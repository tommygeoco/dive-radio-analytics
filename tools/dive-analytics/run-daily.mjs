#!/usr/bin/env node
// run-daily.mjs — the only scheduled entry point for the publishing chain.
// It prevents overlapping runs and permits at most two whole-chain attempts
// on one Phoenix day: the 07:00 run and one morning recovery.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { acquireLock, appendQueueLines } from "./alert-queue.mjs";
import { phoenixDay } from "./freshness.mjs";
import { assertPublisherCheckout } from "./publisher-checkout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const MAX_DAILY_ATTEMPTS = 2;
export const STATE_PATH = process.env.DIVE_DAILY_STATE_PATH || join(homedir(), "Library", "Application Support", "Dive Radio Analytics", "daily-attempts.json");
const RUN_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1, timezone: "America/Phoenix", days: {} };
}

export function readAttemptState(path = STATE_PATH) {
  if (!existsSync(path)) return emptyState();
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.version !== 1 || state?.timezone !== "America/Phoenix" || !state.days || typeof state.days !== "object" || Array.isArray(state.days)) {
    throw new Error("daily attempt state is unreadable");
  }
  for (const attempts of Object.values(state.days)) {
    if (!Array.isArray(attempts)) throw new Error("daily attempt state has an invalid day");
  }
  return state;
}

function saveAttemptState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function nextAttempt(state, now = Date.now(), { mode = "primary", id = `${process.pid}-${Date.now()}`, origin = null } = {}) {
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
  return { allowed: true, day, number: attempts.length + 1, id, state: next };
}

export function finishAttempt(state, day, id, status, endedAt = Date.now()) {
  const next = structuredClone(state);
  const attempt = next.days?.[day]?.find((item) => item.id === id);
  if (!attempt) throw new Error("daily attempt record disappeared");
  attempt.status = status;
  attempt.endedAt = new Date(endedAt).toISOString();
  return next;
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

export function runDaily({
  root = ROOT,
  statePath = STATE_PATH,
  now = Date.now(),
  mode,
  run = (args) => spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" }),
} = {}) {
  assertPublisherCheckout(root);
  const release = acquireLock(`${statePath}.run.lock`, { now, label: "daily publishing chain", maxAgeMs: RUN_LOCK_MAX_AGE_MS });
  try {
    const reserved = nextAttempt(readAttemptState(statePath), now, { mode, origin: originSha(root) });
    if (!reserved.allowed) {
      const line = `Daily publish already used both automatic attempts for ${reserved.day}; no third run was started.`;
      appendQueueLines([line]);
      console.error(`daily-run: ${line}`);
      return 75;
    }
    saveAttemptState(statePath, reserved.state);
    console.log(`daily-run: ${reserved.day} attempt ${reserved.number} of ${MAX_DAILY_ATTEMPTS} (${mode}).`);
    const result = run(["tools/dive-analytics/run-chain.mjs"]);
    const status = Number.isInteger(result.status) ? result.status : 1;
    const finished = finishAttempt(readAttemptState(statePath), reserved.day, reserved.id, status === 0 ? "passed" : `failed:${status}`);
    saveAttemptState(statePath, finished);
    return status;
  } finally {
    release();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    if (process.argv.includes("--dry")) {
      assertPublisherCheckout(ROOT);
      const state = readAttemptState();
      const day = phoenixDay(Date.now());
      console.log(`daily-run: dry run — ${state.days[day]?.length || 0} of ${MAX_DAILY_ATTEMPTS} attempts recorded for ${day}; no work started.`);
    } else {
      process.exit(runDaily({ mode: modeFromArgs(process.argv.slice(2)) }));
    }
  } catch (error) {
    console.error(`daily-run: ${error.message}`);
    process.exit(1);
  }
}
