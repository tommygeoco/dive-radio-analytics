#!/usr/bin/env node
// baselines.test.mjs — fixture test for tools/dive-analytics/baselines.mjs
// (PRD v7 §8). Twelve synthetic weekly episodes with a 2× growth trend across
// the run, one promo outlier, one late-registered episode, one episode with
// no analytics. Asserts window membership, per-measure exclusions, MIN_PEERS
// absence, reading-rule tie-breaks, that only the promo episode is flagged
// under growth, and that the typical curve uses only mature, unflagged curves.
// Run by validate.mjs (block 1u) and on its own: node tools/dive-analytics/audit/baselines.test.mjs
import assert from "node:assert/strict";
import * as B from "../baselines.mjs";
import { scoreEpisode, readAgeOf, WEIGHTS, MIN_WEIGHT } from "../ratings.mjs";
import { deterministicMean, projectHealth, validateSynthesis, FORMULA_VERSION, STALE_WITHHOLD_DAYS } from "../health.mjs";

const DAY = 86400000;
const PHX = 7 * 3600000;
const premiere = (i) => new Date(Date.UTC(2026, 0, 7 + 7 * i, 12) + PHX).toISOString().slice(0, 10); // weekly from 2026-01-07
const ts = (date, ageDays) => new Date(B.premiereMs(date) + ageDays * DAY).toISOString();

// views grow with age (flatline ~3 weeks) and with episode index (2× over 12)
function episode(i, { firstDay = 1, lastDay = 40, promo = false, noWatch = false } = {}) {
  const date = premiere(i);
  const growth = 1 + i / 11; // E1 ×1 … E12 ×2
  const snaps = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const curve = 1 - Math.exp(-d / 6); // saturating
    const yt = Math.round(1000 * growth * curve);
    const plays = Math.round(800 * growth * curve * (promo ? 4 : 1));
    const reach = Math.round(5000 * growth * curve * (promo ? 4 : 1));
    snaps.push({ ts: ts(date, d), byDest: {
      "yt:joindiveclub": { views: Math.round(yt * 0.6), likes: Math.round(yt * 0.02), comments: Math.round(yt * 0.004) },
      "yt:designertom": { views: Math.round(yt * 0.4), likes: Math.round(yt * 0.015), comments: Math.round(yt * 0.003) },
      "x:ridd_design": { views: Math.round(reach * 0.6), plays: Math.round(plays * 0.6) },
      "x:designertom": { views: Math.round(reach * 0.4), plays: Math.round(plays * 0.4) },
    } });
  }
  const last = snaps[snaps.length - 1];
  const ytTotal = B.ytViewsOf(last);
  const xPlays = B.xPlaysOf(last, 2);
  return {
    slug: `e${String(i + 1).padStart(2, "0")}`,
    premiere: date,
    snapshots: snaps,
    latest: { ts: last.ts, byDest: last.byDest, ytTotal, xPlays, xPlaysInfo: { partial: false, stale: false, total: 2, have: 2 }, xImpressions: B.xImpressionsOf(last), totalViews: ytTotal + xPlays },
    watch: noWatch ? undefined : { avgPercent: 10 + i * 0.5, curve: [0.01, 0.02, 0.5, 1].map((at) => ({ at, watching: Math.round((100 - at * 80 - i) * 100) / 100 })) },
  };
}

// E1–E12; E5 promo outlier; E9 registered late (first snapshot day 12); E11 no analytics;
// the newest three are still young (last snapshot = their current age)
const eps = [];
for (let i = 0; i < 12; i++) {
  const ageNow = 12 * 7 - i * 7 + 3; // E12 is 3 days old at "now"
  eps.push(episode(i, { lastDay: Math.min(40, ageNow), promo: i === 4, firstDay: i === 8 ? 12 : 1, noWatch: i === 10 }));
}

// --- reading rule ---
{
  const e = eps[0];
  assert.equal(B.snapshotAt(e, 21).ts, ts(e.premiere, 21));
  assert.equal(B.snapshotAt(e, 21.4).ts, ts(e.premiere, 21), "nearest within tolerance");
  assert.equal(B.snapshotAt(e, 21.5).ts, ts(e.premiere, 21), "tie → earlier");
  assert.equal(B.snapshotAt(e, 60), null, "nothing beyond the last snapshot");
  assert.equal(B.snapshotAt(eps[8], 5), null, "late-registered episode has no reading before its first snapshot");
  assert.equal(B.historyAt([{ ageDays: 19.6 }, { ageDays: 22.4 }], 21).ageDays, 19.6, "history: tie → earlier");
  assert.equal(B.historyAt([{ ageDays: 19.4 }], 21), null, "history: outside ±1.5");
}

// --- window ---
{
  const w = B.windowFor(eps[11], eps);
  assert.deepEqual(w.map((e) => e.slug), ["e04", "e05", "e06", "e07", "e08", "e09", "e10", "e11"], "eight most recent before own, premiere order");
  assert.deepEqual(B.windowFor(eps[0], eps).map((e) => e.slug), [], "first episode has no earlier window");
  const either = B.windowFor(eps[5], eps, { side: "either" });
  assert.equal(either.length, 8);
  assert.ok(!either.some((e) => e.slug === "e06"), "either-side window excludes self");
}

// --- outlier flags: only the promo episode, and under 2× growth nothing else ---
{
  const flags = B.anomalyFlags(eps);
  const flagged = [...flags.entries()].filter(([, f]) => f.flagged).map(([s]) => s);
  assert.deepEqual(flagged, ["e05"], `only the promo episode is flagged, got ${flagged}`);
  const f5 = flags.get("e05");
  assert.equal(f5.units.xPlays.flag, true);
  assert.equal(f5.units.ytViews.flag, false, "YouTube views were not promoted");
  assert.equal(f5.units.xPlays.tier, 1, "mature episode with mature peers uses the settled tier");
  assert.equal(f5.provisional, false);
  assert.ok(!f5.units.xPlays.window.includes("e05"), "window excludes self");
  assert.ok(/promo-driven outlier/.test(f5.text));
  // the youngest episode can only be tested provisionally
  const f12 = flags.get("e12");
  assert.equal(f12.flagged, false);
  assert.ok([2, 3].includes(f12.units.ytViews.tier), "young episode uses a provisional tier");
}

// --- peers: exclusions and MIN_PEERS ---
{
  const flags = B.anomalyFlags(eps);
  const own = eps[7];
  const window = B.windowFor(own, eps);
  const r = B.peersFor({ own, window, flags, valueOf: (p) => { const s = B.snapshotAt(p, 21); return s ? B.ytViewsOf(s) : null; } });
  assert.ok(r.excluded.some((x) => x.slug === "e05" && x.why === "promo outlier"), "flagged peer excluded with reason");
  assert.equal(r.n, window.length - 1);
  assert.equal(typeof r.typical, "number");
  assert.equal(r.reason, null);
  const few = B.peersFor({ own: eps[2], window: B.windowFor(eps[2], eps), flags, valueOf: (p) => { const s = B.snapshotAt(p, 21); return s ? B.ytViewsOf(s) : null; } });
  assert.equal(few.typical, null, "two peers → no typical");
  assert.equal(few.reason, B.NOTES.fewPeers);
  const cov = B.peersFor({ own, window, flags, valueOf: () => 1, coverageOf: (p) => (p.slug === "e06" ? "yt" : "yt+x"), ownCoverage: "yt+x" });
  assert.ok(cov.excluded.some((x) => x.slug === "e06" && x.why === "different comment coverage"));
}

// --- pace: late-registered episode is not a peer before its first snapshot ---
{
  const flags = B.anomalyFlags(eps);
  const young = eps[11]; // 3 days old
  const p = B.paceFor(young, eps, flags);
  assert.ok(!p.peers.includes("e09"), "e09 has no reading at 3 days");
  assert.ok(p.excluded.some((x) => x.slug === "e09" && x.why === "no reading at this age"));
  assert.ok(!p.peers.includes("e05"), "outlier excluded from pace peers");
  assert.equal(typeof p.rank, "number");
  assert.equal(p.of, p.n + 1);
  const first = B.paceFor(eps[0], eps, flags);
  assert.equal(typeof first.rank, "number", "mature episodes compare at their shared last-snapshot age");
  const alone = B.paceFor(young, [young, eps[8], eps[4]], flags);
  assert.equal(alone.rank, null, "no three peers with a reading at 3 days (late-registered + outlier)");
  assert.match(alone.reason, /tracked this early/);
}

// --- typical curve: mature, unflagged, with analytics only ---
{
  const flags = B.anomalyFlags(eps);
  const t = B.typicalCurve(eps, flags);
  assert.ok(!t.window.includes("e05"), "outlier curve excluded");
  assert.ok(!t.window.includes("e11"), "episode without analytics excluded");
  assert.ok(!t.window.includes("e12"), "young episode excluded");
  assert.ok(t.window.includes("e10"), "a 24-day-old episode is mature");
  assert.equal(t.points.length, 4);
  assert.equal(t.points[0].at, 0.01);
  const ex = B.typicalCurve(eps, flags, { exclude: "e01" });
  assert.ok(!ex.window.includes("e01"));
  assert.equal(B.typicalCurve(eps.slice(0, 2), flags).points, null, "below MIN_PEERS → no line");
}

// --- projection is deterministic and carries the constants ---
{
  const a = JSON.stringify(B.computeBaselines(eps));
  const b = JSON.stringify(B.computeBaselines(eps));
  assert.equal(a, b);
  const proj = B.computeBaselines(eps);
  assert.equal(proj.constants.WINDOW_N, 8);
  assert.equal(proj.constants.MIN_PEERS, 3);
  assert.equal(proj.anomaly.e05.flagged, true);
  assert.equal(proj.watchPct.ageBasis, "mature");
  assert.ok(!proj.watchPct.window.includes("e05"));
}

// --- scoring helpers ---
assert.equal(B.scoreOf(50, 100), 25);
assert.equal(B.scoreOf(300, 100), 100);
assert.equal(B.scoreOf(10, 0), null);
assert.equal(B.trueMedian([3, 1, 2, 4]), 2.5);
assert.equal(B.trueMedian([]), null);

// --- episode health (health21-v2) on the fixture ---
{
  // live sessions, comments, and an injectable analytics/history reader
  for (const [i, e] of eps.entries()) {
    e.live = { peak: 60 + i * 2, chatMessages: 150 + i * 5 };
    const at = (d) => new Date(B.premiereMs(e.premiere) + d * DAY).toISOString();
    e.comments = { xCoverage: i % 2 ? "covered" : "missed", list: [
      { source: "yt", author: `a${i}`, sentiment: "positive", at: at(1) },
      { source: "yt", author: `b${i}`, sentiment: "positive", at: at(2) },
      { source: "yt", author: `c${i}`, sentiment: "negative", at: at(3) },
      { source: "x", author: `d${i}`, sentiment: "positive", at: at(1) },
      { source: "yt", author: `late${i}`, sentiment: "negative", at: at(30) }, // outside the read window
    ] };
  }
  const totals = (e, views) => ({ "yt:joindiveclub": { totals: { views: Math.round(views * 0.6), averageViewPercentage: 12 + e.ep, subscribersGained: 3 } }, "yt:designertom": { totals: { views: Math.round(views * 0.4), averageViewPercentage: 10 + e.ep, subscribersGained: 2 } } });
  eps.forEach((e, i) => { e.ep = i + 1; });
  const io = {
    readAnalytics: (slug) => { const e = eps.find((x) => x.slug === slug); return e.watch ? { updatedAt: ts(e.premiere, 40), channels: totals(e, 2000) } : null; },
    readHistory: (slug) => {
      const e = eps.find((x) => x.slug === slug);
      if (!e.watch || e.ep > 7) return []; // only E1–E7 have a day-21 history line
      const ch = totals(e, 1500);
      return [{ date: ts(e.premiere, 21).slice(0, 10), ageDays: 21.2, channels: Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, v.totals])) }];
    },
  };
  const flags = B.anomalyFlags(eps);
  const target = eps[7]; // E8: window E1–E7, E5 flagged
  const window = B.windowFor(target, eps);
  const r = scoreEpisode(target, window, flags, io);
  assert.equal(typeof r.score, "number");
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.checks.watch.ageBasis, "sameAge");
  assert.equal(r.checks.watch.peers.length, 6, "E1–E7 minus the outlier");
  assert.ok(r.checks.watch.peers.every((p) => p.atDay === readAgeOf(target) && p.source === "snapshot"));
  assert.ok(r.checks.watch.excluded.some((x) => x.slug === "e05" && x.why === "promo outlier"));
  assert.equal(r.checks.retention.ageBasis, "mature", "E8 has no history line → all from the current file");
  assert.equal(r.checks.retention.note, B.NOTES.mature);
  assert.equal(r.reproducible, false, "a current-file input is not rebuildable");
  assert.equal(r.checks.live.ageBasis, "ageFree");
  assert.equal(r.checks.sentiment.ageBasis, "mature");
  assert.deepEqual(r.checks.sentiment.sources, ["yt"], "window has a missed-X member → YouTube-only for everyone");
  assert.equal(r.checks.sentiment.value, 66.7, "late comment outside 21 d excluded; 2 of 3 positive");
  const weightSum = Object.values(r.checks).reduce((a, c) => a + (c.weight || 0), 0);
  assert.ok(Math.abs(weightSum - 1) < 0.002);
  const rebuilt = Object.entries(r.checks).filter(([, c]) => c.ratio != null).reduce((a, [, c]) => a + c.score * c.weight, 0);
  assert.equal(Math.round(rebuilt), r.score, "score rebuilds from the stored checks");
  for (const [k, c] of Object.entries(r.checks)) {
    if (c.ratio == null || k === "live") continue;
    assert.equal(c.typical, B.round1(B.trueMedian(c.peers.map((p) => p.value))), `${k} typical rebuilds from stored peers`);
    assert.equal(c.score, B.scoreOf(c.value, c.typical), `${k} score rebuilds`);
  }
  // E7: window E1–E6 all carry history lines → retention is same-age and rebuildable
  const r7 = scoreEpisode(eps[6], B.windowFor(eps[6], eps), flags, io);
  assert.equal(r7.checks.retention.ageBasis, "sameAge");
  assert.ok(r7.checks.retention.peers.every((p) => p.source === "history" && Math.abs(p.atDay - 21) <= B.HISTORY_TOL));
  assert.equal(r7.reproducible, true);
  // too few peers → no score, reason, every check absent with its own reason
  const r3 = scoreEpisode(eps[2], B.windowFor(eps[2], eps), flags, io);
  assert.equal(r3.score, null);
  assert.equal(r3.reason, B.NOTES.fewPeers);
  assert.ok(Object.values(r3.checks).every((c) => c.ratio == null && c.weight === 0));
  assert.equal(r3.missingChecks.length, Object.keys(WEIGHTS).length);
  assert.ok(MIN_WEIGHT === 0.5);
}

// --- show health (health-v3): weighting and projection rules ---
{
  // absent checks share weight among RELATIVE checks only; an absolute-scale check keeps its base weight
  const sub = {
    growth: { score: null, baseWeight: 0.25, absoluteScale: false },
    audienceQuality: { score: null, baseWeight: 0.20, absoluteScale: false },
    reachEfficiency: { score: 51, baseWeight: 0.15, absoluteScale: false },
    livePull: { score: 40, baseWeight: 0.15, absoluteScale: false },
    conversion: { score: null, baseWeight: 0.10, absoluteScale: false },
    sentiment: { score: 83, baseWeight: 0.15, absoluteScale: true },
  };
  const { weightedMean, effectiveWeightOf } = deterministicMean(sub);
  assert.equal(effectiveWeightOf(sub.sentiment), 0.15, "absolute check keeps its base weight");
  assert.ok(Math.abs(effectiveWeightOf(sub.reachEfficiency) - 0.425) < 1e-9, "relative checks share the rest");
  const total = Object.values(sub).reduce((a, p) => a + effectiveWeightOf(p), 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "weights sum to 1");
  assert.equal(weightedMean, 51.1);
  // with every check present the effective weights are the base weights
  const full = Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, { ...v, score: 50 }]));
  for (const [k, v] of Object.entries(full)) assert.ok(Math.abs(deterministicMean(full).effectiveWeightOf(v) - v.baseWeight) < 1e-9, `${k} base weight when all present`);

  // projection: age, withhold after STALE_WITHHOLD_DAYS, trend only under the running formula
  const entry = (date, formulaVersion, score = 50) => ({ date, score, headline: "h", pros: [], cons: [], subScores: {}, facts: [], formulaVersion });
  const store = { version: 2, entries: [
    ...Array.from({ length: 7 }, (_, i) => entry(`2026-08-${String(10 + i).padStart(2, "0")}`, "health-v2")),
    entry("2026-08-20", FORMULA_VERSION), entry("2026-08-21", FORMULA_VERSION),
  ] };
  const fresh = projectHealth(store, { now: Date.parse("2026-08-21T20:00:00Z") });
  assert.equal(fresh.ageDays, 0);
  assert.equal(fresh.withheld, false);
  assert.equal(fresh.score, 50);
  assert.equal(fresh.trend, null, "seven v2 days do not make a trend under the running formula");
  const stale = projectHealth(store, { now: Date.parse("2026-08-21T20:00:00Z") + (STALE_WITHHOLD_DAYS + 1) * DAY });
  assert.equal(stale.withheld, true);
  assert.equal(stale.score, null, "withheld read carries no score");
  assert.equal(stale.date, "2026-08-21", "but still says which day it was saved");
  assert.deepEqual(projectHealth({ version: 1, entries: [entry("2026-08-21", "health-v1")] }, { now: Date.parse("2026-08-21T20:00:00Z") }).checks.map((c) => c.measures), Array(6).fill([]), "a v1 store projects with empty measures");

  // check-set guard in validateSynthesis
  const inputs = { allowedScore: { min: 40, max: 60 }, facts: [{ id: "f1", display: "71" }], checkSetChange: { joined: [], left: ["audienceQuality"], previousScore: 40 } };
  const ok = { score: 50, headline: "Steadier than it looks.", pros: [{ text: "Peak hit 71.", factId: "f1" }, { text: "Peak hit 71.", factId: "f1" }], cons: [{ text: "Peak hit 71.", factId: "f1" }, { text: "Peak hit 71.", factId: "f1" }], drivers: ["The move comes from the audience quality check leaving, not the show changing."] };
  assert.doesNotThrow(() => validateSynthesis(ok, inputs));
  assert.throws(() => validateSynthesis({ ...ok, drivers: ["Live turnout carried it."] }, inputs), /must name the check/);
  assert.doesNotThrow(() => validateSynthesis({ ...ok, score: 44, drivers: ["Live turnout carried it."] }, inputs), "a move of 4 needs no naming");
}

console.log("baselines.test: ok");
