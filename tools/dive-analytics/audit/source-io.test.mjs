import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, readJsonFile, withSourceLock, fetchJson, readingEnvelope, validateReadingEnvelope, phoenixDateKey } from "../source-io.mjs";

const root = mkdtempSync(join(tmpdir(), "dive-source-io-"));
try {
  const path = join(root, "store.json");
  atomicWriteJson(path, { before: true });
  const before = readFileSync(path, "utf8");
  assert.throws(() => atomicWriteJson(path, { after: true }, { beforeRename() { throw new Error("interrupted"); } }), /interrupted/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.throws(() => withSourceLock(path, () => withSourceLock(path, () => {})), /already in use/);
  await assert.rejects(withSourceLock(path, async () => { throw new Error("child failed"); }), /child failed/);
  withSourceLock(path, () => atomicWriteJson(path, { after: true }));
  writeFileSync(`${path}.lock.tmp`, JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }));
  withSourceLock(path, () => assert.deepEqual(readJsonFile(path), { after: true }));
  writeFileSync(path, "bad json");
  assert.throws(() => readJsonFile(path, { fallback: {} }), /unreadable/);
  assert.deepEqual(readJsonFile(join(root, "missing"), { fallback: {} }), {});
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(fetchJson("https://fixture/?secret=hidden", {
      fetchImpl: async () => { calls++; return { status, ok: false }; }, sleep: async () => {},
    }), (error) => !error.message.includes("hidden") && error.message.includes(`HTTP ${status}`));
    assert.equal(calls, status === 429 || status >= 500 ? 2 : 1);
  }
  let calls = 0;
  await assert.rejects(fetchJson("fixture", { fetchImpl: async () => { calls++; throw new Error("secret"); } }), /timed out/);
  assert.equal(calls, 2);
  for (const value of [null, undefined, "", 42]) await assert.rejects(fetchJson("fixture", { fetchImpl: async () => ({ ok: true, json: async () => value }) }), /invalid/);
  await assert.rejects(fetchJson("fixture", { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("parse"); } }) }), /malformed/);
  assert.equal(await fetchJson("fixture", { allow404: true, fetchImpl: async () => ({ status: 404, ok: false }) }), null);
  const reading = readingEnvelope({ source: "youtube-data", episode: "ep", objectId: "video", pulledAt: "2026-09-04T06:30:00Z" });
  assert.deepEqual(validateReadingEnvelope(reading, { source: "youtube-data", episode: "ep", objectId: "video", now: "2026-09-04T07:00Z" }), []);
  assert.equal(validateReadingEnvelope(reading, { objectId: "wrong" }).length, 1);
  assert.equal(validateReadingEnvelope(reading, { now: "2026-09-04T06:00Z" }).length, 1);
  assert.equal(phoenixDateKey(reading.pulledAt), "2026-09-03");
  console.log("source-io: atomic interruption, live/dead locks, corrupt stores, bounded HTTP failures, sanitized errors and provenance passed");
} finally { rmSync(root, { recursive: true, force: true }); }
