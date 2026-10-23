// owner-override.test.mjs — the owner may direct ONE extra operator repair per
// Phoenix day, after that day's operator repair, on changed code, with a reason.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishAttempt, nextAttempt, readAttemptState, runDaily, saveAttemptState, OWNER_OVERRIDE_KIND } from '../run-daily.mjs';

const now = Date.now();
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((ch) => ch.repeat(40));
const reason = 'Owner requested immediate repair after public X authentication failed.';
const ownerReason = 'Owner directed a second repair to backfill LinkedIn broadcasts today.';
const base = { version: 1, timezone: 'America/Phoenix', days: {}, invocations: {} };
const primary = nextAttempt(base, now, { mode: 'primary', origin: a });
const recovery = nextAttempt(finishAttempt(primary.state, primary.day, primary.id, 'failed:1', now), now, { mode: 'recovery', origin: a });
const failed = finishAttempt(recovery.state, recovery.day, recovery.id, 'failed:1', now);
const repair = nextAttempt(failed, now, { mode: 'operator-repair', origin: b, reason });
const repaired = finishAttempt(repair.state, repair.day, repair.id, 'waiting:sources', now);
const day = repair.day;

// Without the override a second repair is refused, exactly as before.
assert.equal(nextAttempt(repaired, now, { mode: 'operator-repair', origin: c, reason }).allowed, false);
// The override needs a reason (missing, short, multi-line).
for (const bad of [undefined, '', '   ', 'too short', `${ownerReason}\nsecond line`]) {
  assert.throws(() => nextAttempt(repaired, now, { mode: 'operator-repair', origin: c, reason: bad, ownerOverride: true }), /reason/);
}
// It applies only to operator-repair, only after the day's repair, and only on changed code.
assert.throws(() => nextAttempt(repaired, now, { mode: 'recovery', origin: c, ownerOverride: true }), /only to --operator-repair/);
assert.throws(() => nextAttempt(failed, now, { mode: 'operator-repair', origin: c, reason: ownerReason, ownerOverride: true }), /operator repair to have already run/);
assert.throws(() => nextAttempt(repair.state, now, { mode: 'operator-repair', origin: c, reason: ownerReason, ownerOverride: true }), /operator repair to have already run/, 'not while the repair is still running');
assert.throws(() => nextAttempt(repaired, now, { mode: 'operator-repair', origin: b, reason: ownerReason, ownerOverride: true }), /changed committed code/);

// Allowed once, recorded explicitly.
const override = nextAttempt(repaired, now, { mode: 'operator-repair', origin: c, reason: ownerReason, ownerOverride: true });
assert.equal(override.allowed, true);
assert.equal(override.number, 4);
const entry = override.state.days[day][3];
assert.equal(entry.kind, OWNER_OVERRIDE_KIND);
assert.equal(entry.reason, ownerReason);
assert.equal(entry.mode, 'operator-repair');
assert(Number.isFinite(Date.parse(entry.startedAt)));
assert.deepEqual(override.state.days[day].slice(0, 3), repaired.days[day], 'earlier attempts retained unchanged');

// A third repair is refused, with or without the override; automatic modes stay capped.
const done = finishAttempt(override.state, day, override.id, 'passed', now);
assert.equal(nextAttempt(done, now, { mode: 'operator-repair', origin: d, reason: ownerReason, ownerOverride: true }).allowed, false);
assert.equal(nextAttempt(done, now, { mode: 'operator-repair', origin: d, reason }).allowed, false);
assert.equal(nextAttempt(done, now, { mode: 'recovery', origin: d }).allowed, false);
assert.equal(nextAttempt(done, now + 86400000, { mode: 'primary', origin: d }).allowed, true, 'next day budget resets');

// Ledger validation accepts exactly the recorded shape and rejects others.
const temp = mkdtempSync(join(tmpdir(), 'dive-owner-override-'));
try {
  const path = join(temp, 'attempts.json');
  const load = (state) => { saveAttemptState(path, state); return readAttemptState(path); };
  assert.equal(load(done).days[day][3].kind, OWNER_OVERRIDE_KIND);
  const invalid = [
    ['two override repairs', (s) => s.days[day].push({ ...structuredClone(s.days[day][3]), id: 'extra', origin: d })],
    ['two plain repairs', (s) => { delete s.days[day][3].kind; }],
    ['override with no reason', (s) => { s.days[day][3].reason = ''; }],
    ['override on unchanged code', (s) => { s.days[day][3].origin = b; }],
    ['override with no plain repair before it', (s) => { s.days[day].splice(2, 1); }],
    ['unknown kind', (s) => { s.days[day][3].kind = 'admin'; }],
    ['kind on an automatic attempt', (s) => { s.days[day][0].kind = OWNER_OVERRIDE_KIND; }],
  ];
  for (const [label, mutate] of invalid) {
    const bad = structuredClone(done); mutate(bad);
    writeFileSync(path, JSON.stringify(bad));
    assert.throws(() => readAttemptState(path), /invalid|requires|reason/, label);
  }

  // runDaily end to end: refused without the flag, runs once with it, refused after.
  saveAttemptState(path, repaired);
  let calls = 0;
  const options = {
    statePath: path, now, mode: 'operator-repair', reason: ownerReason, ownerOverride: true,
    root: temp, isolatedRoot: temp, prepare: () => temp, getOrigin: () => c,
    queue: () => {}, resolve: () => {},
    run: () => { calls++; return { status: 0 }; },
    captureReceipt: () => ({ sha: c, generatedAt: new Date(now).toISOString(), sourceStates: [], proof: { ok: true, checkedAt: new Date(now).toISOString(), checked: 17, artifacts: [] } }),
  };
  assert.equal(await runDaily({ ...options, ownerOverride: false }), 75);
  assert.equal(calls, 0);
  await assert.rejects(runDaily({ ...options, reason: '' }), /reason/);
  assert.equal(calls, 0);
  assert.equal(await runDaily(options), 0);
  assert.equal(calls, 1);
  const saved = readAttemptState(path).days[day];
  assert.equal(saved.length, 4, 'the refused invocation adds no attempt');
  assert.equal(saved[3].kind, OWNER_OVERRIDE_KIND);
  assert.equal(saved[3].status, 'passed');
  assert.equal(await runDaily({ ...options, getOrigin: () => d }), 75, 'a third repair is refused');
  assert.equal(calls, 1);
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log('owner-override: refused without the flag or a reason, one extra repair after the day\'s repair on changed code, refused a third time, ledger shape enforced');
