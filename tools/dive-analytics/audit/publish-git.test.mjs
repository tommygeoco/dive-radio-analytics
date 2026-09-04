// publish-git.test.mjs — real temporary Git remotes prove HEAD goes to main,
// a moving main is rebased and rechecked, and two rejected pushes stop.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pushMain, assertCleanRelease } from "../publish-flow.mjs";

const base = mkdtempSync(join(tmpdir(), "dive-publish-git."));
const origin = join(base, "origin.git");
const publisher = join(base, "publisher");
const other = join(base, "other");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function identity(cwd) {
  git(cwd, "config", "user.email", "fixture@example.test");
  git(cwd, "config", "user.name", "Fixture");
}

try {
  git(base, "init", "--bare", "-q", "-b", "main", origin);
  git(base, "clone", "-q", origin, publisher);
  identity(publisher);
  mkdirSync(join(publisher, "tools", "dive-analytics", "audit"), { recursive: true });
  writeFileSync(join(publisher, "data.json"), "base\n");
  writeFileSync(join(publisher, "README.md"), "base\n");
  writeFileSync(join(publisher, "tools", "dive-analytics", "ratings.mjs"), "process.exit(0);\n");
  const gate = join(publisher, "tools", "dive-analytics", "release-gate.mjs");
  writeFileSync(gate, "process.exit(0);\n");
  writeFileSync(join(publisher, "tools", "dive-analytics", "build-data.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('data.json', 'rebuilt\\n');\n");
  writeFileSync(join(publisher, "tools", "dive-analytics", "audit", "validate.mjs"), "process.exit(0);\n");
  git(publisher, "add", "-A");
  git(publisher, "commit", "-qm", "base");
  git(publisher, "push", "-q", "origin", "main");

  writeFileSync(join(publisher, "data.json"), "first\n");
  git(publisher, "add", "--", "data.json");
  git(publisher, "commit", "-qm", "data one");
  const firstHead = git(publisher, "rev-parse", "HEAD");
  assert.equal(pushMain(publisher, () => {}), firstHead);
  assert.equal(git(origin, "rev-parse", "main"), firstHead);
  assertCleanRelease(publisher, firstHead);

  git(base, "clone", "-q", origin, other);
  identity(other);
  writeFileSync(join(other, "README.md"), "main moved\n");
  git(other, "add", "--", "README.md");
  git(other, "commit", "-qm", "code moved");
  git(other, "push", "-q", "origin", "main");
  assert.equal(git(publisher, "rev-parse", "origin/main"), firstHead, "cached main still looks current after another publisher advances it");
  assert.throws(() => assertCleanRelease(publisher, firstHead), /release is not exact origin\/main/, "release proof must refresh the remote after long gates and deploys");

  writeFileSync(join(publisher, "data.json"), "local second\n");
  git(publisher, "add", "--", "data.json");
  git(publisher, "commit", "-qm", "data two");
  const movedHead = pushMain(publisher, () => {});
  assert.equal(git(origin, "rev-parse", "main"), movedHead);
  assert.equal(readFileSync(join(publisher, "data.json"), "utf8"), "rebuilt\n", "final build ran after main moved");
  assert.equal(readFileSync(join(publisher, "README.md"), "utf8"), "main moved\n");

  writeFileSync(gate, "process.exit(23);\n");
  git(publisher, "add", "--", gate); git(publisher, "commit", "-qm", "gate rejection fixture");
  assert.throws(() => pushMain(publisher, () => {}), /failed/);
  assert.equal(git(origin, "rev-parse", "main"), movedHead, "failed gate must stop before push even without an installed hook");
  writeFileSync(gate, "process.exit(0);\n");
  git(publisher, "add", "--", gate); git(publisher, "commit", "-qm", "restore gate fixture");

  const attempts = join(base, "push-attempts.txt");
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\necho x >> '${attempts}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(publisher, "data.json"), "will reject\n");
  git(publisher, "add", "--", "data.json");
  git(publisher, "commit", "-qm", "data rejected");
  assert.throws(() => pushMain(publisher, () => {}), /push failed twice/);
  assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 2);
} finally {
  rmSync(base, { force: true, recursive: true });
}

console.log("publish-git.test: exact HEAD push, moving-main rebuild and validation, remote SHA proof, and two-rejection stop pass");
