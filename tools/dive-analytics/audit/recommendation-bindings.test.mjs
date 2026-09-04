import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { collectFacts, stampedFacts, validateItem, validateItems, validateGeneratedItems } from "../recommendations.mjs";

// Actual collision observed in the September 4 fact sheet: E4 mid-hold and
// E6 watch share both equal 11.6; E3 mid-hold and E4 discovery both equal 13.5.
// The rejected live model prose was not retained, so this proves the guard
// defect without assuming that it caused that particular rejected response.
const facts = [
  { id: "mid-hold-E4", value: 11.6, episode: 4, ageDays: 29, comparisonBasis: "mature" },
  { id: "mid-hold-E3", value: 13.5, episode: 3, ageDays: 36, comparisonBasis: "mature" },
  { id: "watched-E6", value: 11.6, episode: 6, ageDays: 15, kind: "episode-rate", basis: "young" },
  { id: "discovery-E4", value: 13.5, episode: 4, ageDays: 29, kind: "episode-rate", basis: "mature" },
  { id: "mid-hold-E6", value: 11.6, episode: 6, ageDays: 15, comparisonBasis: "young" },
  { id: "peak-E3", value: 42.7 },
  { id: "subs-E1-fixture", value: 4 },
];
const item = {
  id: "tighten-mid-show-demos", category: "content", serves: "audienceQuality",
  text: "E4 retained 11.6% through the middle half, compared with 13.5% for E3.",
  recommendation: "Tighten the middle demonstration and test a shorter transition.",
  factIds: ["mid-hold-E4", "mid-hold-E3"],
};
assert.equal(validateItem(item, facts), item, "correct mature bindings must resolve the numeric collision");
assert.equal(validateItem(item, stampedFacts(facts)), item, "stored facts retain the comparison evidence");
const legacy = { ...item }; delete legacy.factIds;
assert.throws(() => validateItem(legacy, facts), /young episode/, "unbound legacy items retain their conservative prior guard");
assert.throws(() => validateItem({ ...item, text: "E6 has 11.6% share watched, compared with 13.5% discovery for E4.", factIds: ["watched-E6", "discovery-E4"] }, facts), /young episode/, "real young/mature comparison must fail despite the same numeric collision");
assert.throws(() => validateItem({ ...item, text: "E6 retained 11.6% through the middle half, compared with 11.6% for E4.", factIds: ["mid-hold-E6", "mid-hold-E4"] }, facts), /young episode/, "young versus mature curve facts must fail even when their values match");
for (const factIds of [[], ["missing"], ["mid-hold-E4", "mid-hold-E4"], [null]]) {
  assert.throws(() => validateItem({ ...item, factIds }, facts), /factIds|cited fact/, "bindings must be known and unique");
}
assert.throws(() => validateItem({ ...item, factIds: ["watched-E6", "discovery-E4"] }, facts), /episode E3|young episode/, "known but wrong episode bindings must fail");
assert.throws(() => validateItem({ ...item, text: "E4 retained 42.7% through the middle half." }, facts), /42.7.*cited facts/, "a number elsewhere in the sheet cannot satisfy the declared citations");
assert.throws(() => validateItem({ ...item, caveat: "Another reading is 42.7%." }, facts), /caveat number/, "caveat numbers use the same bindings");
assert.throws(() => validateItem(item, facts.map(f => f.id === "mid-hold-E4" ? { id: f.id, value: f.value } : f)), /comparison metadata/, "missing rate metadata cannot grant comparison permission");
assert.throws(() => validateItem(item, [...facts, facts[0]]), /ambiguous/, "fact IDs identify one reading only");
const five = Array.from({ length: 5 }, (_, i) => ({ ...item, id: `bound-action-${i}` }));
assert.equal(validateGeneratedItems(five, facts), five);
const unbound = five.map(({ factIds, ...rest }) => ({ ...rest, text: "The middle demonstration needs a tighter transition." }));
assert.equal(validateItems(unbound, facts), unbound, "legacy reading does not require invented bindings");
assert.throws(() => validateGeneratedItems(unbound, facts), /requires factIds/, "every newly generated model item must declare bindings");
assert.throws(() => validateItems(unbound, facts, { requireFactIds: true }), /requires factIds/, "v5 store readers enforce the same contract");

const episode = (ep, ageDays) => ({ ep, ageDays, slug: `fixture-episode-${ep}`, latest: {}, watch: {
  avgPercent: 11.6, curve: [{ at: 0.01, watching: 0.3 }, { at: 0.02, watching: 0.2 }],
  shape: { openFloor: 12, recoveryPeak: 20, midHold: 11.6, endHold: 8 },
  moments: [{ kind: "drop", at: 0.5, points: 2.4, estSec: 120, excerpt: "Fixture context" }, { kind: "hold", at: 0.6, points: 1.4, estSec: 180 }],
}, live: { peak: 100, avg: 80, chatMessages: 30, chatters: 10 } });
const emitted = collectFacts({ generatedAt: "2026-09-04T20:00:00Z", episodes: [episode(4, 29), episode(6, 15)] }).facts;
for (const prefix of ["watched", "open-start", "open-at2", "open-floor", "recovery-peak", "mid-hold", "end-hold", "drop", "hold"]) {
  const family = emitted.filter(f => f.id.startsWith(`${prefix}-E`));
  assert.equal(family.length, 2, `${prefix} fixture must emit both ages`);
  for (const fact of family) assert.equal(fact.comparisonBasis ?? fact.basis, fact.episode === 4 ? "mature" : "young", `${fact.id} needs its own episode age`);
}
assert.ok(emitted.filter(f => /^(peak|avg|chat|chatters)-/.test(f.id)).every(f => f.basis == null && f.comparisonBasis == null), "completed live-session facts remain independent of episode maturity");

// Exercise generation -> saved bindings -> public projection -> stale filter
// through the actual CLIs in an isolated copy. No live model/network or source
// store can be touched; a preload supplies only copied fact-sheet values.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "dive-recommendation-bindings-")));
try {
  const root = join(temp, "repo");
  execFileSync("git", ["clone", "--quiet", "--shared", ROOT, root]);
  cpSync(join(ROOT, "tools"), join(root, "tools"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(ROOT, "data.json"), join(root, "data.json"));
  const storePath = join(root, "data/restream/recommendations.json");
  const preload = join(temp, "model-stub.mjs");
  writeFileSync(preload, `globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(JSON.parse(options.body).messages[0].content);
    const fact = payload.facts.find(f => f.id === 'peak-E1');
    if (!fact) throw new Error('fixture needs the measured E1 live peak');
    const items = Array.from({length:5}, (_, i) => ({id:'bound-fixture-'+i,category:'content',serves:'livePull',text:'E1 reached '+fact.value+' peak live viewers.',recommendation:'Test a shorter introduction.',...(process.env.DIVE_FIXTURE_BINDINGS === 'missing' ? {} : {factIds:[fact.id]})}));
    return {ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify({items})}]})};
  };\n`);
  const run = (script, mode = "present") => spawnSync(process.execPath, ["--import", preload, join(root, "tools/dive-analytics", script)], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "fixture-only", HEALTH_MODEL: "fixture-model", DIVE_FIXTURE_BINDINGS: mode },
  });
  let result = run("recommendations.mjs");
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(store.promptVersion, 5);
  assert.ok(store.items.every(i => i.factIds?.[0] === "peak-E1"));
  assert.ok(store.facts.filter(f => /^mid-hold-E/.test(f.id)).every(f => f.comparisonBasis && f.episode && Number.isFinite(f.ageDays)), "generation persists comparison metadata");
  result = run("build-data.mjs");
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  let data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
  assert.equal(data.insights.length, 5);
  assert.ok(data.insights.every(i => !Object.hasOwn(i, "factIds")), "internal bindings never enter public prose");
  result = run("recommendations.mjs", "missing");
  assert.equal(result.status, 1, "new output without bindings must fail, then retain grounded saved items");
  assert.match(result.stdout, /requires factIds/);
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).items, store.items);
  store.items[0].factIds = ["fixture-unknown-fact"];
  writeFileSync(storePath, JSON.stringify(store));
  result = run("build-data.mjs");
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
  assert.ok(!data.insights.some(i => i.id === store.items[0].id));
  assert.match(data.insightsStale.find(i => i.id === store.items[0].id)?.why || "", /cited fact/);
  console.log("recommendation-bindings.test: exact citations resolve collisions, enforce maturity, survive storage, and gate generation and public projection");
} finally { rmSync(temp, { recursive: true, force: true }); }
