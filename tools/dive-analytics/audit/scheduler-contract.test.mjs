import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../alert-queue.mjs";
import { runDaily, readAttemptState, reconcileInterruptedState } from "../run-daily.mjs";
import { runStepWithPolicy } from "../run-chain.mjs";
import { runFixtureSuite } from "./scheduler-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temp = mkdtempSync(join(tmpdir(), "dive-scheduler-contract."));
const now = Date.parse("2026-09-02T14:00:00Z");
let assertions = 0;
try {
  const result = await runFixtureSuite();
  assert.equal(result.result, "passed"); assertions++;
  assert.equal(result.canonicalAttemptsChanged, false); assertions++;

  for (const invalid of ["{bad", JSON.stringify({ version: 1, timezone: "America/Phoenix", days: { "2026-09-02": [{}] } })]) {
    const path = join(temp, "invalid-state.json"); writeFileSync(path, invalid);
    await assert.rejects(() => runDaily({ statePath: path, now, mode: "primary", prepare: () => { throw new Error("must not prepare"); } })); assertions++;
    assert.equal(existsSync(`${path}.run.lock`), false); assertions++;
    assert.equal(readFileSync(path, "utf8"), invalid); assertions++;
  }
  const lost = join(temp, "missing-state.json"); writeFileSync(`${lost}.initialized-v1`, "{}\n");
  await assert.rejects(() => runDaily({ statePath: lost, now, mode: "primary" }), /missing after initialization/); assertions++;
  assert.equal(existsSync(`${lost}.run.lock`), false); assertions++;

  const interrupted = reconcileInterruptedState({ version: 1, timezone: "America/Phoenix", days: { "2026-09-02": [{ id: "old", mode: "primary", startedAt: new Date(now).toISOString(), status: "running" }] }, invocations: {} }, now + 1);
  assert.equal(interrupted.days["2026-09-02"][0].status, "failed:interrupted"); assertions++;
  assert.equal(interrupted.days["2026-09-02"].length, 1); assertions++;
  const lockPath = join(temp, "stale.lock"); writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: new Date(now).toISOString() }));
  const release = acquireLock(lockPath); release();
  assert.equal(existsSync(lockPath), false); assertions++;

  for (const child of [{ status: null }, { status: 0, error: new Error("child interrupted") }, { status: 0, signal: "SIGTERM" }]) {
    const path = join(temp, `child-${assertions}.json`);
    const status = await runDaily({ statePath: path, root: temp, isolatedRoot: temp, now, mode: "primary", prepare: () => temp, getOrigin: () => "a".repeat(40), queue: () => {}, resolve: () => {}, run: () => child });
    assert.equal(status, 1); assertions++;
    assert.equal(readAttemptState(path).days["2026-09-02"][0].receipt.finalState, "failed:1"); assertions++;
  }
  const noProofState = join(temp, "no-proof.json");
  assert.equal(await runDaily({ statePath: noProofState, root: temp, isolatedRoot: temp, now, mode: "primary", prepare: () => temp, getOrigin: () => "a".repeat(40), queue: () => {}, resolve: () => {}, run: () => ({ status: 0 }), captureReceipt: () => { throw new Error("missing production receipt"); } }), 1); assertions++;

  for (const name of ["snapshot", "live", "newsletter-promotion", "transcripts"]) {
    const step = await runStepWithPolicy({ step: { step: name, required: true }, execute: async () => ({ code: 20 }), wait: async () => {} });
    assert.equal(step.sourcePending, true); assertions++;
    assert.equal(step.attempts, 1); assertions++;
  }
  const missingExit = await runStepWithPolicy({ step: { step: "snapshot", required: true }, execute: async () => ({}), wait: async () => {} });
  assert.equal(missingExit.code, 1); assertions++;
  assert.equal(missingExit.attempts, 2); assertions++;

  const queue = join(temp, "dry-queue.json");
  const warning = '["Daily publishing failed","Newest episode YouTube watch data is unavailable"]\n';
  writeFileSync(queue, warning);
  const dry = spawnSync(process.execPath, ["tools/dive-analytics/run-chain.mjs", "--dry"], { cwd: ROOT, encoding: "utf8", timeout: 10_000, env: { ...process.env, DIVE_ALERT_QUEUE_PATH: queue, DIVE_RUNTIME_DIR: temp } });
  assert.equal(dry.status, 0, dry.stderr); assertions++;
  assert.equal(readFileSync(queue, "utf8"), warning); assertions++;
  assert.equal(existsSync(`${queue}.initialized-v1`), false); assertions++;
  console.log(`scheduler-contract.test: ${assertions} assertions plus ${result.checks.length} complete synthetic lifecycle checks passed`);
} finally { rmSync(temp, { recursive: true, force: true }); }
