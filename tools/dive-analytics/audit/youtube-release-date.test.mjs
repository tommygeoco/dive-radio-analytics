#!/usr/bin/env node
// Regression: a scheduled live upload belongs to the day it airs, not the
// earlier day on which YouTube first placed it in the uploads playlist.

import assert from "node:assert/strict";
import { episodeDateForVideo } from "../../../scripts/restream/postlive-discover.mjs";

assert.equal(episodeDateForVideo({
  snippet: { publishedAt: "2026-09-02T21:41:32.000Z" },
  liveStreamingDetails: {
    scheduledStartTime: "2026-09-04T20:00:00.000Z",
    actualStartTime: "2026-09-03T20:00:00.000Z",
  },
}), "2026-09-03", "actual start wins over the upload and scheduled times");

assert.equal(episodeDateForVideo({
  snippet: { publishedAt: "2026-09-02T21:41:32.000Z" },
  liveStreamingDetails: { scheduledStartTime: "2026-09-03T20:00:00.000Z" },
}), "2026-09-03", "an upcoming stream uses its scheduled broadcast day");

assert.equal(episodeDateForVideo({
  snippet: { publishedAt: "2026-09-02T21:41:32.000Z", liveBroadcastContent: "none" },
}), "2026-09-02", "an ordinary upload uses its publication day");

assert.equal(episodeDateForVideo({
  snippet: { publishedAt: "2026-09-02T21:41:32.000Z" },
  liveStreamingDetails: {},
}), null, "a live upload without a start time is skipped instead of using its upload day");

assert.equal(episodeDateForVideo({
  snippet: { publishedAt: "2026-09-02T21:41:32.000Z", liveBroadcastContent: "upcoming" },
}), null, "an upcoming broadcast without details is not mistaken for an ordinary upload");

console.log("youtube-release-date.test: live episodes use actual or scheduled broadcast day; ordinary uploads use publication day");
