// alerts-delivery.test.mjs — pending lines leave the queue only after an
// acknowledged Slack send; producer writes during delivery survive.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertLines, deliverPending } from "../alerts.mjs";
import { appendQueueLines, readQueue } from "../alert-queue.mjs";

const dir = mkdtempSync(join(tmpdir(), "dive-alert-delivery."));
const queue = join(dir, "pending.json");
const reset = (lines) => writeFileSync(queue, JSON.stringify(lines, null, 2) + "\n");
const noChain = () => () => {};

try {
  reset([]);
  let calls = 0;
  assert.deepEqual(deliverPending({ queuePath: queue, target: "user:test", log: () => {}, chainGuard: noChain, send: () => { calls++; return { status: 0, stdout: "{}" }; } }), { sent: 0, receipts: [] });
  assert.equal(calls, 0);

  reset(["one"]);
  assert.throws(() => deliverPending({
    queuePath: queue,
    target: "user:test",
    log: () => {},
    chainGuard: noChain,
    send: () => ({ status: 1, stderr: "offline" }),
  }), /Slack send failed/);
  assert.deepEqual(readQueue(queue), ["one"]);

  assert.throws(() => deliverPending({
    queuePath: queue,
    target: "user:test",
    log: () => {},
    chainGuard: noChain,
    send: () => ({ status: 0, stdout: JSON.stringify({ ok: true }) }),
  }), /no message receipt/);
  assert.deepEqual(readQueue(queue), ["one"]);

  const sentArgs = [];
  const result = deliverPending({
    queuePath: queue,
    channel: "slack",
    account: "default",
    target: "user:test",
    log: () => {},
    chainGuard: noChain,
    send: (args) => {
      sentArgs.push(args);
      appendQueueLines(["arrived during send"], queue);
      assert.throws(() => deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: () => ({ status: 0, stdout: "{}" }) }), /already in use/);
      return { status: 0, stdout: JSON.stringify({ ok: true, result: { messageId: "slack-123" } }) };
    },
  });
  assert.deepEqual(result, { sent: 1, receipts: ["slack-123"] });
  assert.deepEqual(readQueue(queue), ["arrived during send"]);
  assert.deepEqual(sentArgs[0].slice(0, 8), ["message", "send", "--channel", "slack", "--account", "default", "--target", "user:test"]);

  reset(["Daily publish recovery failed; production still needs attention."]);
  let staleSend = 0;
  const deferred = deliverPending({
    queuePath: queue,
    target: "user:test",
    log: () => {},
    chainGuard: () => { throw new Error("daily publishing chain is already in use"); },
    send: () => { staleSend++; return { status: 0, stdout: JSON.stringify({ messageId: "should-not-send" }) }; },
  });
  assert.deepEqual(deferred, { sent: 0, receipts: [], deferred: true }, "delivery waits while a publish or recovery proof can still resolve the warning");
  assert.equal(staleSend, 0, "an operational warning is never sent while a success proof is in flight");
  assert.equal(readQueue(queue).length, 1, "the deferred warning remains queued until proof resolves it or delivery retries");

  const prev = { episodeCount: 1, newestSlug: "one", paceRank: null, complaints: { one: 0 }, reviewCount: 0, w1v: {}, staleCount: 0, promoFlagged: [], healthCheckSet: null };
  const cur = { ...prev, promoFlagged: ["one"] };
  const data = { episodes: [{ slug: "one", ep: 1, title: "Dive Radio: Test" }], showTrend: {}, baselines: {} };
  assert.match(alertLines(prev, cur, data).at(-1).text, /E1 \(Test\)/, "promo flag alerts do not crash on the episode title");
} finally {
  rmSync(dir, { force: true, recursive: true });
}

console.log("alerts-delivery.test: empty, send failure, missing receipt, provider receipt, chain-aware deferral, concurrent producer/deliverer, and promo alert checks pass");
