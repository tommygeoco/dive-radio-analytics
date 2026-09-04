// Shared source boundary: bounded requests, checked provenance and atomic writes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock } from "./alert-queue.mjs";

export function readJsonFile(path, options = {}) {
  if (!existsSync(path) && Object.hasOwn(options, "fallback")) return structuredClone(options.fallback);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`source store is missing or unreadable: ${path}`); }
}

export function atomicWriteText(path, text, { beforeRename = () => {}, mode = 0o644 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    beforeRename(temp, path);
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function atomicWriteJson(path, value, options) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n", options);
}

export function acquireSourceLock(path) {
  return acquireLock(`${path}.lock.tmp`, { label: "source store" });
}

export function withSourceLock(path, action) {
  const release = acquireSourceLock(path);
  try {
    const result = action();
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) { release(); throw error; }
}

export function phoenixDateKey(value = Date.now()) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error("invalid source timestamp");
  return new Date(ms - 7 * 3600000).toISOString().slice(0, 10);
}

const STATES = new Set(["ready", "pending", "failed", "stale", "future", "missing"]);
export function validateReadingEnvelope(reading, expected = {}) {
  const errors = [];
  if (reading?.schemaVersion !== 1) errors.push("reading schema is missing or unsupported");
  for (const key of ["source", "objectId"]) {
    if (typeof reading?.[key] !== "string" || !reading[key].trim()) errors.push(`reading ${key} is missing`);
  }
  if (!(reading?.episode === null || (typeof reading?.episode === "string" && reading.episode.trim()))) errors.push("reading episode is missing");
  const instant = typeof reading?.pulledAt === "string" ? Date.parse(reading.pulledAt) : NaN;
  if (!Number.isFinite(instant)) errors.push("reading pull time is invalid");
  if (expected.now != null && instant > new Date(expected.now).getTime()) errors.push("reading pull time is in the future");
  if (!STATES.has(reading?.state)) errors.push("reading completeness state is invalid");
  for (const key of ["source", "episode", "objectId"]) {
    if (Object.hasOwn(expected, key) && reading?.[key] !== expected[key]) errors.push(`reading ${key} differs from the registered source`);
  }
  return errors;
}

export function readingEnvelope({ source, episode, objectId, pulledAt, state = "ready" }) {
  const reading = { schemaVersion: 1, source, episode, objectId, pulledAt, state };
  const errors = validateReadingEnvelope(reading);
  if (errors.length) throw new Error(errors.join("; "));
  return reading;
}

// URLs, bodies and credentials never enter errors. A body/schema error is a
// failed request, never a successful empty dataset. Source-specific schemas
// are checked by callers before any store is promoted.
export async function fetchJson(url, {
  label = "source request", fetchImpl = fetch, timeoutMs = 30_000,
  maxAttempts = 2, allow404 = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  headers, method, body,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new Error("source requests allow one or two attempts");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("source timeout must be positive");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try { response = await fetchImpl(url, { headers, method, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch {
      if (attempt === maxAttempts) throw new Error(`${label} failed or timed out after ${attempt} attempt(s)`);
      continue;
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) throw new Error(`${label} returned HTTP ${response.status} after ${attempt} attempt(s)`);
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 1000) : 250;
      await sleep(wait);
      continue;
    }
    let value;
    try { value = await response.json(); }
    catch { throw new Error(`${label} returned malformed or empty JSON`); }
    if (!value || typeof value !== "object") throw new Error(`${label} returned an empty or invalid JSON payload`);
    return value;
  }
  throw new Error(`${label} did not complete`);
}
