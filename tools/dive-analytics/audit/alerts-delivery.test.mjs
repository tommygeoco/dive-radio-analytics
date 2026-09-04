// alerts-delivery.test.mjs — pending lines leave the queue only after an
// acknowledged Slack send; producer writes during delivery survive.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertLines, deliveryId, detectAndQueue, deliverPending } from "../alerts.mjs";
import { appendQueueLines, readQueue } from "../alert-queue.mjs";

const dir = mkdtempSync(join(tmpdir(), "dive-alert-delivery."));
const queue = join(dir, "pending.json");
const reset = (lines) => {
  writeFileSync(queue, JSON.stringify(lines, null, 2) + "\n");
  if (existsSync(`${queue}.receipts.json`)) unlinkSync(`${queue}.receipts.json`);
};
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

  reset(["one"]);
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
  const confirmed = JSON.parse(readFileSync(`${queue}.receipts.json`, "utf8")).attempts.at(-1);
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.receipt, "slack-123");
  assert.ok(Number.isFinite(Date.parse(confirmed.acknowledgedAt)));
  assert.deepEqual(confirmed.lines, ["one"], "durable provider evidence identifies exactly the acknowledged lines");

  for (const invalid of [{ ts: "123.456" }, { ok: false, result: { messageId: "bad" } }, { dryRun: true, messageId: "bad" }, { metadata: { ts: "123.456", messageId: "bad" } }, { result: { error: "failed", messageId: "bad" } }]) {
    assert.equal(deliveryId(invalid), null, "non-message timestamps and failed/dry results never acknowledge queued warnings");
  }
  assert.equal(deliveryId({ payload: { result: { channelId: "Ctest", ts: "123.456" } } }), "123.456");

  reset(["crash after receipt"]);
  let crashSends = 0;
  const crashSend = () => { crashSends++; return { status: 0, stdout: JSON.stringify({ result: { messageId: "crash-proof" } }) }; };
  assert.throws(() => deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: crashSend, log: () => {}, acknowledge: () => { throw new Error("simulated interruption after receipt"); } }), /simulated interruption/);
  assert.deepEqual(readQueue(queue), ["crash after receipt"]);
  assert.equal(JSON.parse(readFileSync(`${queue}.receipts.json`, "utf8")).attempts.at(-1).state, "confirmed");
  deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: crashSend, log: () => {} });
  assert.equal(crashSends, 1, "a saved provider receipt prevents duplicate sending after restart");
  assert.deepEqual(readQueue(queue), []);

  reset(["old confirmed line"]);
  assert.throws(() => deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: crashSend, log: () => {}, acknowledge: () => { throw new Error("receipt persisted before acknowledgement"); } }), /before acknowledgement/);
  appendQueueLines(["new producer line"], queue);
  const recoveredMessages = [];
  const changedBatch = deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, log: () => {}, send: (args) => {
    recoveredMessages.push(args[args.indexOf("--message") + 1]);
    return { status: 0, stdout: JSON.stringify({ messageId: "new-line-receipt" }) };
  } });
  assert.equal(recoveredMessages.length, 1);
  assert.match(recoveredMessages[0], /new producer line/);
  assert.doesNotMatch(recoveredMessages[0], /old confirmed line/, "a new producer line cannot cause the previously confirmed batch to be resent");
  assert.deepEqual(changedBatch.receipts, ["crash-proof", "new-line-receipt"]);
  assert.deepEqual(readQueue(queue), []);
  appendQueueLines(["old confirmed line"], queue);
  deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, log: () => {}, send: (args) => {
    recoveredMessages.push(args[args.indexOf("--message") + 1]);
    return { status: 0, stdout: JSON.stringify({ messageId: "new-event-receipt" }) };
  } });
  assert.equal(recoveredMessages.length, 2, "a completed acknowledgement does not suppress a later newly queued event");

  reset(["unconfirmed send"]);
  let uncertainSends = 0;
  const unconfirmedSend = () => { uncertainSends++; return { status: null, error: new Error("timeout") }; };
  assert.throws(() => deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: unconfirmedSend, log: () => {} }), /Slack send failed/);
  appendQueueLines(["new line after ambiguous result"], queue);
  assert.throws(() => deliverPending({ queuePath: queue, target: "user:test", chainGuard: noChain, send: unconfirmedSend, log: () => {} }), /unconfirmed provider outcome/);
  assert.equal(uncertainSends, 1, "uncertain provider success is not blindly retried");
  assert.deepEqual(readQueue(queue), ["unconfirmed send", "new line after ambiguous result"]);

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

  const dataPath = join(dir, "data.json");
  const statePath = join(dir, "runtime-state.json");
  const legacyStatePath = join(dir, "legacy-state.json");
  writeFileSync(dataPath, JSON.stringify(data));
  writeFileSync(legacyStatePath, JSON.stringify(prev));
  const legacyBytes = readFileSync(legacyStatePath, "utf8");
  reset([]);
  const detected = detectAndQueue({ dataPath, statePath, legacyStatePath, queuePath: queue, snapshot: () => cur });
  assert.equal(detected.count, 1);
  assert.equal(readFileSync(legacyStatePath, "utf8"), legacyBytes, "legacy tracked detection state is never changed");
  assert.equal(existsSync(`${statePath}.initialized-v1`), true);
  unlinkSync(statePath);
  assert.throws(() => detectAndQueue({ dataPath, statePath, legacyStatePath, queuePath: queue, snapshot: () => cur }), /missing after initialization/);
  assert.equal(existsSync(`${statePath}.lock`), false);
} finally {
  rmSync(dir, { force: true, recursive: true });
}

console.log("alerts-delivery.test: empty, send failure, missing receipt, provider receipt, chain-aware deferral, concurrent producer/deliverer, and promo alert checks pass");
