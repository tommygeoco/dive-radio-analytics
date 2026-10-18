// runtime-watchdog-cron-script.test.mjs — runs the OpenClaw script payload the way
// the gateway does (an async body with exec, process and trigger supplied)
// against the 2026-10-18 failure shapes. The fake shell answers the one probe
// command in its real row format; one case runs that command's python3 filter
// on a cron.list reply shaped like the gateway's.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "runtime-watchdog-cron-script.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = new AsyncFunction("exec", "process", "trigger", source);
const NODE = "/Users/bones/.local/bin/node";
const BREW = "/opt/homebrew/bin/node";
const OFFICIAL = "/Users/bones/.local/share/node/node-v24.20.0-darwin-arm64/bin/node";
const CORE_IDS = [...source.matchAll(/"([0-9a-f-]{36})": "/g)].map((m) => m[1]);
const AT = Date.parse("2026-10-18T17:00:00Z");
let assertions = 0;

const ok = (path) => `${path}|0|v24.20.0|${OFFICIAL}`;
const dyld = (path) => `${path}|134|dyld[68978]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib|/opt/homebrew/Cellar/node/25.6.1/bin/node`;
const GUARDED = "brew.env|5";
const coreRow = (id, over = {}) => { const j = { enabled: 1, atMs: "", errors: "", last: "", ...over }; return `job|${id}|${id.slice(0, 8)}-name|${j.enabled}|${j.atMs}|${j.errors}|${j.last}`; };
const STORE = ["jobs-read|116", ...CORE_IDS.map((id) => coreRow(id))];
// rows: runtime rows plus any overrides; brew.env and the store are added unless given.
const shell = (...rows) => async () => {
  const out = [...rows];
  if (!out.some((r) => r.startsWith("brew.env|"))) out.push(GUARDED);
  if (!out.some((r) => r.startsWith("jobs-read|") || r === "NO-STORE")) out.push(...STORE);
  return { status: "completed", exitCode: 0, aggregated: `${out.filter((r) => r !== "NO-STORE").join("\n")}\n` };
};
const run = (execImpl, state, at = AT, poll = async () => { throw new Error("no poll expected"); }) => {
  const realNow = Date.now;
  Date.now = () => at;
  try { return body(execImpl, poll, { state }); }
  finally { Date.now = realNow; }
};

assert.equal(CORE_IDS.length, 5, "five core jobs by id"); assertions++;

// 1. Healthy: nothing said, nothing remembered.
{
  const result = await run(shell(ok(NODE), ok(BREW)), undefined);
  assert.deepEqual(result, { state: { told: {}, names: {} } }); assertions++;
}

// 2. 01:18 on 2026-10-18: Homebrew's node dies in dyld. Said once, reminded after six hours, cleared once.
{
  const first = await run(shell(ok(NODE), dyld(BREW)), undefined, AT);
  assert.match(first.notify, /^Runtime watchdog \(Hinterlands Mini\)\n• Homebrew's node link, which seven LaunchAgents and wrappers still start \(\/opt\/homebrew\/bin\/node\) will not start on the Mini \(exit 134: Library not loaded: \/opt\/homebrew\/opt\/simdjson\/lib\/libsimdjson\.29\.dylib\)\./); assertions++;
  const quiet = await run(shell(ok(NODE), dyld(BREW)), first.state, AT + 5 * 60_000);
  assert.equal(quiet.notify, undefined, "the five-minute check does not repeat itself"); assertions++;
  const reminder = await run(shell(ok(NODE), dyld(BREW)), first.state, AT + 6 * 3600_000);
  assert.match(reminder.notify, /will not start/, "reminded after six hours"); assertions++;
  const cleared = await run(shell(ok(NODE), ok(BREW)), reminder.state, AT + 7 * 3600_000);
  assert.match(cleared.notify, /• Cleared: \/opt\/homebrew\/bin\/node starts again\.$/); assertions++;
  assert.deepEqual(cleared.state.told, {}); assertions++;
}

// 3. The scheduled Node is missing (the simulated dead-runtime proof), or an
//    installer or `brew link` replaced a link: all said; the approved build is quiet.
{
  const result = await run(shell(`${NODE}|127|sh: ${NODE}: No such file or directory|`, ok(BREW)), undefined);
  assert.match(result.notify, /The Node every scheduled job runs \(\/Users\/bones\/\.local\/bin\/node\) will not start on the Mini \(exit 127: sh: /); assertions++;
  const moved = await run(shell(`${NODE}|0|v26.12.0|/opt/homebrew/Cellar/node/26.12.0/bin/node`, ok(BREW)), undefined);
  assert.match(moved.notify, /\/Users\/bones\/\.local\/bin\/node \(the Node every scheduled job runs\) now resolves to \/opt\/homebrew\/Cellar\/node\/26\.12\.0\/bin\/node \(v26\.12\.0\), not the approved official v24\.20\.0 build/); assertions++;
  const relinked = await run(shell(ok(NODE), `${BREW}|0|v26.12.0|/opt/homebrew/Cellar/node/26.12.0/bin/node`), undefined);
  assert.match(relinked.notify, /\/opt\/homebrew\/bin\/node \(Homebrew's node link, which seven LaunchAgents and wrappers still start\) now resolves to \/opt\/homebrew\/Cellar\/node\/26\.12\.0/); assertions++;
  const sameVersionElsewhere = await run(shell(`${NODE}|0|v24.20.0|/opt/homebrew/Cellar/node@24/24.20.0/bin/node`, ok(BREW)), undefined);
  assert.match(sameVersionElsewhere.notify, /now resolves to \/opt\/homebrew\/Cellar\/node@24/, "the right version from Homebrew is still a moved link"); assertions++;
  const otherVersion = await run(shell(`${NODE}|0|v24.21.0|${OFFICIAL}`, ok(BREW)), undefined);
  assert.match(otherVersion.notify, /\(v24\.21\.0\), not the approved official v24\.20\.0 build/); assertions++;
  const back = await run(shell(ok(NODE), ok(BREW)), moved.state);
  assert.match(back.notify, /• Cleared: \/Users\/bones\/\.local\/bin\/node is the approved v24\.20\.0 build again\.$/); assertions++;
}

// 3b. brew.env loses a guard (or is gone): said; restored: cleared. The probe's own
//     grep pattern counts exactly the five guard lines.
{
  const lost = await run(shell(ok(NODE), ok(BREW), "brew.env|2"), undefined);
  assert.match(lost.notify, /\/opt\/homebrew\/etc\/homebrew\/brew\.env no longer sets all five HOMEBREW_NO_\* guards \(2 of 5\)/); assertions++;
  const oneShort = await run(shell(ok(NODE), ok(BREW), "brew.env|4"), undefined);
  assert.match(oneShort.notify, /\(4 of 5\)/); assertions++;
  const gone = await run(shell(ok(NODE), ok(BREW), "brew.env|0"), undefined);
  assert.match(gone.notify, /\(0 of 5\)/); assertions++;
  const restored = await run(shell(ok(NODE), ok(BREW)), lost.state);
  assert.match(restored.notify, /Cleared: \/opt\/homebrew\/etc\/homebrew\/brew\.env sets all five guards again\./); assertions++;
  let command = "";
  await run(async (request) => { command = request.command; return shell(ok(NODE), ok(BREW))(); }, undefined);
  const pattern = new RegExp(command.match(/grep -cE '([^']+)'/)[1]);
  const guards = ["HOMEBREW_NO_AUTO_UPDATE=1", "HOMEBREW_NO_INSTALL_UPGRADE=1", "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1", "HOMEBREW_NO_INSTALL_CLEANUP=1", "HOMEBREW_NO_AUTOREMOVE=1"];
  assert.equal(guards.filter((line) => pattern.test(line)).length, 5); assertions++;
  assert.equal(["HOMEBREW_NO_AUTO_UPDATE=0", "# HOMEBREW_NO_AUTOREMOVE=1", "HOMEBREW_NO_ANALYTICS=1"].filter((line) => pattern.test(line)).length, 0); assertions++;
}

// 3c. A loaded gateway backgrounds the probe: the watchdog polls it to the end instead of crying wolf.
{
  const polls = [];
  const result = await run(async () => ({ status: "running", sessionId: "s1" }), undefined, AT,
    async (request) => { polls.push(request); return polls.length < 2 ? { status: "running", sessionId: "s1" } : shell(ok(NODE), ok(BREW))(); });
  assert.deepEqual(result, { state: { told: {}, names: {} } }); assertions++;
  assert.deepEqual(polls.map((p) => [p.action, p.sessionId]), [["poll", "s1"], ["poll", "s1"]]); assertions++;
  const stuck = await run(async () => ({ status: "running", sessionId: "s2" }), undefined, AT, async () => ({ status: "running", sessionId: "s2" }));
  assert.match(stuck.notify, /cannot start commands/); assertions++;
}

// 4. 09:21–10:27 on 2026-10-18: the gateway could not start any command (write EPIPE).
{
  const thrown = await run(async () => { throw new Error("service child cleanup identity lost: write EPIPE"); }, undefined);
  assert.match(thrown.notify, /The OpenClaw gateway on the Mini cannot start commands \(service child cleanup identity lost: write EPIPE\)/); assertions++;
  const truncated = await run(async () => ({ status: "completed", exitCode: 0, aggregated: `${ok(NODE)}\n${ok(BREW)}\n` }), undefined);
  assert.match(truncated.notify, /cannot start commands/, "output that stops before the brew.env line is a failed probe, not a crash"); assertions++;
  const failed = await run(async () => ({ status: "failed", exitCode: 1, aggregated: "" }), undefined);
  assert.match(failed.notify, /cannot start commands \(exit 1\)/); assertions++;
}

// 5. Switched-off jobs: an auto-disabled core job, a hand-disabled core job, another job
//    auto-disabled today. A job switched back on clears once.
{
  const store = ["jobs-read|116",
    ...CORE_IDS.map((id, i) => i === 2 ? coreRow(id, { enabled: 0, atMs: AT - 3600_000, errors: 10, last: "command stopped by signal SIGABRT" }) : i === 4 ? coreRow(id, { enabled: 0 }) : coreRow(id)),
    `job|32740a2f-0000-4000-8000-000000000001|dive-roster-refresh|0|${AT - 2 * 3600_000}|10|command stopped by signal SIGABRT`];
  const result = await run(shell(ok(NODE), ok(BREW), ...store), undefined);
  const lines = result.notify.split("\n").slice(1);
  assert.equal(lines.length, 3); assertions++;
  assert.equal(lines[0], `• OpenClaw switched off Dive Radio Slack alert delivery after 10 failed runs in a row (last error: command stopped by signal SIGABRT). Fix the cause, then \`openclaw cron enable ${CORE_IDS[2]}\`.`); assertions++;
  assert.match(lines[1], /^• The 08:00 Dive Radio transcript mirror is switched off in OpenClaw/); assertions++;
  assert.equal(lines[2], "• OpenClaw switched off dive-roster-refresh after 10 failed runs in a row (last error: command stopped by signal SIGABRT)."); assertions++;
  // Next check: the probe asks for the reported job by id too; all switched back on.
  let command = "";
  const back = await run(async (request) => { command = request.command; return shell(ok(NODE), ok(BREW), "jobs-read|116", ...CORE_IDS.map((id) => coreRow(id)), "job|32740a2f-0000-4000-8000-000000000001|dive-roster-refresh|1|||")(); }, result.state, AT + 600_000);
  assert.match(command, /,32740a2f-0000-4000-8000-000000000001'/, "a reported job is asked about until it clears"); assertions++;
  const cleared = back.notify.split("\n").filter((line) => line.startsWith("• Cleared:"));
  assert.deepEqual(cleared, ["• Cleared: Dive Radio Slack alert delivery is switched on again.", "• Cleared: the 08:00 Dive Radio transcript mirror is switched on again.", "• Cleared: dive-roster-refresh is switched on again."]); assertions++;
  // Still off a day later: reminded at six hours, then dropped quietly once it ages out.
  const aged = await run(shell(ok(NODE), ok(BREW), "jobs-read|116", ...CORE_IDS.map((id) => coreRow(id)), `job|32740a2f-0000-4000-8000-000000000001|dive-roster-refresh|0|${AT - 2 * 3600_000}|10|x`), { told: { "auto:32740a2f-0000-4000-8000-000000000001": AT }, names: { "auto:32740a2f-0000-4000-8000-000000000001": "dive-roster-refresh" } }, AT + 23 * 3600_000);
  assert.equal(aged.notify, undefined, "no false 'cleared' for a job that is still off"); assertions++;
  assert.deepEqual(aged.state.told, {}); assertions++;
}

// 6. A missing core job is named; an unreadable store is a run failure (failure alert), never silence.
{
  const result = await run(shell(ok(NODE), ok(BREW), "jobs-read|116", ...CORE_IDS.slice(1).map((id) => coreRow(id))), undefined);
  assert.match(result.notify, /The 07:00 Dive Radio daily run is no longer scheduled in OpenClaw/); assertions++;
  await assert.rejects(() => run(shell(ok(NODE), ok(BREW), "NO-STORE"), undefined), /could not read the automation list/); assertions++;
  await assert.rejects(() => run(shell(ok(NODE), ok(BREW), "jobs-read|0"), undefined), /could not read the automation list/); assertions++;
  // The list is read through the scheduled Node: when it is dead, its alert stands in (no throw, no false "missing").
  const dead = await run(shell(`${NODE}|134|dyld[1]: Library not loaded: x|`, ok(BREW), "NO-STORE"), undefined);
  assert.match(dead.notify, /The Node every scheduled job runs \(\/Users\/bones\/\.local\/bin\/node\) will not start/); assertions++;
  assert.doesNotMatch(dead.notify, /no longer scheduled/); assertions++;
  // More jobs than one page: a core job off the page is not called missing.
  const partial = await run(shell(ok(NODE), ok(BREW), "jobs-read|200|more", ...CORE_IDS.slice(1).map((id) => coreRow(id))), undefined);
  assert.deepEqual(partial, { state: { told: {}, names: {} } }); assertions++;
}

// 7. The probe's python3 filter, run for real on a cron.list reply shaped like the
//    gateway's (2026-10-18: the script's own automations tool saw only caller-visible
//    jobs, and the gateway's exec refuses sqlite3 on its state directory).
{
  let command = "";
  await run(async (request) => { command = request.command; return shell(ok(NODE), ok(BREW))(); }, { told: { "auto:dddddddd-0000-4000-8000-000000000004": AT }, names: {} });
  assert.match(command, /^.*'\/Users\/bones\/\.local\/bin\/node' '\/opt\/homebrew\/bin\/openclaw' gateway call cron\.list --json/, "listed with the scheduled Node"); assertions++;
  const m = command.match(/\/usr\/bin\/python3 -c '((?:[^']|'\\'')+)' '([^']*)' '(\d+)'$/);
  const program = m[1].replace(/'\\''/g, "'");
  const since = Number(m[3]);
  assert.equal(since, AT - 24 * 3600_000); assertions++;
  assert.ok(m[2].split(",").includes("dddddddd-0000-4000-8000-000000000004"), "a reported job is asked about"); assertions++;
  const day = AT - 3600_000;
  const reply = { jobs: [
    ...CORE_IDS.map((id, i) => ({ id, name: `core-${i}`, enabled: i !== 2, state: i === 2 ? { autoDisabled: { atMs: day, consecutiveErrors: 10 }, lastError: "stopped by signal SIGABRT\nline two | piped" } : {} })),
    { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "recent-off", enabled: false, state: { autoDisabled: { atMs: day, consecutiveErrors: 10 } } },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "old-off", enabled: false, state: { autoDisabled: { atMs: AT - 9 * 86400_000, consecutiveErrors: 10 } } },
    { id: "cccccccc-0000-4000-8000-000000000003", name: "healthy", enabled: true, state: {} },
    { id: "dddddddd-0000-4000-8000-000000000004", name: "reported-earlier", enabled: true, state: {} },
  ], hasMore: false };
  const out = execFileSync("/usr/bin/python3", ["-c", program, m[2], m[3]], { input: `OpenClaw 2026.10.4\n${JSON.stringify(reply, null, 2)}\n`, encoding: "utf8" }).trim().split("\n");
  assert.equal(out[0], "jobs-read|9"); assertions++;
  assert.deepEqual(out.slice(1).map((r) => r.split("|")[2]).sort(), ["core-0", "core-1", "core-2", "core-3", "core-4", "recent-off", "reported-earlier"]); assertions++;
  assert.equal(out.find((r) => r.includes("core-2")), `job|${CORE_IDS[2]}|core-2|0|${day}|10|stopped by signal SIGABRT line two / piped`, "newlines and pipes in the last error cannot break a row"); assertions++;
  const more = execFileSync("/usr/bin/python3", ["-c", program, m[2], m[3]], { input: JSON.stringify({ ...reply, hasMore: true }), encoding: "utf8" }).split("\n")[0];
  assert.equal(more, "jobs-read|9|more"); assertions++;
  const garbage = execFileSync("/usr/bin/python3", ["-c", program, m[2], m[3]], { input: "gateway closed (1006)", encoding: "utf8" });
  assert.equal(garbage, "", "an unreadable reply prints nothing, so the run fails loudly"); assertions++;
}

console.log(`runtime-watchdog-cron-script.test: ${assertions} assertions passed`);
