import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xPublicGet } from "../../../scripts/restream/x-public-get.mjs";
import { discoverX } from "../../../scripts/restream/postlive-discover.mjs";
import { fetchXStats } from "../../../scripts/restream/postlive-track.mjs";
import { pullXTarget } from "../../../scripts/restream/comments-pull.mjs";
import { runChannelStats, YT_CHANNELS, X_USERS } from "../../../scripts/restream/channel-stats-pull.mjs";

const requests = [];
let answer = () => ({ data: [] });
const run = (bin, args, options) => {
  if (args.includes("token")) throw new Error("personal OAuth login failed");
  assert.equal(bin, "/opt/homebrew/bin/xurl");
  assert.deepEqual(args.slice(0, 6), ["--app", "hinterlands", "--auth", "app", "--method", "GET"]);
  assert.equal(args.length, 7);
  assert.equal(options.env, undefined, "credentials are never passed in a new environment");
  assert.equal(options.timeout, 30_000);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  const url = new URL(args[6]); requests.push(url);
  return { status: 0, stdout: JSON.stringify(answer(url)) };
};
const get = (url) => xPublicGet(url, { run });
// A broken personal login cannot affect any of the four public-read callers.
answer = (url) => url.pathname.includes("/by/username/") ? { data: { id: "123" } }
  : url.searchParams.has("pagination_token") ? { data: [], meta: { result_count: 0 } }
  : { data: [{ id: "fixture-post", text: "Dive Radio fixture", created_at: new Date().toISOString() }], meta: { next_token: "page two&opaque" } };
const discovery = await discoverX(new Set(), { get });
assert.ok(discovery.accounts.every((row) => row.success));
assert.equal(requests.filter((url) => url.searchParams.get("pagination_token") === "page two&opaque").length, 2);
assert.ok(requests.filter((url) => url.pathname.endsWith("/tweets")).every((url) => url.searchParams.get("max_results") === "100" && url.searchParams.get("exclude") === "retweets"));
answer = (url) => ({ data: url.searchParams.get("ids").split(",").map((id) => ({ id })) });
requests.length = 0;
const stats = await fetchXStats(Array.from({ length: 101 }, (_, i) => String(i + 1)), { get });
assert.equal(requests.length, 2); assert.equal(Object.keys(stats).length, 101);
assert.equal(stats["1"].views, null, "missing metrics remain absent");
assert.ok(requests.every((url) => url.searchParams.get("media.fields") === "type"));
requests.length = 0;
answer = (url) => ({ data: [], meta: url.searchParams.has("next_token") ? {} : { next_token: "reply page&two" } });
await pullXTarget({ slug: "fixture" }, { postId: "123", account: "ridd_design" }, { now: new Date().toISOString(), get });
assert.equal(requests.length, 2);
assert.equal(requests[1].searchParams.get("next_token"), "reply page&two");
assert.equal(requests[0].searchParams.get("query"), "conversation_id:123 is:reply");
const root = mkdtempSync(join(tmpdir(), "dive-x-app-"));
try {
  answer = () => ({ data: X_USERS.map((user, i) => ({ id: String(i + 1), username: user.username, public_metrics: { followers_count: 0, tweet_count: 0 } })) });
  await runChannelStats({ root, now: "2026-09-07T16:00:00Z", apiKey: "fixture", xGet: get, log() {}, fetchImpl: async (url) => {
    assert.ok(url.includes("googleapis"));
    return { ok: true, json: async () => ({ items: YT_CHANNELS.map((channel) => ({ id: channel.id, statistics: { subscriberCount: "0", viewCount: "0", videoCount: "0" } })) }) };
  } });
  const store = JSON.parse(readFileSync(join(root, "data/restream/channel-stats.json")));
  assert.equal(store.capture.state, "ready"); assert.equal(store.current["x:ridd_design"].followers, 0);
} finally { rmSync(root, { recursive: true, force: true }); }

for (const url of ["http://api.x.com/2/tweets", "https://other.test/2/tweets", "https://user:pass@api.x.com/2/tweets", "https://api.x.com:444/2/tweets", "https://api.x.com/2/users/me", "https://api.x.com/2/tweets?access_token=fixture", "https://api.x.com/2/tweets#fragment", "not a URL"]) {
  await assert.rejects(xPublicGet(url, { run: () => { assert.fail("invalid target reached xurl"); } }), /X public request/);
}
const url = "https://api.x.com/2/tweets?ids=123";
for (const status of [401, 403, 429]) {
  let calls = 0;
  await assert.rejects(xPublicGet(url, { run: () => { calls++; return { status: 1, stdout: JSON.stringify({ status, detail: "PRIVATE_DIAGNOSTIC" }), stderr: "PRIVATE_DIAGNOSTIC" }; } }), (error) => {
    assert.equal(error.message, `X app request returned HTTP ${status}`); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls, 1, "authorization and rate limits do not trigger a retry or credential fallback");
}
for (const result of [{ status: 1, stderr: "PRIVATE_DIAGNOSTIC" }, { status: 0, stdout: "PRIVATE_DIAGNOSTIC" }, { status: 0, stdout: JSON.stringify({ data: [], errors: [{ detail: "PRIVATE_DIAGNOSTIC" }] }) }, { error: new Error("PRIVATE_DIAGNOSTIC") }, { status: null, signal: "SIGTERM" }]) {
  await assert.rejects(xPublicGet(url, { run: () => result }), (error) => { assert.doesNotMatch(String(error), /PRIVATE_DIAGNOSTIC/); assert.equal(error.cause, undefined); return true; });
}
let attempts = 0, sleeps = 0;
await xPublicGet(url, { run: () => ++attempts === 1 ? { status: 1, stdout: '{"status":503}' } : { status: 0, stdout: '{"data":[]}' }, sleep: async (ms) => { assert.equal(ms, 250); sleeps++; } });
assert.equal(attempts, 2); assert.equal(sleeps, 1);
attempts = 0;
await assert.rejects(xPublicGet(url, { run: () => { attempts++; throw new Error("PRIVATE_DIAGNOSTIC"); } }), /after 2 attempts/);
assert.equal(attempts, 2);
for (const name of ["postlive-discover", "postlive-track", "comments-pull", "channel-stats-pull"]) {
  const source = readFileSync(new URL(`../../../scripts/restream/${name}.mjs`, import.meta.url), "utf8");
  assert.match(source, /xPublicGet/); assert.doesNotMatch(source, /xBearer|bearerToken|Authorization|\["token"/);
}
console.log("x-public-get: app-only auth, four callers, pages/batches, honest absence, endpoint restrictions, bounded retries and secret-free failures passed");
