#!/usr/bin/env node
// health-verify.mjs — the standing critic loop for show health (PRD v10 W33).
//
// Every read the health store publishes makes claims a later day can check:
// the direction each measure is moving, the range the next first week should
// land in, and the launch word given to an episode under a week old. This
// script keeps an append-only ledger of those claims, scores
// each one the day reality arrives, and reports four things about the formula:
//
//   ACCURACY   today's entry re-derived from what it stored (checks, weights,
//              direction slopes, outlook range) and its words checked against
//              its own numbers (a "fragile" headline needs a check under 45;
//              a pro must not cite a promo-qualified lift as strength)
//   LONGEVITY  how the formula itself is ageing: checks absent for long
//              stretches, reads carried from older episodes, promo-qualified
//              measures, check-set churn, days the model step produced no
//              entry, formula version churn, direction measures still thin
//   USEFULNESS hit rates from the ledger — first-week ranges that held,
//              direction words the next episode confirmed, provisional launch
//              words that held at day seven — and agreement with the owners'
//              own "feel" notes (health-feedback.jsonl, written by
//              health-feedback.mjs)
//   OPEN       the claims still waiting for reality
//
// Deterministic: no model, no network. It reads the stores build-data reads
// plus the health store and the feedback file, appends only new claims and
// resolutions to data/restream/health-verify.json (never rewrites a resolved
// row), and rewrites tools/dive-analytics/audit/HEALTH-VERIFY.md. It never
// blocks publish: findings are WARN lines and the report. Run after health.mjs
// and build-data (chain step "health-verify"); `--dry` prints without writing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as BL from "./baselines.mjs";
import { CHECK_LABELS, WEIGHTS_BY_FORMULA, checkScoreOf, deterministicMean } from "./health.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const HEALTH_PATH = join(ROOT, "data", "restream", "health-history.json");
const LEDGER_PATH = join(ROOT, "data", "restream", "health-verify.json");
const FEEDBACK_PATH = join(ROOT, "data", "restream", "health-feedback.jsonl");
const REPORT_PATH = join(HERE, "audit", "HEALTH-VERIFY.md");
export const LEDGER_VERSION = 1;
const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
// longevity thresholds — days, shares, counts; one place
export const LIMITS = Object.freeze({
  absentDays: 21,        // a check absent this long in a row is starving, not waiting
  carriedShare: 0.5,     // more than half the scored checks carried = the read is mostly last episode's
  churnPer30: 3,         // steady-state check-set changes in 30 days (launch-week joins excluded)
  missingDays: 3,        // model days with a data build and no entry, in 30 days
  thinDirection: 3,      // a direction measure still at MIN_PEERS points after this many entries
  feelScorePoints: 5,    // a score move this large counts as "the read said better/worse"
});
const cell = (t) => String(t ?? "").replace(/\|/g, "/").replace(/\s+/g, " ");

const phoenixDate = (ms) => new Date(ms - PHX_OFFSET).toISOString().slice(0, 10);
const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
function saveAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
const num = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "–");
const pct = (n) => (Number.isFinite(n) ? `${n > 0 ? "+" : ""}${Math.round(n * 10) / 10}%` : "–");
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

// --- accuracy: the latest entry against itself and its stores ---------------
export function checkAccuracy(entry, data) {
  const findings = [];
  const note = (severity, text) => findings.push({ severity, text });
  if (!entry) { note("warn", "No saved health entry to verify."); return findings; }
  const v4 = Number(String(entry.formulaVersion || "").replace(/\D/g, "")) >= 4;
  // checks and weights re-derive from what the entry stored
  for (const [key, part] of Object.entries(entry.subScores || {})) {
    const expected = v4 ? checkScoreOf(part.measures || {}).score
      : (() => { const s = Object.values(part.measures || {}).map((m) => m.score).filter(Number.isFinite); return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null; })();
    if (part.score !== expected) note("fail", `${CHECK_LABELS[key] || key}: stored score ${part.score} does not re-derive from its measures (${expected}).`);
    for (const m of Object.values(part.measures || {})) {
      if (m.score != null && m.typical != null && !m.absoluteScale) {
        // v4 entries store the comparison at three decimals; older entries
        // only the rounded value, which can land a point off — tolerate one
        const again = Number.isFinite(m.ratio) ? Math.round(Math.min(100, Math.max(0, 50 * m.ratio))) : Math.round(Math.min(100, Math.max(0, (50 * m.value) / m.typical)));
        const slack = Number.isFinite(m.ratio) ? 0 : 1;
        if (Math.abs(again - m.score) > slack) note("fail", `${CHECK_LABELS[key] || key}.${m.id}: ${m.value} against ${m.typical} should score ${again}, stored ${m.score}.`);
      }
      if (m.typical != null && (m.window || []).length < BL.MIN_PEERS) note("fail", `${CHECK_LABELS[key] || key}.${m.id}: a typical from ${(m.window || []).length} peers.`);
    }
  }
  const { weightedMean } = deterministicMean(entry.subScores || {});
  if (weightedMean !== entry.weightedMean) note("fail", `Weighted mean ${entry.weightedMean} does not re-derive (${weightedMean}).`);
  if (Math.abs(entry.score - entry.weightedMean) > 8) note("fail", `Model score ${entry.score} is more than eight from the mean ${entry.weightedMean}.`);
  // direction slopes re-derive from their stored points
  for (const t of entry.direction?.measures || []) {
    const again = BL.theilSenPctPerEpisode(t.points || []);
    if ((again ?? null) !== (t.pctPerEpisode ?? null)) note("fail", `Direction ${t.key}: stored ${t.pctPerEpisode}% per episode, re-derived ${again}.`);
  }
  if (entry.direction && BL.overallDirection(entry.direction.measures) !== entry.direction.overall) note("fail", "Overall direction does not follow its measures.");
  // the outlook range is the last three clean first weeks
  const nfw = entry.outlook?.nextFirstWeek;
  if (nfw?.low != null) {
    const rows = (data?.showTrend?.week1VelocityByEpisode || []).filter((r) => Number.isFinite(r.value)).slice(-3);
    const low = Math.min(...rows.map((r) => r.value)), high = Math.max(...rows.map((r) => r.value));
    if (rows.length >= BL.MIN_PEERS && (low !== nfw.low || high !== nfw.high) && entry.date === phoenixDate(Date.parse(data.generatedAt))) {
      note("warn", `Outlook range ${num(nfw.low)}–${num(nfw.high)} differs from today's clean first weeks ${num(low)}–${num(high)}.`);
    }
  }
  // words against numbers: the headline's strength words need a check to back them
  const scores = Object.values(entry.subScores || {}).map((p) => p.score).filter(Number.isFinite);
  const head = String(entry.headline || "").toLowerCase();
  if (/\b(fragile|weak|slipping|falling)\b/.test(head) && !scores.some((s) => s < BL.BANDS.steady)) note("warn", `Headline says fragile/weak but no check scores under ${BL.BANDS.steady}: "${entry.headline}"`);
  if (/\b(healthy|strong|thriving)\b/.test(head) && !scores.some((s) => s >= BL.BANDS.healthy)) note("warn", `Headline says healthy/strong but no check scores ${BL.BANDS.healthy} or more: "${entry.headline}"`);
  const overall = entry.direction?.overall;
  for (const word of ["building", "softening"]) {
    if (head.includes(word) && overall && overall !== word && !(entry.direction?.measures || []).some((m) => m.direction === word)) {
      note("warn", `Headline says "${word}" but no measure and not the overall direction (${overall}) says so.`);
    }
  }
  // a pro must never dress a promo-qualified lift as strength
  const promoFacts = new Set((entry.facts || []).filter((f) => f.requiredPhrase === "promo").map((f) => f.id));
  for (const pro of entry.pros || []) if (promoFacts.has(pro.factId)) note("warn", `A "helping" bullet cites the promo-qualified fact ${pro.factId}: "${pro.text}"`);
  // facts with a live source re-derive from data.json (spot checks on air-night numbers)
  const newest = entry.asOf?.newest ? (data?.episodes || []).find((e) => e.slug === entry.asOf.newest) : null;
  const factValue = (id) => (entry.facts || []).find((f) => f.id === id)?.value;
  if (newest?.live) {
    if (factValue("latest-live-peak") != null && factValue("latest-live-peak") !== newest.live.peak) note("fail", `Fact latest-live-peak ${factValue("latest-live-peak")} differs from the store (${newest.live.peak}).`);
    if (factValue("latest-live-average") != null && factValue("latest-live-average") !== newest.live.avg) note("fail", `Fact latest-live-average ${factValue("latest-live-average")} differs from the store (${newest.live.avg}).`);
  }
  return findings;
}

// --- the ledger: claims and their resolutions ---------------------------------
// One claim per THING predicted — never one per day. A range is one claim
// per next episode and range; a direction word one claim per series, last
// episode, and word; a launch word one claim per episode. A day that repeats
// yesterday's claim adds nothing, so the hit table counts predictions.
function claimsFrom(entry, data) {
  const claims = [];
  const episodes = data?.episodes || [];
  const newestEp = episodes.at(-1)?.ep ?? null;
  const nfw = data?.baselines?.outlook?.nextFirstWeek;
  if (entry && nfw?.low != null && Number.isFinite(newestEp)) {
    claims.push({ id: `range:after-E${newestEp}:${nfw.low}-${nfw.high}`, kind: "first-week-range", madeOn: entry.date, afterEp: newestEp, low: nfw.low, high: nfw.high, typical: nfw.typical, direction: nfw.direction ?? null, pctPerEpisode: nfw.pctPerEpisode ?? null });
  }
  for (const t of data?.baselines?.direction?.measures || []) {
    if (!entry || !t.direction || !t.points?.length) continue;
    const last = t.points.at(-1);
    claims.push({ id: `direction:${t.key}:E${last.ep}:${t.direction}`, kind: "direction", key: t.key, madeOn: entry.date, word: t.direction, pctPerEpisode: t.pctPerEpisode, lastEp: last.ep, lastValue: last.value });
  }
  // a provisional launch word is a claim only when it can fail: a promo-
  // driven word is a near-certain hit and would flatter the hit rate
  for (const e of episodes) {
    const launch = data?.baselines?.launch?.[e.slug];
    if (launch?.word && launch.provisional && !launch.promoDriven) {
      claims.push({ id: `launch:${e.slug}`, kind: "launch-word", madeOn: phoenixDate(Date.parse(data.generatedAt)), slug: e.slug, ageDays: launch.ageDays, word: launch.word, promoDriven: false });
    }
  }
  return claims;
}

function bandOf(score) {
  return score >= BL.BANDS.healthy ? "above" : score >= BL.BANDS.steady ? "near" : "below";
}

// Resolve open claims against what exists today. Each resolution is written
// once and never changed.
// Outcomes: hit (reality agreed), miss (reality disagreed), neutral (reality
// sat in the quiet zone, or outside a range on the side the slope pointed —
// neither for nor against), void (no clean test: the next episode was
// promo-driven, tracked late, or never entered the series).
function resolve(claim, { data, today }) {
  const episodes = data?.episodes || [];
  const lens = data?.baselines?.direction;
  if (claim.kind === "first-week-range") {
    if (!Number.isFinite(claim.afterEp)) return { on: today, outcome: "void", detail: "no episode number to wait for." };
    const next = episodes.find((e) => e.ep === claim.afterEp + 1);
    if (!next) return null;
    const row = (data.showTrend?.week1VelocityByEpisode || []).find((r) => r.slug === next.slug);
    if (!row) return null;
    if (row.note && /promo/.test(row.note)) return { on: today, outcome: "void", detail: `${next.slug}: promo-driven first week — not a clean test.` };
    if (row.note && /pending/.test(row.note)) return null;
    if (!Number.isFinite(row.value)) return row.note ? { on: today, outcome: "void", detail: `${next.slug}: ${row.note}.` } : null;
    if (row.value >= claim.low && row.value <= claim.high) return { on: today, outcome: "hit", actual: row.value, detail: `${next.slug}: first week ${num(row.value)} inside ${num(claim.low)}–${num(claim.high)}.` };
    const pointed = claim.direction === "softening" ? "below" : claim.direction === "building" ? "above" : null;
    const side = row.value < claim.low ? "below" : "above";
    return { on: today, outcome: pointed === side ? "neutral" : "miss", actual: row.value, detail: `${next.slug}: first week ${num(row.value)} ${side} ${num(claim.low)}–${num(claim.high)}${pointed === side ? " — on the side the slope pointed" : ""}.` };
  }
  if (claim.kind === "direction") {
    // the next episode's value for this series, read from today's served
    // lens (the same definition, never re-implemented here)
    const t = (lens?.measures || []).find((m) => m.key === claim.key);
    const point = (t?.points || []).find((p) => p.ep > claim.lastEp);
    if (!point) {
      // the next episode exists but will never enter the series: no clean test
      const next = episodes.find((e) => e.ep === claim.lastEp + 1);
      const flagged = next && data?.baselines?.anomaly?.[next.slug]?.flagged;
      if (next && (flagged || next.partialHistory) && (BL.currentAge(next) ?? 0) >= BL.MATURITY_DAYS.analytics) return { on: today, outcome: "void", detail: `${claim.key}: E${next.ep} is ${flagged ? "promo-driven" : "tracked late"} and never enters the series.` };
      return null;
    }
    if (point.ep !== claim.lastEp + 1) return { on: today, outcome: "void", detail: `${claim.key}: E${claim.lastEp + 1} never entered the series; the next reading is E${point.ep}.` };
    const realized = claim.lastValue > 0 ? ((point.value - claim.lastValue) / claim.lastValue) * 100 : null;
    if (!Number.isFinite(realized)) return null;
    const realizedWord = BL.directionOf(realized);
    const outcome = realizedWord === claim.word ? "hit" : (realizedWord === "holding" || claim.word === "holding") ? "neutral" : "miss";
    return { on: today, outcome, actual: point.value, realizedPct: Math.round(realized * 10) / 10, detail: `${claim.key}: E${point.ep} moved ${pct(realized)} (${realizedWord}) against the word ${claim.word}.` };
  }
  if (claim.kind === "launch-word") {
    const now = data?.baselines?.launch?.[claim.slug];
    const e = episodes.find((x) => x.slug === claim.slug);
    if (!now || !e) return null;
    if (now.provisional) return null;
    if (!now.word) return (BL.currentAge(e) ?? 0) >= BL.LAUNCH_AGE + 1 ? { on: today, outcome: "void", detail: `${claim.slug}: no launch word at day seven (${now.reason || "no reading"}).` } : null;
    if (now.promoDriven) return { on: today, outcome: "void", detail: `${claim.slug}: the launch became promo-driven — not a clean test.` };
    return { on: today, outcome: now.word === claim.word ? "hit" : "miss", actual: now.word, detail: `${claim.slug}: read ${claim.word} at day ${claim.ageDays}, ${now.word} at day ${now.ageDays}.` };
  }
  return null;
}

// --- owner feel vs the read (health-feedback.jsonl) -------------------------------
function readFeedback() {
  if (!existsSync(FEEDBACK_PATH)) return [];
  return readFileSync(FEEDBACK_PATH, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((r) => r && r.date && ["better", "same", "worse"].includes(r.feel));
}
// Two honest comparisons per note: the read's direction word (a slope over
// episodes) and the score's move since the previous saved read (points);
// a note agrees when either says the same thing.
function feelAgreement(feedback, entries) {
  const rows = [];
  for (const f of feedback) {
    const entry = entries.filter((e) => e.date <= f.date).at(-1);
    if (!entry) continue;
    const prev = entries.filter((e) => e.date < entry.date).at(-1);
    const moved = prev ? entry.score - prev.score : null;
    const dir = entry.direction?.overall ?? null;
    const byDirection = dir === "building" ? "better" : dir === "softening" ? "worse" : dir ? "same" : null;
    const byScore = moved == null ? null : moved > LIMITS.feelScorePoints ? "better" : moved < -LIMITS.feelScorePoints ? "worse" : "same";
    rows.push({ date: f.date, feel: f.feel, note: f.note || "", byDirection, byScore, agree: byDirection === f.feel || byScore === f.feel, score: entry.score, direction: dir });
  }
  return rows;
}

// --- longevity: how the formula itself is ageing ---------------------------------
export function longevity(entries, data) {
  const findings = [];
  const note = (severity, text) => findings.push({ severity, text });
  if (!entries.length) return { findings, stats: {} };
  const latest = entries.at(-1);
  const keys = Object.keys(WEIGHTS_BY_FORMULA[latest.formulaVersion] || {});
  const stats = { absentStreak: {}, carriedShare: null, qualified: [], churn30: 0, missing30: [], formulaChanges: 0, thin: [] };
  // absence streaks per check (consecutive latest entries with score null)
  for (const key of keys) {
    let streak = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].subScores?.[key] && entries[i].subScores[key].score == null) streak++; else break;
    }
    const days = streak ? daysBetween(entries[entries.length - streak].date, latest.date) + 1 : 0;
    stats.absentStreak[key] = days;
    if (days >= LIMITS.absentDays) note("warn", `${CHECK_LABELS[key] || key} has been absent for ${days} days — starving, not waiting (${latest.subScores[key]?.reason || "no reason stored"}).`);
  }
  const scored = keys.filter((k) => Number.isFinite(latest.subScores?.[k]?.score));
  const carried = scored.filter((k) => latest.subScores[k].carried);
  stats.carriedShare = scored.length ? Math.round((carried.length / scored.length) * 100) / 100 : null;
  if (stats.carriedShare != null && stats.carriedShare > LIMITS.carriedShare) note("warn", `${carried.length} of ${scored.length} scored checks are carried from an older episode — today's number is mostly last episode's.`);
  stats.qualified = latest.asOf?.qualified || [];
  // the size of the carried discount: the mean with every carried check at full weight
  if (carried.length) {
    const full = Object.fromEntries(Object.entries(latest.subScores).map(([k, p]) => [k, { ...p, carried: false }]));
    const alt = deterministicMean(full).weightedMean;
    stats.carriedFlipPoints = alt != null && latest.weightedMean != null ? Math.round((alt - latest.weightedMean) * 10) / 10 : null;
  }
  // check-set churn and missing days over the last 30
  const cutoff = phoenixDate(Date.parse(`${latest.date}T12:00:00Z`) - 30 * DAY);
  const recent = entries.filter((e) => e.date >= cutoff);
  for (let i = 1; i < recent.length; i++) {
    // a launch week's joins (same-age checks arriving as earlier episodes
    // reach the newest's age) are designed; only steady-state changes count
    const steady = recent[i].asOf && recent[i - 1].asOf && recent[i].asOf.newest === recent[i - 1].asOf.newest && recent[i - 1].asOf.ageDays >= BL.MATURITY_DAYS.xAnnounce;
    if ((!recent[i].asOf || steady) && JSON.stringify(recent[i].checkSet || []) !== JSON.stringify(recent[i - 1].checkSet || [])) stats.churn30++;
    if (recent[i].formulaVersion !== recent[i - 1].formulaVersion) stats.formulaChanges++;
    const gap = daysBetween(recent[i - 1].date, recent[i].date);
    for (let d = 1; d < gap; d++) stats.missing30.push(phoenixDate(Date.parse(`${recent[i - 1].date}T12:00:00Z`) + d * DAY));
  }
  if (stats.churn30 >= LIMITS.churnPer30) note("warn", `The check set changed ${stats.churn30} times in 30 days — the number keeps changing what it measures.`);
  if (stats.missing30.length >= LIMITS.missingDays) note("warn", `${stats.missing30.length} day(s) in the last 30 have no saved read (${stats.missing30.slice(-5).join(", ")}) — the model step failed or the chain did not run.`);
  if (stats.formulaChanges) note("info", `The scoring rules changed ${stats.formulaChanges} time(s) in the last 30 days; the daily trend restarts each time.`);
  // thin direction measures
  const v4Entries = entries.filter((e) => e.direction?.measures?.length);
  if (v4Entries.length >= LIMITS.thinDirection) {
    for (const t of latest.direction?.measures || []) {
      if (t.pctPerEpisode == null) stats.thin.push(`${t.key} (absent: ${t.reason || "no points"})`);
      else if (t.n <= BL.MIN_PEERS) stats.thin.push(`${t.key} (${t.n} episodes)`);
    }
    if (stats.thin.length) note("info", `Direction measures still thin: ${stats.thin.join("; ")}.`);
  }
  // the mature fallback should retire once same-age history has depth
  for (const [key, part] of Object.entries(latest.subScores || {})) {
    for (const m of Object.values(part.measures || {})) {
      if (m.ageBasis === "mature" && ["watching", "subscribers"].includes(m.id) && latest.date >= "2026-10-15") {
        note("info", `${CHECK_LABELS[key] || key}.${m.id} still compares episodes as they stand now; same-age history was expected to take over by mid-October.`);
      }
    }
  }
  return { findings, stats };
}

// --- report ----------------------------------------------------------------------
function tally(rows) {
  const out = { hit: 0, miss: 0, neutral: 0, void: 0 };
  for (const r of rows) if (r.resolution) out[r.resolution.outcome] = (out[r.resolution.outcome] || 0) + 1;
  return out;
}
function report({ today, entry, accuracy, ledger, longevityResult, feel }) {
  const lines = [];
  const p = (t = "") => lines.push(t);
  p(`# Show-health verification — ${today}`);
  p();
  p(`Standing critic loop (PRD v10 W33): today's read re-derived from what it stored, every claim it makes ledgered and scored when reality arrives, the formula's own ageing, and the owners' feel against the read. Deterministic; never blocks publish.`);
  p();
  p(`## Accuracy — the ${entry?.date ?? "(none)"} read`);
  p();
  if (entry) {
    const reads = entry.asOf?.newestTitle ? `; reads ${entry.asOf.newestTitle} at ${entry.asOf.ageDays} days` : " (a pre-v4 entry: no as-of block)";
    p(`Score ${entry.score} (weighted mean ${entry.weightedMean}, ${entry.formulaVersion}, prompt v${entry.promptVersion})${reads}${entry.asOf?.carried?.length ? `; carried: ${entry.asOf.carried.map((k) => CHECK_LABELS[k] || k).join(", ")}` : ""}${entry.asOf?.qualified?.length ? `; promo-qualified: ${entry.asOf.qualified.join(", ")}` : ""}.`);
    p();
  }
  if (!accuracy.length) p("- PASS — every check, weight, direction slope, and outlook range re-derives; the headline's words agree with the numbers; no pro cites a promo lift.");
  for (const f of accuracy) p(`- ${f.severity.toUpperCase()} — ${f.text}`);
  p();
  p("## Usefulness — claims against reality");
  p();
  const kinds = [["first-week-range", "Next first week inside the expected range"], ["direction", "Direction word confirmed by the next episode"], ["launch-word", "Provisional launch word held at day seven"]];
  p("| Claim | Hits | Misses | Neutral | Void | Open |");
  p("|---|---|---|---|---|---|");
  for (const [kind, label] of kinds) {
    const rows = ledger.claims.filter((c) => c.kind === kind);
    const t = tally(rows);
    p(`| ${label} | ${t.hit} | ${t.miss} | ${t.neutral || 0} | ${t.void} | ${rows.filter((r) => !r.resolution).length} |`);
  }
  p();
  const resolved = ledger.claims.filter((c) => c.resolution).sort((a, b) => b.resolution.on.localeCompare(a.resolution.on)).slice(0, 12);
  const t = { hit: 0, miss: 0, neutral: 0, void: 0 };
  for (const c of ledger.claims) if (c.resolution) t[c.resolution.outcome] = (t[c.resolution.outcome] || 0) + 1;
  if (resolved.length) {
    p("Most recent resolutions:");
    p();
    for (const c of resolved) p(`- ${c.resolution.on} · ${c.resolution.outcome.toUpperCase()} · ${cell(c.resolution.detail)}`);
    p();
  }
  p("### Owner feel against the read");
  p();
  if (!feel.length) p("No feel notes yet. Record one with `node tools/dive-analytics/health-feedback.mjs better|same|worse \"a few words\"` on any day; the loop compares each note with what the read said that day.");
  else {
    const agree = feel.filter((r) => r.agree).length;
    p(`${agree} of ${feel.length} notes agree with the read's direction or score move.`);
    p();
    p("| Day | Felt | By direction | By score move | Score | Note |");
    p("|---|---|---|---|---|---|");
    for (const r of feel.slice(-10)) p(`| ${r.date} | ${r.feel} | ${r.byDirection ?? "–"} | ${r.byScore ?? "–"} | ${r.score}${r.agree ? "" : " ✗"} | ${cell(r.note)} |`);
  }
  p();
  p("## Longevity — how the formula is ageing");
  p();
  const s = longevityResult.stats;
  if (Object.keys(s.absentStreak || {}).length) {
    p("| Check | Absent for (days) |");
    p("|---|---|");
    for (const [k, d] of Object.entries(s.absentStreak)) p(`| ${CHECK_LABELS[k] || k} | ${d} |`);
    p();
  }
  p(`Carried share of scored checks: ${s.carriedShare == null ? "–" : `${Math.round(s.carriedShare * 100)}%`}${s.carriedFlipPoints != null ? ` (at full weight the mean would move ${s.carriedFlipPoints > 0 ? "+" : ""}${s.carriedFlipPoints})` : ""} · promo-qualified measures: ${(s.qualified || []).length ? s.qualified.join(", ") : "none"} · steady-state check-set changes in 30 days: ${s.churn30 ?? 0} · days without a read in 30: ${(s.missing30 || []).length} · scoring-rule changes in 30 days: ${s.formulaChanges ?? 0}.`);
  p();
  if (!longevityResult.findings.length) p("- PASS — no check is starving, the read is not mostly carried, the check set is steady, and no read days are missing.");
  for (const f of longevityResult.findings) p(`- ${f.severity.toUpperCase()} — ${f.text}`);
  p();
  p("## Open claims");
  p();
  const open = ledger.claims.filter((c) => !c.resolution);
  if (!open.length) p("None.");
  for (const c of open.slice(-20)) {
    if (c.kind === "first-week-range") p(`- ${c.madeOn} · the last three clean first weeks ran ${num(c.low)}–${num(c.high)}${c.direction ? ` (${c.direction})` : ""} — waits for the episode after E${c.afterEp}.`);
    else if (c.kind === "direction") p(`- ${c.madeOn} · ${c.key} ${c.word} (${pct(c.pctPerEpisode)} per episode) — waits for the episode after E${c.lastEp}.`);
    else if (c.kind === "launch-word") p(`- ${c.madeOn} · ${c.slug}: ${c.word} launch at day ${c.ageDays}${c.promoDriven ? " (promo-driven)" : ""} — waits for day seven.`);
  }
  p();
  return lines.join("\n") + "\n";
}

export function run({ now = Date.now(), dry = false } = {}) {
  const data = readJson(DATA_PATH);
  if (!data) throw new Error("data.json is missing — run build-data first");
  const store = readJson(HEALTH_PATH, { entries: [] });
  const today = phoenixDate(Date.parse(data.generatedAt) || now);
  const entries = (store.entries || []).filter((e) => e.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const entry = entries.at(-1) || null;
  const ledger = readJson(LEDGER_PATH, { version: LEDGER_VERSION, updatedAt: null, claims: [] });
  if (ledger.version !== LEDGER_VERSION || !Array.isArray(ledger.claims)) throw new Error("health-verify.json has an unsupported schema");
  const known = new Set(ledger.claims.map((c) => c.id));
  let added = 0, resolvedNow = 0;
  for (const claim of claimsFrom(entry, data)) {
    if (known.has(claim.id)) continue;
    ledger.claims.push({ ...claim, resolution: null });
    known.add(claim.id);
    added++;
  }
  for (const claim of ledger.claims) {
    if (claim.resolution) continue;
    const resolution = resolve(claim, { data, today });
    if (resolution) { claim.resolution = resolution; resolvedNow++; }
  }
  const accuracy = checkAccuracy(entry, data);
  const longevityResult = longevity(entries, data);
  const feel = feelAgreement(readFeedback(), entries);
  const md = report({ today, entry, accuracy, ledger, longevityResult, feel });
  if (!dry) {
    ledger.updatedAt = new Date(now).toISOString();
    saveAtomic(LEDGER_PATH, ledger);
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, md);
  }
  return { today, added, resolvedNow, accuracy, longevity: longevityResult, feel, ledger, md };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dry = process.argv.includes("--dry");
  const out = run({ dry });
  for (const f of out.accuracy) console.log(`${f.severity === "fail" ? "FAIL" : f.severity === "warn" ? "WARN" : "info"} verify: ${f.text}`);
  for (const f of out.longevity.findings) console.log(`${f.severity === "warn" ? "WARN" : "info"} verify: ${f.text}`);
  const t = { hit: 0, miss: 0, neutral: 0, void: 0 };
  for (const c of out.ledger.claims) if (c.resolution) t[c.resolution.outcome] = (t[c.resolution.outcome] || 0) + 1;
  console.log(`health-verify: ${out.today} — ${out.added} new claim(s), ${out.resolvedNow} resolved today; ledger ${out.ledger.claims.length} claim(s): ${t.hit} hit, ${t.miss} miss, ${t.neutral} neutral, ${t.void} void; feel notes ${out.feel.length}${dry ? " (dry run — nothing written)" : ` — wrote ${REPORT_PATH.replace(ROOT + "/", "")}`}`);
}
