#!/usr/bin/env node
// freshness.mjs — W21 prod freshness watchdog (PRD v8, 2026-08-23).
//
// The validate gate can only block a bad publish; nothing watched the OUTPUT
// for staleness, so a blocked morning chain left prod serving yesterday's
// numbers with no alarm. This script asks prod directly: fetch the live
// data.json and compare its generatedAt to now. Deterministic, no model.
//
// Run:
//   node tools/dive-analytics/audit/freshness.mjs            # check prod
//   node tools/dive-analytics/audit/freshness.mjs --url URL  # check elsewhere (tests)
//
// It runs at the end of the daily chain (alerts.mjs calls the same check and
// queues the alert line) and again under its own midday cron, which catches
// the chain-died-before-alerts case. Fresh prints a status line on stderr and
// stays silent on stdout, so a cron that pipes stdout to Slack says nothing.
//
// Exit codes: 0 fresh, 1 stale, 2 fetch failure.

import { fileURLToPath } from "node:url";

export const PROD_DATA_URL = "https://dive-radio-analytics.vercel.app/data.json";
export const STALE_HOURS = 26;

export async function checkProdFreshness({ url = PROD_DATA_URL, now = Date.now() } = {}) {
  let payload;
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${now}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (error) {
    return { state: "unreachable", sentence: `could not read the prod dashboard data to check its age (${error.message}).` };
  }
  const generatedAt = payload?.generatedAt;
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) {
    return { state: "unreachable", sentence: "the prod dashboard data has no readable generatedAt stamp, so its age is unknown." };
  }
  const hours = Math.round((now - generatedMs) / 3600000);
  if (now - generatedMs > STALE_HOURS * 3600000) {
    return {
      state: "stale",
      generatedAt,
      hours,
      sentence: `prod dashboard is serving data from ${generatedAt}, ${hours} hours old — the morning publish likely failed.`,
    };
  }
  return { state: "fresh", generatedAt, hours };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const urlIndex = process.argv.indexOf("--url");
  const url = urlIndex > -1 ? process.argv[urlIndex + 1] : PROD_DATA_URL;
  const result = await checkProdFreshness({ url });
  if (result.state === "fresh") {
    process.stderr.write(`freshness: prod dashboard is serving data from ${result.generatedAt}, ${result.hours} hour(s) old.\n`);
    process.exit(0);
  }
  console.log(result.sentence);
  process.exit(result.state === "stale" ? 1 : 2);
}
