// alert-queue.mjs — one locked, atomic queue for every chain producer and the
// acknowledged Slack delivery worker. Corrupt data fails loudly; it is never
// replaced with an empty queue.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALERT_QUEUE_PATH } from "./runtime-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const LEGACY_QUEUE_PATH = join(ROOT, "data", "restream", "alerts-pending.json");
export const QUEUE_PATH = ALERT_QUEUE_PATH;
export const MIGRATION_PATH = `${QUEUE_PATH}.initialized-v1`;
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const PRODUCTION_PREFIXES = [
  "Daily production check",
  "Prod dashboard",
];
const CHECKLIST_PREFIXES = [
  "Daily publish",
  "Daily publishing",
  "chain:",
];
const YOUTUBE_WATCH_PREFIXES = [
  "Newest episode YouTube watch data",
];

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function lockLooksActive(path, now = Date.now(), maxAgeMs = LOCK_MAX_AGE_MS) {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (processIsAlive(saved.pid)) return true;
    return false;
  } catch {
    try { return now - statSync(path).mtimeMs < maxAgeMs; }
    catch { return false; }
  }
}

export function acquireLock(path, { now = Date.now(), label = "alert queue", maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }) + "\n");
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockLooksActive(path, now, maxAgeMs)) throw new Error(`${label} is already in use`);
      try { unlinkSync(path); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    }
  }
  throw new Error(`${label} lock could not be acquired`);
}

export function readQueue(path = QUEUE_PATH, { allowMissing = false } = {}) {
  if (path === QUEUE_PATH) ensureDefaultQueue(path);
  else if (!existsSync(path)) {
    if (allowMissing) return [];
    throw new Error(`alert queue is missing at ${path}`);
  }
  return loadQueue(path);
}

function parseQueue(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== "string" || !line.trim())) {
    throw new Error("alert queue must be an array of non-empty lines");
  }
  return [...new Set(parsed)];
}

function saveQueue(path, lines) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(lines, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function saveMarker(path) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, initializedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function loadQueue(path) {
  return parseQueue(readFileSync(path, "utf8"));
}

function initialDefaultQueue() {
  return existsSync(LEGACY_QUEUE_PATH)
    ? parseQueue(readFileSync(LEGACY_QUEUE_PATH, "utf8"))
    : [];
}

function ensureDefaultQueue(path) {
  const release = acquireLock(`${path}.lock`);
  try {
    initializeDefaultQueueLocked(path);
  } finally {
    release();
  }
}

function initializeDefaultQueueLocked(path) {
  if (existsSync(MIGRATION_PATH)) {
    if (!existsSync(path)) throw new Error(`alert queue is missing after initialization at ${path}`);
    return;
  }
  const existing = existsSync(path) ? loadQueue(path) : [];
  const initial = [...new Set([...existing, ...initialDefaultQueue()])];
  saveQueue(path, initial);
  saveMarker(MIGRATION_PATH);
}

export function updateQueue(path = QUEUE_PATH, update) {
  const release = acquireLock(`${path}.lock`);
  try {
    if (path === QUEUE_PATH) initializeDefaultQueueLocked(path);
    else if (!existsSync(path)) throw new Error(`alert queue is missing at ${path}`);
    const before = loadQueue(path);
    const after = update([...before]);
    if (!Array.isArray(after) || after.some((line) => typeof line !== "string" || !line.trim())) {
      throw new Error("alert queue update returned invalid lines");
    }
    const unique = [...new Set(after)];
    saveQueue(path, unique);
    return unique;
  } finally {
    release();
  }
}

export function appendQueueLines(lines, path = QUEUE_PATH) {
  const additions = lines.filter((line) => typeof line === "string" && line.trim());
  return updateQueue(path, (queue) => [...queue, ...additions]);
}

// Upgrade an older publisher checkout whose tracked queue was changed after
// its last commit. The caller restores that tracked file only after this
// locked append succeeds, so no unsent line is discarded during migration.
export function importLegacyQueueFile(path, destination = QUEUE_PATH) {
  if (!existsSync(path)) return [];
  const lines = parseQueue(readFileSync(path, "utf8"));
  if (lines.length) appendQueueLines(lines, destination);
  return lines;
}

export function replaceQueueLines(match, additions, path = QUEUE_PATH) {
  return updateQueue(path, (queue) => [...queue.filter((line) => !match(line)), ...additions]);
}

export function acknowledgeQueueLines(delivered, path = QUEUE_PATH) {
  const sent = new Set(delivered);
  return updateQueue(path, (queue) => queue.filter((line) => !sent.has(line)));
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function resolveOperationalAlerts(path = QUEUE_PATH, {
  checks = 13,
  waitMs = 5_000,
  wait = waitSync,
  includeChecklist = false,
  includeYoutubeWatch = false,
} = {}) {
  let releaseDelivery = null;
  for (let check = 1; check <= checks; check++) {
    try {
      releaseDelivery = acquireLock(`${path}.delivery.lock`, { label: "alert delivery", maxAgeMs: 5 * 60 * 1000 });
      break;
    } catch (error) {
      if (!/already in use/.test(error.message) || check === checks) throw error;
      wait(waitMs);
    }
  }
  try {
    const prefixes = [
      ...PRODUCTION_PREFIXES,
      ...(includeChecklist ? CHECKLIST_PREFIXES : []),
      ...(includeYoutubeWatch ? YOUTUBE_WATCH_PREFIXES : []),
    ];
    return replaceQueueLines(
      (line) => prefixes.some((prefix) => line.startsWith(prefix)),
      [],
      path,
    );
  } finally {
    releaseDelivery?.();
  }
}
