#!/usr/bin/env node
// health.mjs — W10 deterministic show checks + model-written health summary.
//
// This is the only script allowed to call a model for show health. It uses
// fetch directly and has no runtime dependencies. build-data.mjs only reads
// the persisted health-history.json store; it never calls a model.
//
// Deterministic formulas (health-v3, PRD v9 §3.1; all results clamped 0..100):
//   relative(value, typical) = 50 * value / typical, typical = true median of
//   the peers left after taking the eight episodes before the one being read
//   and removing promo outliers and peers with no honest reading (baselines.mjs).
//   Every measure carries ONE basis and a fixed plain-words note:
//     sameAge  own and every peer read at the same age (snapshot / history line)
//     mature   own and every peer at or past the measure's maturity age, as they
//              stand now (only until same-age history exists — never after a
//              measure has once been same-age)
//     ageFree  the measure does not move with age (live night, day-7 totals)
//   growth 25%          first-week slope over the last five clean weeks (ageFree)
//                       + the newest episode's same-age YouTube pace (sameAge)
//   audience quality 20% engagement per 1k at the newest episode's age vs peers
//                       at that age (sameAge); share watched of the latest
//                       episode ≥ 7 d vs peers' history lines at that age
//                       (sameAge) — mature until the history store has depth
//   reach efficiency 15% announce-to-play and X share of the latest finished
//                       clean episode vs peers (mature, 7 d)
//   live pull 15%       newest peak and chat vs peers (ageFree)
//   conversion 10%      subscribers per 1k of the latest episode ≥ 7 d, same
//                       rule as share watched
//   sentiment 15%       positive + half of mixed across the three newest
//                       episodes on the sources all three have coverage for
//                       (absolute scale: it never receives redistributed
//                       weight); commenters per 1k vs peers with complete
//                       replies (mature, 21 d)
//   Each measure needs MIN_PEERS (3) usable peers or it is absent with a reason.
//
// A missing measure is null with a reason, never zero. Available measures share
// their check's weight; available RELATIVE checks share missing checks' weights
// (an absolute-scale check keeps its base weight). The model may move the final
// score at most 8 points from that weighted mean. An entry is written whenever
// three or more checks are available; it records which (checkSet), and when
// that set changed since the last saved read the drivers must name the check
// that joined or left (prompt v4 — unconditional; under v3 only when the
// score also moved by more than 5). One immutable entry per Phoenix calendar day.
// Model failure is non-fatal: the previous entry remains the public truth;
// after seven days without a fresh entry the projection withholds the score.
//
// v8 W20 staleness audit (2026-08-23): this store CANNOT go stale the way
// recommendations.json did. Entries are dated append-only history — the
// validator judges each against its own stamped formula/prompt versions and
// against the committed bytes at HEAD, never against the current fact
// sheet, and the page shows every entry under its saved date. Keep-previous
// is correct here BY DESIGN; do not port the prune-or-regenerate pattern to
// this store.
//
// Run:
//   node tools/dive-analytics/health.mjs --dry          # math only, no model/write
//   node tools/dive-analytics/health.mjs --probe-model  # live model test, no write
//   node tools/dive-analytics/health.mjs                # append today's entry

import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATURITY_DAYS, MIN_PEERS, NOTES, READ_DAYS, SLOPE_N, anomalyFlags, currentAge, engagementPer1kOf,
  historyAt, peersFor, snapshotAt, trueMedian as baselineMedian, windowFor, ytViewsOf,
} from "./baselines.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "health-history.json");
const ANALYTICS_DIR = join(ROOT, "data", "restream", "yt-analytics");
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
const HISTORY_DIR = join(ROOT, "data", "restream", "yt-analytics-history");
const PROMPT_PATH = join(HERE, "health-prompt.md");
const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
const MAX_TOKENS = 16000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

// store v2 (PRD v9 W24): entries carry per-measure ageBasis/window/note and
// per-entry checkSet; v1 files are accepted and upgraded in place with every
// existing entry byte-identical.
export const HEALTH_STORE_VERSION = 2;
// health-v3 (2026-08-23, PRD v9): like-for-like bases, eight-episode windows,
// three-peer minimum per measure, episode-read selection, absolute-scale
// sentiment never inflated by absences. Saved entries keep their own stamp.
export const FORMULA_VERSION = "health-v3";
// prompt v4 (2026-08-24, W27): a changed check set must ALWAYS be named in the
// drivers — v3 only required it when the score also moved by more than 5, so
// the 2026-08-24 transition (two checks left, score held at 51) shipped with
// no reader-facing explanation anywhere. Drivers are now digit-free so the
// page can render them without carrying ungrounded numbers. Entries keep
// their stamp; pre-v4 entries are judged by the v3 rule.
// prompt v5 (2026-08-31, remediation W11.1): the prompt now states the
// validator's per-driver length cap (told 170, enforced 180). v4 never
// mentioned it, and the rule-10 check-set explanation reliably ran to ~200
// characters, so the model failed "drivers must contain one to three short
// plain strings" twice per run and the store kept the previous day's entry.
export const PROMPT_VERSION = 5;
export const BASE_WEIGHTS = Object.freeze({
  growth: 0.25,
  audienceQuality: 0.20,
  reachEfficiency: 0.15,
  livePull: 0.15,
  conversion: 0.10,
  sentiment: 0.15,
});
// historical entries are judged by the weights of the formula they were written under
export const WEIGHTS_BY_FORMULA = Object.freeze({
  "health-v1": BASE_WEIGHTS,
  "health-v2": BASE_WEIGHTS,
  "health-v3": BASE_WEIGHTS,
});
export const CHECK_LABELS = Object.freeze({
  growth: "growth", audienceQuality: "audience quality", reachEfficiency: "reach", livePull: "live turnout", conversion: "subscribers", sentiment: "goodwill",
});
export const STALE_WITHHOLD_DAYS = 7;

const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value, lo = 0, hi = 100) {
  return Math.min(hi, Math.max(lo, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

export function trueMedian(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

export function relativeScore(value, typical) {
  if (!Number.isFinite(value) || !Number.isFinite(typical) || typical <= 0) return null;
  return Math.round(clamp(50 * value / typical));
}

function phoenixDate(ms) {
  return new Date(ms - PHX_OFFSET).toISOString().slice(0, 10);
}

function premiereMs(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12) + PHX_OFFSET;
}

function observedAgeMs(episode) {
  return Date.parse(episode.latest.ts) - premiereMs(episode.premiere);
}

function youtubeViews(snapshot) {
  return Object.entries(snapshot?.byDest || {}).reduce(
    (sum, [key, metrics]) => sum + (key.startsWith("yt:") ? Number(metrics.views || 0) : 0),
    0,
  );
}

function lastAtOrBefore(snapshots, cutoff) {
  let best = null;
  for (const snapshot of snapshots || []) {
    const at = Date.parse(snapshot.ts);
    if (at <= cutoff && (!best || at > Date.parse(best.ts))) best = snapshot;
  }
  return best;
}

function repoPath(path) {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function displayNumber(value, suffix = "") {
  const rounded = round1(value);
  const number = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${number}${suffix}`;
}

function weightedRetention(analytics) {
  const required = ["yt:designertom", "yt:joindiveclub"];
  if (!analytics?.channels || required.some((key) => !analytics.channels[key])) return null;
  const rows = required.map((key) => analytics.channels[key])
    .map((channel) => ({
      views: channel?.totals?.views,
      value: channel?.totals?.averageViewPercentage,
    }))
    .filter((row) => Number.isFinite(row.views) && row.views > 0 && Number.isFinite(row.value));
  const views = rows.reduce((sum, row) => sum + row.views, 0);
  return views > 0 ? rows.reduce((sum, row) => sum + row.value * row.views, 0) / views : null;
}

function subscriberTotal(analytics) {
  const required = ["yt:designertom", "yt:joindiveclub"];
  if (!analytics?.channels || required.some((key) => !Number.isFinite(analytics.channels[key]?.totals?.subscribersGained))) return null;
  return required.reduce((sum, key) => sum + analytics.channels[key].totals.subscribersGained, 0);
}

function compactCurve(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const targets = [0.1, 0.25, 0.5, 0.75, 1];
  return targets.map((target) => {
    const best = points.reduce((chosen, point) => (
      !chosen || Math.abs(point.elapsedVideoTimeRatio - target) < Math.abs(chosen.elapsedVideoTimeRatio - target) ? point : chosen
    ), null);
    return best ? { at: best.elapsedVideoTimeRatio, watching: best.audienceWatchRatio } : null;
  }).filter(Boolean);
}

// One measure: value vs typical on a stated basis, with the peers it used.
// `ps` is a peersFor() result (or null for a measure with no typical).
function measurement(id, value, ps, { ageBasis = null, reason = null, episodeRead = null, readDate = null, absoluteScale = false } = {}) {
  const typical = ps?.typical ?? null;
  const score = absoluteScale ? (Number.isFinite(value) ? Math.round(clamp(value)) : null) : relativeScore(value, typical);
  const note = score == null ? null : ageBasis && NOTES[ageBasis] ? NOTES[ageBasis] : null;
  return {
    id,
    value: Number.isFinite(value) ? round1(value) : null,
    typical: Number.isFinite(typical) ? round1(typical) : null,
    sample: ps ? ps.n : 0,
    score,
    reason: score == null ? (reason || ps?.reason || null) : null,
    ageBasis: score == null ? null : ageBasis,
    absoluteScale,
    window: ps ? ps.peers.map((p) => p.slug) : [],
    excluded: ps ? ps.excluded : [],
    episodeRead,
    readDate,
    note,
  };
}

function finishSubScore(key, measures, reason) {
  const present = Object.values(measures).filter((measure) => Number.isFinite(measure.score));
  return {
    score: present.length ? Math.round(mean(present.map((m) => m.score))) : null,
    baseWeight: BASE_WEIGHTS[key],
    effectiveWeight: 0,
    // a check scored only by absolute-scale measures never absorbs the weight
    // of absent checks (PRD v9 rule 13) — an honest absence must not lift it
    absoluteScale: present.length > 0 && present.every((m) => m.absoluteScale),
    measures,
    reason,
  };
}

// Available relative checks share the weight of absent checks; an absolute
// check keeps exactly its base weight. Weights sum to 1 when anything scored.
export function deterministicMean(subScores) {
  const parts = Object.values(subScores);
  const available = parts.filter((part) => Number.isFinite(part.score));
  const availableWeight = available.reduce((sum, part) => sum + part.baseWeight, 0);
  const absoluteWeight = available.filter((part) => part.absoluteScale).reduce((sum, part) => sum + part.baseWeight, 0);
  const relativeWeight = availableWeight - absoluteWeight;
  const effective = (part) => {
    if (!Number.isFinite(part.score)) return 0;
    if (part.absoluteScale) return relativeWeight > 0 ? part.baseWeight : part.baseWeight / availableWeight;
    return relativeWeight > 0 ? part.baseWeight * (1 - (relativeWeight > 0 ? absoluteWeight : 0)) / relativeWeight : 0;
  };
  const weightedMean = availableWeight > 0
    ? round1(parts.reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.score * effective(part) : 0), 0))
    : null;
  return { weightedMean, availableWeight: round1(availableWeight), effectiveWeightOf: effective };
}

function newestSourceTime(episodes, analyticsBySlug, classified) {
  const times = episodes.map((episode) => episode.latest?.ts).filter(Boolean);
  for (const analytics of analyticsBySlug.values()) if (analytics?.updatedAt) times.push(analytics.updatedAt);
  if (classified?.updatedAt) times.push(classified.updatedAt);
  return times.sort().at(-1) || null;
}

export function computeHealthInputs({ data = null, now = null, root = ROOT, previous = null } = {}) {
  const source = data || readJson(join(root, "data.json"));
  if (!source?.episodes?.length) throw new Error("data.json has no episodes");
  const sourceNow = now ?? Date.parse(source.generatedAt);
  if (!Number.isFinite(sourceNow)) throw new Error("health source time is invalid");
  const episodes = [...source.episodes].sort((a, b) => a.premiere.localeCompare(b.premiere));
  const newest = episodes.at(-1);
  const analyticsBySlug = new Map();
  const historyBySlug = new Map();
  for (const episode of episodes) {
    const analytics = readJson(join(root, "data", "restream", "yt-analytics", `${episode.slug}.json`));
    if (analytics) analyticsBySlug.set(episode.slug, analytics);
    const hp = join(root, "data", "restream", "yt-analytics-history", `${episode.slug}.jsonl`);
    historyBySlug.set(episode.slug, existsSync(hp) ? readFileSync(hp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  }
  const classified = readJson(join(root, "data", "restream", "comments-classified.json"));
  const flags = anomalyFlags(episodes);
  const facts = [];
  const addFact = (id, value, suffix, text, sources, requiredPhrase = null) => {
    if (!Number.isFinite(value)) return;
    const display = displayNumber(value, suffix);
    facts.push({ id, value: round1(value), display, text: text(display), sources, ...(requiredPhrase ? { requiredPhrase } : {}) });
  };
  const short = (episode) => (episode.title || episode.slug).replace(/^Dive Radio:?\s*/i, "").split(/[:—–-]/)[0].trim().slice(0, 40);
  const ageOf = (episode) => currentAge(episode) ?? 0;
  const prevBasis = (check, measure) => previous?.subScores?.[check]?.measures?.[measure]?.ageBasis ?? null;
  // "latest episode that can meet a basis": the newest one at or past `days`
  const latestAtLeast = (days, extra = () => true) => [...episodes].reverse().find((e) => ageOf(e) >= days && !flags.get(e.slug)?.flagged && extra(e)) || null;
  const readNote = (episode) => (episode && episode.slug !== newest.slug ? NOTES.readFrom(short(episode)) : null);

  // --- Growth: clean first weeks (ageFree) plus same-age YouTube pace (sameAge) ---
  const cleanWeeks = (source.showTrend?.week1VelocityByEpisode || []).filter((row) => Number.isFinite(row.value));
  addFact("clean-first-weeks", cleanWeeks.length, "", (display) => `Only ${display} episodes have clean first-week records.`, ["data.json#showTrend.week1VelocityByEpisode"]);
  let week1Measure;
  if (cleanWeeks.length >= MIN_PEERS) {
    const recent = cleanWeeks.slice(-SLOPE_N);
    const xs = recent.map((_, index) => index);
    const ys = recent.map((row) => Math.log(row.value));
    const xMean = mean(xs);
    const yMean = mean(ys);
    const slope = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) /
      xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
    const changeEachEpisode = Math.exp(slope);
    week1Measure = measurement("firstWeek", changeEachEpisode, { typical: 1, n: recent.length, peers: recent.map((r) => ({ slug: r.slug })), excluded: [], reason: null }, { ageBasis: "ageFree" });
    addFact("latest-clean-first-week", recent.at(-1).value, "", (display) => `The latest clean first week reached ${display} YouTube views.`, ["data.json#showTrend.week1VelocityByEpisode"]);
  } else {
    week1Measure = measurement("firstWeek", null, null, { reason: `Only ${cleanWeeks.length} clean first weeks exist; at least three are required.` });
  }
  const newestAge = ageOf(newest);
  const paceWindow = windowFor(newest, episodes);
  const paceAge = Math.min(newestAge, READ_DAYS);
  const pacePeers = peersFor({ own: newest, window: paceWindow, flags, valueOf: (p) => { const s = snapshotAt(p, paceAge); return s ? ytViewsOf(s) : null; } });
  const newestSnap = snapshotAt(newest, paceAge);
  const sameAgeMeasure = pacePeers.typical != null && newestSnap
    ? measurement("sameAge", ytViewsOf(newestSnap), pacePeers, { ageBasis: "sameAge", episodeRead: newest.slug })
    : measurement("sameAge", null, pacePeers, { reason: NOTES.youngAge(pacePeers.n) });
  if (sameAgeMeasure.score != null) addFact("latest-same-age-youtube", sameAgeMeasure.value, "", (display) => `The latest episode has ${display} YouTube views at this age.`, [`data.json#episodes.${newest.slug}.latest.ytTotal`]);
  const subScores = {
    growth: finishSubScore("growth", { firstWeek: week1Measure, sameAge: sameAgeMeasure }, [week1Measure.reason, sameAgeMeasure.reason].filter(Boolean).join(" ") || null),
  };

  // --- Audience quality: engagement at the newest episode's age (sameAge); share watched (sameAge via history, else mature) ---
  const engPeers = peersFor({ own: newest, window: paceWindow, flags, valueOf: (p) => { const s = snapshotAt(p, paceAge); return s ? engagementPer1kOf(s) : null; } });
  const engagementMeasure = engPeers.typical != null && newestSnap && Number.isFinite(engagementPer1kOf(newestSnap))
    ? measurement("engagement", engagementPer1kOf(newestSnap), engPeers, { ageBasis: "sameAge", episodeRead: newest.slug })
    : measurement("engagement", null, engPeers, { reason: NOTES.youngAge(engPeers.n) });
  if (engagementMeasure.score != null) {
    addFact("latest-engagement", engagementMeasure.value, "", (display) => `The latest episode drew ${display} engagements for each thousand YouTube views at this age.`, [`data.json#episodes.${newest.slug}.metrics.engagementPer1k`]);
    addFact("typical-engagement", engagementMeasure.typical, "", (display) => `Earlier episodes typically drew ${display} engagements for each thousand YouTube views at the same age.`, ["data.json#episodes.snapshots"]);
  }

  // analytics measures: own = latest episode ≥ 7 d; sameAge when own and
  // MIN_PEERS peers have a history line at own's current age; otherwise mature
  // (own ≥ 21 d, peers ≥ 21 d, current file). Once a measure has been sameAge
  // in a saved entry it never falls back (PRD v9 §3.1 transition rule).
  const blend = (channels, pick) => {
    let num = 0, den = 0;
    for (const ch of Object.values(channels || {})) {
      const t = ch?.totals ?? ch;
      if (!t || !Number.isFinite(t.views) || t.views <= 0) continue;
      const v = pick(t);
      if (!Number.isFinite(v)) continue;
      num += v * t.views; den += t.views;
    }
    return den > 0 ? num / den : null;
  };
  const subsPer1k = (channels) => {
    let subs = 0, views = 0;
    for (const key of ["yt:designertom", "yt:joindiveclub"]) {
      const t = channels?.[key]?.totals ?? channels?.[key];
      if (!t || !Number.isFinite(t.subscribersGained) || !Number.isFinite(t.views)) return null;
      subs += t.subscribersGained; views += t.views;
    }
    return views > 0 ? (subs / views) * 1000 : null;
  };
  const analyticsMeasure = (id, check, pick) => {
    const own = latestAtLeast(MATURITY_DAYS.xAnnounce, (e) => analyticsBySlug.has(e.slug));
    if (!own) return measurement(id, null, null, { reason: "No episode at least a week old has a YouTube analytics report yet." });
    const A = ageOf(own);
    const window = windowFor(own, episodes);
    const lineValue = (e) => { const line = historyAt(historyBySlug.get(e.slug), A); return line ? pick(line.channels) : null; };
    const sameAge = peersFor({ own, window, flags, valueOf: lineValue });
    const ownLine = lineValue(own);
    if (sameAge.typical != null && Number.isFinite(ownLine)) {
      return measurement(id, ownLine, sameAge, { ageBasis: "sameAge", episodeRead: own.slug, readDate: historyAt(historyBySlug.get(own.slug), A)?.date ?? null });
    }
    if (prevBasis(check, id) === "sameAge") return measurement(id, null, sameAge, { reason: NOTES.noReadingAtAge });
    const matureOwn = latestAtLeast(MATURITY_DAYS.analytics, (e) => analyticsBySlug.has(e.slug));
    if (!matureOwn) return measurement(id, null, null, { reason: "No episode is three weeks old yet with a YouTube analytics report." });
    const matureWindow = windowFor(matureOwn, episodes).filter((p) => ageOf(p) >= MATURITY_DAYS.analytics);
    const mature = peersFor({ own: matureOwn, window: matureWindow, flags, valueOf: (p) => pick(analyticsBySlug.get(p.slug)?.channels) });
    const ownValue = pick(analyticsBySlug.get(matureOwn.slug)?.channels);
    if (mature.typical == null || !Number.isFinite(ownValue)) return measurement(id, null, mature, { reason: mature.reason || "No reading for the latest three-week-old episode." });
    return measurement(id, ownValue, mature, { ageBasis: "mature", episodeRead: matureOwn.slug, readDate: (analyticsBySlug.get(matureOwn.slug)?.updatedAt || "").slice(0, 10) || null });
  };
  const retentionMeasure = analyticsMeasure("watching", "audienceQuality", (ch) => blend(ch, (t) => t.averageViewPercentage));
  if (retentionMeasure.score != null) {
    const read = episodes.find((e) => e.slug === retentionMeasure.episodeRead);
    addFact("latest-watch-percent", retentionMeasure.value, "%", (display) => `Viewers watched ${display} of ${read.slug === newest.slug ? "the latest" : "the latest finished"} YouTube episode on average.`, [`data/restream/yt-analytics/${read.slug}.json`]);
    addFact("typical-watch-percent", retentionMeasure.typical, "%", (display) => `Earlier episodes typically held viewers for ${display} of their YouTube run time.`, ["data/restream/yt-analytics/*.json"]);
    for (const [channelKey, channelName] of [["yt:joindiveclub", "Dive Club"], ["yt:designertom", "DesignerTom"]]) {
      const totals = analyticsBySlug.get(read.slug)?.channels?.[channelKey]?.totals;
      if (totals && Number.isFinite(totals.averageViewPercentage) && totals.views > 0) {
        addFact(`latest-watch-percent-${channelKey.slice(3)}`, totals.averageViewPercentage, "%", (display) => `Viewers watched ${display} of that episode on ${channelName} on average.`, [`data/restream/yt-analytics/${read.slug}.json`]);
      }
    }
  }
  const audienceReasons = [engagementMeasure.reason, retentionMeasure.reason, readNote(episodes.find((e) => e.slug === retentionMeasure.episodeRead))].filter(Boolean).join(" ");
  subScores.audienceQuality = finishSubScore("audienceQuality", { engagement: engagementMeasure, watching: retentionMeasure }, audienceReasons || null);

  // --- Reach efficiency: latest finished clean episode with complete, fresh X plays vs peers (mature, 7 d) ---
  const reachOk = (e) => ageOf(e) >= MATURITY_DAYS.xAnnounce && !flags.get(e.slug)?.flagged && Number.isFinite(e.latest?.xPlays)
    && e.latest.xPlaysInfo?.partial === false && e.latest.xPlaysInfo?.stale === false && e.latest.xImpressions > 0 && e.latest.totalViews > 0;
  const reachOwn = [...episodes].reverse().find(reachOk) || null;
  let announceMeasure, xShareMeasure, reachReason = null;
  if (reachOwn) {
    const window = windowFor(reachOwn, episodes).filter(reachOk);
    const ann = peersFor({ own: reachOwn, window, flags, valueOf: (p) => p.latest.xPlays / p.latest.xImpressions * 100 });
    const shr = peersFor({ own: reachOwn, window, flags, valueOf: (p) => p.latest.xPlays / p.latest.totalViews * 100 });
    announceMeasure = measurement("announceToPlay", reachOwn.latest.xPlays / reachOwn.latest.xImpressions * 100, ann, { ageBasis: "mature", episodeRead: reachOwn.slug, readDate: reachOwn.latest.ts.slice(0, 10) });
    xShareMeasure = measurement("xShare", reachOwn.latest.xPlays / reachOwn.latest.totalViews * 100, shr, { ageBasis: "mature", episodeRead: reachOwn.slug, readDate: reachOwn.latest.ts.slice(0, 10) });
    if (announceMeasure.score != null) {
      addFact("latest-finished-announce-play", announceMeasure.value, "%", (display) => `${display} of the latest finished episode's X announce impressions became plays.`, [`data.json#episodes.${reachOwn.slug}.latest`]);
      addFact("typical-announce-play", announceMeasure.typical, "%", (display) => `Earlier clean episodes typically turned ${display} of X announce impressions into plays.`, ["data.json#episodes.latest"]);
    }
    if (xShareMeasure.score != null) addFact("latest-finished-x-share", xShareMeasure.value, "%", (display) => `X supplied ${display} of watching for the latest finished episode.`, [`data.json#episodes.${reachOwn.slug}.latest`]);
    reachReason = readNote(reachOwn);
  } else {
    const reason = "No episode at least a week old has complete X play counts yet.";
    announceMeasure = measurement("announceToPlay", null, null, { reason });
    xShareMeasure = measurement("xShare", null, null, { reason });
  }
  subScores.reachEfficiency = finishSubScore("reachEfficiency", { announceToPlay: announceMeasure, xShare: xShareMeasure }, [announceMeasure.reason, xShareMeasure.reason, reachReason].filter(Boolean).join(" ") || null);

  // --- Live pull: newest session vs peers (ageFree) ---
  const liveOk = (e) => Number.isFinite(e.live?.peak) && Number.isFinite(e.live?.chatMessages);
  let livePeakMeasure, liveChatMeasure;
  if (liveOk(newest)) {
    const window = windowFor(newest, episodes);
    const pk = peersFor({ own: newest, window, flags, valueOf: (p) => (liveOk(p) ? p.live.peak : null) });
    const ch = peersFor({ own: newest, window, flags, valueOf: (p) => (liveOk(p) ? p.live.chatMessages : null) });
    livePeakMeasure = measurement("peak", newest.live.peak, pk, { ageBasis: "ageFree", episodeRead: newest.slug });
    liveChatMeasure = measurement("chat", newest.live.chatMessages, ch, { ageBasis: "ageFree", episodeRead: newest.slug });
    if (livePeakMeasure.score != null) {
      addFact("latest-live-peak", newest.live.peak, "", (display) => `The latest show peaked at ${display} live viewers.`, [`data.json#episodes.${newest.slug}.live.peak`]);
      addFact("typical-live-peak", livePeakMeasure.typical, "", (display) => `Earlier shows typically peaked at ${display} live viewers.`, ["data.json#episodes.live.peak"]);
    }
    if (liveChatMeasure.score != null) {
      addFact("latest-live-chat", newest.live.chatMessages, "", (display) => `The latest show drew ${display} chat messages.`, [`data.json#episodes.${newest.slug}.live.chatMessages`]);
      addFact("typical-live-chat", liveChatMeasure.typical, "", (display) => `Earlier shows typically drew ${display} chat messages.`, ["data.json#episodes.live.chatMessages"]);
    }
  } else {
    const reason = "The latest episode has no live session record.";
    livePeakMeasure = measurement("peak", null, null, { reason });
    liveChatMeasure = measurement("chat", null, null, { reason });
  }
  subScores.livePull = finishSubScore("livePull", { peak: livePeakMeasure, chat: liveChatMeasure }, [livePeakMeasure.reason, liveChatMeasure.reason].filter(Boolean).join(" ") || null);

  // --- Subscriber conversion: same rule as share watched ---
  const conversionMeasure = analyticsMeasure("subscribers", "conversion", (ch) => subsPer1k(ch));
  let conversionReason = conversionMeasure.reason;
  if (conversionMeasure.score != null) {
    const read = episodes.find((e) => e.slug === conversionMeasure.episodeRead);
    addFact("latest-subscriber-rate", conversionMeasure.value, "", (display) => `${read.slug === newest.slug ? "The latest episode" : "The latest finished episode"} added ${display} subscribers for each thousand YouTube views.`, [`data/restream/yt-analytics/${read.slug}.json`]);
    addFact("typical-subscriber-rate", conversionMeasure.typical, "", (display) => `Earlier clean episodes typically added ${display} subscribers for each thousand YouTube views.`, ["data/restream/yt-analytics/*.json"]);
    for (const [channelKey, channelName] of [["yt:joindiveclub", "Dive Club"], ["yt:designertom", "DesignerTom"]]) {
      const totals = analyticsBySlug.get(read.slug)?.channels?.[channelKey]?.totals;
      if (totals && Number.isFinite(totals.subscribersGained) && totals.views > 0) {
        addFact(`latest-subscriber-rate-${channelKey.slice(3)}`, totals.subscribersGained / totals.views * 1000, "", (display) => `${channelName} added ${display} subscribers for each thousand of its YouTube views on that episode.`, [`data/restream/yt-analytics/${read.slug}.json`]);
      }
    }
    conversionReason = readNote(read);
  }
  subScores.conversion = finishSubScore("conversion", { subscribers: conversionMeasure }, conversionReason || null);

  // --- Sentiment: balance over the three newest episodes on their common sources (absolute scale); commenters per 1k vs peers (mature) ---
  const coverageOf = (e) => (e.comments?.xCoverage === "covered" ? "yt+x" : "yt");
  const recentEpisodes = episodes.slice(-3);
  const commonSources = recentEpisodes.every((e) => coverageOf(e) === "yt+x") ? new Set(["yt", "x"]) : new Set(["yt"]);
  const recentFeedback = recentEpisodes.flatMap((episode) => (episode.comments?.list || []).filter((row) => commonSources.has(row.source)));
  const recentPositive = recentFeedback.filter((row) => row.sentiment === "positive").length;
  const recentNegative = recentFeedback.filter((row) => row.sentiment === "negative").length;
  const recentMixed = recentFeedback.filter((row) => row.sentiment === "mixed").length;
  const recentDirectional = recentPositive + recentNegative + recentMixed;
  const recentPeople = new Set(recentFeedback.map((row) => `${row.source}:${String(row.author || "viewer").trim().toLowerCase()}`)).size;
  const balanceValue = recentDirectional > 0 ? (recentPositive + recentMixed * 0.5) / recentDirectional * 100 : null;
  // a typical for the balance once three earlier episodes (before the newest three) carry one on the same sources
  const balanceOf = (e) => {
    const rows = (e.comments?.list || []).filter((row) => commonSources.has(row.source));
    const d = rows.filter((row) => ["positive", "negative", "mixed"].includes(row.sentiment));
    const people = new Set(d.map((row) => `${row.source}:${String(row.author || "viewer").trim().toLowerCase()}`)).size;
    if (d.length < 3 || people < 3) return null;
    return (d.filter((r) => r.sentiment === "positive").length + d.filter((r) => r.sentiment === "mixed").length * 0.5) / d.length * 100;
  };
  const balanceWindow = windowFor(recentEpisodes[0], episodes);
  const balancePeers = peersFor({ own: recentEpisodes[0], window: balanceWindow, flags, valueOf: balanceOf });
  const balanceMeasure = recentDirectional >= 3 && recentPeople >= 3 && Number.isFinite(balanceValue)
    ? (balancePeers.typical != null
      ? measurement("balance", balanceValue, balancePeers, { ageBasis: "mature", episodeRead: newest.slug })
      : measurement("balance", balanceValue, null, { ageBasis: "ageFree", episodeRead: newest.slug, absoluteScale: true }))
    : measurement("balance", null, null, { reason: "Fewer than three people have recent directional feedback." });
  if (balanceMeasure.score != null) {
    const phrase = commonSources.has("x") ? null : "X replies are missing";
    addFact("recent-positive-feedback", recentPositive, "", (display) => `${display} recent comments were clearly positive.`, ["data.json#episodes[-3:].comments.list"], phrase);
    addFact("recent-mixed-feedback", recentMixed, "", (display) => `${display} recent comments mixed praise with a concern.`, ["data.json#episodes[-3:].comments.list"], phrase);
    addFact("recent-feedback-people", recentPeople, "", (display) => `${display} people left recent directional feedback.`, ["data.json#episodes[-3:].comments.list"], phrase);
  }
  const rateOk = (e) => Number.isFinite(e.comments?.commentersPer1k) && ageOf(e) >= MATURITY_DAYS.analytics;
  const rateOwn = [...episodes].reverse().find((e) => Number.isFinite(e.comments?.commentersPer1k)) || null;
  let commentRateMeasure;
  if (rateOwn) {
    const window = windowFor(rateOwn, episodes).filter(rateOk);
    const ps = peersFor({ own: rateOwn, window, flags, valueOf: (p) => p.comments.commentersPer1k, coverageOf, ownCoverage: coverageOf(rateOwn) });
    commentRateMeasure = measurement("commentRate", rateOwn.comments.commentersPer1k, ps, { ageBasis: "mature", episodeRead: rateOwn.slug, reason: ps.typical == null ? `Only ${ps.n + 1} episode${ps.n ? "s have" : " has"} complete replies and watch counts; at least four are required.` : null });
    addFact("latest-comment-rate", rateOwn.comments.commentersPer1k, "", (display) => `The latest comparable episode drew ${display} commenters for each thousand watches.`, [`data.json#episodes.${rateOwn.slug}.comments.commentersPer1k`], ps.typical == null ? "only one episode" : null);
  } else {
    commentRateMeasure = measurement("commentRate", null, null, { reason: "No episode has complete replies and watch counts yet." });
  }
  subScores.sentiment = finishSubScore("sentiment", { balance: balanceMeasure, commentRate: commentRateMeasure }, [balanceMeasure.reason, commentRateMeasure.reason].filter(Boolean).join(" ") || null);

  // Missing checks relinquish their weight to the available RELATIVE checks; an
  // absolute-scale check keeps its base weight. No missing check becomes zero.
  const { weightedMean, availableWeight: availableBaseWeight, effectiveWeightOf } = deterministicMean(subScores);
  for (const part of Object.values(subScores)) part.effectiveWeight = Math.round(effectiveWeightOf(part) * 10000) / 10000;
  const checkSet = Object.entries(subScores).filter(([, part]) => Number.isFinite(part.score)).map(([key]) => key);
  const previousCheckSet = previous?.checkSet ?? (previous ? Object.entries(previous.subScores || {}).filter(([, part]) => Number.isFinite(part?.score)).map(([key]) => key) : null);
  const checkSetChanged = previousCheckSet ? JSON.stringify(previousCheckSet) !== JSON.stringify(checkSet) : false;
  const checkSetDiff = previousCheckSet ? {
    joined: checkSet.filter((k) => !previousCheckSet.includes(k)),
    left: previousCheckSet.filter((k) => !checkSet.includes(k)),
  } : { joined: [], left: [] };

  const latestSnapshot = episodes.map((episode) => episode.latest?.ts).filter(Boolean).sort().at(-1);
  if (latestSnapshot) {
    const ageHours = Math.max(0, Math.round((sourceNow - Date.parse(latestSnapshot)) / 3600000));
    addFact("data-age-hours", ageHours, "", (display) => `The newest audience numbers were refreshed ${display} hours ago.`, ["data.json#episodes.latest.ts"]);
  }

  const context = {
    trajectories: source.showTrend?.week1VelocityByEpisode || [],
    episodeHealth: episodes.map((episode) => ({
      episode: episode.ep,
      score: episode.health?.pending ? null : episode.health?.score ?? null,
      readCompleteOn: episode.health?.readCompleteOn ?? null,
      stillReading: episode.health?.pending ?? false,
      missingChecks: episode.health?.missingChecks || [],
      noScoreReason: episode.health?.reason ?? null,
    })),
    retention: episodes.map((episode) => {
      const analytics = analyticsBySlug.get(episode.slug);
      return {
        episode: episode.ep,
        averageWatched: Number.isFinite(episode.watch?.avgPercent) ? round1(episode.watch.avgPercent) : null,
        ageDays: round1(ageOf(episode)),
        channels: Object.fromEntries(Object.entries(analytics?.channels || {}).map(([key, channel]) => [key, {
          curve: compactCurve(channel.retention),
          topTraffic: [...(channel.trafficSources || [])].sort((a, b) => b.views - a.views).slice(0, 3),
        }])),
      };
    }),
    comments: {
      show: source.commentSummary || {},
      episodes: episodes.map((episode) => ({
        episode: episode.ep,
        people: episode.comments?.uniqueCommenters ?? null,
        enjoyed: episode.comments?.enjoyCount ?? null,
        concerned: episode.comments?.complaintCount ?? null,
        peoplePerThousand: episode.comments?.commentersPer1k ?? null,
        enjoyThemes: episode.comments?.enjoyThemes || [],
        concernThemes: episode.comments?.complaintThemes || [],
      })),
    },
    checkSet,
    checkSetChange: checkSetChanged ? { previous: previousCheckSet, ...checkSetDiff, previousScore: previous?.score ?? null } : null,
    outliers: [...flags.entries()].filter(([, f]) => f.flagged).map(([slug, f]) => ({ slug, provisional: f.provisional })),
    dataAge: {
      dashboardGeneratedAt: new Date(sourceNow).toISOString(),
      latestSnapshot,
      analyticsUpdatedAt: [...analyticsBySlug.values()].map((analytics) => analytics.updatedAt).filter(Boolean).sort().at(-1) || null,
      commentsClassifiedAt: classified?.updatedAt || null,
      unavailableChecks: Object.entries(subScores).filter(([, part]) => part.score == null).map(([key, part]) => ({ key, reason: part.reason })),
    },
  };

  const bundle = {
    formulaVersion: FORMULA_VERSION,
    weightedMean,
    allowedScore: Number.isFinite(weightedMean) ? { min: Math.max(0, Math.ceil(weightedMean - 8)), max: Math.min(100, Math.floor(weightedMean + 8)) } : null,
    subScores,
    facts,
    context,
  };
  return {
    ...bundle,
    bundleHash: sha(JSON.stringify(bundle)),
    dataGeneratedAt: new Date(sourceNow).toISOString(),
    dataThrough: newestSourceTime(episodes, analyticsBySlug, classified),
    availableChecks: checkSet.length,
    availableBaseWeight,
    checkSet,
    checkSetChange: context.checkSetChange,
  };
}

function providerConfig() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: process.env.HEALTH_MODEL || DEFAULT_ANTHROPIC_MODEL };
  }
  if (process.env.OPENAI_API_KEY) {
    if (!process.env.HEALTH_MODEL) throw new Error("HEALTH_MODEL must name a live-tested OpenAI model when only OPENAI_API_KEY is set");
    return { provider: "openai", key: process.env.OPENAI_API_KEY, model: process.env.HEALTH_MODEL };
  }
  throw new Error("ANTHROPIC_API_KEY or OPENAI_API_KEY is required");
}

async function callOnce(system, payload) {
  const cfg = providerConfig();
  if (cfg.provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    const text = (body.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (!text.trim()) throw new Error("empty Anthropic response");
    return { text, ...cfg };
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_output_tokens: MAX_TOKENS, instructions: system, input: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`openai HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  const text = body.output_text || (body.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("\n");
  if (!text.trim()) throw new Error("empty OpenAI response");
  return { text, ...cfg };
}

function numberTokens(text) {
  return text.match(/[-+]?\d[\d,]*(?:\.\d+)?%?/g) || [];
}

export function validateSynthesis(value, inputs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["cons", "drivers", "headline", "pros", "score"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("response must contain exactly score, headline, pros, cons, and drivers");
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100) throw new Error("score must be a whole number from 0 through 100");
  if (!inputs.allowedScore || value.score < inputs.allowedScore.min || value.score > inputs.allowedScore.max) {
    throw new Error(`score ${value.score} is outside allowed ${inputs.allowedScore?.min}..${inputs.allowedScore?.max}`);
  }
  if (typeof value.headline !== "string" || !value.headline.trim() || value.headline.length > 100 || numberTokens(value.headline).length) throw new Error("headline must be non-empty, under 101 characters, and contain no number");
  if (BANNED.test(value.headline) || MARKUP.test(value.headline)) throw new Error("headline contains banned dashboard jargon or markup");
  const facts = new Map(inputs.facts.map((fact) => [fact.id, fact]));
  for (const side of ["pros", "cons"]) {
    if (!Array.isArray(value[side]) || value[side].length !== 2) throw new Error(`${side} must contain exactly two bullets`);
    for (const bullet of value[side]) {
      if (!bullet || typeof bullet !== "object" || Array.isArray(bullet) || JSON.stringify(Object.keys(bullet).sort()) !== JSON.stringify(["factId", "text"])) throw new Error(`${side} bullets must contain exactly text and factId`);
      const fact = facts.get(bullet.factId);
      if (!fact) throw new Error(`${side} cites unknown fact ${JSON.stringify(bullet.factId)}`);
      if (typeof bullet.text !== "string" || !bullet.text.trim() || bullet.text.length > 140) throw new Error(`${side} bullet is empty or too long`);
      if (BANNED.test(bullet.text) || MARKUP.test(bullet.text)) throw new Error(`${side} bullet contains banned dashboard jargon or markup`);
      const tokens = numberTokens(bullet.text);
      if (tokens.length !== 1 || tokens[0] !== fact.display) throw new Error(`${side} bullet must copy only ${fact.display} from ${fact.id}`);
      if (fact.requiredPhrase && !bullet.text.toLowerCase().includes(fact.requiredPhrase.toLowerCase())) throw new Error(`${side} bullet must include ${JSON.stringify(fact.requiredPhrase)} for ${fact.id}`);
    }
  }
  if (!Array.isArray(value.drivers) || value.drivers.length < 1 || value.drivers.length > 3 || value.drivers.some((driver) => typeof driver !== "string" || !driver.trim() || driver.length > 180 || BANNED.test(driver) || MARKUP.test(driver))) {
    throw new Error("drivers must contain one to three short plain strings");
  }
  // entries are judged under the prompt version they were written with; the
  // synthesis path judges under the current one
  const promptVersion = Number.isFinite(inputs.promptVersion) ? inputs.promptVersion : PROMPT_VERSION;
  // drivers render on the page from prompt v4 on, so they carry no digits —
  // every shipped number must trace to a cited fact, and drivers cite none
  if (promptVersion >= 4 && value.drivers.some((driver) => numberTokens(driver).length)) {
    throw new Error("drivers must contain no numbers — the judgment in words, the numbers in cited bullets");
  }
  // check-set guard (PRD v9 §3.1, W27): when the set of scored checks changed
  // since the previous entry, a driver must name a check that joined or left —
  // a number resting on different checks than the last read is a different
  // read even when it lands in the same place. Under prompt v3 the naming was
  // only required when the score also moved by more than 5; the 2026-08-24
  // transition showed that exemption hides exactly the worst case.
  const change = inputs.checkSetChange;
  if (change) {
    // an unlabeled future check key falls back to its raw key rather than
    // silently escaping the naming rule
    const names = [...change.joined, ...change.left].map((key) => CHECK_LABELS[key] ?? key);
    const scoreMoved = Number.isFinite(change.previousScore) && Math.abs(value.score - change.previousScore) > 5;
    if (names.length && (promptVersion >= 4 || scoreMoved)) {
      const text = value.drivers.join(" ").toLowerCase();
      // whole-word match: "reached" must not satisfy "reach", "regrowth" must
      // not satisfy "growth" — the prompt lists the exact names to use
      const named = (name) => new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
      // v4: every changed check is named; v3 only required one of them
      const missing = promptVersion >= 4 ? names.filter((name) => !named(name)) : (names.some(named) ? [] : names);
      if (missing.length) {
        throw new Error(`drivers must name the checks that joined or left (missing: ${missing.join(", ")}) because the check set changed`);
      }
    }
  }
  return value;
}

// Public projection used by build-data.mjs. It contains only saved model copy,
// its citation IDs, the saved per-check results, and real history points. No
// score or trend is recomputed in the browser, and gaps in history remain gaps.
export const CHECK_ORDER = Object.freeze(["growth", "audienceQuality", "reachEfficiency", "livePull", "conversion", "sentiment"]);
export function projectHealth(store, { now = Date.now() } = {}) {
  if (!store) return null;
  if (![1, HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
  const cutoff = phoenixDate(now);
  const entries = store.entries.filter((entry) => entry.date <= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) return null;
  const latest = entries.at(-1);
  if (!Number.isFinite(latest.score) || typeof latest.headline !== "string" || !Array.isArray(latest.pros) || !Array.isArray(latest.cons)) {
    throw new Error("latest health entry is incomplete");
  }
  // age of the served read in Phoenix days; after STALE_WITHHOLD_DAYS the
  // score is withheld — the page shows its empty state rather than a week-old
  // number as today's (PRD v9 rule 15 / D3). Data still publishes.
  const ageDays = Math.round((Date.parse(`${cutoff}T12:00:00Z`) - Date.parse(`${latest.date}T12:00:00Z`)) / 86400000);
  const withheld = ageDays > STALE_WITHHOLD_DAYS;
  // The page needs to say when today's score is still an early read, but it
  // must not guess that state from model-written prose. The health entry
  // already records unavailable checks and facts that explicitly require an
  // early-data warning, so project that state as a deterministic field.
  const hasUnavailableCheck = Object.values(latest.subScores || {}).some((section) =>
    section?.score == null || Object.values(section?.measures || {}).some((measure) => measure?.score == null));
  const hasEarlyFact = (latest.facts || []).some((fact) => fact?.requiredPhrase === "still early");
  const running = entries.filter((entry) => entry.formulaVersion === FORMULA_VERSION);
  return {
    date: latest.date,
    ageDays,
    withheld,
    formulaVersion: latest.formulaVersion ?? null,
    dataThrough: latest.dataThrough || null,
    score: withheld ? null : latest.score,
    readState: hasUnavailableCheck || hasEarlyFact ? "early" : "settled",
    headline: withheld ? null : latest.headline,
    // The saved per-check results, projected verbatim so the page can show the
    // whole diagnosis without ever recomputing: a score where one exists, the
    // saved reason where one does not, and each measure's stored note.
    checks: withheld ? [] : CHECK_ORDER.map((key) => ({
      key,
      score: Number.isFinite(latest.subScores?.[key]?.score) ? latest.subScores[key].score : null,
      reason: latest.subScores?.[key]?.reason ?? null,
      measures: Object.entries(latest.subScores?.[key]?.measures || {}).map(([measureKey, measure]) => ({
        key: measureKey,
        value: measure?.value ?? null,
        typical: measure?.typical ?? null,
        sample: measure?.sample ?? null,
        reason: measure?.reason ?? null,
        ageBasis: measure?.ageBasis ?? null,
        note: measure?.note ?? null,
        episodeRead: measure?.episodeRead ?? null,
      })),
    })),
    pros: withheld ? [] : latest.pros.map((bullet) => ({ text: bullet.text, factId: bullet.factId })),
    cons: withheld ? [] : latest.cons.map((bullet) => ({ text: bullet.text, factId: bullet.factId })),
    // the saved judgment sentences, verbatim — from prompt v4 they are
    // digit-free, so the click layer can show the model's reasoning without
    // shipping a number no fact grounds
    drivers: withheld ? [] : (latest.drivers || []),
    // the saved change in which checks scored (W27): when a check joined or
    // left since the previous saved read, the reader is told — a score
    // resting on different checks must never pass as continuity. null when
    // the set held.
    checkSetChange: withheld ? null : (latest.checkSetChange ?? null),
    // the trend plots only entries written under the running formula (F5)
    trend: running.length >= 7 ? { points: running.map((entry) => ({ date: entry.date, score: entry.score })) } : null,
  };
}

async function synthesize(inputs) {
  const system = readFileSync(PROMPT_PATH, "utf8");
  const payload = {
    task: "Write today's Dive Radio show-health summary.",
    weightedMean: inputs.weightedMean,
    allowedScore: inputs.allowedScore,
    subScores: inputs.subScores,
    facts: inputs.facts,
    context: inputs.context,
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callOnce(system, payload);
      let parsed;
      try { parsed = JSON.parse(result.text); }
      catch (error) { throw new Error(`response was not raw JSON: ${error.message}`); }
      validateSynthesis(parsed, inputs);
      return { synthesis: parsed, provider: result.provider, model: result.model };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`model synthesis failed twice: ${lastError.message}`);
}

function loadStore() {
  const store = readJson(STORE_PATH, { version: HEALTH_STORE_VERSION, updatedAt: null, entries: [] });
  if (![1, HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
  store.version = HEALTH_STORE_VERSION; // v1 files upgrade in place; entries stay byte-identical
  const dates = store.entries.map((entry) => entry.date);
  if (new Set(dates).size !== dates.length) throw new Error("health-history.json contains more than one entry for a day");
  return store;
}

async function main() {
  const data = readJson(DATA_PATH);
  if (!data) throw new Error("data.json is missing");
  const sourceNow = Date.parse(data.generatedAt);
  const store = loadStore();
  const previous = store.entries.at(-1) ?? null;
  const inputs = computeHealthInputs({ data, now: sourceNow, previous });
  if (process.argv.includes("--dry")) {
    console.log(JSON.stringify({ weightedMean: inputs.weightedMean, allowedScore: inputs.allowedScore, availableChecks: inputs.availableChecks, checkSet: inputs.checkSet, checkSetChange: inputs.checkSetChange, subScores: inputs.subScores, facts: inputs.facts }, null, 2));
    return;
  }
  // gate (PRD v9 F33): three or more available checks. Absent checks already
  // relinquish weight and render as "Not in yet"; a three-check read with three
  // honest absences beats a stale six-check read.
  if (!Number.isFinite(inputs.weightedMean) || inputs.availableChecks < 3) {
    console.log(`WARN health: only ${inputs.availableChecks} usable checks; previous saved score kept`);
    return;
  }
  if (process.argv.includes("--probe-model")) {
    const result = await synthesize(inputs);
    console.log(`health probe: ${result.provider}/${result.model} returned valid grounded JSON with score ${result.synthesis.score}`);
    return;
  }

  const date = phoenixDate(sourceNow);
  if (store.entries.some((entry) => entry.date === date)) {
    console.log(`health: ${date} already saved — append-only store unchanged`);
    return;
  }
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  const promptHash = sha(prompt);
  if (previous?.promptVersion === PROMPT_VERSION && previous.promptHash && previous.promptHash !== promptHash) {
    throw new Error("health prompt changed without a prompt version bump");
  }

  let result;
  try {
    result = await synthesize(inputs);
  } catch (error) {
    console.log(`WARN health: ${error.message}; previous saved score kept`);
    return;
  }
  const entry = {
    date,
    score: result.synthesis.score,
    weightedMean: inputs.weightedMean,
    deviation: round1(result.synthesis.score - inputs.weightedMean),
    subScores: inputs.subScores,
    headline: result.synthesis.headline,
    pros: result.synthesis.pros,
    cons: result.synthesis.cons,
    drivers: result.synthesis.drivers,
    facts: inputs.facts,
    checkSet: inputs.checkSet,
    checkSetChange: inputs.checkSetChange,
    provider: result.provider,
    model: result.model,
    promptVersion: PROMPT_VERSION,
    promptHash,
    formulaVersion: FORMULA_VERSION,
    bundleHash: inputs.bundleHash,
    dataGeneratedAt: inputs.dataGeneratedAt,
    dataThrough: inputs.dataThrough,
    createdAt: new Date().toISOString(),
  };
  store.entries.push(entry);
  store.updatedAt = entry.createdAt;
  saveAtomic(STORE_PATH, store);
  console.log(`health: saved ${date} score ${entry.score} (deterministic mean ${entry.weightedMean}, move ${entry.deviation >= 0 ? "+" : ""}${entry.deviation})`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  process.stderr.write(`health: ${error.message}\n`);
  process.exit(1);
});
