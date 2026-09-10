// Keep exact bytes from a successful source read through transient file-provider
// failures. A changed, missing, inaccessible or unverified source still fails.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "./source-io.mjs";
import { RUNTIME_DIR } from "./runtime-paths.mjs";

export const SOURCE_CACHE_DIR = join(RUNTIME_DIR, "verified-transcript-sources");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = (s) => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const transientSourceRead = (error) => ["EAGAIN", "EBUSY", "EDEADLK", "ETIMEDOUT"].includes(error?.code)
  || (process.platform === "darwin" && error?.errno === -11 && error?.syscall === "read");

export function readVerifiedSource(path, {
  cacheDir = SOURCE_CACHE_DIR, read = readFileSync, stat = statSync,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const source = resolve(path);
  const before = identity(stat(source)); // ENOENT / permissions never use cache.
  const cachePath = cacheDir ? join(cacheDir, `${hash(source)}.json`) : null;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try { text = read(source, "utf8"); }
    catch (error) {
      if (!transientSourceRead(error)) throw error;
      lastError = error;
      if (attempt < 2) wait(250 * (attempt + 1));
      continue;
    }
    if (!same(before, identity(stat(source)))) throw new Error("transcript source changed during its read");
    if (cachePath) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      atomicWriteJson(cachePath, { version: 1, source, identity: before, sha256: hash(text), text }, { mode: 0o600 });
    }
    return text;
  }
  if (!cachePath || !same(before, identity(stat(source)))) throw lastError;
  let cached;
  try { cached = JSON.parse(readFileSync(cachePath, "utf8")); }
  catch { throw lastError; }
  if (cached.version !== 1 || cached.source !== source || !same(cached.identity, before)
    || typeof cached.text !== "string" || cached.sha256 !== hash(cached.text)
    || Buffer.byteLength(cached.text) !== before.size || !same(before, identity(stat(source)))) throw lastError;
  return cached.text;
}
