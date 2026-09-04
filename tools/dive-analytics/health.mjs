#!/usr/bin/env node
// health.mjs — W10 deterministic show checks + model-written health summary.
//
// This is the only script allowed to call a model for show health. It uses
// fetch directly and has no runtime dependencies. build-data.mjs only reads
// the persisted health-history.json store; it never calls a model.
//
// Deterministic formulas (health-v4, PRD v10 §3; all results clamped 0..100):
//   relative(value, typical) = 50 * value / typical, typical = true median of
//   the peers left after taking the eight episodes before the one being read
//   and removing promo outliers and peers with no honest reading (baselines.mjs).
//   Every measure carries ONE basis and a fixed plain-words note:
//     sameAge  own and every peer read at the same age (snapshot / history line)
//     mature   own and every peer at or past the measure's maturity age, as they
//              stand now (only until same-age history exists — never after a
//              measure has once been same-age)
//     ageFree  the measure does not move with age (live night, day-7 totals)
//   Three lenses (PRD v10): the checks below are the NOW lens — the newest
//   episode at its age, like for like. The DIRECTION lens reads each durable
//   measure over the last TREND_N clean episodes (Theil–Sen percent per
//   episode, quiet zone, words). The OUTLOOK reads the next first week's
//   expected range from the last three clean first weeks and the newest
//   episode's cool-off. Direction and outlook are stored beside the checks
//   and never change the score; they change what the words say.
//   growth 25%           first-week direction over the last TREND_N clean
//                        weeks (ageFree, Theil–Sen) + the newest episode's
//                        same-age YouTube launch (sameAge)
//   audience quality 17% likes and comments COUNTED at the newest episode's
//                        age vs peers at that age (sameAge — a count, so a
//                        promo-inflated denominator cannot dilute it); share
//                        watched of the latest episode ≥ 7 d (sameAge/mature)
//   reach 12%            X exposure (impressions) at the newest episode's age
//                        vs peers (sameAge); announce-to-play same-age when
//                        three peers carry plays at that age, else the latest
//                        finished clean episode CARRIED at half weight (mature)
//   live turnout 16%     newest peak and average concurrent vs peers (ageFree)
//   participation 12%    chatters per 100 peak viewers and chat messages per
//                        hour vs peers (ageFree — normalized for show length)
//   subscribers 8%       subscribers per 1k of the latest episode ≥ 7 d, same
//                        rule as share watched (carried when not the newest)
//   goodwill 10%         positive + half of mixed across the three newest
//                        episodes on the sources all three have coverage for
//                        (absolute scale: it never receives redistributed
//                        weight); commenters per 1k vs peers with complete
//                        replies (mature, 21 d)
//   Each measure needs MIN_PEERS (3) usable peers or it is absent with a reason.
//   QUALIFIED (rule 18): a measure whose own unit is promo-flagged — the newest
//   episode's YouTube views, X reach, or a rate on either — keeps its value
//   and typical but scores null with the reason "promo-driven lift — shown,
//   not scored"; the lift reaches the page as a word, never as health.
//   CARRIED (rule 19): a measure read from an older episode than the newest
//   is stamped carried and counts CARRIED_WEIGHT (half) inside its check; a
//   check whose every scored measure is carried counts half in the mean.
//
// A missing measure is null with a reason, never zero. Available measures share
// their check's weight; available RELATIVE checks share missing checks' weights
// (an absolute-scale check keeps its base weight). The model may move the final
// score at most 8 points from that weighted mean. An entry is written whenever
// three or more checks are available; it records which (checkSet), and when
// that set changed since the last saved read the drivers must name the check
// that joined or left (prompt v4 — unconditional; under v3 only when the
// score also moved by more than 5). One immutable entry per Phoenix calendar day.
// A failed model read never advances the saved day. After one retry the CLI
// fails and preserves the prior entry so the scheduler can record the failure.
// The deterministic synthesis remains an explicit diagnostic (--probe-fallback)
// and historical deterministic entries keep their original provider label.
// After seven days without any fresh entry the projection withholds the score.
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
  existsSync, readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CARRIED_WEIGHT, MATURITY_DAYS, MIN_PEERS, NOTES, READ_DAYS, UNIT_FAMILIES, anomalyFlags, currentAge, flaggedOn, ytHistoryAt, liveRatesOf, peersFor, snapshotAt, ytSnapshotAt, ytCurrentAge, subsPer1kOf, windowFor, xImpressionsOf, xPlaysOf, ytEngagementOf, ytViewsOf, swingOf, bandsFor, stateOf, liveDepthOf, discoveryShareOf, STATE_WORDS, comparableAcrossBreaks, NOTE_BREAK } from "./baselines.mjs";

import { atomicWriteText, withSourceLock } from "./source-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "health-history.json");
const ANALYTICS_DIR = join(ROOT, "data", "restream", "yt-analytics");
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
import { currentAnalyticsCohort, assertSourceStoreIntegrity } from "./source-integrity.mjs";

const HISTORY_DIR = join(ROOT, "data", "restream", "yt-analytics-history");
const PROMPT_PATH = join(HERE, "health-prompt.md");
const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
const MAX_TOKENS = 16000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

// store v2 (PRD v9 W24): entries carry per-measure ageBasis/window/note and
// per-entry checkSet; v1 files are accepted and upgraded in place with every
// existing entry byte-identical.
// store v3 (PRD v10 W29): entries carry direction, outlook, asOf, and per-
// measure qualified/carried stamps; v1 and v2 files are accepted and upgraded
// in place with every existing entry byte-identical.
export const HEALTH_STORE_VERSION = 3;
// health-v3 (2026-08-23, PRD v9): like-for-like bases, eight-episode windows,
// three-peer minimum per measure, episode-read selection, absolute-scale
// sentiment never inflated by absences. Saved entries keep their own stamp.
// health-v4 (2026-09-01, PRD v10): seven checks (live split into turnout and
// participation), counted engagement, same-age exposure, qualified promo
// lifts, carried reads at half weight, direction and outlook lenses. Widened
// the same evening, before any v4 entry existed (PRD v10 addendum, rule 23):
// live turnout also reads unique live viewers and minutes watched live,
// participation also reads minutes per live viewer and the hold rate, reach
// also reads YouTube discovery share; each check's state word comes from
// bands that follow the show's own swing on that check.
// health-v5 (2026-09-02, PRD v12 §3.1): the two live measures a known
// reporting break touches (people who watched live, minutes per viewer) take
// peers only from the newest episode's side of the break — three or nothing.
// Same checks, same weights, same measures otherwise. The day's v4 read is
// re-derived and kept under superseded (rule 9).
// health-v6 (2026-09-03, broadcast-only correction): commenters per thousand
// can read only a finished episode. A young episode's rate previously entered
// the fact sheet even though the peer window correctly required maturity.
// health-v7/v8 (2026-09-03, air-date correction): an episode cannot become the
// show-health anchor until the Phoenix date after it airs. Current air-date
// counters remain visible on its card but stay out of the saved daily read.
// v8 is the first saved read built after all four destination stores landed.
// health-v9 (2026-09-03): an exact UX Tools newsletter link marks only the
// linked viewing source as promoted. Its clicks never enter the score; the
// affected viewing number is shown but left out of clean comparisons.
export const FORMULA_VERSION = "health-v9";
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
// prompt v6 (2026-09-01, PRD v10): seven check names, the promo-qualified and
// carried rules, and the direction / outlook facts the drivers may draw on.
// prompt v7 (2026-09-01 evening, rule 23): check states come from bands that
// follow the show's own swing, so the model reads each check's `state` word
// instead of fixed 45 / 55 cut-offs; the live and reach checks gained measures.
export const PROMPT_VERSION = 7;
const V3_WEIGHTS = Object.freeze({
  growth: 0.25,
  audienceQuality: 0.20,
  reachEfficiency: 0.15,
  livePull: 0.15,
  conversion: 0.10,
  sentiment: 0.15,
});
export const BASE_WEIGHTS = Object.freeze({
  growth: 0.25,
  audienceQuality: 0.17,
  reachEfficiency: 0.12,
  livePull: 0.16,
  participation: 0.12,
  conversion: 0.08,
  sentiment: 0.10,
});
// historical entries are judged by the weights of the formula they were written under
export const WEIGHTS_BY_FORMULA = Object.freeze({
  "health-v1": V3_WEIGHTS,
  "health-v2": V3_WEIGHTS,
  "health-v3": V3_WEIGHTS,
  "health-v4": BASE_WEIGHTS,
  "health-v5": BASE_WEIGHTS,
  "health-v6": BASE_WEIGHTS,
  "health-v7": BASE_WEIGHTS,
  "health-v8": BASE_WEIGHTS,
  "health-v9": BASE_WEIGHTS,
});
export const CHECK_LABELS = Object.freeze({
  growth: "growth", audienceQuality: "audience quality", reachEfficiency: "reach", livePull: "live turnout", participation: "participation", conversion: "subscribers", sentiment: "goodwill",
});
export const STALE_WITHHOLD_DAYS = 7;

const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAtomic(path, value) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
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
// PRD v10: `qualified` keeps value and typical but scores null (a promo-driven
// lift is shown, never scored); `carried` stamps a read from an older episode
// than the newest, which counts CARRIED_WEIGHT inside its check.
function measurement(id, value, ps, { ageBasis = null, reason = null, episodeRead = null, readDate = null, absoluteScale = false, qualified = false, carried = false, carriedFrom = null } = {}) {
  const typical = ps?.typical ?? null;
  // ONE scoring path: the three-decimal comparison is stored, and the score
  // is derived from it — never from the unrounded quotient — so the writer,
  // the validator, and the verifier can never straddle a .5 boundary
  const ratio = !absoluteScale && Number.isFinite(value) && Number.isFinite(typical) && typical > 0 ? Math.round((value / typical) * 1000) / 1000 : null;
  const rawScore = absoluteScale ? (Number.isFinite(value) ? Math.round(clamp(value)) : null) : (ratio == null ? null : Math.round(clamp(50 * ratio)));
  const score = qualified ? null : rawScore;
  // a qualified lift is still a like-for-like comparison — it keeps its basis
  // and note (rule 17) even though it scores nothing
  const compared = score != null || (qualified && rawScore != null);
  const note = compared && ageBasis && NOTES[ageBasis] ? NOTES[ageBasis] : null;
  return {
    id,
    value: Number.isFinite(value) ? round1(value) : null,
    typical: Number.isFinite(typical) ? round1(typical) : null,
    ratio,
    sample: ps ? ps.n : 0,
    score,
    reason: score == null ? (qualified && rawScore != null ? NOTES.promoQualified : (reason || ps?.reason || null)) : null,
    ageBasis: compared ? ageBasis : null,
    absoluteScale,
    qualified: Boolean(qualified && rawScore != null),
    carried: Boolean(carried && score != null),
    carriedNote: carried && score != null && carriedFrom ? NOTES.carried(carriedFrom) : null,
    // rule 23: how much this measure normally swings between episodes (a
    // whole-percent share of the typical), from the same peers the typical used
    swing: !absoluteScale && ps && Number.isFinite(typical) ? swingOf(ps.peers.map((p) => p.value), typical) : null,
    window: ps ? ps.peers.map((p) => p.slug) : [],
    excluded: ps ? ps.excluded : [],
    episodeRead,
    readDate,
    note,
  };
}

// A check's stored reason names its ABSENT measures (a qualified lift carries
// its own reason on the measure) and, when given, which episode it read
function checkReason(measures, ...extra) {
  return [...Object.values(measures).filter((m) => m.score == null && !m.qualified).map((m) => m.reason), ...extra].filter(Boolean).join(" ") || null;
}

// A check's score is the mean of its scored measures, a carried measure
// counting CARRIED_WEIGHT; a check whose every scored measure is carried is
// itself carried (half weight in the mean, rule 19).
export function checkScoreOf(measures) {
  const present = Object.values(measures).filter((measure) => Number.isFinite(measure.score));
  if (!present.length) return { score: null, carried: false };
  const weightOf = (m) => (m.carried ? CARRIED_WEIGHT : 1);
  const total = present.reduce((sum, m) => sum + weightOf(m), 0);
  const score = Math.round(present.reduce((sum, m) => sum + m.score * weightOf(m), 0) / total);
  return { score, carried: present.every((m) => m.carried) };
}

// A check's swing is the median of its scored measures' swings; its bands
// follow that swing (baselines.bandsFor) and its state word follows the bands
// (rule 23) — stamped here once, copied by the page and the verifier.
export function checkBandsOf(measures) {
  const swings = Object.values(measures).filter((m) => Number.isFinite(m.score) && Number.isFinite(m.swing)).map((m) => m.swing);
  const swing = swings.length ? Math.round(trueMedian(swings)) : null;
  return { swing, bands: bandsFor(swing) };
}

function finishSubScore(key, measures, reason) {
  const { score, carried } = checkScoreOf(measures);
  const present = Object.values(measures).filter((measure) => Number.isFinite(measure.score));
  const { swing, bands } = checkBandsOf(measures);
  return {
    score,
    baseWeight: BASE_WEIGHTS[key],
    effectiveWeight: 0,
    // a check scored only by absolute-scale measures never absorbs the weight
    // of absent checks (PRD v9 rule 13) — an honest absence must not lift it
    absoluteScale: present.length > 0 && present.every((m) => m.absoluteScale),
    carried,
    swing,
    bands,
    state: stateOf(score, bands),
    measures,
    reason,
  };
}

// Available relative checks share the weight of absent checks; an absolute
// check keeps exactly its base weight; a carried check brings half its base
// weight to the share (PRD v10 rule 19). Weights sum to 1 when anything scored.
export function deterministicMean(subScores) {
  const parts = Object.values(subScores);
  const available = parts.filter((part) => Number.isFinite(part.score));
  const baseOf = (part) => part.baseWeight * (part.carried ? CARRIED_WEIGHT : 1);
  const availableWeight = available.reduce((sum, part) => sum + part.baseWeight, 0);
  const absoluteWeight = available.filter((part) => part.absoluteScale).reduce((sum, part) => sum + part.baseWeight, 0);
  const relativeWeight = available.filter((part) => !part.absoluteScale).reduce((sum, part) => sum + baseOf(part), 0);
  const effective = (part) => {
    if (!Number.isFinite(part.score)) return 0;
    if (part.absoluteScale) return relativeWeight > 0 ? part.baseWeight : part.baseWeight / availableWeight;
    return relativeWeight > 0 ? baseOf(part) * (1 - absoluteWeight) / relativeWeight : 0;
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
  const sourceDate = phoenixDate(sourceNow);
  const episodes = [...source.episodes]
    .filter((episode) => episode.premiere < sourceDate)
    .sort((a, b) => a.premiere.localeCompare(b.premiere));
  if (!episodes.length) throw new Error("No episode has completed its air date yet.");
  const newest = episodes.at(-1);
  const analyticsBySlug = new Map();
  const historyBySlug = new Map();
  for (const episode of episodes) {
    const analytics = readJson(join(root, "data", "restream", "yt-analytics", `${episode.slug}.json`));
    if (currentAnalyticsCohort(episode, analytics, sourceNow).length) analyticsBySlug.set(episode.slug, analytics);
    const hp = join(root, "data", "restream", "yt-analytics-history", `${episode.slug}.jsonl`);
    historyBySlug.set(episode.slug, existsSync(hp) ? readFileSync(hp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  }
  const classified = readJson(join(root, "data", "restream", "comments-classified.json"));
  const flags = anomalyFlags(episodes);
  const unitFlagged = (episode, unit) => flags.get(episode.slug)?.units?.[unit]?.flag === true;
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
  // the analytics measures are view-based: an episode flagged on X units only still reads
  const latestAtLeast = (days, extra = () => true) => [...episodes].reverse().find((e) => ageOf(e) >= days && !flaggedOn(flags, e.slug, UNIT_FAMILIES.views) && extra(e)) || null;
  // when the newest episode is old enough but promo-flagged, the read falls to
  // the latest finished clean one and the note says why (rule 19)
  const readNote = (episode) => (episode && episode.slug !== newest.slug
    ? (flags.get(newest.slug)?.flagged && ageOf(newest) >= MATURITY_DAYS.xAnnounce ? NOTES.readFromPromo(short(episode)) : NOTES.readFrom(short(episode)))
    : null);
  const carriedOpts = (episode) => (episode && episode.slug !== newest.slug ? { carried: true, carriedFrom: short(episode) } : {});
  const newestAge = ageOf(newest);
  const paceWindow = windowFor(newest, episodes);
  const paceAge = Math.min(newestAge, READ_DAYS);
  const newestSnap = snapshotAt(newest, paceAge);
  const newestYtAge = ytCurrentAge(newest);
  const ytPaceAge = Number.isFinite(newestYtAge) ? Math.min(newestYtAge, READ_DAYS) : null;
  const newestYtSnap = Number.isFinite(ytPaceAge) ? ytSnapshotAt(newest, ytPaceAge) : null;
  // the DIRECTION and OUTLOOK lenses are computed once, by build-data, from
  // the shared definitions (baselines.computeDirection / computeOutlook) and
  // served every build; the entry copies the served blocks so the history is
  // exactly what the owners saw — never gated on the model step
  const direction = source.baselines?.direction ?? null;
  const outlook = source.baselines?.outlook ?? null;
  if (!direction?.measures || !outlook?.nextFirstWeek) throw new Error("data.json carries no direction/outlook lenses — run build-data.mjs first");
  const firstWeekTrend = direction.measures.find((m) => m.key === "firstWeek");

  // --- Growth: first-week direction (ageFree, Theil–Sen over clean weeks) + same-age launch (sameAge, qualified when promo-flagged) ---
  addFact("clean-first-weeks", firstWeekTrend.n, "", (display) => `Only ${display} episodes have clean first-week records.`, ["data.json#showTrend.week1VelocityByEpisode"]);
  let week1Measure;
  if (firstWeekTrend.pctPerEpisode != null) {
    const changeEachEpisode = 1 + firstWeekTrend.pctPerEpisode / 100;
    week1Measure = measurement("firstWeek", changeEachEpisode, { typical: 1, n: firstWeekTrend.n, peers: firstWeekTrend.points.map((p) => ({ slug: p.slug })), excluded: [], reason: null }, { ageBasis: "ageFree" });
    addFact("latest-clean-first-week", firstWeekTrend.points.at(-1).value, "", (display) => `The latest clean first week reached ${display} YouTube views.`, ["data.json#showTrend.week1VelocityByEpisode"]);
    addFact("first-week-change-each-episode", Math.abs(firstWeekTrend.pctPerEpisode), "%", (display) => `Across the last ${firstWeekTrend.n === 3 ? "three" : firstWeekTrend.n === 4 ? "four" : "five"} clean first weeks the slope runs ${firstWeekTrend.pctPerEpisode >= 0 ? "up" : "down"} about ${display} each episode${firstWeekTrend.direction ? "" : " — too few weeks for a direction word"}.`, ["data.json#showTrend.week1VelocityByEpisode"]);
  } else {
    week1Measure = measurement("firstWeek", null, null, { reason: `Only ${firstWeekTrend.n} clean first weeks exist; at least three are required.` });
  }
  const pacePeers = peersFor({ own: newest, window: paceWindow, flags, units: UNIT_FAMILIES.views, valueOf: (p) => { const s = Number.isFinite(ytPaceAge) ? ytSnapshotAt(p, ytPaceAge) : null; return s ? ytViewsOf(s) : null; } });
  const launchQualified = unitFlagged(newest, "ytViews");
  const sameAgeMeasure = pacePeers.typical != null && newestYtSnap
    ? measurement("sameAge", ytViewsOf(newestYtSnap), pacePeers, { ageBasis: "sameAge", episodeRead: newest.slug, qualified: launchQualified })
    : measurement("sameAge", null, pacePeers, { reason: newestYtSnap ? NOTES.youngAge(pacePeers.n) : NOTES.noYtReading });
  if (sameAgeMeasure.value != null && pacePeers.typical != null) {
    addFact("latest-same-age-youtube", sameAgeMeasure.value, "", (display) => `The latest episode has ${display} YouTube views at this age.`, [`data.json#episodes.${newest.slug}.latest.ytTotal`], launchQualified ? "promo" : null);
    addFact("typical-same-age-youtube", pacePeers.typical, "", (display) => `Earlier episodes typically had ${display} YouTube views at the same age.`, ["data.json#episodes.snapshots"]);
  }
  const subScores = {
    growth: finishSubScore("growth", { firstWeek: week1Measure, sameAge: sameAgeMeasure }, checkReason({ firstWeek: week1Measure, sameAge: sameAgeMeasure })),
  };

  // --- Audience quality: likes and comments COUNTED at the newest episode's age (sameAge — a count, never diluted by promo views); share watched (sameAge via history, else mature; carried when not the newest) ---
  const engPeers = peersFor({ own: newest, window: paceWindow, flags, units: UNIT_FAMILIES.views, valueOf: (p) => { const s = Number.isFinite(ytPaceAge) ? ytSnapshotAt(p, ytPaceAge) : null; return s ? ytEngagementOf(s) : null; } });
  const engagementMeasure = engPeers.typical != null && newestYtSnap
    ? measurement("engagement", ytEngagementOf(newestYtSnap), engPeers, { ageBasis: "sameAge", episodeRead: newest.slug })
    : measurement("engagement", null, engPeers, { reason: newestYtSnap ? NOTES.youngAge(engPeers.n) : NOTES.noYtReading });
  if (engagementMeasure.score != null) {
    addFact("latest-engagement-count", engagementMeasure.value, "", (display) => `The latest episode has drawn ${display} likes and comments on YouTube at this age.`, [`data.json#episodes.${newest.slug}.snapshots`]);
    addFact("typical-engagement-count", engagementMeasure.typical, "", (display) => `Earlier episodes typically had ${display} likes and comments at the same age.`, ["data.json#episodes.snapshots"]);
  }

  // analytics measures: own = latest episode ≥ 7 d; sameAge when own and
  // MIN_PEERS peers have a history line at own's current age; otherwise mature
  // (own ≥ 21 d, peers ≥ 21 d, current file). Once a measure has been sameAge
  // in a saved entry it never falls back (PRD v9 §3.1 transition rule). A
  // read from an older episode than the newest is carried (PRD v10 rule 19).
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
  const subsPer1k = (channels) => subsPer1kOf(channels);
  const analyticsMeasure = (id, check, pick) => {
    const own = latestAtLeast(MATURITY_DAYS.xAnnounce, (e) => analyticsBySlug.has(e.slug));
    if (!own) return measurement(id, null, null, { reason: "No episode at least a week old has a YouTube analytics report yet." });
    const A = ageOf(own);
    const window = windowFor(own, episodes);
    const lineValue = (e) => { const line = ytHistoryAt(historyBySlug.get(e.slug), A, e.premiere); return line ? pick(line.channels) : null; };
    const sameAge = peersFor({ own, window, flags, units: UNIT_FAMILIES.views, valueOf: lineValue });
    const ownLine = lineValue(own);
    if (sameAge.typical != null && Number.isFinite(ownLine)) {
      return measurement(id, ownLine, sameAge, { ageBasis: "sameAge", episodeRead: own.slug, readDate: ytHistoryAt(historyBySlug.get(own.slug), A, own.premiere)?.date ?? null, ...carriedOpts(own) });
    }
    if (prevBasis(check, id) === "sameAge") return measurement(id, null, sameAge, { reason: NOTES.noReadingAtAge });
    const matureOwn = latestAtLeast(MATURITY_DAYS.analytics, (e) => analyticsBySlug.has(e.slug));
    if (!matureOwn) return measurement(id, null, null, { reason: "No episode is three weeks old yet with a YouTube analytics report." });
    const matureWindow = windowFor(matureOwn, episodes).filter((p) => ageOf(p) >= MATURITY_DAYS.analytics);
    const mature = peersFor({ own: matureOwn, window: matureWindow, flags, units: UNIT_FAMILIES.views, valueOf: (p) => pick(analyticsBySlug.get(p.slug)?.channels) });
    const ownValue = pick(analyticsBySlug.get(matureOwn.slug)?.channels);
    if (mature.typical == null || !Number.isFinite(ownValue)) return measurement(id, null, mature, { reason: mature.reason || "No reading for the latest three-week-old episode." });
    return measurement(id, ownValue, mature, { ageBasis: "mature", episodeRead: matureOwn.slug, readDate: (analyticsBySlug.get(matureOwn.slug)?.updatedAt || "").slice(0, 10) || null, ...carriedOpts(matureOwn) });
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
  subScores.audienceQuality = finishSubScore("audienceQuality", { engagement: engagementMeasure, watching: retentionMeasure }, checkReason({ engagement: engagementMeasure, watching: retentionMeasure }, readNote(episodes.find((e) => e.slug === retentionMeasure.episodeRead))));

  // --- Reach: X exposure at the newest episode's age (sameAge, qualified when promo-flagged); announce-to-play same-age when three peers carry plays at that age, else carried from the latest finished clean episode (mature, 7 d) ---
  const exposurePeers = peersFor({ own: newest, window: paceWindow, flags, units: UNIT_FAMILIES.reach, valueOf: (p) => { const s = snapshotAt(p, paceAge); const v = s ? xImpressionsOf(s) : null; return v > 0 ? v : null; } });
  const newestExposure = newestSnap ? xImpressionsOf(newestSnap) : null;
  const exposureQualified = unitFlagged(newest, "xImpressions");
  const exposureMeasure = exposurePeers.typical != null && newestExposure > 0
    ? measurement("exposure", newestExposure, exposurePeers, { ageBasis: "sameAge", episodeRead: newest.slug, qualified: exposureQualified })
    : measurement("exposure", null, exposurePeers, { reason: NOTES.youngAge(exposurePeers.n) });
  if (exposureMeasure.value != null && exposurePeers.typical != null) {
    addFact("latest-same-age-reach", exposureMeasure.value, "", (display) => `The latest episode's X announces have been seen ${display} times at this age.`, [`data.json#episodes.${newest.slug}.latest.xImpressions`], exposureQualified ? "promo" : null);
    addFact("typical-same-age-reach", exposurePeers.typical, "", (display) => `Earlier episodes' announces had typically been seen ${display} times at the same age.`, ["data.json#episodes.snapshots"]);
  }
  const playsAt = (e, A) => { const s = snapshotAt(e, A); const plays = s ? xPlaysOf(s, e.latest?.xPlaysInfo?.total) : null; const imp = s ? xImpressionsOf(s) : null; return Number.isFinite(plays) && imp > 0 ? (plays / imp) * 100 : null; };
  const reachOk = (e) => ageOf(e) >= MATURITY_DAYS.xAnnounce && !flaggedOn(flags, e.slug, UNIT_FAMILIES.reach) && Number.isFinite(e.latest?.xPlays)
    && e.latest.xPlaysInfo?.partial === false && e.latest.xPlaysInfo?.stale === false && e.latest.xImpressions > 0 && e.latest.totalViews > 0;
  const sameAgePlays = peersFor({ own: newest, window: paceWindow, flags, units: UNIT_FAMILIES.reach, valueOf: (p) => playsAt(p, paceAge) });
  const newestPlays = playsAt(newest, paceAge);
  let announceMeasure, reachReason = null, reachOwn = null;
  if (sameAgePlays.typical != null && Number.isFinite(newestPlays)) {
    announceMeasure = measurement("announceToPlay", newestPlays, sameAgePlays, { ageBasis: "sameAge", episodeRead: newest.slug, qualified: exposureQualified || unitFlagged(newest, "xPlays") });
    reachOwn = newest;
  } else {
    reachOwn = [...episodes].reverse().find(reachOk) || null;
    if (reachOwn) {
      const window = windowFor(reachOwn, episodes).filter(reachOk);
      const ann = peersFor({ own: reachOwn, window, flags, units: UNIT_FAMILIES.reach, valueOf: (p) => p.latest.xPlays / p.latest.xImpressions * 100 });
      announceMeasure = measurement("announceToPlay", reachOwn.latest.xPlays / reachOwn.latest.xImpressions * 100, ann, { ageBasis: "mature", episodeRead: reachOwn.slug, readDate: reachOwn.latest.ts.slice(0, 10), ...carriedOpts(reachOwn) });
      reachReason = readNote(reachOwn);
    } else {
      announceMeasure = measurement("announceToPlay", null, null, { reason: "No episode at least a week old has complete X play counts yet." });
    }
  }
  if (announceMeasure.value != null && announceMeasure.typical != null) {
    const fromNewest = announceMeasure.episodeRead === newest.slug;
    addFact(fromNewest ? "latest-announce-play" : "latest-finished-announce-play", announceMeasure.value, "%", (display) => `${display} of ${fromNewest ? "the latest episode's" : "the latest finished episode's"} X announce impressions became plays.`, [`data.json#episodes.${announceMeasure.episodeRead}.latest`], announceMeasure.qualified ? "promo" : null);
    addFact("typical-announce-play", announceMeasure.typical, "%", (display) => `Earlier clean episodes typically turned ${display} of X announce impressions into plays.`, ["data.json#episodes.latest"]);
  }
  if (reachOwn && reachOk(reachOwn)) addFact("latest-finished-x-share", reachOwn.latest.xPlays / reachOwn.latest.totalViews * 100, "%", (display) => `X supplied ${display} of watching for ${reachOwn.slug === newest.slug ? "the latest episode" : "the latest finished episode"}.`, [`data.json#episodes.${reachOwn.slug}.latest`]);
  // rule 23: the share of YouTube views YouTube itself brought (search,
  // suggested, Shorts, browse) — same rule as share watched: sameAge when the
  // history carries it (it does not yet), else mature and carried
  const discoveryMeasure = analyticsMeasure("discoveryShare", "reachEfficiency", (ch) => discoveryShareOf(ch));
  let discoveryReason = null;
  if (discoveryMeasure.score != null) {
    const read = episodes.find((e) => e.slug === discoveryMeasure.episodeRead);
    addFact("latest-discovery-share", discoveryMeasure.value, "%", (display) => `${display} of ${read.slug === newest.slug ? "the latest" : "the latest finished"} episode's YouTube views came from search and suggested videos.`, [`data/restream/yt-analytics/${read.slug}.json`]);
    addFact("typical-discovery-share", discoveryMeasure.typical, "%", (display) => `Earlier episodes typically drew ${display} of their YouTube views from search and suggested videos.`, ["data/restream/yt-analytics/*.json"]);
    discoveryReason = read.slug === (reachOwn?.slug ?? null) ? null : readNote(read);
  }
  subScores.reachEfficiency = finishSubScore("reachEfficiency", { exposure: exposureMeasure, announceToPlay: announceMeasure, discoveryShare: discoveryMeasure }, checkReason({ exposure: exposureMeasure, announceToPlay: announceMeasure, discoveryShare: discoveryMeasure }, reachReason, discoveryReason));

  // --- Live turnout: newest peak, average concurrent, unique live viewers, and minutes watched live vs peers (ageFree; rule 23 added the last two) ---
  const liveOk = (e) => Number.isFinite(e.live?.peak) && Number.isFinite(e.live?.avg);
  const liveViewersOf = (e) => (liveOk(e) && Number.isFinite(e.live.liveViews) && e.live.liveViews > 0 ? e.live.liveViews : null);
  const liveMinutesOf = (e) => (liveOk(e) && Number.isFinite(e.live.watchedMin) && e.live.watchedMin > 0 ? e.live.watchedMin : null);
  let livePeakMeasure, liveAvgMeasure, liveViewersMeasure, liveMinutesMeasure;
  if (liveOk(newest)) {
    const window = windowFor(newest, episodes);
    const pk = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: (p) => (liveOk(p) ? p.live.peak : null) });
    const av = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: (p) => (liveOk(p) ? p.live.avg : null) });
    // PRD v12 §3.1 / health-v5: a known reporting break splits the peers —
    // only episodes on the newest's side of it are like for like
    const lv = peersFor({ own: newest, window: window.filter((p) => comparableAcrossBreaks("liveViewers", p)), flags, units: UNIT_FAMILIES.live, valueOf: liveViewersOf });
    const lm = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: liveMinutesOf });
    livePeakMeasure = measurement("peak", newest.live.peak, pk, { ageBasis: "ageFree", episodeRead: newest.slug });
    liveAvgMeasure = measurement("average", newest.live.avg, av, { ageBasis: "ageFree", episodeRead: newest.slug });
    liveViewersMeasure = liveViewersOf(newest) != null
      ? measurement("liveViewers", liveViewersOf(newest), lv, { ageBasis: "ageFree", episodeRead: newest.slug, reason: lv.typical == null ? NOTE_BREAK("liveViewers") : null })
      : measurement("liveViewers", null, null, { reason: "The latest episode's live session has no viewer count." });
    liveMinutesMeasure = liveMinutesOf(newest) != null
      ? measurement("minutesWatched", liveMinutesOf(newest), lm, { ageBasis: "ageFree", episodeRead: newest.slug })
      : measurement("minutesWatched", null, null, { reason: "The latest episode's live session has no watch-time total." });
    if (liveViewersMeasure.score != null) {
      addFact("latest-live-viewers", liveViewersMeasure.value, "", (display) => `${display} people watched the latest show live.`, [`data.json#episodes.${newest.slug}.live.liveViews`]);
      addFact("typical-live-viewers", liveViewersMeasure.typical, "", (display) => `Earlier shows were typically watched live by ${display} people.`, ["data.json#episodes.live.liveViews"]);
    }
    if (liveMinutesMeasure.score != null) {
      addFact("latest-live-minutes", liveMinutesMeasure.value, "", (display) => `People watched ${display} minutes of the latest show live, all together.`, [`data.json#episodes.${newest.slug}.live.watchedMin`]);
      addFact("typical-live-minutes", liveMinutesMeasure.typical, "", (display) => `Earlier shows were typically watched for ${display} live minutes all together.`, ["data.json#episodes.live.watchedMin"]);
    }
    if (livePeakMeasure.score != null) {
      addFact("latest-live-peak", newest.live.peak, "", (display) => `The latest show peaked at ${display} live viewers.`, [`data.json#episodes.${newest.slug}.live.peak`]);
      addFact("typical-live-peak", livePeakMeasure.typical, "", (display) => `Earlier shows typically peaked at ${display} live viewers.`, ["data.json#episodes.live.peak"]);
    }
    if (liveAvgMeasure.score != null) {
      addFact("latest-live-average", newest.live.avg, "", (display) => `The latest show averaged ${display} live viewers.`, [`data.json#episodes.${newest.slug}.live.avg`]);
      addFact("typical-live-average", liveAvgMeasure.typical, "", (display) => `Earlier shows typically averaged ${display} live viewers.`, ["data.json#episodes.live.avg"]);
    }
  } else {
    const reason = newest.live ? "The latest episode's live session record is incomplete." : "The latest episode has no live session record.";
    livePeakMeasure = measurement("peak", null, null, { reason });
    liveAvgMeasure = measurement("average", null, null, { reason });
    liveViewersMeasure = measurement("liveViewers", null, null, { reason });
    liveMinutesMeasure = measurement("minutesWatched", null, null, { reason });
  }
  const liveMeasures = { peak: livePeakMeasure, average: liveAvgMeasure, liveViewers: liveViewersMeasure, minutesWatched: liveMinutesMeasure };
  subScores.livePull = finishSubScore("livePull", liveMeasures, checkReason(liveMeasures));

  // --- Participation: chatters per 100 peak viewers, chat messages per hour, minutes each live viewer stayed, and the share of the peak still watching at the end, vs peers (ageFree; rule 23 added the last two) ---
  const newestRates = liveRatesOf(newest);
  const newestDepth = liveDepthOf(newest);
  let chattersMeasure, chatRateMeasure, stayMeasure, holdMeasure;
  if (newestRates && Number.isFinite(newestRates.chattersPer100) && Number.isFinite(newestRates.messagesPerHour)) {
    const window = windowFor(newest, episodes);
    const ch = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: (p) => liveRatesOf(p)?.chattersPer100 ?? null });
    const mr = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: (p) => liveRatesOf(p)?.messagesPerHour ?? null });
    const st = peersFor({ own: newest, window: window.filter((p) => comparableAcrossBreaks("minutesPerViewer", p)), flags, units: UNIT_FAMILIES.live, valueOf: (p) => liveDepthOf(p)?.minutesPerViewer ?? null });
    const hd = peersFor({ own: newest, window, flags, units: UNIT_FAMILIES.live, valueOf: (p) => liveDepthOf(p)?.holdRate ?? null });
    chattersMeasure = measurement("chattersPer100", newestRates.chattersPer100, ch, { ageBasis: "ageFree", episodeRead: newest.slug });
    chatRateMeasure = measurement("messagesPerHour", newestRates.messagesPerHour, mr, { ageBasis: "ageFree", episodeRead: newest.slug });
    stayMeasure = Number.isFinite(newestDepth?.minutesPerViewer)
      ? measurement("minutesPerViewer", newestDepth.minutesPerViewer, st, { ageBasis: "ageFree", episodeRead: newest.slug, reason: st.typical == null ? NOTE_BREAK("minutesPerViewer") : null })
      : measurement("minutesPerViewer", null, null, { reason: "The latest episode's live session has no watch-time or viewer total." });
    holdMeasure = Number.isFinite(newestDepth?.holdRate)
      ? measurement("holdRate", newestDepth.holdRate, hd, { ageBasis: "ageFree", episodeRead: newest.slug })
      : measurement("holdRate", null, null, { reason: "The latest episode's live session has no minute-by-minute audience record." });
    if (stayMeasure.score != null) {
      addFact("latest-minutes-per-viewer", stayMeasure.value, "", (display) => `Each person who watched the latest show live stayed ${display} minutes on average.`, [`data.json#episodes.${newest.slug}.live`]);
      addFact("typical-minutes-per-viewer", stayMeasure.typical, "", (display) => `Earlier shows typically kept each live viewer for ${display} minutes.`, ["data.json#episodes.live"]);
    }
    if (holdMeasure.score != null) {
      addFact("latest-hold-rate", holdMeasure.value, "%", (display) => `${display} of the latest show's peak audience was still watching in its last ten minutes.`, [`data.json#episodes.${newest.slug}.live.series`]);
      addFact("typical-hold-rate", holdMeasure.typical, "%", (display) => `Earlier shows typically kept ${display} of their peak audience to the end.`, ["data.json#episodes.live.series"]);
    }
    if (chattersMeasure.score != null) {
      addFact("latest-chatters-per-100", newestRates.chattersPer100, "", (display) => `The latest show drew ${display} chatters for every hundred people at its peak.`, [`data.json#episodes.${newest.slug}.live.chatters`]);
      addFact("typical-chatters-per-100", chattersMeasure.typical, "", (display) => `Earlier shows typically drew ${display} chatters for every hundred people at their peak.`, ["data.json#episodes.live.chatters"]);
    }
    if (chatRateMeasure.score != null) {
      addFact("latest-chat-per-hour", newestRates.messagesPerHour, "", (display) => `The latest show drew ${display} chat messages an hour.`, [`data.json#episodes.${newest.slug}.live.chatMessages`]);
      addFact("typical-chat-per-hour", chatRateMeasure.typical, "", (display) => `Earlier shows typically drew ${display} chat messages an hour.`, ["data.json#episodes.live.chatMessages"]);
    }
  } else {
    const reason = newest.live ? "The latest episode's live session record is incomplete." : "The latest episode has no live session record.";
    chattersMeasure = measurement("chattersPer100", null, null, { reason });
    chatRateMeasure = measurement("messagesPerHour", null, null, { reason });
    stayMeasure = measurement("minutesPerViewer", null, null, { reason });
    holdMeasure = measurement("holdRate", null, null, { reason });
  }
  const participationMeasures = { chattersPer100: chattersMeasure, messagesPerHour: chatRateMeasure, minutesPerViewer: stayMeasure, holdRate: holdMeasure };
  subScores.participation = finishSubScore("participation", participationMeasures, checkReason(participationMeasures));

  // --- Subscriber conversion: same rule as share watched (carried when not the newest) ---
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
  const rateOwn = [...episodes].reverse().find(rateOk) || null;
  let commentRateMeasure;
  if (rateOwn) {
    const window = windowFor(rateOwn, episodes).filter(rateOk);
    const ps = peersFor({ own: rateOwn, window, flags, valueOf: (p) => p.comments.commentersPer1k, coverageOf, ownCoverage: coverageOf(rateOwn) });
    commentRateMeasure = measurement("commentRate", rateOwn.comments.commentersPer1k, ps, { ageBasis: "mature", episodeRead: rateOwn.slug, reason: ps.typical == null ? `Only ${ps.n + 1} episode${ps.n ? "s have" : " has"} complete replies and watch counts; at least four are required.` : null, ...carriedOpts(rateOwn) });
    addFact("latest-comment-rate", rateOwn.comments.commentersPer1k, "", (display) => `The latest comparable episode drew ${display} commenters for each thousand watches.`, [`data.json#episodes.${rateOwn.slug}.comments.commentersPer1k`], ps.typical == null ? "only one episode" : null);
  } else {
    commentRateMeasure = measurement("commentRate", null, null, { reason: "No episode has complete replies and watch counts yet." });
  }
  subScores.sentiment = finishSubScore("sentiment", { balance: balanceMeasure, commentRate: commentRateMeasure }, checkReason({ balance: balanceMeasure, commentRate: commentRateMeasure }));

  // --- Direction facts (PRD v10): one per durable measure that has a slope; the
  // words name the measure, the count of clean readings, and the basis ---
  for (const t of direction.measures) {
    if (t.pctPerEpisode == null || t.key === "firstWeek") continue;
    const words = {
      liveAverage: "average live viewers", livePeak: "peak live viewers", chattersPer100: "chatters per hundred at the peak",
      messagesPerHour: "chat messages an hour", engagementWeekOne: "first-week likes and comments", exposureWeekOne: "first-week X reach",
      announceToPlay: "announce-to-play on X", watching: "share of the video watched", subscribers: "subscribers per thousand views",
      liveViewers: "unique live viewers", minutesWatched: "minutes watched live", minutesPerViewer: "minutes each live viewer stayed",
      holdRate: "the share of the peak still watching at the end", discoveryShare: "the share of YouTube views from search and suggested videos",
    }[t.key] || t.key;
    const count = t.n === 3 ? "three" : t.n === 4 ? "four" : "five";
    const basis = t.ageBasis === "mature" ? ", as those episodes stand now" : "";
    const word = t.direction ? "" : " — too few readings for a direction word";
    addFact(`direction-${t.key}`, Math.abs(t.pctPerEpisode), "%", (display) => `Over the last ${count} clean readings${basis}, ${words} ${t.pctPerEpisode >= 0 ? "rose" : "fell"} about ${display} each episode${word}.`, ["data.json#baselines.direction"]);
  }
  // --- Outlook facts: where the last three clean first weeks landed (a description, never a bound) ---
  const nextFirstWeek = outlook.nextFirstWeek;
  if (nextFirstWeek.low != null) {
    addFact("outlook-first-week-low", nextFirstWeek.low, "", (display) => `The lowest of the last three clean first weeks was ${display} YouTube views.`, ["data.json#baselines.outlook"]);
    addFact("outlook-first-week-high", nextFirstWeek.high, "", (display) => `The highest of the last three clean first weeks was ${display} YouTube views.`, ["data.json#baselines.outlook"]);
  }

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
  // what the read is on (PRD v10 rule 19): the newest episode and its age, the
  // checks that read it, the checks carried from an older episode, the
  // measures whose lift is shown but not scored
  const asOf = {
    newest: newest.slug,
    newestTitle: short(newest),
    ageDays: round1(newestAge),
    provisional: newestAge < MATURITY_DAYS.xAnnounce,
    carried: Object.entries(subScores).filter(([, part]) => part.carried).map(([key]) => key),
    qualified: Object.entries(subScores).flatMap(([key, part]) => Object.values(part.measures).filter((m) => m.qualified).map((m) => `${key}.${m.id}`)),
  };

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
      launch: source.baselines?.launch?.[episode.slug] ? { word: source.baselines.launch[episode.slug].word, promoDriven: source.baselines.launch[episode.slug].promoDriven, provisional: source.baselines.launch[episode.slug].provisional } : null,
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
    asOf,
    direction,
    outlook,
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
    direction,
    outlook,
    asOf,
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

// --- the deterministic fallback (PRD v10 W34) --------------------------------
//
// Same contract as the model: score inside the allowed range (here the mean
// itself), two pros and two cons that each copy one cited fact's display
// value, a digit-free headline under 101 characters, one to three digit-free
// drivers, and — when the check set changed — the names of the checks that
// joined or left. Everything comes from the fact sheet and the check words.
const BAND_WORDS = (score) => (score >= 55 ? "above its usual level" : score >= 45 ? "near its usual level" : "below its usual level");
function fallbackSynthesis(inputs) {
  const facts = inputs.facts || [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  // a scored measure's own "latest-*" fact, ranked by the measure's score;
  // promo-qualified lifts never lead a pro (rule 18)
  const FACT_FOR = {
    "growth.firstWeek": "first-week-change-each-episode", "growth.sameAge": "latest-same-age-youtube",
    "audienceQuality.engagement": "latest-engagement-count", "audienceQuality.watching": "latest-watch-percent",
    "reachEfficiency.exposure": "latest-same-age-reach", "reachEfficiency.announceToPlay": ["latest-announce-play", "latest-finished-announce-play"],
    "reachEfficiency.discoveryShare": "latest-discovery-share",
    "livePull.peak": "latest-live-peak", "livePull.average": "latest-live-average", "livePull.liveViewers": "latest-live-viewers", "livePull.minutesWatched": "latest-live-minutes",
    "participation.chattersPer100": "latest-chatters-per-100", "participation.messagesPerHour": "latest-chat-per-hour",
    "participation.minutesPerViewer": "latest-minutes-per-viewer", "participation.holdRate": "latest-hold-rate",
    "conversion.subscribers": "latest-subscriber-rate", "sentiment.balance": "recent-positive-feedback", "sentiment.commentRate": "latest-comment-rate",
  };
  const scored = [];
  for (const [check, part] of Object.entries(inputs.subScores || {})) {
    for (const m of Object.values(part.measures || {})) {
      if (m.score == null || m.qualified) continue;
      const ids = [].concat(FACT_FOR[`${check}.${m.id}`] || []);
      const fact = ids.map((id) => byId.get(id)).find(Boolean);
      if (fact && fact.requiredPhrase !== "promo") scored.push({ check, measure: m, fact });
    }
  }
  scored.sort((a, b) => b.measure.score - a.measure.score);
  // rule 23: a check's word is its stamped state (bands that follow the
  // show's own swing), never a fixed cut-off
  const wordFor = (score, part) => part?.state ?? stateOf(score);
  const bullet = (row, side) => {
    const phrase = row.fact.requiredPhrase ? ` — ${row.fact.requiredPhrase}` : "";
    const tail = side === "up" ? "ahead of the show’s usual level" : "under the show’s usual level";
    // the fact sentence already carries its one number; keep it verbatim and add the standing
    const text = `${row.fact.text.replace(/\.$/, "")}, ${tail}${phrase}.`;
    return { text: text.length > 140 ? `${row.fact.text.replace(/\.$/, "")}${phrase}.`.slice(0, 140) : text, factId: row.fact.id };
  };
  const pros = scored.filter((r) => r.measure.score >= 50).slice(0, 2).map((r) => bullet(r, "up"));
  const cons = [...scored].reverse().filter((r) => r.measure.score < 50).slice(0, 2).map((r) => bullet(r, "down"));
  // fill to exactly two each from the remaining ranked facts, weakest side last
  const used = new Set([...pros, ...cons].map((b) => b.factId));
  for (const r of scored) { if (pros.length >= 2) break; if (!used.has(r.fact.id)) { pros.push(bullet(r, "up")); used.add(r.fact.id); } }
  for (const r of [...scored].reverse()) { if (cons.length >= 2) break; if (!used.has(r.fact.id)) { cons.push(bullet(r, "down")); used.add(r.fact.id); } }
  const checkWord = (key) => wordFor(inputs.subScores?.[key]?.score, inputs.subScores?.[key]);
  const names = (keys) => keys.map((k) => CHECK_LABELS[k] ?? k);
  const list = (keys) => names(keys).map((w, i, all) => (i === 0 ? "" : i === all.length - 1 ? " and " : ", ") + w).join("");
  const healthy = Object.keys(inputs.subScores || {}).filter((k) => Number.isFinite(inputs.subScores[k].score) && checkWord(k) === "healthy");
  const fragile = Object.keys(inputs.subScores || {}).filter((k) => Number.isFinite(inputs.subScores[k].score) && checkWord(k) === "fragile");
  const dir = inputs.direction?.overall || null;
  const dirWords = dir === "building" ? "building over the last clean episodes" : dir === "softening" ? "softening over the last clean episodes" : dir === "mixed" ? "moving in mixed directions" : "holding";
  let headline = `The show is ${BAND_WORDS(Math.round(inputs.weightedMean))} and ${dirWords}${fragile.length ? `; ${names(fragile).join(" and ")} ${fragile.length > 1 ? "look" : "looks"} fragile` : ""}${healthy.length ? `; ${names(healthy).join(" and ")} ${healthy.length > 1 ? "are" : "is"} healthy` : ""}.`;
  if (headline.length > 100) headline = `The show is ${BAND_WORDS(Math.round(inputs.weightedMean))} and ${dirWords}.`;
  const drivers = [`A deterministic read: the score is the weighted middle of the checks that could be measured today, with promo-driven lifts shown but not scored.`];
  const change = inputs.checkSetChange;
  if (change && (change.joined?.length || change.left?.length)) {
    const parts = [];
    if (change.joined?.length) parts.push(`${list(change.joined)} joined`);
    if (change.left?.length) parts.push(`${list(change.left)} left`);
    drivers.push(`Since the last saved read ${parts.join(" and ")}: the difference comes from which checks are available, not from the show changing.`);
  }
  if (inputs.asOf?.carried?.length) drivers.push(`${list(inputs.asOf.carried)} read the latest finished episode at half weight because the newest is too young for ${inputs.asOf.carried.length > 1 ? "them" : "it"}.`);
  return { score: Math.round(inputs.weightedMean), headline, pros, cons, drivers: drivers.slice(0, 3).map((d) => d.slice(0, 170)) };
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
    if (!response.ok) throw new Error(`anthropic HTTP ${response.status}`);
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
  if (!response.ok) throw new Error(`openai HTTP ${response.status}`);
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
      // PRD v10 rule 18 / prompt rule 12: a promo-driven lift is never strength
      if (side === "pros" && (inputs.promptVersion ?? PROMPT_VERSION) >= 6 && facts.get(bullet?.factId)?.requiredPhrase === "promo") throw new Error(`pros must not cite the promo-driven fact ${bullet.factId}`);
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
export const CHECK_ORDER = Object.freeze(["growth", "audienceQuality", "reachEfficiency", "livePull", "participation", "conversion", "sentiment"]);
export function projectHealth(store, { now = Date.now() } = {}) {
  if (!store) return null;
  if (![1, 2, HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
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
  // a promo-qualified measure is shown by design, not missing: it does not
  // make the read "early"
  const hasUnavailableCheck = Object.values(latest.subScores || {}).some((section) =>
    section?.score == null || Object.values(section?.measures || {}).some((measure) => measure?.score == null && !measure?.qualified));
  const hasEarlyFact = (latest.facts || []).some((fact) => fact?.requiredPhrase === "still early");
  const running = entries.filter((entry) => entry.formulaVersion === FORMULA_VERSION);
  return {
    date: latest.date,
    ageDays,
    withheld,
    formulaVersion: latest.formulaVersion ?? null,
    provider: latest.provider ?? null,
    model: latest.model ?? null,
    dataThrough: latest.dataThrough || null,
    score: withheld ? null : latest.score,
    readState: hasUnavailableCheck || hasEarlyFact ? "early" : "settled",
    headline: withheld ? null : latest.headline,
    // The saved per-check results, projected verbatim so the page can show the
    // whole diagnosis without ever recomputing: a score where one exists, the
    // saved reason where one does not, and each measure's stored note.
    // checks the entry does not carry (a pre-v4 entry has no participation)
    // are simply absent from the projection — never invented as "Not in yet"
    checks: withheld ? [] : CHECK_ORDER.filter((key) => latest.subScores?.[key]).map((key) => ({
      key,
      score: Number.isFinite(latest.subScores?.[key]?.score) ? latest.subScores[key].score : null,
      reason: latest.subScores?.[key]?.reason ?? null,
      carried: latest.subScores?.[key]?.carried === true,
      // rule 23: the stamped state word and the bands it came from (fixed
      // bands for entries written before the rule), plus the check's swing
      state: latest.subScores?.[key]?.state ?? stateOf(latest.subScores?.[key]?.score),
      bands: latest.subScores?.[key]?.bands ?? null,
      swing: latest.subScores?.[key]?.swing ?? null,
      measures: Object.entries(latest.subScores?.[key]?.measures || {}).map(([measureKey, measure]) => ({
        key: measureKey,
        value: measure?.value ?? null,
        typical: measure?.typical ?? null,
        sample: measure?.sample ?? null,
        reason: measure?.reason ?? null,
        ageBasis: measure?.ageBasis ?? null,
        note: measure?.note ?? null,
        episodeRead: measure?.episodeRead ?? null,
        qualified: measure?.qualified === true,
        carried: measure?.carried === true,
        carriedNote: measure?.carriedNote ?? null,
        swing: measure?.swing ?? null,
      })),
    })),
    // PRD v10: what the read is on, which way each durable measure is moving,
    // and where the next launch is expected to land — stored with the entry,
    // projected verbatim, never recomputed on the page
    asOf: withheld ? null : (latest.asOf ?? null),
    direction: withheld ? null : (latest.direction ? {
      overall: latest.direction.overall ?? null,
      measures: (latest.direction.measures || []).map((t) => ({ key: t.key, n: t.n, pctPerEpisode: t.pctPerEpisode ?? null, direction: t.direction ?? null, reason: t.reason ?? null })),
    } : null),
    outlook: withheld ? null : (latest.outlook ? {
      nextFirstWeek: latest.outlook.nextFirstWeek ? { low: latest.outlook.nextFirstWeek.low ?? null, high: latest.outlook.nextFirstWeek.high ?? null, typical: latest.outlook.nextFirstWeek.typical ?? null, n: latest.outlook.nextFirstWeek.n ?? 0, direction: latest.outlook.nextFirstWeek.direction ?? null, reason: latest.outlook.nextFirstWeek.reason ?? null } : null,
      coolOff: latest.outlook.coolOff ? { ageDays: latest.outlook.coolOff.ageDays ?? null, word: latest.outlook.coolOff.word ?? null, n: latest.outlook.coolOff.n ?? 0, reason: latest.outlook.coolOff.reason ?? null } : null,
    } : null),
    // PRD v12: the facts the bullets cite, projected so an agent can cite
    // the same ids (id, the display string, the sentence) — never recomputed
    facts: withheld ? [] : (latest.facts || []).map((f) => ({ id: f.id, display: f.display, text: f.text })),
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
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) throw new Error("health model credential is unavailable; previous saved score kept");
  const system = readFileSync(PROMPT_PATH, "utf8");
  const payload = {
    task: "Write today's Dive Radio show-health summary.",
    weightedMean: inputs.weightedMean,
    allowedScore: inputs.allowedScore,
    subScores: inputs.subScores,
    facts: inputs.facts,
    direction: inputs.direction,
    outlook: inputs.outlook,
    asOf: inputs.asOf,
    context: inputs.context,
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // the second attempt is told exactly which rule the first one broke —
      // a blind retry of a deterministic rule failure fails identically
      const result = await callOnce(system, lastError ? { ...payload, previousAttemptError: String(lastError.message).slice(0, 300) } : payload);
      let parsed;
      try { parsed = JSON.parse(result.text); }
      catch (error) { throw new Error(`response was not raw JSON: ${error.message}`); }
      validateSynthesis(parsed, inputs);
      return { synthesis: parsed, provider: result.provider, model: result.model };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`health model synthesis failed after two attempts: ${lastError.message}; previous saved score kept`);
}

function loadStore() {
  const store = readJson(STORE_PATH, { version: HEALTH_STORE_VERSION, updatedAt: null, entries: [] });
  if (![1, 2, HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
  store.version = HEALTH_STORE_VERSION; // v1/v2 files upgrade in place; entries stay byte-identical
  // rule 9 (formula bump day): a day's read written under an older formula is
  // re-derived by the new one and the old read is kept byte-identical here
  if (!Array.isArray(store.superseded)) store.superseded = [];
  const dates = store.entries.map((entry) => entry.date);
  if (new Set(dates).size !== dates.length) throw new Error("health-history.json contains more than one entry for a day");
  return store;
}

async function main() {
  assertSourceStoreIntegrity(ROOT);
  const data = readJson(DATA_PATH);
  if (!data) throw new Error("data.json is missing");
  const sourceNow = Date.parse(data.generatedAt);
  const store = loadStore();
  const date = phoenixDate(sourceNow);
  // the previous read is the last one BEFORE today — on a formula-bump day
  // today's older-formula read is being replaced, not continued
  const previous = store.entries.filter((entry) => entry.date < date).at(-1) ?? null;
  const inputs = computeHealthInputs({ data, now: sourceNow, previous });
  if (process.argv.includes("--dry")) {
    console.log(JSON.stringify({ weightedMean: inputs.weightedMean, allowedScore: inputs.allowedScore, availableChecks: inputs.availableChecks, checkSet: inputs.checkSet, checkSetChange: inputs.checkSetChange, asOf: inputs.asOf, direction: inputs.direction, outlook: inputs.outlook, subScores: inputs.subScores, facts: inputs.facts }, null, 2));
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
  if (process.argv.includes("--probe-fallback")) {
    const synthesis = validateSynthesis(fallbackSynthesis(inputs), inputs);
    console.log(JSON.stringify(synthesis, null, 2));
    console.log("health probe: the deterministic fallback passes the grounding rules");
    return;
  }

  const existing = store.entries.find((entry) => entry.date === date) ?? null;
  if (existing && existing.formulaVersion === FORMULA_VERSION) {
    console.log(`health: ${date} already saved — append-only store unchanged`);
    return;
  }
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  const promptHash = sha(prompt);
  if (previous?.promptVersion === PROMPT_VERSION && previous.promptHash && previous.promptHash !== promptHash) {
    throw new Error("health prompt changed without a prompt version bump");
  }

  const result = await synthesize(inputs);
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
    direction: inputs.direction,
    outlook: inputs.outlook,
    asOf: inputs.asOf,
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
  if (existing) {
    // rule 9: a formula bump re-derives the day visibly — the older read is
    // kept byte-identical under `superseded`, and the new read says what it replaced
    entry.rederivedFrom = { formulaVersion: existing.formulaVersion, score: existing.score };
    store.entries = store.entries.filter((e) => e !== existing);
    store.superseded.push({ supersededOn: date, by: FORMULA_VERSION, entry: existing });
  }
  store.entries.push(entry);
  store.entries.sort((a, b) => a.date.localeCompare(b.date));
  store.updatedAt = entry.createdAt;
  saveAtomic(STORE_PATH, store);
  console.log(`health: saved ${date} score ${entry.score} (deterministic mean ${entry.weightedMean}, move ${entry.deviation >= 0 ? "+" : ""}${entry.deviation})${existing ? ` — re-derived under ${FORMULA_VERSION}; the ${existing.formulaVersion} read (${existing.score}) is kept under superseded` : ""}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) Promise.resolve().then(() => withSourceLock(STORE_PATH, main)).catch((error) => {
  process.stderr.write(`health: ${error.message}\n`);
  process.exit(1);
});
