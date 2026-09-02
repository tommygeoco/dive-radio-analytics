// alert-queue.test.mjs — producers cannot overwrite each other, corruption is
// retained, and delivery acknowledges only the lines it actually sent.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeQueueLines, acquireLock, appendQueueLines, readQueue } from "../alert-queue.mjs";

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

  const lock = `${queue}.delivery.lock`;
  const release = acquireLock(lock, { label: "alert delivery" });
  assert.throws(() => acquireLock(lock, { label: "alert delivery" }), /already in use/);
  release();
  assert.equal(existsSync(lock), false);

  writeFileSync(queue, "{broken\n");
  assert.throws(() => readQueue(queue), /JSON/);
  assert.equal(readFileSync(queue, "utf8"), "{broken\n", "corruption is retained for diagnosis");
} finally {
  rmSync(dir, { force: true, recursive: true });
}

console.log("alert-queue.test: missing and corrupt fail loud; dedupe, producer retention, exact acknowledgment, and delivery lock pass");
