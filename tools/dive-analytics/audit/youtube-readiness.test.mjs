#!/usr/bin/env node
// An HTTP 200 with no Analytics rows for the newest aired episode is pending
// data, even when YouTube takes more than a day. It may keep the noon
// whole-chain attempt, but it must never become zero or hide another failure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeYoutubeWatchCohort,
  completeYoutubeWatchChannels,
  isYoutubeWatchPendingStatus,
  missingYoutubeAccounts,
  usableYoutubeWatchTotals,
  summedYoutubeMetric,
  weightedYoutubeMetric,
  YOUTUBE_WATCH_PENDING_EXIT,
  YOUTUBE_WATCH_PENDING_STATUS,
  youtubeChannelsFingerprint,
  youtubeCohortAfterPull,
  youtubePullExitCode,
  youtubeTargetFingerprint,
  youtubeWatchProbe,
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
const withFuture = [...shows, { slug: "future", date: "2026-09-10" }];
assert.equal(
  youtubePullExitCode({ shows: withFuture, missingTotals: [...newestMissing, { slug: "future", channel: "yt:designertom" }], now: morningAfter }),
  YOUTUBE_WATCH_PENDING_EXIT,
  "a preregistered future episode cannot make the newest aired episode look old",
);
assert.equal(
  youtubePullExitCode({ shows: withFuture, missingTotals: [{ slug: "future", channel: "yt:designertom" }], now: morningAfter }),
  0,
  "a future episode is idle rather than waiting or failed",
);
assert.equal(isYoutubeWatchPendingStatus(YOUTUBE_WATCH_PENDING_STATUS), true);
assert.equal(isYoutubeWatchPendingStatus("failed:20"), false);
assert.deepEqual(missingYoutubeAccounts([{ targets: [
  { kind: "youtube", account: "joindiveclub", videoId: "one" },
  { kind: "youtube", account: "designertom", videoId: "two" },
] }], { designertom: "token" }), ["joindiveclub"], "a missing owner token cannot silently produce a one-channel report");
assert.deepEqual(missingYoutubeAccounts(shows, { designertom: "token" }), [], "shows without registered YouTube targets do not invent required accounts");

const expectedTargets = [
  { key: "yt:joindiveclub", videoId: "dive-video" },
  { key: "yt:designertom", videoId: "tom-video" },
];
const noRows = expectedTargets.map(({ key, videoId }) => youtubeWatchProbe({ key, videoId }));
const idleReport = youtubeWatchReport({
  checkedAt: "2026-09-03T15:15:00.000Z",
  airDate: "2026-09-03",
  probes: noRows,
});
assert.equal(idleReport.state, "idle", "air-date absence does not start the source wait");
assert.equal(Object.hasOwn(idleReport, "pendingSince"), false);
assert.deepEqual(youtubeWatchReport({
  checkedAt: "2026-09-04T15:15:00.000Z",
  probes: noRows,
}), {
  state: "pending",
  checkedAt: "2026-09-04T15:15:00.000Z",
  missingChannels: ["yt:joindiveclub", "yt:designertom"],
  reason: "YouTube Analytics has not returned this episode's watch data yet",
  targetFingerprint: "yt:designertom:tom-video|yt:joindiveclub:dive-video",
  probes: noRows,
  pendingSince: "2026-09-04T15:15:00.000Z",
});
const carried = youtubeWatchReport({
  checkedAt: "2026-09-05T15:15:00.000Z",
  probes: noRows,
  previous: { state: "pending", checkedAt: "2026-09-04T15:15:00.000Z" },
  previousTargetFingerprint: youtubeTargetFingerprint(expectedTargets),
});
assert.equal(carried.pendingSince, "2026-09-04T15:15:00.000Z", "a legacy pending report migrates its first checked time");
const changedTargets = youtubeWatchReport({
  checkedAt: "2026-09-05T15:15:00.000Z",
  probes: [youtubeWatchProbe({ key: "yt:joindiveclub", videoId: "replacement" })],
  previous: carried,
  previousTargetFingerprint: youtubeTargetFingerprint(expectedTargets),
});
assert.equal(changedTargets.pendingSince, "2026-09-05T15:15:00.000Z", "a video-id change begins a new wait");
const readyProbes = expectedTargets.map(({ key, videoId }) => youtubeWatchProbe({
  key,
  videoId,
  totals: { views: 12, averageViewPercentage: 9.5 },
}));
const readyReport = youtubeWatchReport({ checkedAt: "now", probes: readyProbes, previous: carried });
assert.equal(readyReport.state, "ready");
assert.equal(Object.hasOwn(readyReport, "pendingSince"), false, "ready clears the pending start");
const failedReport = youtubeWatchReport({
  checkedAt: "now",
  probes: [youtubeWatchProbe({ key: "yt:joindiveclub", videoId: "dive-video", failed: true })],
  previous: carried,
});
assert.equal(failedReport.state, "failed");
assert.equal(Object.hasOwn(failedReport, "pendingSince"), false, "a hard failure breaks a consecutive source wait");
assert.deepEqual(youtubeWatchProbe({ key: "yt:a", videoId: "one", totals: { views: 0, averageViewPercentage: 0 } }), {
  key: "yt:a", videoId: "one", result: "zero-views", observed: { views: 0, averageViewPercentage: 0 },
});
assert.equal(youtubeWatchProbe({ key: "yt:a", videoId: "one", totals: { views: 0 } }).result, "zero-views", "an explicit zero stays zero evidence when watched share is absent");
assert.equal(youtubeWatchProbe({ key: "yt:a", videoId: "one", totals: { views: -1 } }).result, "request-failed", "an impossible negative row is malformed source data");
assert.equal(youtubeWatchProbe({ key: "yt:a", videoId: "one", totals: { views: 4 } }).result, "missing-share");
assert.equal(youtubeWatchProbe({ key: "yt:a", videoId: "one", totals: { averageViewPercentage: 4 } }).result, "request-failed");
assert.equal(usableYoutubeWatchTotals({ views: 0, averageViewPercentage: 0 }), false, "an explicit startup zero is not a share-watched reading");
assert.equal(usableYoutubeWatchTotals({ views: 12, averageViewPercentage: null }), false, "views without the watched share are still pending");
assert.equal(usableYoutubeWatchTotals({ views: 12, averageViewPercentage: 9.5 }), true);
const partialChannels = {
  "yt:joindiveclub": { pulledAt: "2026-09-04T15:00:00.000Z", totals: { views: 12, averageViewPercentage: 9.5 } },
  "yt:designertom": { pulledAt: "2026-09-04T15:00:00.000Z", totals: { views: 8, averageViewPercentage: null } },
  "yt:unregistered": { pulledAt: "2026-09-04T15:00:00.000Z", totals: { views: 99, averageViewPercentage: 99 } },
};
assert.deepEqual(
  completeYoutubeWatchChannels(["yt:joindiveclub", "yt:designertom"], partialChannels),
  [],
  "one missing watched-share field withholds the whole episode instead of producing a one-channel blend",
);
partialChannels["yt:designertom"].totals.averageViewPercentage = 7.25;
delete partialChannels["yt:unregistered"];
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
  "a complete report uses exactly the registered channels",
);

partialChannels["yt:designertom"].pulledAt = "2026-09-05T15:00:00.000Z";
assert.deepEqual(completeYoutubeWatchChannels(["yt:joindiveclub", "yt:designertom"], partialChannels), [], "mixed pull times are not one reading");
partialChannels["yt:designertom"].pulledAt = "2026-09-04T15:00:00.000Z";
assert.equal(completeYoutubeWatchCohort(["yt:joindiveclub", "yt:designertom"], {
  channels: partialChannels,
  updatedAt: "2026-09-05T15:00:00.000Z",
}).length, 0, "the store timestamp must equal the channel cohort time");

const savedDive = {
  videoId: "dive-video",
  pulledAt: "2026-09-04T15:00:00.000Z",
  totals: { views: 41, averageViewPercentage: 12.5 },
  trafficSources: [{ insightTrafficSourceType: "RELATED_VIDEO", views: 8 }],
  retention: [{ elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.3 }],
};
const savedTom = {
  videoId: "tom-video",
  pulledAt: "2026-09-04T15:00:00.000Z",
  totals: { views: 31, averageViewPercentage: 10.5 },
  trafficSources: [{ insightTrafficSourceType: "BROWSE", views: 6 }],
  retention: [{ elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.25 }],
};
const previousStore = {
  channels: { "yt:joindiveclub": savedDive, "yt:designertom": savedTom },
  updatedAt: "2026-09-04T15:00:00.000Z",
};
const partialCandidate = {
  "yt:joindiveclub": { ...savedDive, pulledAt: "2026-09-05T15:00:00.000Z", totals: { views: 50, averageViewPercentage: 13 } },
  "yt:designertom": { ...savedTom, pulledAt: "2026-09-05T15:00:00.000Z", totals: null },
};
const afterPartial = youtubeCohortAfterPull({
  previousStore,
  expectedTargets,
  candidateChannels: partialCandidate,
  checkedAt: "2026-09-05T15:00:00.000Z",
});
assert.equal(afterPartial.channels, previousStore.channels, "one fresh channel cannot replace either block in the saved cohort");
assert.equal(afterPartial.updatedAt, previousStore.updatedAt);
assert.equal(afterPartial.advanced, false);
assert.deepEqual(youtubeCohortAfterPull({
  previousStore: {},
  expectedTargets,
  candidateChannels: partialCandidate,
  checkedAt: "2026-09-05T15:00:00.000Z",
}).channels, {}, "a first partial pull leaves public channels empty");
assert.deepEqual(youtubeCohortAfterPull({
  previousStore,
  expectedTargets: [{ key: "yt:joindiveclub", videoId: "replacement" }, expectedTargets[1]],
  candidateChannels: partialCandidate,
  checkedAt: "2026-09-05T15:00:00.000Z",
}).channels, {}, "a changed video id cannot inherit the prior video's cohort");
const completeCandidate = {
  "yt:joindiveclub": { ...partialCandidate["yt:joindiveclub"] },
  "yt:designertom": { ...savedTom, pulledAt: "2026-09-05T15:00:00.000Z", totals: { views: 39, averageViewPercentage: 11 } },
};
const advanced = youtubeCohortAfterPull({
  previousStore,
  expectedTargets,
  candidateChannels: completeCandidate,
  checkedAt: "2026-09-05T15:00:00.000Z",
});
assert.deepEqual(advanced.channels, completeCandidate, "both fresh channels replace the cohort together");
assert.equal(advanced.updatedAt, "2026-09-05T15:00:00.000Z");
assert.equal(advanced.advanced, true);
assert.equal(completeYoutubeWatchCohort(expectedTargets, advanced).length, 2);
assert.equal(youtubeChannelsFingerprint(previousStore.channels), youtubeTargetFingerprint(expectedTargets));
assert.equal(youtubeCohortAfterPull({
  previousStore,
  expectedTargets,
  candidateChannels: completeCandidate,
  checkedAt: "2026-09-05T15:00:00.000Z",
  acceptCandidate: false,
}).channels, previousStore.channels, "a request failure preserves the whole earlier cohort even if partial values were observed");

const pullSource = readFileSync(join(HERE, "..", "..", "..", "scripts", "restream", "yt-analytics-pull.mjs"), "utf8");
assert.match(pullSource, /store\.watchReport\s*=\s*youtubeWatchReport\(\{/);
assert.match(pullSource, /airDate: show\.date/);
assert.match(pullSource, /if \(exitCode === YOUTUBE_WATCH_PENDING_EXIT\)/);
assert.match(pullSource, /const candidateChannels = Object\.fromEntries/);
assert.match(pullSource, /const cohort = youtubeCohortAfterPull\(\{/);
assert.doesNotMatch(pullSource, /store\.channels\[key\]\s*=/);
assert.match(pullSource, /const today = phoenixDate\(now\)/);
assert.match(pullSource, /const dueShows = shows\.filter/);
assert.match(pullSource, /missingAccounts = missingYoutubeAccounts\(dueShows, tokens\)/);
assert.match(pullSource, /acquireLock\(`\$\{path\}\.lock\.tmp`/);
assert.match(pullSource, /renameSync\(tmp, path\)/);
assert.match(pullSource, /!usableYoutubeWatchTotals\(totals\)/);

const buildSource = readFileSync(join(HERE, "..", "build-data.mjs"), "utf8");
assert.match(buildSource, /completeYoutubeWatchCohort\(expectedChannels, j\)/);

const chainSource = readFileSync(join(HERE, "..", "run-chain.mjs"), "utf8");
assert.match(chainSource, /runStepWithPolicy/);
assert.match(chainSource, /youtubeWatchPending: isPending\(\)/);
assert.match(chainSource, /continuing so the morning production build stays current/);
assert.match(chainSource, /if \(youtubeWatchPending\)[\s\S]*process\.exit\(YOUTUBE_WATCH_PENDING_EXIT\)/);

console.log("youtube-readiness.test: newest no-row reports stay pending, saved totals survive, publish continues, and other failures stay failures");
