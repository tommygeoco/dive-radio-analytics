#!/usr/bin/env node
// alerts.mjs — material-change detector for the Dive Radio dashboard.
// (PRD v2 W4, 2026-08-22.) Push over pull: nobody should open a dashboard to
// find out something changed. This runs at the end of the daily chain, diffs
// today's published data.json against the last run's remembered state, and
// queues ONE plain-language line per material event. A separate trigger-gated
// cron (dive-alerts) delivers the queue to Slack and stays silent when it is
// empty.
//
// Deterministic: no model calls. The one network step is the W19 prod
// freshness probe at the end of a chain run (PRD v7, 2026-08-23): fetch the
// live data.json and queue one plain line when it is older than 26 hours.
// State and queue live next to the data they describe:
//   state:  data/restream/alerts-state.json    (last-seen values)
//   queue:  data/restream/alerts-pending.json  (lines awaiting delivery)
//
// Modes:
//   node tools/dive-analytics/alerts.mjs          # detect + queue (chain step)
//   node tools/dive-analytics/alerts.mjs --emit   # print queue + clear it
//                                                 # (dive-alerts cron payload)
// First run bootstraps state and queues nothing — history is not news.
// The midday watchdog cron runs tools/dive-analytics/audit/freshness.mjs
// standalone instead, which catches the chain-died-before-alerts case.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProdFreshness } from "./audit/freshness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STATE_PATH = join(ROOT, "data", "restream", "alerts-state.json");
const QUEUE_PATH = join(ROOT, "data", "restream", "alerts-pending.json");
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
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

export function snapshotState(data) {
  const eps = data.episodes;
  const newest = eps[eps.length - 1];
  const complaints = {}, w1v = {};
  let staleCount = 0;
  for (const e of eps) {
    complaints[e.slug] = e.comments?.complaintCount ?? 0;
    if (e.latest?.totalViewsInfo?.stale) staleCount++;
  }
  for (const v of data.showTrend?.week1VelocityByEpisode || []) w1v[v.slug] = v.value;
  const classified = loadJson(CLASSIFIED_PATH, { classified: {} });
  const reviewCount = Object.values(classified.classified || {}).filter((x) => x.state === "review").length;
  return {
    episodeCount: eps.length,
    newestSlug: newest?.slug ?? null,
    paceRank: data.showTrend?.paceRank ?? null,
    complaints, reviewCount, w1v, staleCount,
  };
}

export function detect(prev, cur, data) {
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

  // 3. new people raising concerns
  for (const [slug, n] of Object.entries(cur.complaints)) {
    const before = prev.complaints?.[slug] ?? n;
    if (n - before >= NEG_SPIKE) {
      const e = byslug(slug);
      out.push(`E${e?.ep} (${short(e?.title ?? slug)}) had ${n - before} more people raise concerns since yesterday — worth a read (dashboard → episode → audience feedback).`);
    }
  }

  // 3b. classifier disagreements need human review and never reach the page.
  if (cur.reviewCount > (prev.reviewCount ?? 0)) {
    const added = cur.reviewCount - (prev.reviewCount ?? 0);
    out.push(`${added} audience comment${added === 1 ? " needs" : "s need"} label review — held off the dashboard until a person resolves it.`);
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
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
    // W19: end-of-chain prod freshness probe. Stale queues one plain line;
    // an unreachable prod is only noted here — publish just confirmed parity,
    // and the midday freshness cron re-checks on its own.
    const prod = await checkProdFreshness();
    if (prod.state === "stale") {
      const queue = loadJson(QUEUE_PATH, []);
      if (!queue.includes(prod.sentence)) queue.push(prod.sentence);
      saveAtomic(QUEUE_PATH, queue);
      console.log(`alerts: prod is stale — queued: ${prod.sentence}`);
    } else if (prod.state === "unreachable") {
      console.log(`alerts: ${prod.sentence}`);
    } else {
      console.log(`alerts: prod dashboard is serving data from ${prod.generatedAt}, ${prod.hours} hour(s) old.`);
    }
  }
}
