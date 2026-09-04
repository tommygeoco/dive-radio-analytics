#!/usr/bin/env node
// freshness.mjs — production must carry a readable build from today in
// Phoenix. The age check remains as a second guard, but yesterday is stale
// even when it is less than 26 hours old.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUE_PATH, replaceQueueLines } from "./alert-queue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const PROD_URL = "https://dive-radio-analytics.vercel.app/data.json";
export const MAX_AGE_HOURS = 26;
export const LINE_PREFIX = "Prod dashboard";

function phoenixParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function phoenixDay(value) {
  return phoenixParts(value)?.day ?? null;
}

export function phoenixHour(value) {
  return phoenixParts(value)?.hour ?? null;
}

export function freshnessVerdict(generatedAt, now = Date.now(), { requireToday = true } = {}) {
  const generated = Date.parse(generatedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(generated)) return { ok: false, kind: "unreadable", message: "production data has no readable build time" };
  if (!Number.isFinite(nowMs)) throw new Error("freshness clock is invalid");
  if (generated > nowMs) return { ok: false, kind: "future", generatedAt, message: `production build time ${generatedAt} is in the future` };
  const ageHours = (nowMs - generated) / 3600000;
  if (requireToday && phoenixDay(generated) !== phoenixDay(nowMs)) {
    return { ok: false, kind: "prior-day", generatedAt, ageHours, message: `production still serves the ${phoenixDay(generated)} build; Phoenix is on ${phoenixDay(nowMs)}` };
  }
  if (ageHours > MAX_AGE_HOURS) {
    return { ok: false, kind: "old", generatedAt, ageHours, message: `production build ${generatedAt} is ${Math.round(ageHours)} hours old` };
  }
  return { ok: true, kind: "fresh", generatedAt, ageHours };
}

export function staleLine(generatedAt, now = Date.now()) {
  const verdict = freshnessVerdict(generatedAt, now);
  if (verdict.ok) return null;
  if (verdict.kind === "prior-day") return `${LINE_PREFIX} is still serving the ${phoenixDay(generatedAt)} build (${generatedAt}); today's publish is missing.`;
  return `${LINE_PREFIX} cannot confirm today's publish — ${verdict.message}.`;
}

function verdictLine(verdict) {
  if (verdict.kind === "prior-day") return `${LINE_PREFIX} is still serving the ${phoenixDay(verdict.generatedAt)} build (${verdict.generatedAt}); today's publish is missing.`;
  return `${LINE_PREFIX} cannot confirm today's publish — ${verdict.message}.`;
}

export async function checkProductionFreshness({
  url = process.env.DIVE_PROD_URL || PROD_URL,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const target = new URL(url);
    target.searchParams.set("cb", `${now}-${crypto.randomUUID()}`);
    const response = await fetchImpl(target.href, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { ...freshnessVerdict(body?.generatedAt, now), body };
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `production data could not be read (${error.message})` };
  }
}

export function queueFreshnessProblem(verdict, path = QUEUE_PATH) {
  const line = verdictLine(verdict);
  replaceQueueLines((item) => item.startsWith(LINE_PREFIX), [line], path);
  return line;
}

async function main() {
  const strict = process.argv.includes("--strict");
  const verdict = await checkProductionFreshness();
  if (verdict.ok) {
    if (!strict) console.log(`freshness: production serves today's build from ${verdict.generatedAt}.`);
    return;
  }
  const line = queueFreshnessProblem(verdict);
  console.error(line);
  console.error("freshness: the alert remains queued until Slack confirms delivery.");
  if (strict) process.exit(verdict.kind === "prior-day" || verdict.kind === "old" ? 1 : 2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  console.error(`freshness: check failed — ${error.message}`);
  process.exit(2);
});
