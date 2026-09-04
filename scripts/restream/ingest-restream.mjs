#!/usr/bin/env node
// ingest-restream.mjs — pull Restream live-show analytics into the historical log.
//
// For every past event not yet ingested:
//   1. Fetch viewer + chat analytics (per-event, per-channel).
//   2. Archive the raw JSON to data/restream/events/<eventId>.json.
//   3. Insert a summary row + detail block into the vault log
//      (Ops/Bones/live-show-analytics.md), newest first.
//
// State: data/restream/state.json (eventId -> status). Re-runs are idempotent.
// A missing or unreadable state file is fatal. "no-analytics" is retryable;
// only a repeatedly confirmed event that never started becomes "no-stream".
//
// Usage:
//   node ingest-restream.mjs                # ingest new events (2 pages of history)
//   node ingest-restream.mjs --backfill     # walk all history pages
//   node ingest-restream.mjs --dry-run      # report what would be ingested, no writes
//
// Exit 0 with summary line on success; exit 1 with reason on failure.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAccessToken } from "./restream-token.mjs";
import { atomicWriteJson, atomicWriteText, readJsonFile, withSourceLock, fetchJson, readingEnvelope, phoenixDateKey } from "../../tools/dive-analytics/source-io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = join(ROOT, "data", "restream");
const EVENTS_DIR = join(DATA_DIR, "events");
const STATE_PATH = join(DATA_DIR, "state.json");
const LOG_PATH =
  "/Users/bones/Documents/Obsidian/Hinterlands/Ops/Bones/live-show-analytics.md";
const API = "https://api.restream.io/v2";
const LOG_MARKER = "<!-- LOG:BEGIN -->";
const DETAIL_MARKER = "<!-- DETAIL:BEGIN -->";

const DRY_RUN = process.argv.includes("--dry-run");
const BACKFILL = process.argv.includes("--backfill");
const PAGE_LIMIT = 50;
const MAX_PAGES = BACKFILL ? 40 : 2;
export const NO_STREAM_CONFIRMATIONS = 3;
export const NO_STREAM_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const NO_STREAM_CONFIRM_SPAN_MS = 6 * 60 * 60 * 1000;
const EVENT_STATE_STATUSES = new Set(["ingested", "no-analytics", "no-stream"]);

function parseSavedTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validStateEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !EVENT_STATE_STATUSES.has(entry.status)) {
    return false;
  }
  if (entry.status === "ingested") return parseSavedTime(entry.ingestedAt);
  if (entry.status === "no-analytics") {
    return parseSavedTime(entry.checkedAt)
      && (entry.firstCheckedAt === undefined || parseSavedTime(entry.firstCheckedAt))
      && (entry.attempts === undefined || (Number.isInteger(entry.attempts) && entry.attempts > 0));
  }
  return Number.isInteger(entry.attempts)
    && entry.attempts >= NO_STREAM_CONFIRMATIONS
    && parseSavedTime(entry.firstCheckedAt)
    && parseSavedTime(entry.checkedAt)
    && parseSavedTime(entry.confirmedAt);
}


export function loadState(path = STATE_PATH) {
  if (!existsSync(path)) {
    throw new Error(`Restream ingest state is missing at ${path}; refusing to treat missing history as empty`);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Restream ingest state is unreadable at ${path}: ${error.message}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !state.events || typeof state.events !== "object" || Array.isArray(state.events)) {
    throw new Error(`Restream ingest state has no readable events map at ${path}`);
  }
  for (const [eventId, entry] of Object.entries(state.events)) {
    if (!validStateEntry(entry)) {
      throw new Error(`Restream ingest state has an invalid entry for ${eventId}`);
    }
  }
  return state;
}

export function saveState(state, path = STATE_PATH) {
  atomicWriteJson(path, state);
}

// --- normalization helpers (defensive against shape drift) ---

export function asEventList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.events)) return payload.events;
  throw new Error("Restream event history response has no event list");
}

function eventDate(ev) {
  const t = ev.startedAt || ev.scheduledFor || ev.finishedAt || ev.createdAt;
  if (!t) return null;
  const ms = typeof t === "number" ? (t > 1e12 ? t : t * 1000) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function fmtDate(d) {
  if (!d) return "unknown";
  return d.toLocaleDateString("en-CA", { timeZone: "America/Phoenix" }); // YYYY-MM-DD
}

function durationMinutes(ev, viewers) {
  const start = ev.startedAt ? Number(new Date(toMs(ev.startedAt))) : null;
  const end = ev.finishedAt ? Number(new Date(toMs(ev.finishedAt))) : null;
  if (start && end && end > start) return Math.round((end - start) / 60000);
  const series = viewers?.total?.viewersPerMinute;
  return Array.isArray(series) ? series.length : null;
}

function toMs(t) {
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  return Date.parse(t);
}

function validTimeMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = toMs(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validSeries(series, valueKey) {
  return Array.isArray(series)
    && series.length > 0
    && series.every((point, index) => objectRecord(point)
      && Number.isFinite(point.timestamp) && point.timestamp >= 0
      && (!index || point.timestamp > series[index - 1].timestamp)
      && Number.isFinite(point[valueKey]) && point[valueKey] >= 0);
}

function validViewerGroup(group) {
  return objectRecord(group)
    && [group.mean, group.max, group.viewsTotal, group.watchedTime].every((value) => Number.isFinite(value) && value >= 0)
    && validSeries(group.viewersPerMinute, "viewers");
}

function validMessageGroup(group) {
  return objectRecord(group)
    && [group.messagesTotal, group.chattersTotal].every((value) => Number.isFinite(value) && value >= 0)
    && validSeries(group.messagesPerMinute, "messages");
}

function expectedChannelIds(event) {
  if (!Array.isArray(event?.destinations)) return [];
  return [...new Set(event.destinations
    .map((destination) => destination?.channelId)
    .filter((channelId) => channelId !== null && channelId !== undefined)
    .map(String))];
}

function completeAnalytics(value, totalCheck, expectedChannels) {
  if (!objectRecord(value) || !totalCheck(value.total) || !objectRecord(value.byChannel)) return false;
  const channelIds = Object.keys(value.byChannel);
  if (!channelIds.every((channelId) => totalCheck(value.byChannel[channelId]))) return false;
  return expectedChannels.every((channelId) => Object.hasOwn(value.byChannel, channelId));
}

export function hasViewerAnalytics(value, expectedChannels = []) {
  return completeAnalytics(value, validViewerGroup, expectedChannels.map(String));
}

export function hasMessageAnalytics(value, expectedChannels = []) {
  return completeAnalytics(value, validMessageGroup, expectedChannels.map(String));
}

export function eventNeedsAnalytics(entry) {
  if (entry === undefined) return true;
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !EVENT_STATE_STATUSES.has(entry.status)) {
    throw new Error("Restream event state is invalid");
  }
  return entry.status === "no-analytics";
}

function priorNoAnalyticsChecks(previous) {
  if (previous?.status !== "no-analytics") return 0;
  return Number.isInteger(previous.attempts) && previous.attempts > 0 ? previous.attempts : 1;
}

export function analyticsDisposition(event, viewers, messages, previous, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error("Restream analytics check time is invalid");
  const checkedAt = new Date(nowMs).toISOString();
  const channelIds = expectedChannelIds(event);
  const viewersReady = hasViewerAnalytics(viewers, channelIds);
  const messagesReady = hasMessageAnalytics(messages, channelIds);
  if (viewersReady && messagesReady) {
    return { action: "ingest", state: { status: "ingested", ingestedAt: checkedAt } };
  }

  const attempts = priorNoAnalyticsChecks(previous) + 1;
  const priorFirst = Date.parse(previous?.firstCheckedAt || previous?.checkedAt || "");
  const firstCheckedAt = Number.isFinite(priorFirst) ? new Date(priorFirst).toISOString() : checkedAt;
  const missing = [!viewersReady ? "viewer analytics" : null, !messagesReady ? "chat analytics" : null].filter(Boolean);
  const finishedAt = validTimeMs(event?.finishedAt);
  const startedAt = validTimeMs(event?.startedAt);
  const bothNotFound = viewers === null && messages === null;
  const confirmedNoStream = bothNotFound
    && event?.status === "finished"
    && startedAt === null
    && finishedAt !== null
    && nowMs - finishedAt >= NO_STREAM_MIN_AGE_MS
    && nowMs - Date.parse(firstCheckedAt) >= NO_STREAM_CONFIRM_SPAN_MS
    && attempts >= NO_STREAM_CONFIRMATIONS;

  if (confirmedNoStream) {
    return {
      action: "no-stream",
      blocking: false,
      state: {
        status: "no-stream",
        attempts,
        firstCheckedAt,
        checkedAt,
        confirmedAt: checkedAt,
        reason: "finished without an actual stream after repeated analytics checks",
      },
    };
  }

  return {
    action: "retry",
    // A history item that actually started, or returned only part of its
    // analytics, must stop the required chain rather than publish without
    // peak, average, watch time, or chat. A finished item that never started
    // is checked again until the confirmed no-stream rule above closes it.
    blocking: startedAt !== null || !bothNotFound,
    state: {
      status: "no-analytics",
      attempts,
      firstCheckedAt,
      checkedAt,
      missing,
    },
  };
}

export function formatWatchedHours(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return "–";
  return `${(minutes / 60).toFixed(1)}h`;
}

function num(v) {
  return typeof v === "number" ? v.toLocaleString("en-US") : "–";
}

function channelName(id, channelMap, ev) {
  if (channelMap[id]) return channelMap[id];
  const dest = (ev.destinations || []).find(
    (d) => String(d.channelId ?? d.id) === String(id)
  );
  return dest?.displayName || dest?.name || `channel ${id}`;
}

// --- log rendering ---

function summaryRow(ev, viewers, messages, mins) {
  const t = viewers?.total || {};
  const m = messages?.total || {};
  const title = (ev.title || "Untitled").replace(/\|/g, "/").slice(0, 60);
  return `| ${fmtDate(eventDate(ev))} | ${title} | ${mins ?? "–"}m | ${num(t.max)} | ${num(
    t.mean
  )} | ${num(t.viewsTotal)} | ${formatWatchedHours(t.watchedTime)} | ${num(m.messagesTotal)} | ${num(
    m.chattersTotal
  )} |`;
}

function detailBlock(ev, viewers, messages, mins, channelMap) {
  const t = viewers?.total || {};
  const m = messages?.total || {};
  const lines = [];
  lines.push(`### ${fmtDate(eventDate(ev))} — ${ev.title || "Untitled"}`);
  lines.push("");
  lines.push(`- Event ID: \`${ev.id}\``);
  if (mins) lines.push(`- Duration: ${mins} min`);
  lines.push(
    `- Viewers: peak ${num(t.max)}, avg ${num(t.mean)}, total views ${num(t.viewsTotal)}, watch time ${formatWatchedHours(t.watchedTime)}`
  );
  lines.push(`- Chat: ${num(m.messagesTotal)} messages from ${num(m.chattersTotal)} chatters`);
  const byChannel = viewers?.byChannel || {};
  const chatByChannel = messages?.byChannel || {};
  const ids = [...new Set([...Object.keys(byChannel), ...Object.keys(chatByChannel)])];
  if (ids.length) {
    lines.push("- Per platform:");
    for (const id of ids) {
      const v = byChannel[id] || {};
      const c = chatByChannel[id] || {};
      lines.push(
        `  - ${channelName(id, channelMap, ev)}: peak ${num(v.max)}, avg ${num(
          v.mean
        )}, views ${num(v.viewsTotal)}, watch ${formatWatchedHours(v.watchedTime)}, chat ${num(
          c.messagesTotal
        )}`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function insertAfterMarker(content, marker, insertion) {
  const idx = content.indexOf(marker);
  if (idx === -1) throw new Error(`log file missing marker ${marker}`);
  const at = idx + marker.length;
  return content.slice(0, at) + "\n" + insertion + content.slice(at);
}

export function updateLog(entries, logPath = LOG_PATH, now = new Date().toISOString()) {
  if (!existsSync(logPath)) throw new Error(`log file missing: ${logPath}`);
  let content = readFileSync(logPath, "utf8");
  for (const entry of [...entries].reverse()) {
    if (content.includes(`- Event ID: \`${entry.eventId}\``)) continue;
    content = insertAfterMarker(content, LOG_MARKER, entry.row);
    content = insertAfterMarker(content, DETAIL_MARKER, "\n" + entry.detail);
  }
  content = content.replace(/_Last ingest: .*_/, `_Last ingest: ${now} (${entries.length} checked)_`);
  atomicWriteText(logPath, content);
}

function destinationIdentity(url) {
  let value;
  try { value = new URL(url); } catch { return null; }
  if (/(^|\.)youtube\.com$/.test(value.hostname)) {
    const id = value.searchParams.get("v") || value.pathname.match(/^\/live\/([^/]+)/)?.[1];
    return id ? `youtube:${id}` : null;
  }
  if (value.hostname === "youtu.be") return `youtube:${value.pathname.slice(1)}`;
  const id = value.pathname.match(/^\/i\/broadcasts\/([^/]+)/)?.[1];
  return id && /^(x|twitter)\.com$/.test(value.hostname) ? `x:${id}` : null;
}

export function episodeForRestreamEvent(event, registry) {
  const ids = new Set((event.destinations || []).map((destination) => destinationIdentity(destination.externalUrl)).filter(Boolean));
  const matches = (registry.shows || []).filter((show) => (show.targets || []).some((target) => ids.has(target.kind === "youtube" ? `youtube:${target.videoId}` : `x:${target.broadcastId}`)));
  if (matches.length > 1) throw new Error(`Restream event ${event.id} matches several episodes`);
  return matches[0] || null;
}

export async function runRestreamIngest({ root = ROOT, logPath = LOG_PATH, now = new Date().toISOString(), token, fetchImpl = fetch, dryRun = false, backfill = false, log = console.log } = {}) {
  const dataDir = join(root, "data", "restream");
  const statePath = join(dataDir, "state.json");
  const eventsDir = join(dataDir, "events");
  return withSourceLock(statePath, async () => {
    const state = loadState(statePath);
    const registry = readJsonFile(join(dataDir, "postlive-registry.json"));
    const checkedAt = new Date(now).toISOString();
    if (!token) throw new Error("Restream credential is unavailable");
    const api = (path, allow404 = false) => fetchJson(`${API}${path}`, { label: `Restream ${path.split("?")[0]}`, headers: { Authorization: `Bearer ${token}` }, fetchImpl, allow404 });
    const events = [];
    const seenIds = new Set();
    const maxPages = backfill ? 40 : 2;
    for (let page = 0; page < maxPages; page++) {
      const batch = asEventList(await api(`/user/events/history?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`));
      for (const event of batch) {
        if (!event?.id || seenIds.has(String(event.id))) throw new Error("Restream history has missing or duplicate event IDs");
        seenIds.add(String(event.id)); events.push(event);
      }
      if (batch.length < PAGE_LIMIT) break;
      if (page === maxPages - 1) {
        const unclosed = Object.keys(state.events).filter((id) => state.events[id].status === "no-analytics" && !seenIds.has(id));
        if (unclosed.length) throw new Error("Restream history window omitted pending events; retry with the existing backfill option");
      }
    }
    if (!events.length) throw new Error("Restream returned empty event history");
    for (const [id, entry] of Object.entries(state.events)) {
      if (entry.status !== "ingested") continue;
      const raw = readJsonFile(join(eventsDir, `${id}.json`));
      if (String(raw?.event?.id) !== id || !hasViewerAnalytics(raw.viewers, expectedChannelIds(raw.event)) || !hasMessageAnalytics(raw.messages, expectedChannelIds(raw.event))) throw new Error(`Restream archived event ${id} is missing or incomplete`);
    }
    const fresh = events.filter((event) => eventDate(event)?.getTime() <= Date.parse(checkedAt) && eventNeedsAnalytics(state.events[event.id]));
    if (dryRun) { log(`restream-ingest: ${fresh.length} event(s) would be checked (dry run)`); return { ingested: 0, pending: 0, dryRun: true }; }
    const entries = [], pending = [], failures = [];
    for (const event of fresh) {
      const show = episodeForRestreamEvent(event, registry);
      // The owner account can host unrelated shows. Only exact Radio matches
      // and explicitly named Radio events belong to this publishing system.
      if (!show && !/dive\s*radio/i.test(event.title || "")) continue;
      if (show?.date > phoenixDateKey(checkedAt)) continue;
      const path = join(eventsDir, `${event.id}.json`);
      let viewers, messages, raw;
      try {
        if (existsSync(path)) {
          raw = readJsonFile(path);
          if (String(raw?.event?.id) !== String(event.id)) throw new Error("archive identity mismatch");
          viewers = raw.viewers; messages = raw.messages;
        } else {
          viewers = await api(`/user/events/${event.id}/analytics/viewers`, true);
          messages = await api(`/user/events/${event.id}/analytics/messages`, true);
        }
        // Missing fields indicate delayed reports; impossible finite values
        // indicate broken source data and cannot be treated as ordinary waiting.
        for (const payload of [viewers, messages]) for (const group of [payload?.total, ...Object.values(payload?.byChannel || {})]) {
          for (const value of Object.values(group || {})) if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error("Restream returned invalid negative/nonfinite counts");
          for (const series of [group?.viewersPerMinute, group?.messagesPerMinute]) for (const point of series || []) {
            for (const [key, value] of Object.entries(point)) if (key !== "timestamp" && typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error("Restream returned invalid minute counts");
          }
        }
        const disposition = analyticsDisposition(event, viewers, messages, state.events[event.id], Date.parse(checkedAt));
        state.events[event.id] = disposition.state;
        if (show) state.events[event.id].reading = readingEnvelope({ source: "restream", episode: show.slug, objectId: String(event.id), pulledAt: checkedAt, state: disposition.action === "ingest" ? "ready" : "pending" });
        if (raw && disposition.action === "ingest" && show) state.events[event.id].reading = raw.reading || { ...readingEnvelope({ source: "restream", episode: show.slug, objectId: String(event.id), pulledAt: raw.fetchedAt, state: "ready" }), legacyEvidence: true };
        if (disposition.action === "retry") { if (disposition.blocking && show) pending.push(event.id); continue; }
        if (disposition.action === "no-stream") continue;
        if (!show) throw new Error(`Restream event ${event.id} has no exact registered episode destination`);
        raw ||= { event, viewers, messages, fetchedAt: checkedAt, reading: state.events[event.id].reading };
        if (!existsSync(path)) atomicWriteJson(path, raw);
        const mins = durationMinutes(raw.event, raw.viewers);
        entries.push({ eventId: String(event.id), row: summaryRow(raw.event, raw.viewers, raw.messages, mins), detail: detailBlock(raw.event, raw.viewers, raw.messages, mins, {}) });
      } catch (error) {
        state.events[event.id] = { status: "no-analytics", checkedAt, firstCheckedAt: state.events[event.id]?.firstCheckedAt || checkedAt, attempts: priorNoAnalyticsChecks(state.events[event.id]) + 1, missing: [error.message] };
        if (show) state.events[event.id].reading = readingEnvelope({ source: "restream", episode: show.slug, objectId: String(event.id), pulledAt: checkedAt, state: "failed" });
        failures.push(`${event.id}: ${error.message}`);
      }
    }
    if (entries.length) updateLog(entries, logPath, checkedAt);
    state.checkedAt = checkedAt;
    state.capture = { checkedAt, state: failures.length ? "failed" : pending.length ? "pending" : "ready", pendingEvents: pending, errors: failures };
    saveState(state, statePath);
    if (failures.length) throw new Error(`Restream capture failed — ${failures.join("; ")}`);
    log(`restream-ingest: ingested ${entries.length} event(s), ${pending.length} pending`);
    return { ingested: entries.length, pending: pending.length };
  });
}

async function main() {
  const token = await getAccessToken();
  const result = await runRestreamIngest({ token, dryRun: DRY_RUN, backfill: BACKFILL });
  if (result.pending) process.exitCode = 20;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`restream-ingest: ${err.message}\n`);
    process.exit(1);
  });
}
