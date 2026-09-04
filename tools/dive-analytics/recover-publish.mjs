#!/usr/bin/env node
// recover-publish.mjs — verify production after the morning chain and use the
// one reserved recovery attempt. A normal failure uses it during the morning
// window. When production is current and the only pending item is the newest
// episode's YouTube watch report, 08:15 leaves the attempt unused and noon
// runs the whole chain again. run-daily still enforces the two-attempt cap.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, appendQueueLines, resolveOperationalAlerts } from "./alert-queue.mjs";
import { checkProductionFreshness, phoenixDay, phoenixHour } from "./freshness.mjs";
import { checkLiveParity, SITE } from "./live-parity.mjs";
import { ensureIsolatedCheckout, PUBLISHER_ROOT, readAttemptState, RUN_LOCK_MAX_AGE_MS, STATE_PATH } from "./run-daily.mjs";
import { isYoutubeWatchPendingStatus } from "./youtube-readiness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
const MORNING_START = 7;
const MORNING_END = 10;
const NOON_START = 12;
const NOON_END = 13;
const LOCK_CHECKS = 4;
const LOCK_WAIT_MS = 15_000;

export function recoveryAction(proof, now = Date.now()) {
  if (proof.ok) return "done";
  const hour = phoenixHour(now);
  if (proof.youtubeWatchPending === true && proof.freshness?.ok === true && proof.parity?.ok === true) {
    if (hour != null && hour >= MORNING_START && hour < MORNING_END) return "defer";
    if (hour != null && hour >= NOON_START && hour < NOON_END) return "recover";
  }
  if (hour != null && hour >= MORNING_START && hour < MORNING_END) return "recover";
  return "fail";
}

export function checklistVerdict(statePath = STATE_PATH, now = Date.now()) {
  try {
    const state = readAttemptState(statePath);
    const day = phoenixDay(now);
    const attempt = state.days?.[day]?.at(-1);
    const invocation = state.invocations?.[day]?.at(-1);
    const ok = attempt?.status === "passed" && invocation?.status === "passed";
    const youtubeWatchPending = isYoutubeWatchPendingStatus(attempt?.status)
      && isYoutubeWatchPendingStatus(invocation?.status);
    return ok
      ? { ok: true, youtubeWatchPending: false, message: "today's complete publishing checklist passed" }
      : {
          ok: false,
          youtubeWatchPending,
          message: youtubeWatchPending
            ? "the newest episode's YouTube watch data is not ready yet"
            : attempt || invocation
              ? `today's publishing checklist last ended ${attempt?.status || invocation?.status || "without a result"}`
              : "today's publishing checklist has no recorded run",
        };
  } catch (error) {
    return { ok: false, message: `today's publishing checklist could not be read (${error.message})` };
  }
}

export async function verifyProduction({
  root = ROOT,
  site = process.env.DIVE_PROD_SITE || SITE,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  statePath = STATE_PATH,
  checklist = (path, at) => checklistVerdict(path, at),
} = {}) {
  const freshness = await checkProductionFreshness({
    url: `${site}/data.json?cb=${encodeURIComponent(String(now))}`,
    now,
    fetchImpl,
  });
  let parity;
  try {
    parity = await checkLiveParity({ root, site, cacheBust: String(now), fetchImpl });
  } catch (error) {
    parity = { ok: false, mismatches: [{ file: "production", reason: error.message }] };
  }
  const checklistResult = checklist(statePath, now);
  const youtubeWatchPending = checklistResult.youtubeWatchPending === true
    && freshness.ok
    && parity.ok;
  return {
    ok: freshness.ok && parity.ok && checklistResult.ok,
    freshness,
    parity,
    checklist: checklistResult,
    youtubeWatchPending,
  };
}

function proofMessage(proof) {
  const parts = [];
  if (!proof.freshness.ok) parts.push(proof.freshness.message);
  if (!proof.parity.ok) parts.push(`public files differ (${proof.parity.mismatches.map((item) => item.file).join(", ") || "unknown file"})`);
  if (proof.checklist && !proof.checklist.ok) parts.push(proof.checklist.message);
  return parts.join("; ") || "production did not pass its checks";
}

export async function recoverPublish({
  root = ROOT,
  publisherRoot = PUBLISHER_ROOT,
  statePath = STATE_PATH,
  now = Date.now(),
  guard = (path) => acquireLock(path, { label: "daily publishing chain", maxAgeMs: RUN_LOCK_MAX_AGE_MS }),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  queue = (lines) => appendQueueLines(lines),
  resolve = () => resolveOperationalAlerts(),
  prepare = (source, target) => ensureIsolatedCheckout(source, target),
  verify = (options) => verifyProduction(options),
  run = () => spawnSync(process.execPath, ["tools/dive-analytics/run-daily.mjs", "--recovery"], { cwd: root, env: process.env, stdio: "inherit" }),
} = {}) {
  let release;
  for (let check = 1; check <= LOCK_CHECKS; check++) {
    try {
      release = guard(`${statePath}.run.lock`);
      break;
    } catch (error) {
      if (!/already in use/.test(error.message)) throw error;
      if (check < LOCK_CHECKS) {
        console.log(`recovery: the daily publishing chain is still running; checking again in ${LOCK_WAIT_MS / 1000} seconds.`);
        await wait(LOCK_WAIT_MS);
        continue;
      }
      const line = "Daily production check could not run because the publishing chain was still active; production was not confirmed.";
      queue([line]);
      console.error(`recovery: ${line}`);
      return 1;
    }
  }
  let canonicalRoot;
  let before;
  let beforeResolved = false;
  try {
    canonicalRoot = prepare(root, publisherRoot);
    before = await verify({ root: canonicalRoot, now, statePath });
    if (before.ok) {
      resolve();
      beforeResolved = true;
    }
  } catch (error) {
    const line = `Daily production check could not prepare its isolated checkout — ${error.message}.`;
    queue([line]);
    console.error(`recovery: ${line}`);
    return 1;
  } finally {
    release();
  }
  const action = recoveryAction(before, now);
  if (action === "done") {
    if (!beforeResolved) throw new Error("production proof completed without reconciling its alert state");
    console.log(`recovery: production serves today's build and all ${before.parity.checked} public files match.`);
    return 0;
  }
  if (action === "defer") {
    console.log("recovery: production is current; newest episode YouTube watch data is not ready yet, so the one remaining whole-chain run stays reserved for noon.");
    return 0;
  }
  if (action === "fail") {
    const line = `Daily production check failed outside the morning recovery window — ${proofMessage(before)}.`;
    queue([line]);
    console.error(`recovery: ${line}`);
    return 1;
  }

  console.log(before.youtubeWatchPending
    ? "recovery: newest episode YouTube watch data is still pending; starting the one reserved noon run."
    : `recovery: morning production check failed — ${proofMessage(before)}; starting the one recovery run.`);
  const child = run();
  const status = Number.isInteger(child.status) ? child.status : 1;
  if (status !== 0) {
    const line = `Daily publish recovery failed (exit ${status}); production still needs attention.`;
    queue([line]);
    console.error(`recovery: ${line}`);
    return status;
  }
  let afterRelease;
  try {
    afterRelease = guard(`${statePath}.run.lock`);
  } catch (error) {
    const line = `Daily publish recovery finished, but its final production proof could not take the publishing lock — ${error.message}.`;
    queue([line]);
    console.error(`recovery: ${line}`);
    return 1;
  }
  try {
    const after = await verify({ root: canonicalRoot, now: Date.now(), statePath });
    if (!after.ok) {
      if (after.youtubeWatchPending === true && after.freshness?.ok === true && after.parity?.ok === true) {
        console.log("recovery: noon published every available update; YouTube is still preparing the newest episode's watch data, so no third run will start today.");
        return 0;
      }
      const line = `Daily publish recovery finished, but production still failed its checks — ${proofMessage(after)}.`;
      queue([line]);
      console.error(`recovery: ${line}`);
      return 1;
    }
    resolve();
    console.log(`recovery: production now serves today's build and all ${after.parity.checked} public files match.`);
    return 0;
  } finally {
    afterRelease();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) recoverPublish().then((status) => process.exit(status)).catch((error) => {
  console.error(`recovery: ${error.message}`);
  process.exit(1);
});
