#!/usr/bin/env node
// Regression checks for the dependency-free comparison-chart hover model.
// The browser wiring is source-locked in validate.mjs; this fixture proves
// the geometry and the saved-point selection without needing a browser.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const source = html.match(/\/\* chart-hover-model:start \*\/([\s\S]*?)\/\* chart-hover-model:end \*\//)?.[1];
assert.ok(source, "comparison hover model is extractable from index.html");

const sandbox = {};
vm.runInNewContext(`${source}\nthis.model = { storedPointNear, describeTotalViews, pendingWatchMessage, pointToSegmentDistance, pointToCurveDistance, closestEpisodeLine, tooltipBoxPosition, pointInsideChartArea, storedCategoryReading, trendHighlightSlug, tooltipItemForHit };`, sandbox);
const { storedPointNear, describeTotalViews, pendingWatchMessage, closestEpisodeLine, tooltipBoxPosition, pointInsideChartArea, storedCategoryReading, trendHighlightSlug, tooltipItemForHit } = sandbox.model;

const readings = [{ x: 0, y: 10 }, { x: 40, y: 20 }, { x: 100, y: 30 }];
assert.equal(storedPointNear(readings, 39).index, 1, "nearest saved reading is selected");
assert.equal(storedPointNear(readings, 70).index, 2, "a tie selects the later saved reading");
assert.equal(storedPointNear(readings, -1, { atOrBefore: true }), null, "no future reading is pulled before history starts");
assert.equal(storedPointNear(readings, 70, { atOrBefore: true }).index, 1, "history readout never pulls a future saved reading");
assert.equal(storedPointNear([{ x: 48, y: 1 }, { x: 48, y: 2 }], 48 - 1e-9, { atOrBefore: true }).index, 1, "an exact rendered day tolerates pixel roundoff and uses its latest saved reading");
assert.equal(storedPointNear([{ x: 0, y: null }, { x: 1, y: 0 / 0 }], 1), null, "missing readings stay absent");
const plain = (value) => String(value);
assert.equal(describeTotalViews(null, {}, true, plain), "not available", "a missing total stays explicit");
assert.equal(describeTotalViews(321, { includesYoutube: false, includesPlays: true, incomplete: true }, true, plain), "321 X plays", "X-only playback is named as X plays");
assert.equal(describeTotalViews(321, { includesYoutube: false, includesPlays: true, incomplete: true, partial: true }, true, plain), "321 known X plays", "partial X-only playback stays visibly incomplete");
assert.equal(describeTotalViews(321, { includesYoutube: false, includesPlays: true, incomplete: true, stale: true }, true, plain), "321 known X plays", "older X-only playback stays visibly old");
assert.equal(describeTotalViews(321, { includesYoutube: true, includesPlays: false, incomplete: true }, true, plain), "321 YouTube views", "YouTube-only playback is named as YouTube views");
assert.equal(describeTotalViews(321, { includesYoutube: true, includesPlays: false, incomplete: true, youtubeStale: true }, true, plain), "321 known YouTube views", "an older YouTube-only reading stays visibly old");
assert.equal(describeTotalViews(321, { includesYoutube: true, includesPlays: true, incomplete: true }, true, plain), "321 known views", "an incomplete blended total is named as known views");
assert.equal(describeTotalViews(321, { includesYoutube: true, includesPlays: true, stale: true }, true, plain), "321 known views", "a blended total with an older source stays visibly incomplete");
assert.equal(describeTotalViews(321, { includesYoutube: true, includesPlays: true }, true, plain), "321 total views", "a complete blended total is named as total views");

const newestPendingWatch = { slug: "newest", watch: null, watchReport: { state: "pending" } };
assert.equal(pendingWatchMessage(newestPendingWatch, "newest"), "YouTube is still preparing this number.", "the newest missing watch number explains the source wait");
assert.equal(pendingWatchMessage(newestPendingWatch, "newest", { compact: true }), "Waiting for YouTube", "compact chart copy still names YouTube's wait");
assert.equal(pendingWatchMessage({ slug: "older", watch: null, watchReport: { state: "pending" } }, "newest"), null, "an older pending watch report does not take over the newest episode's state");
assert.equal(pendingWatchMessage({ slug: "newest", watch: null, watchReport: { state: "failed" } }, "newest"), null, "a failed source pull is not mislabeled as YouTube preparing data");
assert.equal(pendingWatchMessage({ slug: "newest", watch: { avgPercent: 0 }, watchReport: { state: "pending" } }, "newest"), "YouTube is still preparing an update.", "a saved zero remains a reading while its newer source check stays visibly pending");
assert.equal(pendingWatchMessage({ slug: "newest", watch: { avgPercent: 12 }, watchReport: { state: "pending" } }, "newest", { compact: true }), "Update pending", "a preserved exact reading is not mislabeled as current");

const weeklyDataset = { data: [100, null, 80], metas: [{ ts: "2026-08-01T00:00:00Z", week: 1 }, null, { ts: "2026-08-15T00:00:00Z", week: 3 }] };
assert.equal(storedCategoryReading(weeklyDataset, 0).value, 100, "weekly grouped bars return their saved number");
assert.equal(storedCategoryReading(weeklyDataset, 0).meta.week, 1, "weekly grouped bars keep their saved week metadata");
assert.equal(storedCategoryReading(weeklyDataset, 1), null, "a missing weekly grouped bar stays unavailable");

const trendRowsMissingNewest = [{ e: { slug: "older" }, v: 10 }, { e: { slug: "newest" }, v: null }];
assert.equal(trendHighlightSlug(trendRowsMissingNewest), null, "the overview never highlights an older episode as if it were newest");
assert.equal(trendHighlightSlug(trendRowsMissingNewest, "older"), "older", "an explicit episode selection may highlight its saved reading");
assert.equal(trendHighlightSlug([{ e: { slug: "newest" }, v: 12 }]), "newest", "the newest episode is highlighted when its reading exists");

const fractionalArea = { left: 62.1584, right: 700, top: 20.25, bottom: 300 };
assert.equal(pointInsideChartArea({ x: 62, y: 20 }, fractionalArea), true, "whole-pixel input keeps a visibly rendered left-edge point inside");
assert.equal(pointInsideChartArea({ x: 61, y: 20 }, fractionalArea), false, "real space outside the plot stays outside");

const datasets = [
  { slug: "episode-one", order: 1, data: [{ x: 0, y: 10 }, { x: 100, y: 30 }] },
  { slug: "episode-two", order: 0, pastOnly: true, data: [{ x: 0, y: 60 }, { x: 100, y: 60 }] },
  { slug: "hidden-episode", data: [{ x: 0, y: 40 }, { x: 100, y: 40 }] },
  { isAnnounce: true, data: [{ x: 0, y: 42 }, { x: 100, y: 42 }] },
];
const rendered = [
  [{ x: 0, y: 20 }, { x: 100, y: 20 }],
  [{ x: 0, y: 60 }, { x: 100, y: 60 }],
  [{ x: 0, y: 40 }, { x: 100, y: 40 }],
  [{ x: 0, y: 42 }, { x: 100, y: 42 }],
];
const chart = {
  data: { datasets },
  scales: { x: { getValueForPixel: (value) => value } },
  isDatasetVisible: (index) => index !== 2,
  getDatasetMeta(index) {
    return {
      data: rendered[index],
      dataset: { interpolate: ({ x }) => ({ x, y: rendered[index][0].y }) },
    };
  },
};

assert.equal(closestEpisodeLine(chart, { x: 50, y: 40 }), null, "blank plot space returns the all-episode summary");
const lineHit = closestEpisodeLine(chart, { x: 50, y: 24 });
assert.equal(lineHit.datasetIndex, 0, "the closest visible episode line wins");
assert.equal(lineHit.index, 1, "line geometry selects a real saved point, not an interpolated value");
assert.equal(closestEpisodeLine(chart, { x: 50, y: 42 }), null, "hidden and announcement lines cannot take over direct detail");
assert.equal(closestEpisodeLine(chart, { x: 70, y: 60 }).index, 0, "history detail never jumps ahead to a future saved reading");

const roundedEndpointChart = {
  data: { datasets: [{ slug: "episode-one", pastOnly: true, data: [{ x: 47, y: 3878 }, { x: 48, y: 3889 }] }] },
  scales: { x: { getValueForPixel: () => 47.98 } },
  isDatasetVisible: () => true,
  getDatasetMeta() {
    return {
      data: [{ x: 1088.2, y: 22 }, { x: 1104.114, y: 20 }],
      dataset: { interpolate: () => ({ x: 1104, y: 20 }) },
    };
  },
};
assert.equal(closestEpisodeLine(roundedEndpointChart, { x: 1104, y: 20 }).index, 1,
  "a pointer rounded to a whole CSS pixel uses the saved endpoint visibly under it");

const overlapDatasets = [
  { slug: "older", order: 1, data: [{ x: 0, y: 20 }, { x: 100, y: 20 }] },
  { slug: "newest", order: 0, data: [{ x: 0, y: 20 }, { x: 100, y: 20 }] },
];
const overlapChart = {
  data: { datasets: overlapDatasets },
  scales: { x: { getValueForPixel: (value) => value } },
  isDatasetVisible: () => true,
  getDatasetMeta(index) {
    return {
      data: [{ x: 0, y: 20 }, { x: 100, y: 20 }],
      dataset: { interpolate: ({ x }) => ({ x, y: 20 }) },
    };
  },
};
assert.equal(closestEpisodeLine(overlapChart, { x: 50, y: 20 }).datasetIndex, 1, "the visually topmost line wins an exact overlap");
const forcedItem = tooltipItemForHit(overlapChart, { datasetIndex: 0, index: 1 });
assert.equal(forcedItem.dataset.slug, "older", "direct popup content follows the custom geometry hit, not Chart.js's nearby line");
assert.equal(forcedItem.raw.y, 20);

let placed = tooltipBoxPosition({ x: 20, y: 20 }, { width: 100, height: 60 }, { width: 320, height: 180 });
assert.equal(placed.left, 34, "popup follows the cursor to the right when there is room");
assert.equal(placed.top, 34, "popup follows the cursor below when there is room");
placed = tooltipBoxPosition({ x: 300, y: 160 }, { width: 100, height: 60 }, { width: 320, height: 180 });
assert.equal(placed.left, 186, "popup flips left before leaving the chart");
assert.equal(placed.top, 86, "popup flips above before leaving the chart");
placed = tooltipBoxPosition({ x: 230, y: 130 }, { width: 224, height: 260 }, { width: 240, height: 340 });
assert.ok(placed.left >= 8 && placed.left + 224 <= 232, "phone popup stays inside the chart horizontally");
assert.ok(placed.top >= 8 && placed.top + 260 <= 332, "an eight-episode phone popup stays inside a selected chart vertically");

console.log("chart tooltip model: saved points, pending watch state, grouped weeks, honest highlighting, line choice, edge tolerance, and placement green");
