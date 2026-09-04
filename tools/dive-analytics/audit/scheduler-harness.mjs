#!/usr/bin/env node
// Controlled scheduler acceptance. Every source and deployment here is a named
// synthetic fixture in a new temporary directory. No credentials or APIs run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_ARTIFACTS } from "../public-artifacts.mjs";
import { appendQueueLines, acquireLock, readQueue, resolveOperationalAlerts } from "../alert-queue.mjs";
import { readAttemptState, runBoundedChain, runDaily } from "../run-daily.mjs";
import { recoverPublish, verifyProduction } from "../recover-publish.mjs";
import { readPublishEvidence, saveReceipt } from "../run-receipt.mjs";

const MORNING = Date.parse("2026-09-02T14:00:00Z");
const NOON = Date.parse("2026-09-02T19:15:00Z");
function fixture(base, name) {
  const root = join(base, name);
  mkdirSync(root);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Synthetic fixture", GIT_COMMITTER_NAME: "Synthetic fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  writeFileSync(join(root, "fixture.txt"), "Synthetic scheduler acceptance; never source or deployment evidence.\n");
  git("add", "fixture.txt"); git("commit", "-m", "synthetic fixture");
  const sha = git("rev-parse", "HEAD");
  const statePath = join(root, "daily-attempts.json");
  const queuePath = join(root, "alerts.json");
  const proofPath = join(root, "publish-proof.json");
  writeFileSync(queuePath, "[]\n");
  let clock = MORNING;
  const publish = (state, at) => {
    clock = at;
    const data = {
      generatedAt: new Date(at + 1000).toISOString(), episodes: [{
        ep: 1, slug: "synthetic-episode", premiere: "2026-09-01", transcript: false,
        sourceStates: { youtube: { state: "ready", checkedAt: new Date(at).toISOString(), reason: null }, watch: { state, checkedAt: new Date(at).toISOString(), reason: state === "pending" ? "Synthetic delayed source" : null } },
      }],
    };
    for (const file of PUBLIC_ARTIFACTS) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file === "data.json" ? JSON.stringify(data) + "\n" : `synthetic ${file} ${data.generatedAt}\n`);
    }
    const artifacts = PUBLIC_ARTIFACTS.map((file) => {
      const bytes = readFileSync(join(root, file));
      return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    saveReceipt(proofPath, { version: 1, sha, generatedAt: data.generatedAt, site: "https://dive-radio-analytics.vercel.app", deployment: { url: "https://synthetic.vercel.app" }, proof: { ok: true, checked: artifacts.length, artifacts, checkedAt: new Date(at + 2000).toISOString() } });
  };
  const queue = (lines) => appendQueueLines(lines, queuePath);
  const resolve = () => resolveOperationalAlerts(queuePath, { includeChecklist: true, includeYoutubeWatch: true });
  const captureReceipt = (_root, options = {}) => readPublishEvidence(root, { ...options, path: proofPath, now: clock + 10_000 });
  const daily = (state, at, mode = "primary", code = 0) => runDaily({
    root, isolatedRoot: root, statePath, now: at, mode, prepare: () => root, getOrigin: () => sha, queue, resolve, captureReceipt,
    run: async () => {
      if (code === 0 || code === 20) publish(state, at);
      return runBoundedChain(["-e", `process.exit(${Number.isInteger(code) ? code : 0})`], root, { timeoutMs: 5000 });
    },
  });
  const verify = async () => verifyProduction({
    root, statePath, now: clock + 10_000, evidence: captureReceipt,
    fetchImpl: async (url) => {
      const file = new URL(url).pathname.slice(1);
      const bytes = readFileSync(join(root, file));
      return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
    },
  });
  const recover = (options) => recoverPublish({
    root, publisherRoot: root, statePath, prepare: () => root,
    guard: (path) => acquireLock(path, { label: "daily publishing chain" }), queue, resolve, verify,
    recordProof: (proof, at) => saveReceipt(join(root, "recovery-proof.json"), { synthetic: true, checkedAt: new Date(at).toISOString(), proof }), ...options,
  });
  return { root, statePath, queuePath, proofPath, sha, daily, publish, verify, recover, captureReceipt };
}

export async function runFixtureSuite({ keep = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "dive-scheduler-synthetic."));
  const checks = [];
  try {
    const normal = fixture(base, "normal");
    assert.equal(await normal.daily("ready", MORNING), 0);
    const saved = readAttemptState(normal.statePath).days["2026-09-02"][0];
    assert.equal(saved.receipt.sha, normal.sha);
    assert.equal(saved.receipt.productionProof.ok, true);
    assert.equal(saved.receipt.sourceStates[0].watch.state, "ready");
    checks.push("normal child exit plus exact synthetic artifact receipt");

    const pending = fixture(base, "pending-recovery");
    assert.equal(await pending.daily("pending", MORNING, "primary", 20), 0);
    assert.equal(await pending.recover({ now: MORNING + 75 * 60_000, run: () => { throw new Error("morning source wait must defer"); } }), 0);
    const before = readFileSync(pending.statePath, "utf8");
    assert.equal(await pending.recover({ now: NOON, proofOnly: true, run: () => { throw new Error("proof-only must not capture"); } }), 0);
    assert.equal(readFileSync(pending.statePath, "utf8"), before);
    assert.equal(await pending.recover({ now: NOON, run: async () => ({ status: await pending.daily("ready", NOON, "recovery") }) }), 0);
    assert.equal(readAttemptState(pending.statePath).days["2026-09-02"].length, 2);
    assert.equal(await pending.recover({ now: NOON + 5000, run: () => { throw new Error("duplicate recovery must not capture"); } }), 0);
    assert.equal(readAttemptState(pending.statePath).days["2026-09-02"].length, 2);
    checks.push("pending morning, later ready recovery, proof-only and duplicate recovery preserve attempts");

    const missing = fixture(base, "exhausted-pending");
    assert.equal(await missing.daily("pending", MORNING, "primary", 20), 0);
    assert.equal(await missing.daily("pending", NOON, "recovery", 20), 0);
    const count = readQueue(missing.queuePath).length;
    assert.equal(count, 1);
    assert.equal(await missing.recover({ now: NOON + 5000, run: () => { throw new Error("third attempt forbidden"); } }), 0);
    assert.equal(readQueue(missing.queuePath).length, count);
    checks.push("exhausted pending source alerts exactly once and refuses a third capture");

    const failure = fixture(base, "failure-clear");
    assert.equal(await failure.daily("ready", MORNING, "primary", 7), 7);
    assert.equal(readQueue(failure.queuePath).length, 1);
    assert.equal(readAttemptState(failure.statePath).days["2026-09-02"][0].receipt.finalState, "failed:7");
    assert.equal(await failure.daily("ready", NOON, "recovery"), 0);
    assert.deepEqual(readQueue(failure.queuePath), []);
    checks.push("real failed child creates durable warning and later receipt-bound success clears it");

    const stale = fixture(base, "stale-proof");
    stale.publish("ready", MORNING - 20_000);
    await assert.rejects(async () => stale.captureReceipt(stale.root, { startedAt: new Date(MORNING).toISOString() }), /current release and run/);
    stale.publish("ready", MORNING);
    assert.throws(() => readPublishEvidence(stale.root, { path: stale.proofPath, now: MORNING + 999 }), /current release and run/, "a future build timestamp never proves completed publication");
    writeFileSync(join(stale.root, "data.js"), "changed after proof\n");
    assert.throws(() => stale.captureReceipt(stale.root), /no longer matches data.js/);
    checks.push("old receipt and post-proof artifact changes cannot prove a new run");

    const environmentPresence = Object.fromEntries(["BEEHIIV_API_KEY", "ANTHROPIC_API_KEY", "OP_SERVICE_ACCOUNT_TOKEN"].map((key) => [key, Boolean(process.env[key])]));
    const report = { synthetic: true, createdAt: new Date().toISOString(), root: base, checks, result: "passed", environmentPresence, sourceApisCalled: false, deploymentsMade: false, canonicalAttemptsChanged: false };
    saveReceipt(join(base, "report.json"), report);
    return report;
  } finally { if (!keep) rmSync(base, { recursive: true, force: true }); }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const mode = process.argv[process.argv.indexOf("--failure") + 1];
  if (process.argv.includes("--failure")) {
    const root = mkdtempSync(join(tmpdir(), "dive-scheduler-failed-child."));
    const result = mode === "missing-status" ? { status: null }
      : await runBoundedChain(["-e", mode === "timeout" ? "setInterval(()=>{},1000)" : "process.exit(23)"], root, { timeoutMs: 100, killGraceMs: 50 });
    const status = Number.isInteger(result.status) ? result.status : 1;
    saveReceipt(join(root, "failure-receipt.json"), { synthetic: true, case: mode, status, finalState: "failed" });
    console.error(`scheduler-harness: synthetic ${mode} correctly failed with exit ${status}; receipt ${root}/failure-receipt.json`);
    process.exitCode = status;
  } else {
    const report = await runFixtureSuite({ keep: process.argv.includes("--keep") });
    console.log(JSON.stringify(report));
  }
}
