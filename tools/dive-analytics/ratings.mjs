#!/usr/bin/env node
// ratings.mjs — W9 episode rating: "#x of N", YouTube-Studio-style, frozen windows.
// PRD: Dive Media Group/Dive Radio/prd-analytics-v3-comments-and-rating-2026-08-22.md
//
// Definition (constitutional):
//   - Window = the episode + up to 9 episodes that aired BEFORE it (the 10 most
//     recent as of its air date). Windows never include later episodes.
//   - A rating is provisional from air day and freezes at day 7, when week-1
//     data completes. A frozen rating NEVER changes on re-processing.
//   - Composite of four pillars, each a percentile within the window:
//       watch 50% · engagement 20% · retention 15% · live 15%
//   - Missing-data rule: a pillar with no honest data redistributes its weight
//     proportionally across the pillars that exist. Never estimate, never
//     interpolate, never rank on fabricated zeros.
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

export const WEIGHTS = { watch: 0.5, engagement: 0.2, retention: 0.15, live: 0.15 };
const PILLARS = Object.keys(WEIGHTS);
const WINDOW_MAX = 10;
const FREEZE_DAYS = 7;

// --- pillar values (null = no honest data; never zero-filled) ---

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
  // view-weighted average across channels that actually report analytics
  return { value: den > 0 ? Math.round((num / den) * 100) / 100 : null, channels };
}

function pillarValues(e) {
  return {
    // day-7 YouTube views, both channels (build-data gates late-reg + <7d to null).
    // X plays are excluded from the watch pillar: plays have no history before
    // 2026-08-21, so a blended day-7 number would fabricate a disadvantage for
    // older episodes. Basis is stated in coverage and in About.
    watch: e.metrics.week1Velocity ?? null,
    // likes + audience comments per 1k YT views, lifetime (stable by day 7)
    engagement: e.metrics.engagementPer1k ?? null,
    // averageViewPercentage from YT Analytics, view-weighted across reporting channels
    retention: retentionOf(e.slug).value,
    // live turnout: peak concurrents + chat messages (two sub-percentiles averaged)
    live: e.live ? { peak: e.live.peak, chat: e.live.chatMessages } : null,
  };
}

// midrank percentile of v within pool (array of numbers incl. v), 0–100.
// pool.length must be >= 2 to mean anything.
function percentile(v, pool) {
  const below = pool.filter((x) => x < v).length;
  const equal = pool.filter((x) => x === v).length - 1; // excluding self
  return Math.round(((below + equal / 2) / (pool.length - 1)) * 100);
}

// --- core: rate ONE episode within its window, given every member's pillar values ---

function rateEpisode(target, members) {
  // pools per pillar: members with honest data (live uses both sub-values)
  const pools = {};
  for (const p of PILLARS) {
    pools[p] = members.filter((m) => m.values[p] != null);
  }

  // composite for each member: percentile per pillar it HAS (pool >= 2),
  // weights redistributed over those pillars
  const composites = [];
  for (const m of members) {
    const pct = {};
    for (const p of PILLARS) {
      if (m.values[p] == null || pools[p].length < 2) continue;
      if (p === "live") {
        const peakPool = pools.live.map((x) => x.values.live.peak);
        const chatPool = pools.live.map((x) => x.values.live.chat);
        pct[p] = Math.round(
          (percentile(m.values.live.peak, peakPool) + percentile(m.values.live.chat, chatPool)) / 2
        );
      } else {
        pct[p] = percentile(m.values[p], pools[p].map((x) => x.values[p]));
      }
    }
    const present = Object.keys(pct);
    const wSum = present.reduce((a, p) => a + WEIGHTS[p], 0);
    const weights = {};
    let score = null;
    if (present.length && wSum > 0) {
      score = 0;
      for (const p of present) {
        weights[p] = Math.round((WEIGHTS[p] / wSum) * 10000) / 10000;
        score += (pct[p] / 100) * weights[p];
      }
      score = Math.round(score * 10000) / 10000;
    }
    composites.push({ slug: m.slug, ep: m.ep, pct, weights, score });
  }

  const mine = composites.find((c) => c.slug === target.slug);
  const scored = composites.filter((c) => c.score != null);
  // rank by composite desc; ties broken by earlier episode (stated, deterministic)
  let rank = null;
  if (mine.score != null) {
    rank = 1 + scored.filter((c) => c.score > mine.score || (c.score === mine.score && c.ep < mine.ep)).length;
  } else if (members.length === 1) {
    rank = 1; // first episode: nothing to compare, #1 of 1 by definition
  }

  const pillarScores = {};
  const missing = [];
  for (const p of PILLARS) {
    const v = target.values[p];
    const has = v != null && pools[p].length >= 2;
    pillarScores[p] = {
      value: v,
      pctl: has ? mine.pct[p] : null,
      weight: has ? mine.weights[p] : 0,
    };
    if (!has) missing.push(p + (v != null && pools[p].length < 2 ? " (no peer to compare)" : ""));
  }

  return { rank, n: members.length, score: mine.score, pillarScores, missing };
}

// --- store orchestration: frozen entries pass through untouched ---

export function computeRatings({ now = Date.now() } = {}) {
  const data = computeAll({ now });
  const eps = data.episodes; // premiere-ordered, ep numbered
  let store = { version: 1, algorithm: "composite-v1", weights: WEIGHTS, updatedAt: null, ratings: [] };
  if (existsSync(STORE_PATH)) {
    try { store = JSON.parse(readFileSync(STORE_PATH, "utf8")); } catch { /* corrupt store: rebuild provisionals, frozen are lost only if file is unreadable */ }
  }
  const bySlug = new Map((store.ratings || []).map((r) => [r.slug, r]));

  const all = eps.map((e) => ({ slug: e.slug, ep: e.ep, premiere: e.premiere, values: pillarValues(e), ageDays: e.ageDays }));
  const ratings = [];
  let frozenKept = 0, computed = 0;

  for (const e of all) {
    const prior = bySlug.get(e.slug);
    if (prior?.frozenAt) {
      ratings.push(prior); // frozen forever — byte-stable pass-through
      frozenKept++;
      continue;
    }
    // window: this episode + up to 9 that aired before it (ep order = air order)
    const members = all.filter((m) => m.ep <= e.ep && m.ep > e.ep - WINDOW_MAX);
    const r = rateEpisode(e, members);
    const retention = retentionOf(e.slug);
    const nowIso = new Date(now).toISOString();
    const entry = {
      ep: e.ep,
      slug: e.slug,
      windowIds: members.map((m) => m.slug),
      rank: r.rank,
      n: r.n,
      score: r.score,
      pillarScores: r.pillarScores,
      coverage: {
        missingPillars: r.missing,
        watchBasis: "yt-day7", // X plays excluded: no plays history before 2026-08-21
        retentionChannels: retention.channels,
      },
      provisional: e.ageDays < FREEZE_DAYS,
      computedAt: nowIso,
      frozenAt: e.ageDays >= FREEZE_DAYS ? nowIso : null,
    };
    ratings.push(entry);
    computed++;
  }

  ratings.sort((a, b) => a.ep - b.ep);
  return { ...store, weights: WEIGHTS, updatedAt: new Date(now).toISOString(), ratings, _frozenKept: frozenKept, _computed: computed };
}

// --- main ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dry = process.argv.includes("--dry");
  const out = computeRatings();
  const { _frozenKept, _computed, ...store } = out;
  if (!dry) writeFileSync(STORE_PATH, JSON.stringify(store, null, 1) + "\n");
  for (const r of store.ratings) {
    const flags = [r.provisional ? "provisional" : "frozen", r.coverage.missingPillars.length ? `◐ missing: ${r.coverage.missingPillars.join(", ")}` : "full basis"];
    console.log(`E${r.ep} ${r.slug.slice(0, 34)} — #${r.rank} of ${r.n} (score ${r.score ?? "–"}) [${flags.join(" · ")}]`);
  }
  console.log(`ratings: ${_computed} computed, ${_frozenKept} frozen kept${dry ? " (dry run — store not written)" : ` — wrote ${STORE_PATH}`}`);
}
