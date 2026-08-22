#!/usr/bin/env node
// validate.mjs — read-only validation gate for the Dive Radio analytics pipeline.
// No model calls, no network, no writes. Exit 0 = all checks pass, exit 1 = failure.
//
// Run:            node tools/dive-analytics/audit/validate.mjs
// Monday gate:    insert into restream-postlive-weekly payload between build and
//                 report:  ... && node tools/dive-analytics/audit/validate.mjs && ...
//                 A failure then blocks the Slack trends report instead of shipping
//                 numbers that fail unit/freshness/consistency checks.
//
// Checks:
//   1. unit sanity        — no X impressions stored in plays fields (plays===views
//                           heuristic), no plays on YT destinations, plays never 0
//                           (absence is the only legal "unavailable" marker)
//   2. monotonic views    — cumulative views never decrease per destination
//   3. late-reg flags     — partialHistory matches first-snapshot age (>5d) and
//                           gates week1Velocity to null
//   4. freshness          — newest snapshot and generatedAt both < 26h old,
//                           build not older than newest snapshot
//   5. roster consistency — registry active dive-radio shows == data.json episodes,
//                           ep numbers sequential in premiere order
//   6. publish integrity  — public repo data.json/data.js byte-match the source
//   7. rebuild currency   — computeAll() over current history reproduces data.json
//                           (catches "snapshot ran but build/publish didn't")
//   Warnings (non-fatal): unresolved broadcast latches, resolved-broadcast targets
//   missing plays in the latest snapshot, snapshot gaps > 26h in the last 7 days.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // tools/dive-analytics/audit
const TOOL = join(HERE, "..");
const ROOT = join(TOOL, "..", "..");
const REGISTRY = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY = join(ROOT, "data", "restream", "postlive");
const DAY = 86400000;
const FRESH_MS = 26 * 3600000;
const PARTIAL_DAYS = 5; // must match PARTIAL_THRESHOLD_DAYS in build-data.mjs

let failures = 0;
let warnings = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const warn = (m) => { warnings++; console.log(`WARN  ${m}`); };
const ok = (m) => console.log(`ok    ${m}`);

const data = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const eps = data.episodes;

function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + 7 * 3600000;
}

// --- 1. unit sanity ---
{
  let bad = 0;
  for (const e of eps) {
    for (const s of e.snapshots) {
      for (const [k, m] of Object.entries(s.byDest)) {
        if (k.startsWith("yt:") && m.plays != null) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays field on a YouTube destination`); }
        if (k.startsWith("x:") && m.plays != null) {
          if (m.plays === 0) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays recorded as 0 — unavailable must be absent, never zero`); }
          // conflation heuristic: broadcast plays exactly equal to post impressions
          if (m.plays > 100 && m.plays === m.views) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays === impressions (${m.plays}) — unit conflation`); }
        }
      }
    }
    if (e.latest.xPlays === 0) { bad++; fail(`${e.slug}: latest.xPlays is 0 — must be null when unavailable`); }
  }
  if (!bad) ok("unit sanity: no plays-on-YT, no zero plays, no plays==impressions conflation");
}

// --- 1b. unit separation + Total views definition (F-3/F-7 + CARD-RULING) ---
// Total views = ytTotal + xPlays (both video playback). xImpressions is
// exposure and must NEVER leak into any views total, under any field name.
{
  let bad = 0;
  for (const e of eps) {
    if ("total" in e.latest) { bad++; fail(`${e.slug}: latest.total exists — mixed impressions+views field must not ship`); }
    if (e.latest.ytTotal == null || e.latest.xImpressions == null) { bad++; fail(`${e.slug}: per-unit fields (ytTotal/xImpressions) missing`); }
    const info = e.latest.xPlaysInfo;
    if (info && info.value !== e.latest.xPlays) { bad++; fail(`${e.slug}: xPlays (${e.latest.xPlays}) != xPlaysInfo.value (${info.value})`); }
    // Total views: canonical definition, coverage-marker parity, no smuggled reach
    if (e.latest.totalViews == null) { bad++; fail(`${e.slug}: latest.totalViews missing`); }
    else {
      if (e.latest.totalViews !== e.latest.ytTotal + (e.latest.xPlays ?? 0)) { bad++; fail(`${e.slug}: totalViews (${e.latest.totalViews}) != ytTotal + xPlays (${e.latest.ytTotal} + ${e.latest.xPlays ?? 0}) — definition violated`); }
      if (
        e.latest.totalViews - e.latest.ytTotal === e.latest.xImpressions &&
        e.latest.xImpressions > 0 &&
        e.latest.xImpressions !== e.latest.xPlays
      ) { bad++; fail(`${e.slug}: totalViews appears to include xImpressions — impressions smuggled into the plays slot`); }
      const tvi = e.latest.totalViewsInfo;
      if (!tvi) { bad++; fail(`${e.slug}: totalViewsInfo missing — coverage markers cannot render`); }
      else if (info && (tvi.partial !== info.partial || tvi.stale !== info.stale)) { bad++; fail(`${e.slug}: totalViewsInfo partial/stale disagrees with xPlaysInfo — marker state dropped between build and render`); }
    }
  }
  for (const p of data.showTrend?.cumulativeAllEpisodes || []) {
    if ("total" in p) { bad++; fail(`showTrend.cumulativeAllEpisodes carries mixed-unit 'total' — must be per-unit (ytViews/xReach)`); }
    if ("totalViews" in p) { bad++; fail(`showTrend.cumulativeAllEpisodes carries 'totalViews' — plays have no history; a blended time series is fabricated`); }
    if (p.ytViews == null || p.xReach == null) { bad++; fail(`showTrend.cumulativeAllEpisodes entry missing per-unit fields`); }
  }
  if (!bad) ok("unit separation: totalViews = ytTotal + xPlays (marker parity held), no mixed or fabricated fields");
}

// --- 1c. playsStatus/high-water schema (F-4) ---
{
  let bad = 0;
  const LEGAL = new Set(["ok", "stale-high-water", "none", "unresolved"]);
  for (const show of registry.shows) {
    if (show.active === false) continue;
    const e = eps.find((x) => x.slug === show.slug);
    const latest = e ? e.snapshots[e.snapshots.length - 1] : null;
    for (const t of show.targets || []) {
      if (t.kind !== "x") continue;
      if (t.playsStatus != null && !LEGAL.has(t.playsStatus)) { bad++; fail(`${show.slug} x:${t.account}: illegal playsStatus "${t.playsStatus}"`); }
      if (t.playsHighWater && (typeof t.playsHighWater.value !== "number" || !t.playsHighWater.asOf)) { bad++; fail(`${show.slug} x:${t.account}: malformed playsHighWater`); }
      if (t.playsStatus === "ok" && latest && latest.byDest[`x:${t.account}`]?.plays == null) { bad++; fail(`${show.slug} x:${t.account}: playsStatus "ok" but latest snapshot has NO plays — silent absence`); }
      if (t.playsStatus === "stale-high-water" && !t.playsHighWater) { bad++; fail(`${show.slug} x:${t.account}: stale-high-water without a persisted high-water mark`); }
    }
  }
  if (!bad) ok("plays schema: playsStatus values legal, ok-status targets have plays, high-water marks well-formed");
}

// --- 2. monotonic cumulative views ---
{
  let bad = 0;
  for (const e of eps) {
    const last = {};
    for (const s of e.snapshots) {
      for (const [k, m] of Object.entries(s.byDest)) {
        if (last[k] != null && m.views < last[k]) {
          const drop = last[k] - m.views;
          if (drop > Math.max(50, last[k] * 0.02)) { bad++; fail(`${e.slug} ${k}: views dropped ${last[k]} -> ${m.views} at ${s.ts}`); }
          else warn(`${e.slug} ${k}: small views dip ${last[k]} -> ${m.views} at ${s.ts} (API jitter?)`);
        }
        last[k] = m.views;
      }
    }
  }
  if (!bad) ok("monotonic: cumulative views never materially decrease");
}

// --- 3. late-reg flags present and honored ---
{
  let bad = 0;
  for (const e of eps) {
    const firstTs = Date.parse(e.snapshots[0].ts);
    const expected = firstTs - premiereMs(e.premiere) > PARTIAL_DAYS * DAY;
    if (e.partialHistory !== expected) { bad++; fail(`${e.slug}: partialHistory=${e.partialHistory}, expected ${expected} (first snapshot ${e.snapshots[0].ts})`); }
    if (e.partialHistory && e.metrics.week1Velocity !== null) { bad++; fail(`${e.slug}: late-reg episode has week1Velocity=${e.metrics.week1Velocity} — must be excluded`); }
    if (e.partialHistory && !/partial/i.test(e.metrics.week1Note || "")) { bad++; fail(`${e.slug}: late-reg episode missing exclusion note`); }
  }
  if (!bad) ok("late-reg: partialHistory flags match snapshot history and gate velocity math");
}

// --- 4. freshness ---
{
  const newest = Math.max(...eps.filter((e) => e.active).map((e) => Date.parse(e.snapshots[e.snapshots.length - 1].ts)));
  const gen = Date.parse(data.generatedAt);
  const now = Date.now();
  if (now - newest > FRESH_MS) fail(`freshness: newest snapshot is ${((now - newest) / 3600000).toFixed(1)}h old (limit 26h)`);
  else ok(`freshness: newest snapshot ${((now - newest) / 3600000).toFixed(1)}h old`);
  if (now - gen > FRESH_MS) fail(`freshness: data.json generated ${((now - gen) / 3600000).toFixed(1)}h ago (limit 26h)`);
  else ok(`freshness: data.json generated ${((now - gen) / 3600000).toFixed(1)}h ago`);
  if (gen < newest - 60000) fail(`freshness: data.json (${data.generatedAt}) is OLDER than the newest snapshot — build did not run after last snapshot`);
}

// --- 5. roster consistency ---
{
  const expected = registry.shows.filter(
    (s) => s.active !== false && (/dive.?radio/i.test(s.title) || /dive-radio/.test(s.slug)) && existsSync(join(HISTORY, `${s.slug}.json`))
  );
  const expectedSlugs = new Set(expected.map((s) => s.slug));
  const gotSlugs = new Set(eps.map((e) => e.slug));
  let bad = 0;
  for (const s of expectedSlugs) if (!gotSlugs.has(s)) { bad++; fail(`roster: registry show ${s} missing from data.json`); }
  for (const s of gotSlugs) if (!expectedSlugs.has(s)) { bad++; fail(`roster: data.json episode ${s} not an active dive-radio registry show`); }
  const sorted = [...eps].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  sorted.forEach((e, i) => { if (e.ep !== i + 1) { bad++; fail(`roster: ${e.slug} has ep=${e.ep}, expected ${i + 1}`); } });
  if (!bad) ok(`roster: ${eps.length} episodes match registry (active dive-radio with history)`);
}

// --- 5b. episode tags schema (PRD v2 W3) ---
{
  const FORMATS = new Set(["topic", "interview", "call-in", "bts", "panel"]);
  let bad = 0, tagged = 0, unconfirmed = 0;
  for (const s of registry.shows) {
    if (s.active === false || !s.tags) continue;
    tagged++;
    if (s.tags.unconfirmed) unconfirmed++;
    if (!FORMATS.has(s.tags.format)) { bad++; fail(`${s.slug}: illegal tag format "${s.tags.format}"`); }
    if (!Array.isArray(s.tags.guests)) { bad++; fail(`${s.slug}: tags.guests must be an array`); }
    if (typeof s.tags.unconfirmed !== "boolean") { bad++; fail(`${s.slug}: tags.unconfirmed must be a boolean`); }
  }
  if (!bad) ok(`tags: ${tagged} episode(s) tagged, schema-legal (${unconfirmed} unconfirmed draft(s) — excluded from insights until blessed)`);
}

// --- 6. publish integrity (public repo copies match source of truth) ---
// The cron chain runs build && validate && publish: at validate time a fresh
// build legitimately puts the source AHEAD of the public repo, so that state
// is a WARN (publish about to catch up), never a FAIL — a hard fail here
// would deadlock the chain on every fresh build. The FAIL cases are the real
// corruptions: public repo AHEAD of source (a rollback/divergence) or a
// mismatch with no fresh-build explanation.
// Single-repo layout (2026-08-22 migration): source of truth and served site
// are the same directory, so there is no second copy to drift. What can still
// go wrong locally: data.js not rebuilt alongside data.json, or a missing
// artifact. Live-site parity is verified post-deploy by postlive-publish.sh
// (it curls the production data.json and compares generatedAt).
{
  let bad = 0;
  for (const f of ["data.json", "data.js", "index.html", "chart.umd.js"]) {
    if (!existsSync(join(ROOT, f))) { bad++; fail(`publish: ${join(ROOT, f)} missing from repo root`); }
  }
  const js = readFileSync(join(ROOT, "data.js"), "utf8");
  const expected = `window.DIVE_DATA = ${readFileSync(join(ROOT, "data.json"), "utf8").trimEnd()};\n`;
  if (js !== expected) { bad++; fail("publish: data.js does not wrap data.json byte-for-byte — artifacts out of sync (rerun build-data.mjs)"); }
  if (!bad) ok("publish: root artifacts present, data.js wraps data.json exactly");
}

// --- 7. rebuild currency (deterministic recompute reproduces committed data.json) ---
{
  try {
    const mod = await import(join(TOOL, "build-data.mjs"));
    const rebuilt = mod.computeAll({ now: Date.parse(data.generatedAt) });
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.generatedAt; return JSON.stringify(c); };
    if (strip(rebuilt) !== strip(data)) fail("rebuild: computeAll() over current history does NOT reproduce data.json — snapshots advanced without a rebuild, or build is non-deterministic");
    else ok("rebuild: computeAll() reproduces committed data.json exactly");
  } catch (err) {
    fail(`rebuild: computeAll threw — ${err.message}`);
  }
}

// --- 1d. featured comments sanity (comments-pull + attachComments) ---
{
  let bad = 0;
  const HOSTS = new Set(["@ridd_design", "@designertom", "ridd_design", "designertom"]);
  // negative-signal veto uses the same deterministic wordlist as the labels
  let negSignal = null;
  try { ({ hasNegativeSignal: negSignal } = await import(join(ROOT, "scripts", "restream", "comments-sentiment.mjs"))); }
  catch { warn("comments: sentiment module unavailable — negative-veto check skipped"); }
  let sentiStore = null;
  try { sentiStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-sentiment.json"), "utf8")); } catch { /* absent */ }
  const XCOV = new Set(["covered", "missed", null]);
  for (const e of eps) {
    if (!e.comments) continue;
    if (!XCOV.has(e.comments.xCoverage ?? null)) { bad++; fail(`${e.slug}: illegal xCoverage "${e.comments.xCoverage}"`); }
    const f = e.comments.featured || [];
    let raw = null;
    try { raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8")); } catch { /* checked in 1e */ }
    if (f.length > 3) { bad++; fail(`${e.slug}: ${f.length} featured comments — cap is 3`); }
    for (const q of f) {
      if (!q.author || !q.text) { bad++; fail(`${e.slug}: featured comment missing author/text`); }
      if (HOSTS.has((q.author || "").toLowerCase())) { bad++; fail(`${e.slug}: host account "${q.author}" in featured comments — hosts must be excluded`); }
      if ((q.text || "").length > 200) { bad++; fail(`${e.slug}: featured comment exceeds 200-char cap`); }
      if (/<script|javascript:/i.test(q.text || "")) { bad++; fail(`${e.slug}: featured comment contains active content — escape/render risk`); }
      if (negSignal && negSignal(q.text || "")) { bad++; fail(`${e.slug}: featured quote by "${q.author}" carries negative wording ("${(q.text || "").slice(0, 60)}…") — complaints must never be pull-quotes`); }
      // provenance: a featured quote must be a prefix of a stored comment (F-C8),
      // and — when the sentiment store has labels — that comment must be
      // classified positive (F-C1: no complaint may ever ship as praise)
      if (raw) {
        const src = (raw.comments || []).find((c) => c.author === q.author && c.text.startsWith(q.text.replace(/…$/, "")));
        if (!src) { bad++; fail(`${e.slug}: featured quote by "${q.author}" not found in the comments store — provenance broken`); }
        else if (sentiStore?.classified && Object.keys(sentiStore.classified).length) {
          const lbl = sentiStore.classified[src.id]?.label;
          if (lbl !== "positive") { bad++; fail(`${e.slug}: featured quote by "${q.author}" is classified "${lbl ?? "unclassified"}" — only sentiment-positive comments may be featured`); }
        }
      }
    }
  }
  if (!bad) ok("comments: featured quotes capped, host-free, length-bounded, inert, provenance-checked, sentiment-positive");
}

// --- 1e. comment sentiment (counts match the persisted store; shipped text inert) ---
// Sentiment labels live in data/restream/comments-sentiment.json (per comment
// id, incremental, explicit reclassification only). data.json must agree with
// a recompute from raw comments + store, so a count can never drift from its
// classifications. Absence ≠ zero: unlabeled comments are "unclassified".
{
  let bad = 0;
  const LEGAL = new Set(["positive", "negative", "neutral"]);
  const BUCKETS = ["positive", "negative", "neutral", "unclassified"];
  const ACTIVE = /<script|javascript:|on\w+\s*=|<iframe|data:text\/html/i;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-sentiment.json"), "utf8")); } catch { /* absent */ }
  const labels = store?.classified || {};
  let sawSentiment = false;
  let unclassifiedTotal = 0;
  for (const e of eps) {
    if (!e.comments) continue;
    const s = e.comments.sentiment;
    const list = e.comments.list;
    if (!s || !list) { bad++; fail(`${e.slug}: comments.sentiment/list missing — sentiment fields must ship with comments`); continue; }
    sawSentiment = true;
    for (const k of Object.keys(s)) if (!BUCKETS.includes(k)) { bad++; fail(`${e.slug}: illegal sentiment bucket "${k}"`); }
    const sum = BUCKETS.reduce((a, k) => a + (s[k] || 0), 0);
    if (sum !== e.comments.total) { bad++; fail(`${e.slug}: sentiment buckets sum ${sum} != comments.total ${e.comments.total}`); }
    if (list.length !== e.comments.total) { bad++; fail(`${e.slug}: comments.list has ${list.length} rows, total says ${e.comments.total}`); }
    unclassifiedTotal += s.unclassified || 0;
    // recompute from the raw comments file + store — catches build/store drift
    try {
      const raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8"));
      const rec = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
      for (const c of raw.comments || []) {
        const l = labels[c.id]?.label;
        rec[LEGAL.has(l) ? l : "unclassified"]++;
      }
      for (const k of BUCKETS) {
        if (rec[k] !== (s[k] || 0)) { bad++; fail(`${e.slug}: sentiment.${k}=${s[k] || 0} but store recompute gives ${rec[k]} — counts drifted from stored classifications`); }
      }
    } catch (err) {
      bad++; fail(`${e.slug}: cannot recompute sentiment from raw comments — ${err.message}`);
    }
    for (const row of list) {
      if (row.sentiment != null && !LEGAL.has(row.sentiment)) { bad++; fail(`${e.slug}: comment row carries illegal sentiment "${row.sentiment}"`); }
      if (ACTIVE.test(row.text || "") || ACTIVE.test(row.author || "")) { bad++; fail(`${e.slug}: active content in shipped comment text/author — escape/render risk`); }
    }
  }
  if (unclassifiedTotal > 0) warn(`sentiment: ${unclassifiedTotal} comment(s) unclassified — classifier behind the pull (run scripts/restream/comments-sentiment.mjs)`);
  if (store) {
    const known = new Set();
    for (const e of eps) {
      try {
        const raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8"));
        for (const c of raw.comments || []) known.add(c.id);
      } catch { /* covered above */ }
    }
    const orphans = Object.keys(labels).filter((id) => !known.has(id));
    if (orphans.length) warn(`sentiment: ${orphans.length} store entr${orphans.length === 1 ? "y" : "ies"} for ids not in any comments file (deleted/pruned comments — harmless, kept for id stability)`);
  }
  if (!bad) ok("sentiment: buckets legal, counts match store recompute exactly, shipped text inert");
}

// --- 1f. insight strategy categories ---
{
  let bad = 0;
  const LEGAL_CATS = new Set(["content", "distribution", "promotion", "audience", "data"]);
  const KNOWN_DATA_IDS = new Set(["partial-history"]);
  for (const i of data.insights) {
    if (!i.category) { bad++; fail(`insight ${i.id}: category missing — strategy-impact category must ship`); }
    else if (!LEGAL_CATS.has(i.category)) { bad++; fail(`insight ${i.id}: illegal category "${i.category}"`); }
    else if (i.category === "data" && !KNOWN_DATA_IDS.has(i.id)) warn(`insight ${i.id}: landed on the "data" fallback category — add it to categoryFor()`);
    if (!i.recommendation) { bad++; fail(`insight ${i.id}: recommendation missing — every insight ships the decision it informs`); }
    if (!i.text || i.text.length < 20) { bad++; fail(`insight ${i.id}: text missing or too short to be an insight`); }
  }
  if (!bad) ok(`insight categories: ${data.insights.length} insights all carry a legal strategy category + recommendation`);
}

// --- 1g. episode ratings (W9): frozen immutability, window sanity, weight math, definition-lock ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  if (!store) {
    warn("ratings: episode-ratings.json absent — rating surfaces will not render (run tools/dive-analytics/ratings.mjs)");
  } else {
    if (store.algorithm !== "ratio-v2") { bad++; fail(`ratings: store algorithm "${store.algorithm}" — expected ratio-v2 (stale store; rerun ratings.mjs)`); }
    const bySlug = new Map((store.ratings || []).map((r) => [r.slug, r]));
    const epOrder = [...eps].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
    for (const e of epOrder) {
      const r = bySlug.get(e.slug);
      if (!r) { bad++; fail(`ratings: ${e.slug} has no store entry`); continue; }
      // definition-lock: what shipped in data.json IS the store entry
      const a = e.rating;
      if (!a) { bad++; fail(`ratings: ${e.slug} rating not attached to data.json — surfaces read nothing`); }
      else if (a.rank !== r.rank || a.n !== r.n || a.score !== r.score || a.provisional !== r.provisional || a.frozenAt !== r.frozenAt) {
        bad++; fail(`ratings: ${e.slug} attached rating disagrees with store (rank ${a.rank}/${r.rank}, n ${a.n}/${r.n}) — definition-lock broken`);
      }
      // window: exactly this episode + up to 9 that aired before it, never later
      const expectedWin = epOrder.filter((x) => x.ep <= e.ep && x.ep > e.ep - 10).map((x) => x.slug);
      if (JSON.stringify(r.windowIds) !== JSON.stringify(expectedWin)) { bad++; fail(`ratings: ${e.slug} windowIds != the ${expectedWin.length} most recent as of air date`); }
      if (r.n !== r.windowIds.length) { bad++; fail(`ratings: ${e.slug} n=${r.n} != window size ${r.windowIds.length}`); }
      if (r.rank == null || r.rank < 1 || r.rank > r.n) { bad++; fail(`ratings: ${e.slug} rank ${r.rank} outside 1..${r.n}`); }
      // freeze discipline: ≥7d episodes frozen, younger provisional
      if (e.ageDays >= 7 && (!r.frozenAt || r.provisional)) { bad++; fail(`ratings: ${e.slug} is ${e.ageDays}d old but not frozen`); }
      if (e.ageDays < 7 && (r.frozenAt || !r.provisional)) { bad++; fail(`ratings: ${e.slug} is ${e.ageDays}d old but marked frozen — week 1 incomplete`); }
      if (r.frozenAt && r.computedAt > r.frozenAt) { bad++; fail(`ratings: ${e.slug} computedAt after frozenAt`); }
      // weight math: redistributed weights sum to 1; absent pillars carry weight 0
      if (r.score != null) {
        let sum = 0;
        for (const [p, ps] of Object.entries(r.pillarScores || {})) {
          sum += ps.weight || 0;
          if (ps.ratio == null && (ps.weight || 0) !== 0) { bad++; fail(`ratings: ${e.slug} pillar ${p} has no ratio but weight ${ps.weight}`); }
          if (ps.ratio != null && !(ps.ratio > 0 && ps.ratio < 100)) { bad++; fail(`ratings: ${e.slug} pillar ${p} ratio ${ps.ratio} outside sane range`); }
          if (ps.ratio != null && ps.typical == null) { bad++; fail(`ratings: ${e.slug} pillar ${p} has a ratio but no stated typical — baseline must ship`); }
        }
        if (Math.abs(sum - 1) > 0.002) { bad++; fail(`ratings: ${e.slug} redistributed weights sum to ${sum.toFixed(4)}, not 1`); }
      }
    }
    // frozen immutability: a re-run must pass frozen entries through untouched
    try {
      const mod = await import(join(TOOL, "ratings.mjs"));
      const rerun = mod.computeRatings({ now: Date.parse(data.generatedAt) });
      for (const r of store.ratings || []) {
        if (!r.frozenAt) continue;
        const again = rerun.ratings.find((x) => x.slug === r.slug);
        if (JSON.stringify(again) !== JSON.stringify(r)) { bad++; fail(`ratings: frozen entry ${r.slug} CHANGED on recompute — frozen must be immutable`); }
      }
    } catch (err) {
      bad++; fail(`ratings: recompute threw — ${err.message}`);
    }
    if (!bad) ok(`ratings: ${(store.ratings || []).length} entries — windows exclude the future, frozen entries immutable, weights sum to 1, surfaces definition-locked`);
  }
}

// --- warnings: broadcast-resolution latches and plays coverage ---
{
  for (const show of registry.shows) {
    if (show.active === false) continue;
    for (const t of show.targets || []) {
      if (t.kind !== "x") continue;
      if (t.broadcastResolved && !t.broadcastId && t.playsStatus !== "none")
        warn(`latch: ${show.slug} ${t.account}/${t.postId} marked broadcastResolved with NO broadcastId and not latched "none" — will never be retried (plays lost unless latch cleared)`);
    }
  }
  for (const e of eps) {
    const latest = e.snapshots[e.snapshots.length - 1];
    const show = registry.shows.find((s) => s.slug === e.slug);
    for (const t of show?.targets || []) {
      if (t.kind === "x" && t.broadcastId) {
        const key = `x:${t.account}`;
        if (latest.byDest[key]?.plays == null)
          warn(`plays gap: ${e.slug} ${key} has a resolved broadcastId but no plays in latest snapshot (status=${t.playsStatus ?? "unset"}) — ${t.playsStatus === "stale-high-water" ? "reporting persisted high water" : "pull failing or broadcast newly expired"}`);
      }
    }
  }
  // snapshot cadence gaps over the last 7 days
  const weekAgo = Date.now() - 7 * DAY;
  for (const e of eps) {
    if (!e.active) continue;
    const recent = e.snapshots.map((s) => Date.parse(s.ts)).filter((t) => t >= weekAgo);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] - recent[i - 1] > FRESH_MS)
        warn(`cadence: ${e.slug} gap of ${((recent[i] - recent[i - 1]) / 3600000).toFixed(1)}h between snapshots ending ${new Date(recent[i]).toISOString()}`);
    }
  }
}

console.log(`\n${failures} failure(s), ${warnings} warning(s).`);
process.exit(failures ? 1 : 0);
