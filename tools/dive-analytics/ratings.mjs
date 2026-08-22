#!/usr/bin/env node
// ratings.mjs — W9 episode rating: "#x of N", ratio-based, frozen windows.
// PRD: Dive Media Group/Dive Radio/prd-analytics-v3-comments-and-rating-2026-08-22.md
// (algorithm ratio-v2, owner directive 2026-08-22 13:20: every episode ranked,
//  ratio'd so nobody is penalized for lack of historical data)
//
// Definition (constitutional):
//   - Window = the episode + up to 9 episodes that aired BEFORE it (the 10 most
//     recent as of its air date). Windows never include later episodes.
//   - A rating is provisional from air day and freezes at day 7. A frozen rating
//     NEVER changes on re-processing within the same algorithm version. An
//     algorithm version bump re-derives every rating visibly (stamped at the
//     store root) — never silently.
//   - Every pillar is a RATIO — "this episode vs the typical episode" — so an
//     episode is never docked for when tracking started:
//       watch      50%  YT views at its own age (capped at day 21, the measured
//                       flatline point) ÷ median of window peers' REAL snapshot
//                       values at that same age. Same-age, same-unit, no history
//                       required beyond what peers actually recorded.
//       engagement 20%  likes+comments per 1k YT views ÷ window median (a ratio
//                       of a ratio — age-independent).
//       retention  15%  averageViewPercentage ÷ window median (designertom-only
//                       coverage until Ridd's grant; marked).
//       live       15%  peak concurrents ÷ median, chat messages ÷ median,
//                       averaged. Live data exists from air night for everyone.
//   - Missing-data rule: a pillar with no honest data (no peer covers that age,
//     analytics not yet available) drops out and its weight redistributes
//     proportionally. Never estimate, never interpolate, never zero-fill.
//
// Store: data/restream/episode-ratings.json — one entry per episode, updated in
// place only while provisional; frozen entries are copied through byte-stable.
//
// Deterministic: no model calls, no network. Reads the same files as build-data.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeAll } from "./build-data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const STORE_PATH = join(ROOT, "data", "restream", "episode-ratings.json");
const YTA_DIR = join(ROOT, "data", "restream", "yt-analytics");

export const ALGORITHM = "ratio-v2";
export const WEIGHTS = { watch: 0.5, engagement: 0.2, retention: 0.15, live: 0.15 };
const PILLARS = Object.keys(WEIGHTS);
const WINDOW_MAX = 10;
const FREEZE_DAYS = 7;
const WATCH_CAP_DAYS = 21; // measured flatline point: episodes stop growing ~week 3
const DAY = 86400000;
const YT_KEYS = ["yt:joindiveclub", "yt:designertom"];
const PHX_OFFSET = 7 * 3600000;

function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET;
}

function median(vals) {
  const v = [...vals].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

// --- pillar raw values ---

function retentionOf(slug) {
  const p = join(YTA_DIR, `${slug}.json`);
  if (!existsSync(p)) return { value: null, channels: [] };
  let j;
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { return { value: null, channels: [] }; }
  let num = 0, den = 0;
  const channels = [];
  for (const [key, ch] of Object.entries(j.channels || {})) {
    const t = ch?.totals;
    if (t && t.averageViewPercentage != null && t.views > 0) {
      num += t.averageViewPercentage * t.views;
      den += t.views;
      channels.push(key);
    }
  }
  return { value: den > 0 ? Math.round((num / den) * 100) / 100 : null, channels };
}

const ytAt = (snaps, cutoffMs) => {
  let best = null;
  for (const s of snaps) {
    const t = Date.parse(s.ts);
    if (t <= cutoffMs && (!best || t > best.t)) best = { t, v: YT_KEYS.reduce((a, k) => a + (s.byDest[k]?.views || 0), 0) };
  }
  return best ? best.v : null;
};

// watch: member's YT views at its reference age vs the median of OTHER window
// members' real snapshot values at that same age.
//   reference age = min(its age, 21d cap) — unless the episode was registered
//   late and its earliest real snapshot lands after that, in which case the
//   first snapshot's age becomes the reference (its earliest honest data point,
//   still compared same-age against peers). A peer only counts when its
//   snapshot coverage genuinely spans that age (first snapshot at-or-before it,
//   last snapshot at-or-after it) — no extrapolation, no fabricated history.
function watchRatio(m, members) {
  const prem = premiereMs(m.premiere);
  const firstAge = (Date.parse(m.snapshots[0].ts) - prem) / DAY;
  let refAge = Math.min(m.ageDays, WATCH_CAP_DAYS);
  if (firstAge > refAge) refAge = firstAge; // late reg: earliest real data point
  const own = ytAt(m.snapshots, prem + refAge * DAY);
  if (own == null) return null;
  const peers = [];
  for (const p of members) {
    if (p.slug === m.slug) continue;
    const pPrem = premiereMs(p.premiere);
    const pFirst = (Date.parse(p.snapshots[0].ts) - pPrem) / DAY;
    const pLast = (Date.parse(p.snapshots[p.snapshots.length - 1].ts) - pPrem) / DAY;
    if (pFirst > refAge || pLast < refAge) continue; // no real data spanning that age
    const v = ytAt(p.snapshots, pPrem + refAge * DAY);
    if (v != null) peers.push(v);
  }
  const typical = median(peers);
  if (typical == null || typical <= 0) return null;
  return { value: own, typical: Math.round(typical), ratio: r3(own / typical), atDay: Math.round(refAge * 10) / 10 };
}

function simpleRatio(value, pool) {
  if (value == null) return null;
  const typical = median(pool);
  if (typical == null || typical <= 0) return null;
  return { value, typical: r3(typical), ratio: r3(value / typical) };
}

// --- rate ONE episode within its window ---

function rateEpisode(target, members) {
  // per-member pillar ratios (each member judged vs typical at ITS OWN age)
  const engPool = members.map((m) => m.eng).filter((v) => v != null);
  const retPool = members.map((m) => m.ret).filter((v) => v != null);
  const peakPool = members.map((m) => m.live?.peak).filter((v) => v != null);
  const chatPool = members.map((m) => m.live?.chat).filter((v) => v != null);

  const composites = members.map((m) => {
    const pillars = {};
    if (members.length > 1) {
      pillars.watch = watchRatio(m, members);
      if (engPool.length >= 2) pillars.engagement = simpleRatio(m.eng, engPool);
      if (retPool.length >= 2) pillars.retention = simpleRatio(m.ret, retPool);
      if (m.live && peakPool.length >= 2 && chatPool.length >= 2) {
        const pk = simpleRatio(m.live.peak, peakPool);
        const ch = simpleRatio(m.live.chat, chatPool);
        if (pk && ch) pillars.live = { value: { peak: m.live.peak, chat: m.live.chat }, typical: { peak: pk.typical, chat: ch.typical }, ratio: r3((pk.ratio + ch.ratio) / 2) };
      }
    }
    const present = PILLARS.filter((p) => pillars[p] != null);
    const wSum = present.reduce((a, p) => a + WEIGHTS[p], 0);
    let score = null;
    const weights = {};
    if (present.length && wSum > 0) {
      score = 0;
      for (const p of present) {
        weights[p] = Math.round((WEIGHTS[p] / wSum) * 10000) / 10000;
        score += pillars[p].ratio * weights[p];
      }
      score = Math.round(score * 10000) / 10000;
    }
    return { slug: m.slug, ep: m.ep, pillars, weights, score };
  });

  const mine = composites.find((c) => c.slug === target.slug);
  const scored = composites.filter((c) => c.score != null);
  let rank = null;
  if (mine.score != null) {
    rank = 1 + scored.filter((c) => c.score > mine.score || (c.score === mine.score && c.ep < mine.ep)).length;
  } else if (members.length === 1) {
    rank = 1; // first episode: nothing to compare, #1 of 1 by definition
  }

  const pillarScores = {};
  const missing = [];
  for (const p of PILLARS) {
    const got = mine.pillars[p];
    pillarScores[p] = got
      ? { value: got.value, typical: got.typical, ratio: got.ratio, weight: mine.weights[p] }
      : { value: p === "live" ? (target.live ?? null) : p === "engagement" ? target.eng : p === "retention" ? target.ret : null, typical: null, ratio: null, weight: 0 };
    if (!got && members.length > 1) missing.push(p);
  }

  return { rank, n: members.length, score: mine.score, pillarScores, missing };
}

// --- store orchestration ---

export function computeRatings({ now = Date.now() } = {}) {
  const data = computeAll({ now });
  const eps = data.episodes;
  let store = null;
  if (existsSync(STORE_PATH)) {
    try { store = JSON.parse(readFileSync(STORE_PATH, "utf8")); } catch { /* unreadable store — rebuild below */ }
  }
  const sameAlgo = store?.algorithm === ALGORITHM;
  const bySlug = new Map(sameAlgo ? (store.ratings || []).map((r) => [r.slug, r]) : []);

  const all = eps.map((e) => ({
    slug: e.slug,
    ep: e.ep,
    premiere: e.premiere,
    ageDays: e.ageDays,
    snapshots: e.snapshots,
    eng: e.metrics.engagementPer1k ?? null,
    ret: retentionOf(e.slug).value,
    live: e.live ? { peak: e.live.peak, chat: e.live.chatMessages } : null,
  }));

  const ratings = [];
  let frozenKept = 0, computed = 0;
  for (const e of all) {
    const prior = bySlug.get(e.slug);
    if (prior?.frozenAt) {
      ratings.push(prior); // frozen forever within this algorithm version
      frozenKept++;
      continue;
    }
    const members = all.filter((m) => m.ep <= e.ep && m.ep > e.ep - WINDOW_MAX);
    const r = rateEpisode(e, members);
    const retention = retentionOf(e.slug);
    const nowIso = new Date(now).toISOString();
    ratings.push({
      ep: e.ep,
      slug: e.slug,
      algorithm: ALGORITHM,
      windowIds: members.map((m) => m.slug),
      rank: r.rank,
      n: r.n,
      score: r.score,
      pillarScores: r.pillarScores,
      coverage: {
        missingPillars: r.missing,
        watchBasis: `yt-views-at-own-age-vs-peer-median (cap ${WATCH_CAP_DAYS}d; X plays excluded — no plays history before 2026-08-21)`,
        retentionChannels: retention.channels,
      },
      provisional: e.ageDays < FREEZE_DAYS,
      computedAt: nowIso,
      frozenAt: e.ageDays >= FREEZE_DAYS ? nowIso : null,
    });
    computed++;
  }

  ratings.sort((a, b) => a.ep - b.ep);
  const out = {
    version: 2,
    algorithm: ALGORITHM,
    weights: WEIGHTS,
    updatedAt: new Date(now).toISOString(),
    ratings,
  };
  if (store && !sameAlgo) {
    out.rederivedFrom = store.algorithm ?? "composite-v1";
    out.rederivedAt = new Date(now).toISOString();
  } else if (store?.rederivedFrom) {
    out.rederivedFrom = store.rederivedFrom;
    out.rederivedAt = store.rederivedAt;
  }
  return { ...out, _frozenKept: frozenKept, _computed: computed };
}

// --- main ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dry = process.argv.includes("--dry");
  const { _frozenKept, _computed, ...store } = computeRatings();
  if (!dry) writeFileSync(STORE_PATH, JSON.stringify(store, null, 1) + "\n");
  for (const r of store.ratings) {
    const flags = [r.provisional ? "provisional" : "frozen", r.coverage.missingPillars.length ? `◐ missing: ${r.coverage.missingPillars.join(", ")}` : "full basis"];
    console.log(`E${r.ep} ${r.slug.slice(0, 34)} — #${r.rank} of ${r.n} (score ${r.score ?? "–"}) [${flags.join(" · ")}]`);
  }
  console.log(`ratings (${ALGORITHM}): ${_computed} computed, ${_frozenKept} frozen kept${store.rederivedFrom ? ` — re-derived from ${store.rederivedFrom}` : ""}${dry ? " (dry run — store not written)" : ` — wrote ${STORE_PATH}`}`);
}
