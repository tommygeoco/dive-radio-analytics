#!/usr/bin/env node
// recover-publish.mjs — verify production after the morning chain and use the
// one reserved recovery attempt only during the morning window. The noon run
// verifies again but never starts a third whole-chain run.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendQueueLines } from "./alert-queue.mjs";
import { checkProductionFreshness, phoenixHour } from "./freshness.mjs";
import { checkLiveParity, SITE } from "./live-parity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
const MORNING_START = 7;
const MORNING_END = 10;

export function recoveryAction(proof, now = Date.now()) {
  if (proof.ok) return "done";
  const hour = phoenixHour(now);
  if (hour != null && hour >= MORNING_START && hour < MORNING_END) return "recover";
  return "fail";
}

export async function verifyProduction({
  root = ROOT,
  site = process.env.DIVE_PROD_SITE || SITE,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
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
  return {
    ok: freshness.ok && parity.ok,
    freshness,
    parity,
  };
}

function proofMessage(proof) {
  const parts = [];
  if (!proof.freshness.ok) parts.push(proof.freshness.message);
  if (!proof.parity.ok) parts.push(`public files differ (${proof.parity.mismatches.map((item) => item.file).join(", ") || "unknown file"})`);
  return parts.join("; ") || "production did not pass its checks";
}

export async function recoverPublish({
  root = ROOT,
  now = Date.now(),
  verify = (options) => verifyProduction(options),
  run = () => spawnSync(process.execPath, ["tools/dive-analytics/run-daily.mjs", "--recovery"], { cwd: root, env: process.env, stdio: "inherit" }),
} = {}) {
  const before = await verify({ root, now });
  const action = recoveryAction(before, now);
  if (action === "done") {
    console.log(`recovery: production serves today's build and all ${before.parity.checked} public files match.`);
    return 0;
  }
  if (action === "fail") {
    const line = `Daily production check failed outside the morning recovery window — ${proofMessage(before)}.`;
    appendQueueLines([line]);
    console.error(`recovery: ${line}`);
    return 1;
  }

  console.log(`recovery: morning production check failed — ${proofMessage(before)}; starting the one recovery run.`);
  const child = run();
  const status = Number.isInteger(child.status) ? child.status : 1;
  if (status !== 0) {
    const line = `Daily publish recovery failed (exit ${status}); production still needs attention.`;
    appendQueueLines([line]);
    console.error(`recovery: ${line}`);
    return status;
  }
  const after = await verify({ root, now: Date.now() });
  if (!after.ok) {
    const line = `Daily publish recovery finished, but production still failed its checks — ${proofMessage(after)}.`;
    appendQueueLines([line]);
    console.error(`recovery: ${line}`);
    return 1;
  }
  console.log(`recovery: production now serves today's build and all ${after.parity.checked} public files match.`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) recoverPublish().then((status) => process.exit(status)).catch((error) => {
  console.error(`recovery: ${error.message}`);
  process.exit(1);
});
