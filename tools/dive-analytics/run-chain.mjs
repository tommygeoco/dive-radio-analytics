#!/usr/bin/env node
// run-chain.mjs — execute the daily chain exactly as chain.json orders it.
//
// The crontab shrinks to one line (node tools/dive-analytics/run-chain.mjs)
// and chain.json stays the single versioned definition of the chain (PRD v9
// §4.5) — the order the cron runs can no longer drift from the order the
// validator checks. A required step that fails stops the chain (validate and
// publish are the gates); an optional step that fails is reported and
// skipped — a wobbly comment pull must not cost the day's publish. Steps
// marked "when": "Mondays" run only on Phoenix Mondays. Model steps read
// their keys from the cron environment as today; this runner is plain
// orchestration and never calls a model itself.
//
// Run:
//   node tools/dive-analytics/run-chain.mjs --dry      # print the plan, run nothing
//   node tools/dive-analytics/run-chain.mjs --rehearse # full chain, no publish-side steps
//   node tools/dive-analytics/run-chain.mjs            # run the chain
//
// --rehearse exists for the pre-flight cron: it runs every data step and both
// validate gates exactly as the real run will, but skips the steps that touch
// the outside world (publish, alerts, freshness) so a 6:00 rehearsal can fail
// loudly without shipping or queueing anything. The 7:00 run stays the only
// writer of public state.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healLeftovers } from "./chain-heal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const chain = JSON.parse(readFileSync(join(HERE, "chain.json"), "utf8"));
const PHX_DAY = new Date(Date.now() - 7 * 3600000).toUTCString().slice(0, 3);
const dry = process.argv.includes("--dry");
const rehearse = process.argv.includes("--rehearse");
const REHEARSE_SKIP = new Set(["publish", "alerts", "freshness", "critic"]);

// PRD v10 W34: the chain pulls main BEFORE it builds, so code merged from
// another machine runs the same morning and the publish-time pull is a no-op.
// Data files are the chain's own output: any local change to them is set
// aside, the pull applies, and they are rebuilt by the build-data step —
// never stashed back over the pulled code. A pull that cannot fast-forward
// stops the chain loudly (the old behavior, one step earlier).
function pullFirst() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
  // an earlier run's failed publish may have left unmerged paths and a stash
  // behind (a same-day formula re-derivation collides with the local day's
  // read); repair that first or the pull below refuses to run
  try { healLeftovers(ROOT); } catch (error) { console.error(`chain: ${error.message}`); process.exit(1); }
  const status = git(["status", "--porcelain"]).stdout.trim();
  const dirty = status.split("\n").filter(Boolean).map((l) => l.slice(3));
  const generated = dirty.filter((f) => /^(data\.json|data\.js|data\/restream\/|transcripts\/|tools\/dive-analytics\/audit\/HEALTH-VERIFY\.md)/.test(f));
  const other = dirty.filter((f) => !generated.includes(f));
  if (other.length) console.log(`chain: local changes outside the data stores (${other.slice(0, 5).join(", ")}) — pulling with a stash`);
  const stashed = dirty.length ? git(["stash", "push", "--include-untracked", "-m", "chain-pre-pull"]).status === 0 : false;
  const pull = git(["pull", "--rebase", "--quiet", "origin", "main"]);
  if (pull.status !== 0) {
    if (stashed) git(["stash", "pop"]);
    console.error(`chain: git pull --rebase failed — ${(pull.stderr || pull.stdout).trim().slice(0, 300)}`);
    process.exit(1);
  }
  if (stashed) {
    const pop = git(["stash", "pop"]);
    if (pop.status !== 0) {
      // the stash held generated files that the pulled commit also changed:
      // keep the pulled versions (build-data rewrites them minutes from now)
      git(["checkout", "--", "."]);
      git(["stash", "drop"]);
      console.log("chain: pulled code changed generated files too — kept the pulled versions; the build step regenerates them");
    }
  }
  console.log(`chain: at ${git(["rev-parse", "--short", "HEAD"]).stdout.trim()} after pulling main`);
}
if (!dry) pullFirst();

let failedOptional = 0;
for (const step of chain.steps) {
  if (step.when === "Mondays" && PHX_DAY !== "Mon") {
    console.log(`chain: ${step.step} — waits for Monday, skipped`);
    continue;
  }
  if (rehearse && REHEARSE_SKIP.has(step.step)) {
    console.log(`chain: ${step.step} — rehearsal, skipped (no publish-side effects)`);
    continue;
  }
  const parts = step.script.split(" ");
  const cmd = parts[0].endsWith(".sh") ? ["sh", ...parts] : ["node", ...parts];
  if (dry) {
    console.log(`chain: would run ${step.step}${step.required ? "" : " (optional)"} — ${cmd.join(" ")}`);
    continue;
  }
  console.log(`chain: ${step.step} …`);
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` },
  });
  const code = res.status ?? 1;
  if (code !== 0) {
    if (step.required) {
      console.error(`chain: ${step.step} failed (exit ${code}) — required, stopping here`);
      process.exit(1);
    }
    failedOptional++;
    console.log(`chain: ${step.step} failed (exit ${code}) — not required, continuing`);
  }
}
console.log(`chain: done${failedOptional ? ` — ${failedOptional} optional step(s) failed` : ""}`);
