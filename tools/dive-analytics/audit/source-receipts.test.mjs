#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  metricViewsTotal,
  snapshotSourceCoverage,
  xStatsOf,
} from "../../../scripts/restream/postlive-track.mjs";
import { discoverX } from "../../../scripts/restream/postlive-discover.mjs";
import { buildLatest, compactSnap } from "../build-data.mjs";
import {
  accountCoverageErrors,
  appendSourceReceipt,
  readSourceReceipts,
} from "../../../scripts/restream/source-receipts.mjs";

const missing = xStatsOf({ id: "missing" });
for (const field of ["views", "likes", "replies", "reposts", "bookmarks", "quotes"]) {
  assert.equal(missing[field], null, `missing X ${field} must stay null`);
}
assert.equal(missing.publicMetricsAvailable, false);

const explicitZero = xStatsOf({
  id: "zero",
  public_metrics: {
    impression_count: 0,
    like_count: 0,
    reply_count: 0,
    retweet_count: 0,
    bookmark_count: 0,
    quote_count: 0,
  },
});
for (const field of ["views", "likes", "replies", "reposts", "bookmarks", "quotes"]) {
  assert.equal(explicitZero[field], 0, `explicit X ${field} zero must stay zero`);
}
assert.equal(explicitZero.publicMetricsAvailable, true);
assert.equal(metricViewsTotal({ "x:ridd_design": missing, "x:designertom": explicitZero }, "x:"), null);
assert.equal(metricViewsTotal({ "x:ridd_design": explicitZero, "x:designertom": explicitZero }, "x:"), 0);
const compactMissing = compactSnap({ ts: "2026-09-04T14:00:00.000Z", metrics: {
  "x:ridd_design": { views: null, detail: { likes: null, replies: null } },
  "x:designertom": { views: 0, detail: { likes: 0, replies: 0 } },
} });
assert.equal(compactMissing.byDest["x:ridd_design"].likes, null);
assert.equal(compactMissing.byDest["x:ridd_design"].comments, null);
assert.equal(buildLatest({ targets: [] }, compactMissing, null).xImpressions, null);

const metric = (views) => ({
  views,
  likes: 0,
  replies: 0,
  reposts: 0,
  bookmarks: 0,
  quotes: 0,
  publicMetricsAvailable: true,
});
const shows = [
  {
    date: "2026-09-03",
    targets: [
      { kind: "youtube", account: "joindiveclub", videoId: "yd" },
      { kind: "youtube", account: "designertom", videoId: "yt" },
      { kind: "x", account: "ridd_design", postId: "xr", broadcastId: "br" },
      { kind: "x", account: "designertom", postId: "xt", broadcastId: "bt" },
    ],
  },
  {
    date: "2026-08-27",
    targets: [
      { kind: "x", account: "ridd_design", postId: "old-xr", broadcastId: "old-br" },
      { kind: "x", account: "designertom", postId: "old-xt", broadcastId: "old-bt" },
    ],
  },
];
const attempts = {
  youtube: { attempted: true, success: true, error: null },
  x: { attempted: true, success: true, error: null },
  xBroadcast: { attempted: true, success: true, error: null },
};
const complete = snapshotSourceCoverage({
  shows,
  ytStats: { yd: { views: 12 }, yt: { views: 9 } },
  xStats: { xr: metric(20), xt: metric(17) },
  broadcastStats: { br: { views: 8 }, bt: { views: 7 } },
  attempts,
});
assert.equal(complete.status, "ok", "an older missing broadcast must not poison current coverage");

const missingCurrentX = snapshotSourceCoverage({
  shows,
  ytStats: { yd: { views: 12 }, yt: { views: 9 } },
  xStats: { xr: metric(20), xt: missing },
  broadcastStats: { br: { views: 8 }, bt: { views: 7 } },
  attempts,
});
assert.equal(missingCurrentX.status, "partial");
assert.match(missingCurrentX.errors.join("\n"), /x:designertom: read 0 of 1/);

const xLookup = await discoverX(new Set(), {
  bearerToken: "fixture-token",
  get: async (url) => {
    if (url.includes("/by/username/ridd_design")) return { data: {} };
    if (url.includes("/by/username/designertom")) return { data: { id: "tom" } };
    if (url.includes("/users/tom/tweets")) return { meta: { result_count: 0 } };
    throw new Error(`unexpected fixture URL ${url}`);
  },
});
assert.equal(xLookup.accounts.find((row) => row.account === "ridd_design").success, false);
assert.equal(xLookup.accounts.find((row) => row.account === "designertom").success, true);

const dir = mkdtempSync(join(tmpdir(), "dive-source-receipts-"));
const receiptPath = join(dir, "source-receipts.json");
try {
  appendSourceReceipt("discovery", { finishedAt: "2026-09-04T14:00:00.000Z", status: "ok", sources: complete.sources }, { path: receiptPath });
  appendSourceReceipt("discovery", { finishedAt: "2026-09-04T14:01:00.000Z", status: "partial", sources: missingCurrentX.sources }, { path: receiptPath });
  appendSourceReceipt("snapshot", { finishedAt: "2026-09-04T14:02:00.000Z", status: "ok", sources: complete.sources }, { path: receiptPath });
  appendSourceReceipt("snapshot", { finishedAt: "2026-09-04T14:03:00.000Z", status: "partial", sources: missingCurrentX.sources }, { path: receiptPath });
  const store = readSourceReceipts(receiptPath);
  assert.equal(store.discoveries.length, 2);
  assert.equal(store.snapshots.length, 2);
  assert.equal(store.lastSuccessfulDiscoveryAt, "2026-09-04T14:00:00.000Z");
  assert.equal(store.lastSuccessfulSnapshotAt, "2026-09-04T14:02:00.000Z");
  assert.equal(store.updatedAt, "2026-09-04T14:03:00.000Z");
  assert.equal(store.snapshots.at(-1).ts, "2026-09-04T14:03:00.000Z");
  assert.deepEqual(accountCoverageErrors(complete.sources.x, ["ridd_design", "designertom"]), []);
  assert.match(accountCoverageErrors(missingCurrentX.sources.x, ["ridd_design", "designertom"]).join("\n"), /designertom/);
  JSON.parse(readFileSync(receiptPath, "utf8"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("source receipts: missing X stays null; partial current sources fail closed; receipts are append-only");
