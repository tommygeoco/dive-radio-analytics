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
//   • episode-ratings.json — union entries without ever changing an existing
//     frozen entry; incompatible frozen entries stop the run
//   • any other store under data/restream (one writer: this machine) — keep the local run's version
//   • anything else — stop and say so (a human resolves it)
// It also restores a recognized pre-pull stash left by interruption before a
// pull or pop began. A stash is dropped only after Git either applied it
// cleanly or every resulting conflict was resolved and staged. Idempotent: a
// clean tree with no recognized orphan stash is a no-op.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HEALTH_STORE = "data/restream/health-history.json";
const RATINGS_STORE = "data/restream/episode-ratings.json";
const POSTLIVE_STORE = /^data\/restream\/postlive\/[^/]+\.json$/;
const GENERATED = /^(data\.json|data\.js|agent\.md|agent\.json|llms\.txt)$/;   // PRD v12: the brief artifacts are generated too

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

const RATING_CONFIG_KEYS = ["version", "algorithm", "weights", "readDays", "windowN", "minPeers"];

function ratingKey(row) {
  if (typeof row?.slug === "string" && row.slug) return row.slug;
  if (Number.isInteger(row?.ep)) return `episode:${row.ep}`;
  throw new Error("episode ratings contain an entry without an episode key");
}

function newestRating(a, b) {
  const stamp = (row) => Date.parse(row?.computedAt || row?.updatedAt || "") || 0;
  return stamp(b) >= stamp(a) ? b : a;
}

// Frozen rows are historical records, not recomputable cache entries. A
// moved main may add a newly frozen episode while an older daily commit is
// waiting locally, so merge by episode and fail closed if two frozen copies
// disagree. An unfrozen copy can never replace a frozen copy.
export function mergeEpisodeRatingsStores(upstream, local) {
  for (const key of RATING_CONFIG_KEYS) {
    if (JSON.stringify(upstream?.[key] ?? null) !== JSON.stringify(local?.[key] ?? null)) {
      throw new Error(`episode rating settings differ at ${key}; refusing an automatic merge`);
    }
  }
  const upstreamRows = new Map((upstream.scores || []).map((row) => [ratingKey(row), row]));
  const localRows = new Map((local.scores || []).map((row) => [ratingKey(row), row]));
  const scores = [];
  for (const key of new Set([...upstreamRows.keys(), ...localRows.keys()])) {
    const a = upstreamRows.get(key);
    const b = localRows.get(key);
    if (!a) { scores.push(b); continue; }
    if (!b) { scores.push(a); continue; }
    if (a.frozenAt && b.frozenAt) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`frozen episode rating differs for ${key}; refusing to overwrite history`);
      }
      scores.push(a);
      continue;
    }
    if (a.frozenAt || b.frozenAt) {
      scores.push(a.frozenAt ? a : b);
      continue;
    }
    scores.push(newestRating(a, b));
  }
  scores.sort((a, b) => (a.ep ?? Number.MAX_SAFE_INTEGER) - (b.ep ?? Number.MAX_SAFE_INTEGER) || ratingKey(a).localeCompare(ratingKey(b)));
  const newerDocument = (Date.parse(local.updatedAt || "") || 0) >= (Date.parse(upstream.updatedAt || "") || 0) ? local : upstream;
  const updatedAt = [upstream.updatedAt, local.updatedAt].filter(Boolean).sort().at(-1) ?? null;
  return { ...newerDocument, updatedAt, scores };
}

// Post-live files are append-only histories. If main advanced after a local
// capture, choosing either side would erase a real reading. Keep every unique
// timestamp and fail if the same timestamp carries different facts.
export function mergePostliveStores(upstream, local) {
  for (const key of ["slug", "title", "date"]) {
    if ((upstream?.[key] ?? null) !== (local?.[key] ?? null)) {
      throw new Error(`post-live history identity differs at ${key}; refusing an automatic merge`);
    }
  }
  const snapshots = new Map();
  for (const snapshot of [...(upstream.snapshots || []), ...(local.snapshots || [])]) {
    if (!snapshot?.ts || !Number.isFinite(Date.parse(snapshot.ts))) {
      throw new Error(`post-live history for ${upstream.slug} contains a snapshot without a valid time`);
    }
    const existing = snapshots.get(snapshot.ts);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error(`post-live history for ${upstream.slug} differs at ${snapshot.ts}; refusing to erase either reading`);
    }
    snapshots.set(snapshot.ts, snapshot);
  }
  return {
    ...upstream,
    ...local,
    snapshots: [...snapshots.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}

export function healLeftovers(root, { log = console.log } = {}) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
  const healed = [];
  const orphanName = () => (git(["stash", "list"]).stdout.split("\n")[0] || "");
  const recognizedOrphan = () => /(?:isolated|chain|publish)-pre-pull/.test(orphanName());
  let unmerged = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
  for (let restored = 0; !unmerged.length && restored < 20 && recognizedOrphan(); restored++) {
    const name = orphanName();
    const pop = git(["stash", "pop", "--quiet"]);
    if (pop.status === 0) {
      healed.push(`${name} (restored after an interrupted pre-pull window)`);
      log(`chain: restored ${name} after an interrupted pre-pull window`);
      continue;
    }
    unmerged = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
    if (!unmerged.length) throw new Error(`${name} could not be restored and left no merge state to repair`);
  }
  if (!unmerged.length) return { healed };
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
    if (file === RATINGS_STORE) {
      const upstream = JSON.parse(git(["show", `:2:${file}`]).stdout);
      const local = JSON.parse(git(["show", `:3:${file}`]).stdout);
      const merged = mergeEpisodeRatingsStores(upstream, local);
      writeFileSync(join(root, file), JSON.stringify(merged, null, 2) + "\n");
      git(["add", file]);
      healed.push(`${file} (merged ${merged.scores.length} entries without changing frozen history)`);
      continue;
    }
    if (POSTLIVE_STORE.test(file)) {
      const upstream = JSON.parse(git(["show", `:2:${file}`]).stdout);
      const local = JSON.parse(git(["show", `:3:${file}`]).stdout);
      const merged = mergePostliveStores(upstream, local);
      writeFileSync(join(root, file), JSON.stringify(merged, null, 2) + "\n");
      git(["add", file]);
      healed.push(`${file} (kept ${merged.snapshots.length} unique readings from both sides)`);
      continue;
    }
    // PRD v11 W38 / rule 26: every other store under data/restream has one
    // writer — this machine's chain — so the local run's version (the stash
    // side of a failed pop) is the truth; the pulled side can only be older
    if (/^data\/restream\//.test(file) || /^transcripts\//.test(file) || file === "tools/dive-analytics/audit/HEALTH-VERIFY.md") {
      git(["checkout", "--theirs", "--", file]);
      git(["add", file]);
      healed.push(`${file} (kept this machine's version — the stores have one writer)`);
      continue;
    }
    throw new Error(`${file} is left conflicted from an earlier run and has no automatic merge — resolve it by hand, then rerun the chain`);
  }
  if (recognizedOrphan()) {
    const unresolved = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
    if (unresolved) throw new Error(`pre-pull data could not be restored; unresolved paths remain: ${unresolved.replace(/\n/g, ", ")}`);
    const dropped = git(["stash", "drop"]);
    if (dropped.status !== 0) throw new Error("restored pre-pull data, but could not retire its recovered stash");
  }
  for (const line of healed) log(`chain: healed ${line}`);
  return { healed };
}
