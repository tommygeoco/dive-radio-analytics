#!/usr/bin/env node
// alerts-emit.test.mjs — W37A: empty alert queues stay silent while real
// alerts still print and clear. All cases run against a temporary fixture.
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..");
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "dive-alerts-emit.")));
const fixtureTools = join(fixtureRoot, "tools", "dive-analytics");
const queuePath = join(fixtureRoot, "data", "restream", "alerts-pending.json");

function runEmit() {
  return spawnSync(process.execPath, [join(fixtureTools, "alerts.mjs"), "--emit"], {
    cwd: fixtureRoot,
  });
}

try {
  mkdirSync(fixtureTools, { recursive: true });
  mkdirSync(dirname(queuePath), { recursive: true });
  for (const file of ["alerts.mjs", "health.mjs", "baselines.mjs"]) {
    copyFileSync(join(SOURCE, file), join(fixtureTools, file));
  }

  const emptyBytes = Buffer.from("[]\n");
  writeFileSync(queuePath, emptyBytes);
  const empty = runEmit();
  assert.equal(empty.status, 0, empty.stderr.toString("utf8"));
  assert.equal(empty.stdout.length, 0, "empty queue must produce zero stdout bytes");
  assert.equal(empty.stderr.length, 0, "empty queue must produce zero stderr bytes");
  assert.deepEqual(readFileSync(queuePath), emptyBytes, "empty queue must remain byte-identical");

  writeFileSync(queuePath, JSON.stringify(["First alert.", "Second alert."], null, 2) + "\n");
  const nonempty = runEmit();
  assert.equal(nonempty.status, 0, nonempty.stderr.toString("utf8"));
  assert.equal(nonempty.stderr.length, 0, "real alerts must produce zero stderr bytes");
  assert.equal(
    nonempty.stdout.toString("utf8"),
    "Dive Radio — what changed:\n• First alert.\n• Second alert.\n",
    "real alert output changed",
  );
  assert.equal(readFileSync(queuePath, "utf8"), "[]\n", "real alert queue must clear");

  const malformedBytes = Buffer.from("{not json\n");
  writeFileSync(queuePath, malformedBytes);
  const malformed = runEmit();
  assert.notEqual(malformed.status, 0, "malformed queue must fail");
  assert.deepEqual(readFileSync(queuePath), malformedBytes, "malformed queue must remain byte-identical");

  const nonArrayBytes = Buffer.from('{"text":"must not be destroyed"}\n');
  writeFileSync(queuePath, nonArrayBytes);
  const nonArray = runEmit();
  assert.notEqual(nonArray.status, 0, "non-array queue must fail");
  assert.deepEqual(readFileSync(queuePath), nonArrayBytes, "non-array queue must remain byte-identical");

  const nonStringBytes = Buffer.from('[{"text":"must not be destroyed"}]\n');
  writeFileSync(queuePath, nonStringBytes);
  const nonString = runEmit();
  assert.notEqual(nonString.status, 0, "queue containing a non-string must fail");
  assert.deepEqual(readFileSync(queuePath), nonStringBytes, "queue containing a non-string must remain byte-identical");

  const blankStringBytes = Buffer.from('["   "]\n');
  writeFileSync(queuePath, blankStringBytes);
  const blankString = runEmit();
  assert.notEqual(blankString.status, 0, "queue containing a blank-only string must fail");
  assert.deepEqual(readFileSync(queuePath), blankStringBytes, "queue containing a blank-only string must remain byte-identical");

  const unreadableBytes = Buffer.from('["protected alert"]\n');
  writeFileSync(queuePath, unreadableBytes);
  chmodSync(queuePath, 0o000);
  let unreadable;
  try {
    unreadable = runEmit();
  } finally {
    chmodSync(queuePath, 0o600);
  }
  assert.notEqual(unreadable.status, 0, "unreadable queue must fail");
  assert.deepEqual(readFileSync(queuePath), unreadableBytes, "unreadable queue must remain byte-identical");

  rmSync(queuePath);
  const missing = runEmit();
  assert.notEqual(missing.status, 0, "missing queue must fail");
  assert.equal(existsSync(queuePath), false, "missing queue must remain absent");

  console.log("alerts-emit.test: empty suppressed; real alerts delivered; invalid and missing queues preserved");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
