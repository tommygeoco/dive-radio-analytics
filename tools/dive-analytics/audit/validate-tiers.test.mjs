// validate-tiers.test.mjs — PRD v11 W36: the validator's two tiers hold.
//   1. Static: no `fail(` remains under a condition that inspects page or
//      script source; those are `drift(` — in publish mode they never block.
//   2. Live: `validate.mjs --publish` on the current tree exits 0 whenever the
//      strict run reports no `fail`; drift never counts as a failure there.
//   3. The drift definition itself: counts in both modes, blocks only strict.
// Run: node tools/dive-analytics/audit/validate-tiers.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const src = readFileSync(join(HERE, "validate.mjs"), "utf8");
const lines = src.split("\n");

// 3. the definition
assert.match(src, /const publishMode = process\.argv\.includes\("--publish"\)/);
assert.match(src, /const drift = \(m\) => \{ drifts\+\+; if \(!publishMode\) failures\+\+; console\.log\(`DRIFT \$\{m\}`\); \}/);
assert.match(src, /process\.exit\(failures \? 1 : 0\)/);

// 1. static: every failure whose governing condition reads source is a drift
const SOURCE_VARS = ["html", "healthSource", "panelSource", "stripSource", "trendSource", "totalsPlugin", "heroSource", "compoundSource", "chipSource", "renderer", "pageSource", "panel", "tooltipSource", "tableSource", "about", "defsBlock", "between(", "promptHash", "chain.steps", "step.script", "step.writes", "publishIdx"];
const HARD = /freshness:|rebuild:|append-only|grounded|re-derive|recompute|reproduce|withheld|does not equal|does not re-derive|unit |plays schema|totalViews|absence|Slack does not read|slack\b|trendsText|parity/;
const offenders = [];
let drifts = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes("drift(") && !l.includes("const drift")) drifts++;
  if (!l.includes("fail(") || l.includes("const fail")) continue;
  if (HARD.test(l)) continue;
  let j = i;
  while (j >= 0 && i - j < 8 && !/\b(if|for|else if)\s*\(/.test(lines[j])) j--;
  if (j < 0 || i - j >= 8) j = i;
  const ctx = lines.slice(j, i + 1).join("\n");
  if (SOURCE_VARS.some((v) => ctx.includes(v))) offenders.push(`${i + 1}: ${l.trim().slice(0, 100)}`);
}
assert.deepEqual(offenders, [], `source-inspecting checks still block a publish:\n${offenders.join("\n")}`);
assert.ok(drifts >= 60, `expected the source contracts to be drift-tier (found ${drifts} drift call sites)`);

// 2. live: publish mode never fails on drift
const strict = spawnSync("node", [join(HERE, "validate.mjs")], { cwd: ROOT, encoding: "utf8" });
const publish = spawnSync("node", [join(HERE, "validate.mjs"), "--publish"], { cwd: ROOT, encoding: "utf8" });
const strictFails = (strict.stdout.match(/^FAIL /gm) || []).length;
const publishFails = (publish.stdout.match(/^FAIL /gm) || []).length;
assert.equal(publishFails, strictFails, "the two modes must agree on every fail");
assert.match(publish.stdout, /publish mode: drift is reported, not blocking/);
if (strictFails === 0) assert.equal(publish.status, 0, "publish mode must exit 0 when no fail is present, whatever the drift count");
console.log(`validate-tiers.test: ${drifts} drift-tier checks, ${strictFails} fail(s) on this tree, publish mode exit ${publish.status}`);
