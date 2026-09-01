// chain-heal.mjs — repair what an earlier run's failed publish left behind
// (PRD v10 addendum, 2026-09-01).
//
// The publish script stashes the day's data around `git pull --rebase`; when
// the pulled commit changed the same store file (a formula bump re-derived a
// day, say) the stash pop conflicts, the old script exits, and the tree is
// left with unmerged paths and the stash still on the list. The next
// morning's chain must not stall on that. healLeftovers():
//   • data.json / data.js — take HEAD's copy (build-data rewrites them minutes later)
//   • data/restream/health-history.json — union of both sides by day
//     (mergeHealthStores): every day from either side is kept; when both
//     sides carry the same day, the newer formula's read wins and the older
//     one is kept byte-identical under `superseded`
//   • anything else — stop and say so (a human resolves it)
// then drops the leftover stash. Idempotent: a clean tree is a no-op.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HEALTH_STORE = "data/restream/health-history.json";
const GENERATED = /^(data\.json|data\.js)$/;

export function formulaNumber(v) { return Number(String(v || "").replace(/\D/g, "")) || 0; }

export function mergeHealthStores(ours, theirs) {
  const byDate = new Map();
  const superseded = [];
  const seenSuperseded = new Set();
  const addSuperseded = (row) => { const key = JSON.stringify(row.entry); if (!seenSuperseded.has(key)) { seenSuperseded.add(key); superseded.push(row); } };
  for (const row of [...(ours.superseded || []), ...(theirs.superseded || [])]) addSuperseded(row);
  for (const side of [ours, theirs]) {
    for (const entry of side.entries || []) {
      const have = byDate.get(entry.date);
      if (!have) { byDate.set(entry.date, entry); continue; }
      if (JSON.stringify(have) === JSON.stringify(entry)) continue;
      const newer = formulaNumber(entry.formulaVersion) > formulaNumber(have.formulaVersion) ? entry : have;
      const older = newer === entry ? have : entry;
      if (formulaNumber(newer.formulaVersion) === formulaNumber(older.formulaVersion)) continue; // same formula twice: keep ours
      byDate.set(entry.date, { ...newer, rederivedFrom: newer.rederivedFrom ?? { formulaVersion: older.formulaVersion, score: older.score } });
      addSuperseded({ supersededOn: entry.date, by: newer.formulaVersion, entry: older });
    }
  }
  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const updatedAt = [ours.updatedAt, theirs.updatedAt].filter(Boolean).sort().at(-1) ?? null;
  return { version: Math.max(ours.version || 0, theirs.version || 0), updatedAt, entries, superseded };
}

export function healLeftovers(root, { log = console.log } = {}) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
  if (!unmerged.length) return { healed: [] };
  const healed = [];
  for (const file of unmerged) {
    if (GENERATED.test(file)) {
      git(["checkout", "HEAD", "--", file]);
      git(["add", file]);
      healed.push(`${file} (kept HEAD's copy; the build regenerates it)`);
      continue;
    }
    if (file === HEALTH_STORE) {
      const ours = JSON.parse(git(["show", `:2:${file}`]).stdout);   // HEAD after the pull
      const theirs = JSON.parse(git(["show", `:3:${file}`]).stdout); // the stashed local run
      const merged = mergeHealthStores(ours, theirs);
      writeFileSync(join(root, file), JSON.stringify(merged, null, 2) + "\n");
      git(["add", file]);
      healed.push(`${file} (union by day: ${merged.entries.length} reads, ${merged.superseded.length} superseded)`);
      continue;
    }
    throw new Error(`${file} is left conflicted from an earlier run and has no automatic merge — resolve it by hand, then rerun the chain`);
  }
  const stashes = git(["stash", "list"]).stdout;
  if (/publish-pre-pull|chain-pre-pull/.test(stashes.split("\n")[0] || "")) git(["stash", "drop"]);
  for (const line of healed) log(`chain: healed ${line}`);
  return { healed };
}
