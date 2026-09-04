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

  const dated = shows
    .filter((show) => typeof show?.date === "string" && typeof show?.slug === "string")
    .sort((a, b) => b.date.localeCompare(a.date));
  const newestDate = dated[0]?.date;
  if (!newestDate) return 1;
  const newestSlugs = new Set(dated.filter((show) => show.date === newestDate).map((show) => show.slug));
  if (missingTotals.some((item) => !newestSlugs.has(item?.slug))) return 1;

  const today = phoenixDate(now);
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

export function youtubeWatchReport({ checkedAt, missingChannels = [], failedChannels = [] } = {}) {
  const failed = [...new Set(failedChannels)];
  const missing = [...new Set([...missingChannels, ...failed])];
  return {
    state: failed.length ? "failed" : missing.length ? "pending" : "ready",
    checkedAt,
    missingChannels: missing,
    reason: failed.length
      ? "YouTube Analytics could not return every watch report"
      : missing.length
        ? "YouTube Analytics has not returned this episode's watch data yet"
        : null,
  };
}

export function usableYoutubeWatchTotals(totals) {
  return Number.isFinite(totals?.views)
    && totals.views > 0
    && Number.isFinite(totals.averageViewPercentage);
}

// Return exactly the registered channels only when every one has a usable
// watch report. A view count without the watched-share field is still an
// incomplete report and must never collapse into a one-channel blend.
export function completeYoutubeWatchChannels(expectedChannels = [], channels = {}) {
  if (!expectedChannels.length) return [];
  if (expectedChannels.some((key) => !usableYoutubeWatchTotals(channels?.[key]?.totals))) return [];
  return expectedChannels.map((key) => [key, channels[key]]);
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

export function youtubeChannelAfterPull({ previous = null, videoId, pulledAt, totals, trafficSources, retention } = {}) {
  if (!usableYoutubeWatchTotals(totals)
    && usableYoutubeWatchTotals(previous?.totals)
    && previous.videoId === videoId) return previous;
  return { videoId, pulledAt, totals: totals ?? null, trafficSources, retention };
}
