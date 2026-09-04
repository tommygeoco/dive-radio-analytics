#!/usr/bin/env node
// An HTTP 200 with no Analytics rows for the newest aired episode is pending
// data, even when YouTube takes more than a day. It may keep the noon
// whole-chain attempt, but it must never become zero or hide another failure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeYoutubeWatchChannels,
  isYoutubeWatchPendingStatus,
  missingYoutubeAccounts,
  usableYoutubeWatchTotals,
  summedYoutubeMetric,
  weightedYoutubeMetric,
  YOUTUBE_WATCH_PENDING_EXIT,
  YOUTUBE_WATCH_PENDING_STATUS,
  youtubeChannelAfterPull,
  youtubePullExitCode,
  youtubeWatchReport,
} from "../youtube-readiness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const shows = [
  { slug: "older", date: "2026-08-27" },
  { slug: "newest", date: "2026-09-03" },
];
const newestMissing = [
  { slug: "newest", channel: "yt:joindiveclub" },
  { slug: "newest", channel: "yt:designertom" },
];
const morningAfter = Date.parse("2026-09-04T15:15:00Z"); // 08:15 Phoenix

assert.equal(youtubePullExitCode({ shows, missingTotals: [], now: morningAfter }), 0);
assert.equal(
  youtubePullExitCode({ shows, missingTotals: newestMissing, now: morningAfter }),
  YOUTUBE_WATCH_PENDING_EXIT,
  "no rows for only the newest episode on the next Phoenix date are pending, not zero or a hard failure",
);
assert.equal(
  youtubePullExitCode({ shows, missingTotals: newestMissing, now: Date.parse("2026-09-03T15:15:00Z") }),
  0,
  "a scheduled or not-yet-processed report on air day does not fail the daily build",
);
assert.equal(
  youtubePullExitCode({ shows, missingTotals: [{ slug: "older", channel: "yt:designertom" }], now: morningAfter }),
  1,
  "a missing older report is not the short first-day delay",
);
assert.equal(
  youtubePullExitCode({ shows, missingTotals: newestMissing, hardFailures: 1, now: morningAfter }),
  1,
  "an API or auth error cannot be relabeled as normal report delay",
);
assert.equal(
  youtubePullExitCode({ shows, missingTotals: newestMissing, now: Date.parse("2026-09-05T15:15:00Z") }),
  YOUTUBE_WATCH_PENDING_EXIT,
  "the newest report stays pending for as many daily checks as YouTube needs",
);
assert.equal(isYoutubeWatchPendingStatus(YOUTUBE_WATCH_PENDING_STATUS), true);
assert.equal(isYoutubeWatchPendingStatus("failed:20"), false);
assert.deepEqual(missingYoutubeAccounts([{ targets: [
  { kind: "youtube", account: "joindiveclub", videoId: "one" },
  { kind: "youtube", account: "designertom", videoId: "two" },
] }], { designertom: "token" }), ["joindiveclub"], "a missing owner token cannot silently produce a one-channel report");
assert.deepEqual(missingYoutubeAccounts(shows, { designertom: "token" }), [], "shows without registered YouTube targets do not invent required accounts");

assert.deepEqual(youtubeWatchReport({
  checkedAt: "2026-09-04T15:15:00.000Z",
  missingChannels: ["yt:joindiveclub", "yt:designertom"],
}), {
  state: "pending",
  checkedAt: "2026-09-04T15:15:00.000Z",
  missingChannels: ["yt:joindiveclub", "yt:designertom"],
  reason: "YouTube Analytics has not returned this episode's watch data yet",
});
assert.equal(youtubeWatchReport({ checkedAt: "now" }).state, "ready");
assert.equal(youtubeWatchReport({ checkedAt: "now", failedChannels: ["yt:joindiveclub"] }).state, "failed");
assert.equal(usableYoutubeWatchTotals({ views: 0, averageViewPercentage: 0 }), false, "an explicit startup zero is not a share-watched reading");
assert.equal(usableYoutubeWatchTotals({ views: 12, averageViewPercentage: null }), false, "views without the watched share are still pending");
assert.equal(usableYoutubeWatchTotals({ views: 12, averageViewPercentage: 9.5 }), true);
const partialChannels = {
  "yt:joindiveclub": { totals: { views: 12, averageViewPercentage: 9.5 } },
  "yt:designertom": { totals: { views: 8, averageViewPercentage: null } },
  "yt:unregistered": { totals: { views: 99, averageViewPercentage: 99 } },
};
assert.deepEqual(
  completeYoutubeWatchChannels(["yt:joindiveclub", "yt:designertom"], partialChannels),
  [],
  "one missing watched-share field withholds the whole episode instead of producing a one-channel blend",
);
partialChannels["yt:designertom"].totals.averageViewPercentage = 7.25;
const fullEntries = completeYoutubeWatchChannels(["yt:joindiveclub", "yt:designertom"], partialChannels);
fullEntries[0][1].totals.averageViewDuration = 600;
fullEntries[1][1].totals.averageViewDuration = null;
fullEntries[0][1].totals.estimatedMinutesWatched = 120;
fullEntries[1][1].totals.estimatedMinutesWatched = null;
assert.equal(weightedYoutubeMetric(fullEntries, "averageViewDuration"), null, "one missing duration cannot produce a partial average");
assert.equal(summedYoutubeMetric(fullEntries, "estimatedMinutesWatched"), null, "one missing watch-time total cannot be added as zero");
fullEntries[1][1].totals.averageViewDuration = 300;
fullEntries[1][1].totals.estimatedMinutesWatched = 80;
assert.equal(weightedYoutubeMetric(fullEntries, "averageViewDuration"), 480, "complete durations use both channels' view weights");
assert.equal(summedYoutubeMetric(fullEntries, "estimatedMinutesWatched"), 200, "complete watch time adds both exact channel totals");
assert.deepEqual(
  completeYoutubeWatchChannels(["yt:joindiveclub", "yt:designertom"], partialChannels).map(([key]) => key),
  ["yt:joindiveclub", "yt:designertom"],
  "a complete report uses exactly the registered channels and ignores stale extras",
);

const savedChannel = {
  videoId: "video",
  pulledAt: "2026-09-04T15:00:00.000Z",
  totals: { views: 41, averageViewPercentage: 12.5 },
  trafficSources: [{ insightTrafficSourceType: "RELATED_VIDEO", views: 8 }],
  retention: [{ elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.3 }],
};
const afterEmpty = youtubeChannelAfterPull({
  previous: savedChannel,
  videoId: "video",
  pulledAt: "2026-09-05T15:00:00.000Z",
  totals: null,
  trafficSources: [],
  retention: [],
});
assert.equal(afterEmpty, savedChannel, "a later empty response preserves the exact saved report and its original timestamp");
assert.equal(youtubeChannelAfterPull({
  previous: savedChannel,
  videoId: "video",
  pulledAt: "2026-09-05T15:00:00.000Z",
  totals: { views: 0, averageViewPercentage: 0 },
  trafficSources: [],
  retention: [],
}), savedChannel, "a startup-zero restatement cannot erase a prior exact report");
assert.deepEqual(youtubeChannelAfterPull({
  previous: savedChannel,
  videoId: "replacement-video",
  pulledAt: "2026-09-05T15:00:00.000Z",
  totals: null,
  trafficSources: [],
  retention: [],
}), {
  videoId: "replacement-video",
  pulledAt: "2026-09-05T15:00:00.000Z",
  totals: null,
  trafficSources: [],
  retention: [],
}, "an empty replacement video cannot inherit the old video's exact report");
assert.deepEqual(youtubeChannelAfterPull({
  videoId: "new-video",
  pulledAt: "2026-09-04T15:00:00.000Z",
  totals: null,
  trafficSources: [],
  retention: null,
}), {
  videoId: "new-video",
  pulledAt: "2026-09-04T15:00:00.000Z",
  totals: null,
  trafficSources: [],
  retention: null,
}, "a first empty response stays explicit null");

const pullSource = readFileSync(join(HERE, "..", "..", "..", "scripts", "restream", "yt-analytics-pull.mjs"), "utf8");
assert.match(pullSource, /store\.watchReport\s*=\s*youtubeWatchReport\(\{/);
assert.match(pullSource, /if \(exitCode === YOUTUBE_WATCH_PENDING_EXIT\)/);
assert.match(pullSource, /store\.channels\[key\]\s*=\s*youtubeChannelAfterPull\(\{/);
assert.match(pullSource, /missingAccounts = missingYoutubeAccounts\(shows, tokens\)/);
assert.match(pullSource, /!usableYoutubeWatchTotals\(totals\)/);

const buildSource = readFileSync(join(HERE, "..", "build-data.mjs"), "utf8");
assert.match(buildSource, /completeYoutubeWatchChannels\(expectedChannels, j\.channels \|\| \{\}\)/);

const chainSource = readFileSync(join(HERE, "..", "run-chain.mjs"), "utf8");
assert.match(chainSource, /step\.step === "yt-analytics" && code === YOUTUBE_WATCH_PENDING_EXIT/);
assert.match(chainSource, /continuing so the morning production build stays current/);
assert.match(chainSource, /if \(youtubeWatchPending\)[\s\S]*process\.exit\(YOUTUBE_WATCH_PENDING_EXIT\)/);

console.log("youtube-readiness.test: newest no-row reports stay pending, saved totals survive, publish continues, and other failures stay failures");
