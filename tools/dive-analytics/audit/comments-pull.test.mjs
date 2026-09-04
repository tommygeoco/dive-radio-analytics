import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommentsPull, pullYouTubeTarget, pullXTarget } from "../../../scripts/restream/comments-pull.mjs";
const root = mkdtempSync(join(tmpdir(), "dive-comments-"));
const now = "2026-09-04T15:00:00.000Z";
const show = { slug: "dive-radio-fixture", title: "Dive Radio", date: "2026-09-03", targets: [{ kind: "youtube", account: "dive", videoId: "video" }, { kind: "x", account: "ridd_design", postId: "post" }] };
const sn = (text = "Useful") => ({ textDisplay: text, publishedAt: "2026-09-03T20:00:00Z", authorDisplayName: "viewer", likeCount: 0 });
const response = (value) => ({ ok: true, status: 200, json: async () => value });
try {
  const dir = join(root, "data", "restream"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "postlive-registry.json"), JSON.stringify({ shows: [show, { ...show, slug: "dive-radio-future", date: "2026-09-05" }] }));
  const path = join(dir, "comments", `${show.slug}.json`);
  let calls = 0;
  await assert.rejects(runCommentsPull({ root, now, apiKey: "fixture", bearer: "fixture", log() {}, fetchImpl: async (url) => {
    calls++;
    if (url.includes("googleapis")) return response({ items: [{ snippet: { topLevelComment: { id: "c1", snippet: sn() }, totalReplyCount: 0 } }] });
    return { ok: false, status: 401 };
  } }), /incomplete/);
  let store = JSON.parse(readFileSync(path));
  assert.equal(store.comments.length, 0); assert.equal(store.xCoverage, undefined); assert.equal(store.updatedAt, undefined); assert.equal(store.capture.state, "failed"); assert.equal(calls, 2);
  await runCommentsPull({ root, now, apiKey: "fixture", bearer: "fixture", log() {}, fetchImpl: async (url) => response(url.includes("googleapis")
    ? { items: [{ snippet: { topLevelComment: { id: "c1", snippet: sn() }, totalReplyCount: 0 } }] }
    : { meta: { result_count: 0 } }) });
  store = JSON.parse(readFileSync(path));
  assert.equal(store.comments.length, 1); assert.equal(store.comments[0].likes, 0); assert.equal(store.comments[0].reading.objectId, "c1"); assert.equal(store.xCoverage, "covered");
  const previous = JSON.stringify(store.comments);
  await assert.rejects(runCommentsPull({ root, now: "2026-09-04T16:00:00Z", apiKey: null, bearer: null, log() {} }), /credential/);
  store = JSON.parse(readFileSync(path)); assert.equal(JSON.stringify(store.comments), previous); assert.equal(store.updatedAt, now);
  const replies = await pullYouTubeTarget(show, show.targets[0], { apiKey: "fixture", now, get: async (url) => {
    if (url.includes("commentThreads")) return { items: [{ snippet: { topLevelComment: { id: "top", snippet: sn() }, totalReplyCount: 2 } }] };
    if (url.includes("pageToken")) return { items: [{ id: "r2", snippet: sn("Second") }] };
    return { items: [{ id: "r1", snippet: sn("First") }], nextPageToken: "page-two" };
  } }); assert.deepEqual(replies.map((c) => c.id), ["yt:top", "yt:r1", "yt:r2"]);
  let pages = 0;
  const x = await pullXTarget(show, show.targets[1], { bearer: "fixture", now, get: async () => ({ data: [{ id: `x${++pages}`, author_id: "a", text: "Helpful", created_at: now, public_metrics: { like_count: 0 } }], meta: pages === 1 ? { next_token: "next" } : {} }) });
  assert.equal(x.length, 2);
  await assert.rejects(pullXTarget(show, show.targets[1], { bearer: "fixture", now, get: async () => ({}) }), /complete result/);
  await assert.rejects(pullYouTubeTarget(show, show.targets[0], { apiKey: "fixture", now, get: async () => ({}) }), /item list/);
  await assert.rejects(pullXTarget(show, show.targets[1], { bearer: "fixture", now, get: async () => ({ data: [], meta: { next_token: "same" } }) }), /pagination repeated/);
  writeFileSync(path, "broken");
  await assert.rejects(runCommentsPull({ root, now, apiKey: "fixture", bearer: "fixture", log() {} }), /unreadable/);
  assert.equal(readFileSync(path, "utf8"), "broken");
  console.log("comments-pull: complete pagination, truthful coverage, missing credentials, partial preservation, future skip, source zero and corrupt-store protection passed");
} finally { rmSync(root, { recursive: true, force: true }); }
