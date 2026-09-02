// recover-publish.test.mjs — only a failed morning proof starts the reserved
// recovery; noon verifies without starting another chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverPublish, recoveryAction } from "../recover-publish.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const morning = Date.parse("2026-09-02T15:15:00Z");
const noon = Date.parse("2026-09-02T19:00:00Z");
const fresh = { ok: true };
const stale = { ok: false };
assert.equal(recoveryAction(fresh, morning), "done");
assert.equal(recoveryAction(stale, morning), "recover");
assert.equal(recoveryAction(stale, noon), "fail");

{
  let runs = 0;
  let checks = 0;
  const status = await recoverPublish({
    now: morning,
    verify: async () => {
      checks++;
      return checks === 1
        ? { ok: false, freshness: { ok: false, message: "yesterday" }, parity: { ok: false, mismatches: [{ file: "data.json" }] } }
        : { ok: true, freshness: { ok: true }, parity: { ok: true, checked: 7 } };
    },
    run: () => { runs++; return { status: 0 }; },
  });
  assert.equal(status, 0);
  assert.equal(runs, 1);
  assert.equal(checks, 2, "production is proved again after recovery");
}

{
  let runs = 0;
  const status = await recoverPublish({
    now: morning,
    verify: async () => ({ ok: true, freshness: { ok: true }, parity: { ok: true, checked: 7 } }),
    run: () => { runs++; return { status: 0 }; },
  });
  assert.equal(status, 0);
  assert.equal(runs, 0);
}

const source = readFileSync(join(HERE, "..", "recover-publish.mjs"), "utf8");
assert.match(source, /run-daily\.mjs", "--recovery"/);
assert.doesNotMatch(source, /run-chain\.mjs/);
assert.match(source, /const after = await verify/);

console.log("recover-publish.test: fresh no-op, one morning recovery, post-recovery proof, and noon no-run rules pass");
