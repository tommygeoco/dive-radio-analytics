#!/usr/bin/env node
// run-daily.mjs — the only scheduled entry point for the publishing chain.
// It prevents overlapping runs and permits at most two whole-chain attempts
// on one Phoenix day: the 07:00 run and one reserved recovery. The recovery
// normally runs in the morning; YouTube's expected watch-report
// delay keeps it available for noon.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, appendQueueLines, importLegacyQueueFile, resolveOperationalAlerts } from "./alert-queue.mjs";
import { healLeftovers } from "./chain-heal.mjs";
import { phoenixDay } from "./freshness.mjs";
import { assertPublisherCheckout } from "./publisher-checkout.mjs";
import { DAILY_STATE_PATH, ISOLATED_PUBLISHER_ROOT } from "./runtime-paths.mjs";
import { YOUTUBE_WATCH_PENDING_EXIT, YOUTUBE_WATCH_PENDING_STATUS } from "./youtube-readiness.mjs";
import { lastProductionProof, pendingSourceStates, publicSourceStates, readPublishEvidence, receiptForAttempt, saveReceipt, SOURCE_PENDING_STATUS } from "./run-receipt.mjs";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const PUBLISHER_ROOT = ISOLATED_PUBLISHER_ROOT;
export const MAX_DAILY_ATTEMPTS = 2;
export const STATE_PATH = DAILY_STATE_PATH;
export const RUN_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const CHAIN_TIMEOUT_MS = 29 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };

function emptyState() {
  return { version: 1, timezone: "America/Phoenix", days: {}, invocations: {}, youtubeWatchAlerts: {} };
}

export function readAttemptState(path = STATE_PATH) {
  if (!existsSync(path)) {
    if (existsSync(`${path}.initialized-v1`)) throw new Error(`daily attempt state is missing after initialization at ${path}`);
    return emptyState();
  }
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.version !== 1 || state?.timezone !== "America/Phoenix" || !state.days || typeof state.days !== "object" || Array.isArray(state.days)) {
    throw new Error("daily attempt state is unreadable");
  }
  state.invocations ??= {};
  if (typeof state.invocations !== "object" || Array.isArray(state.invocations)) throw new Error("daily invocation state is unreadable");
  state.youtubeWatchAlerts ??= {};
  if (typeof state.youtubeWatchAlerts !== "object" || Array.isArray(state.youtubeWatchAlerts)) throw new Error("daily YouTube watch alert state is unreadable");
  state.failureAlerts ??= {};
  if (typeof state.failureAlerts !== "object" || Array.isArray(state.failureAlerts)) throw new Error("daily failure alert state is unreadable");
  for (const [day, attempts] of Object.entries(state.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(attempts) || attempts.length > MAX_DAILY_ATTEMPTS) throw new Error("daily attempt state has an invalid day");
    for (const attempt of attempts) {
      if (!attempt || typeof attempt.id !== "string" || !attempt.id || !["primary", "recovery"].includes(attempt.mode)
        || !Number.isFinite(Date.parse(attempt.startedAt)) || phoenixDay(attempt.startedAt) !== day || typeof attempt.status !== "string") {
        throw new Error("daily attempt state has an invalid attempt");
      }
    }
    if (new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length) throw new Error("daily attempt state has duplicate attempt ids");
  }
  for (const invocations of Object.values(state.invocations)) {
    if (!Array.isArray(invocations)) throw new Error("daily invocation state has an invalid day");
  }
  for (const marker of Object.values(state.youtubeWatchAlerts)) {
    if (marker?.event !== "newest-youtube-watch-still-waiting" || !Number.isFinite(Date.parse(marker?.queuedAt))) {
      throw new Error("daily YouTube watch alert state has an invalid marker");
    }
  }
  return state;
}

export function reconcileInterruptedState(state, now = Date.now()) {
  const next = structuredClone(state);
  for (const attempts of Object.values(next.days)) for (const attempt of attempts) {
    if (["running", "proving", "finishing"].includes(attempt.status)) {
      attempt.status = "failed:interrupted";
      attempt.endedAt = new Date(now).toISOString();
      if (attempt.receipt) attempt.receipt.finalState = attempt.status;
    }
  }
  for (const invocations of Object.values(next.invocations || {})) for (const invocation of invocations) {
    if (["preparing", "running", "proving", "finishing"].includes(invocation.status)) {
      invocation.status = "failed:interrupted";
      invocation.endedAt = new Date(now).toISOString();
    }
  }
  return next;
}

export function saveAttemptState(path, state) {
  saveReceipt(path, state);
  const marker = `${path}.initialized-v1`;
  if (!existsSync(marker)) saveReceipt(marker, { version: 1, initializedAt: new Date().toISOString() });
}

export function queueDailyFailure(statePath, day, line, queue, lastProof = lastProductionProof()) {
  const state = readAttemptState(statePath);
  if (state.failureAlerts[day]) return false;
  const message = `${line} Phoenix date: ${day}. Last successful production proof: ${lastProof ? `${lastProof.generatedAt} (${lastProof.sha.slice(0, 8)})` : "none recorded"}.`;
  queue([message]);
  state.failureAlerts[day] = { queuedAt: new Date().toISOString(), cause: line, lastProof };
  saveAttemptState(statePath, state);
  return true;
}

export function nextAttempt(state, now = Date.now(), { mode = "primary", id = randomUUID(), origin = null } = {}) {
  const day = phoenixDay(now);
  if (!day) throw new Error("daily attempt clock is invalid");
  const attempts = state.days[day] || [];
  if (attempts.length >= MAX_DAILY_ATTEMPTS) return { allowed: false, day, number: attempts.length + 1, state };
  const next = structuredClone(state);
  next.days[day] = [...attempts, {
    id,
    mode,
    origin,
    startedAt: new Date(now).toISOString(),
    status: "running",
  }];
  const keepAfter = Date.parse(`${day}T12:00:00Z`) - 31 * 86400000;
  for (const savedDay of Object.keys(next.days)) {
    if (Date.parse(`${savedDay}T12:00:00Z`) < keepAfter) delete next.days[savedDay];
  }
  for (const savedDay of Object.keys(next.youtubeWatchAlerts || {})) {
    if (Date.parse(`${savedDay}T12:00:00Z`) < keepAfter) delete next.youtubeWatchAlerts[savedDay];
  }
  return { allowed: true, day, number: attempts.length + 1, id, state: next };
}

export function markYoutubeWatchAlert(state, day, queuedAt = Date.now()) {
  if (state.youtubeWatchAlerts?.[day]) return { needed: false, state };
  const next = structuredClone(state);
  next.youtubeWatchAlerts ??= {};
  next.youtubeWatchAlerts[day] = {
    event: "newest-youtube-watch-still-waiting",
    queuedAt: new Date(queuedAt).toISOString(),
  };
  return { needed: true, state: next };
}

export function finishAttempt(state, day, id, status, endedAt = Date.now(), receipt = null) {
  const next = structuredClone(state);
  const attempt = next.days?.[day]?.find((item) => item.id === id);
  if (!attempt) throw new Error("daily attempt record disappeared");
  attempt.status = status;
  attempt.endedAt = new Date(endedAt).toISOString();
  if (receipt) attempt.receipt = receipt;
  return next;
}

export function startInvocation(state, now = Date.now(), { mode = "primary", id = randomUUID() } = {}) {
  const day = phoenixDay(now);
  if (!day) throw new Error("daily invocation clock is invalid");
  const next = structuredClone(state);
  next.invocations ??= {};
  next.invocations[day] = [...(next.invocations[day] || []), {
    id,
    mode,
    startedAt: new Date(now).toISOString(),
    status: "preparing",
  }];
  const keepAfter = Date.parse(`${day}T12:00:00Z`) - 31 * 86400000;
  for (const savedDay of Object.keys(next.invocations)) {
    if (Date.parse(`${savedDay}T12:00:00Z`) < keepAfter) delete next.invocations[savedDay];
  }
  return { day, id, state: next };
}

export function finishInvocation(state, day, id, status, endedAt = Date.now(), detail = null) {
  const next = structuredClone(state);
  const invocation = next.invocations?.[day]?.find((item) => item.id === id);
  if (!invocation) throw new Error("daily invocation record disappeared");
  invocation.status = status;
  invocation.endedAt = new Date(endedAt).toISOString();
  if (detail) invocation.detail = String(detail).slice(0, 500);
  return next;
}

function command(executable, args, { cwd } = {}) {
  return spawnSync(executable, args, { cwd, env: ENV, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS });
}

function checkedGit(root, args) {
  const result = command("git", args, { cwd: root });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").slice(-3).join("; ");
    throw new Error(`git ${args[0]} failed in the isolated publisher — ${detail}`);
  }
  return result.stdout.trim();
}

function gitPath(root, name) {
  const path = checkedGit(root, ["rev-parse", "--git-path", name]);
  return isAbsolute(path) ? path : join(root, path);
}

function rebaseInProgress(root) {
  return ["rebase-merge", "rebase-apply"].some((name) => existsSync(gitPath(root, name)));
}

function reconcileDataRebase(root, log) {
  for (let step = 0; step < 20 && rebaseInProgress(root); step++) {
    healLeftovers(root, { log });
    const staged = command("git", ["diff", "--cached", "--quiet"], { cwd: root });
    const action = staged.status === 0
      ? ["rebase", "--skip"]
      : ["-c", "core.editor=true", "rebase", "--continue"];
    const continued = command("git", action, { cwd: root });
    if (continued.status === 0) continue;
    const unmerged = command("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root });
    if (unmerged.status !== 0 || !unmerged.stdout.trim()) return false;
  }
  return !rebaseInProgress(root);
}

function quarantineIncompleteCheckout(isolatedRoot, log) {
  if (!existsSync(isolatedRoot) || existsSync(join(isolatedRoot, ".git"))) return null;
  const quarantined = `${isolatedRoot}.incomplete-${Date.now()}-${process.pid}`;
  renameSync(isolatedRoot, quarantined);
  log(`daily-run: moved an incomplete publisher checkout aside at ${quarantined}.`);
  return quarantined;
}

function trackedPathChanged(root, path) {
  const result = command("git", ["status", "--porcelain", "--", path], { cwd: root });
  if (result.status !== 0) throw new Error(`could not inspect the old alert queue in the isolated publisher`);
  return Boolean(result.stdout.trim());
}

export function retireLegacyQueueChange(root, log, { importQueue = importLegacyQueueFile } = {}) {
  const relative = "data/restream/alerts-pending.json";
  const path = join(root, relative);
  if (!trackedPathChanged(root, relative)) return [];
  const lines = importQueue(path);
  checkedGit(root, ["restore", "--staged", "--worktree", "--source=HEAD", "--", relative]);
  if (trackedPathChanged(root, relative)) throw new Error("the old tracked alert queue could not be retired safely");
  log(`daily-run: moved ${lines.length} pending alert line(s) from the old tracked queue into durable runtime state.`);
  return lines;
}

export function runBoundedChain(args, cwd, {
  timeoutMs = CHAIN_TIMEOUT_MS,
  killGraceMs = 5_000,
  executable = process.execPath,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let detail = "";
    const output = (chunk, stream) => {
      stream.write(chunk);
      detail = (detail + String(chunk)).slice(-4000);
    };
    child.stdout?.on("data", (chunk) => output(chunk, process.stdout));
    child.stderr?.on("data", (chunk) => output(chunk, process.stderr));
    let finished = false;
    let forceTimer = null;
    let settleTimer = null;
    let stopResult = null;
    const stop = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const groupIsAlive = () => {
      if (process.platform === "win32" || !child.pid) return child.exitCode == null;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      resolve({ ...result, detail: detail.trim().split("\n").filter(Boolean).slice(-2).join("; ").slice(-600) });
    };
    const beginStop = (status, message) => {
      if (stopResult) return;
      stopResult = { status, error: new Error(message) };
      stop("SIGTERM");
      forceTimer = setTimeout(() => {
        stop("SIGKILL");
        settleTimer = setTimeout(() => finish(stopResult), 100);
      }, killGraceMs);
    };
    const onSigterm = () => beginStop(143, "publishing chain was interrupted by SIGTERM and its process group was stopped");
    const onSigint = () => beginStop(130, "publishing chain was interrupted by SIGINT and its process group was stopped");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const timer = setTimeout(() => beginStop(
      124,
      `publishing chain exceeded ${Math.round(timeoutMs / 60000)} minutes and its process group was stopped`,
    ), timeoutMs);
    child.on("error", (error) => finish({ status: 1, error }));
    child.on("close", (code, signal) => {
      if (stopResult) {
        if (!groupIsAlive()) finish({ ...stopResult, signal });
        return;
      }
      finish({ status: Number.isInteger(code) ? code : 1, error: null, signal });
    });
  });
}

export function installPublisherHook(root) {
  const installer = join(root, "scripts", "dev", "install-hooks.sh");
  const template = readFileSync(installer, "utf8").match(/<<'HOOKEOF'\r?\n([\s\S]*?)\r?\nHOOKEOF(?:\r?\n|$)/)?.[1];
  if (!template) throw new Error("publisher hook installer has no verifiable pre-push template");
  const installed = command("sh", [installer], { cwd: root });
  if (installed.status !== 0 || installed.error || installed.signal) throw new Error("publisher pre-push hook could not be installed");
  const hookName = checkedGit(root, ["rev-parse", "--git-path", "hooks/pre-push"]);
  const hook = isAbsolute(hookName) ? hookName : join(root, hookName);
  if (readFileSync(hook, "utf8") !== `${template}\n` || (statSync(hook).mode & 0o111) === 0) {
    throw new Error("publisher pre-push hook does not match the executable repository template");
  }
  const checked = command("sh", ["-n", hook], { cwd: root });
  if (checked.status !== 0 || checked.error || checked.signal) throw new Error("publisher pre-push hook has invalid shell syntax");
  return hook;
}

export function ensureIsolatedCheckout(sourceRoot = ROOT, isolatedRoot = PUBLISHER_ROOT, { log = console.log } = {}) {
  const origin = checkedGit(sourceRoot, ["remote", "get-url", "origin"]);
  const gitDir = join(isolatedRoot, ".git");
  if (!existsSync(gitDir)) {
    quarantineIncompleteCheckout(isolatedRoot, log);
    mkdirSync(dirname(isolatedRoot), { recursive: true, mode: 0o700 });
    const cloned = command("git", ["clone", "--quiet", "--branch", "main", "--single-branch", origin, isolatedRoot], { cwd: dirname(isolatedRoot) });
    if (cloned.status !== 0) {
      const detail = String(cloned.stderr || cloned.stdout || `exit ${cloned.status}`).trim().split("\n").slice(-3).join("; ");
      throw new Error(`could not create the isolated publisher — ${detail}`);
    }
    log(`daily-run: created isolated publisher at ${isolatedRoot}.`);
  } else {
    const savedOrigin = checkedGit(isolatedRoot, ["remote", "get-url", "origin"]);
    if (savedOrigin !== origin) throw new Error("isolated publisher points at a different Git remote");
  }

  const abortedRebase = command("git", ["rebase", "--abort"], { cwd: isolatedRoot });
  if (abortedRebase.status === 0) log("daily-run: cleared an interrupted rebase in the isolated publisher.");
  const abortedMerge = command("git", ["merge", "--abort"], { cwd: isolatedRoot });
  if (abortedMerge.status === 0) log("daily-run: cleared an interrupted merge in the isolated publisher.");
  healLeftovers(isolatedRoot, { log });
  retireLegacyQueueChange(isolatedRoot, log);
  const before = assertPublisherCheckout(isolatedRoot);
  let stashed = false;
  if (before.dirtyPaths.length) {
    checkedGit(isolatedRoot, ["stash", "push", "--quiet", "--include-untracked", "-m", "isolated-pre-pull", "--", ...before.dirtyPaths]);
    stashed = true;
  }
  const pulled = command("git", ["pull", "--rebase", "--quiet", "origin", "main"], { cwd: isolatedRoot });
  if (pulled.status !== 0) {
    let reconciled = false;
    try { if (rebaseInProgress(isolatedRoot)) reconciled = reconcileDataRebase(isolatedRoot, log); }
    catch { reconciled = false; }
    if (reconciled) {
      log("daily-run: reconciled saved data with newer main changes in the isolated publisher.");
    } else {
      command("git", ["rebase", "--abort"], { cwd: isolatedRoot });
      if (stashed) {
        const restored = command("git", ["stash", "pop", "--quiet"], { cwd: isolatedRoot });
        if (restored.status !== 0) healLeftovers(isolatedRoot, { log });
      }
      const detail = String(pulled.stderr || pulled.stdout || `exit ${pulled.status}`).trim().split("\n").slice(-3).join("; ");
      throw new Error(`isolated publisher could not update from main — ${detail}`);
    }
  }
  if (stashed) {
    const restored = command("git", ["stash", "pop", "--quiet"], { cwd: isolatedRoot });
    if (restored.status !== 0) healLeftovers(isolatedRoot, { log });
  }
  assertPublisherCheckout(isolatedRoot);
  installPublisherHook(isolatedRoot);

  const sourceProject = join(sourceRoot, ".vercel", "project.json");
  const isolatedProject = join(isolatedRoot, ".vercel", "project.json");
  if (existsSync(sourceProject) && resolve(sourceProject) !== resolve(isolatedProject)) {
    mkdirSync(dirname(isolatedProject), { recursive: true, mode: 0o700 });
    copyFileSync(sourceProject, isolatedProject);
  } else if (!existsSync(isolatedProject)) {
    throw new Error("Vercel project link is missing from both the launcher and isolated publisher");
  }
  return isolatedRoot;
}

function originSha(root) {
  const result = spawnSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function modeFromArgs(args) {
  const modes = ["primary", "recovery"].filter((mode) => args.includes(`--${mode}`));
  if (modes.length !== 1) throw new Error("choose exactly one run mode: --primary or --recovery");
  return modes[0];
}

export async function runDaily({
  root = ROOT,
  isolatedRoot = PUBLISHER_ROOT,
  statePath = STATE_PATH,
  now = Date.now(),
  mode,
  prepare = (source, target) => ensureIsolatedCheckout(source, target),
  getOrigin = originSha,
  queue = (lines) => appendQueueLines(lines),
  run = (args, cwd) => runBoundedChain(args, cwd, { env: { ...process.env, DIVE_DAILY_OWNS_ALERTS: "1" } }),
  captureReceipt = (publisherRoot, options) => readPublishEvidence(publisherRoot, options),
  resolve = () => resolveOperationalAlerts(undefined, { includeChecklist: true, includeYoutubeWatch: true }),
} = {}) {
  const release = acquireLock(`${statePath}.run.lock`, { now, label: "daily publishing chain", maxAgeMs: RUN_LOCK_MAX_AGE_MS });
  try {
    const invocation = startInvocation(reconcileInterruptedState(readAttemptState(statePath), now), now, { mode });
    saveAttemptState(statePath, invocation.state);
    let publisherRoot;
    try {
      publisherRoot = prepare(root, isolatedRoot);
    } catch (error) {
      const failed = finishInvocation(readAttemptState(statePath), invocation.day, invocation.id, "failed:preflight", Date.now(), error.message);
      saveAttemptState(statePath, failed);
      const line = `Daily publish could not prepare its isolated checkout — ${error.message}.`;
      try { queueDailyFailure(statePath, invocation.day, line, queue); } catch (queueError) { console.error(`daily-run: could not queue the preflight alert (${queueError.message}).`); }
      console.error(`daily-run: ${line}`);
      return 1;
    }

    const reserved = nextAttempt(readAttemptState(statePath), now, { mode, origin: getOrigin(publisherRoot) });
    if (!reserved.allowed) {
      const line = `Daily publish already used both automatic attempts for ${reserved.day}; no third run was started.`;
      const refused = finishInvocation(reserved.state, invocation.day, invocation.id, "refused:attempt-limit");
      saveAttemptState(statePath, refused);
      try { queueDailyFailure(statePath, invocation.day, line, queue); } catch (queueError) { console.error(`daily-run: could not queue the attempt-limit alert (${queueError.message}).`); }
      console.error(`daily-run: ${line}`);
      return 75;
    }
    saveAttemptState(statePath, reserved.state);
    console.log(`daily-run: ${reserved.day} attempt ${reserved.number} of ${MAX_DAILY_ATTEMPTS} (${mode}).`);
    let result;
    let runError = null;
    try {
      result = await run(["tools/dive-analytics/run-chain.mjs"], publisherRoot);
    } catch (error) {
      runError = error;
      result = { status: 1 };
    }
    if (!Number.isInteger(result?.status) && result?.error) runError = result.error;
    let status = Number.isInteger(result?.status) && !result?.error && !result?.signal ? result.status : 1;
    let evidence = null;
    if (status === 0 || status === YOUTUBE_WATCH_PENDING_EXIT) {
      try {
        evidence = captureReceipt(publisherRoot, { now: Date.now(), startedAt: new Date(now).toISOString() });
        if (!evidence?.proof?.ok || !evidence?.sha || !evidence?.generatedAt) throw new Error("completed child returned no production evidence");
        if (pendingSourceStates(evidence.sourceStates || []).length) status = YOUTUBE_WATCH_PENDING_EXIT;
      } catch (error) {
        runError = error;
        status = 1;
      }
    }
    const savedStatus = status === 0
      ? "passed"
      : status === YOUTUBE_WATCH_PENDING_EXIT
        ? pendingSourceStates(evidence?.sourceStates || []).some((source) => source.source !== "watch") ? SOURCE_PENDING_STATUS : YOUTUBE_WATCH_PENDING_STATUS
        : `failed:${status}`;
    const endedAt = Date.now();
    const receipt = receiptForAttempt(evidence, {
      day: reserved.day, number: reserved.number, mode,
      startedAt: new Date(now).toISOString(), endedAt: new Date(endedAt).toISOString(), status: savedStatus,
    });
    receipt.lastSuccessfulProof = evidence ? { sha: evidence.sha, generatedAt: evidence.generatedAt, checkedAt: evidence.proof.checkedAt } : lastProductionProof();
    if (!evidence) {
      try { receipt.sourceStates = publicSourceStates(JSON.parse(readFileSync(join(publisherRoot, "data.json"), "utf8")), now); }
      catch { /* An unreadable build is named by the failed receipt, never fabricated. */ }
    }
    const finishing = status === 0 || status === YOUTUBE_WATCH_PENDING_EXIT;
    const intermediateStatus = finishing ? "finishing" : savedStatus;
    let finished = finishAttempt(readAttemptState(statePath), reserved.day, reserved.id, intermediateStatus, endedAt, { ...receipt, finalState: intermediateStatus });
    finished = finishInvocation(finished, invocation.day, invocation.id, intermediateStatus, Date.now(), runError?.message || null);
    saveAttemptState(statePath, finished);
    const finalize = () => {
      const finalTime = Date.now();
      const finalReceipt = { ...receipt, endedAt: new Date(finalTime).toISOString(), finalState: savedStatus };
      const finalState = finishAttempt(readAttemptState(statePath), reserved.day, reserved.id, savedStatus, finalTime, finalReceipt);
      saveAttemptState(statePath, finishInvocation(finalState, invocation.day, invocation.id, savedStatus, finalTime));
    };
    if (status === YOUTUBE_WATCH_PENDING_EXIT) {
      const finalAttempt = reserved.number >= MAX_DAILY_ATTEMPTS;
      if (finalAttempt) {
        const alert = markYoutubeWatchAlert(readAttemptState(statePath), reserved.day);
        if (alert.needed) {
          const pending = pendingSourceStates(evidence?.sourceStates || []);
          const line = savedStatus === YOUTUBE_WATCH_PENDING_STATUS
            ? `Newest episode YouTube watch data is still unavailable after the ${reserved.day} recovery run; production is current, but watch measures remain missing. Last production proof: ${evidence.generatedAt} (${evidence.sha.slice(0, 8)}).`
            : `Daily publishing source data remains unavailable on ${reserved.day}: ${pending.map((source) => `E${source.episode} ${source.source}: ${source.reason || source.state}`).join("; ") || "source reported pending"}. Last production proof: ${evidence.generatedAt} (${evidence.sha.slice(0, 8)}).`;
          try {
            queue([line]);
            saveAttemptState(statePath, alert.state);
            console.log("daily-run: queued today's missing YouTube watch alert after the recovery check.");
          } catch (error) {
            const alertFailed = finishAttempt(readAttemptState(statePath), reserved.day, reserved.id, "failed:alert", Date.now(), { ...receipt, finalState: "failed:alert" });
            saveAttemptState(statePath, finishInvocation(alertFailed, invocation.day, invocation.id, "failed:alert", Date.now(), error.message));
            console.error(`daily-run: could not save the missing YouTube watch alert (${error.message}).`);
            return 1;
          }
        }
      }
      console.log(!finalAttempt
        ? "daily-run: production was updated with the data available now; pending sources will be tried again at noon."
        : "daily-run: production was updated with the data available now; sources remain unavailable and no third run will start today.");
      finalize();
      return 0;
    }
    if (status !== 0) {
      const line = runError
        ? `Daily publishing chain stopped — ${runError.message}.`
        : `Daily publishing checklist failed (exit ${status}); production needs verification.${result?.detail ? ` Cause: ${result.detail}` : ""}`;
      try { queueDailyFailure(statePath, invocation.day, line, queue, receipt.lastSuccessfulProof); } catch (queueError) { console.error(`daily-run: could not queue the chain alert (${queueError.message}).`); }
      console.error(`daily-run: ${line}`);
    } else {
      try {
        resolve();
        const cleared = readAttemptState(statePath);
        delete cleared.failureAlerts[reserved.day];
        saveAttemptState(statePath, cleared);
        finalize();
      }
      catch (error) {
        const failed = finishAttempt(readAttemptState(statePath), reserved.day, reserved.id, "failed:alert-resolution", Date.now(), { ...receipt, finalState: "failed:alert-resolution" });
        saveAttemptState(statePath, finishInvocation(failed, invocation.day, invocation.id, "failed:alert-resolution", Date.now(), error.message));
        console.error(`daily-run: production was proved, but alert resolution failed (${error.message}).`);
        return 1;
      }
    }
    return status;
  } finally {
    release();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    if (process.argv.includes("--dry")) {
      const state = readAttemptState();
      const day = phoenixDay(Date.now());
      console.log(`daily-run: dry run — ${state.days[day]?.length || 0} of ${MAX_DAILY_ATTEMPTS} attempts recorded for ${day}; isolated publisher ${PUBLISHER_ROOT}; no work started.`);
    } else {
      runDaily({ mode: modeFromArgs(process.argv.slice(2)) }).then((status) => process.exit(status)).catch((error) => {
        console.error(`daily-run: ${error.message}`);
        process.exit(1);
      });
    }
  } catch (error) {
    console.error(`daily-run: ${error.message}`);
    process.exit(1);
  }
}
