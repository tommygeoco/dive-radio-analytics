// scheduler-watch.test.mjs — OpenClaw can never again switch the daily run off
// in silence (2026-09-30 and 2026-10-01 had no 07:00 run): handled outcomes
// reach the scheduler as 0, an auto-disabled core automation is switched back
// on, and anything the watchdog cannot fix reaches Slack once per Phoenix day.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScheduler, CORE_JOBS, exitForScheduler, schedulerExit, watchSchedulerQuietly } from "../scheduler-watch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "dive-scheduler-watch."));
const morning = Date.parse("2026-10-02T14:30:00Z"); // 07:30 Phoenix
const nextDay = Date.parse("2026-10-03T14:30:00Z");
const publisher = "/Users/bones/Library/Application Support/Dive Radio Analytics/publisher-main";
let assertions = 0;

// Shapes copied from `openclaw cron list --all --json` on the chain machine (2026.9.7).
const job = (id, argv, extra = {}) => ({ id, name: id, enabled: true, schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/Phoenix" }, payload: { kind: "command", argv: ["/opt/homebrew/bin/node", ...argv], cwd: publisher }, state: { consecutiveErrors: 0, lastStatus: "ok" }, ...extra });
const healthy = () => [
  job("primary-id", ["tools/dive-analytics/run-daily.mjs", "--primary"]),
  job("recovery-id", ["tools/dive-analytics/recover-publish.mjs"]),
  job("alerts-id", ["tools/dive-analytics/alerts.mjs", "--deliver", "--channel", "slack", "--account", "default", "--target", "user:U063YBZEGQ5"]),
  job("ingest-id", ["scripts/restream/ingest-restream.mjs"]),
  // Not core: the intentionally disabled rehearsal, a one-shot, and an unrelated job.
  job("rehearsal-id", ["tools/dive-analytics/run-chain.mjs", "--rehearse"], { enabled: false }),
  { ...job("oneshot-id", ["tools/dive-analytics/run-daily.mjs", "--primary"]), enabled: false, schedule: { kind: "at", at: "2026-09-08T14:40:00.000Z" } },
  job("other-id", ["scripts/other.mjs"], { enabled: false, state: { consecutiveErrors: 12, autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 } } }),
];
const listing = (jobs, banner = "") => () => ({ status: 0, stdout: `${banner}${JSON.stringify({ jobs }, null, 2)}\n`, stderr: "" });

function harness(name, jobs, overrides = {}) {
  const statePath = join(temp, `${name}.json`);
  const queued = [];
  const enabledCalls = [];
  const options = {
    statePath,
    now: morning,
    read: listing(jobs, "OpenClaw 2026.9.7 (c074824)\n"),
    enable: (id) => { enabledCalls.push(id); return { status: 0, stdout: "{\"ok\":true}" }; },
    queue: (lines) => queued.push(...lines),
    ...overrides,
  };
  return { statePath, queued, enabledCalls, options, run: (more = {}) => checkScheduler({ ...options, ...more }) };
}

try {
  // 1. Handled outcomes never build OpenClaw's disable streak; real failures still do.
  for (const [status, reported] of [[0, 0], [10, 0], [75, 0], [1, 1], [20, 20], [21, 21], [137, 137]]) {
    assert.equal(schedulerExit(status), reported, `exit ${status}`); assertions++;
  }
  const said = [];
  assert.equal(exitForScheduler(75, "daily-run", (line) => said.push(line)), 0); assertions++;
  assert.match(said[0], /recorded in the attempt ledger/, "the true outcome stays in the run log"); assertions++;
  assert.equal(exitForScheduler(1, "daily-run", (line) => said.push(line)), 1); assertions++;
  assert.equal(said.length, 1, "nothing is said when the exit passes through"); assertions++;

  // 2. A healthy scheduler: no lines, no enables, non-core jobs untouched.
  {
    const h = harness("healthy", healthy());
    const result = h.run();
    assert.deepEqual(result.lines, []); assertions++;
    assert.deepEqual(h.enabledCalls, [], "a disabled non-core, rehearsal or one-shot job is never switched on"); assertions++;
    assert.equal(result.checked, 7); assertions++;
  }

  // 3. The 2026-09-30 failure: OpenClaw auto-disabled the 07:00 run. It is switched
  //    back on and Slack hears about it, once per day however often the check runs.
  {
    const jobs = healthy();
    jobs[0] = { ...jobs[0], enabled: false, state: { consecutiveErrors: 10, lastStatus: "error", autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10, at: morning - 60_000 } } };
    const h = harness("auto-disabled", jobs);
    const first = h.run();
    assert.deepEqual(h.enabledCalls, ["primary-id"]); assertions++;
    assert.deepEqual(first.enabled, ["primary-id"]); assertions++;
    assert.equal(h.queued.length, 1); assertions++;
    assert.match(h.queued[0], /^OpenClaw switched off the 07:00 daily run after 10 failed runs in a row; the watchdog switched it back on at 7:30/); assertions++;
    h.run();
    assert.deepEqual(h.enabledCalls, ["primary-id", "primary-id"], "it keeps switching the job on while OpenClaw reports it off"); assertions++;
    assert.equal(h.queued.length, 1, "the five-minute check does not repeat itself"); assertions++;
    h.run({ now: nextDay });
    assert.equal(h.queued.length, 2, "a new Phoenix day may say it again"); assertions++;
    const state = JSON.parse(readFileSync(h.statePath, "utf8"));
    assert.deepEqual(Object.keys(state.days).sort(), ["2026-10-02", "2026-10-03"]); assertions++;
  }

  // 4. Switching back on fails: Slack is told how to do it by hand.
  {
    const jobs = healthy();
    jobs[1] = { ...jobs[1], enabled: false, state: { consecutiveErrors: 10, autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 } } };
    const h = harness("enable-fails", jobs, { enable: () => ({ status: 1, stderr: "gateway closed" }) });
    const result = h.run();
    assert.deepEqual(result.enabled, []); assertions++;
    assert.match(h.queued[0], /could not switch it back on; run `openclaw cron enable recovery-id` on the chain machine/); assertions++;
    const thrown = harness("enable-throws", jobs, { enable: () => { throw new Error("spawn openclaw ENOENT"); } });
    thrown.run();
    assert.equal(thrown.queued.length, 1, "a thrown enable is the same failure, not a crash"); assertions++;
  }

  // 5. A person switched a core job off: never overridden, but never silent.
  {
    const jobs = healthy();
    jobs[2] = { ...jobs[2], enabled: false, state: { consecutiveErrors: 0, lastStatus: "ok" } };
    const h = harness("human-disabled", jobs);
    h.run(); h.run();
    assert.deepEqual(h.enabledCalls, [], "an owner's switch-off is respected"); assertions++;
    assert.equal(h.queued.length, 1); assertions++;
    assert.match(h.queued[0], /^Slack alert delivery is switched off in OpenClaw/); assertions++;
  }

  // 6. A failing streak is named before OpenClaw acts on it; a missing job is named.
  {
    const jobs = healthy().filter((item) => item.id !== "ingest-id");
    jobs[1] = { ...jobs[1], state: { consecutiveErrors: 6, lastStatus: "error" } };
    const h = harness("streak-missing", jobs);
    h.run(); h.run();
    assert.equal(h.queued.length, 2); assertions++;
    assert.ok(h.queued.some((line) => /^The 08:15\/12:15 recovery check has failed 6 runs in a row; OpenClaw switches an automation off at 10/.test(line))); assertions++;
    assert.ok(h.queued.some((line) => /^The 06:50 Restream ingest is not scheduled in OpenClaw/.test(line))); assertions++;
    const quiet = harness("streak-below", healthy().map((item) => item.id === "recovery-id" ? { ...item, state: { consecutiveErrors: 4 } } : item));
    quiet.run();
    assert.deepEqual(quiet.queued, [], "a short streak is ordinary"); assertions++;
  }

  // 7. The list cannot be read: one line a day, no crash, no enables.
  {
    const h = harness("unreadable", [], { read: () => ({ status: 1, stdout: "", stderr: "gateway closed (1006)\n" }) });
    h.run(); h.run();
    assert.equal(h.queued.length, 1); assertions++;
    assert.match(h.queued[0], /^The OpenClaw automation list could not be read on the chain machine \(gateway closed \(1006\)\)/); assertions++;
    const garbled = harness("garbled", [], { read: () => ({ status: 0, stdout: "not json" }) });
    garbled.run();
    assert.match(garbled.queued[0], /^The OpenClaw automation list was unreadable/); assertions++;
  }

  // 8. A failed queue write leaves the day unmarked so the next check tries again.
  {
    const jobs = healthy();
    jobs[0] = { ...jobs[0], enabled: false, state: { consecutiveErrors: 10, autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 } } };
    const h = harness("queue-fails", jobs);
    assert.throws(() => h.run({ queue: () => { throw new Error("alert queue is corrupt"); } }), /corrupt/); assertions++;
    assert.equal(existsSync(h.statePath), false); assertions++;
    h.run();
    assert.equal(h.queued.length, 1, "the retry says it"); assertions++;
  }

  // 9. Entry points never fail because of the watchdog; a corrupt state file is loud in the log only.
  {
    const statePath = join(temp, "corrupt.json");
    writeFileSync(statePath, "{bad");
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(line);
    try { assert.equal(watchSchedulerQuietly("dive-alerts", () => {}, { root: temp, publisherRoot: temp, statePath, read: listing(healthy()), queue: () => {} }), null); assertions++; }
    finally { console.error = original; }
    assert.match(errors[0], /^dive-alerts: scheduler watch failed/); assertions++;
    assert.equal(readFileSync(statePath, "utf8"), "{bad", "corrupt state is retained, never reset"); assertions++;
  }

  // 9b. Outside the publisher checkout (fixtures, /tmp clones, a dev tree) it never reads or switches anything.
  {
    let touched = 0;
    const result = watchSchedulerQuietly("dive-alerts", () => {}, { root: HERE, publisherRoot: temp, read: () => { touched++; return { status: 0, stdout: "[]" }; }, enable: () => { touched++; }, queue: () => { touched++; } });
    assert.equal(result.skipped, "not the publisher checkout"); assertions++;
    assert.equal(touched, 0); assertions++;
    const missing = watchSchedulerQuietly("dive-alerts", () => {}, { root: HERE, publisherRoot: join(temp, "no-such-publisher"), read: () => { touched++; } });
    assert.equal(missing.skipped, "not the publisher checkout"); assertions++;
    assert.equal(touched, 0); assertions++;
  }

  // 10. A concurrent check (dive-alerts and the daily run at 07:00) skips instead of doubling lines.
  {
    const h = harness("locked", healthy());
    writeFileSync(`${h.statePath}.lock`, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.equal(h.run().skipped, "another scheduler check is running"); assertions++;
    rmSync(`${h.statePath}.lock`);
  }

  // 11. Every core matcher finds the real chain-machine command, and the
  //     scheduled entry points are wired (primary and recovery map exits; the
  //     recovery child of recover-publish keeps its true exit).
  for (const core of CORE_JOBS) {
    assert.ok(healthy().some((item) => item.schedule.kind === "cron" && core.match(item.payload.argv)), core.key); assertions++;
  }
  const source = (name) => readFileSync(join(HERE, "..", name), "utf8");
  assert.match(source("run-daily.mjs"), /mode === "primary" \? exitForScheduler\(status, "daily-run"\) : status/); assertions++;
  assert.match(source("recover-publish.mjs"), /scheduled \? exitForScheduler\(status, "recovery"\) : status/); assertions++;
  assert.match(source("alerts.mjs"), /watchSchedulerQuietly\("dive-alerts"\);\n\s+deliverPending\(/); assertions++;
  console.log(`scheduler-watch.test: ${assertions} assertions passed`);
} finally { rmSync(temp, { recursive: true, force: true }); }
