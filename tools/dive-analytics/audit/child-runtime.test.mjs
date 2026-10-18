// child-runtime.test.mjs — every child of a scheduled Dive run uses the Node
// that runs it (2026-10-18, AUDIT-2026-10-18-homebrew-node.md). A Homebrew
// upgrade broke /opt/homebrew/bin/node, and run-chain started each step as bare
// `node` with /opt/homebrew/bin first on PATH, so pinning the scheduled command
// alone would not have saved a single step. Steps now start through
// process.execPath; postlive-publish.sh execs $DIVE_NODE; a Node CLI started by
// name (openclaw, vercel) finds the same Node first on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, childPath } from "../runtime-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const source = (name) => readFileSync(join(HERE, "..", name), "utf8");
let assertions = 0;

// 1. The running Node's bin directory comes first; Homebrew stays for git, yt-dlp, xurl.
assert.equal(childPath("/usr/bin:/bin"), `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`); assertions++;
const env = childEnv({ PATH: "/usr/bin:/bin", KEEP: "1" });
assert.deepEqual(env, { PATH: childPath("/usr/bin:/bin"), KEEP: "1", DIVE_NODE: process.execPath }); assertions++;

// 2. A child that starts `node` by name, as a `#!/usr/bin/env node` CLI does, gets this exact Node.
const shell = spawnSync("sh", ["-c", "exec node -p process.execPath"], { env: childEnv(), encoding: "utf8" });
assert.equal(shell.status, 0, shell.stderr); assertions++;
assert.equal(shell.stdout.trim(), process.execPath); assertions++;

// 3. The real publish wrapper hands off to $DIVE_NODE with its arguments.
const wrapper = spawnSync("sh", [join(ROOT, "scripts", "restream", "postlive-publish.sh"), "--dry"], { env: { ...childEnv(), DIVE_NODE: "/bin/echo" }, encoding: "utf8" });
assert.equal(wrapper.status, 0, wrapper.stderr); assertions++;
assert.equal(wrapper.stdout.trim(), "tools/dive-analytics/publish-flow.mjs --dry"); assertions++;

// 4. Wiring: the runner starts steps through process.execPath, every entry point
//    that starts children uses childEnv(), and the openclaw CLI calls carry it.
assert.match(source("run-chain.mjs"), /: \[process\.execPath, \.\.\.parts\];/); assertions++;
assert.doesNotMatch(source("run-chain.mjs"), /\["node", \.\.\.parts\]/); assertions++;
for (const name of ["run-chain.mjs", "run-daily.mjs", "publish-flow.mjs"]) {
  assert.match(source(name), /const ENV = childEnv\(\);/, name); assertions++;
}
for (const name of ["alerts.mjs", "scheduler-watch.mjs"]) {
  const spawns = source(name).match(/spawnSync\("openclaw", [\s\S]*?timeout: [\d_]+ \}\)/g) ?? [];
  assert.ok(spawns.length >= 2, name); assertions++;
  for (const call of spawns) { assert.match(call, /\{ env: childEnv\(\),/, `${name}: ${call.slice(0, 80)}`); assertions++; }
}

console.log(`child-runtime.test: ${assertions} assertions passed`);
