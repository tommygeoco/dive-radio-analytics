// alert-queue.test.mjs — producers cannot overwrite each other, corruption is
// retained, and delivery acknowledges only the lines it actually sent.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeQueueLines, acquireLock, appendQueueLines, importLegacyQueueFile, readQueue, resolveOperationalAlerts } from "../alert-queue.mjs";

const dir = mkdtempSync(join(tmpdir(), "dive-alert-queue."));
const queue = join(dir, "pending.json");
try {
  assert.throws(() => readQueue(queue), /missing/, "a vanished tracked queue is not absence-as-zero");
  writeFileSync(queue, "[]\n");
  appendQueueLines(["one"], queue);
  appendQueueLines(["two", "one"], queue);
  assert.deepEqual(readQueue(queue), ["one", "two"]);

  const delivered = readQueue(queue);
  appendQueueLines(["arrived during delivery"], queue);
  acknowledgeQueueLines(delivered, queue);
  assert.deepEqual(readQueue(queue), ["arrived during delivery"]);

  const legacy = join(dir, "legacy.json");
  writeFileSync(legacy, JSON.stringify(["old operational warning", "material audience note"]) + "\n");
  assert.deepEqual(importLegacyQueueFile(legacy, queue), ["old operational warning", "material audience note"]);
  assert.deepEqual(readQueue(queue), ["arrived during delivery", "old operational warning", "material audience note"], "legacy lines are durably appended before a checkout retires its tracked queue");

  appendQueueLines(["Daily publish recovery failed.", "Prod dashboard is stale.", "chain: capture failed.", "Newest episode YouTube watch data is still unavailable after the 2026-09-02 recovery run."], queue);
  const deliveryRelease = acquireLock(`${queue}.delivery.lock`, { label: "alert delivery" });
  assert.throws(() => resolveOperationalAlerts(queue, { checks: 1 }), /already in use/, "success cannot rewrite the queue under an in-flight delivery");
  assert.equal(readQueue(queue).includes("Daily publish recovery failed."), true);
  deliveryRelease();
  resolveOperationalAlerts(queue);
  assert.deepEqual(readQueue(queue), ["arrived during delivery", "old operational warning", "material audience note", "Daily publish recovery failed.", "chain: capture failed.", "Newest episode YouTube watch data is still unavailable after the 2026-09-02 recovery run."], "production proof clears stale-production warnings but keeps incomplete-checklist and source warnings");
  resolveOperationalAlerts(queue, { includeChecklist: true });
  assert.deepEqual(readQueue(queue), ["arrived during delivery", "old operational warning", "material audience note", "Newest episode YouTube watch data is still unavailable after the 2026-09-02 recovery run."], "a completed checklist does not clear a source warning without explicit source proof");
  resolveOperationalAlerts(queue, { includeYoutubeWatch: true });
  assert.deepEqual(readQueue(queue), ["arrived during delivery", "old operational warning", "material audience note"], "a complete watch read with production proof clears the stale source warning");

  const lock = `${queue}.delivery.lock`;
  const release = acquireLock(lock, { label: "alert delivery" });
  assert.throws(() => acquireLock(lock, { label: "alert delivery" }), /already in use/);
  release();
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }) + "\n");
  assert.throws(() => acquireLock(lock, { label: "alert delivery", maxAgeMs: 1 }), /already in use/, "a live owner is never evicted because its work ran long");
  unlinkSync(lock);

  writeFileSync(queue, "{broken\n");
  assert.throws(() => readQueue(queue), /JSON/);
  assert.equal(readFileSync(queue, "utf8"), "{broken\n", "corruption is retained for diagnosis");
} finally {
  rmSync(dir, { force: true, recursive: true });
}

console.log("alert-queue.test: missing and corrupt fail loud; migration, selective resolution, dedupe, exact acknowledgment, and live-owner locks pass");
