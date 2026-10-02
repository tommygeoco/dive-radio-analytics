#!/usr/bin/env node
// scheduler-watch.mjs — keeps the OpenClaw automations that publish the
// dashboard switched on, and says so in Slack when it cannot.
//
// OpenClaw switches a recurring automation off after 10 nonzero exits in a row
// (state.autoDisabled, reason "consecutive-failures") and tells only its own
// agent. That silently stopped the 07:00 run on 2026-09-30 and 2026-10-01: the
// streak was built from handled outcomes (exit 10, 75) plus sentinel replays,
// and nobody was told. Two guards follow:
//
//   1. schedulerExit() — the scheduled entry points report a handled outcome
//      (published with an optional step failed; a replay or third run refused)
//      to the scheduler as 0. The attempt ledger keeps the true status and the
//      alert queue already carries the line; only the scheduler's count changes.
//   2. checkScheduler() — runs from every scheduled entry point (dive-alerts
//      every five minutes, the daily run, the recovery check). It switches an
//      auto-disabled core automation back on and queues one line per job per
//      Phoenix day for anything it cannot fix: switched off by a person,
//      missing, unreadable, or failing repeatedly.
//
// It never runs the chain, never edits a schedule or command, and never
// touches an automation outside CORE_JOBS. Entry points act only from the
// publisher checkout; fixtures inject read/enable/queue.
//
//   node tools/dive-analytics/scheduler-watch.mjs        # check once, print what it did

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, appendQueueLines } from "./alert-queue.mjs";
import { phoenixDay } from "./freshness.mjs";
import { saveReceipt } from "./run-receipt.mjs";
import { ISOLATED_PUBLISHER_ROOT, RUNTIME_DIR } from "./runtime-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SCHEDULER_WATCH_PATH = process.env.DIVE_SCHEDULER_WATCH_PATH
  || join(RUNTIME_DIR, "scheduler-watch.json");
export const OPENCLAW_DISABLE_AT = 10; // OpenClaw's fixed consecutive-failure limit (2026.9.x)
export const STREAK_WARNING = 5;
export const AUTO_DISABLE_REASONS = ["consecutive-failures", "schedule-errors"];
// Exit codes whose outcome is already durable in the attempt ledger and queued
// for Slack: 10 = published, an optional step failed; 75 = replay or third run
// refused by the ledger. Everything else (1, crashes, signals) stays nonzero.
export const HANDLED_EXITS = [10, 75];

const ends = (argv, path) => argv.some((arg) => typeof arg === "string" && (arg === path || arg.endsWith(`/${path}`)));
export const CORE_JOBS = [
  { key: "primary", label: "The 07:00 daily run", match: (argv) => ends(argv, "tools/dive-analytics/run-daily.mjs") && argv.includes("--primary") },
  { key: "recovery", label: "The 08:15/12:15 recovery check", match: (argv) => ends(argv, "tools/dive-analytics/recover-publish.mjs") },
  { key: "alerts", label: "Slack alert delivery", match: (argv) => ends(argv, "tools/dive-analytics/alerts.mjs") && argv.includes("--deliver") },
  { key: "ingest", label: "The 06:50 Restream ingest", match: (argv) => ends(argv, "scripts/restream/ingest-restream.mjs") },
];

export function schedulerExit(status) {
  return HANDLED_EXITS.includes(status) ? 0 : status;
}

// Exit for a scheduled entry point: the true status is logged, the handled
// ones reach OpenClaw as 0 so they never build a disable streak.
export function exitForScheduler(status, name, log = console.log) {
  const reported = schedulerExit(status);
  if (reported !== status) log(`${name}: outcome ${status} is recorded in the attempt ledger and queued for Slack; reporting 0 so OpenClaw does not count a handled outcome toward switching this automation off.`);
  return reported;
}

function parseJobs(stdout) {
  const text = String(stdout ?? "");
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in the automation list");
  const value = JSON.parse(text.slice(start));
  const jobs = Array.isArray(value) ? value : value?.jobs;
  if (!Array.isArray(jobs)) throw new Error("the automation list has no jobs array");
  return jobs;
}

const phxClock = (now) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" }).format(now);
const failed = (result) => !result || result.error || result.signal || result.status !== 0;

function readState(path) {
  if (!existsSync(path)) return { version: 1, days: {} };
  const value = JSON.parse(readFileSync(path, "utf8")); // corrupt state = loud, never a silent reset
  if (value?.version !== 1 || typeof value.days !== "object" || !value.days) throw new Error("scheduler watch state is unreadable");
  return value;
}

export function checkScheduler({
  read = () => spawnSync("openclaw", ["cron", "list", "--all", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }),
  enable = (id) => spawnSync("openclaw", ["cron", "enable", id, "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 }),
  queue = (lines) => appendQueueLines(lines),
  statePath = SCHEDULER_WATCH_PATH,
  now = Date.now(),
  lock = () => acquireLock(`${statePath}.lock`, { label: "scheduler watch", maxAgeMs: 2 * 60 * 1000 }),
} = {}) {
  let release;
  try { release = lock(); }
  catch (error) {
    if (/already in use/.test(error.message)) return { skipped: "another scheduler check is running", lines: [], enabled: [] };
    throw error;
  }
  try {
    const day = phoenixDay(now);
    const state = readState(statePath);
    const marks = state.days[day] ?? {};
    const lines = [];
    const enabled = [];
    // One line per job and problem per Phoenix day; the check runs every five
    // minutes and must not repeat itself.
    const once = (key, line) => { if (marks[key]) return; marks[key] = new Date(now).toISOString(); lines.push(line); };

    let jobs = null;
    let result;
    try { result = read(); } catch (error) { result = { status: null, error }; }
    if (failed(result)) {
      once("list:unreadable", `The OpenClaw automation list could not be read on the chain machine (${String(result?.error?.message || result?.stderr || `exit ${result?.status}`).trim().split("\n").at(-1).slice(0, 160)}), so nothing can confirm the daily run is switched on.`);
    } else {
      try { jobs = parseJobs(result.stdout); }
      catch (error) { once("list:unreadable", `The OpenClaw automation list was unreadable (${error.message}), so nothing can confirm the daily run is switched on.`); }
    }

    for (const core of jobs ? CORE_JOBS : []) {
      const matches = jobs.filter((job) => job?.schedule?.kind === "cron" && Array.isArray(job?.payload?.argv) && core.match(job.payload.argv));
      if (!matches.length) {
        once(`${core.key}:missing`, `${core.label} is not scheduled in OpenClaw on the chain machine, so it will not run until it is added back.`);
        continue;
      }
      for (const job of matches) {
        const streak = Number.isInteger(job.state?.consecutiveErrors) ? job.state.consecutiveErrors : 0;
        if (job.enabled === false) {
          const auto = job.state?.autoDisabled;
          if (auto && AUTO_DISABLE_REASONS.includes(auto.reason)) {
            let outcome;
            try { outcome = enable(job.id); } catch (error) { outcome = { status: null, error }; }
            if (failed(outcome)) {
              once(`${core.key}:${job.id}:enable-failed`, `OpenClaw switched off ${core.label.toLowerCase()} after ${auto.consecutiveErrors ?? "repeated"} failed runs in a row, and the watchdog could not switch it back on; run \`openclaw cron enable ${job.id}\` on the chain machine.`);
            } else {
              enabled.push(job.id);
              once(`${core.key}:${job.id}:re-enabled`, `OpenClaw switched off ${core.label.toLowerCase()} after ${auto.consecutiveErrors ?? "repeated"} failed runs in a row; the watchdog switched it back on at ${phxClock(now)}. Earlier alerts name the failures.`);
            }
          } else {
            once(`${core.key}:${job.id}:disabled`, `${core.label} is switched off in OpenClaw, so it will not run until someone switches it back on (\`openclaw cron enable ${job.id}\` on the chain machine).`);
          }
        } else if (streak >= STREAK_WARNING) {
          once(`${core.key}:${job.id}:streak`, `${core.label} has failed ${streak} runs in a row; OpenClaw switches an automation off at ${OPENCLAW_DISABLE_AT}, and the watchdog will switch it back on if that happens.`);
        }
      }
    }

    if (lines.length) queue(lines);
    // Markers are saved only after the lines are queued: a failed queue write
    // leaves the day unmarked, so the next check tries again.
    state.days[day] = marks;
    for (const old of Object.keys(state.days).sort().slice(0, -14)) delete state.days[old];
    if (lines.length || !existsSync(statePath)) saveReceipt(statePath, state);
    return { lines, enabled, checked: jobs ? jobs.length : 0 };
  } finally {
    release();
  }
}

const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

// Scheduled entry points call this; it never changes their outcome. It acts
// only from the dedicated publisher checkout the automations run in, so a
// fixture, a /tmp clone or a development tree never touches the scheduler.
export function watchSchedulerQuietly(name, log = console.log, { root = ROOT, publisherRoot = ISOLATED_PUBLISHER_ROOT, ...options } = {}) {
  if (!same(root, publisherRoot)) return { skipped: "not the publisher checkout", lines: [], enabled: [] };
  try {
    const result = checkScheduler(options);
    if (result.enabled?.length) log(`${name}: switched ${result.enabled.length} auto-disabled automation(s) back on (${result.enabled.join(", ")}).`);
    for (const line of result.lines || []) log(`${name}: scheduler watch — ${line}`);
    return result;
  } catch (error) {
    console.error(`${name}: scheduler watch failed (${error.message}); continuing.`);
    return null;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = checkScheduler();
    if (result.skipped) console.log(`scheduler-watch: ${result.skipped}.`);
    else console.log(`scheduler-watch: ${result.checked} automation(s) read; ${result.enabled.length} switched back on; ${result.lines.length} line(s) queued.${result.lines.map((line) => `\n  ${line}`).join("")}`);
  } catch (error) {
    console.error(`scheduler-watch: ${error.message}`);
    process.exit(1);
  }
}
