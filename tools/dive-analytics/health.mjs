#!/usr/bin/env node
// health.mjs — W10 deterministic show checks + model-written health summary.
//
// This is the only script allowed to call a model for show health. It uses
// fetch directly and has no runtime dependencies. build-data.mjs only reads
// the persisted health-history.json store; it never calls a model.
//
// Deterministic formulas (all results are clamped to 0..100):
//   relative(value, typical) = 50 * value / typical
//   growth 25%              = average of clean first-week direction and the
//                             newest episode's same-age YouTube pace. Each
//                             measure needs at least three clean comparisons.
//   audience quality 20%    = latest engagement and YouTube watch percentage,
//                             each compared with at least three prior episodes.
//   reach efficiency 15%    = X announce-to-play result and X share for the
//                             latest finished, non-promo-outlier episode,
//                             compared with at least three prior clean episodes.
//   live pull 15%           = latest peak and chat against at least three prior
//                             live sessions.
//   conversion 10%          = subscribers gained for each thousand YouTube views
//                             on the latest episode, both channels combined,
//                             against at least three prior clean episodes.
//   sentiment 15%           = positive + half of mixed reactions across the
//                             three newest episodes, with a commenter-rate
//                             comparison added only after three prior episodes
//                             have complete replies and watches.
//
// A missing measure is null with a reason, never zero. Available measures share
// their check's weight; available checks share missing checks' weights. The model
// may move the final score at most 8 points from that weighted mean. One immutable
// entry is appended per Phoenix calendar day. Model failure is non-fatal: the
// previous entry remains the public truth and its saved date stays visible.
//
// Staleness audit (PRD v7 W18, 2026-08-23): this store does NOT share the
// staleness class that broke recommendations.json. Each saved entry carries
// the fact sheet it was written against, and validate.mjs judges every entry
// against ITS OWN saved facts and stamped prompt/formula versions — never
// against the current fact sheet. Frozen daily reads are immutable by design,
// so a data refresh can never turn an old entry into a publish blocker.
// Keep-previous is safe here; do not add pruning or regeneration.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "health-history.json");
const ANALYTICS_DIR = join(ROOT, "data", "restream", "yt-analytics");
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
const PROMPT_PATH = join(HERE, "health-prompt.md");
const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
const MAX_TOKENS = 16000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

export const HEALTH_STORE_VERSION = 1;
// health-v2 (2026-08-23): context carries per-episode three-week health scores
// instead of the retired "#x of N" ranks; the check math itself is unchanged.
// Saved entries keep the formula stamp they were written under.
export const FORMULA_VERSION = "health-v2";
// prompt v2 (2026-08-23): the headline must agree with the per-check states the
// page renders next to it (critic F3 — one source of truth for check words).
export const PROMPT_VERSION = 2;
export const BASE_WEIGHTS = Object.freeze({
  growth: 0.25,
  audienceQuality: 0.20,
  reachEfficiency: 0.15,
  livePull: 0.15,
  conversion: 0.10,
  sentiment: 0.15,
});

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

function measurement(id, value, typical, sample, reason = null) {
  return {
    id,
    value: Number.isFinite(value) ? round1(value) : null,
    typical: Number.isFinite(typical) ? round1(typical) : null,
    sample,
    score: relativeScore(value, typical),
    reason,
  };
}

function finishSubScore(key, measures, reason) {
  const scores = Object.values(measures).map((measure) => measure.score).filter(Number.isFinite);
  return {
    score: scores.length ? Math.round(mean(scores)) : null,
    baseWeight: BASE_WEIGHTS[key],
    effectiveWeight: 0,
    measures,
    reason,
  };
}

export function deterministicMean(subScores) {
  const availableWeight = Object.values(subScores).reduce(
    (sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0),
    0,
  );
  const weightedMean = availableWeight > 0
    ? round1(Object.values(subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.score * part.baseWeight / availableWeight : 0), 0))
    : null;
  return { weightedMean, availableWeight: round1(availableWeight) };
}

function newestSourceTime(episodes, analyticsBySlug, classified) {
  const times = episodes.map((episode) => episode.latest?.ts).filter(Boolean);
  for (const analytics of analyticsBySlug.values()) if (analytics?.updatedAt) times.push(analytics.updatedAt);
  if (classified?.updatedAt) times.push(classified.updatedAt);
  return times.sort().at(-1) || null;
}

export function computeHealthInputs({ data = null, now = null, root = ROOT } = {}) {
  const source = data || readJson(join(root, "data.json"));
  if (!source?.episodes?.length) throw new Error("data.json has no episodes");
  const sourceNow = now ?? Date.parse(source.generatedAt);
  if (!Number.isFinite(sourceNow)) throw new Error("health source time is invalid");
  const episodes = [...source.episodes].sort((a, b) => a.premiere.localeCompare(b.premiere));
  const newest = episodes.at(-1);
  const analyticsBySlug = new Map();
  for (const episode of episodes) {
    const path = join(root, "data", "restream", "yt-analytics", `${episode.slug}.json`);
    const analytics = readJson(path);
    if (analytics) analyticsBySlug.set(episode.slug, analytics);
  }
  const classified = readJson(join(root, "data", "restream", "comments-classified.json"));
  const facts = [];
  const addFact = (id, value, suffix, text, sources, requiredPhrase = null) => {
    if (!Number.isFinite(value)) return;
    const display = displayNumber(value, suffix);
    facts.push({ id, value: round1(value), display, text: text(display), sources, ...(requiredPhrase ? { requiredPhrase } : {}) });
  };

  // Growth: clean first weeks plus same-age YouTube pace.
  const cleanWeeks = (source.showTrend?.week1VelocityByEpisode || []).filter((row) => Number.isFinite(row.value));
  addFact(
    "clean-first-weeks",
    cleanWeeks.length,
    "",
    (display) => `Only ${display} episodes have clean first-week records.`,
    ["data.json#showTrend.week1VelocityByEpisode"],
  );
  let week1Measure;
  if (cleanWeeks.length >= 3) {
    const recent = cleanWeeks.slice(-5);
    const xs = recent.map((_, index) => index);
    const ys = recent.map((row) => Math.log(row.value));
    const xMean = mean(xs);
    const yMean = mean(ys);
    const slope = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) /
      xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
    const changeEachEpisode = Math.exp(slope);
    const latest = recent.at(-1);
    week1Measure = measurement("firstWeek", changeEachEpisode, 1, recent.length);
    addFact("latest-clean-first-week", latest.value, "", (display) => `The latest clean first week reached ${display} YouTube views.`, ["data.json#showTrend.week1VelocityByEpisode"]);
  } else {
    week1Measure = measurement("firstWeek", null, null, cleanWeeks.length, `Only ${cleanWeeks.length} clean first weeks exist; at least three are required.`);
  }

  const targetAge = observedAgeMs(newest);
  const sameAgePeers = [];
  for (const episode of episodes.slice(0, -1)) {
    const premiere = premiereMs(episode.premiere);
    const first = episode.snapshots?.[0] ? Date.parse(episode.snapshots[0].ts) - premiere : Infinity;
    const last = episode.snapshots?.at(-1) ? Date.parse(episode.snapshots.at(-1).ts) - premiere : -Infinity;
    if (first > targetAge || last < targetAge) continue;
    const snapshot = lastAtOrBefore(episode.snapshots, premiere + targetAge);
    if (snapshot) sameAgePeers.push(youtubeViews(snapshot));
  }
  let sameAgeMeasure;
  if (sameAgePeers.length >= 3) {
    const typical = trueMedian(sameAgePeers);
    sameAgeMeasure = measurement("sameAge", newest.latest.ytTotal, typical, sameAgePeers.length + 1);
    addFact("latest-same-age-youtube", newest.latest.ytTotal, "", (display) => `The latest episode has ${display} YouTube views at this age.`, [`data.json#episodes.${newest.slug}.latest.ytTotal`]);
  } else {
    sameAgeMeasure = measurement("sameAge", null, null, sameAgePeers.length + 1, `Only ${sameAgePeers.length} prior episodes were tracked this early; at least three are required.`);
  }
  const growthReasons = [week1Measure.reason, sameAgeMeasure.reason].filter(Boolean).join(" ");
  const subScores = {
    growth: finishSubScore("growth", { firstWeek: week1Measure, sameAge: sameAgeMeasure }, growthReasons || null),
  };

  // Audience quality: latest engagement and weighted YouTube watch percentage.
  const priorEngagement = episodes.slice(0, -1).filter((episode) => !episode.metrics?.anomaly).map((episode) => episode.metrics?.engagementPer1k).filter(Number.isFinite);
  const latestEngagement = newest.metrics?.engagementPer1k;
  const engagementMeasure = priorEngagement.length >= 3 && Number.isFinite(latestEngagement)
    ? measurement("engagement", latestEngagement, trueMedian(priorEngagement), priorEngagement.length + 1)
    : measurement("engagement", null, null, priorEngagement.length + (Number.isFinite(latestEngagement) ? 1 : 0), "Fewer than three prior engagement results are available.");
  if (engagementMeasure.score != null) {
    addFact("latest-engagement", latestEngagement, "", (display) => `The latest episode drew ${display} engagements for each thousand YouTube views.`, [`data.json#episodes.${newest.slug}.metrics.engagementPer1k`], observedAgeMs(newest) < 7 * DAY ? "still early" : null);
    addFact("typical-engagement", engagementMeasure.typical, "", (display) => `Prior episodes typically drew ${display} engagements for each thousand YouTube views.`, ["data.json#episodes.metrics.engagementPer1k"]);
  }
  const retentionBySlug = new Map(episodes.map((episode) => [episode.slug, weightedRetention(analyticsBySlug.get(episode.slug))]));
  const latestRetention = retentionBySlug.get(newest.slug);
  const priorRetention = episodes.slice(0, -1).filter((episode) => !episode.metrics?.anomaly).map((episode) => retentionBySlug.get(episode.slug)).filter(Number.isFinite);
  const retentionMeasure = priorRetention.length >= 3 && Number.isFinite(latestRetention)
    ? measurement("watching", latestRetention, trueMedian(priorRetention), priorRetention.length + 1)
    : measurement("watching", null, null, priorRetention.length + (Number.isFinite(latestRetention) ? 1 : 0), "Fewer than three prior watch results are available.");
  if (retentionMeasure.score != null) {
    addFact("latest-watch-percent", latestRetention, "%", (display) => `Viewers watched ${display} of the latest YouTube episode on average.`, [repoPath(join(ANALYTICS_DIR, `${newest.slug}.json`))], observedAgeMs(newest) < 7 * DAY ? "still early" : null);
    addFact("typical-watch-percent", retentionMeasure.typical, "%", (display) => `Prior episodes typically held viewers for ${display} of their YouTube run time.`, ["data/restream/yt-analytics/*.json"]);
    // per-channel splits (owner directive 2026-08-23): the blend never hides
    // which channel a number came from — the model may call out the gap
    for (const [channelKey, channelName] of [["yt:joindiveclub", "Dive Club"], ["yt:designertom", "DesignerTom"]]) {
      const totals = analyticsBySlug.get(newest.slug)?.channels?.[channelKey]?.totals;
      if (totals && Number.isFinite(totals.averageViewPercentage) && totals.views > 0) {
        addFact(`latest-watch-percent-${channelKey.slice(3)}`, totals.averageViewPercentage, "%", (display) => `Viewers watched ${display} of the latest episode on ${channelName} on average.`, [repoPath(join(ANALYTICS_DIR, `${newest.slug}.json`))], observedAgeMs(newest) < 7 * DAY ? "still early" : null);
      }
    }
  }
  const audienceAgeReason = observedAgeMs(newest) < 7 * DAY ? "The latest episode is still under a week old, so these checks may move." : null;
  subScores.audienceQuality = finishSubScore(
    "audienceQuality",
    { engagement: engagementMeasure, watching: retentionMeasure },
    [engagementMeasure.reason, retentionMeasure.reason, audienceAgeReason].filter(Boolean).join(" ") || null,
  );

  // Reach efficiency: last mature clean episode vs at least three prior ones.
  const reachEligible = episodes.filter((episode) => (
    observedAgeMs(episode) >= 7 * DAY &&
    !episode.metrics?.anomaly &&
    Number.isFinite(episode.latest?.xPlays) &&
    episode.latest.xPlaysInfo?.partial === false &&
    episode.latest.xPlaysInfo?.stale === false &&
    episode.latest.xImpressions > 0 &&
    episode.latest.totalViews > 0
  ));
  let announceMeasure;
  let xShareMeasure;
  let reachReason = null;
  if (reachEligible.length >= 4) {
    const latestFinished = reachEligible.at(-1);
    const priors = reachEligible.slice(0, -1);
    const announceValue = latestFinished.latest.xPlays / latestFinished.latest.xImpressions * 100;
    const announceTypical = trueMedian(priors.map((episode) => episode.latest.xPlays / episode.latest.xImpressions * 100));
    const shareValue = latestFinished.latest.xPlays / latestFinished.latest.totalViews * 100;
    const shareTypical = trueMedian(priors.map((episode) => episode.latest.xPlays / episode.latest.totalViews * 100));
    announceMeasure = measurement("announceToPlay", announceValue, announceTypical, reachEligible.length);
    xShareMeasure = measurement("xShare", shareValue, shareTypical, reachEligible.length);
    addFact("latest-finished-announce-play", announceValue, "%", (display) => `${display} of the latest finished episode's X announce impressions became plays.`, [`data.json#episodes.${latestFinished.slug}.latest`]);
    addFact("typical-announce-play", announceTypical, "%", (display) => `Prior clean episodes typically turned ${display} of X announce impressions into plays.`, ["data.json#episodes.latest"]);
    addFact("latest-finished-x-share", shareValue, "%", (display) => `X supplied ${display} of watching for the latest finished episode.`, [`data.json#episodes.${latestFinished.slug}.latest`]);
    if (latestFinished.slug !== newest.slug) reachReason = "The newest episode is under a week old, so this check uses the latest finished episode.";
  } else {
    announceMeasure = measurement("announceToPlay", null, null, reachEligible.length, "Fewer than four finished clean episodes have complete X reach and play counts.");
    xShareMeasure = measurement("xShare", null, null, reachEligible.length, "Fewer than four finished clean episodes have complete X reach and play counts.");
    reachReason = announceMeasure.reason;
  }
  subScores.reachEfficiency = finishSubScore("reachEfficiency", { announceToPlay: announceMeasure, xShare: xShareMeasure }, reachReason);

  // Live pull: newest session against prior sessions.
  const priorLive = episodes.slice(0, -1).filter((episode) => Number.isFinite(episode.live?.peak) && Number.isFinite(episode.live?.chatMessages));
  let livePeakMeasure;
  let liveChatMeasure;
  if (Number.isFinite(newest.live?.peak) && Number.isFinite(newest.live?.chatMessages) && priorLive.length >= 3) {
    livePeakMeasure = measurement("peak", newest.live.peak, trueMedian(priorLive.map((episode) => episode.live.peak)), priorLive.length + 1);
    liveChatMeasure = measurement("chat", newest.live.chatMessages, trueMedian(priorLive.map((episode) => episode.live.chatMessages)), priorLive.length + 1);
    addFact("latest-live-peak", newest.live.peak, "", (display) => `The latest show peaked at ${display} live viewers.`, [`data.json#episodes.${newest.slug}.live.peak`]);
    addFact("typical-live-peak", livePeakMeasure.typical, "", (display) => `Prior shows typically peaked at ${display} live viewers.`, ["data.json#episodes.live.peak"]);
    addFact("latest-live-chat", newest.live.chatMessages, "", (display) => `The latest show drew ${display} chat messages.`, [`data.json#episodes.${newest.slug}.live.chatMessages`]);
    addFact("typical-live-chat", liveChatMeasure.typical, "", (display) => `Prior shows typically drew ${display} chat messages.`, ["data.json#episodes.live.chatMessages"]);
  } else {
    const reason = "Fewer than three prior live sessions are available.";
    livePeakMeasure = measurement("peak", null, null, priorLive.length + 1, reason);
    liveChatMeasure = measurement("chat", null, null, priorLive.length + 1, reason);
  }
  subScores.livePull = finishSubScore("livePull", { peak: livePeakMeasure, chat: liveChatMeasure }, livePeakMeasure.reason || liveChatMeasure.reason || null);

  // Subscriber conversion: both YouTube channels, normalized by their views so
  // differently aged episodes remain comparable without inventing history.
  const analyticsViews = (analytics) => {
    const required = ["yt:designertom", "yt:joindiveclub"];
    if (!analytics?.channels || required.some((key) => !Number.isFinite(analytics.channels[key]?.totals?.views))) return null;
    return required.reduce((sum, key) => sum + analytics.channels[key].totals.views, 0);
  };
  const subscriberRate = (analytics) => {
    const subscribers = subscriberTotal(analytics);
    const views = analyticsViews(analytics);
    return Number.isFinite(subscribers) && Number.isFinite(views) && views > 0 ? subscribers / views * 1000 : null;
  };
  const conversionEligible = episodes.filter((episode) => !episode.metrics?.anomaly && Number.isFinite(subscriberRate(analyticsBySlug.get(episode.slug))));
  let conversionMeasure;
  let conversionReason = null;
  if (conversionEligible.length >= 4) {
    const latestFinished = conversionEligible.at(-1);
    const value = subscriberRate(analyticsBySlug.get(latestFinished.slug));
    const typical = trueMedian(conversionEligible.slice(0, -1).map((episode) => subscriberRate(analyticsBySlug.get(episode.slug))));
    conversionMeasure = measurement("subscribers", value, typical, conversionEligible.length);
    addFact("latest-subscriber-rate", value, "", (display) => `The latest episode added ${display} subscribers for each thousand YouTube views.`, [repoPath(join(ANALYTICS_DIR, `${latestFinished.slug}.json`))], observedAgeMs(latestFinished) < 7 * DAY ? "still early" : null);
    addFact("typical-subscriber-rate", typical, "", (display) => `Prior clean episodes typically added ${display} subscribers for each thousand YouTube views.`, ["data/restream/yt-analytics/*.json"]);
    for (const [channelKey, channelName] of [["yt:joindiveclub", "Dive Club"], ["yt:designertom", "DesignerTom"]]) {
      const totals = analyticsBySlug.get(latestFinished.slug)?.channels?.[channelKey]?.totals;
      if (totals && Number.isFinite(totals.subscribersGained) && totals.views > 0) {
        addFact(`latest-subscriber-rate-${channelKey.slice(3)}`, totals.subscribersGained / totals.views * 1000, "", (display) => `${channelName} added ${display} subscribers for each thousand of its YouTube views on the latest comparable episode.`, [repoPath(join(ANALYTICS_DIR, `${latestFinished.slug}.json`))], observedAgeMs(latestFinished) < 7 * DAY ? "still early" : null);
      }
    }
    if (observedAgeMs(latestFinished) < 7 * DAY) conversionReason = "The latest episode is still under a week old, so this check may move.";
  } else {
    conversionMeasure = measurement("subscribers", null, null, conversionEligible.length, "Fewer than four clean episodes have subscriber results from both YouTube channels.");
    conversionReason = conversionMeasure.reason;
  }
  subScores.conversion = finishSubScore("conversion", { subscribers: conversionMeasure }, conversionReason);

  // W8 sentiment: recent directional reactions; rate waits for comparable replies.
  const summary = source.commentSummary || {};
  const recentFeedback = episodes.slice(-3).flatMap((episode) => episode.comments?.list || []);
  const recentPositive = recentFeedback.filter((row) => row.sentiment === "positive").length;
  const recentNegative = recentFeedback.filter((row) => row.sentiment === "negative").length;
  const recentMixed = recentFeedback.filter((row) => row.sentiment === "mixed").length;
  const recentDirectional = recentPositive + recentNegative + recentMixed;
  const recentPeople = new Set(recentFeedback.map((row) => `${row.source}:${String(row.author || "viewer").trim().toLowerCase()}`)).size;
  const balanceValue = recentDirectional > 0 ? (recentPositive + recentMixed * 0.5) / recentDirectional * 100 : null;
  const balanceMeasure = recentDirectional >= 3 && recentPeople >= 3 && Number.isFinite(balanceValue)
    ? { id: "balance", value: round1(balanceValue), typical: null, sample: recentPeople, score: Math.round(clamp(balanceValue)), reason: null }
    : { id: "balance", value: null, typical: null, sample: recentPeople, score: null, reason: "Fewer than three people have recent directional feedback." };
  if (balanceMeasure.score != null) {
    addFact("recent-positive-feedback", recentPositive, "", (display) => `${display} recent comments were clearly positive.`, ["data.json#episodes[-3:].comments.list"], "X replies are missing");
    addFact("recent-mixed-feedback", recentMixed, "", (display) => `${display} recent comments mixed praise with a concern.`, ["data.json#episodes[-3:].comments.list"], "X replies are missing");
    addFact("recent-feedback-people", recentPeople, "", (display) => `${display} people left recent directional feedback.`, ["data.json#episodes[-3:].comments.list"], "X replies are missing");
  }
  const completeRates = episodes.filter((episode) => Number.isFinite(episode.comments?.commentersPer1k));
  let commentRateMeasure;
  if (completeRates.length >= 4) {
    const latestRate = completeRates.at(-1);
    const typical = trueMedian(completeRates.slice(0, -1).map((episode) => episode.comments.commentersPer1k));
    commentRateMeasure = measurement("commentRate", latestRate.comments.commentersPer1k, typical, completeRates.length);
    addFact("latest-comment-rate", latestRate.comments.commentersPer1k, "", (display) => `The latest comparable episode drew ${display} commenters for each thousand watches.`, [`data.json#episodes.${latestRate.slug}.comments.commentersPer1k`]);
  } else {
    commentRateMeasure = measurement("commentRate", null, null, completeRates.length, `Only ${completeRates.length} episode has complete replies and watch counts; at least four are required.`);
    const latestRate = completeRates.at(-1);
    if (latestRate) addFact("latest-comment-rate", latestRate.comments.commentersPer1k, "", (display) => `The latest episode drew ${display} commenters for each thousand watches.`, [`data.json#episodes.${latestRate.slug}.comments.commentersPer1k`], "only one episode");
  }
  subScores.sentiment = finishSubScore(
    "sentiment",
    { balance: balanceMeasure, commentRate: commentRateMeasure },
    [balanceMeasure.reason, commentRateMeasure.reason].filter(Boolean).join(" ") || null,
  );

  // Missing checks relinquish their weight; no missing check becomes zero.
  const availableWeight = Object.values(subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
  for (const part of Object.values(subScores)) {
    part.effectiveWeight = Number.isFinite(part.score) && availableWeight > 0 ? Math.round(part.baseWeight / availableWeight * 10000) / 10000 : 0;
  }
  const { weightedMean, availableWeight: availableBaseWeight } = deterministicMean(subScores);

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
        averageWatched: Number.isFinite(retentionBySlug.get(episode.slug)) ? round1(retentionBySlug.get(episode.slug)) : null,
        channels: Object.fromEntries(Object.entries(analytics?.channels || {}).map(([key, channel]) => [key, {
          curve: compactCurve(channel.retention),
          topTraffic: [...(channel.trafficSources || [])].sort((a, b) => b.views - a.views).slice(0, 3),
        }])),
      };
    }),
    comments: {
      show: summary,
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
    availableChecks: Object.values(subScores).filter((part) => Number.isFinite(part.score)).length,
    availableBaseWeight,
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
  return value;
}

// Public projection used by build-data.mjs. It contains only saved model copy,
// its citation IDs, the saved per-check results, and real history points. No
// score or trend is recomputed in the browser, and gaps in history remain gaps.
export const CHECK_ORDER = Object.freeze(["growth", "audienceQuality", "reachEfficiency", "livePull", "conversion", "sentiment"]);
export function projectHealth(store, { now = Date.now() } = {}) {
  if (!store) return null;
  if (store.version !== HEALTH_STORE_VERSION || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
  const cutoff = phoenixDate(now);
  const entries = store.entries.filter((entry) => entry.date <= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) return null;
  const latest = entries.at(-1);
  if (!Number.isFinite(latest.score) || typeof latest.headline !== "string" || !Array.isArray(latest.pros) || !Array.isArray(latest.cons)) {
    throw new Error("latest health entry is incomplete");
  }
  // The page needs to say when today's score is still an early read, but it
  // must not guess that state from model-written prose. The health entry
  // already records unavailable checks and facts that explicitly require an
  // early-data warning, so project that state as a deterministic field.
  const hasUnavailableCheck = Object.values(latest.subScores || {}).some((section) =>
    section?.score == null || Object.values(section?.measures || {}).some((measure) => measure?.score == null));
  const hasEarlyFact = (latest.facts || []).some((fact) => fact?.requiredPhrase === "still early");
  return {
    date: latest.date,
    dataThrough: latest.dataThrough || null,
    score: latest.score,
    readState: hasUnavailableCheck || hasEarlyFact ? "early" : "settled",
    headline: latest.headline,
    // The saved per-check results, projected verbatim so the page can show the
    // whole diagnosis without ever recomputing: a score where one exists, the
    // saved reason where one does not.
    checks: CHECK_ORDER.map((key) => ({
      key,
      score: Number.isFinite(latest.subScores?.[key]?.score) ? latest.subScores[key].score : null,
      reason: latest.subScores?.[key]?.reason ?? null,
      // the saved measures behind the check, projected so the diagnosis rows
      // can offer hover drill-in (value vs typical) without ever recomputing
      measures: Object.entries(latest.subScores?.[key]?.measures || {}).map(([measureKey, measure]) => ({
        key: measureKey,
        value: measure?.value ?? null,
        typical: measure?.typical ?? null,
        sample: measure?.sample ?? null,
        reason: measure?.reason ?? null,
      })),
    })),
    pros: latest.pros.map((bullet) => ({ text: bullet.text, factId: bullet.factId })),
    cons: latest.cons.map((bullet) => ({ text: bullet.text, factId: bullet.factId })),
    trend: entries.length >= 7 ? { points: entries.map((entry) => ({ date: entry.date, score: entry.score })) } : null,
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
  if (store.version !== HEALTH_STORE_VERSION || !Array.isArray(store.entries)) throw new Error("health-history.json has an unsupported schema");
  const dates = store.entries.map((entry) => entry.date);
  if (new Set(dates).size !== dates.length) throw new Error("health-history.json contains more than one entry for a day");
  return store;
}

async function main() {
  const data = readJson(DATA_PATH);
  if (!data) throw new Error("data.json is missing");
  const sourceNow = Date.parse(data.generatedAt);
  const inputs = computeHealthInputs({ data, now: sourceNow });
  if (process.argv.includes("--dry")) {
    console.log(JSON.stringify({ weightedMean: inputs.weightedMean, allowedScore: inputs.allowedScore, availableChecks: inputs.availableChecks, subScores: inputs.subScores, facts: inputs.facts }, null, 2));
    return;
  }
  if (!Number.isFinite(inputs.weightedMean) || inputs.availableChecks < 3 || inputs.availableBaseWeight < 0.5) {
    console.log(`WARN health: only ${inputs.availableChecks} usable checks with ${inputs.availableBaseWeight} of the planned weight; previous saved score kept`);
    return;
  }
  if (process.argv.includes("--probe-model")) {
    const result = await synthesize(inputs);
    console.log(`health probe: ${result.provider}/${result.model} returned valid grounded JSON with score ${result.synthesis.score}`);
    return;
  }

  const store = loadStore();
  const date = phoenixDate(sourceNow);
  if (store.entries.some((entry) => entry.date === date)) {
    console.log(`health: ${date} already saved — append-only store unchanged`);
    return;
  }
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  const promptHash = sha(prompt);
  const previous = store.entries.at(-1);
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
