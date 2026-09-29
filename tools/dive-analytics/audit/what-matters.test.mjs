#!/usr/bin/env node
// what-matters.test.mjs — What matters holds at most five cards (owner
// directive 2026-09-01, restated 2026-09-29 after the rule-based fallback
// shipped sixteen). The ranked store ships its own five; with no ranked store
// the five most timely rule-based cards ship: the newest episode's standing
// first, then this week's levers, then standing facts, older promo flags and
// data caveats. Reads the committed data.json episodes and stores.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeAll, fallbackInsights, trendsLines } from "../build-data.mjs";
import { anomalyFlags } from "../baselines.mjs";
import { TOP_N } from "../recommendations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const data = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
assert.equal(TOP_N, 5);

// the full rule-based list, in timeliness order
const eps = structuredClone(data.episodes);
const full = fallbackInsights(eps, anomalyFlags(eps));
const ids = full.map((i) => i.id);
const at = (id) => ids.indexOf(id);
const newest = [...data.episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : 1)).at(-1).slug;
const levers = ["reach-conversion", "host-split", "engagement", "live-chat", "flatline", "platform-phase", "watch-split", "host-plays-split"].filter((id) => at(id) >= 0);
const timely = ["pace-rank", "live-peak", `anomaly-${newest}`].filter((id) => at(id) >= 0);
assert.deepEqual(ids.slice(0, timely.length), timely, "the newest episode's cards come first");
assert.deepEqual(ids.slice(timely.length, timely.length + levers.length), levers, "then the levers, in their order");
for (const id of ids.filter((x) => x.startsWith("anomaly-") && x !== `anomaly-${newest}`)) assert.ok(levers.every((l) => at(l) < at(id)), `${id} (an older promo flag) comes after the levers`);
if (at("partial-history") >= 0) assert.equal(ids.at(-1), "partial-history", "the data caveat comes last");
assert.ok(full.every((i) => i.category && i.rank == null), "fallback cards carry a category and never a rank");

// what ships: at most five, and — when no ranked store drives — exactly the first five
const built = computeAll({ now: Date.parse(data.generatedAt) });
assert.ok(built.insights.length <= TOP_N, `${built.insights.length} cards shipped`);
if (built.insights.every((i) => i.rank == null)) {
  const fresh = fallbackInsights(structuredClone(built.episodes), anomalyFlags(structuredClone(built.episodes)));
  assert.deepEqual(built.insights.map((i) => i.id).sort(), fresh.slice(0, TOP_N).map((i) => i.id).sort());
}
// Slack reads the same five
assert.equal(trendsLines(built).filter((l) => l.kind === "insight" && l.text.startsWith("•")).length, built.insights.length);

console.log(`what-matters.test: ${built.insights.length} of ${full.length} rule-based cards ship; newest episode first, levers next, caveats last`);
