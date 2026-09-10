import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCaptureEnvironment, nextAttempt, readAttemptState, runDaily } from "../run-daily.mjs";

assert.throws(() => assertCaptureEnvironment({}), /1Password environment/);
assert.throws(() => assertCaptureEnvironment({ BEEHIIV_API_KEY: " " }), /unavailable/);
assert.doesNotThrow(() => assertCaptureEnvironment({ BEEHIIV_API_KEY: "fixture" }));
const dir = mkdtempSync(join(tmpdir(), "dive-capture-preflight-"));
try {
  const statePath = join(dir, "attempts.json"), now = Date.now();
  let runs = 0;
  const status = await runDaily({ statePath, now, mode: "recovery", queue() {},
    prepare() { assertCaptureEnvironment({}); }, run() { runs++; return { status: 0 }; } });
  assert.equal(status, 1);
  assert.equal(runs, 0);
  const saved = readAttemptState(statePath);
  assert.deepEqual(saved.days, {}, "missing local launch credentials cannot consume capture budget");
  assert.equal(Object.values(saved.invocations)[0][0].status, "failed:preflight");
  assert.equal(nextAttempt(saved, now, { mode: "recovery" }).allowed, true);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("capture-preflight: absent credentials fail before capture; invocation retained; recovery budget available");
