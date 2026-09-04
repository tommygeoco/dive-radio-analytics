#!/usr/bin/env node
// Regression: an all-zero YouTube startup receipt remains raw evidence but is
// not a historical reading, a tracking start, or a rendered zero.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLatest, partialHistoryOf } from "../build-data.mjs";
import { computeRatings, readAgeOf, scoreEpisode } from "../ratings.mjs";
import { anomalyFlags, premiereMs, firstYtSnapshot, latestCurrentYtSnapshot, latestYtSnapshot, snapshotAt, ytSnapshotAt, ytViewsOf } from "../baselines.mjs";
import { collectFacts } from "../recommendations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DAY = 86400000;
const PREMIERE = "2026-09-03";
const at = (ageDays, a, b = 0, extra = {}) => ({
  ts: new Date(premiereMs(PREMIERE) + ageDays * DAY).toISOString(),
  byDest: {
    "yt:joindiveclub": { views: a, likes: 0, comments: 0 },
    "yt:designertom": { views: b, likes: 0, comments: 0 },
    ...extra,
  },
});

const zeroAirDay = at(0.3, 0);
const zeroNextDay = at(0.8, 0);
const preAir = at(-0.2, 3, 0);
const airDay = at(0.3, 12, 0);
const nextDay = at(0.8, 20, 0);
const dayTwo = at(1.8, 24, 0);
const late = at(6.2, 20, 0);

assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [zeroAirDay, zeroNextDay] }), null);
assert.equal(ytSnapshotAt({ premiere: PREMIERE, snapshots: [zeroAirDay, zeroNextDay] }, 1), null, "startup zero is not day one");
assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [preAir] }), null, "a waiting-room count before premiere is not day one");
assert.equal(latestCurrentYtSnapshot({ premiere: PREMIERE, snapshots: [preAir, airDay] }), airDay, "a post-air count is valid current data");
assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [preAir, airDay] }), null, "an air-date count is not day one");
assert.equal(latestYtSnapshot({ premiere: PREMIERE, snapshots: [preAir, airDay, nextDay, dayTwo] }), dayTwo, "historical selection begins on the next Phoenix date");
assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [preAir, airDay, nextDay] }), nextDay, "the next-date count is day one");
assert.equal(snapshotAt({ premiere: PREMIERE, snapshots: [airDay] }, 0.3), null, "air-date X and YouTube rows stay out of generic history");
assert.equal(ytSnapshotAt({ premiere: PREMIERE, snapshots: [preAir, airDay, nextDay] }, 0.3), nextDay, "the nearest eligible read cannot be the air-date count");
assert.equal(ytViewsOf(zeroAirDay), null, "all-zero YouTube is absence downstream");
assert.equal(ytViewsOf(nextDay), 20, "one positive channel makes the combined reading real");
assert.equal(partialHistoryOf([zeroAirDay, zeroNextDay], PREMIERE), null, "tracking state is unknown before a real next-date reading");
assert.equal(partialHistoryOf([preAir], PREMIERE), null, "a positive waiting-room count cannot start tracking");
assert.equal(partialHistoryOf([preAir, airDay], PREMIERE), null, "air-date data cannot start tracking");
assert.equal(partialHistoryOf([zeroAirDay, nextDay], PREMIERE), false, "the first next-date reading starts on time");
assert.equal(partialHistoryOf([zeroAirDay, late], PREMIERE), true, "a startup zero cannot hide late tracking");

const zeroEpisode = { slug: "zero", ep: 1, premiere: PREMIERE, snapshots: [zeroAirDay], latest: {} };
const airDayEpisode = { ...zeroEpisode, slug: "air-day", snapshots: [airDay], latest: { ytTotal: 12 } };
const lateEpisode = { ...zeroEpisode, slug: "late", snapshots: [zeroAirDay, late] };
assert.equal(readAgeOf(zeroEpisode), null);
assert.equal(readAgeOf(airDayEpisode), null, "air-date current data cannot begin a rating read");
assert.equal(readAgeOf(lateEpisode), 21, "read age starts at the first positive reading, then waits for day 21");
const unscored = scoreEpisode(zeroEpisode, [], new Map());
assert.equal(unscored.score, null);
assert.equal(unscored.atDay, null);
assert.match(unscored.reason, /YouTube views are not available/);
assert.ok(Object.values(unscored.checks).every((check) => check.value == null && check.ratio == null && check.weight === 0));

const show = { date: PREMIERE, targets: [{ kind: "x", account: "ridd_design", broadcastId: "1", playsStatus: "unresolved" }] };
const nothing = buildLatest(show, zeroAirDay);
assert.equal(nothing.ytTotal, null);
assert.equal(nothing.byDest["yt:joindiveclub"].views, null, "the canonical latest block masks the raw startup zero");
assert.equal(nothing.xPlays, null);
assert.equal(nothing.totalViews, null, "two absent view sources cannot render zero");
assert.deepEqual({
  includesYoutube: nothing.totalViewsInfo.includesYoutube,
  youtubeMissing: nothing.totalViewsInfo.youtubeMissing,
  missing: nothing.totalViewsInfo.missing,
  incomplete: nothing.totalViewsInfo.incomplete,
}, { includesYoutube: false, youtubeMissing: true, missing: true, incomplete: true });
assert.match(nothing.totalViewsInfo.reason, /YouTube views are not available/);
assert.match(nothing.totalViewsInfo.reason, /X plays are not available/);

const xOnly = buildLatest(show, at(0.3, 0, 0, { "x:ridd_design": { views: 1000, plays: 323, playsSource: "x-broadcast" } }));
assert.equal(xOnly.ytTotal, null);
assert.equal(xOnly.totalViews, 323, "a real X play count remains available");
assert.equal(xOnly.totalViewsInfo.missing, false);
assert.equal(xOnly.totalViewsInfo.incomplete, true);
assert.match(xOnly.totalViewsInfo.reason, /YouTube views are not available/);

const preAirLatest = buildLatest({ ...show, date: PREMIERE }, preAir);
assert.equal(preAirLatest.ytTotal, null, "a positive pre-air count stays out of the canonical latest block");
assert.equal(preAirLatest.totalViews, null);

const laterZero = at(2.8, 0, 0);
const heldReading = buildLatest({ targets: [] }, laterZero, dayTwo);
assert.equal(heldReading.ytTotal, 24, "a later empty pull cannot erase the last real reading");
assert.equal(heldReading.byDest["yt:joindiveclub"].views, 24);
assert.equal(heldReading.youtubeAsOf, dayTwo.ts);
assert.equal(heldReading.youtubeStale, true);
assert.match(heldReading.totalViewsInfo.reason, /older reading/);

const currentAirDay = buildLatest(show, airDay);
assert.equal(currentAirDay.ytTotal, 12, "the current card may show a confirmed post-air count");
assert.equal(partialHistoryOf([airDay], PREMIERE), null, "the same current count remains outside historical reads");
const airDayWithX = { ...airDayEpisode, latest: { ...currentAirDay, xPlays: 323, xImpressions: 1000, xPlaysInfo: { value: 323, have: 1, total: 1, partial: false, stale: false } } };
for (const unit of Object.values(anomalyFlags([airDayWithX], { minPeers: 0 }).get(airDayWithX.slug).units)) {
  assert.equal(unit.value, null, "air-date current values cannot enter anomaly history");
}

// One episode without a positive YouTube reading withholds whole-show
// recommendation totals. It cannot be folded into them as a zero.
const recommendationData = {
  generatedAt: zeroAirDay.ts,
  episodes: [
    { ...zeroEpisode, ep: 1, latest: { ...xOnly, ytTotal: 100, totalViews: 423, byDest: { ...xOnly.byDest, "yt:joindiveclub": { views: 100 } } } },
    { ...zeroEpisode, ep: 2, latest: xOnly },
  ],
  baselines: {},
};
const recommendationFacts = collectFacts(recommendationData).facts;
for (const id of ["views-yt-all", "views-total-all", "share-x-all"]) {
  assert.equal(recommendationFacts.find((fact) => fact.id === id), undefined, `${id} must wait for every episode's YouTube reading`);
}
assert.ok(!recommendationFacts.some((fact) => fact.id.startsWith("channel-") || fact.id.startsWith("traffic-")), "incomplete analytics cannot create whole-show channel or traffic facts");

// The orchestration must retain every frozen entry byte-for-byte even though
// new eligibility rules apply to future entries.
const stored = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8"));
const rerun = computeRatings({ now: Date.now() });
for (const frozen of stored.scores || []) {
  assert.deepEqual(rerun.scores.find((entry) => entry.slug === frozen.slug), frozen, `frozen rating changed: ${frozen.slug}`);
}

console.log("youtube-zero-downstream.test: startup zero stays out of reads, exports, and frozen ratings");
