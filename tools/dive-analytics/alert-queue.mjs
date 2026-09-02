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

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const QUEUE_PATH = join(ROOT, "data", "restream", "alerts-pending.json");
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function lockLooksActive(path, now = Date.now(), maxAgeMs = LOCK_MAX_AGE_MS) {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const age = now - Date.parse(saved.startedAt);
    return processIsAlive(saved.pid) && Number.isFinite(age) && age < maxAgeMs;
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
  if (!existsSync(path)) {
    if (allowMissing) return [];
    throw new Error(`alert queue is missing at ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== "string" || !line.trim())) {
    throw new Error("alert queue must be an array of non-empty lines");
  }
  return [...new Set(parsed)];
}

function saveQueue(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(lines, null, 2) + "\n");
  renameSync(tmp, path);
}

export function updateQueue(path = QUEUE_PATH, update) {
  const release = acquireLock(`${path}.lock`);
  try {
    const before = readQueue(path);
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

export function replaceQueueLines(match, additions, path = QUEUE_PATH) {
  return updateQueue(path, (queue) => [...queue.filter((line) => !match(line)), ...additions]);
}

export function acknowledgeQueueLines(delivered, path = QUEUE_PATH) {
  const sent = new Set(delivered);
  return updateQueue(path, (queue) => queue.filter((line) => !sent.has(line)));
}
