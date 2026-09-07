// recover-publish.test.mjs — a real failure uses the reserved attempt in the
// morning; a current build with late YouTube watch data saves it for noon.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checklistVerdict, recoverPublish as recoverPublishActual, recoveryAction } from "../recover-publish.mjs";
import { appendQueueLines, acknowledgeQueueLines, readQueue } from "../alert-queue.mjs";
import { nextAttempt, finishAttempt, saveAttemptState, readAttemptState, queueDailyFailure } from "../run-daily.mjs";
import { YOUTUBE_WATCH_PENDING_STATUS } from "../youtube-readiness.mjs";

const suite = mkdtempSync(join(tmpdir(), "dive-recovery-suite-"));
let fixture = 0;
const recoverPublish = (options) => recoverPublishActual({ statePath: join(suite, `${fixture++}.json`), recordProof: () => {}, ...options });
const HERE = dirname(fileURLToPath(import.meta.url));
const morning = Date.parse("2026-09-02T15:15:00Z");
const noon = Date.parse("2026-09-02T19:00:00Z");
// A first-ever preflight failure must alert even before a ledger exists.
{
  const statePath = join(suite, "first-preflight.json");
  const queued = [];
  let runs = 0;
  const options = {
    statePath, now: morning, guard: () => () => {},
    prepare: () => { throw new Error("fixture preparation failed"); },
    verify: async () => { assert.fail("failed preflight must not verify production"); },
    run: () => { runs++; return { status: 0 }; },
    queue: (lines) => queued.push(...lines),
    resolve: () => {},
  };
  assert.equal(await recoverPublish(options), 1);
  assert.equal(queued.length, 1, "first failure is queued without a pre-existing ledger");
  assert.equal(runs, 0);
  assert.deepEqual(readAttemptState(statePath).days, {}, "no capture attempt is fabricated");
  assert.equal(await recoverPublish(options), 1);
  assert.equal(queued.length, 1, "repeated preparation failure is still deduplicated");
  assert.equal(runs, 0);
  rmSync(statePath);
  await assert.rejects(recoverPublish(options), /missing after initialization/);
  assert.equal(queued.length, 1, "a lost initialized ledger is not reset or reported as new");
}

const fresh = { ok: true };
const stale = { ok: false };
const youtubePending = {
  ok: false,
  youtubeWatchPending: true,
  freshness: { ok: true },
  parity: { ok: true },
  checklist: { ok: false, youtubeWatchPending: true },
};
assert.equal(recoveryAction(fresh, morning), "done");
assert.equal(recoveryAction(stale, morning), "recover");
assert.equal(recoveryAction(stale, noon), "recover", "12:15 repairs a missed or failed morning when an attempt remains");
assert.equal(recoveryAction(stale, Date.parse("2026-09-02T20:30:00Z")), "fail", "outside both scheduled windows the checker does not start surprise work");
assert.equal(recoveryAction(youtubePending, morning), "defer", "08:15 keeps the second whole-chain attempt for noon");
assert.equal(recoveryAction(youtubePending, noon), "recover", "noon uses the reserved whole-chain attempt for the late report");
assert.equal(recoveryAction({ ...youtubePending, freshness: { ok: false } }, morning), "recover", "a real production problem still recovers in the morning");
assert.equal(recoveryAction({ ...youtubePending, parity: { ok: false } }, morning), "recover", "a public-file mismatch still recovers in the morning");

{
  const temp = mkdtempSync(join(tmpdir(), "dive-youtube-pending-state."));
  const statePath = join(temp, "daily-attempts.json");
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    timezone: "America/Phoenix",
    days: { "2026-09-02": [{ id: "one", mode: "primary", startedAt: "2026-09-02T14:00:00Z", status: YOUTUBE_WATCH_PENDING_STATUS }] },
    invocations: { "2026-09-02": [{ status: YOUTUBE_WATCH_PENDING_STATUS }] },
  }));
  const verdict = checklistVerdict(statePath, morning);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.youtubeWatchPending, true, "the persisted pending state drives the follow-up schedule");
  assert.match(verdict.message, /not ready yet/);
  rmSync(temp, { recursive: true, force: true });
}

{
  let runs = 0;
  const status = await recoverPublish({
    now: morning,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => youtubePending,
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 0, "the first follow-up proves current production but does not spend the noon attempt");
}

{
  let runs = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: noon,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => {
      checks++;
      return checks === 1
        ? youtubePending
        : { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 8 }, checklist: { ok: true } };
    },
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 1, "noon retries the whole chain rather than running a one-off YouTube patch");
  assert.equal(checks, 2);
}

{
  let runs = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: noon,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => {
      checks++;
      return checks === 1
        ? { ok: false, freshness: { ok: false, message: "no build today" }, parity: { ok: false, mismatches: [{ file: "data.json" }] }, checklist: { ok: false } }
        : { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 16 }, checklist: { ok: true } };
    },
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 1, "the noon check uses an available recovery when the morning never published");
  assert.equal(checks, 2);
}

{
  let runs = 0;
  const queued = [];
  const status = await recoverPublish({
    now: noon,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => youtubePending,
    run: () => { runs++; return { status: 0 }; },
    queue: (lines) => queued.push(...lines),
    resolve: () => {},
  });
  assert.equal(status, 0, "a second honest pending publication is not a recovery failure");
  assert.equal(runs, 1);
  assert.deepEqual(queued, [], "no false failure alert is sent when noon production is current and only YouTube remains pending");
}

{
  let runs = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: morning,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async ({ root }) => {
      assert.equal(root, "/isolated/publisher");
      checks++;
      return checks === 1
        ? { ok: false, freshness: { ok: false, message: "yesterday" }, parity: { ok: false, mismatches: [{ file: "data.json" }] } }
        : { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 8 } };
    },
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 1);
  assert.equal(checks, 2, "production is proved again after recovery");
}

{
  let runs = 0;
  const status = await recoverPublish({
    now: morning,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async ({ root }) => {
      assert.equal(root, "/isolated/publisher");
      return { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 8 } };
    },
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 0);
}

{
  let runs = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: morning,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => {
      checks++;
      return checks === 1
        ? { ok: false, freshness: { ok: true }, parity: { ok: true, checked: 8 }, checklist: { ok: false, message: "today's publishing checklist last ended failed:10" } }
        : { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 8 }, checklist: { ok: true } };
    },
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 0);
  assert.equal(runs, 1, "fresh production with an incomplete checklist still uses the morning recovery");
  assert.equal(checks, 2);
}

{
  let prepared = 0;
  let guardChecks = 0;
  const queued = [];
  const status = await recoverPublish({
    now: morning,
    guard: () => { guardChecks++; throw new Error("daily publishing chain is already in use"); },
    wait: async () => {},
    queue: (lines) => queued.push(...lines),
    resolve: () => {},
    prepare: () => { prepared++; return "/isolated/publisher"; },
  });
  assert.equal(status, 1);
  assert.equal(guardChecks, 4, "recovery makes a bounded set of lock checks");
  assert.equal(prepared, 0, "recovery never touches the isolated checkout while the daily chain owns it");
  assert.match(queued[0], /production was not confirmed/, "a skipped proof cannot look green");
}

{
  let guardChecks = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: morning,
    guard: () => {
      guardChecks++;
      if (guardChecks === 1) throw new Error("daily publishing chain is already in use");
      return () => {};
    },
    wait: async () => {},
    resolve: () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => { checks++; return { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 8 } }; },
  });
  assert.equal(status, 0);
  assert.equal(guardChecks, 2);
  assert.equal(checks, 1, "recovery proves production once the publisher becomes idle");
}

{
  let runs = 0;
  let resolved = 0;
  const status = await recoverPublish({
    now: noon,
    proofOnly: true,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => ({
      ok: false,
      youtubeWatchPending: true,
      receipt: { ok: true },
      freshness: { ok: true },
      parity: { ok: true, checked: 16 },
      checklist: { ok: false, youtubeWatchPending: true },
    }),
    run: () => { runs++; return { status: 0 }; },
    resolve: () => { resolved++; },
  });
  assert.equal(status, 0, "proof-only confirms current exact production even when the source checklist is honestly waiting");
  assert.equal(runs, 0, "proof-only can never spend a chain attempt");
  assert.equal(resolved, 0, "proof-only does not mutate the alert queue");
}

{
  let runs = 0;
  const status = await recoverPublish({
    now: noon,
    proofOnly: true,
    guard: () => () => {},
    prepare: () => "/isolated/publisher",
    verify: async () => ({
      ok: false,
      freshness: { ok: true },
      parity: { ok: true, checked: 16 },
      checklist: { ok: false, message: "today's publishing checklist could not be read" },
    }),
    run: () => { runs++; return { status: 0 }; },
    resolve: () => {},
  });
  assert.equal(status, 1, "proof-only cannot call fresh bytes green when the checklist is missing or unreadable");
  assert.equal(runs, 0);
}

const source = readFileSync(join(HERE, "..", "recover-publish.mjs"), "utf8");
assert.match(source, /run-daily\.mjs", "--recovery"/);
assert.doesNotMatch(source, /run-chain\.mjs/);
assert.match(source, /const after = await verify/);
assert.match(source, /return "defer"/);
assert.match(source, /NOON_START/);
assert.match(source, /proofOnly: process\.argv\.includes\("--proof-only"\)/);

console.log("recover-publish.test: fresh no-op, proof-only safety, morning recovery, late-YouTube noon retry, post-run proof, and overlap guard pass");

// Real queue acknowledgement must not remove the durable daily failure marker.
const day = "2026-09-02";
const makeState = (count) => {
  let state = { version: 1, timezone: "America/Phoenix", days: {}, invocations: {}, youtubeWatchAlerts: {}, failureAlerts: {} };
  for (let i = 0; i < count; i++) {
    const attempt = nextAttempt(state, morning, { mode: i ? "recovery" : "primary", id: `attempt-${i}` });
    state = finishAttempt(attempt.state, day, attempt.id, "failed:1", morning);
  }
  return state;
};
for (const alreadyReported of [false, true]) {
  const statePath = join(suite, `exhausted-${alreadyReported}.json`);
  const queuePath = join(suite, `queue-${alreadyReported}.json`);
  writeFileSync(queuePath, "[]");
  saveAttemptState(statePath, makeState(2));
  const queue = (lines) => appendQueueLines(lines, queuePath);
  if (alreadyReported) {
    queueDailyFailure(statePath, day, "Daily publishing checklist failed (exit 1)", queue, null);
    acknowledgeQueueLines(readQueue(queuePath), queuePath);
  }
  const attemptsBefore = JSON.stringify(readAttemptState(statePath).days);
  let runs = 0;
  const options = { statePath, now: morning, prepare: () => "/fixture", verify: async () => stale,
    queue, run: () => { runs++; return { status: 75 }; } };
  assert.equal(await recoverPublish(options), 75);
  assert.equal(runs, 0, "an exhausted hard failure must not launch run-daily at all");
  assert.equal(readQueue(queuePath).length, alreadyReported ? 0 : 1);
  acknowledgeQueueLines(readQueue(queuePath), queuePath);
  assert.equal(await recoverPublish({ ...options, now: noon }), 75);
  assert.equal(readQueue(queuePath).length, 0, "queue drain must not rearm the exhausted warning");
  assert.equal(runs, 0);
  assert.equal(JSON.stringify(readAttemptState(statePath).days), attemptsBefore, "past attempts are never rewritten");
}
{
  const statePath = join(suite, "child-failure.json"), queuePath = join(suite, "child-queue.json");
  saveAttemptState(statePath, makeState(1)); writeFileSync(queuePath, "[]");
  const queue = (lines) => appendQueueLines(lines, queuePath);
  let runs = 0;
  const options = { statePath, now: morning, prepare: () => "/fixture", verify: async () => stale, queue,
    run: () => {
      runs++;
      const attempt = nextAttempt(readAttemptState(statePath), morning, { mode: "recovery", id: "second" });
      saveAttemptState(statePath, finishAttempt(attempt.state, day, attempt.id, "failed:1", morning));
      queueDailyFailure(statePath, day, "Daily publishing checklist failed (exit 1)", queue, null);
      return { status: 1 };
    } };
  assert.equal(await recoverPublish(options), 1);
  assert.equal(readQueue(queuePath).length, 1, "child and recovery share one failure event");
  acknowledgeQueueLines(readQueue(queuePath), queuePath);
  assert.equal(await recoverPublish(options), 75);
  assert.equal(runs, 1); assert.deepEqual(readQueue(queuePath), []);
  assert.equal(readAttemptState(statePath).days[day].length, 2);
  // Tomorrow gets its own budget without deleting yesterday's records.
  assert.equal(nextAttempt(readAttemptState(statePath), Date.parse("2026-09-03T15:15:00Z"), { mode: "primary" }).allowed, true);
}
{
  const statePath = join(suite, "queue-failure.json");
  saveAttemptState(statePath, makeState(2));
  let runs = 0, queued = 0;
  const options = { statePath, now: morning, prepare: () => "/fixture", verify: async () => stale,
    run: () => { runs++; }, queue: () => { throw new Error("queue unavailable"); } };
  await assert.rejects(recoverPublish(options), /queue unavailable/);
  assert.equal(readAttemptState(statePath).failureAlerts[day], undefined, "failed queue writes cannot mark an alert delivered");
  assert.equal(await recoverPublish({ ...options, queue: () => { queued++; } }), 75);
  assert.equal(queued, 1); assert.equal(runs, 0);
}
{
  const statePath = join(suite, "corrupt.json"); writeFileSync(statePath, "broken");
  let runs = 0;
  await assert.rejects(recoverPublish({ statePath, now: morning, prepare: () => "/fixture", verify: async () => stale, run: () => { runs++; } }));
  assert.equal(runs, 0, "unreadable attempt history fails closed");
}
rmSync(suite, { recursive: true, force: true });
console.log("recover-publish: hard-failure cap, durable warning after queue drain, child dedupe, queue failure and next-day budget passed");
