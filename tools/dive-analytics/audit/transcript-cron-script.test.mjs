// transcript-cron-script.test.mjs — the OpenClaw wrapper must preserve the
// inner command's real result: quiet success is quiet, changed success notifies,
// and nonzero or missing status throws so the job's failure alert can fire.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "transcript-cron-script.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run(result) {
  const calls = [];
  const execute = new AsyncFunction("exec", source);
  const value = await execute(async (request) => {
    calls.push(request);
    return result;
  });
  return { value, calls };
}

const quiet = await run({ exitCode: 0, aggregated: "" });
assert.deepEqual(quiet.value, {});
assert.equal(quiet.calls.length, 1);
assert.match(quiet.calls[0].command, /mirror-transcripts\.mjs --quiet-current/);
assert.match(quiet.calls[0].command, /Library\/Application Support\/Dive Radio Analytics\/publisher-main/);

const changed = await run({ exitCode: 0, aggregated: "copied e8 transcript" });
assert.deepEqual(changed.value, { notify: "copied e8 transcript" });
await assert.rejects(() => run({ exitCode: 1, aggregated: "search refresh failed" }), /search refresh failed/);
await assert.rejects(() => run({ aggregated: "" }), /exit unknown/);
await assert.rejects(() => run({ exitCode: 0, timedOut: true }), /failed/);
await assert.rejects(() => run({ exitCode: 0, signal: "SIGTERM" }), /failed/);

console.log("transcript-cron-script.test: quiet success, changed success, nonzero failure, and missing-status failure pass");
