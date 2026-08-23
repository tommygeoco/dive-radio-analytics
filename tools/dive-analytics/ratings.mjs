#!/usr/bin/env node
// ratings.mjs — W12 episode health: one 0–100 score per episode, measured over
// its first three weeks and shown nowhere until those three weeks are over.
// (Owner directive 2026-08-23: replace the "#x of N" rank with a per-episode
//  three-week health score; nothing renders before the read completes.)
//
// Definition (constitutional):
//   - The read window is the episode's first 21 days — the measured flatline
//     point where growth stops. An episode gets a stored entry ONLY once it is
//     at least 21 days old; younger episodes have no entry and no surface.
//   - Window peers = up to 9 episodes that aired BEFORE it. Peers never include
//     later episodes, so a finished score NEVER changes when new episodes land.
//   - Every comparative check is a ratio — "this episode vs the typical earlier
//     episode" — converted to a 0–100 score where 50 = right at typical
//     (score = 50 × own ÷ typical, capped 0..100).
//       watch      35%  YT views at day 21 (or its earliest real snapshot if it
//                       was registered later) vs peers' REAL snapshot values at
//                       that same age. No extrapolation, no fabricated history.
//       engagement 15%  YT likes+comments per 1k YT views at the same read age,
//                       vs the peers' own three-week values.
//       retention  15%  averageViewPercentage (view-weighted across channels
//                       with data; channels stamped) vs peers' values.
//       live       15%  peak concurrents and chat messages vs peer typicals,
//                       averaged. Live data exists from air night.
//       conversion 10%  subscribers gained per 1k YT analytics views, both
//                       channels required, vs peers' values.
//       sentiment  10%  share of directional feedback that is positive (mixed
//                       counts half), needing 3+ directional comments from 3+
//                       people, vs peers' shares.
//   - Missing-data rule: a check with no honest number (no peer covers that
//     age, analytics absent, too little feedback) drops out and its weight is
//     shared by the rest. Never estimate, never interpolate, never zero-fill.
//     A score ships only when at least half the planned weight is present.
//   - The first episode has no earlier peers: it sets the baseline and carries
//     no score, stated as a reason — never rendered as a zero.
//   - Entries are frozen at write time and NEVER change on re-processing within
//     the same algorithm version. A version bump re-derives every entry visibly
//     (stamped at the store root) — never silently.
//
// Store: data/restream/episode-ratings.json (path kept so the cron chain and
// its consumers stay valid) — one entry per FINISHED episode, append-only.
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

export const ALGORITHM = "health21-v1";
export const WEIGHTS = Object.freeze({
  watch: 0.35,
  engagement: 0.15,
  retention: 0.15,
  live: 0.15,
  conversion: 0.10,
  sentiment: 0.10,
});
export const READ_DAYS = 21; // measured flatline point: episodes stop growing ~week 3
export const MIN_WEIGHT = 0.5; // no score on less than half the planned evidence
const CHECKS = Object.keys(WEIGHTS);
const WINDOW_MAX = 10;
const DAY = 86400000;
const YT_KEYS = ["yt:joindiveclub", "yt:designertom"];
const PHX_OFFSET = 7 * 3600000;

function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET;
}

export function readCompleteOn(premiere) {
  return new Date(premiereMs(premiere) + READ_DAYS * DAY - PHX_OFFSET).toISOString().slice(0, 10);
}

function median(vals) {
  const v = [...vals].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const toScore = (ratio) => Math.round(Math.min(100, Math.max(0, 50 * ratio)));

// --- raw per-episode values, all measured from stored data only ---

function snapAt(snaps, cutoffMs) {
  let best = null;
  for (const s of snaps) {
    const t = Date.parse(s.ts);
    if (t <= cutoffMs && (!best || t > best.t)) best = { t, s };
  }
  return best ? best.s : null;
}

const ytViews = (snap) => YT_KEYS.reduce((a, k) => a + (snap.byDest[k]?.views || 0), 0);
const ytEng = (snap) => YT_KEYS.reduce((a, k) => a + (snap.byDest[k]?.likes || 0) + (snap.byDest[k]?.comments || 0), 0);

// read age: day 21, or the first real snapshot's age when tracking started later
function readAgeOf(e) {
  const prem = premiereMs(e.premiere);
  const firstAge = (Date.parse(e.snapshots[0].ts) - prem) / DAY;
  return Math.max(READ_DAYS, firstAge);
}

function watchAt(e, ageDays) {
  const snap = snapAt(e.snapshots, premiereMs(e.premiere) + ageDays * DAY);
  return snap ? ytViews(snap) : null;
}

// a peer only counts when its snapshot coverage genuinely spans that age
function peerCovers(p, ageDays) {
  const prem = premiereMs(p.premiere);
  const first = (Date.parse(p.snapshots[0].ts) - prem) / DAY;
  const last = (Date.parse(p.snapshots[p.snapshots.length - 1].ts) - prem) / DAY;
  return first <= ageDays && last >= ageDays;
}

function engagementAt(e, ageDays) {
  const snap = snapAt(e.snapshots, premiereMs(e.premiere) + ageDays * DAY);
  if (!snap) return null;
  const v = ytViews(snap);
  return v > 0 ? r1((ytEng(snap) / v) * 1000) : null;
}

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

function conversionOf(slug) {
  const p = join(YTA_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  let j;
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  let subs = 0, views = 0;
  for (const key of YT_KEYS) {
    const t = j.channels?.[key]?.totals;
    if (!t || !Number.isFinite(t.subscribersGained) || !Number.isFinite(t.views)) return null;
    subs += t.subscribersGained;
    views += t.views;
  }
  return views > 0 ? r1((subs / views) * 1000) : null;
}

// directional-feedback share: positive + half of mixed, needing 3+ directional
// comments from 3+ people — the same thresholds the show checks use
function sentimentOf(e) {
  const list = e.comments?.list || [];
  const directional = list.filter((c) => ["positive", "negative", "mixed"].includes(c.sentiment));
  const people = new Set(directional.map((c) => `${c.source}:${String(c.author || "viewer").trim().toLowerCase()}`)).size;
  if (directional.length < 3 || people < 3) return null;
  const pos = directional.filter((c) => c.sentiment === "positive").length;
  const mixed = directional.filter((c) => c.sentiment === "mixed").length;
  return { share: r1(((pos + mixed * 0.5) / directional.length) * 100), directional: directional.length, people };
}

// --- score ONE finished episode against its window peers ---

function check(value, typical, sample, extra = {}) {
  if (value == null) return null;
  if (typical == null || typical <= 0) return null;
  const ratio = r3(value / typical);
  return { value, typical: r3(typical), ratio, score: toScore(ratio), sample, ...extra };
}

function scoreEpisode(target, peers) {
  const checks = {};
  const age = readAgeOf(target); // full precision — rounding only for display
  const atDay = r1(age);

  // watch: same-age views — the one check that must be strictly age-matched
  const ownWatch = watchAt(target, age);
  const watchPeers = peers.filter((p) => peerCovers(p, age)).map((p) => watchAt(p, age)).filter((v) => v != null);
  checks.watch = ownWatch != null && watchPeers.length
    ? check(ownWatch, median(watchPeers), watchPeers.length, { atDay })
    : null;

  // engagement: each episode at its OWN read age (a rate, so ages align honestly)
  const ownEng = engagementAt(target, age);
  const engPeers = peers.map((p) => engagementAt(p, readAgeOf(p))).filter((v) => v != null);
  checks.engagement = ownEng != null && engPeers.length ? check(ownEng, median(engPeers), engPeers.length) : null;

  // retention: view-weighted watch percentage from YouTube analytics
  const ownRet = retentionOf(target.slug);
  const retPeers = peers.map((p) => retentionOf(p.slug).value).filter((v) => v != null);
  checks.retention = ownRet.value != null && retPeers.length
    ? check(ownRet.value, median(retPeers), retPeers.length, { channels: ownRet.channels })
    : null;

  // live: peak and chat ratios averaged — air-night numbers, age-free
  if (target.live) {
    const peakPeers = peers.map((p) => p.live?.peak).filter((v) => v != null);
    const chatPeers = peers.map((p) => p.live?.chat).filter((v) => v != null);
    const pk = peakPeers.length ? check(target.live.peak, median(peakPeers), peakPeers.length) : null;
    const ch = chatPeers.length ? check(target.live.chat, median(chatPeers), chatPeers.length) : null;
    checks.live = pk && ch
      ? {
          value: { peak: target.live.peak, chat: target.live.chat },
          typical: { peak: pk.typical, chat: ch.typical },
          ratio: r3((pk.ratio + ch.ratio) / 2),
          score: toScore((pk.ratio + ch.ratio) / 2),
          sample: Math.min(pk.sample, ch.sample),
        }
      : null;
  } else checks.live = null;

  // conversion: subscribers per 1k analytics views, both channels required
  const ownConv = conversionOf(target.slug);
  const convPeers = peers.map((p) => conversionOf(p.slug)).filter((v) => v != null);
  checks.conversion = ownConv != null && convPeers.length ? check(ownConv, median(convPeers), convPeers.length) : null;

  // sentiment: positive share of directional feedback vs peers' shares
  const ownSent = sentimentOf(target);
  const sentPeers = peers.map((p) => sentimentOf(p)).filter((v) => v != null).map((v) => v.share);
  checks.sentiment = ownSent && sentPeers.length
    ? check(ownSent.share, median(sentPeers), sentPeers.length, { people: ownSent.people })
    : null;

  const present = CHECKS.filter((c) => checks[c] != null);
  const availableWeight = present.reduce((a, c) => a + WEIGHTS[c], 0);
  let score = null;
  let reason = null;
  if (!peers.length) {
    reason = "first episode — it sets the baseline, with nothing earlier to compare against";
  } else if (present.length < 2 || availableWeight < MIN_WEIGHT) {
    reason = "too few checks have honest numbers to score this episode";
  } else {
    score = 0;
    for (const c of present) {
      checks[c].weight = Math.round((WEIGHTS[c] / availableWeight) * 10000) / 10000;
      score += checks[c].score * checks[c].weight;
    }
    score = Math.round(score);
  }
  const shaped = {};
  const missing = [];
  for (const c of CHECKS) {
    if (checks[c] && score != null) shaped[c] = checks[c];
    else if (checks[c]) shaped[c] = { ...checks[c], weight: 0 };
    else {
      shaped[c] = { value: null, typical: null, ratio: null, score: null, weight: 0 };
      if (peers.length) missing.push(c);
    }
  }
  return { score, checks: shaped, missingChecks: missing, atDay, reason };
}

// --- store orchestration ---

export function computeRatings({ now = Date.now() } = {}) {
  const data = computeAll({ now });
  let store = null;
  if (existsSync(STORE_PATH)) {
    try { store = JSON.parse(readFileSync(STORE_PATH, "utf8")); } catch { /* unreadable store — rebuild below */ }
  }
  const sameAlgo = store?.algorithm === ALGORITHM;
  const prior = new Map(sameAlgo ? (store.scores || []).map((r) => [r.slug, r]) : []);

  const all = data.episodes.map((e) => ({
    slug: e.slug,
    ep: e.ep,
    premiere: e.premiere,
    ageDays: e.ageDays,
    snapshots: e.snapshots,
    live: e.live ? { peak: e.live.peak, chat: e.live.chatMessages } : null,
    comments: e.comments || null,
  }));

  const scores = [];
  let frozenKept = 0, computed = 0;
  for (const e of all) {
    if (e.ageDays < READ_DAYS) continue; // three weeks not over — nothing exists yet
    const kept = prior.get(e.slug);
    if (kept) {
      scores.push(kept); // frozen forever within this algorithm version
      frozenKept++;
      continue;
    }
    const peers = all.filter((m) => m.ep < e.ep && m.ep >= e.ep - (WINDOW_MAX - 1));
    const r = scoreEpisode(e, peers);
    scores.push({
      ep: e.ep,
      slug: e.slug,
      premiere: e.premiere,
      algorithm: ALGORITHM,
      windowIds: [...peers.map((p) => p.slug), e.slug],
      readDays: READ_DAYS,
      atDay: r.atDay,
      readCompleteOn: readCompleteOn(e.premiere),
      score: r.score,
      checks: r.checks,
      missingChecks: r.missingChecks,
      reason: r.reason,
      basis: `yt-views-at-own-read-age-vs-peer-values-at-theirs (read ${READ_DAYS}d; X plays excluded — no plays history before 2026-08-21)`,
      computedAt: new Date(now).toISOString(),
      frozenAt: new Date(now).toISOString(),
    });
    computed++;
  }

  scores.sort((a, b) => a.ep - b.ep);
  const out = {
    version: 3,
    algorithm: ALGORITHM,
    weights: WEIGHTS,
    readDays: READ_DAYS,
    updatedAt: new Date(now).toISOString(),
    scores,
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
  for (const r of store.scores) {
    const flags = r.score == null
      ? [r.reason]
      : [`read at day ${r.atDay}`, r.missingChecks.length ? `◐ missing: ${r.missingChecks.join(", ")}` : "full basis"];
    console.log(`E${r.ep} ${r.slug.slice(0, 34)} — health ${r.score ?? "–"} [${flags.join(" · ")}]`);
  }
  console.log(`episode health (${ALGORITHM}): ${_computed} computed, ${_frozenKept} frozen kept${store.rederivedFrom ? ` — re-derived from ${store.rederivedFrom}` : ""}${dry ? " (dry run — store not written)" : ` — wrote ${STORE_PATH}`}`);
}
