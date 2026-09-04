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

async function api(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") || 5) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
    return api(path, token);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${text}`);
  }
  return res.json();
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
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n");
  renameSync(tempPath, path);
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
    && series.every((point) => objectRecord(point)
      && Number.isFinite(point.timestamp)
      && Number.isFinite(point[valueKey]));
}

function validViewerGroup(group) {
  return objectRecord(group)
    && [group.mean, group.max, group.viewsTotal, group.watchedTime].every(Number.isFinite)
    && validSeries(group.viewersPerMinute, "viewers");
}

function validMessageGroup(group) {
  return objectRecord(group)
    && [group.messagesTotal, group.chattersTotal].every(Number.isFinite)
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

function updateLog(entries) {
  if (!existsSync(LOG_PATH)) throw new Error(`log file missing: ${LOG_PATH}`);
  let content = readFileSync(LOG_PATH, "utf8");
  // newest first: entries arrive newest-first from the API; insert in reverse
  // so the final order after repeated inserts stays newest-at-top.
  for (const e of [...entries].reverse()) {
    content = insertAfterMarker(content, LOG_MARKER, e.row);
    content = insertAfterMarker(content, DETAIL_MARKER, "\n" + e.detail);
  }
  content = content.replace(
    /_Last ingest: .*_/,
    `_Last ingest: ${new Date().toISOString()} (${entries.length} new)_`
  );
  writeFileSync(LOG_PATH, content);
}

async function main() {
  const token = await getAccessToken();
  const state = loadState();

  // channel id -> display name map (best effort)
  const channelMap = {};
  try {
    const channels = await api("/user/channel/all", token);
    for (const ch of Array.isArray(channels) ? channels : []) {
      channelMap[ch.id] = ch.displayName || ch.name || `channel ${ch.id}`;
    }
  } catch (err) {
    process.stderr.write(`channel map unavailable: ${err.message}\n`);
  }

  // walk history
  const events = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await api(
      `/user/events/history?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
      token
    );
    const batch = asEventList(payload);
    events.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
  }

  const fresh = events.filter((ev) => ev?.id && eventNeedsAnalytics(state.events[ev.id]));
  if (!fresh.length) {
    console.log(`restream-ingest: no new events (${events.length} in history window)`);
    return;
  }
  if (DRY_RUN) {
    console.log(
      `restream-ingest (dry-run): would ingest ${fresh.length} event(s):\n` +
        fresh.map((e) => `  ${fmtDate(eventDate(e))}  ${e.title || e.id}`).join("\n")
    );
    return;
  }

  mkdirSync(EVENTS_DIR, { recursive: true });
  const entries = [];
  const blockingRetries = [];
  let awaitingNoStreamConfirmation = 0;
  let confirmedNoStream = 0;
  for (const ev of fresh) {
    const viewers = await api(`/user/events/${ev.id}/analytics/viewers`, token);
    const messages = await api(`/user/events/${ev.id}/analytics/messages`, token);
    const disposition = analyticsDisposition(ev, viewers, messages, state.events[ev.id]);
    state.events[ev.id] = disposition.state;
    if (disposition.action === "retry") {
      if (disposition.blocking) blockingRetries.push({ id: ev.id, missing: disposition.state.missing });
      else awaitingNoStreamConfirmation++;
      continue;
    }
    if (disposition.action === "no-stream") {
      confirmedNoStream++;
      continue;
    }
    const raw = { event: ev, viewers, messages, fetchedAt: new Date().toISOString() };
    writeFileSync(join(EVENTS_DIR, `${ev.id}.json`), JSON.stringify(raw, null, 2) + "\n");
    const mins = durationMinutes(ev, viewers);
    entries.push({
      date: eventDate(ev),
      row: summaryRow(ev, viewers, messages, mins),
      detail: detailBlock(ev, viewers, messages, mins, channelMap),
    });
  }

  if (entries.length) updateLog(entries);
  saveState(state);
  if (blockingRetries.length) {
    const details = blockingRetries
      .map((item) => `${item.id} missing ${item.missing.join(" and ")}`)
      .join("; ");
    throw new Error(`analytics are not ready for ${blockingRetries.length} streamed event(s); retry state was saved and no partial event was archived — ${details}`);
  }
  console.log(
    `restream-ingest: ingested ${entries.length} event(s)`
      + `${awaitingNoStreamConfirmation ? `, ${awaitingNoStreamConfirmation} finished event(s) still confirming no stream` : ""}`
      + `${confirmedNoStream ? `, ${confirmedNoStream} event(s) confirmed as never started` : ""}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`restream-ingest: ${err.message}\n`);
    process.exit(1);
  });
}
