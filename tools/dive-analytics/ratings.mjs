#!/usr/bin/env node
// ratings.mjs — episode health (health21-v3): one 0–100 score per episode,
// measured over its first three weeks against the episodes before it, frozen
// once written, and rebuildable from what the entry itself stores.
//
// Definition (constitutional; PRD v4 §1 as amended by PRD v9 §3.2):
//   - The read window is the episode's first 21 days (READ_DAYS, the measured
//     flatline point). An entry exists ONLY once the episode's last snapshot
//     is at least 21 days old; younger episodes have no entry and no surface.
//   - Peers = the WINDOW_N (8) episodes that aired BEFORE it, minus promo
//     outliers (as flagged at freeze time — stored, never re-evaluated), minus
//     peers with no honest reading for a check. Each check needs MIN_PEERS (3)
//     or it is absent with a reason. Peers never include later episodes, so a
//     finished score NEVER changes when new episodes land.
//   - Every comparative check is "this episode vs the typical peer" on ONE
//     basis (rule 11), stamped as ageBasis:
//       watch      35%  YouTube views at day 21 (or the earliest real snapshot if
//                       tracked later) vs peers' snapshots at that same age  [sameAge]
//       engagement 15%  likes+comments per 1k views at own read age vs peers at
//                       their own read age                                  [sameAge]
//       retention  15%  share watched: history line at own day 21 vs peers' lines
//                       at their day 21 [sameAge]; until every member has such a
//                       line, all from the current analytics file            [mature]
//       live       15%  peak concurrents and chat messages vs peers, averaged   [ageFree]
//                       chat = baselines.liveChatOf: without LinkedIn, absent when
//                       LinkedIn's count is unknown (health21-v3); a peer counts
//                       only with both readings
//       conversion 10%  subscribers per 1k analytics views, same rule as retention
//       sentiment  10%  positive share of directional feedback posted within 21 d,
//                       on the sources every window member has coverage for, needing
//                       3+ directional comments from 3+ people                [mature]
//     score = round(clamp(50 × own ÷ typical, 0..100)); 50 = right at typical.
//   - Missing-data rule: a check with no honest number drops out and its weight
//     is shared by the rest. Never estimate, never interpolate, never zero-fill.
//     A score ships only with ≥2 checks and ≥ half the planned weight.
//   - The first episode has no earlier peers: it sets the baseline and carries
//     no score, stated as a reason — never rendered as a zero.
//   - Entries are frozen at write time and NEVER change within an algorithm
//     version. Each check stores the peer values it used (slug, value, atDay,
//     source, readDate) so the validator can rebuild the score from the entry
//     and the inputs from the history stores. Inputs read from the overwritten
//     analytics file (no history line yet) are stamped reproducible: false.
//   - A version bump re-derives every entry visibly (rederivedFrom stamped),
//     and only through a step declared in REDERIVES: the step rebuilds an
//     entry of the previous algorithm from what the entry stores (its window,
//     its frozen outlier verdicts, every check it does not change) plus the
//     append-only store the changed check reads. The frozen-bytes guard and
//     the validator replay the step and accept nothing else.
//
// Store: data/restream/episode-ratings.json — one entry per FINISHED episode.
// Deterministic: no model calls, no network. Reads the same files as build-data.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeAll } from "./build-data.mjs";
import { assertFrozenRatingsUnchanged, currentAnalyticsCohort, assertSourceStoreIntegrity } from "./source-integrity.mjs";
import { atomicWriteText, acquireSourceLock } from "./source-io.mjs";
import {
  MIN_PEERS, NOTES, READ_DAYS, WINDOW_N, anomalyFlags, engagementPer1kOf, firstYtSnapshot,
  flagReason, liveChatOf, peersFor, round1, round3, scoreOf, trueMedian, windowFor, ytCurrentAge,
  ytHistoryAt, ytSnapshotAt, ytViewsOf, ageDaysOf,
} from "./baselines.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const STORE_PATH = join(ROOT, "data", "restream", "episode-ratings.json");
const YTA_DIR = join(ROOT, "data", "restream", "yt-analytics");
const HISTORY_DIR = join(ROOT, "data", "restream", "yt-analytics-history");

export const ALGORITHM = "health21-v3";
export const STORE_VERSION = 4;
export const WEIGHTS = Object.freeze({
  watch: 0.35,
  engagement: 0.15,
  retention: 0.15,
  live: 0.15,
  conversion: 0.10,
  sentiment: 0.10,
});
export { READ_DAYS };
export const MIN_WEIGHT = 0.5; // no score on less than half the planned evidence
const CHECKS = Object.keys(WEIGHTS);
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

// --- store readers (injectable for the fixture test) ---

function readAnalytics(slug) {
  const p = join(YTA_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function readHistory(slug) {
  const p = join(HISTORY_DIR, `${slug}.jsonl`);
  if (!existsSync(p)) return [];
  try { return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
const DEFAULT_IO = { readAnalytics, readHistory };

// --- raw per-episode values, all measured from stored data only ---

// read age: day 21, or the first real snapshot's age when tracking started later
export function readAgeOf(e) {
  const first = firstYtSnapshot(e);
  if (!first) return null;
  const firstAge = ageDaysOf(first.ts, e.premiere);
  return Math.max(READ_DAYS, firstAge);
}

// view-weighted share watched / subscribers per 1k from a channels block
// (the analytics file's `channels` or a history line's `channels`)
function blendFrom(channels, pick) {
  let num = 0, den = 0;
  const used = [];
  for (const [key, ch] of Object.entries(channels || {})) {
    const t = ch?.totals ?? ch; // analytics file nests totals; history lines are flat
    if (!t || !Number.isFinite(t.views) || t.views <= 0) continue;
    const v = pick(t);
    if (!Number.isFinite(v)) continue;
    num += v * t.views; den += t.views; used.push(key);
  }
  return den > 0 ? { value: Math.round((num / den) * 100) / 100, channels: used } : { value: null, channels: [] };
}
function conversionFrom(channels) {
  let subs = 0, views = 0;
  for (const key of YT_KEYS) {
    const t = channels?.[key]?.totals ?? channels?.[key];
    if (!t || !Number.isFinite(t.subscribersGained) || !Number.isFinite(t.views)) return null;
    subs += t.subscribersGained; views += t.views;
  }
  return views > 0 ? round1((subs / views) * 1000) : null;
}

// An analytics-file reading for a check: {value, source, readDate, atDay}.
// sameAge needs a history line within tolerance of the episode's own day 21;
// mature reads the current file (the episode is ≥ 21 d by construction).
function analyticsReading(e, kind, io, { basis }) {
  const pick = kind === "retention"
    ? (ch) => blendFrom(ch, (t) => t.averageViewPercentage)
    : (ch) => ({ value: conversionFrom(ch), channels: [] });
  if (basis === "sameAge") {
    const line = ytHistoryAt(io.readHistory(e.slug), READ_DAYS, e.premiere);
    if (!line) return null;
    const r = pick(line.channels);
    return r.value == null ? null : { value: r.value, channels: r.channels, source: "history", readDate: line.date, atDay: round1(line.ageDays) };
  }
  const file = io.readAnalytics(e.slug);
  if (!file) return null;
  const cohort = currentAnalyticsCohort(e, file);
  if (!cohort.length) return null;
  const r = pick(Object.fromEntries(cohort));
  return r.value == null ? null : { value: r.value, channels: r.channels, source: "analytics-file", readDate: (file.updatedAt || "").slice(0, 10) || null, atDay: round1(ageDaysOf(file.updatedAt || Date.now(), e.premiere)) };
}

// directional-feedback share on the given sources, comments posted within
// the read window only — 3+ directional comments from 3+ people or nothing
function sentimentOf(e, sources) {
  // comments still being read are an incomplete reading, never a smaller one
  if (e.comments?.pending) return null;
  const cutoff = premiereMs(e.premiere) + READ_DAYS * DAY;
  const list = (e.comments?.list || []).filter((c) => sources.has(c.source) && c.at && Date.parse(c.at) <= cutoff);
  const directional = list.filter((c) => ["positive", "negative", "mixed"].includes(c.sentiment));
  const people = new Set(directional.map((c) => `${c.source}:${String(c.author || "viewer").trim().toLowerCase()}`)).size;
  if (directional.length < 3 || people < 3) return null;
  const pos = directional.filter((c) => c.sentiment === "positive").length;
  const mixed = directional.filter((c) => c.sentiment === "mixed").length;
  return { share: round1(((pos + mixed * 0.5) / directional.length) * 100), directional: directional.length, people };
}
const coverageOf = (e) => (e.comments?.xCoverage === "covered" ? "yt+x" : "yt");

// --- score ONE finished episode against its window peers ---

function check(own, peerSet, extra = {}) {
  if (own == null || !Number.isFinite(own.value)) return null;
  if (peerSet.typical == null) {
    return { value: own.value, typical: null, ratio: null, score: null, sample: peerSet.n, peers: peerSet.peers, reason: peerSet.reason, ...extra };
  }
  const ratio = round3(own.value / peerSet.typical);
  return { value: own.value, typical: peerSet.typical, ratio, score: scoreOf(own.value, peerSet.typical), sample: peerSet.n, peers: peerSet.peers, reason: null, ...extra };
}

export function scoreEpisode(target, window, flags, io = DEFAULT_IO) {
  const checks = {};
  const age = readAgeOf(target);
  if (!Number.isFinite(age)) {
    const missingReason = target.latest?.ytTotal != null ? NOTES.noFullDayReading : NOTES.noYtReading;
    const empty = Object.fromEntries(CHECKS.map((key) => [key, {
      value: null, typical: null, ratio: null, score: null, weight: 0,
      sample: 0, peers: [], reason: missingReason, ageBasis: null,
      note: null, excluded: [],
    }]));
    return { score: null, checks: empty, missingChecks: [...CHECKS], atDay: null, reason: missingReason, reproducible: true };
  }
  const atDay = round1(age);
  const peerOf = (p, value, extra) => ({ slug: p.slug, value, ...extra });

  // watch: same-age views — own at its read age, every peer at that same age
  {
    const ownSnap = ytSnapshotAt(target, age);
    const ps = peersFor({ own: target, window, flags, valueOf: (p) => { const s = ytSnapshotAt(p, age); return s ? ytViewsOf(s) : null; } });
    ps.peers = ps.peers.map((x) => { const p = window.find((w) => w.slug === x.slug); const s = ytSnapshotAt(p, age); return peerOf(p, x.value, { atDay, source: "snapshot", readDate: s.ts.slice(0, 10) }); });
    checks.watch = check(ownSnap ? { value: ytViewsOf(ownSnap) } : null, ps, { atDay, ageBasis: "sameAge", note: NOTES.sameAge, excluded: ps.excluded });
  }
  // engagement: each episode at its OWN read age (a rate, so ages align)
  {
    const ownSnap = ytSnapshotAt(target, age);
    const ps = peersFor({ own: target, window, flags, valueOf: (p) => { const pAge = readAgeOf(p); const s = Number.isFinite(pAge) ? ytSnapshotAt(p, pAge) : null; return s ? engagementPer1kOf(s) : null; } });
    ps.peers = ps.peers.map((x) => { const p = window.find((w) => w.slug === x.slug); const pAge = readAgeOf(p); const s = ytSnapshotAt(p, pAge); return peerOf(p, x.value, { atDay: round1(pAge), source: "snapshot", readDate: s.ts.slice(0, 10) }); });
    checks.engagement = check(ownSnap ? { value: engagementPer1kOf(ownSnap) } : null, ps, { atDay, ageBasis: "sameAge", note: NOTES.sameAge, excluded: ps.excluded });
  }
  // retention + conversion: sameAge when own AND every usable peer has a day-21
  // history line; otherwise all from the current analytics file (mature)
  for (const kind of ["retention", "conversion"]) {
    const usable = window.filter((p) => !flags.get(p.slug)?.flagged);
    const allSameAge = analyticsReading(target, kind, io, { basis: "sameAge" }) && usable.length && usable.every((p) => analyticsReading(p, kind, io, { basis: "sameAge" }));
    const basis = allSameAge ? "sameAge" : "mature";
    const own = analyticsReading(target, kind, io, { basis });
    const readings = new Map(window.map((p) => [p.slug, analyticsReading(p, kind, io, { basis })]));
    const ps = peersFor({ own: target, window, flags, valueOf: (p) => readings.get(p.slug)?.value ?? null });
    ps.peers = ps.peers.map((x) => { const r = readings.get(x.slug); return { slug: x.slug, value: x.value, atDay: r.atDay, source: r.source, readDate: r.readDate }; });
    checks[kind] = check(own, ps, { ageBasis: basis, note: NOTES[basis], excluded: ps.excluded, ...(kind === "retention" && own ? { channels: own.channels } : {}) });
  }
  checks.live = liveCheck(target, window, flags);
  // sentiment: on the sources every window member has coverage for
  {
    const members = [target, ...window.filter((p) => !flags.get(p.slug)?.flagged)];
    const common = members.every((m) => coverageOf(m) === "yt+x") ? new Set(["yt", "x"]) : new Set(["yt"]);
    const own = sentimentOf(target, common);
    const ps = peersFor({ own: target, window, flags, valueOf: (p) => sentimentOf(p, common)?.share ?? null });
    ps.peers = ps.peers.map((x) => ({ slug: x.slug, value: x.value, atDay: READ_DAYS, source: "comments", readDate: null }));
    checks.sentiment = check(own ? { value: own.share } : null, ps, { ageBasis: "mature", note: NOTES.mature, excluded: ps.excluded, sources: [...common], ...(own ? { people: own.people } : {}) });
  }
  return { ...finishScore(checks, window.length), atDay };
}

// live: peak and chat each against their typical, averaged — air-night
// numbers, age-free. Chat is baselines.liveChatOf (health21-v3): LinkedIn's
// chat left out, absent when LinkedIn's count is unknown. A peer counts only
// with both readings, so the two typicals come from the same episodes.
function liveOf(e) {
  const peak = e?.live?.peak, chat = liveChatOf(e);
  return Number.isFinite(peak) && Number.isFinite(chat) ? { peak, chat } : null;
}
function liveCheck(target, window, flags) {
  // no live session or no chat total: the check does not exist
  if (!Number.isFinite(target.live?.peak) || !Number.isFinite(target.live?.chatMessages)) return null;
  const own = liveOf(target);
  if (!own) return { value: null, typical: null, ratio: null, score: null, sample: 0, peers: [], reason: NOTES.liveChatUnknown, ageBasis: "ageFree", note: NOTES.liveChat, excluded: [] };
  const ps = peersFor({ own: target, window, flags, valueOf: (p) => liveOf(p)?.peak ?? null });
  if (ps.typical == null) return { value: own, typical: null, ratio: null, score: null, sample: ps.n, peers: [], reason: ps.reason, ageBasis: "ageFree", note: NOTES.liveChat, excluded: ps.excluded };
  const peers = ps.peers.map((x) => ({ slug: x.slug, value: liveOf(window.find((w) => w.slug === x.slug)), atDay: null, source: "live-event", readDate: null }));
  const typical = { peak: ps.typical, chat: round1(trueMedian(peers.map((p) => p.value.chat))) };
  const rp = round3(own.peak / typical.peak);
  const rc = round3(own.chat / typical.chat);
  return {
    value: own, typical, ratio: round3((rp + rc) / 2),
    score: Math.round(Math.min(100, Math.max(0, 50 * ((rp + rc) / 2)))),
    sample: ps.n, peers, reason: null, ageBasis: "ageFree", note: NOTES.liveChat, excluded: ps.excluded,
  };
}

// weights, score, absence reasons — shared by a fresh read and a re-derive
function finishScore(checks, windowLength) {
  const present = CHECKS.filter((c) => checks[c]?.ratio != null);
  const availableWeight = present.reduce((a, c) => a + WEIGHTS[c], 0);
  let score = null;
  let reason = null;
  if (!windowLength) {
    reason = "first episode — it sets the baseline, with nothing earlier to compare against";
  } else if (present.length < 2 || availableWeight < MIN_WEIGHT) {
    reason = present.length ? "too few checks have honest numbers to score this episode" : NOTES.fewPeers;
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
    const cs = checks[c];
    if (cs && cs.ratio != null && score != null) shaped[c] = cs;
    else if (cs) shaped[c] = { ...cs, weight: 0 };
    else shaped[c] = { value: null, typical: null, ratio: null, score: null, weight: 0, sample: 0, peers: [], reason: windowLength ? NOTES.fewPeers : null, ageBasis: null, note: null, excluded: [] };
    if (shaped[c].ratio == null && windowLength) missing.push(c);
  }
  // rebuildable when every CONTRIBUTING check's inputs live in an append-only store
  const reproducible = !present.some((c) => (shaped[c].peers || []).some((p) => p.source === "analytics-file"));
  return { score, checks: shaped, missingChecks: missing, reason, reproducible };
}

// --- declared re-derives (rule 9) ---
//
// The only way a frozen entry may change. A step rebuilds an entry of the
// previous algorithm from what the entry stores — its window, the outlier
// verdicts it froze with, every check the step does not touch — plus the
// append-only store the changed check reads, then re-weights. Every other
// byte stays as frozen. `assertFrozenRatingsUnchanged` and the validator
// replay the declared steps from earlier store bytes and accept nothing else.

// health21-v2 → v3 (AUDIT-2026-09-29 #12): the live check's chat leaves
// LinkedIn out. Its inputs come from the live-event files, frozen at first
// ingest; the step first proves the entry's stored v2 values still match
// them, so a changed input can never ride in on a rules change.
function liveWithoutLinkedin(entry, bySlug) {
  const episodeOf = (slug) => {
    const e = bySlug.get(slug);
    if (!e) throw new Error(`re-derive ${entry.slug}: ${slug} is not in the episode list`);
    return e;
  };
  const target = episodeOf(entry.slug);
  const window = (entry.windowIds || []).filter((s) => s !== entry.slug).map(episodeOf);
  const checks = structuredClone(entry.checks || {}); // finishScore writes weights; the input stays as frozen
  const stored = checks.live;
  const v2 = (e) => ({ peak: e.live?.peak ?? null, chat: e.live?.chatMessages ?? null });
  const same = (a, b) => a?.peak === b.peak && a?.chat === b.chat;
  if (stored?.value != null && !same(stored.value, v2(target))) throw new Error(`re-derive ${entry.slug}: stored live values differ from the live-event file`);
  for (const p of stored?.peers || []) if (!same(p.value, v2(episodeOf(p.slug)))) throw new Error(`re-derive ${entry.slug}: stored live peer ${p.slug} differs from the live-event file`);
  // the outlier verdicts the entry froze with (and their reasons), never today's
  const frozen = new Map((entry.excluded || []).map((x) => [x.slug, { ...x }]));
  const flags = new Map([...frozen.keys()].map((slug) => [slug, { flagged: true }]));
  // an entry that froze with no live session keeps that; a rules change
  // never brings in an input the entry did not have
  if (!(stored?.value == null && stored?.ageBasis == null)) {
    const live = liveCheck(target, window, flags);
    checks.live = live && { ...live, excluded: live.excluded.map((x) => frozen.get(x.slug) ?? x) };
  }
  const r = finishScore(checks, window.length);
  return {
    ...entry,
    algorithm: "health21-v3",
    score: r.score,
    checks: r.checks,
    missingChecks: r.missingChecks,
    reason: r.reason,
    reproducible: r.reproducible,
    rederivedFrom: { algorithm: entry.algorithm, score: entry.score },
  };
}

export const REDERIVES = Object.freeze({
  "health21-v3": { from: "health21-v2", entry: liveWithoutLinkedin },
});

// the declared algorithms from `from` to `to`, oldest first; throws when no
// chain of declared steps connects them
export function rederivePath(from, to) {
  const path = [to];
  while (path[0] !== from) {
    const step = REDERIVES[path[0]];
    if (!step) throw new Error(`frozen rating: no declared re-derive from ${from} to ${to}`);
    path.unshift(step.from);
  }
  return path;
}

// what the frozen-bytes guard needs: the declared path, and the entry each
// frozen entry must become — built from the episodes' append-only inputs
export function declaredRederive(episodes) {
  const bySlug = new Map(episodes.map((e) => [e.slug, e]));
  return {
    path: rederivePath,
    entry: (row, to) => rederivePath(row.algorithm, to).slice(1).reduce((r, alg) => REDERIVES[alg].entry(r, bySlug), row),
  };
}

// --- store orchestration ---

export function computeRatings({ now = Date.now(), io = DEFAULT_IO } = {}) {
  assertSourceStoreIntegrity(ROOT, now);
  const data = computeAll({ now });
  let store = null;
  if (existsSync(STORE_PATH)) {
    store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (!Array.isArray(store.scores)) throw new Error("ratings store has no scores array");
  }
  const sameAlgo = store?.algorithm === ALGORITHM;
  const all = data.episodes;
  const rederive = declaredRederive(all);
  // a rules change re-derives every frozen entry through the declared steps
  // (it throws when no step connects the two algorithms); nothing frozen is
  // ever recomputed from scratch
  const prior = new Map(sameAlgo
    ? (store.scores || []).map((r) => [r.slug, r])
    : (store?.scores || []).filter((r) => r.frozenAt).map((r) => [r.slug, rederive.entry(r, ALGORITHM)]));

  const flags = anomalyFlags(all);

  const scores = [];
  let frozenKept = 0, computed = 0;
  for (const e of all) {
    const kept = prior.get(e.slug);
    if (kept) {
      scores.push(kept); // frozen forever within this algorithm version (re-derived on a declared bump)
      frozenKept++;
      continue;
    }
    const ytAge = ytCurrentAge(e);
    if (!Number.isFinite(ytAge) || ytAge < READ_DAYS) continue; // no real three-week YouTube reading yet
    const window = windowFor(e, all, { side: "before", n: WINDOW_N });
    const r = scoreEpisode(e, window, flags, io);
    const excluded = window.filter((p) => flags.get(p.slug)?.flagged).map((p) => ({ slug: p.slug, why: flagReason(flags, p.slug) }));
    scores.push({
      ep: e.ep,
      slug: e.slug,
      premiere: e.premiere,
      algorithm: ALGORITHM,
      windowIds: [...window.map((p) => p.slug), e.slug],
      excluded,
      readDays: READ_DAYS,
      atDay: r.atDay,
      frozenAtDay: round1(ytAge),
      readCompleteOn: readCompleteOn(e.premiere),
      score: r.score,
      checks: r.checks,
      missingChecks: r.missingChecks,
      reason: r.reason,
      reproducible: r.reproducible,
      computedAt: new Date(now).toISOString(),
      frozenAt: new Date(now).toISOString(),
    });
    computed++;
  }

  scores.sort((a, b) => a.ep - b.ep);
  const out = {
    version: STORE_VERSION,
    algorithm: ALGORITHM,
    weights: WEIGHTS,
    readDays: READ_DAYS,
    windowN: WINDOW_N,
    minPeers: MIN_PEERS,
    updatedAt: new Date(now).toISOString(),
    scores,
  };
  if (store && !sameAlgo) {
    out.rederivedFrom = rederivePath(store.algorithm, ALGORITHM).at(-2);
    out.rederivedAt = new Date(now).toISOString();
  } else if (store?.rederivedFrom) {
    out.rederivedFrom = store.rederivedFrom;
    out.rederivedAt = store.rederivedAt;
  }
  return { ...out, _frozenKept: frozenKept, _computed: computed, _rederive: rederive };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dry = process.argv.includes("--dry");
  const release = dry ? () => {} : acquireSourceLock(STORE_PATH);
  try {
  const { _frozenKept, _computed, _rederive, ...store } = computeRatings();
  for (const r of store.scores) {
    const flagsOut = [
      r.missingChecks.length ? `missing ${r.missingChecks.join(",")}` : "all checks",
      r.reason ? `reason: ${r.reason}` : null,
      r.reproducible ? null : "not yet rebuildable (no history line)",
    ].filter(Boolean);
    const was = r.rederivedFrom ? ` (${r.rederivedFrom.algorithm}: ${r.rederivedFrom.score ?? "–"})` : "";
    console.log(`E${r.ep} ${r.slug.slice(0, 34)} — health ${r.score ?? "–"}${was} [${flagsOut.join(" · ")}]`);
  }
  console.log(`episode health (${ALGORITHM}): ${_computed} computed, ${_frozenKept} frozen kept${store.rederivedFrom ? ` — re-derived from ${store.rederivedFrom}` : ""}${dry ? " (dry run — store not written)" : ` — wrote ${STORE_PATH}`}`);
  if (!dry) {
    const next = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_PATH)) assertFrozenRatingsUnchanged(readFileSync(STORE_PATH, "utf8"), next, { rederive: _rederive });
    atomicWriteText(STORE_PATH, next);
  }
  } finally { release(); }
}
