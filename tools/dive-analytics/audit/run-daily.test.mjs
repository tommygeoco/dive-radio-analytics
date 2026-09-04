// run-daily.test.mjs — whole-chain runs stop after the scheduled run and one
// recovery, then reset on the next Phoenix day.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureIsolatedCheckout, finishAttempt, markYoutubeWatchAlert, MAX_DAILY_ATTEMPTS, nextAttempt, readAttemptState, retireLegacyQueueChange, runBoundedChain, runDaily as runDailyActual } from "../run-daily.mjs";
import { YOUTUBE_WATCH_PENDING_EXIT, YOUTUBE_WATCH_PENDING_STATUS } from "../youtube-readiness.mjs";

const receiptEvidence = { sha: "a".repeat(40), generatedAt: "2026-09-02T14:00:00Z", proof: { ok: true, checked: 1, artifacts: [] }, sourceStates: [] };
const runDaily = (options) => runDailyActual({ captureReceipt: () => receiptEvidence, resolve: () => {}, ...options });
const base = { version: 1, timezone: "America/Phoenix", days: {} };
const dayOneMorning = Date.parse("2026-09-02T14:00:00Z");

const first = nextAttempt(base, dayOneMorning, { mode: "primary", id: "one", origin: "abc" });
assert.equal(first.allowed, true);
assert.equal(first.number, 1);
const firstDone = finishAttempt(first.state, first.day, first.id, "failed:1", dayOneMorning + 1000);
assert.equal(firstDone.days["2026-09-02"][0].status, "failed:1");

const second = nextAttempt(firstDone, dayOneMorning + 2000, { mode: "recovery", id: "two", origin: "abc" });
assert.equal(second.allowed, true);
assert.equal(second.number, MAX_DAILY_ATTEMPTS);
const secondDone = finishAttempt(second.state, second.day, second.id, "passed", dayOneMorning + 3000);

const third = nextAttempt(secondDone, dayOneMorning + 4000, { mode: "recovery", id: "three", origin: "abc" });
assert.equal(third.allowed, false);
assert.equal(third.state.days["2026-09-02"].length, 2, "a refused third run is not recorded as work");

const nextDay = nextAttempt(secondDone, Date.parse("2026-09-03T14:00:00Z"), { mode: "primary", id: "next" });
assert.equal(nextDay.allowed, true);
assert.equal(nextDay.number, 1);

const firstAlert = markYoutubeWatchAlert(firstDone, "2026-09-02", dayOneMorning);
assert.equal(firstAlert.needed, true);
assert.equal(markYoutubeWatchAlert(firstAlert.state, "2026-09-02", dayOneMorning + 1000).needed, false, "the daily source alert has one durable event marker");

const temp = mkdtempSync(join(tmpdir(), "dive-daily-isolation."));
const remote = join(temp, "remote.git");
const source = join(temp, "source");
const isolated = join(temp, "runtime", "publisher-main");
const writer = join(temp, "writer");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Dive test",
  GIT_AUTHOR_EMAIL: "dive-test@example.invalid",
  GIT_COMMITTER_NAME: "Dive test",
  GIT_COMMITTER_EMAIL: "dive-test@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  mkdirSync(source);
  git(temp, "init", "--bare", remote);
  git(source, "init", "-b", "main");
  mkdirSync(join(source, "data", "restream"), { recursive: true });
  writeFileSync(join(source, ".gitignore"), ".vercel/\n");
  writeFileSync(join(source, "README.md"), "first\n");
  writeFileSync(join(source, "data.json"), "{}\n");
  writeFileSync(join(source, "data", "restream", "state.json"), "{\"source\":\"first\"}\n");
  git(source, "add", ".gitignore", "README.md", "data.json", "data/restream/state.json");
  git(source, "commit", "-m", "initial");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-u", "origin", "main");
  mkdirSync(join(source, ".vercel"));
  writeFileSync(join(source, ".vercel", "project.json"), "{\"projectId\":\"test\"}\n");
  writeFileSync(join(source, "README.md"), "dirty development copy\n");

  const incomplete = join(temp, "runtime", "partial-publisher");
  mkdirSync(incomplete, { recursive: true });
  writeFileSync(join(incomplete, "partial"), "interrupted clone\n");
  ensureIsolatedCheckout(source, incomplete, { log: () => {} });
  assert.equal(readFileSync(join(incomplete, "README.md"), "utf8"), "first\n", "an interrupted first clone is replaced by a complete checkout");
  assert.equal(readdirSync(join(temp, "runtime")).some((name) => name.startsWith("partial-publisher.incomplete-")), true, "the partial directory is quarantined rather than deleted");

  assert.equal(ensureIsolatedCheckout(source, isolated, { log: () => {} }), isolated);
  assert.equal(readFileSync(join(isolated, "README.md"), "utf8"), "first\n", "dirty development files never enter the publisher");
  assert.equal(readFileSync(join(isolated, ".vercel", "project.json"), "utf8"), "{\"projectId\":\"test\"}\n");

  git(temp, "clone", remote, writer);
  git(writer, "checkout", "main");
  writeFileSync(join(writer, "README.md"), "second\n");
  git(writer, "add", "README.md");
  git(writer, "commit", "-m", "update");
  git(writer, "push", "origin", "main");
  writeFileSync(join(isolated, "data.json"), "{\"saved\":true}\n");

  ensureIsolatedCheckout(source, isolated, { log: () => {} });
  assert.equal(readFileSync(join(isolated, "README.md"), "utf8"), "second\n", "isolated publisher fast-forwards to main");
  assert.equal(readFileSync(join(isolated, "data.json"), "utf8"), "{\"saved\":true}\n", "declared chain output survives the update");

  writeFileSync(join(isolated, "data", "restream", "state.json"), "{\"source\":\"local\"}\n");
  git(isolated, "add", "data.json", "data/restream/state.json");
  git(isolated, "commit", "-m", "local data");
  writeFileSync(join(writer, "data.json"), "{\"source\":\"remote\"}\n");
  writeFileSync(join(writer, "data", "restream", "state.json"), "{\"source\":\"remote\"}\n");
  git(writer, "add", "data.json", "data/restream/state.json");
  git(writer, "commit", "-m", "remote data");
  git(writer, "push", "origin", "main");

  ensureIsolatedCheckout(source, isolated, { log: () => {} });
  assert.equal(readFileSync(join(isolated, "data.json"), "utf8"), "{\"source\":\"remote\"}\n", "generated output is rebuilt instead of preserving a conflicting old commit");
  assert.equal(readFileSync(join(isolated, "data", "restream", "state.json"), "utf8"), "{\"source\":\"local\"}\n", "one-writer source data survives a moved main branch");
  assert.equal(git(isolated, "rev-list", "--count", "origin/main..HEAD").trim(), "1", "saved source data remains as one publishable local commit");

  writeFileSync(join(isolated, "data", "restream", "alerts-pending.json"), JSON.stringify(["saved alert"]) + "\n");
  git(isolated, "add", "data/restream/alerts-pending.json");
  git(isolated, "commit", "-m", "legacy queue fixture");
  writeFileSync(join(isolated, "data", "restream", "alerts-pending.json"), JSON.stringify(["saved alert", "new alert"]) + "\n");
  const imported = [];
  retireLegacyQueueChange(isolated, () => {}, { importQueue: (path) => {
    const lines = JSON.parse(readFileSync(path, "utf8"));
    imported.push(...lines);
    return lines;
  } });
  assert.deepEqual(imported, ["saved alert", "new alert"], "every pending legacy line is imported before retirement");
  assert.deepEqual(JSON.parse(readFileSync(join(isolated, "data", "restream", "alerts-pending.json"), "utf8")), ["saved alert"], "the tracked legacy file returns to its committed state only after import");

  const heartbeat = join(temp, "grandchild-heartbeat");
  const grandchild = `const fs=require("fs");const p=${JSON.stringify(heartbeat)};process.on("SIGTERM",()=>{});setInterval(()=>fs.appendFileSync(p,"x"),20)`;
  const parent = `const {spawn}=require("child_process");spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const bounded = await runBoundedChain(["-e", parent], temp, { timeoutMs: 250, killGraceMs: 100 });
  assert.equal(bounded.status, 124, "a timed-out chain is stopped as a process group and reported distinctly");
  const heartbeatAfterStop = readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(readFileSync(heartbeat, "utf8"), heartbeatAfterStop, "the timeout kills descendants before the daily lock can be released");

  const statePath = join(temp, "state", "daily-attempts.json");
  const queued = [];
  const preflightStatus = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath,
    now: dayOneMorning,
    mode: "primary",
    prepare: () => { throw new Error("test preflight stopped"); },
    queue: (lines) => queued.push(...lines),
  });
  assert.equal(preflightStatus, 1);
  let saved = readAttemptState(statePath);
  assert.equal(saved.days["2026-09-02"], undefined, "a preflight failure does not spend a chain attempt");
  assert.equal(saved.invocations["2026-09-02"].at(-1).status, "failed:preflight", "the failed invocation is still recorded");
  assert.match(queued.at(-1), /isolated checkout/);

  const passedStatus = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath,
    now: dayOneMorning + 1000,
    mode: "recovery",
    prepare: () => isolated,
    getOrigin: () => "abc",
    queue: (lines) => queued.push(...lines),
    run: (args, cwd) => {
      assert.deepEqual(args, ["tools/dive-analytics/run-chain.mjs"]);
      assert.equal(cwd, isolated);
      return { status: 0 };
    },
  });
  assert.equal(passedStatus, 0);
  saved = readAttemptState(statePath);
  assert.equal(saved.days["2026-09-02"].length, 1);
  assert.equal(saved.days["2026-09-02"][0].status, "passed");
  assert.equal(saved.invocations["2026-09-02"].at(-1).status, "passed");
  assert.equal(existsSync(`${statePath}.run.lock`), false);

  const pendingStatePath = join(temp, "state", "youtube-pending-attempts.json");
  const queueCountBeforePending = queued.length;
  const pendingStatus = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath: pendingStatePath,
    now: dayOneMorning,
    mode: "primary",
    prepare: () => isolated,
    getOrigin: () => "abc",
    queue: (lines) => queued.push(...lines),
    run: () => ({ status: YOUTUBE_WATCH_PENDING_EXIT }),
  });
  assert.equal(pendingStatus, 0, "the scheduled wrapper stays green after the morning build publishes honest pending data");
  const pendingSaved = readAttemptState(pendingStatePath);
  assert.equal(pendingSaved.days["2026-09-02"].length, 1, "the pending primary still spends the first whole-chain attempt");
  assert.equal(pendingSaved.days["2026-09-02"][0].status, YOUTUBE_WATCH_PENDING_STATUS);
  assert.equal(pendingSaved.invocations["2026-09-02"].at(-1).status, YOUTUBE_WATCH_PENDING_STATUS);
  assert.equal(queued.length, queueCountBeforePending, "expected YouTube report delay does not queue a false production-failure alert");

  const firstRecoveryStatePath = join(temp, "state", "first-recovery-pending-attempts.json");
  const queueCountBeforeFirstRecovery = queued.length;
  const firstRecoveryPending = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath: firstRecoveryStatePath,
    now: dayOneMorning,
    mode: "recovery",
    prepare: () => isolated,
    getOrigin: () => "abc",
    queue: (lines) => queued.push(...lines),
    run: () => ({ status: YOUTUBE_WATCH_PENDING_EXIT }),
  });
  assert.equal(firstRecoveryPending, 0);
  const firstRecoverySaved = readAttemptState(firstRecoveryStatePath);
  assert.equal(firstRecoverySaved.days["2026-09-02"].length, 1, "an 08:15 recovery can be the first whole-chain attempt");
  assert.equal(firstRecoverySaved.youtubeWatchAlerts["2026-09-02"], undefined, "the first attempt does not send the final missing-source alert");
  assert.equal(queued.length, queueCountBeforeFirstRecovery);

  const pendingRecoveryStatus = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath: pendingStatePath,
    now: dayOneMorning + 5 * 3600000,
    mode: "recovery",
    prepare: () => isolated,
    getOrigin: () => "abc",
    queue: (lines) => queued.push(...lines),
    run: () => ({ status: YOUTUBE_WATCH_PENDING_EXIT }),
  });
  assert.equal(pendingRecoveryStatus, 0, "honest missing data after recovery does not mislabel production as failed");
  const pendingAfterRecovery = readAttemptState(pendingStatePath);
  assert.equal(pendingAfterRecovery.days["2026-09-02"].length, 2);
  assert.equal(pendingAfterRecovery.youtubeWatchAlerts["2026-09-02"].event, "newest-youtube-watch-still-waiting");
  assert.equal(queued.length, queueCountBeforePending + 1, "the reserved run queues one plain missing-watch alert");
  assert.match(queued.at(-1), /watch measures remain missing/);
  assert.match(queued.at(-1), /2026-09-02/, "daily source alerts remain distinct while an earlier day's line is still queued");

  const failedStatus = await runDaily({
    root: source,
    isolatedRoot: isolated,
    statePath,
    now: dayOneMorning + 2000,
    mode: "primary",
    prepare: () => isolated,
    getOrigin: () => "def",
    queue: (lines) => queued.push(...lines),
    run: () => ({ status: 2 }),
  });
  assert.equal(failedStatus, 2);
  saved = readAttemptState(statePath);
  assert.equal(saved.days["2026-09-02"].at(-1).status, "failed:2");
  assert.equal(saved.invocations["2026-09-02"].at(-1).status, "failed:2");
  assert.match(queued.at(-1), /production needs verification/, "a nonzero chain exit cannot be silent or claim the release state");
  unlinkSync(statePath);
  assert.throws(() => readAttemptState(statePath), /missing after initialization/, "a vanished attempt ledger cannot silently reset the daily cap");
} finally {
  rmSync(temp, { force: true, recursive: true });
}

console.log("run-daily.test: bounded attempts, durable missing-watch alerts, process groups, recorded preflights, clone quarantine, queue migration, dirty-source isolation, main sync, conflict healing, output preservation, and next-day reset pass");
