#!/usr/bin/env node
// Regression: a scheduled YouTube upload can exist before statistics or owner
// analytics are available. Missing counts must not become a day-one zero.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  destinationViewsForDisplay,
  mergedViewCount,
  totalViewsCell,
  youtubeDeltaForDisplay,
  youtubeStatsOf,
  youtubeViewsForDisplay,
} from "../../../scripts/restream/postlive-track.mjs";
import { appendHistoryLine, historyLine, phoenixDate, readHistory } from "../../../scripts/restream/yt-analytics-pull.mjs";

assert.equal(phoenixDate("2026-09-05T01:00:00.000Z"), "2026-09-04", "the writer keeps Phoenix's date during the UTC evening rollover");

const missing = youtubeStatsOf({
  id: "scheduled",
  snippet: { title: "Scheduled show", channelId: "channel" },
  statistics: {},
});
assert.deepEqual(missing, {
  views: null,
  likes: null,
  comments: null,
  title: "Scheduled show",
  channelId: "channel",
});

const measuredZero = youtubeStatsOf({
  id: "aired",
  snippet: { title: "Aired show", channelId: "channel" },
  statistics: { viewCount: "0", likeCount: "0", commentCount: "0" },
});
assert.deepEqual(measuredZero, {
  views: 0,
  likes: 0,
  comments: 0,
  title: "Aired show",
  channelId: "channel",
});
assert.equal(mergedViewCount(undefined, missing.views), null, "a missing API count stays missing in the raw snapshot");
assert.equal(mergedViewCount(undefined, measuredZero.views), 0, "an explicit API zero stays measured zero in the raw snapshot");
assert.equal(mergedViewCount(12, null), 12, "a missing duplicate target cannot erase a known count");

const startup = {
  "yt:joindiveclub": { views: 0 },
  "yt:designertom": { views: null },
  "x:ridd_design": { views: 50, plays: 12 },
};
assert.equal(youtubeViewsForDisplay(startup), null, "an all-zero or missing YouTube row is unavailable for reports");
assert.equal(destinationViewsForDisplay(startup, "yt:joindiveclub"), null, "the vault must not print the raw startup zero");
assert.equal(destinationViewsForDisplay(startup, "x:ridd_design"), 50, "X reach behavior is unchanged");
assert.equal(youtubeDeltaForDisplay(startup, { "yt:joindiveclub": { views: 30 } }), null, "an unavailable current reading has no change");
assert.equal(youtubeDeltaForDisplay({ "yt:joindiveclub": { views: 30 } }, startup), null, "an unavailable earlier reading is not a baseline");
assert.equal(totalViewsCell(null, { value: 12, partial: false, stale: false }), "12 (X only)");
assert.equal(totalViewsCell(null, { value: null, partial: false, stale: false }), "–");

const aired = {
  "yt:joindiveclub": { views: 20 },
  "yt:designertom": { views: 0 },
};
assert.equal(youtubeViewsForDisplay(aired), 20, "a positive YouTube reading keeps an explicit companion zero");
assert.equal(destinationViewsForDisplay(aired, "yt:designertom"), 0);

const dir = mkdtempSync(join(tmpdir(), "dive-youtube-missing-"));
const historyPath = join(dir, "episode.jsonl");
const empty = historyLine({
  premiere: "2026-09-03",
  pulledAt: "2026-09-03T14:00:00.000Z",
  endDate: "2026-09-03",
  channels: {
    "yt:joindiveclub": { totals: null },
    "yt:designertom": { totals: null },
  },
});
assert.deepEqual(empty.channels, {});
assert.equal(appendHistoryLine(historyPath, empty), false, "an empty pull must not reserve the date");
assert.equal(existsSync(historyPath), false, "an empty pull must not create a history file");

const partial = historyLine({
  premiere: "2026-09-03",
  pulledAt: "2026-09-03T14:30:00.000Z",
  endDate: "2026-09-03",
  channels: {
    "yt:joindiveclub": { totals: { views: 1 } },
    "yt:designertom": { totals: null },
  },
});
assert.equal(appendHistoryLine(historyPath, partial, {
  expectedChannels: ["yt:joindiveclub", "yt:designertom"],
}), false, "a partial authorized-channel pull must not reserve the date");
assert.equal(existsSync(historyPath), false);

const zero = historyLine({
  premiere: "2026-09-03",
  pulledAt: "2026-09-03T15:00:00.000Z",
  endDate: "2026-09-03",
  channels: {
    "yt:joindiveclub": {
      totals: {
        views: 0,
        averageViewPercentage: 0,
        averageViewDuration: 0,
        estimatedMinutesWatched: 0,
        subscribersGained: 0,
        likes: 0,
        comments: 0,
      },
    },
  },
});
assert.equal(zero.channels["yt:joindiveclub"].views, 0, "the current analytics value preserves a measured zero");
assert.equal(appendHistoryLine(historyPath, zero, { expectedChannels: ["yt:joindiveclub"] }), false, "an all-zero pull must not reserve day one");
assert.equal(existsSync(historyPath), false);

const positive = structuredClone(zero);
positive.channels["yt:joindiveclub"].views = 1;
assert.equal(appendHistoryLine(historyPath, positive, { expectedChannels: ["yt:joindiveclub"], premiere: "2026-09-03" }), false, "a positive pre-air pull must not claim the date");
assert.equal(existsSync(historyPath), false);

const postAir = historyLine({
  premiere: "2026-09-03",
  pulledAt: "2026-09-03T20:00:00.000Z",
  endDate: "2026-09-03",
  channels: { "yt:joindiveclub": { totals: { views: 1 } } },
});
assert.equal(appendHistoryLine(historyPath, postAir, { expectedChannels: ["yt:joindiveclub"], premiere: "2026-09-03" }), false, "an air-date pull cannot claim day one");
assert.equal(existsSync(historyPath), false);

const partialNextDay = historyLine({
  slug: "2026-09-03-dive-radio-fixture",
  premiere: "2026-09-03",
  pulledAt: "2026-09-04T14:00:00.000Z",
  endDate: "2026-09-04",
  channels: {
    "yt:joindiveclub": { videoId: "d", totals: { views: 20, averageViewPercentage: 12 } },
    "yt:designertom": { videoId: "t", totals: { views: 0, averageViewPercentage: 0 } },
  },
});
assert.equal(appendHistoryLine(historyPath, partialNextDay, { expectedChannels: ["yt:joindiveclub", "yt:designertom"], premiere: "2026-09-03" }), false, "one zero channel cannot make a two-channel watched-share history point");
const nextDay = structuredClone(partialNextDay);
nextDay.channels["yt:designertom"] = { ...nextDay.channels["yt:designertom"], views: 7, averageViewPercentage: 9 };
assert.equal(appendHistoryLine(historyPath, nextDay, { expectedChannels: ["yt:joindiveclub", "yt:designertom"], premiere: "2026-09-03" }), true, "the first complete positive next-date pull may claim day one");
assert.deepEqual(readHistory(historyPath), [nextDay]);
assert.match(readFileSync(historyPath, "utf8"), /"views":20/);

console.log("youtube-missing-data.test: missing counts stay null, empty and partial history are skipped, raw explicit zero is preserved");
