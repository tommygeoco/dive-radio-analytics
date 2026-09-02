// publisher-checkout.test.mjs — automation refuses feature branches and
// source edits before the first capture call, while allowing declared stores.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPublisherCheckout } from "../publisher-checkout.mjs";

const base = mkdtempSync(join(tmpdir(), "dive-publisher-checkout."));
const repo = join(base, "work");
const origin = join(base, "origin.git");
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

try {
  git(base, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.email", "fixture@example.test");
  git(repo, "config", "user.name", "Fixture");
  writeFileSync(join(repo, "data.json"), "old\n");
  writeFileSync(join(repo, "index.html"), "old\n");
  writeFileSync(join(repo, "agents.html"), "old\n");
  git(repo, "add", "--", "data.json", "index.html", "agents.html");
  git(repo, "commit", "-qm", "fixture");
  git(base, "init", "--bare", "-q", "-b", "main", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-qu", "origin", "main");

  assert.deepEqual(assertPublisherCheckout(repo), { branch: "main", dirtyPaths: [], localCommitPaths: [] });
  writeFileSync(join(repo, "data.json"), "new\n");
  assert.deepEqual(assertPublisherCheckout(repo), { branch: "main", dirtyPaths: ["data.json"], localCommitPaths: [] });
  git(repo, "add", "--", "data.json");
  git(repo, "commit", "-qm", "local data");
  assert.deepEqual(assertPublisherCheckout(repo), { branch: "main", dirtyPaths: [], localCommitPaths: ["data.json"] });
  writeFileSync(join(repo, "index.html"), "new\n");
  assert.throws(() => assertPublisherCheckout(repo), /index\.html/);
  git(repo, "checkout", "--", "index.html");
  writeFileSync(join(repo, "agents.html"), "new\n");
  assert.throws(() => assertPublisherCheckout(repo), /agents\.html/);
  git(repo, "checkout", "--", "agents.html");
  git(repo, "switch", "-qc", "agent/in-progress");
  assert.throws(() => assertPublisherCheckout(repo), /must be on main/);
} finally {
  rmSync(base, { force: true, recursive: true });
}

console.log("publisher-checkout.test: clean main and declared dirty/committed data pass; source edits and feature branches fail before capture");
