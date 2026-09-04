#!/usr/bin/env node
// Regression: correcting a registry episode day must reach every mutable
// per-episode store on its next normal writer run.

import assert from "node:assert/strict";
import { syncCommentMetadata } from "../../../scripts/restream/comments-pull.mjs";
import { syncPostliveMetadata } from "../../../scripts/restream/postlive-track.mjs";
import { syncAnalyticsMetadata } from "../../../scripts/restream/yt-analytics-pull.mjs";

const show = { title: "Dive Radio: Correct day", date: "2026-09-03" };

const postlive = { title: show.title, date: "2026-09-02", snapshots: [{ ts: "kept" }] };
assert.equal(syncPostliveMetadata(postlive, show), true);
assert.equal(postlive.date, "2026-09-03");
assert.deepEqual(postlive.snapshots, [{ ts: "kept" }]);
assert.equal(syncPostliveMetadata(postlive, show), false, "postlive metadata sync is idempotent");

const comments = { title: show.title, date: "2026-09-02", comments: [{ id: "kept" }], updatedAt: "old" };
assert.equal(syncCommentMetadata(comments, show), true);
assert.equal(comments.date, "2026-09-03");
assert.deepEqual(comments.comments, [{ id: "kept" }]);
assert.equal(comments.updatedAt, "old", "metadata sync alone does not claim a fresh audience pull");

const analytics = { title: show.title, premiere: "2026-09-02", channels: { kept: {} }, updatedAt: "old" };
assert.equal(syncAnalyticsMetadata(analytics, show), true);
assert.equal(analytics.premiere, "2026-09-03");
assert.deepEqual(analytics.channels, { kept: {} });
assert.equal(analytics.updatedAt, "old", "metadata sync alone does not claim a fresh analytics pull");

console.log("episode-date-sync.test: corrected registry day reaches postlive, comments, and analytics metadata without touching observations");
