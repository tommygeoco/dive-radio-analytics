#!/usr/bin/env node
// alerts.mjs — material-change detector for the Dive Radio dashboard.
// (PRD v2 W4, 2026-08-22.) Push over pull: nobody should open a dashboard to
// find out something changed. This runs at the end of the daily chain, diffs
// today's published data.json against the last run's remembered state, and
// queues ONE plain-language line per material event. A separate trigger-gated
// cron (dive-alerts) delivers the queue to Slack and stays silent when it is
// empty.
//
// Deterministic: no model calls, no network. State and queue live next to the
// data they describe:
//   state:  data/restream/alerts-state.json    (last-seen values)
//   queue:  data/restream/alerts-pending.json  (lines awaiting delivery)
//
// Modes:
//   node tools/dive-analytics/alerts.mjs          # detect + queue (chain step)
//   node tools/dive-analytics/alerts.mjs --emit   # print queue + clear it
//                                                 # (dive-alerts cron payload)
// First run bootstraps state and queues nothing — history is not news.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STATE_PATH = join(ROOT, "data", "restream", "alerts-state.json");
const QUEUE_PATH = join(ROOT, "data", "restream", "alerts-pending.json");
const NEG_SPIKE = 3; // new negative comments in one day that count as a spike

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")); // corrupt file = loud crash, never silent reset
}
function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}
const short = (t) => t.replace(/^Dive Radio:\s*/i, "");

function snapshotState(data) {
  const eps = data.episodes;
  const newest = eps[eps.length - 1];
  const neg = {}, w1v = {};
  let staleCount = 0;
  for (const e of eps) {
    neg[e.slug] = e.comments?.sentiment?.negative ?? 0;
    if (e.latest?.totalViewsInfo?.stale) staleCount++;
  }
  for (const v of data.showTrend?.week1VelocityByEpisode || []) w1v[v.slug] = v.value;
  return {
    episodeCount: eps.length,
    newestSlug: newest?.slug ?? null,
    paceRank: data.showTrend?.paceRank ?? null,
    neg, w1v, staleCount,
  };
}

function detect(prev, cur, data) {
  const out = [];
  const eps = data.episodes;
  const byslug = (s) => eps.find((e) => e.slug === s);

  // 1. new episode registered
  if (cur.episodeCount > prev.episodeCount) {
    const fresh = eps.slice(prev.episodeCount);
    for (const e of fresh) out.push(`New episode registered automatically: E${e.ep} — ${short(e.title)} (premiered ${e.premiere}).`);
  }

  // 2. same-age pace rank change for the newest episode (same episode only —
  // a new episode resets the comparison and is covered by alert 1)
  if (prev.paceRank && cur.paceRank && prev.newestSlug === cur.newestSlug &&
      cur.paceRank.rank != null && prev.paceRank.rank != null && cur.paceRank.rank !== prev.paceRank.rank) {
    const e = byslug(cur.newestSlug);
    const dir = cur.paceRank.rank < prev.paceRank.rank ? "up" : "down";
    out.push(`E${e?.ep} (${short(e?.title ?? cur.newestSlug)}) moved ${dir} to #${cur.paceRank.rank} of ${cur.paceRank.of} on same-age YouTube pace (was #${prev.paceRank.rank}).`);
  }

  // 3. negative-comment spike
  for (const [slug, n] of Object.entries(cur.neg)) {
    const before = prev.neg?.[slug] ?? 0;
    if (n - before >= NEG_SPIKE) {
      const e = byslug(slug);
      out.push(`E${e?.ep} (${short(e?.title ?? slug)}) picked up ${n - before} negative comments since yesterday — worth a read (dashboard → episode → comments).`);
    }
  }

  // 4. a first week just completed (week-1 number newly available)
  for (const [slug, v] of Object.entries(cur.w1v)) {
    if (v != null && (prev.w1v?.[slug] ?? null) == null && slug in (prev.w1v ?? {})) {
      const e = byslug(slug);
      const clean = Object.values(cur.w1v).filter((x) => x != null).sort((a, b) => b - a);
      const rank = clean.indexOf(v) + 1;
      out.push(`E${e?.ep} (${short(e?.title ?? slug)}) finished its first week: ${v.toLocaleString("en-US")} YouTube views — #${rank} of ${clean.length} clean first weeks.`);
    }
  }

  // 5. plays went stale (a broadcast stopped answering; high-water shown)
  if (cur.staleCount > (prev.staleCount ?? 0)) {
    out.push(`X plays went stale for ${cur.staleCount - prev.staleCount} episode(s) — dashboard is showing the last confirmed number, marked with →date.`);
  }

  return out;
}

const emitMode = process.argv.includes("--emit");

if (emitMode) {
  const queue = loadJson(QUEUE_PATH, []);
  if (!queue.length) { console.log("dive-alerts: queue empty — nothing to say."); process.exit(0); }
  console.log("Dive Radio — what changed:");
  for (const line of queue) console.log(`• ${line}`);
  saveAtomic(QUEUE_PATH, []);
} else {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const cur = snapshotState(data);
  const prev = loadJson(STATE_PATH, null);
  if (!prev) {
    saveAtomic(STATE_PATH, cur);
    console.log("alerts: state bootstrapped — no alerts on first run.");
  } else {
    const found = detect(prev, cur, data);
    if (found.length) {
      const queue = loadJson(QUEUE_PATH, []);
      for (const line of found) if (!queue.includes(line)) queue.push(line);
      saveAtomic(QUEUE_PATH, queue);
    }
    saveAtomic(STATE_PATH, cur);
    console.log(`alerts: ${found.length} material change(s)${found.length ? " queued" : ""}.`);
  }
}
