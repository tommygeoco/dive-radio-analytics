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
//
// Usage:
//   node ingest-restream.mjs                # ingest new events (2 pages of history)
//   node ingest-restream.mjs --backfill     # walk all history pages
//   node ingest-restream.mjs --dry-run      # report what would be ingested, no writes
//
// Exit 0 with summary line on success; exit 1 with reason on failure.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { events: {} };
  }
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// --- normalization helpers (defensive against shape drift) ---

function asEventList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.events)) return payload.events;
  return [];
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

function hours(sec) {
  return sec ? (sec / 3600).toFixed(1) : "0";
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
  )} | ${num(t.viewsTotal)} | ${hours(t.watchedTime)}h | ${num(m.messagesTotal)} | ${num(
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
    `- Viewers: peak ${num(t.max)}, avg ${num(t.mean)}, total views ${num(t.viewsTotal)}, watch time ${hours(t.watchedTime)}h`
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
        )}, views ${num(v.viewsTotal)}, watch ${hours(v.watchedTime)}h, chat ${num(
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

  const fresh = events.filter((ev) => ev?.id && !state.events[ev.id]);
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
  let skipped = 0;
  for (const ev of fresh) {
    const viewers = await api(`/user/events/${ev.id}/analytics/viewers`, token);
    const messages = await api(`/user/events/${ev.id}/analytics/messages`, token);
    if (!viewers && !messages) {
      state.events[ev.id] = { status: "no-analytics", checkedAt: new Date().toISOString() };
      skipped++;
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
    state.events[ev.id] = { status: "ingested", ingestedAt: new Date().toISOString() };
  }

  if (entries.length) updateLog(entries);
  saveState(state);
  console.log(
    `restream-ingest: ingested ${entries.length} event(s), skipped ${skipped} without analytics`
  );
}

main().catch((err) => {
  process.stderr.write(`restream-ingest: ${err.message}\n`);
  process.exit(1);
});
