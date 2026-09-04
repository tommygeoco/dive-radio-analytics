// youtube-readiness.mjs — shared contract for the one expected delay after a
// new episode airs. YouTube Analytics can return HTTP 200 with no rows on the
// dates after air even while public view counts are already available.
// That is pending data, not zero and not a reason to withhold the morning
// production build. The daily state keeps the second whole-chain attempt for
// noon; every other nonzero exit keeps its normal failure behavior.

const DAY_MS = 86400000;
const PHX_OFFSET_MS = 7 * 3600000;

export const YOUTUBE_WATCH_PENDING_EXIT = 20;
export const YOUTUBE_WATCH_PENDING_STATUS = "waiting:newest-youtube-watch";

function phoenixDate(now) {
  const ms = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - PHX_OFFSET_MS).toISOString().slice(0, 10);
}

function dayDistance(from, to) {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY_MS) : null;
}

// Pure decision used by the live pull and its focused regression test.
// `missingTotals` contains only successful Analytics responses with no row;
// request/auth errors are counted separately in `hardFailures`.
export function youtubePullExitCode({ shows = [], missingTotals = [], hardFailures = 0, now = Date.now() } = {}) {
  if (hardFailures > 0) return 1;
  if (!missingTotals.length) return 0;

  const today = phoenixDate(now);
  if (!today) return 1;
  const dated = shows
    .filter((show) => typeof show?.date === "string" && typeof show?.slug === "string")
    .sort((a, b) => b.date.localeCompare(a.date));
  const bySlug = new Map(dated.map((show) => [show.slug, show]));
  if (missingTotals.some((item) => !bySlug.has(item?.slug))) return 1;

  // A preregistered future episode is idle. It must not turn a still-waiting
  // aired episode into an "older report" failure or create a recovery need.
  const actionable = missingTotals.filter((item) => bySlug.get(item.slug).date <= today);
  if (!actionable.length) return 0;
  const aired = dated.filter((show) => show.date <= today);
  const newestDate = aired[0]?.date;
  if (!newestDate) return 0;
  const newestSlugs = new Set(aired.filter((show) => show.date === newestDate).map((show) => show.slug));
  if (actionable.some((item) => !newestSlugs.has(item?.slug))) return 1;

  const daysAfterAir = today ? dayDistance(newestDate, today) : null;
  if (daysAfterAir == null) return 1;
  if (daysAfterAir <= 0) return 0;
  // Analytics often takes longer than one full date to publish a new video's
  // first report. Keep the newest episode pending for as many daily checks as
  // the source needs; an older episode returning no row is handled above as a
  // real loss of data.
  return YOUTUBE_WATCH_PENDING_EXIT;
}

export function isYoutubeWatchPendingStatus(status) {
  return status === YOUTUBE_WATCH_PENDING_STATUS;
}

export function missingYoutubeAccounts(shows = [], tokens = {}) {
  const expected = new Set(shows.flatMap((show) => (show.targets || [])
    .filter((target) => target.kind === "youtube" && target.videoId)
    .map((target) => target.account)));
  return [...expected].filter((account) => !tokens[account]).sort();
}

export function youtubeWatchReport({
  checkedAt,
  airDate = null,
  probes = [],
  previous = null,
  previousTargetFingerprint = null,
} = {}) {
  const targetFingerprint = youtubeTargetFingerprint(probes);
  const failed = probes.filter((probe) => probe?.result === "request-failed").map((probe) => probe.key);
  const missing = probes.filter((probe) => probe?.result !== "ready").map((probe) => probe.key);
  const checkedDate = phoenixDate(checkedAt);
  const idle = missing.length && !failed.length && typeof airDate === "string"
    && checkedDate && checkedDate <= airDate;
  const state = failed.length ? "failed" : missing.length ? (idle ? "idle" : "pending") : "ready";
  const report = {
    state,
    checkedAt,
    missingChannels: missing,
    reason: failed.length
      ? "YouTube Analytics could not return every watch report"
      : idle
        ? "YouTube watch data is not due until after this episode's air date"
      : missing.length
        ? "YouTube Analytics has not returned this episode's watch data yet"
        : null,
  };
  report.targetFingerprint = targetFingerprint;
  report.probes = probes.map((probe) => ({
    key: probe.key,
    videoId: probe.videoId,
    result: probe.result,
    observed: probe.observed ?? null,
  }));
  if (state === "pending") {
    const sameTargets = previous?.state === "pending"
      && (previous?.targetFingerprint || previousTargetFingerprint) === targetFingerprint;
    report.pendingSince = sameTargets
      ? previous.pendingSince || previous.checkedAt || checkedAt
      : checkedAt;
  }
  return report;
}

export function usableYoutubeWatchTotals(totals) {
  return Number.isFinite(totals?.views)
    && totals.views > 0
    && Number.isFinite(totals.averageViewPercentage);
}

// Return exactly the registered channels only when every one has a usable
// watch report. A view count without the watched-share field is still an
// incomplete report and must never collapse into a one-channel blend.
function normalizedYoutubeTargets(expectedTargets = []) {
  return expectedTargets.map((target) => typeof target === "string"
    ? { key: target, videoId: null }
    : { key: target?.key, videoId: target?.videoId ?? null });
}

export function youtubeTargetFingerprint(expectedTargets = []) {
  return normalizedYoutubeTargets(expectedTargets)
    .map(({ key, videoId }) => `${key || "?"}:${videoId || "?"}`)
    .sort()
    .join("|");
}

export function youtubeChannelsFingerprint(channels = {}) {
  return youtubeTargetFingerprint(Object.entries(channels || {}).map(([key, channel]) => ({
    key,
    videoId: channel?.videoId ?? null,
  })));
}

export function youtubeWatchProbe({ key, videoId, totals = null, failed = false } = {}) {
  if (failed || (totals && (!Number.isFinite(totals.views) || totals.views < 0))) {
    return { key, videoId, result: "request-failed", observed: null };
  }
  if (!totals) return { key, videoId, result: "no-row", observed: null };
  const observed = {
    views: Number.isFinite(totals.views) ? totals.views : null,
    averageViewPercentage: Number.isFinite(totals.averageViewPercentage) ? totals.averageViewPercentage : null,
  };
  if (totals.views === 0) return { key, videoId, result: "zero-views", observed };
  if (!Number.isFinite(totals.averageViewPercentage)) return { key, videoId, result: "missing-share", observed };
  return { key, videoId, result: "ready", observed };
}

// A watch reading is one episode-level source transaction. Every registered
// channel must be usable, belong to the current video id, and carry one shared
// pull time. `updatedAt`, when supplied, must name that same transaction.
export function completeYoutubeWatchChannels(expectedTargets = [], channels = {}) {
  const targets = normalizedYoutubeTargets(expectedTargets);
  if (!targets.length || targets.some(({ key }) => typeof key !== "string" || !key.startsWith("yt:"))) return [];
  const expectedKeys = new Set(targets.map(({ key }) => key));
  if (expectedKeys.size !== targets.length) return [];
  const storedKeys = Object.keys(channels || {});
  if (storedKeys.length !== expectedKeys.size || storedKeys.some((key) => !expectedKeys.has(key))) return [];
  const entries = targets.map(({ key, videoId }) => [key, channels?.[key], videoId]);
  if (entries.some(([, channel, videoId]) => !usableYoutubeWatchTotals(channel?.totals)
    || (videoId && channel?.videoId !== videoId)
    || !Number.isFinite(Date.parse(channel?.pulledAt)))) return [];
  const pulledAt = new Set(entries.map(([, channel]) => channel.pulledAt));
  if (pulledAt.size !== 1) return [];
  return entries.map(([key, channel]) => [key, channel]);
}

export function completeYoutubeWatchCohort(expectedTargets = [], store = {}) {
  if (!Number.isFinite(Date.parse(store?.updatedAt))) return [];
  const entries = completeYoutubeWatchChannels(expectedTargets, store?.channels || {});
  if (!entries.length || entries.some(([, channel]) => channel.pulledAt !== store.updatedAt)) return [];
  return entries;
}

// Select the only cohort consumers may see after a pull. A complete candidate
// advances as a whole. Otherwise the complete previous current-id cohort stays
// byte-for-byte; with no such cohort, channels stays empty. Incomplete source
// evidence belongs only in watchReport.probes.
export function youtubeCohortAfterPull({
  previousStore = {},
  expectedTargets = [],
  candidateChannels = {},
  checkedAt,
  acceptCandidate = true,
} = {}) {
  const targets = normalizedYoutubeTargets(expectedTargets);
  const candidate = acceptCandidate
    ? completeYoutubeWatchCohort(targets, { channels: candidateChannels, updatedAt: checkedAt })
    : [];
  if (candidate.length === targets.length && targets.length) {
    return { channels: Object.fromEntries(candidate), updatedAt: checkedAt, advanced: true };
  }
  const previous = completeYoutubeWatchCohort(targets, previousStore);
  if (previous.length === targets.length && targets.length) {
    return { channels: previousStore.channels, updatedAt: previousStore.updatedAt, advanced: false };
  }
  return { channels: {}, updatedAt: null, advanced: false };
}

export function weightedYoutubeMetric(channelEntries = [], field) {
  if (!channelEntries.length || channelEntries.some(([, channel]) => !Number.isFinite(channel?.totals?.views)
    || channel.totals.views <= 0
    || !Number.isFinite(channel.totals[field]))) return null;
  const views = channelEntries.reduce((sum, [, channel]) => sum + channel.totals.views, 0);
  return views > 0
    ? channelEntries.reduce((sum, [, channel]) => sum + channel.totals[field] * channel.totals.views, 0) / views
    : null;
}

export function summedYoutubeMetric(channelEntries = [], field) {
  if (!channelEntries.length || channelEntries.some(([, channel]) => !Number.isFinite(channel?.totals?.[field]))) return null;
  return channelEntries.reduce((sum, [, channel]) => sum + channel.totals[field], 0);
}
