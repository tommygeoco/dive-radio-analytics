#!/usr/bin/env node
// freshness.mjs — v8 W21 prod freshness watchdog.
//
// The publish gate can only block; nothing watched the OUTPUT for staleness,
// so a blocked morning publish served yesterday's numbers silently
// (2026-08-23). This fetches the LIVE data.json from prod and raises one
// plain sentence when its generatedAt is older than 26 hours. It runs at the
// END of the daily chain and again under a small midday cron — the midday
// run catches the chain-died-before-alerts case.
//
// The alert line is queued into alerts-pending.json, the same queue the
// trigger-gated dive-alerts cron already delivers to Slack, and printed to
// stdout for the midday cron's own payload. Always exits 0 — a watchdog
// that blocks the chain would recreate the problem it watches for.
//
//   node tools/dive-analytics/freshness.mjs           # check prod, queue if stale (always exit 0)
//   node tools/dive-analytics/freshness.mjs --strict  # midday watchdog mode: silent when
//                                                     # fresh, exit 1 stale / 2 unreachable —
//                                                     # a non-zero exit makes the cron job
//                                                     # itself page through its failure alert
//
// DIVE_PROD_URL overrides the prod URL (acceptance tests only).

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const QUEUE_PATH = join(ROOT, "data", "restream", "alerts-pending.json");
const PROD_URL = "https://dive-radio-analytics.vercel.app/data.json";
const MAX_AGE_HOURS = 26;
const LINE_PREFIX = "Prod dashboard is serving data from";

function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

export function staleLine(generatedAt, now = Date.now()) {
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return null;
  const hours = (now - t) / 3600000;
  if (hours <= MAX_AGE_HOURS) return null;
  return `${LINE_PREFIX} ${generatedAt}, ${Math.round(hours)} hours old — the morning publish likely failed.`;
}

const strict = process.argv.includes("--strict");

async function main() {
  let body;
  try {
    const res = await fetch(process.env.DIVE_PROD_URL || PROD_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    console.log(`freshness: prod fetch failed (${error.message}) — cannot judge staleness this run`);
    if (strict) process.exit(2);
    return;
  }
  if (!Number.isFinite(Date.parse(body?.generatedAt))) {
    console.log("freshness: prod data.json has no readable generatedAt — cannot judge staleness this run");
    if (strict) process.exit(2);
    return;
  }
  const line = staleLine(body.generatedAt);
  if (!line) {
    // strict mode stays silent when all is well — its cron job only speaks
    // (through its own failure alert) when something is wrong
    if (!strict) console.log(`freshness: prod is serving data from ${body.generatedAt} — fresh.`);
    return;
  }
  console.log(line);
  // one staleness line in the queue at a time: replace any earlier one so
  // the delivered alert always names the timestamp prod is serving NOW
  let queue = [];
  if (existsSync(QUEUE_PATH)) { try { queue = JSON.parse(readFileSync(QUEUE_PATH, "utf8")); } catch { queue = []; } }
  queue = queue.filter((l) => typeof l === "string" && !l.startsWith(LINE_PREFIX));
  queue.push(line);
  saveAtomic(QUEUE_PATH, queue);
  console.log("freshness: alert queued for the next dive-alerts delivery.");
  if (strict) process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  // even an unexpected crash must not fail the chain — report and exit 0
  console.log(`freshness: check crashed (${error.message}) — no verdict this run`);
});
