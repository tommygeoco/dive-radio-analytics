import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChannelStats, YT_CHANNELS, X_USERS } from "../../../scripts/restream/channel-stats-pull.mjs";
const root = mkdtempSync(join(tmpdir(), "dive-channels-"));
const now = "2026-09-04T06:59:00.000Z";
const yt = { items: YT_CHANNELS.map((channel) => ({ id: channel.id, statistics: { subscriberCount: "0", viewCount: "12", videoCount: "2" } })) };
const x = { data: X_USERS.map((user, index) => ({ id: `id${index}`, username: user.username, public_metrics: { followers_count: 0, tweet_count: 2 } })) };
const response = (value) => ({ ok: true, json: async () => value });
const fetchImpl = async (url) => response(url.includes("googleapis") ? yt : x);
try {
  const path = join(root, "data", "restream", "channel-stats.json");
  await runChannelStats({ root, now, apiKey: "fixture", bearer: "fixture", fetchImpl, log() {} });
  let store = JSON.parse(readFileSync(path));
  assert.equal(Object.keys(store.current).length, 4);
  assert.equal(store.series[YT_CHANNELS[0].key][0].date, "2026-09-03");
  assert.equal(store.series[YT_CHANNELS[0].key][0].subscribers, 0);
  assert.equal(store.current[YT_CHANNELS[0].key].reading.objectId, YT_CHANNELS[0].id);
  const series = JSON.stringify(store.series), current = JSON.stringify(store.current);
  await runChannelStats({ root, now, apiKey: "fixture", bearer: "fixture", fetchImpl, log() {} });
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path)).series), series);
  for (const malformed of [{}, { items: [] }, { items: [yt.items[0]] }, { items: [yt.items[0], yt.items[0]] }, { items: yt.items.map((item) => ({ ...item, statistics: { subscriberCount: null, viewCount: "12", videoCount: "2" } })) }]) {
    await assert.rejects(runChannelStats({ root, now, apiKey: "fixture", bearer: "fixture", fetchImpl: async (url) => response(url.includes("googleapis") ? malformed : x), log() {} }), /incomplete/);
    store = JSON.parse(readFileSync(path)); assert.equal(JSON.stringify(store.series), series); assert.equal(JSON.stringify(store.current), current); assert.equal(store.capture.state, "failed");
  }
  await assert.rejects(runChannelStats({ root, now, apiKey: null, bearer: null, log() {} }), /credential/);
  console.log("channel-stats: all-account cohort, IDs, missing counts, explicit zeroes, Phoenix rollover, idempotence and partial preservation passed");
} finally { rmSync(root, { recursive: true, force: true }); }
