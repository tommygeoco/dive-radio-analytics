// publish-scope.test.mjs — exact allowlist matching and scoped staging.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { allowlistSpecs, assertPublishScope, classifyPaths, pathMatchesSpec, stagePublishScope } from "../publish-scope.mjs";

const specs = allowlistSpecs();
assert.ok(specs.includes("data.json") && specs.includes("data/restream/alerts-state.json") && specs.includes("tools/dive-analytics/audit/CRITIC-*.md"));
assert.equal(pathMatchesSpec("transcripts/episode one.txt", "transcripts/*.txt"), true);
assert.equal(pathMatchesSpec("transcripts/nested/episode.txt", "transcripts/*.txt"), false);
assert.equal(pathMatchesSpec("tools/dive-analytics/audit/CRITIC-2026-09-01.md", "tools/dive-analytics/audit/CRITIC-*.md"), true);
assert.deepEqual(classifyPaths(["index.html", "agents.html"], specs).map((entry) => entry.matches), [[], []]);

const repo = mkdtempSync(join(tmpdir(), "dive-publish-scope."));
try {
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run("init", "-q");
  run("config", "user.email", "fixture@example.test");
  run("config", "user.name", "Fixture");
  mkdirSync(join(repo, "data", "restream"), { recursive: true });
  writeFileSync(join(repo, "data.json"), "old\n");
  writeFileSync(join(repo, "index.html"), "old\n");
  run("add", "--", "data.json", "index.html");
  run("commit", "-qm", "fixture");
  writeFileSync(join(repo, "data.json"), "new\n");
  assert.deepEqual(assertPublishScope(repo, ["data.json"]), ["data.json"]);
  stagePublishScope(repo, ["data.json"]);
  assert.equal(run("diff", "--cached", "--name-only").trim(), "data.json");
  writeFileSync(join(repo, "index.html"), "new\n");
  assert.throws(() => assertPublishScope(repo, ["data.json"]), /index\.html \(not a declared chain output\)/);
} finally {
  rmSync(repo, { force: true, recursive: true });
}

console.log(`publish-scope.test: ${specs.length} exact chain specs, direct-child wildcards, refusal, and exact staging pass`);
