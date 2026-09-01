// chain-heal.test.mjs — rehearses the morning after a formula-bump day in
// throwaway git repos: the chain machine (old publish script) stashes its
// day's read, pulls the re-derived store, the pop conflicts and it exits;
// the next run's healLeftovers() must leave one clean, merged store and no
// stash. Run: node tools/dive-analytics/audit/chain-heal.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healLeftovers } from "../chain-heal.mjs";

const base = mkdtempSync(join(process.env.CLAUDE_SCRATCH || tmpdir(), "chain-heal-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (root, rel, value) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n"); };
const v3 = (date, score) => ({ date, score, formulaVersion: "health-v3", createdAt: `${date}T14:00:00Z` });
const v4 = (date, score) => ({ date, score, formulaVersion: "health-v4", createdAt: `${date}T21:00:00Z` });

// origin + the chain machine's clone at the base commit
const origin = join(base, "origin.git"); git(base, "init", "--bare", "-q", "-b", "main", origin);
const mini = join(base, "mini"); git(base, "clone", "-q", origin, mini);
const S0 = { version: 3, updatedAt: "2026-09-01T14:00:00Z", entries: [v3("2026-08-31", 46), v3("2026-09-01", 46)] };
write(mini, "data/restream/health-history.json", S0); write(mini, "data.json", { generatedAt: "2026-09-01T14:00:00Z" });
git(mini, "add", "-A"); git(mini, "commit", "-q", "-m", "base"); git(mini, "push", "-q", "origin", "main");

// the laptop re-derives today under the new formula and pushes
const mac = join(base, "mac"); git(base, "clone", "-q", origin, mac);
const S1 = { version: 3, updatedAt: "2026-09-01T21:00:00Z", entries: [v3("2026-08-31", 46), { ...v4("2026-09-01", 48), rederivedFrom: { formulaVersion: "health-v3", score: 46 } }], superseded: [{ supersededOn: "2026-09-01", by: "health-v4", entry: v3("2026-09-01", 46) }] };
write(mac, "data/restream/health-history.json", S1);
git(mac, "add", "-A"); git(mac, "commit", "-q", "-m", "health v4 re-derivation"); git(mac, "push", "-q", "origin", "main");

// next morning on the chain machine (old code): the day's read is appended locally, then the old publish flow runs
write(mini, "data/restream/health-history.json", { ...S0, updatedAt: "2026-09-02T14:00:00Z", entries: [...S0.entries, v3("2026-09-02", 47)] });
write(mini, "data.json", { generatedAt: "2026-09-02T14:00:00Z" });
git(mini, "stash", "push", "--quiet", "--include-untracked", "-m", "publish-pre-pull");
git(mini, "pull", "--rebase", "--quiet", "origin", "main");
let popFailed = false;
try { git(mini, "stash", "pop", "--quiet"); } catch { popFailed = true; }
assert.equal(popFailed, true, "the rehearsal must reproduce the stash-pop conflict");
assert.match(git(mini, "diff", "--name-only", "--diff-filter=U"), /health-history\.json/);

// the new chain heals before pulling
const { healed } = healLeftovers(mini, { log: () => {} });
assert.equal(healed.length, 1, "only the store needed healing (data.json did not conflict)");
assert.equal(git(mini, "diff", "--name-only", "--diff-filter=U").trim(), "", "no unmerged paths remain");
assert.equal(git(mini, "stash", "list").trim(), "", "the leftover stash is dropped");
const merged = JSON.parse(readFileSync(join(mini, "data/restream/health-history.json"), "utf8"));
assert.deepEqual(merged.entries.map((e) => `${e.date}:${e.formulaVersion}:${e.score}`), ["2026-08-31:health-v3:46", "2026-09-01:health-v4:48", "2026-09-02:health-v3:47"]);
assert.equal(merged.superseded.length, 1);
assert.equal(JSON.parse(readFileSync(join(mini, "data.json"), "utf8")).generatedAt, "2026-09-02T14:00:00Z", "the day's non-conflicting data stayed");
// a clean tree is a no-op, and the ordinary stash → pull → pop now succeeds
assert.deepEqual(healLeftovers(mini, { log: () => {} }), { healed: [] });
git(mini, "stash", "push", "--quiet", "--include-untracked", "-m", "chain-pre-pull");
git(mini, "pull", "--rebase", "--quiet", "origin", "main");
git(mini, "stash", "pop", "--quiet");
assert.equal(git(mini, "diff", "--name-only", "--diff-filter=U").trim(), "");
console.log("chain-heal.test: the morning after a formula bump heals into one merged store with no stash left");
