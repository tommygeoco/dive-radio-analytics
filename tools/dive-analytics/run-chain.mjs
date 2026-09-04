#!/usr/bin/env node
// run-chain.mjs — execute the daily chain exactly as chain.json orders it.
//
// chain.json is the single versioned definition of the chain (PRD v9 §4.5);
// the order the scheduler runs can never drift from the order the validator
// checks. A required step that fails stops the chain; an optional step that
// fails is reported and skipped — a wobbly comment pull must not cost the
// day's publish. Steps marked "when": "Mondays" run only on Phoenix Mondays.
// Model steps read their keys from the scheduler's environment; this runner
// is plain orchestration and never calls a model itself.
//
// PRD v11 (2026-09-01), rules 24–26:
//   • pull-first (W34) and heal-first (§11): the run starts on current code
//     with no conflict left behind by an earlier run
//   • W39: a required capture step (snapshot, yt-analytics) gets ONE retry
//     after RETRY_PAUSE_MS — platforms hiccup; a second failure stops the chain
//   • W37: a required-step failure, or a publish that could not confirm live
//     parity (exit 2, W38), queues one plain line into the alert queue that
//     the dive-alerts automation delivers to Slack — silence means success
//   • W40: every run's whole output is teed to
//     ~/Library/Logs/dive-radio-analytics/chain-<date>.log (30 days kept);
//     `--last` prints the last run's failing step with its surrounding lines
//
// Run:
//   node tools/dive-analytics/run-chain.mjs --dry      # print the plan, run nothing
//   node tools/dive-analytics/run-chain.mjs --rehearse # full chain, no publish-side steps
//   node tools/dive-analytics/run-chain.mjs --last     # show the last run's failure
//   node tools/dive-analytics/run-chain.mjs            # run the chain

import { readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { healLeftovers } from "./chain-heal.mjs";
import { assertPublisherCheckout } from "./publisher-checkout.mjs";
import { appendQueueLines, QUEUE_PATH, resolveOperationalAlerts } from "./alert-queue.mjs";
import { YOUTUBE_WATCH_PENDING_EXIT } from "./youtube-readiness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const chain = JSON.parse(readFileSync(join(HERE, "chain.json"), "utf8"));
const PHX_DAY = new Date(Date.now() - 7 * 3600000).toUTCString().slice(0, 3);
const PHX_DATE = new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
const dry = process.argv.includes("--dry");
const rehearse = process.argv.includes("--rehearse");
const REHEARSE_SKIP = new Set(["publish", "alerts", "freshness", "critic"]);
const RETRY_ONCE = new Set(["discover", "snapshot", "yt-analytics", "newsletter-promotion"]);   // W39: the required steps that talk to a platform
const RETRY_PAUSE_MS = 60_000;
const LOG_DIR = process.env.DIVE_CHAIN_LOG_DIR || join(homedir(), "Library", "Logs", "dive-radio-analytics");
const LOG_KEEP_DAYS = 30;
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };

// --- W40: the run log --------------------------------------------------------
let logPath = null;
function openLog() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logPath = join(LOG_DIR, `chain-${PHX_DATE}.log`);
    appendFileSync(logPath, `\n===== chain run ${new Date().toISOString()}${rehearse ? " (rehearsal)" : ""} =====\n`);
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^chain-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && Date.now() - Date.parse(`${m[1]}T12:00:00Z`) > LOG_KEEP_DAYS * 86400000) unlinkSync(join(LOG_DIR, f));
    }
  } catch (error) { console.log(`chain: run log unavailable (${error.message}) — continuing without it`); logPath = null; }
}
function log(line, stream = process.stdout) {
  stream.write(`${line}\n`);
  if (logPath) { try { appendFileSync(logPath, `${line}\n`); } catch { /* the log is a convenience, never a gate */ } }
}
function tee(chunk, stream) {
  stream.write(chunk);
  if (logPath) { try { appendFileSync(logPath, chunk); } catch { /* ditto */ } }
}
function showLast() {
  if (!existsSync(LOG_DIR)) { console.log(`chain: no run logs under ${LOG_DIR}`); return; }
  const files = readdirSync(LOG_DIR).filter((f) => /^chain-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  if (!files.length) { console.log(`chain: no run logs under ${LOG_DIR}`); return; }
  const text = readFileSync(join(LOG_DIR, files.at(-1)), "utf8");
  const runs = text.split(/\n(?======= chain run )/);
  const last = runs.at(-1).split("\n");
  // only a REQUIRED failure ends a run; an optional step's failure is noted inline and the run goes on
  const failAt = last.findIndex((l) => /^chain: .*— required, stopping here|^chain: could not|^chain: git pull --rebase failed/.test(l));
  const optional = last.filter((l) => /^chain: .* failed \(exit \d+\) — not required/.test(l)).length;
  console.log(`chain: last run in ${files.at(-1)} — ${failAt >= 0 ? "FAILED on a required step" : `no required-step failure recorded${optional ? ` (${optional} optional step(s) failed)` : ""}`}`);
  const from = failAt >= 0 ? Math.max(0, failAt - 10) : Math.max(0, last.length - 12);
  console.log(last.slice(from, failAt >= 0 ? failAt + 3 : last.length).join("\n"));
}

// --- W37: one line into the queue the dive-alerts automation delivers ----------
function queueAlert(text) {
  try {
    appendQueueLines([text], QUEUE_PATH);
    log(`chain: queued an alert — ${text}`);
  } catch (error) { log(`chain: could not queue the alert (${error.message}) — ${text}`, process.stderr); }
}
const phxClock = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour12: false, hour: "2-digit", minute: "2-digit" });

// --- W34/§11: current code, clean tree ------------------------------------------
function pullFirst() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env: ENV });
  let checkout;
  try { checkout = assertPublisherCheckout(ROOT); }
  catch (error) {
    log(`chain: ${error.message} — refusing before capture`, process.stderr);
    queueAlert(`chain: isolated publisher failed its safety check at ${phxClock()} — ${error.message}`);
    process.exit(1);
  }
  // A failed publish in the dedicated checkout may have left allowed store
  // conflicts. Only after checkout identity and scope are proved may healing
  // change those files.
  try { healLeftovers(ROOT, { log }); }
  catch (error) { log(`chain: ${error.message}`, process.stderr); queueAlert(`chain: could not start at ${phxClock()} — ${error.message}`); process.exit(1); }
  try { checkout = assertPublisherCheckout(ROOT); }
  catch (error) { log(`chain: ${error.message} after healing`, process.stderr); queueAlert(`chain: could not start at ${phxClock()} — ${error.message}`); process.exit(1); }
  const dirty = checkout.dirtyPaths;
  const stashed = dirty.length ? git(["stash", "push", "--include-untracked", "-m", "chain-pre-pull"]).status === 0 : false;
  const pull = git(["pull", "--rebase", "--quiet", "origin", "main"]);
  if (pull.status !== 0) {
    if (stashed) git(["stash", "pop"]);
    const why = (pull.stderr || pull.stdout).trim().slice(0, 300);
    log(`chain: git pull --rebase failed — ${why}`, process.stderr);
    queueAlert(`chain: could not pull main at ${phxClock()} — ${why.split("\n")[0]}`);
    process.exit(1);
  }
  if (stashed) {
    const pop = git(["stash", "pop"]);
    if (pop.status !== 0) {
      try { healLeftovers(ROOT, { log }); }
      catch (error) {
        log(`chain: ${error.message}`, process.stderr);
        queueAlert(`chain: could not restore today's stores at ${phxClock()} — ${error.message}`);
        process.exit(1);
      }
    }
  }
  try { assertPublisherCheckout(ROOT); }
  catch (error) {
    log(`chain: ${error.message} after pull — refusing before capture`, process.stderr);
    queueAlert(`chain: unsafe checkout after pull at ${phxClock()} — ${error.message}`);
    process.exit(1);
  }
  log(`chain: at main@${git(["rev-parse", "--short", "HEAD"]).stdout.trim()} after pulling origin/main`);
}

// --- one step, output streamed to the console and the log --------------------------
function runStep(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let lastErr = "";
    child.stdout.on("data", (chunk) => tee(chunk, process.stdout));
    child.stderr.on("data", (chunk) => { const t = String(chunk); lastErr = (lastErr + t).split("\n").filter(Boolean).slice(-3).join("\n"); tee(chunk, process.stderr); });
    child.on("error", (error) => resolve({ code: 1, lastErr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, lastErr }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.argv.includes("--last")) { showLast(); return; }
  if (!dry) { openLog(); pullFirst(); }
  let failedOptional = 0;
  let published = false;
  let youtubeWatchPending = false;
  for (const step of chain.steps) {
    if (step.when === "Mondays" && PHX_DAY !== "Mon") { log(`chain: ${step.step} — waits for Monday, skipped`); continue; }
    if (rehearse && REHEARSE_SKIP.has(step.step)) { log(`chain: ${step.step} — rehearsal, skipped (no publish-side effects)`); continue; }
    const parts = step.script.split(" ");
    const cmd = parts[0].endsWith(".sh") ? ["sh", ...parts] : ["node", ...parts];
    if (dry) { console.log(`chain: would run ${step.step}${step.required ? "" : " (optional)"} — ${cmd.join(" ")}`); continue; }
    log(`chain: ${step.step} …`);
    let { code, lastErr } = await runStep(cmd);
    if (step.step === "yt-analytics" && code === YOUTUBE_WATCH_PENDING_EXIT) {
      youtubeWatchPending = true;
      log("chain: newest episode YouTube watch data is not ready yet — continuing so the morning production build stays current");
      continue;
    }
    if (code !== 0 && step.required && RETRY_ONCE.has(step.step)) {
      log(`chain: ${step.step} failed (exit ${code}) — required, retrying once in ${RETRY_PAUSE_MS / 1000}s`);
      await sleep(RETRY_PAUSE_MS);
      ({ code, lastErr } = await runStep(cmd));
    }
    if (code === 0) {
      if (step.step === "publish") {
        published = true;
        try {
          resolveOperationalAlerts(QUEUE_PATH);
          log("chain: cleared resolved production warnings after parity passed");
        } catch (error) {
          code = 1;
          lastErr = `could not reconcile the alert queue after production proof — ${error.message}`;
        }
      }
      if (code === 0) continue;
    }
    if (step.required) {
      log(`chain: ${step.step} failed (exit ${code}) — required, stopping here`, process.stderr);
      const outcome = published
        ? "production was updated, but the morning checklist did not finish"
        : "production was not updated by this run";
      queueAlert(`chain: ${step.step} failed at ${phxClock()} (exit ${code})${lastErr ? ` — ${lastErr.split("\n").at(-1).slice(0, 160)}` : ""} — ${outcome}; \`node tools/dive-analytics/run-chain.mjs --last\` on the chain machine shows the log`);
      process.exit(1);
    }
    failedOptional++;
    queueAlert(`chain: optional ${step.step} check failed at ${phxClock()} (exit ${code})${lastErr ? ` — ${lastErr.split("\n").at(-1).slice(0, 160)}` : ""}; production can update, but this part of the morning data is not current`);
    log(`chain: ${step.step} failed (exit ${code}) — not required, continuing`);
  }
  if (failedOptional) {
    log(`chain: production finished with ${failedOptional} data check${failedOptional === 1 ? "" : "s"} not current`, process.stderr);
    process.exit(10);
  }
  if (youtubeWatchPending) {
    log("chain: production is current except for the newest episode's YouTube watch data; noon will run the whole chain once more");
    process.exit(YOUTUBE_WATCH_PENDING_EXIT);
  }
  try {
    resolveOperationalAlerts(QUEUE_PATH, { includeChecklist: true });
  } catch (error) {
    queueAlert(`chain: the checklist finished but its resolved warnings could not be reconciled at ${phxClock()} — ${error.message}`);
    process.exit(1);
  }
  log(`chain: done${failedOptional ? ` — ${failedOptional} optional step(s) failed` : ""}`);
}
main().catch((error) => { log(`chain: ${error.message}`, process.stderr); process.exit(1); });
