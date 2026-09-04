#!/usr/bin/env node
// publish-flow.mjs — publish one validated data build from the dedicated
// checkout, then prove that production serves the same bytes.
//
// Every external command is checked. Git push, Vercel deploy, and live proof
// each stop after two attempts. A moving main branch is rebased once and the
// final build is rebuilt and validated again before it can be pushed.

import { spawnSync } from "node:child_process";
import { atomicWriteJson } from "./source-io.mjs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublisherCheckout } from "./publisher-checkout.mjs";
import { stagePublishScope } from "./publish-scope.mjs";
import { healLeftovers } from "./chain-heal.mjs";
import { checkLiveParity, SITE } from "./live-parity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const MAX_ATTEMPTS = 2;
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };

function tail(text, lines = 12) {
  return String(text || "").trim().split("\n").filter(Boolean).slice(-lines).join("\n");
}

function command(root, executable, args, { allowFailure = false, env = ENV, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    killSignal: "SIGKILL",
  });
  const status = !result.error && !result.signal && Number.isInteger(result.status) ? result.status : 1;
  if (!allowFailure && status !== 0) {
    const detail = tail(result.stderr || result.stdout) || `exit ${status}`;
    throw new Error(`${executable} ${args[0] || ""} failed — ${detail}`);
  }
  return { status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

const git = (root, args, options) => command(root, "git", args, options);
const gitText = (root, args) => git(root, args).stdout.trim();

function runBuildAndValidation(root, log) {
  log("publish: rebuilding the public files from the final stores.");
  command(root, process.execPath, ["tools/dive-analytics/ratings.mjs"]);
  command(root, process.execPath, ["tools/dive-analytics/build-data.mjs"]);
  log("publish: checking the final files before release.");
  command(root, process.execPath, ["tools/dive-analytics/audit/validate.mjs"]);
}

function restoreAfterPull(root, stashed, log) {
  if (!stashed) return;
  const pop = git(root, ["stash", "pop", "--quiet"], { allowFailure: true });
  if (pop.status === 0) return;
  log("publish: today's store changes met newer main changes; applying the safe store merge.");
  healLeftovers(root, { log });
}

function pullCurrentMain(root, log) {
  const state = assertPublisherCheckout(root);
  let stashed = false;
  if (state.dirtyPaths.length) {
    git(root, ["stash", "push", "--quiet", "--include-untracked", "-m", "publish-pre-pull", "--", ...state.dirtyPaths]);
    stashed = true;
  }
  const pull = git(root, ["pull", "--rebase", "--quiet", "origin", "main"], { allowFailure: true });
  if (pull.status !== 0) {
    if (stashed) git(root, ["stash", "pop", "--quiet"], { allowFailure: true });
    throw new Error(`git pull failed — ${tail(pull.stderr || pull.stdout) || `exit ${pull.status}`}`);
  }
  restoreAfterPull(root, stashed, log);
  assertPublisherCheckout(root);
}

function commitFinalOutputs(root) {
  stagePublishScope(root);
  const staged = git(root, ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (staged.status === 0) return false;
  if (staged.status !== 1) throw new Error(`git diff failed — ${tail(staged.stderr || staged.stdout)}`);
  const stamp = new Date().toLocaleString("sv-SE", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  git(root, ["commit", "--quiet", "-m", `data refresh ${stamp} MST`]);
  return true;
}

function rebaseIfMainMoved(root, log) {
  git(root, ["fetch", "--quiet", "origin", "main"]);
  const ancestor = git(root, ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { allowFailure: true });
  if (ancestor.status === 0) return false;
  if (ancestor.status !== 1) throw new Error(`git merge-base failed — ${tail(ancestor.stderr || ancestor.stdout)}`);

  log("publish: main moved during the run; rebasing once and checking the final files again.");
  const rebase = git(root, ["rebase", "origin/main"], { allowFailure: true });
  if (rebase.status !== 0) {
    git(root, ["rebase", "--abort"], { allowFailure: true });
    throw new Error(`new main conflicts with today's data — ${tail(rebase.stderr || rebase.stdout)}`);
  }
  runBuildAndValidation(root, log);
  stagePublishScope(root);
  const staged = git(root, ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (staged.status === 1) {
    const ahead = Number(gitText(root, ["rev-list", "--count", "origin/main..HEAD"]));
    if (ahead > 0) git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    else commitFinalOutputs(root);
  } else if (staged.status !== 0) {
    throw new Error(`git diff failed after rebase — ${tail(staged.stderr || staged.stdout)}`);
  }
  return true;
}

export function pushMain(root, log = console.log) {
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    rebaseIfMainMoved(root, log);
    const push = git(root, ["push", "--quiet", "origin", "HEAD:main"], { allowFailure: true });
    if (push.status === 0) {
      git(root, ["fetch", "--quiet", "origin", "main"]);
      const local = gitText(root, ["rev-parse", "HEAD"]);
      const remote = gitText(root, ["rev-parse", "origin/main"]);
      if (local !== remote) throw new Error("GitHub did not move to the checked release commit");
      log(`publish: GitHub main is ${local.slice(0, 8)}.`);
      return local;
    }
    last = tail(push.stderr || push.stdout) || `exit ${push.status}`;
    if (attempt < MAX_ATTEMPTS) log("publish: the first push lost a race; refreshing main once.");
  }
  throw new Error(`push failed twice — ${last}`);
}

export async function deployWithParity({
  deploy,
  parity,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 5_000,
  log = console.log,
  attempts = MAX_ATTEMPTS,
} = {}) {
  let last = "production did not confirm the release";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const released = await deploy(attempt);
    if (!released.ok) {
      last = released.message || `deploy attempt ${attempt} failed`;
      log(`publish: deploy attempt ${attempt} failed${attempt < attempts ? "; trying once more" : ""}.`);
      continue;
    }
    if (waitMs) await sleep(waitMs);
    const proof = await parity(attempt);
    if (proof.ok) return { ok: true, attempt, proof };
    last = proof.message || `live bytes differed after deploy attempt ${attempt}`;
    log(`publish: live proof after deploy attempt ${attempt} failed${attempt < attempts ? "; deploying once more" : ""}.`);
  }
  return { ok: false, message: last };
}

function assertCleanRelease(root, sha) {
  const state = assertPublisherCheckout(root);
  if (state.dirtyPaths.length) throw new Error("release checkout changed after validation");
  if (gitText(root, ["rev-parse", "HEAD"]) !== sha) throw new Error("release HEAD changed after validation");
  if (gitText(root, ["rev-parse", "origin/main"]) !== sha) throw new Error("release is not exact origin/main");
}

async function deployProduction(root, sha, log) {
  let deploymentUrl = null;
  if (process.env.DIVE_PROD_SITE && process.env.DIVE_PROD_SITE !== SITE) throw new Error("production proof must use the canonical Dive Radio alias");
  const site = SITE;
  const result = await deployWithParity({
    log,
    deploy: async () => {
      git(root, ["fetch", "--quiet", "origin", "main"]);
      assertCleanRelease(root, sha);
      // The hook also runs this gate, but every deploy is independently gated.
      command(root, process.execPath, ["tools/dive-analytics/release-gate.mjs"], { timeout: 20 * 60_000 });
      assertCleanRelease(root, sha);
      const run = command(root, "vercel", ["deploy", "--prod", "--yes"], { allowFailure: true, timeout: 10 * 60_000 });
      deploymentUrl = (run.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) || []).at(-1) || null;
      const summary = tail(run.stdout || run.stderr, 3);
      if (summary) log(summary);
      return run.status === 0 && deploymentUrl
        ? { ok: true }
        : { ok: false, message: tail(run.stderr || run.stdout) || `Vercel exit ${run.status}` };
    },
    parity: async () => {
      try {
        const proof = await checkLiveParity({ root, site, cacheBust: String(Date.now()) });
        return proof.ok
          ? { ...proof, ok: true }
          : { ok: false, message: proof.mismatches.map((item) => `${item.file}: ${item.reason}`).join("; ") };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },
  });
  if (!result.ok) throw new Error(`production was not confirmed after two deploy attempts — ${result.message}`);
  assertCleanRelease(root, sha);
  const receipt = { version: 1, sha, generatedAt: result.proof.generatedAt, site,
    deployment: { url: deploymentUrl }, proof: result.proof };
  const proofPath = process.env.DIVE_PUBLISH_PROOF_PATH || join(process.env.DIVE_RUNTIME_DIR || join(homedir(), "Library", "Application Support", "Dive Radio Analytics"), "publish-proof.json");
  atomicWriteJson(proofPath, receipt, { mode: 0o600 });
  log(`publish: production matches all ${result.proof.checked} public files byte-for-byte.`);
  return receipt;
}

export async function publishRelease({ root = ROOT, log = console.log } = {}) {
  const origin = gitText(root, ["remote", "get-url", "origin"]);
  if (!/^(https:\/\/github\.com\/|git@github\.com:)tommygeoco\/dive-radio-analytics(?:\.git)?$/.test(origin)) throw new Error("publisher origin is not the Dive Radio repository");
  assertPublisherCheckout(root);
  healLeftovers(root, { log });
  pullCurrentMain(root, log);
  runBuildAndValidation(root, log);
  const committed = commitFinalOutputs(root);
  log(committed ? "publish: committed today's declared chain outputs." : "publish: no new data commit was needed.");
  const sha = pushMain(root, log);
  const receipt = await deployProduction(root, sha, log);
  assertCleanRelease(root, sha);
  return receipt;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--dry")) {
    try {
      const state = assertPublisherCheckout(ROOT);
      console.log(`publish: dry run — main checkout is safe; ${state.dirtyPaths.length} declared chain-output change(s) would be rebuilt, validated, committed, pushed, deployed, and checked.`);
    } catch (error) {
      console.error(`publish: ${error.message}`);
      process.exit(1);
    }
  } else {
    publishRelease().catch((error) => {
      console.error(`publish: ${error.message}`);
      process.exit(1);
    });
  }
}
