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
import { healLeftovers, mergeEpisodeRatingsStores, mergePostliveStores } from "../chain-heal.mjs";

const base = mkdtempSync(join(process.env.CLAUDE_SCRATCH || tmpdir(), "chain-heal-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (root, rel, value) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n"); };
const v3 = (date, score) => ({ date, score, formulaVersion: "health-v3", createdAt: `${date}T14:00:00Z` });
const v4 = (date, score) => ({ date, score, formulaVersion: "health-v4", createdAt: `${date}T21:00:00Z` });

const ratingBase = {
  version: 4,
  algorithm: "health21-v2",
  weights: { watch: 1 },
  readDays: 21,
  windowN: 8,
  minPeers: 3,
};
const frozenOne = { ep: 1, slug: "one", score: 44, computedAt: "2026-08-20T14:00:00Z", frozenAt: "2026-08-20T14:00:00Z" };
const frozenTwo = { ep: 2, slug: "two", score: 51, computedAt: "2026-09-02T14:00:00Z", frozenAt: "2026-09-02T14:00:00Z" };
const mergedRatings = mergeEpisodeRatingsStores(
  { ...ratingBase, updatedAt: "2026-09-02T14:00:00Z", scores: [frozenOne, frozenTwo] },
  { ...ratingBase, updatedAt: "2026-09-01T14:00:00Z", scores: [frozenOne, { ep: 2, slug: "two", score: 48, computedAt: "2026-09-01T14:00:00Z" }] },
);
assert.deepEqual(mergedRatings.scores, [frozenOne, frozenTwo], "a newer frozen main entry replaces an older unfrozen local reading");
assert.throws(() => mergeEpisodeRatingsStores(
  { ...ratingBase, updatedAt: "2026-09-02T14:00:00Z", scores: [frozenOne] },
  { ...ratingBase, updatedAt: "2026-09-02T14:00:00Z", scores: [{ ...frozenOne, score: 45 }] },
), /frozen episode rating differs/, "two different frozen records can never be auto-resolved");

const mergedPostlive = mergePostliveStores(
  { slug: "one", title: "One", date: "2026-09-03", snapshots: [
    { ts: "2026-09-04T15:45:00.000Z", metrics: { youtube: { views: 12 } } },
  ] },
  { slug: "one", title: "One", date: "2026-09-03", snapshots: [
    { ts: "2026-09-04T16:19:00.000Z", metrics: { youtube: { views: 14 } } },
  ] },
);
assert.deepEqual(
  mergedPostlive.snapshots.map((snapshot) => snapshot.ts),
  ["2026-09-04T15:45:00.000Z", "2026-09-04T16:19:00.000Z"],
  "a moving main cannot erase either append-only post-live reading",
);
assert.throws(() => mergePostliveStores(
  { slug: "one", title: "One", date: "2026-09-03", snapshots: [{ ts: "2026-09-04T16:19:00.000Z", metrics: { youtube: { views: 14 } } }] },
  { slug: "one", title: "One", date: "2026-09-03", snapshots: [{ ts: "2026-09-04T16:19:00.000Z", metrics: { youtube: { views: 15 } } }] },
), /differs at/, "two different readings at one timestamp must fail closed");

// origin + the chain machine's clone at the base commit
const origin = join(base, "origin.git"); git(base, "init", "--bare", "-q", "-b", "main", origin);
const mini = join(base, "mini"); git(base, "clone", "-q", origin, mini);
const S0 = { version: 3, updatedAt: "2026-09-01T14:00:00Z", entries: [v3("2026-08-31", 46), v3("2026-09-01", 46)] };
write(mini, "data/restream/health-history.json", S0); write(mini, "data.json", { generatedAt: "2026-09-01T14:00:00Z" });
write(mini, "data/restream/alerts-state.json", { seen: "base" });   // a tracked store both sides will change later
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

// PRD v11 W38: any OTHER store both sides changed keeps this machine's version
write(mac, "data/restream/alerts-state.json", { seen: "laptop-edit" }); git(mac, "add", "-A"); git(mac, "commit", "-q", "-m", "laptop touched a store"); git(mac, "push", "-q", "origin", "main");
write(mini, "data/restream/alerts-state.json", { seen: "chain-run" });
git(mini, "stash", "push", "--quiet", "--include-untracked", "-m", "publish-pre-pull");
git(mini, "pull", "--rebase", "--quiet", "origin", "main");
let popFailed2 = false;
try { git(mini, "stash", "pop", "--quiet"); } catch { popFailed2 = true; }
assert.equal(popFailed2, true, "the second rehearsal must reproduce a plain store conflict");
const healed2 = healLeftovers(mini, { log: () => {} }).healed;
assert.equal(healed2.length, 1);
assert.match(healed2[0], /kept this machine's version/);
assert.equal(JSON.parse(readFileSync(join(mini, "data/restream/alerts-state.json"), "utf8")).seen, "chain-run");
assert.equal(git(mini, "diff", "--name-only", "--diff-filter=U").trim(), "");
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

for (const [name, file, value] of [
  ["publish-pre-pull", "data/restream/orphan-publish.json", { source: "publish" }],
  ["chain-pre-pull", "data/restream/orphan-chain.json", { source: "chain" }],
  ["isolated-pre-pull", "data/restream/orphan-isolated.json", { source: "isolated" }],
]) {
  write(mini, file, value);
  git(mini, "stash", "push", "--quiet", "--include-untracked", "-m", name);
}
const orphanRecovery = healLeftovers(mini, { log: () => {} });
assert.equal(orphanRecovery.healed.length, 3, "every recognized interrupted pre-pull stash is recovered");
assert.equal(JSON.parse(readFileSync(join(mini, "data/restream/orphan-publish.json"), "utf8")).source, "publish");
assert.equal(JSON.parse(readFileSync(join(mini, "data/restream/orphan-chain.json"), "utf8")).source, "chain");
assert.equal(JSON.parse(readFileSync(join(mini, "data/restream/orphan-isolated.json"), "utf8")).source, "isolated");
assert.equal(git(mini, "stash", "list").trim(), "", "restored orphan stashes are removed only after their files return");
console.log("chain-heal.test: formula and post-live histories merge, frozen ratings stay immutable, interrupted pre-pull stores return, plain one-writer stores keep the chain copy, and no stash remains");
