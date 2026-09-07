import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishAttempt, nextAttempt, readAttemptState, reconcileInterruptedState, runDaily, saveAttemptState } from '../run-daily.mjs';
import { checklistVerdict } from '../recover-publish.mjs';

const now = Date.now();
const origin = 'a'.repeat(40);
const fixed = 'b'.repeat(40);
const reason = 'Owner requested immediate repair after public X authentication failed.';
const base = { version: 1, timezone: 'America/Phoenix', days: {}, invocations: {} };
const primary = nextAttempt(base, now, { mode: 'primary', origin });
const recovery = nextAttempt(finishAttempt(primary.state, primary.day, primary.id, 'failed:1', now), now, { mode: 'recovery', origin });
const failed = finishAttempt(recovery.state, recovery.day, recovery.id, 'failed:1', now);
const historical = JSON.stringify(failed.days);
assert.equal(nextAttempt(failed, now, { mode: 'primary', origin: fixed }).allowed, false);
assert.equal(nextAttempt(failed, now, { mode: 'recovery', origin: fixed }).allowed, false);
assert.throws(() => nextAttempt(failed, now, { mode: 'operator-repair', origin: fixed }), /reason/);
assert.throws(() => nextAttempt(failed, now, { mode: 'operator-repair', origin, reason }), /changed committed code/);
assert.throws(() => nextAttempt(base, now, { mode: 'operator-repair', origin: fixed, reason }), /two prior failures/);
const passed = finishAttempt(recovery.state, recovery.day, recovery.id, 'passed', now);
assert.throws(() => nextAttempt(passed, now, { mode: 'operator-repair', origin: fixed, reason }), /two prior failures/);
const reserved = nextAttempt(failed, now, { mode: 'operator-repair', origin: fixed, reason });
assert.equal(reserved.allowed, true);
assert.equal(reserved.number, 3);
assert.equal(JSON.stringify(failed.days), historical);
assert.deepEqual(reserved.state.days[reserved.day].slice(0, 2), failed.days[reserved.day]);
assert.equal(nextAttempt(reserved.state, now, { mode: 'operator-repair', origin: 'c'.repeat(40), reason }).allowed, false);
assert.equal(nextAttempt(reserved.state, now, { mode: 'recovery', origin: fixed }).allowed, false);
const interrupted = reconcileInterruptedState(reserved.state, now + 1);
assert.equal(interrupted.days[reserved.day][2].status, 'failed:interrupted');
assert.equal(nextAttempt(interrupted, now, { mode: 'operator-repair', origin: fixed, reason }).allowed, false);
assert.equal(nextAttempt(interrupted, now + 86400000, { mode: 'primary', origin: fixed }).allowed, true);

const temp = mkdtempSync(join(tmpdir(), 'dive-operator-repair-'));
try {
  const statePath = join(temp, 'attempts.json');
  saveAttemptState(statePath, failed);
  let calls = 0;
  const options = {
    statePath, now, mode: 'operator-repair', reason,
    root: temp, isolatedRoot: temp, prepare: () => temp, getOrigin: () => fixed,
    queue: () => {}, resolve: () => {},
    run: (args, cwd) => {
      calls++;
      assert.deepEqual(args, ['tools/dive-analytics/run-chain.mjs']);
      assert.equal(cwd, temp);
      assert.equal(readAttemptState(statePath).days[reserved.day][2].status, 'running');
      return { status: 0 };
    },
    captureReceipt: () => ({ sha: fixed, generatedAt: new Date(now).toISOString(), sourceStates: [], proof: { ok: true, checkedAt: new Date(now).toISOString(), checked: 17, artifacts: [] } }),
  };
  assert.equal(await runDaily(options), 0);
  const saved = readAttemptState(statePath);
  assert.deepEqual(saved.days[reserved.day].slice(0, 2), failed.days[reserved.day]);
  assert.equal(saved.days[reserved.day][2].reason, reason);
  assert.equal(saved.days[reserved.day][2].receipt.finalState, 'passed');
  assert.equal(checklistVerdict(statePath, now).ok, true);
  assert.equal(await runDaily(options), 75);
  assert.equal(calls, 1);
  assert.equal(await runDaily({ ...options, mode: 'recovery' }), 75);
  assert.equal(calls, 1);
  const corrupt = structuredClone(saved);
  corrupt.days[reserved.day][2].reason = '';
  saveAttemptState(statePath, corrupt);
  assert.throws(() => readAttemptState(statePath), /reason/);
  // A zero child status without live proof cannot certify the operator repair.
  const missingProof = join(temp, 'missing-proof.json');
  saveAttemptState(missingProof, failed);
  assert.equal(await runDaily({ ...options, statePath: missingProof, run: () => ({ status: 0 }), captureReceipt: () => { throw new Error('no production proof'); } }), 1);
  assert.equal(readAttemptState(missingProof).days[reserved.day][2].status, 'failed:1');
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log('operator-repair: automatic cap, authorization reason, changed code, retained failures, one repair, interruption, strict proof and next-day budget pass');
