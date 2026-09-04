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

const source = readFileSync(join(HERE, "..", "recover-publish.mjs"), "utf8");
assert.match(source, /run-daily\.mjs", "--recovery"/);
assert.doesNotMatch(source, /run-chain\.mjs/);
assert.match(source, /const after = await verify/);

console.log("recover-publish.test: fresh no-op, incomplete-checklist recovery, post-recovery proof, overlap guard, and noon no-run rules pass");
