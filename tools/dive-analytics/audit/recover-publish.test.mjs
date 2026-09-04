// recover-publish.test.mjs — a real failure uses the reserved attempt in the
// morning; a current build with late YouTube watch data saves it for noon.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checklistVerdict, recoverPublish, recoveryAction } from "../recover-publish.mjs";
import { YOUTUBE_WATCH_PENDING_STATUS } from "../youtube-readiness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const morning = Date.parse("2026-09-02T15:15:00Z");
const noon = Date.parse("2026-09-02T19:00:00Z");
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
assert.equal(recoveryAction(stale, noon), "fail");
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
    days: { "2026-09-02": [{ status: YOUTUBE_WATCH_PENDING_STATUS }] },
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

const source = readFileSync(join(HERE, "..", "recover-publish.mjs"), "utf8");
assert.match(source, /run-daily\.mjs", "--recovery"/);
assert.doesNotMatch(source, /run-chain\.mjs/);
assert.match(source, /const after = await verify/);
assert.match(source, /return "defer"/);
assert.match(source, /NOON_START/);

console.log("recover-publish.test: fresh no-op, morning recovery, late-YouTube noon retry, post-run proof, and overlap guard pass");
