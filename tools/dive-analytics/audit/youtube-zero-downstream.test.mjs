#!/usr/bin/env node
// Regression: an all-zero YouTube startup receipt remains raw evidence but is
// not a historical reading, a tracking start, or a rendered zero.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLatest, partialHistoryOf } from "../build-data.mjs";
import { computeRatings, readAgeOf, scoreEpisode } from "../ratings.mjs";
import { premiereMs, firstYtSnapshot, latestYtSnapshot, ytSnapshotAt, ytViewsOf } from "../baselines.mjs";
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

const zero = at(0.8, 0);
const preAir = at(-0.2, 3, 0);
const dayTwo = at(1.8, 12, 0);
const late = at(6.2, 20, 0);

assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [zero] }), null);
assert.equal(ytSnapshotAt({ premiere: PREMIERE, snapshots: [zero] }, 1), null, "startup zero is not day one");
assert.equal(firstYtSnapshot({ premiere: PREMIERE, snapshots: [preAir] }), null, "a waiting-room count before premiere is not day one");
assert.equal(latestYtSnapshot({ premiere: PREMIERE, snapshots: [preAir, dayTwo] }), dayTwo, "the first post-air count is the latest usable reading");
assert.equal(ytSnapshotAt({ premiere: PREMIERE, snapshots: [preAir, dayTwo] }, 0), null, "pre-air counts cannot satisfy a historical read");
assert.equal(ytViewsOf(zero), null, "all-zero YouTube is absence downstream");
assert.equal(ytViewsOf(dayTwo), 12, "one positive channel makes the combined reading real");
assert.equal(partialHistoryOf([zero], PREMIERE), null, "tracking state is unknown before a real YouTube reading");
assert.equal(partialHistoryOf([preAir], PREMIERE), null, "a positive waiting-room count cannot start tracking");
assert.equal(partialHistoryOf([zero, dayTwo], PREMIERE), false, "the first positive reading starts on time");
assert.equal(partialHistoryOf([zero, late], PREMIERE), true, "a startup zero cannot hide late tracking");

const zeroEpisode = { slug: "zero", ep: 1, premiere: PREMIERE, snapshots: [zero], latest: {} };
const lateEpisode = { ...zeroEpisode, slug: "late", snapshots: [zero, late] };
assert.equal(readAgeOf(zeroEpisode), null);
assert.equal(readAgeOf(lateEpisode), 21, "read age starts at the first positive reading, then waits for day 21");
const unscored = scoreEpisode(zeroEpisode, [], new Map());
assert.equal(unscored.score, null);
assert.equal(unscored.atDay, null);
assert.match(unscored.reason, /YouTube views are not available/);
assert.ok(Object.values(unscored.checks).every((check) => check.value == null && check.ratio == null && check.weight === 0));

const show = { targets: [{ kind: "x", account: "ridd_design", broadcastId: "1", playsStatus: "unresolved" }] };
const nothing = buildLatest(show, zero);
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

const xOnly = buildLatest(show, at(0.8, 0, 0, { "x:ridd_design": { views: 1000, plays: 323, playsSource: "x-broadcast" } }));
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
assert.equal(heldReading.ytTotal, 12, "a later empty pull cannot erase the last real reading");
assert.equal(heldReading.byDest["yt:joindiveclub"].views, 12);
assert.equal(heldReading.youtubeAsOf, dayTwo.ts);
assert.equal(heldReading.youtubeStale, true);
assert.match(heldReading.totalViewsInfo.reason, /older reading/);

// One episode without a positive YouTube reading withholds whole-show
// recommendation totals. It cannot be folded into them as a zero.
const recommendationData = {
  generatedAt: zero.ts,
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
