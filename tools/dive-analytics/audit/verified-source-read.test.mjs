import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readVerifiedSource } from "../verified-source-read.mjs";

const dir = mkdtempSync(join(tmpdir(), "dive-verified-source-"));
try {
  const source = join(dir, "e8-transcript-2026-09-03.txt");
  const cacheDir = join(dir, "cache");
  const body = "00:01:00 [Speaker 1]\nExact original transcript.\n";
  writeFileSync(source, body);
  const blocked = () => { throw Object.assign(new Error("file provider busy"), { code: "EDEADLK" }); };
  const options = { cacheDir, wait() {} };
  assert.throws(() => readVerifiedSource(source, { ...options, read: blocked }), /file provider busy/, "no cache may be invented from the published transcript");
  assert.equal(readVerifiedSource(source, options), body);
  assert.equal(readVerifiedSource(source, { ...options, read: blocked }), body, "exact previously read bytes survive temporary source unavailability");
  const cache = join(cacheDir, readdirSync(cacheDir)[0]);
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
  const saved = readFileSync(cache);
  const corrupt = JSON.parse(saved); corrupt.text = "fabricated";
  writeFileSync(cache, JSON.stringify(corrupt));
  assert.throws(() => readVerifiedSource(source, { ...options, read: blocked }), /file provider busy/, "a corrupt cache cannot pass parity");
  writeFileSync(cache, saved);
  assert.throws(() => readVerifiedSource(source, { ...options, read() { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } }), /permission denied/);
  let calls = 0;
  assert.equal(readVerifiedSource(source, { ...options, cacheDir: null, read(path, encoding) { if (++calls < 3) return blocked(); return readFileSync(path, encoding); } }), body);
  assert.equal(calls, 3, "transient reads receive bounded retries even without a cache");
  let metadataCalls = 0;
  assert.equal(readVerifiedSource(source, { ...options, cacheDir: null,
    stat(path) { const value = statSync(path); return { ...value, ctimeMs: ++metadataCalls === 1 ? value.ctimeMs - 1 : value.ctimeMs }; },
  }), body, "a file-provider metadata transition is retried and must settle before accepting bytes");
  let changing = 0;
  assert.throws(() => readVerifiedSource(source, { ...options, cacheDir: null,
    stat(path) { return { ...statSync(path), ctimeMs: ++changing }; },
  }), /source changed/, "a source that keeps changing is never accepted");
  writeFileSync(source, body + "Source edited.\n");
  assert.throws(() => readVerifiedSource(source, { ...options, read: blocked }), /file provider busy/, "changed source metadata invalidates cached bytes");
  assert.equal(readVerifiedSource(source, options), body + "Source edited.\n", "a readable changed source always wins and remains subject to transcript parity");
  rmSync(source);
  assert.throws(() => readVerifiedSource(source, { ...options, read: blocked }), /ENOENT/, "a removed source cannot pass from cache");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("verified-source-read: exact source bytes, retries, stale and corrupt cache, missing source and permission refusal passed");
