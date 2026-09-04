#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  broadcastIdFromUrls,
  existingShowForXBroadcast,
  normalizedEpisodeTitle,
} from "../../../scripts/restream/postlive-discover.mjs";
import { findExistingShow } from "../../../scripts/restream/postlive-track.mjs";

const e8 = { slug: "e8-dive-radio", title: "Dive Radio: How to Engineer a Brand Universe", date: "2026-09-03", active: true };
const e7 = { slug: "e7-dive-radio", title: "Dive Radio: Steal These AI Design Patterns", date: "2026-08-27", active: true };
const broadcastId = broadcastIdFromUrls([
  "https://t.co/short",
  "https://x.com/i/broadcasts/1AxRnZzVQkDxl",
]);
assert.equal(broadcastId, "1AxRnZzVQkDxl");
assert.equal(broadcastIdFromUrls(["https://youtube.com/watch?v=abc123"]), null);
assert.equal(normalizedEpisodeTitle("Dive Radio: How to Engineer a Brand Universe"), "dive radio how to engineer a brand universe");

const exact = { broadcastId, date: "2026-09-04", text: `${e8.title} https://t.co/short` };
assert.equal(existingShowForXBroadcast(exact, [e7, e8]), e8, "an exact title attaches even when the post date differs");

const sameDay = { broadcastId, date: e8.date, text: "Dive Radio is live" };
assert.equal(existingShowForXBroadcast(sameDay, [e7, e8]), e8, "one same-day episode is deterministic");
assert.equal(existingShowForXBroadcast(sameDay, [e8, { ...e8, slug: "other" }]), null, "ambiguous same-day shows fail closed");
assert.equal(existingShowForXBroadcast({ ...sameDay, broadcastId: null }, [e8]), null, "a plain mention is not treated as a broadcast");
assert.equal(existingShowForXBroadcast({ ...sameDay, date: "2026-09-09" }, [e7, e8]), null, "an unmatched date is never guessed");
assert.equal(findExistingShow([{ ...e8, slug: "2026-09-02-old-slug" }], e8.title, e8.date)?.slug, "2026-09-02-old-slug", "registration keeps the existing episode identity after a date correction");

console.log("x-broadcast-discovery.test: late broadcasts attach by exact title or one same-day episode; ambiguity fails closed");
