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
//   node tools/dive-analytics/run-chain.mjs --dry   # print the plan, run nothing
//   node tools/dive-analytics/run-chain.mjs         # run the chain

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const chain = JSON.parse(readFileSync(join(HERE, "chain.json"), "utf8"));
const PHX_DAY = new Date(Date.now() - 7 * 3600000).toUTCString().slice(0, 3);
const dry = process.argv.includes("--dry");

let failedOptional = 0;
for (const step of chain.steps) {
  if (step.when === "Mondays" && PHX_DAY !== "Mon") {
    console.log(`chain: ${step.step} — waits for Monday, skipped`);
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
