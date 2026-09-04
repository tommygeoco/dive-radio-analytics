#!/usr/bin/env node
// baselines.test.mjs — fixture test for tools/dive-analytics/baselines.mjs
// (PRD v9 §8). Twelve synthetic weekly episodes with a 2× growth trend across
// the run, one promo outlier, one late-registered episode, one episode with
// no analytics. Asserts window membership, per-measure exclusions, MIN_PEERS
// absence, reading-rule tie-breaks, that only the promo episode is flagged
// under growth, and that the typical curve uses only mature, unflagged curves.
// Run by validate.mjs (block 1u) and on its own: node tools/dive-analytics/audit/baselines.test.mjs
import assert from "node:assert/strict";
import * as B from "../baselines.mjs";
import { scoreEpisode, readAgeOf, WEIGHTS, MIN_WEIGHT } from "../ratings.mjs";
import { computeHealthInputs, deterministicMean, checkScoreOf, checkBandsOf, projectHealth, validateSynthesis, FORMULA_VERSION, STALE_WITHHOLD_DAYS } from "../health.mjs";
import { mergeHealthStores } from "../chain-heal.mjs";

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

// --- YouTube reading eligibility: a pre-reporting zero is absence, not day one ---
{
  const date = premiere(20);
  const zero = { ts: ts(date, 1), byDest: {
    "yt:joindiveclub": { views: 0, likes: 0, comments: 0 },
    "yt:designertom": { views: 0, likes: 0, comments: 0 },
    "x:ridd_design": { views: 400, plays: 100 },
  } };
  const absent = { ts: ts(date, 1.2), byDest: { "x:ridd_design": { views: 500, plays: 120 } } };
  const preAir = { ts: ts(date, -0.2), byDest: {
    "yt:joindiveclub": { views: 3, likes: 0, comments: 0 },
    "yt:designertom": { views: 0, likes: 0, comments: 0 },
  } };
  const airDay = { ts: ts(date, 0.3), byDest: {
    "yt:joindiveclub": { views: 12, likes: 1, comments: 0 },
    "yt:designertom": { views: 0, likes: 0, comments: 0 },
    "x:ridd_design": { views: 450, plays: 110 },
  } };
  const positivePlusZero = { ts: ts(date, 2), byDest: {
    "yt:joindiveclub": { views: 42, likes: 3, comments: 1 },
    "yt:designertom": { views: 0, likes: 0, comments: 0 },
    "x:ridd_design": { views: 600, plays: 140 },
  } };
  const e = { premiere: date, snapshots: [preAir, airDay, zero, absent, positivePlusZero] };
  assert.equal(B.hasYtReading(zero), false, "an all-zero public row is not a YouTube reading");
  assert.equal(B.hasYtReading(absent), false, "an X-only snapshot is not a YouTube reading");
  assert.equal(B.ytViewsOf(zero), null);
  assert.equal(B.ytEngagementOf(zero), null);
  assert.equal(B.hasYtReading(positivePlusZero), true, "one positive channel makes the combined reading valid");
  assert.equal(B.hasYtReading(preAir), true, "the raw count remains measurable before the episode clock is applied");
  assert.equal(B.latestCurrentYtSnapshot({ premiere: date, snapshots: [preAir, airDay] }), airDay, "air-date data can power the current card");
  assert.equal(B.firstYtSnapshot({ premiere: date, snapshots: [preAir, airDay] }), null, "air-date data cannot become day one");
  assert.equal(B.snapshotAt({ premiere: date, snapshots: [airDay] }, 0.3), null, "air-date X data stays out of history too");
  assert.equal(B.ytViewsOf(positivePlusZero), 42, "the valid zero companion channel stays in the sum");
  assert.equal(B.ytEngagementOf(positivePlusZero), 4);
  assert.equal(B.snapshotAt(e, 1), zero, "the generic selector remains available for X");
  assert.equal(B.ytSnapshotAt(e, 1), null, "the zero row cannot satisfy a YouTube age read");
  assert.equal(B.firstYtSnapshot(e), positivePlusZero, "day one starts at the first positive YouTube reading");
  assert.equal(B.latestYtSnapshot(e), positivePlusZero);
  assert.equal(B.ytCurrentAge(e), 2);

  const emptyLine = { date: "2026-01-01", ageDays: 1, channels: {} };
  const zeroLine = { date: "2026-01-02", ageDays: 1.1, channels: {
    "yt:joindiveclub": { views: 0, averageViewPercentage: 0 }, "yt:designertom": { views: 0, averageViewPercentage: 0 },
  } };
  const validLine = { date: "2026-01-03", ageDays: 1.3, channels: {
    "yt:joindiveclub": { views: 50, averageViewPercentage: 12 }, "yt:designertom": { views: 7, averageViewPercentage: 9 },
  } };
  const preAirLine = { date: "2025-12-31", ageDays: -0.2, channels: {
    "yt:joindiveclub": { views: 3, averageViewPercentage: 12 }, "yt:designertom": { views: 2, averageViewPercentage: 9 },
  } };
  assert.equal(B.historyAt([emptyLine, zeroLine], 1), emptyLine, "the generic history selector is unchanged");
  assert.equal(B.ytHistoryAt([emptyLine, zeroLine], 1), null, "empty and all-zero history lines cannot satisfy a YouTube read");
  assert.equal(B.ytHistoryAt([preAirLine, emptyLine, zeroLine, validLine], 1), validLine, "the selector skips pre-air, empty, and zero rows for a positive history reading");
  const airDateLine = { date, ageDays: 0.3, channels: { "yt:joindiveclub": { views: 12, averageViewPercentage: 12 }, "yt:designertom": { views: 4, averageViewPercentage: 9 } } };
  const nextDateLine = { date: new Date(B.premiereMs(date) + 86400000 - PHX).toISOString().slice(0, 10), ageDays: 0.8, channels: { "yt:joindiveclub": { views: 20, averageViewPercentage: 12 }, "yt:designertom": { views: 5, averageViewPercentage: 9 } } };
  assert.equal(B.ytHistoryAt([airDateLine], 0.3, date), null, "an owner analytics line from air date is not historical");
  assert.equal(B.ytHistoryAt([airDateLine, nextDateLine], 0.8, date), nextDateLine, "the next Phoenix date is the first eligible owner analytics read");
}

// The all-zero episode never becomes an own reading or a future peer, and the
// health input builder cannot score its launch or engagement as zero.
{
  const make = (i, views) => {
    const date = premiere(30 + i);
    const snap = { ts: ts(date, 1), byDest: {
      "yt:joindiveclub": { views, likes: views > 0 ? 2 : 0, comments: 0 },
      "yt:designertom": { views: 0, likes: 0, comments: 0 },
      "x:ridd_design": { views: 500, plays: 100 },
    } };
    return {
      ep: i + 1, slug: `zero-read-${i + 1}`, title: `Episode ${i + 1}`, premiere: date,
      snapshots: [snap], latest: { ts: snap.ts, byDest: snap.byDest, ytTotal: views, xImpressions: 500, xPlays: 100, xPlaysInfo: { value: 100, have: 1, total: 1, partial: false, stale: false }, totalViews: views + 100 },
      metrics: { week1Velocity: null, week1Note: "pending: episode under 7 days old" },
    };
  };
  const [p1, p2, p3, zeroPeer, newest] = [100, 200, 300, 0, 220].map((v, i) => make(i, v));
  const list = [p1, p2, p3, zeroPeer, newest];
  const cleanFlags = new Map(list.map((x) => [x.slug, { flagged: false, units: {} }]));
  const pace = B.paceFor(newest, list, cleanFlags);
  assert.equal(pace.typical, 200, "the zero-only episode cannot lower a future pace typical");
  assert.equal(pace.n, 3);
  assert.ok(pace.excluded.some((x) => x.slug === zeroPeer.slug && x.why === "no reading at this age"));
  const launch = B.launchReadFor(newest, list, cleanFlags);
  assert.equal(launch.typical, 200, "the zero-only episode cannot lower a future launch typical");
  assert.equal(B.paceFor(zeroPeer, list, cleanFlags), null, "the zero-only episode has no pace read");
  assert.equal(B.launchReadFor(zeroPeer, list, cleanFlags), null, "the zero-only episode has no launch read");
  const anomaly = B.anomalyFlags(list).get(zeroPeer.slug).units.ytViews;
  assert.deepEqual(anomaly, { tier: null, value: null, typical: null, n: 0, window: [], flag: false }, "zero cannot enter the outlier history as a real value");

  const direction = { measures: [{ key: "firstWeek", check: "growth", n: 0, pctPerEpisode: null, direction: null, points: [], reason: B.NOTES.fewPeers }], votes: [], overall: null };
  const outlook = { nextFirstWeek: { low: null, high: null, typical: null, n: 0, window: [], pctPerEpisode: null, direction: null, reason: B.NOTES.fewPeers }, coolOff: null };
  const zeroLatest = [p1, p2, p3, zeroPeer];
  const inputs = computeHealthInputs({
    data: { generatedAt: zeroPeer.latest.ts, episodes: zeroLatest, showTrend: { week1VelocityByEpisode: [] }, commentSummary: {}, baselines: { direction, outlook, launch: {} } },
    now: Date.parse(zeroPeer.latest.ts), root: "/tmp/dive-radio-zero-health-fixture-does-not-exist",
  });
  assert.equal(inputs.subScores.growth.measures.sameAge.value, null, "show health does not score an all-zero YouTube launch");
  assert.equal(inputs.subScores.growth.measures.sameAge.reason, B.NOTES.noYtReading);
  assert.equal(inputs.subScores.audienceQuality.measures.engagement.value, null, "show health does not score zero engagement before a YouTube view reading");

  const airDateTs = ts(newest.premiere, 0.3);
  const airDateNewest = {
    ...newest,
    snapshots: [{ ...newest.snapshots[0], ts: airDateTs }],
    latest: { ...newest.latest, ts: airDateTs },
  };
  const beforeAirDate = [p1, p2, p3, zeroPeer, airDateNewest];
  const airDateInputs = computeHealthInputs({
    data: { generatedAt: airDateTs, episodes: beforeAirDate, showTrend: { week1VelocityByEpisode: [] }, commentSummary: {}, baselines: { direction, outlook, launch: {} } },
    now: Date.parse(airDateTs), root: "/tmp/dive-radio-air-date-health-fixture-does-not-exist",
  });
  assert.notEqual(airDateInputs.asOf.newest, airDateNewest.slug, "an episode cannot anchor show health on its air date");
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
  assert.ok(p.peers.includes("e05"), "an X-only outlier remains a YouTube pace peer");
  assert.equal(typeof p.rank, "number");
  assert.equal(p.of, p.n + 1);
  const first = B.paceFor(eps[0], eps, flags);
  assert.equal(typeof first.rank, "number", "mature episodes compare at their shared last-snapshot age");
  const alone = B.paceFor(young, [young, eps[8], eps[4]], flags);
  assert.equal(alone.rank, null, "no three peers with a reading at 3 days");
  assert.match(alone.reason, /tracked this early/);
}

// --- typical curve: mature, with analytics, excluding YouTube lifts only ---
{
  const flags = B.anomalyFlags(eps);
  const t = B.typicalCurve(eps, flags);
  assert.ok(t.window.includes("e05"), "an X-only outlier keeps its YouTube watch curve");
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
  assert.ok(proj.watchPct.window.includes("e05"), "an X-only outlier remains eligible for a YouTube watch comparison");
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
  // PRD v10: an entry projects exactly the checks it carries — a six-check v1
  // entry projects six (with empty measures), never an invented seventh
  const v1 = { ...entry("2026-08-21", "health-v1"), subScores: Object.fromEntries(["growth", "audienceQuality", "reachEfficiency", "livePull", "conversion", "sentiment"].map((k) => [k, { score: 50 }])) };
  assert.deepEqual(projectHealth({ version: 1, entries: [v1] }, { now: Date.parse("2026-08-21T20:00:00Z") }).checks.map((c) => c.measures), Array(6).fill([]), "a v1 store projects its six checks with empty measures");
  assert.deepEqual(projectHealth({ version: 1, entries: [entry("2026-08-21", "health-v1")] }, { now: Date.parse("2026-08-21T20:00:00Z") }).checks, [], "an entry without checks projects none");

  // check-set guard in validateSynthesis — W27/prompt v4: a changed set must
  // always be named, every changed check by name, and drivers carry no digits;
  // stored pre-v4 entries keep the looser rule they were written under
  const inputs = { allowedScore: { min: 40, max: 60 }, facts: [{ id: "f1", display: "71" }], checkSetChange: { joined: [], left: ["audienceQuality"], previousScore: 40 } };
  const ok = { score: 50, headline: "Steadier than it looks.", pros: [{ text: "Peak hit 71.", factId: "f1" }, { text: "Peak hit 71.", factId: "f1" }], cons: [{ text: "Peak hit 71.", factId: "f1" }, { text: "Peak hit 71.", factId: "f1" }], drivers: ["The move comes from the audience quality check leaving, not the show changing."] };
  assert.doesNotThrow(() => validateSynthesis(ok, inputs));
  assert.throws(() => validateSynthesis({ ...ok, drivers: ["Live turnout carried it."] }, inputs), /must name the check/);
  assert.throws(() => validateSynthesis({ ...ok, score: 44, drivers: ["Live turnout carried it."] }, inputs), /must name the check/, "v4: even a move of 4 must name the changed check");
  const twoLeft = { ...inputs, checkSetChange: { joined: [], left: ["audienceQuality", "conversion"], previousScore: 50 } };
  assert.throws(() => validateSynthesis(ok, twoLeft), /missing: subscribers/, "v4: every changed check is named, not just one");
  assert.throws(() => validateSynthesis({ ...ok, drivers: ["The audience quality check left after 2 quiet days."] }, inputs), /no numbers/, "v4: drivers carry no digits");
  const reachLeft = { ...inputs, checkSetChange: { joined: [], left: ["reachEfficiency"], previousScore: 50 } };
  assert.throws(() => validateSynthesis({ ...ok, drivers: ["The show reached fewer people this week."] }, reachLeft), /missing: reach/, "v4: 'reached' does not satisfy naming 'reach' — whole words only");
  assert.doesNotThrow(() => validateSynthesis({ ...ok, drivers: ["The reach check left the score, not the show changing."] }, reachLeft), "v4: the exact name satisfies the rule");
  assert.throws(() => validateSynthesis(ok, { ...inputs, checkSetChange: { joined: ["futureCheck"], left: [], previousScore: 50 } }), /missing: futureCheck/, "v4: an unlabeled check key still must be named (raw key)");
  assert.doesNotThrow(() => validateSynthesis({ ...ok, score: 44, drivers: ["Live turnout carried it."] }, { ...inputs, promptVersion: 3 }), "v3 entries keep the old rule: a move of 4 needs no naming");
  assert.doesNotThrow(() => validateSynthesis(ok, { ...twoLeft, promptVersion: 3, checkSetChange: { ...twoLeft.checkSetChange, previousScore: 40 } }), "v3 entries need only one changed check named");
}

console.log("baselines.test: ok");

// --- PRD v10: direction, launch read, live rates, cool-off, carried weights ---
{
  // Theil–Sen on episode number: a clean 10%/episode series reads 10 (rounded), gap-aware
  const series = [1, 2, 3, 5, 6].map((ep) => ({ ep, value: 1000 * 1.1 ** (ep - 1) }));
  assert.equal(B.theilSenPctPerEpisode(series), 10);
  // one odd episode does not move the median slope
  assert.equal(B.theilSenPctPerEpisode([...series, { ep: 4, value: 9000 }]), 10);
  // fewer than MIN_PEERS points → null; zero or negative values are ignored
  assert.equal(B.theilSenPctPerEpisode(series.slice(0, 2)), null);
  assert.equal(B.theilSenPctPerEpisode([{ ep: 1, value: 0 }, { ep: 2, value: 5 }, { ep: 3, value: 6 }]), null);
  // the quiet zone is the only gate between words
  assert.equal(B.directionOf(B.QUIET_ZONE_PCT + 0.1), B.DIRECTION_WORDS.building);
  assert.equal(B.directionOf(-B.QUIET_ZONE_PCT - 0.1), B.DIRECTION_WORDS.softening);
  assert.equal(B.directionOf(B.QUIET_ZONE_PCT), B.DIRECTION_WORDS.holding);
  assert.equal(B.directionOf(null), null);
  // trendFor keeps the last TREND_N valued episodes, in air order, gap-aware,
  // stamps its basis and note, and withholds the word under TREND_MIN_WORD
  const growthTrend = B.trendFor("watch", eps, (e) => (e.partialHistory ? null : B.ytViewsOf(B.snapshotAt(e, 7))), { basis: "sameAge", check: "growth" });
  assert.equal(growthTrend.n, B.TREND_N);
  assert.equal(growthTrend.direction, B.DIRECTION_WORDS.building);
  assert.equal(growthTrend.ageBasis, "sameAge");
  assert.equal(growthTrend.note, B.NOTES.sameAge);
  assert.ok(growthTrend.points.every((p, i, all) => i === 0 || p.ep > all[i - 1].ep));
  const three = B.trendFor("t", eps.slice(0, 3), (e) => B.ytViewsOf(B.snapshotAt(e, 7)), { basis: "ageFree" });
  assert.equal(three.n, 3);
  assert.ok(three.pctPerEpisode != null, "three points show a slope");
  assert.equal(three.direction, null, "but no word");
  assert.equal(three.reason, B.NOTES.fewForWord);
  // one episode can be the slope at three points: a doubled first week flips the sign
  const flipped = B.theilSenPctPerEpisode([{ ep: 1, value: 2000 }, { ep: 2, value: 1100 }, { ep: 3, value: 1210 }]);
  assert.ok(flipped < 0 && B.theilSenPctPerEpisode([{ ep: 1, value: 1000 }, { ep: 2, value: 1100 }, { ep: 3, value: 1210 }]) > 0);
  // one vote per check; a single word only when every vote agrees
  const mk = (check, direction) => ({ check, direction });
  assert.deepEqual(B.checkVotes([mk("livePull", "building"), mk("livePull", "building"), mk("participation", "softening")]).map((v) => v.direction), ["building", "softening"]);
  assert.equal(B.overallDirection([mk("livePull", "building"), mk("livePull", "building"), mk("participation", "softening")]), "mixed", "two chat votes cannot outvote a check");
  assert.equal(B.overallDirection([mk("livePull", "building"), mk("growth", "building")]), "building");
  assert.equal(B.overallDirection([mk("livePull", "holding"), mk("growth", "holding")]), "holding");
  assert.equal(B.overallDirection([mk("a", "building"), mk("b", "softening")]), "mixed");
  assert.equal(B.overallDirection([mk("a", null)]), null);
  // the served lenses: every known series present, votes and overall re-derive
  const flagsAll = B.anomalyFlags(eps);
  const weekOf = (e) => (e.slug === "e09" ? null : B.ytViewsOf(B.snapshotAt(e, B.LAUNCH_AGE)));
  const lens = B.computeDirection(eps, flagsAll, { weekValueOf: weekOf });
  assert.deepEqual(lens.measures.map((m) => m.key), B.TREND_MEASURES.map((m) => m.key));
  assert.equal(lens.overall, B.overallDirection(lens.measures));
  assert.deepEqual(lens.votes, B.checkVotes(lens.measures));
  // the promo episode is flagged on X units: out of the reach family, still in the views family
  assert.ok(!lens.measures.filter((m) => ["exposureWeekOne", "announceToPlay"].includes(m.key)).some((m) => m.points.some((p) => p.slug === "e05")), "an X-flagged episode is in no reach series");
  assert.ok(lens.measures.find((m) => m.key === "firstWeek").points.some((p) => p.slug === "e05") || eps.indexOf(eps.find((e) => e.slug === "e05")) < eps.length - B.TREND_N, "an X-flagged episode keeps its place in a views series");
  // peersFor: the episode-level rule by default, a unit family when asked
  const e12 = eps.find((e) => e.slug === "e12");
  const e12peers = B.peersFor({ own: e12, window: B.windowFor(e12, eps), flags: flagsAll, valueOf: (p) => B.ytViewsOf(B.snapshotAt(p, 7)) });
  const e12viewPeers = B.peersFor({ own: e12, window: B.windowFor(e12, eps), flags: flagsAll, units: B.UNIT_FAMILIES.views, valueOf: (p) => B.ytViewsOf(B.snapshotAt(p, 7)) });
  assert.ok(e12peers.excluded.some((x) => x.slug === "e05" && x.why === "promo outlier"), "episode-level: the promo episode is excluded");
  assert.ok(e12viewPeers.peers.some((p) => p.slug === "e05"), "views family: an X-only flag does not exclude");
  assert.equal(B.flaggedOn(flagsAll, "e05", B.UNIT_FAMILIES.live), false);
  const withNewsletter = eps.map((e) => e.slug === "e06"
    ? { ...e, promotion: { status: "found", source: "UX Tools", matchedUnits: ["ytViews"] } }
    : e);
  const newsletterFlags = B.anomalyFlags(withNewsletter);
  assert.equal(newsletterFlags.get("e06").knownPromotion, true);
  assert.equal(newsletterFlags.get("e06").units.ytViews.source, "newsletter");
  assert.equal(B.flaggedOn(newsletterFlags, "e06", B.UNIT_FAMILIES.views), true);
  assert.equal(B.flaggedOn(newsletterFlags, "e06", B.UNIT_FAMILIES.reach), false, "a YouTube newsletter link must not taint X reach");
  const newsletterPeers = B.peersFor({ own: withNewsletter.at(-1), window: B.windowFor(withNewsletter.at(-1), withNewsletter), flags: newsletterFlags, units: B.UNIT_FAMILIES.views, valueOf: (p) => B.ytViewsOf(B.snapshotAt(p, 7)) });
  assert.ok(newsletterPeers.excluded.some((x) => x.slug === "e06" && x.why === "known newsletter promotion"));
  assert.ok(!B.typicalCurve(withNewsletter, newsletterFlags).window.includes("e06"), "a known YouTube promotion is excluded from the watch curve");
  const outlook = B.computeOutlook(eps, flagsAll, lens);
  assert.equal(lens.measures.find((m) => m.key === "firstWeek").direction, B.DIRECTION_WORDS.building);
  assert.equal(outlook.nextFirstWeek.n, 3);
  assert.ok(outlook.nextFirstWeek.low <= outlook.nextFirstWeek.typical && outlook.nextFirstWeek.typical <= outlook.nextFirstWeek.high);
}
{
  // launch read: a fixed age, either-side peers, outliers out, MIN_PEERS or nothing
  const flags = B.anomalyFlags(eps);
  const e12 = eps.find((e) => e.slug === "e12");
  const launch12 = B.launchReadFor(e12, eps, flags);
  assert.equal(launch12.ageDays, B.LAUNCH_AGE);
  assert.equal(launch12.word, B.LAUNCH_WORDS.strong); // the largest episode of a growing run
  assert.equal(launch12.promoDriven, false);
  // the launch read is a views-family comparison: the fixture's promo episode
  // is flagged on X units only, so it stays a peer (a view-flagged one would not)
  assert.ok(launch12.peers.includes("e05"), "an X-only flag does not exclude a views peer");
  const viewFlagged = new Map(flags);
  viewFlagged.set("e05", { ...flags.get("e05"), units: { ...flags.get("e05").units, ytViews: { ...flags.get("e05").units.ytViews, flag: true } } });
  const launch12v = B.launchReadFor(e12, eps, viewFlagged);
  assert.ok(!launch12v.peers.includes("e05") && launch12v.excluded.some((x) => x.slug === "e05" && x.why === "promo outlier"), "a view-flagged episode is excluded");
  const launch01 = B.launchReadFor(eps.find((e) => e.slug === "e01"), eps, flags);
  assert.equal(launch01.word, B.LAUNCH_WORDS.soft); // the smallest episode of a growing run
  // a late-tracked episode reads at its earliest reading's age, capped at READ_DAYS
  const late = eps.find((e) => e.slug === "e09"); // first tracked on day 12
  const launchLate = B.launchReadFor(late, eps, flags);
  assert.ok(launchLate.late && launchLate.ageDays > B.LAUNCH_AGE && launchLate.ageDays <= B.READ_DAYS);
  // the promo episode's own launch word carries the qualifier
  const launchPromo = B.launchReadFor(eps.find((e) => e.slug === "e05"), eps, flags);
  assert.equal(launchPromo.promoDriven, flags.get("e05").units.ytViews.flag === true);
  // a lone episode has no peers → no word, a reason
  assert.equal(B.launchReadFor(e12, [e12], new Map()).word, null);
}
{
  // live rates normalize for show length and peak
  assert.deepEqual(B.liveRatesOf({ live: { peak: 80, chatters: 40, chatMessages: 120, durationMin: 90 } }), { chattersPer100: 50, messagesPerHour: 80 });
  assert.equal(B.liveRatesOf({ live: { peak: 0 } }), null);
  assert.equal(B.liveRatesOf({}), null);
}
{
  // cool-off: the newest's two-day growth against peers at the same age
  const flags = B.anomalyFlags(eps);
  const newest = eps.find((e) => e.slug === "e12");
  const cool = B.coolOffFor(newest, eps, flags);
  assert.equal(cool.span, B.COOL_SPAN_DAYS);
  assert.ok(cool.value > 1 && cool.typical > 1);
  assert.equal(cool.word, B.COOL_WORDS.usual); // every synthetic curve shares one shape
  assert.ok(cool.peers.includes("e05"), "cool-off is a views comparison: an X-only flag keeps the peer");
  const coolViewFlagged = B.coolOffFor(newest, eps, (() => { const m = new Map(flags); m.set("e05", { ...flags.get("e05"), units: { ...flags.get("e05").units, ytViews: { ...flags.get("e05").units.ytViews, flag: true } } }); return m; })());
  assert.ok(!coolViewFlagged.peers.includes("e05") && coolViewFlagged.excluded.some((x) => x.slug === "e05" && x.why === "promo outlier"));
  // a promo tail (a flagged YouTube unit) gets no cool-off word, only the
  // qualifier; the fixture's promo episode is flagged on X units, so its
  // YouTube cool-off still reads — the stamp follows the unit flag exactly
  const e05 = eps.find((e) => e.slug === "e05");
  const promoCool = B.coolOffFor(e05, eps, flags);
  assert.equal(promoCool.promoDriven, flags.get("e05").units.ytViews.flag === true);
  if (promoCool.promoDriven) { assert.equal(promoCool.word, null); assert.equal(promoCool.reason, B.NOTES.promoQualified); }
  else assert.ok(promoCool.word);
  const forced = new Map(flags);
  forced.set("e05", { ...flags.get("e05"), units: { ...flags.get("e05").units, ytViews: { ...flags.get("e05").units.ytViews, flag: true } } });
  const promoForced = B.coolOffFor(e05, eps, forced);
  assert.equal(promoForced.promoDriven, true);
  assert.equal(promoForced.word, null);
  assert.equal(promoForced.reason, B.NOTES.promoQualified);
}
{
  // carried measures count half inside a check; an all-carried check counts half in the mean
  const fresh = { score: 60, carried: false };
  const carried = { score: 20, carried: true };
  assert.deepEqual(checkScoreOf({ a: fresh, b: carried }), { score: Math.round((60 + 20 * B.CARRIED_WEIGHT) / (1 + B.CARRIED_WEIGHT)), carried: false });
  assert.deepEqual(checkScoreOf({ a: carried }), { score: 20, carried: true });
  assert.deepEqual(checkScoreOf({ a: { score: null } }), { score: null, carried: false });
  const parts = {
    x: { score: 80, baseWeight: 0.5, absoluteScale: false, carried: false },
    y: { score: 20, baseWeight: 0.5, absoluteScale: false, carried: true },
  };
  const { weightedMean, effectiveWeightOf } = deterministicMean(parts);
  // x carries 0.5, y carries 0.25 → x gets two thirds of the weight
  assert.equal(Math.round(effectiveWeightOf(parts.x) * 1000) / 1000, 0.667);
  assert.equal(Math.round(effectiveWeightOf(parts.y) * 1000) / 1000, 0.333);
  assert.equal(weightedMean, 60);
  // an absolute-scale check keeps its base weight even beside a carried one
  const withAbs = { ...parts, z: { score: 100, baseWeight: 0.2, absoluteScale: true, carried: false } };
  assert.equal(deterministicMean(withAbs).effectiveWeightOf(withAbs.z), 0.2);
}
// --- PRD v10 addendum, rule 23: swing-fitted bands, live depth, discovery share ---
{
  // swing: median absolute deviation of the peers from their typical, as a whole percent
  assert.equal(B.swingOf([80, 100, 120, 90], 100), 15);      // deviations 20, 0, 20, 10 → median 15
  assert.equal(B.swingOf([50, 100, 150], 100), 50);          // a wild measure
  assert.equal(B.swingOf([100, 100], 100), null);            // fewer than MIN_PEERS
  assert.equal(B.swingOf([100, 100, 100], 0), null);         // no typical
  // bands: half the swing in score points, clamped to the fixed bands and ±15
  assert.deepEqual(B.bandsFor(null), { healthy: 55, steady: 45 });   // no swing → the fixed bands
  assert.deepEqual(B.bandsFor(4), { healthy: 55, steady: 45 });      // never narrower than ±10 %
  assert.deepEqual(B.bandsFor(20), { healthy: 60, steady: 40 });
  assert.deepEqual(B.bandsFor(80), { healthy: 65, steady: 35 });     // never wider than ±30 %
  // state follows the bands: a 40 is fragile on a quiet measure, steady on a noisy one
  assert.equal(B.stateOf(40), "fragile");
  assert.equal(B.stateOf(40, B.bandsFor(30)), "steady");
  assert.equal(B.stateOf(64, B.bandsFor(30)), "steady");
  assert.equal(B.stateOf(65, B.bandsFor(30)), "healthy");
  assert.equal(B.stateOf(null), "waiting");
  // a check's swing is the median of its scored measures' swings; unscored and absolute ones are out
  const chk = checkBandsOf({
    a: { score: 60, swing: 10 }, b: { score: 40, swing: 30 }, c: { score: 55, swing: 20 },
    d: { score: null, swing: 90 }, e: { score: 70, swing: null, absoluteScale: true },
  });
  assert.deepEqual(chk, { swing: 20, bands: { healthy: 60, steady: 40 } });
  // live depth: minutes per viewer and the hold rate over the last ten minutes
  const series = Array.from({ length: 30 }, (_, i) => ({ v: i < 20 ? 60 : 30 }));
  const ep = { live: { peak: 60, avg: 50, liveViews: 500, watchedMin: 4000, series } };
  assert.deepEqual(B.liveDepthOf(ep), { minutesPerViewer: 8, holdRate: 50 });
  assert.deepEqual(B.liveDepthOf({ live: { peak: 60, avg: 50, series: series.slice(0, 5) } }), { minutesPerViewer: null, holdRate: null });
  assert.equal(B.liveDepthOf({ live: { peak: 0 } }), null);
  // discovery share: search + suggested (+ Shorts, browse) over all views, blended across channels
  const channels = {
    a: { totals: { views: 1000 }, trafficSources: [{ insightTrafficSourceType: "SUBSCRIBER", views: 800 }, { insightTrafficSourceType: "YT_SEARCH", views: 100 }, { insightTrafficSourceType: "RELATED_VIDEO", views: 100 }] },
    b: { totals: { views: 500 }, trafficSources: [{ insightTrafficSourceType: "EXT_URL", views: 450 }, { insightTrafficSourceType: "SHORTS", views: 50 }] },
  };
  assert.equal(B.discoveryShareOf(channels), Math.round((250 / 1500) * 1000) / 10);
  assert.equal(B.discoveryShareOf({ a: { totals: { views: 1000 } } }), null);   // no traffic sources → no reading (history lines)
  assert.equal(B.discoveryShareOf({
    a: { totals: { views: 1000 }, trafficSources: [{ insightTrafficSourceType: "YT_SEARCH", views: 100 }] },
    b: { totals: { views: 500 }, trafficSources: [] },
  }), null); // one missing channel report cannot become a partial or false-zero reading
  // the direction lens carries the five new series, in check order
  assert.deepEqual(B.TREND_MEASURES.filter((m) => ["liveViewers", "minutesWatched", "minutesPerViewer", "holdRate", "discoveryShare"].includes(m.key)).map((m) => m.check),
    ["reachEfficiency", "livePull", "livePull", "participation", "participation"]);
}

// --- chain heal: the health store merges by day; a same-day re-derivation keeps the older read under superseded ---
{
  const v3 = (date, score) => ({ date, score, formulaVersion: "health-v3", createdAt: `${date}T14:00:00Z` });
  const v4 = (date, score) => ({ date, score, formulaVersion: "health-v4", createdAt: `${date}T21:00:00Z` });
  const ours = { version: 3, updatedAt: "2026-09-01T21:00:00Z", entries: [v3("2026-08-31", 46), { ...v4("2026-09-01", 48), rederivedFrom: { formulaVersion: "health-v3", score: 46 } }], superseded: [{ supersededOn: "2026-09-01", by: "health-v4", entry: v3("2026-09-01", 46) }] };
  const theirs = { version: 3, updatedAt: "2026-09-02T14:00:00Z", entries: [v3("2026-08-31", 46), v3("2026-09-01", 46), v3("2026-09-02", 47)] };
  const merged = mergeHealthStores(ours, theirs);
  assert.deepEqual(merged.entries.map((e) => `${e.date}:${e.formulaVersion}:${e.score}`), ["2026-08-31:health-v3:46", "2026-09-01:health-v4:48", "2026-09-02:health-v3:47"]);
  assert.equal(merged.superseded.length, 1);
  assert.equal(merged.updatedAt, "2026-09-02T14:00:00Z");
  // the other way round (theirs newer) lands in the same place, and the union is idempotent
  const back = mergeHealthStores(theirs, ours);
  assert.deepEqual(back.entries.map((e) => `${e.date}:${e.formulaVersion}`), merged.entries.map((e) => `${e.date}:${e.formulaVersion}`));
  assert.deepEqual(mergeHealthStores(merged, merged).entries, merged.entries);
}
console.log("baselines.test: PRD v10 direction, launch, live rates, cool-off, carried weights, swing bands, live depth, discovery, and store merge pass");
