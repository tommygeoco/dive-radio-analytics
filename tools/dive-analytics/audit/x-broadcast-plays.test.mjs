#!/usr/bin/env node
// Broadcast-only X plays regression fixture. Native tweet media may contribute
// reach/engagement, but only a resolved, live-or-finished X broadcast may
// contribute episode plays or total views.

import assert from "node:assert/strict";
import {
  buildShowMetrics,
  parseBroadcastStatsLine,
  playsSummary,
} from "../../../scripts/restream/postlive-track.mjs";
import {
  buildLatest,
  compactSnap,
} from "../build-data.mjs";

const poison = {
  views: 1154,
  plays: 323,
  likes: 24,
  replies: 2,
  urls: [],
  broadcastIds: [],
  hasNativeVideo: true,
};

// Upcoming containers and malformed/zero counters are not episode plays.
assert.equal(parseBroadcastStatsLine("is_upcoming|323|NA"), null);
assert.equal(parseBroadcastStatsLine("not_live|323|NA"), null);
assert.equal(parseBroadcastStatsLine("was_live|0|20"), null);
assert.deepEqual(parseBroadcastStatsLine("was_live|700|80"), {
  views: 700,
  peakConcurrent: 80,
  liveStatus: "was_live",
});

// The exact E8 failure shape: native teaser views survive only as post reach.
{
  const show = { targets: [{ kind: "x", account: "ridd_design", postId: "p1", playsStatus: "unresolved" }] };
  const metrics = buildShowMetrics(show, {}, { p1: poison }, {});
  assert.equal(metrics["x:ridd_design"].views, 1154);
  assert.equal("plays" in metrics["x:ridd_design"], false);
  assert.equal("plays" in metrics["x:ridd_design"].detail, false);
  assert.deepEqual(playsSummary(show, metrics), {
    value: null,
    have: 0,
    total: 0,
    partial: false,
    stale: false,
    asOf: null,
  });

  const compact = compactSnap({ ts: "2026-09-03T14:00:03.312Z", metrics: {
    "yt:joindiveclub": { views: 0, detail: { views: 0 } },
    "yt:designertom": { views: 0, detail: { views: 0 } },
    "x:ridd_design": { views: 1154, plays: 323, detail: { views: 1154, plays: 323 } },
  } });
  assert.equal("plays" in compact.byDest["x:ridd_design"], false, "export must not resurrect detail/native plays");
  const latest = buildLatest(show, compact);
  assert.equal(latest.xPlays, null);
  assert.equal(latest.totalViews, 0);
  assert.equal(latest.totalViewsInfo.includesPlays, false);
}

// Even a poisoned tweet payload beside a valid broadcast contributes exactly
// the broadcast count, never native + broadcast.
{
  const show = { targets: [{
    kind: "x",
    account: "ridd_design",
    postId: "p1",
    broadcastId: "b1",
    playsStatus: "ok",
  }] };
  const metrics = buildShowMetrics(show, {}, { p1: poison }, {
    b1: { views: 700, peakConcurrent: 80, liveStatus: "was_live" },
  });
  assert.equal(metrics["x:ridd_design"].plays, 700);
  assert.equal(metrics["x:ridd_design"].playsSource, "x-broadcast");
  assert.equal("plays" in metrics["x:ridd_design"].detail, false);
  assert.equal(playsSummary(show, metrics).value, 700);

  const compact = compactSnap({ ts: "2026-09-03T20:00:00.000Z", metrics });
  const latest = buildLatest(show, compact);
  assert.equal(latest.xPlays, 700);
  assert.equal(latest.totalViews, 700);
}

// Poison without provenance cannot outrank a known broadcast high-water mark.
{
  const show = { targets: [{
    kind: "x",
    account: "ridd_design",
    postId: "p1",
    broadcastId: "b1",
    playsStatus: "stale-high-water",
    playsHighWater: { value: 650, asOf: "2026-09-02T20:00:00.000Z" },
  }] };
  const result = playsSummary(show, {
    "x:ridd_design": { views: 1154, plays: 999, detail: { plays: 999 } },
  });
  assert.equal(result.value, 650);
  assert.equal(result.stale, true);
  assert.equal(result.asOf, "2026-09-02T20:00:00.000Z");
}

console.log("x-broadcast-plays: broadcast-only source and export fixtures passed");
