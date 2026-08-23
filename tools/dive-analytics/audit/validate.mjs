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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // tools/dive-analytics/audit
const TOOL = join(HERE, "..");
const ROOT = join(TOOL, "..", "..");
const REGISTRY = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY = join(ROOT, "data", "restream", "postlive");
const TRANSCRIPTS = join(ROOT, "transcripts");
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

// --- 5a. W12 transcript continuity: file/link parity, headers, and safe pull ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const scriptPath = join(ROOT, "scripts", "restream", "transcripts-pull.mjs");
  let pull = null;
  try { pull = await import(scriptPath); }
  catch (error) { bad++; fail(`transcripts: pull script could not load — ${error.message}`); }

  if (!/if\s*\(e\.transcript\)\s*\{[\s\S]{0,400}href="transcripts\/\$\{esc\(e\.slug\)\}\.txt"/.test(html)) {
    bad++; fail("transcripts: episode download is not gated by the stored transcript flag and slug");
  }

  const registeredDiveShows = registry.shows.filter(
    (show) => /dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug || "")
  );
  const registeredSlugs = new Set(registeredDiveShows.map((show) => show.slug));
  const files = existsSync(TRANSCRIPTS)
    ? readdirSync(TRANSCRIPTS).filter((name) => name.endsWith(".txt")).sort()
    : [];
  for (const name of files) {
    const slug = name.slice(0, -4);
    if (!registeredSlugs.has(slug)) { bad++; fail(`transcripts: ${name} does not map to a registered Dive Radio episode`); }
  }

  for (const episode of eps) {
    const show = registeredDiveShows.find((candidate) => candidate.slug === episode.slug);
    const path = join(TRANSCRIPTS, `${episode.slug}.txt`);
    const fileExists = existsSync(path);
    if (typeof episode.transcript !== "boolean" || episode.transcript !== fileExists) {
      bad++; fail(`${episode.slug}: stored transcript flag does not exactly match file existence`);
    }
    if (!fileExists || !show) continue;

    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r/g, "");
    const lines = text.split("\n");
    if (!lines[0]?.startsWith(`Dive Radio E${episode.ep} — `) || !lines[0].slice(`Dive Radio E${episode.ep} — `.length).trim()) {
      bad++; fail(`${episode.slug}: transcript does not begin with its episode header`);
    }
    if (!lines.slice(1).join("\n").trim()) { bad++; fail(`${episode.slug}: transcript has a header but no transcript body`); }
  }

  if (pull) {
    const saturdayMorningPhoenix = Date.parse("2026-08-22T14:00:00Z");
    if (!pull.isTranscriptDue("2026-08-20", saturdayMorningPhoenix)
      || pull.isTranscriptDue("2026-08-21", saturdayMorningPhoenix)) {
      bad++; fail("transcripts: day-two gate is not based on the Phoenix calendar");
    }
    for (const show of registeredDiveShows.filter((candidate) => candidate.active !== false && pull.isTranscriptDue(candidate.date))) {
      if (!existsSync(join(TRANSCRIPTS, `${show.slug}.txt`))) {
        warn(`transcripts: ${show.slug} reached day two without captions — no link will render; the pull will try again tomorrow`);
      }
    }
  }

  if (!bad) ok(`transcripts: ${files.length} registered file(s), links, episode headers, bodies, and Phoenix day-two gate are valid`);
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
  // Featured quotes still pass the old deterministic negative-word cross-check.
  let negSignal = null;
  try { ({ hasNegativeSignal: negSignal } = await import(join(ROOT, "scripts", "restream", "comments-sentiment.mjs"))); }
  catch { warn("comments: sentiment module unavailable — negative-veto check skipped"); }
  let classifiedStore = null;
  try { classifiedStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-classified.json"), "utf8")); } catch { /* absent */ }
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
        else if (classifiedStore?.classified) {
          const lbl = classifiedStore.classified[src.id];
          if (lbl?.state !== "ready" || lbl.relevance !== "feedback" || lbl.sentiment !== "positive") {
            bad++; fail(`${e.slug}: featured quote by "${q.author}" is not ready positive feedback — only confirmed praise may be featured`);
          }
        }
      }
    }
  }
  if (!bad) ok("comments: featured quotes capped, host-free, length-bounded, inert, provenance-checked, sentiment-positive");
}

// --- 1e. W8 audience feedback: model store, gates, rollups, and surface exclusion ---
{
  let bad = 0;
  const RELEVANCE = new Set(["feedback", "noise"]);
  const SENTIMENTS = new Set(["positive", "negative", "neutral", "mixed"]);
  const SURFACED = new Set(["positive", "negative", "mixed"]);
  const ACTIVE = /<script|javascript:|on\w+\s*=|<iframe|data:text\/html/i;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-classified.json"), "utf8")); } catch { /* absent */ }
  const labels = store?.classified || {};
  if (!store) {
    bad++; fail("comments: comments-classified.json absent — no feedback may publish without the gated store");
  } else {
    try {
      const classifier = await import(join(ROOT, "scripts", "restream", "comments-classify.mjs"));
      const vocabulary = classifier.THEME_VOCABULARY;
      const prompt = readFileSync(join(ROOT, "scripts", "restream", "comments-classify-prompt.md"), "utf8");
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      const configHash = createHash("sha256").update(JSON.stringify({
        version: classifier.CLASSIFIER_VERSION,
        promptVersion: classifier.PROMPT_VERSION,
        promptHash,
        model: store.model,
        provider: store.provider,
        vocabulary,
      })).digest("hex");
      if (store.version !== classifier.CLASSIFIER_VERSION) { bad++; fail(`comments: store version ${store.version} != classifier version ${classifier.CLASSIFIER_VERSION}`); }
      if (store.promptVersion !== classifier.PROMPT_VERSION || store.promptHash !== promptHash) { bad++; fail("comments: prompt stamp does not match the versioned classifier prompt"); }
      if (JSON.stringify(store.vocabulary) !== JSON.stringify(vocabulary)) { bad++; fail("comments: stored theme vocabulary does not match the classifier"); }
      if (store.configHash !== configHash) { bad++; fail("comments: classifier config hash does not match model, prompt, version, and vocabulary"); }
      if (!store.golden?.passed || store.golden.configHash !== configHash || store.golden.relevance?.pct !== 100 || store.golden.sentiment?.pct < 95) {
        bad++; fail("comments: current classifier config lacks a passing 100% relevance / 95% sentiment golden gate");
      }
      if (store.lastRun?.status !== "complete" || store.lastRun?.pendingIds?.length) { bad++; fail("comments: latest classifier run is pending — publish must stop"); }
      const themeSet = new Set(vocabulary);
      for (const [id, label] of Object.entries(labels)) {
        if (!new Set(["ready", "review"]).has(label.state)) { bad++; fail(`comments: ${id} has illegal state "${label.state}"`); }
        if (!RELEVANCE.has(label.relevance) || !SENTIMENTS.has(label.sentiment)) { bad++; fail(`comments: ${id} has an illegal relevance or sentiment label`); }
        if (!Array.isArray(label.themes) || label.themes.length > 2 || label.themes.some((t) => !themeSet.has(t))) { bad++; fail(`comments: ${id} has illegal themes`); }
        if (label.relevance === "noise" && (label.sentiment !== "neutral" || label.themes.length)) { bad++; fail(`comments: ${id} noise must be neutral with no themes`); }
        if (label.relevance === "feedback" && label.sentiment !== "neutral" && label.themes.length < 1) { bad++; fail(`comments: ${id} evaluative feedback needs a theme`); }
        if (typeof label.confidence !== "number" || label.confidence < 0 || label.confidence > 1) { bad++; fail(`comments: ${id} confidence outside 0..1`); }
        if (label.classifierVersion !== store.version || label.promptVersion == null || !label.model || !label.classifiedAt) { bad++; fail(`comments: ${id} missing classifier stamps`); }
      }
    } catch (err) {
      bad++; fail(`comments: classifier config validation threw — ${err.message}`);
    }
  }

  const personKey = (c) => {
    if (c.authorId) return `${c.source}:id:${c.authorId}`;
    return `${c.source}:name:${String(c.author || "viewer").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ")}`;
  };
  const peopleCount = (rows) => new Set(rows.map(personKey)).size;
  const topThemes = (rows) => {
    const byTheme = new Map();
    for (const { comment, label } of rows) {
      for (const theme of label.themes || []) {
        if (!byTheme.has(theme)) byTheme.set(theme, new Set());
        byTheme.get(theme).add(personKey(comment));
      }
    }
    return [...byTheme.entries()].map(([theme, people]) => ({ theme, count: people.size }))
      .filter((x) => x.count >= 3)
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme)).slice(0, 3);
  };
  const summarize = (rows, totalViews, rateComplete) => {
    const feedback = rows.filter(({ label }) => label?.state === "ready" && label.relevance === "feedback");
    const enjoy = feedback.filter(({ label }) => label.sentiment === "positive" || label.sentiment === "mixed");
    const complaints = feedback.filter(({ label }) => label.sentiment === "negative" || label.sentiment === "mixed");
    const uniqueCommenters = peopleCount(feedback.map(({ comment }) => comment));
    return {
      captured: rows.length,
      feedbackCount: feedback.length,
      uniqueCommenters,
      enjoyCount: peopleCount(enjoy.map(({ comment }) => comment)),
      complaintCount: peopleCount(complaints.map(({ comment }) => comment)),
      commentersPer1k: rateComplete && totalViews > 0 ? Math.round((uniqueCommenters / totalViews) * 10000) / 10 : null,
      commentersPer1kNote: rateComplete ? null : "The commenting rate isn’t available — some replies or watch counts are missing.",
      enjoyThemes: topThemes(enjoy),
      complaintThemes: topThemes(complaints),
    };
  };

  const known = new Set();
  const showRows = [];
  let showViews = 0;
  let showRateComplete = true;
  let reviewCount = 0;
  for (const e of eps) {
    if (!e.comments) continue;
    try {
      const raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8"));
      const rows = (raw.comments || []).map((comment) => {
        known.add(comment.id);
        if (!labels[comment.id]) { bad++; fail(`${e.slug}: ${comment.id} has no classifier entry — pending comments block publish`); }
        return { comment, label: labels[comment.id] || null };
      });
      showRows.push(...rows);
      showViews += e.latest.totalViews || 0;
      const tvi = e.latest.totalViewsInfo || {};
      const rateComplete = raw.xCoverage === "covered" && tvi.includesPlays === true && !tvi.partial && !tvi.stale;
      if (!rateComplete) showRateComplete = false;
      const expected = summarize(rows, e.latest.totalViews, rateComplete);
      for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(e.comments[key]) !== JSON.stringify(value)) { bad++; fail(`${e.slug}: comments.${key} disagrees with the classified-store recompute`); }
      }
      if ((e.comments.xCoverage ?? null) !== (raw.xCoverage ?? null)) { bad++; fail(`${e.slug}: X reply marker was lost between capture and export`); }

      const expectedIds = rows.filter(({ label }) => label?.state === "ready" && label.relevance === "feedback" && SURFACED.has(label.sentiment)).map(({ comment }) => comment.id).sort();
      const gotIds = (e.comments.list || []).map((row) => row.id).sort();
      if (JSON.stringify(gotIds) !== JSON.stringify(expectedIds)) { bad++; fail(`${e.slug}: public feedback rows do not exactly match ready positive, negative, and mixed feedback`); }
      for (const row of e.comments.list || []) {
        const rawComment = (raw.comments || []).find((c) => c.id === row.id);
        const label = labels[row.id];
        if (!rawComment || label?.state !== "ready" || label.relevance !== "feedback" || !SURFACED.has(label.sentiment)) { bad++; fail(`${e.slug}: ${row.id} surfaced without a ready feedback label`); continue; }
        if (row.sentiment !== label.sentiment || JSON.stringify(row.themes) !== JSON.stringify(label.themes) || row.text !== rawComment.text || row.author !== rawComment.author) { bad++; fail(`${e.slug}: ${row.id} public row drifted from raw text or stored label`); }
        if (ACTIVE.test(row.text || "") || ACTIVE.test(row.author || "")) { bad++; fail(`${e.slug}: active content in shipped feedback text or author`); }
      }
    } catch (err) {
      bad++; fail(`${e.slug}: cannot recompute audience feedback — ${err.message}`);
    }
  }
  if (store) {
    const orphans = Object.keys(labels).filter((id) => !known.has(id));
    if (orphans.length) warn(`comments: ${orphans.length} stored label${orphans.length === 1 ? "" : "s"} no longer has a raw comment — kept for id stability`);
    reviewCount = Object.values(labels).filter((label) => label.state === "review").length;
    if (reviewCount) warn(`comments: ${reviewCount} label disagreement${reviewCount === 1 ? "" : "s"} held for human review and absent from the export`);
  }
  const expectedShow = summarize(showRows, showViews, showRateComplete);
  if (JSON.stringify(data.commentSummary) !== JSON.stringify(expectedShow)) { bad++; fail("comments: show-level summary disagrees with the classified-store recompute"); }

  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!html.includes('c.sentiment === "positive" || c.sentiment === "mixed"') || !html.includes('c.sentiment === "negative" || c.sentiment === "mixed"')) {
    bad++; fail("comments: mixed feedback is not wired into both dashboard reading lists");
  }
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const slack = build.trendsText(data);
    const newest = eps[eps.length - 1]?.comments;
    const commenterPhrase = newest ? `${newest.uniqueCommenters} ${newest.uniqueCommenters === 1 ? "person" : "people"} commented` : "";
    if (!slack.includes("• Audience feedback:") || (newest && !slack.includes(commenterPhrase))) {
      bad++; fail("comments: Monday Slack line is missing or does not read the newest exported count");
    }
  } catch (err) {
    bad++; fail(`comments: Slack definition-lock check threw — ${err.message}`);
  }
  try {
    const alerts = await import(join(TOOL, "alerts.mjs"));
    const alertState = alerts.snapshotState(data);
    for (const e of eps) {
      if (alertState.complaints?.[e.slug] !== e.comments?.complaintCount) { bad++; fail(`${e.slug}: alert concern count does not read the exported feedback count`); }
    }
    if (alertState.reviewCount !== reviewCount) { bad++; fail("comments: alert review count does not match the classified store"); }
  } catch (err) {
    bad++; fail(`comments: alert definition-lock check threw — ${err.message}`);
  }
  if (!bad) ok(`comments: gated model store and golden scores valid; counts/themes/store/Slack match; noise, neutral text, pending and ${reviewCount} review item(s) stay off the page`);
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
  const liveChat = data.insights.find((i) => i.id === "live-chat");
  // The deterministic live-chat sentence is a FALLBACK contract: when the
  // recommendation engine's store drives What matters, it replaces the
  // rule-based insights wholesale (W15).
  const recStorePresent = existsSync(join(ROOT, "data", "restream", "recommendations.json"));
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const withLive = eps.filter((episode) => episode.live);
    const launchChat = withLive[0]?.live?.chatMessages;
    const latestChat = withLive.at(-1)?.live?.chatMessages;
    const expectedChat = !recStorePresent && withLive.length >= 2 ? build.liveChatText(launchChat, latestChat) : null;
    if (expectedChat && liveChat?.text !== expectedChat) {
      bad++; fail("insight live-chat: text does not exactly compare the stored first and latest message totals");
    }
    if (liveChat && ((liveChat.text.match(/\b\d[\d,]*\b/g) || []).length > 2 || /\bE\d+\b|→/.test(liveChat.text))) {
      bad++; fail("insight live-chat: history sequence adds more numbers than the decision needs");
    }
    if (build.liveChatText(10, 20) !== "Live chat is up from launch: 10 messages on the first show, 20 on the latest."
      || build.liveChatText(20, 10) !== "Live chat is down from launch: 20 messages on the first show, 10 on the latest."
      || build.liveChatText(10, 10) !== "Live chat is where it started: 10 messages on both the first and latest shows.") {
      bad++; fail("insight live-chat: up, down, and unchanged copy branches are not deterministic");
    }
    if (expectedChat && !build.trendsText(data).includes(`• [Audience health] ${expectedChat}`)) {
      bad++; fail("insight live-chat: Slack does not read the same stored sentence as the dashboard");
    }
  } catch (error) {
    bad++; fail(`insight live-chat: definition-lock check threw — ${error.message}`);
  }
  const paceInsights = data.insights.filter((insight) => insight.id === "pace-rank");
  const newest = eps.at(-1);
  // PRD v9 W22b: pace readiness and rank come from the one baselines definition
  const pacePublic = data.baselines?.pace?.[newest.slug] || null;
  const paceReady = !!(pacePublic && pacePublic.rank != null);
  if (paceReady !== (data.showTrend?.paceRank != null)) {
    bad++; fail("insight pace-rank: public pace readiness does not match the baselines three-peer gate");
  }
  if (paceReady && (data.showTrend.paceRank.rank !== pacePublic.rank || data.showTrend.paceRank.of !== pacePublic.of)) {
    bad++; fail("insight pace-rank: showTrend.paceRank disagrees with data.baselines.pace");
  }
  if (paceInsights.length !== (paceReady ? 1 : 0)) {
    bad++; fail(`insight pace-rank: expected ${paceReady ? "one grounded insight" : "no small-sample insight"}, found ${paceInsights.length}`);
  } else if (paceReady && paceInsights[0].chartState?.solo !== newest.slug) {
    bad++; fail("insight pace-rank: actionable pace insight does not open the newest episode");
  }
  const anomalyEpisodes = eps.filter((e) => e.metrics?.anomaly);
  for (const id of ["reach-conversion", "host-plays-split"]) {
    const insight = data.insights.find((i) => i.id === id);
    if (!insight || !anomalyEpisodes.length) continue;
    if (!/promo outliers left out/i.test(insight.caveat || "")) {
      bad++; fail(`insight ${id}: caveat does not say promo outliers were left out`);
    }
    if (id === "reach-conversion") {
      const copy = `${insight.text} ${insight.recommendation}`;
      for (const e of anomalyEpisodes) {
        if (new RegExp(`\\bE${e.ep}\\b`).test(copy)) { bad++; fail(`insight ${id}: cites promo outlier E${e.ep}`); }
      }
    }
  }
  if (!bad) ok(`insight categories: ${data.insights.length} insights all carry a legal strategy category + recommendation`);
}

// --- 1g. episode health (W12): 21-day gate, frozen immutability, window sanity, weight math, definition-lock ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  if (!store) {
    warn("episode health: episode-ratings.json absent — health surfaces will not render (run tools/dive-analytics/ratings.mjs)");
  } else {
    const BL = await import(join(TOOL, "baselines.mjs"));
    if (store.algorithm !== "health21-v2") { bad++; fail(`episode health: store algorithm "${store.algorithm}" — expected health21-v2 (stale store; rerun ratings.mjs)`); }
    if (store.readDays !== 21) { bad++; fail(`episode health: store readDays ${store.readDays} — the read window is 21 days`); }
    if (store.windowN !== BL.WINDOW_N || store.minPeers !== BL.MIN_PEERS) { bad++; fail("episode health: store window/min-peers stamps differ from baselines.mjs"); }
    const flagsNow = BL.anomalyFlags(eps);
    const bySlug = new Map((store.scores || []).map((r) => [r.slug, r]));
    const epOrder = [...eps].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
    for (const e of epOrder) {
      const r = bySlug.get(e.slug);
      const a = e.health;
      // the 21-day gate is constitutional: no entry, no score, nothing early
      if (e.ageDays < 21) {
        if (r) { bad++; fail(`episode health: ${e.slug} is ${e.ageDays}d old but has a stored score — three weeks incomplete`); }
        if (!a || a.pending !== true || "score" in a) { bad++; fail(`episode health: ${e.slug} must ship only a pending marker before day 21`); continue; }
        const expectOn = new Date(premiereMs(e.premiere) + 21 * DAY - 7 * 3600000).toISOString().slice(0, 10);
        if (a.readCompleteOn !== expectOn) { bad++; fail(`episode health: ${e.slug} readCompleteOn ${a.readCompleteOn} != premiere + 21 days (${expectOn})`); }
        continue;
      }
      if (!r) { bad++; fail(`episode health: ${e.slug} is ${e.ageDays}d old but has no store entry`); continue; }
      // definition-lock: what shipped in data.json IS the store entry
      if (JSON.stringify(a) !== JSON.stringify(r)) { bad++; fail(`episode health: ${e.slug} attached entry disagrees with store — definition-lock broken`); }
      // window (PRD v9): this episode + the WINDOW_N that aired before it, never later
      const expectedWin = [...BL.windowFor(e, epOrder).map((x) => x.slug), e.slug];
      if (JSON.stringify(r.windowIds) !== JSON.stringify(expectedWin)) { bad++; fail(`episode health: ${e.slug} windowIds != itself + the ${BL.WINDOW_N} episodes that aired before it`); }
      if (!r.frozenAt || !r.computedAt || !Number.isFinite(r.frozenAtDay) || r.frozenAtDay < 21) { bad++; fail(`episode health: ${e.slug} entry is missing its frozen/computed stamps or froze before day 21`); }
      if (!Array.isArray(r.excluded)) { bad++; fail(`episode health: ${e.slug} entry carries no excluded[] list`); }
      for (const x of r.excluded || []) if (!r.windowIds.includes(x.slug) || !x.why) { bad++; fail(`episode health: ${e.slug} excludes ${x.slug} outside its window or without a reason`); }
      // rule 13: every contributing check has MIN_PEERS stored peers, its typical is
      // the true median of those peers, and its score rebuilds from value vs typical
      for (const [c, cs] of Object.entries(r.checks || {})) {
        if (!["sameAge", "mature", "ageFree", null].includes(cs.ageBasis ?? null)) { bad++; fail(`episode health: ${e.slug} check ${c} has an unknown ageBasis`); }
        if (cs.ratio == null) { if (!cs.reason && r.score != null) { bad++; fail(`episode health: ${e.slug} check ${c} is absent without a reason`); } continue; }
        if (!Array.isArray(cs.peers) || cs.peers.length < BL.MIN_PEERS) { bad++; fail(`episode health: ${e.slug} check ${c} contributes with ${cs.peers?.length ?? 0} peers — fewer than MIN_PEERS`); continue; }
        for (const p of cs.peers) if (!r.windowIds.includes(p.slug) || p.slug === e.slug || (r.excluded || []).some((x) => x.slug === p.slug)) { bad++; fail(`episode health: ${e.slug} check ${c} peer ${p.slug} is outside the window, itself, or an excluded outlier`); }
        if (c === "live") {
          const tp = BL.round1(BL.trueMedian(cs.peers.map((p) => p.value.peak)));
          const tc = BL.round1(BL.trueMedian(cs.peers.map((p) => p.value.chat)));
          if (tp !== cs.typical.peak || tc !== cs.typical.chat) { bad++; fail(`episode health: ${e.slug} live typicals do not rebuild from stored peers`); }
        } else {
          if (cs.typical !== BL.round1(BL.trueMedian(cs.peers.map((p) => p.value)))) { bad++; fail(`episode health: ${e.slug} check ${c} typical does not rebuild from its stored peers`); }
          if (cs.score !== BL.scoreOf(cs.value, cs.typical)) { bad++; fail(`episode health: ${e.slug} check ${c} score does not rebuild from value vs typical`); }
          if (cs.ageBasis === "sameAge" && cs.peers.some((p) => Math.abs(p.atDay - (c === "engagement" ? p.atDay : cs.atDay ?? r.atDay)) > BL.SNAPSHOT_TOL + 1e-9)) { bad++; fail(`episode health: ${e.slug} check ${c} claims same age but a peer was read at another age`); }
          if (cs.ageBasis === "sameAge" && cs.note !== BL.NOTES.sameAge) { bad++; fail(`episode health: ${e.slug} check ${c} note does not match its basis`); }
          if (cs.ageBasis === "mature" && cs.note !== BL.NOTES.mature) { bad++; fail(`episode health: ${e.slug} check ${c} note does not match its basis`); }
        }
        // inputs from append-only stores rebuild exactly (1w); the overwritten
        // analytics file is stamped unreproducible rather than pretended
        for (const p of cs.peers) {
          if (p.source === "snapshot") {
            const pe = epOrder.find((x) => x.slug === p.slug);
            const snap = pe && BL.snapshotAt(pe, p.atDay);
            const v = snap ? (c === "watch" ? BL.ytViewsOf(snap) : BL.engagementPer1kOf(snap)) : null;
            if (v !== p.value) { bad++; fail(`episode health: ${e.slug} check ${c} peer ${p.slug} value ${p.value} does not rebuild from the snapshot at day ${p.atDay} (${v})`); }
          }
          if (p.source === "analytics-file" && r.reproducible !== false) { bad++; fail(`episode health: ${e.slug} reads a current analytics file but is stamped reproducible`); }
        }
      }
      if (r.score == null) {
        if (!r.reason) { bad++; fail(`episode health: ${e.slug} has no score and no reason — absence must explain itself`); }
      } else {
        if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) { bad++; fail(`episode health: ${e.slug} score ${r.score} outside 0..100`); }
        // weight math: redistributed weights sum to 1; absent checks carry weight 0
        let sum = 0;
        let weighted = 0;
        for (const [c, cs] of Object.entries(r.checks || {})) {
          sum += cs.weight || 0;
          if (cs.ratio == null && (cs.weight || 0) !== 0) { bad++; fail(`episode health: ${e.slug} check ${c} has no honest number but weight ${cs.weight}`); }
          // a comparison of exactly 0 is legal: a real zero (e.g. no subscribers
          // gained) is an honest value, never conflated with a missing one
          if (cs.ratio != null && !(cs.ratio >= 0 && cs.ratio < 100)) { bad++; fail(`episode health: ${e.slug} check ${c} comparison ${cs.ratio} outside sane range`); }
          if (cs.ratio != null && cs.typical == null) { bad++; fail(`episode health: ${e.slug} check ${c} compares against nothing — the typical value must ship`); }
          if (cs.score != null && (!Number.isInteger(cs.score) || cs.score < 0 || cs.score > 100)) { bad++; fail(`episode health: ${e.slug} check ${c} score outside 0..100`); }
          if (cs.ratio != null && cs.weight) weighted += cs.score * cs.weight;
        }
        if (Math.abs(sum - 1) > 0.002) { bad++; fail(`episode health: ${e.slug} redistributed weights sum to ${sum.toFixed(4)}, not 1`); }
        if (Math.round(weighted) !== r.score) { bad++; fail(`episode health: ${e.slug} score ${r.score} != weighted mean of its checks (${Math.round(weighted)})`); }
        const expectMissing = Object.entries(r.checks || {}).filter(([, cs]) => cs.ratio == null).map(([c]) => c);
        if (JSON.stringify(r.missingChecks) !== JSON.stringify(expectMissing)) { bad++; fail(`episode health: ${e.slug} missingChecks does not list exactly the checks without honest numbers`); }
      }
    }
    // frozen immutability (1w): a re-run keeps stored entries by construction,
    // so the real check is above — every score rebuilds from what the entry
    // stores. Here: the stored outlier verdicts never change with today's flags.
    for (const r of store.scores || []) {
      for (const x of r.excluded || []) if (x.why === "promo outlier" && !r.windowIds.includes(x.slug)) { bad++; fail(`episode health: ${r.slug} excluded ${x.slug} is not in its window`); }
    }
    try {
      const mod = await import(join(TOOL, "ratings.mjs"));
      const rerun = mod.computeRatings({ now: Date.parse(data.generatedAt) });
      for (const r of store.scores || []) {
        const again = rerun.scores.find((x) => x.slug === r.slug);
        if (JSON.stringify(again) !== JSON.stringify(r)) { bad++; fail(`episode health: frozen entry ${r.slug} CHANGED on recompute — frozen must be immutable`); }
      }
      if (rerun.algorithm !== store.algorithm) { bad++; fail("episode health: store algorithm differs from the running one — rerun ratings.mjs"); }
    } catch (err) {
      bad++; fail(`episode health: recompute threw — ${err.message}`);
    }
    if (!bad) ok(`episode health: ${(store.scores || []).length} finished read(s) — nothing scored before day 21, windows exclude the future and outliers, every contributing check has ${BL.MIN_PEERS}+ peers and rebuilds from its stored inputs, weights sum to 1, surfaces definition-locked`);
  }
}

// --- 1m. W13 watching export: verified-analytics blend sanity ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/mode: "watch"/.test(html)) { bad++; fail("watching: the chart has no Watching view"); }
  for (const e of eps) {
    const w = e.watch;
    const storePath = join(ROOT, "data", "restream", "yt-analytics", `${e.slug}.json`);
    if (!w) {
      if (existsSync(storePath)) {
        try {
          const j = JSON.parse(readFileSync(storePath, "utf8"));
          const usable = Object.values(j.channels || {}).some((c) => c?.totals && c.totals.views > 0);
          if (usable) { bad++; fail(`watching: ${e.slug} has analytics but no exported watch block`); }
        } catch { /* unreadable store — pull warns separately */ }
      }
      continue;
    }
    if (!existsSync(storePath)) { bad++; fail(`watching: ${e.slug} exports watch data with no analytics store — fabricated`); continue; }
    if (!Array.isArray(w.channels) || !w.channels.length) { bad++; fail(`watching: ${e.slug} watch block names no channels`); }
    if (w.avgPercent != null && !(w.avgPercent >= 0 && w.avgPercent <= 100)) { bad++; fail(`watching: ${e.slug} average share ${w.avgPercent} outside 0..100`); }
    if (w.avgDurationSec != null && !(w.avgDurationSec > 0)) { bad++; fail(`watching: ${e.slug} average duration must be positive when present`); }
    if (w.curve) {
      let last = -1;
      for (const point of w.curve) {
        if (!(point.at > 0 && point.at <= 1) || !(point.watching >= 0 && point.watching <= 3) || point.at <= last) {
          bad++; fail(`watching: ${e.slug} curve point out of range or order (at=${point.at})`); break;
        }
        last = point.at;
      }
    }
    if (w.traffic) {
      const shareSum = w.traffic.reduce((sum, t) => sum + t.share, 0);
      if (shareSum > 100.6) { bad++; fail(`watching: ${e.slug} view-source shares sum to ${shareSum.toFixed(1)}`); }
      if (w.traffic.some((t) => !(t.views > 0) || !(t.share >= 0 && t.share <= 100))) { bad++; fail(`watching: ${e.slug} view-source row out of range`); }
    }
  }
  if (!bad) ok(`watching: ${eps.filter((e) => e.watch).length} episode(s) export verified watch data — blends in range, curves ordered, absence never zero`);
}

// --- 1m2. W16 transcript × retention moments: recompute lock, ranges, verbatim excerpts, silent absence ---
// Contract (PRD v6, calibration frozen 2026-08-23): moments exist only for
// episodes with BOTH a blended curve and a transcript; each is at least the
// frozen point floor over a 2-step window, globally spaced, capped at
// 3 drops + 2 holds; excerpts are verbatim substrings of the transcript file;
// timing sits inside the duration derived from the analytics totals; episodes
// missing either input carry neither block and no surface says so.
{
  let bad = 0;
  const wm = await import(join(TOOL, "watch-moments.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const e of eps) {
    const w = e.watch;
    const transcriptPath = join(TRANSCRIPTS, `${e.slug}.txt`);
    const hasBoth = !!(w?.curve?.length && existsSync(transcriptPath));
    if (!hasBoth) {
      if (w && ("shape" in w || "moments" in w)) { bad++; fail(`moments: ${e.slug} carries shape/moments without both a curve and a transcript`); }
      continue;
    }
    const raw = readFileSync(transcriptPath, "utf8");
    const store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "yt-analytics", `${e.slug}.json`), "utf8"));
    const chans = Object.entries(store.channels || {}).filter(([, c]) => c?.totals && Number.isFinite(c.totals.views) && c.totals.views > 0);
    const expected = wm.watchMoments({ curve: w.curve, channelTotals: chans.map(([, c]) => c.totals), transcriptText: raw });
    if (JSON.stringify(w.shape ?? null) !== JSON.stringify(expected?.shape ?? null)) { bad++; fail(`moments: ${e.slug} shape disagrees with the deterministic recompute`); }
    const expectedMoments = expected?.moments?.length ? expected.moments : null;
    // summaries are store-attached prose; strip them before the deterministic compare
    const strippedMoments = w.moments ? w.moments.map(({ summary, ...rest }) => rest) : null;
    if (JSON.stringify(strippedMoments) !== JSON.stringify(expectedMoments)) { bad++; fail(`moments: ${e.slug} moments disagree with the deterministic recompute`); }
    const duration = wm.deriveDuration(chans.map(([, c]) => c.totals));
    const text = raw.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const ms = w.moments || [];
    if (ms.length > 5 || ms.filter((m) => m.kind === "drop").length > 3 || ms.filter((m) => m.kind === "hold").length > 2) { bad++; fail(`moments: ${e.slug} exceeds the 3-drop/2-hold cap`); }
    for (const m of ms) {
      if (m.kind !== "drop" && m.kind !== "hold") { bad++; fail(`moments: ${e.slug} illegal kind "${m.kind}"`); continue; }
      if (!(m.at >= 0.05 && m.at <= 1) || (m.kind === "hold" && m.at < wm.HOLD_SCAN_FROM)) { bad++; fail(`moments: ${e.slug} ${m.kind} at ${m.at} outside its scan range`); }
      if (!w.curve.some((p) => p.at === m.at)) { bad++; fail(`moments: ${e.slug} moment at ${m.at} is not a curve grid point — its marker could not sit on the line`); }
      if (!(m.points >= wm.MOMENT_POINTS_MIN)) { bad++; fail(`moments: ${e.slug} ${m.kind} of ${m.points} points is under the frozen ${wm.MOMENT_POINTS_MIN}-point floor`); }
      if (!duration || !(m.estSec >= 0 && m.estSec <= duration.durationSec)) { bad++; fail(`moments: ${e.slug} estSec ${m.estSec} outside the derived video length`); }
      if (duration && m.approx !== duration.approx) { bad++; fail(`moments: ${e.slug} approx flag disagrees with the channel-duration disagreement`); }
      if (typeof m.excerpt !== "string" || !m.excerpt.trim() || m.excerpt.length > wm.EXCERPT_MAX) { bad++; fail(`moments: ${e.slug} excerpt missing, empty, or over ${wm.EXCERPT_MAX} chars`); }
      else if (!text.includes(m.excerpt)) { bad++; fail(`moments: ${e.slug} excerpt is NOT a verbatim substring of its transcript file`); }
      if (m.speaker !== null && (typeof m.speaker !== "string" || !m.speaker.trim())) { bad++; fail(`moments: ${e.slug} speaker must be a transcript label or null`); }
    }
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        if (Math.abs(ms[i].at - ms[j].at) < wm.MOMENT_SPACING) { bad++; fail(`moments: ${e.slug} moments at ${ms[i].at} and ${ms[j].at} sit closer than ${wm.MOMENT_SPACING}`); }
      }
    }
  }
  // W17 moment summaries: model-written context in a validated store; the page
  // and the Slack line attach it verbatim, and NOTHING ever falls back to a
  // raw transcript quote (owner directive 2026-08-23)
  try {
    const ms = await import(join(TOOL, "moment-summaries.mjs"));
    let sumStore = null;
    try { sumStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "moment-summaries.json"), "utf8")); } catch { /* absent */ }
    if (!sumStore) {
      warn("moments: no summaries store — pins render without context lines (run tools/dive-analytics/moment-summaries.mjs)");
      for (const e of eps) for (const m of e.watch?.moments || []) {
        if ("summary" in m) { bad++; fail(`moments: ${e.slug} carries a summary with no store — fabricated context`); }
      }
    } else {
      ms.validateStore(sumStore);
      const liveKeys = new Set();
      for (const e of eps) {
        for (const m of e.watch?.moments || []) {
          const key = ms.momentKey(e.slug, m);
          liveKeys.add(key);
          const entry = sumStore.entries[key];
          if (entry && m.summary !== entry.summary) { bad++; fail(`moments: ${e.slug} ${m.kind}@${m.at} summary drifted from the store`); }
          if (!entry && "summary" in m) { bad++; fail(`moments: ${e.slug} ${m.kind}@${m.at} carries a summary the store does not hold`); }
        }
      }
      const orphans = Object.keys(sumStore.entries).filter((k) => !liveKeys.has(k));
      if (orphans.length) warn(`moments: ${orphans.length} stored summar${orphans.length === 1 ? "y" : "ies"} no longer match a current moment — kept as history, unused`);
    }
  } catch (err) { bad++; fail(`moments: summaries store validation threw — ${err.message}`); }
  // panel pins: rendered ONLY from stored moments, as keyboard-reachable tooltip buttons on the positioned plot,
  // with the structured tooltip (payoff, position, stored summary) wired through the shared box
  if (!/\(w\.moments \|\| \[\]\)\.forEach/.test(html)
    || !/class="wmark \$\{mo\.kind\}"/.test(html)
    || !/<button type="button" class="wmark/.test(html)
    || !html.includes('data-stat="${esc(stat)}" data-meta="${esc(meta)}"')
    || !html.includes('data-note="${esc(mo.summary)}"')
    || !html.includes("aria-describedby=")
    || !html.includes("badge.dataset.stat")
    || !html.includes("badge.dataset.note")
    || html.includes("momentQuote")
    || !html.includes(".hs[data-hslug], [data-tip], [data-stat]")) {
    bad++; fail("moments: panel pins must render only from episode.watch.moments with store-attached summaries — never raw transcript quotes");
  }
  if (!/<div class="wcurve"><div class="wplot">/.test(html)) { bad++; fail("moments: curve markers lack the positioned plot wrapper — marker positions would drift off the curve"); }
  // engine parity: the excerpts handed to the engine ARE the stored moments' excerpts, and moment facts equal their points
  try {
    const recs = await import(join(TOOL, "recommendations.mjs"));
    const sheet = recs.collectFacts();
    const byId = new Map();
    for (const e of eps) for (const m of e.watch?.moments || []) byId.set(`${m.kind}-E${e.ep}-${Math.round(m.at * 100)}`, m);
    const ids = [...byId.keys()].sort();
    const sheetIds = (sheet.excerpts || []).map((x) => x.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(sheetIds)) { bad++; fail("moments: engine excerpt ids do not match the stored moments"); }
    for (const x of sheet.excerpts || []) {
      const m = byId.get(x.id);
      if (!m || x.text !== m.excerpt) { bad++; fail(`moments: engine excerpt ${x.id} drifted from the stored moment`); }
    }
    for (const f of sheet.facts) {
      const hit = /^(?:drop|hold)-E\d+-\d+$/.test(f.id);
      if (hit && (!byId.get(f.id) || f.value !== byId.get(f.id).points)) { bad++; fail(`moments: engine fact ${f.id} does not equal the stored moment's points`); }
    }
  } catch (err) { bad++; fail(`moments: engine parity check threw — ${err.message}`); }
  // Slack definition-lock: the Monday report's sharpest-exit line is rebuilt
  // verbatim from the stored moment and its store-attached summary — never a
  // transcript quote (1i re-checks the whole report for plain words)
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const slack = build.trendsText(data);
    const exitLines = slack.split("\n").filter((l) => l.startsWith("• Sharpest exit in "));
    const momentEp = [...eps].reverse().find((x) => x.watch?.moments?.some((m) => m.kind === "drop"));
    if (!momentEp) {
      if (exitLines.length) { bad++; fail("moments: Slack reports an exit moment no episode carries"); }
    } else {
      const d = momentEp.watch.moments.filter((m) => m.kind === "drop").sort((a, b) => b.points - a.points || a.at - b.at)[0];
      const expected = `• Sharpest exit in ${momentEp.title.replace(/^Dive Radio:\s*/i, "")}: ${d.points} of every 100 viewers leave ${d.approx ? "roughly" : "about"} ${build.minutesInWords(d.estSec)}${d.summary ? ` — ${d.summary}` : ""}.`;
      if (exitLines.length !== 1 || exitLines[0] !== expected) { bad++; fail("moments: Slack sharpest-exit line does not exactly rebuild from the stored moment and its summary"); }
    }
  } catch (err) { bad++; fail(`moments: Slack line check threw — ${err.message}`); }
  if (!bad) ok(`moments: ${eps.filter((x) => x.watch?.moments).length} episode(s) carry transcript-anchored moments — recompute-locked, floors/spacing/caps hold, excerpts verbatim, absence silent, Slack line locked`);
}

// --- 1n. W15 recommendation engine: grounded store, definition-locked into insights ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "recommendations.json"), "utf8")); } catch { /* absent */ }
  if (!store) {
    warn("recommendations: no store — What matters falls back to the deterministic rules (run tools/dive-analytics/recommendations.mjs)");
  } else {
    let recs = null;
    try { recs = await import(join(TOOL, "recommendations.mjs")); } catch (err) { bad++; fail(`recommendations: module failed to load — ${err.message}`); }
    if (recs) {
      // grounding against the facts the store stamps (PRD v9 §4.6); stores
      // written before fact stamping can only be judged against today's sheet
      if (Array.isArray(store.facts)) {
        try { recs.validateItems(store.items, store.facts); }
        catch (err) { bad++; fail(`recommendations: store is not grounded in its own stamped facts — ${err.message}`); }
      } else warn("recommendations: store predates fact stamping — grounded against today's sheet only");
      // currency: shipped items pass today's sheet; stale items fail it, and
      // data.json names each stale item with its reason (F32)
      const sheet = recs.collectFacts(data);
      const allowed = recs.allowedNumbers(sheet.facts);
      const staleIds = (data.insightsStale || []).map((x) => x.id);
      for (const item of store.items || []) {
        let err = null;
        try { recs.validateItem(item, sheet.facts, allowed); } catch (e) { err = e; }
        const shipped = data.insights.some((i) => i.id === item.id);
        if (err && shipped) { bad++; fail(`recommendations: ${item.id} is shipped but no longer grounded — ${err.message}`); }
        if (!err && !shipped && data.insights.some((i) => !("chartState" in i))) { bad++; fail(`recommendations: ${item.id} is grounded today but missing from the page`); }
        if (err && !staleIds.includes(item.id)) { bad++; fail(`recommendations: ${item.id} is stale but not named in data.insightsStale`); }
        if (!err && staleIds.includes(item.id)) { bad++; fail(`recommendations: ${item.id} is named stale but still grounds`); }
      }
    }
    // v7 W17/W18 audit fields, when present: a prune records when and what it
    // dropped (and nothing dropped may still be in the store); a model run
    // records how many attempts the grounded set needed (three is the cap)
    if ("prunedIds" in store || "prunedAt" in store) {
      if (!Array.isArray(store.prunedIds) || !store.prunedIds.length || store.prunedIds.some((x) => typeof x !== "string")) {
        bad++; fail("recommendations: prunedIds must be a non-empty list of item ids");
      } else if (!Number.isFinite(Date.parse(store.prunedAt))) {
        bad++; fail("recommendations: a prune must stamp prunedAt");
      } else if ((store.items || []).some((item) => store.prunedIds.includes(item.id))) {
        bad++; fail("recommendations: a pruned id is still in the store");
      }
    }
    if ("attempts" in store && (!Number.isInteger(store.attempts) || store.attempts < 1 || store.attempts > 3)) {
      bad++; fail(`recommendations: attempts ${JSON.stringify(store.attempts)} outside 1..3`);
    }
    const storeIds = (store.items || []).map((r) => r.id).filter((id) => !(data.insightsStale || []).some((x) => x.id === id)).sort();
    const dataIds = (data.insights || []).map((i) => i.id).sort();
    if (storeIds.length && JSON.stringify(storeIds) !== JSON.stringify(dataIds)) {
      bad++; fail("recommendations: data.json insights do not match the saved store minus stale items — definition-lock broken");
    }
    for (const item of store.items || []) {
      const shipped = data.insights.find((i) => i.id === item.id);
      if (shipped && (shipped.text !== item.text || shipped.recommendation !== item.recommendation)) {
        bad++; fail(`recommendations: ${item.id} text drifted between store and page`);
      }
    }
    if (!bad) ok(`recommendations: ${(store.items || []).length} saved item(s), ${(data.insightsStale || []).length} stale and held back — every shipped number grounded in today's fact sheet, page matches the store`);
  }
}

// --- 1h. W10 show health: deterministic math, grounding, history, surface lock ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "health-history.json"), "utf8")); } catch { /* first pre-health build is legal */ }
  const health = await import(join(TOOL, "health.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const phxDate = (value) => new Date(Date.parse(value) - 7 * 3600000).toISOString().slice(0, 10);
  const expectedParts = Object.keys(health.BASE_WEIGHTS).sort();

  if (!html.includes('id="health"') || !html.includes("function buildHealth()") || !html.includes("Number.isFinite(h.score)")) {
    bad++; fail("health: dashboard surface is missing or could turn a real zero score into absence");
  }
  const renderer = html.match(/function buildHealth\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  if (/subScores|weightedMean|BASE_WEIGHTS/.test(renderer)) {
    bad++; fail("health: browser renderer reaches into scoring inputs instead of reading the saved public projection");
  }

  if (!store) {
    if (data.health !== null) { bad++; fail("health: data.json exposes health without a health-history store"); }
    warn("health: no saved entry yet — page must show that the update is unavailable");
  } else {
    if (![1, health.HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) {
      bad++; fail("health: store schema/version is unsupported");
    } else {
      const BL = await import(join(TOOL, "baselines.mjs"));
      const currentDate = phxDate(data.generatedAt);
      const seenDates = new Set();
      let previousDate = null;
      const prompt = readFileSync(join(TOOL, "health-prompt.md"), "utf8");
      const promptHash = createHash("sha256").update(prompt).digest("hex");

      // Strong local append-only guard: every entry already committed at HEAD
      // must remain byte-identical; a working run may add at most today's row.
      try {
        const committed = JSON.parse(execFileSync("git", ["show", "HEAD:data/restream/health-history.json"], { cwd: ROOT, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }));
        if (store.entries.length < committed.entries.length || store.entries.length > committed.entries.length + 1) {
          bad++; fail("health: working store removed history or added more than one daily entry");
        }
        for (let index = 0; index < committed.entries.length; index++) {
          if (JSON.stringify(store.entries[index]) !== JSON.stringify(committed.entries[index])) {
            bad++; fail(`health: committed entry ${committed.entries[index].date} changed — history is append-only`);
          }
        }
      } catch { /* initial W10 commit has no HEAD store */ }

      for (const entry of store.entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || seenDates.has(entry.date) || (previousDate && entry.date <= previousDate)) {
          bad++; fail(`health: entry date ${JSON.stringify(entry.date)} is duplicate, malformed, or out of order`);
        }
        seenDates.add(entry.date);
        previousDate = entry.date;
        if (entry.date > currentDate) { bad++; fail(`health: ${entry.date} is future-dated`); }
        if (!entry.createdAt || phxDate(entry.createdAt) !== entry.date) { bad++; fail(`health: ${entry.date} does not match its Phoenix creation day`); }
        // Entries are immutable history: each is judged against ITS OWN stamped
        // versions. What must hold: stamps exist, and an entry claiming the
        // CURRENT prompt/formula version matches the current prompt/formula.
        if (typeof entry.formulaVersion !== "string" || !entry.formulaVersion) { bad++; fail(`health: ${entry.date} has no formula stamp`); }
        if (!Number.isInteger(entry.promptVersion)) { bad++; fail(`health: ${entry.date} has no prompt stamp`); }
        else if (entry.promptVersion > health.PROMPT_VERSION) { bad++; fail(`health: ${entry.date} claims prompt version ${entry.promptVersion}, newer than the current ${health.PROMPT_VERSION}`); }
        else if (entry.promptVersion === health.PROMPT_VERSION && entry.promptHash !== promptHash) { bad++; fail(`health: ${entry.date} prompt stamp is stale — prompt changed without a version bump`); }
        if (!entry.model || !entry.provider || !entry.bundleHash || !entry.dataGeneratedAt || !entry.dataThrough) { bad++; fail(`health: ${entry.date} is missing provenance stamps`); }
        if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) { bad++; fail(`health: ${entry.date} score is outside 0..100`); }

        const partKeys = Object.keys(entry.subScores || {}).sort();
        if (JSON.stringify(partKeys) !== JSON.stringify(expectedParts)) {
          bad++; fail(`health: ${entry.date} does not carry exactly the six required checks`);
          continue;
        }
        // weights are judged by the formula the entry was written under (PRD v9 F5)
        const plannedWeights = health.WEIGHTS_BY_FORMULA[entry.formulaVersion] || null;
        if (!plannedWeights) { bad++; fail(`health: ${entry.date} formula ${entry.formulaVersion} has no known weight table`); }
        const v3 = entry.formulaVersion === "health-v3" || (health.WEIGHTS_BY_FORMULA[entry.formulaVersion] && Number(entry.formulaVersion.replace(/\D/g, "")) >= 3);
        const { effectiveWeightOf } = health.deterministicMean(entry.subScores);
        const availableWeight = Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
        for (const key of expectedParts) {
          const part = entry.subScores[key];
          if (plannedWeights && part.baseWeight !== plannedWeights[key]) { bad++; fail(`health: ${entry.date} ${key} has the wrong planned weight for ${entry.formulaVersion}`); }
          if (!part.measures || !Object.keys(part.measures).length) { bad++; fail(`health: ${entry.date} ${key} has no recorded measures`); continue; }
          const measureScores = [];
          for (const [measureKey, measure] of Object.entries(part.measures)) {
            if (measure.score == null) {
              if (!measure.reason) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} is missing without a reason`); }
            } else {
              if (!Number.isFinite(measure.score) || measure.score < 0 || measure.score > 100 || !Number.isFinite(measure.value)) {
                bad++; fail(`health: ${entry.date} ${key}.${measureKey} has an invalid score/value`);
              } else measureScores.push(measure.score);
              if (v3) {
                // like-for-like (1s) and windowed typical (1u) on every v3 measure
                if (!["sameAge", "mature", "ageFree"].includes(measure.ageBasis)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} scored without a known basis`); }
                if (measure.typical != null && (!Array.isArray(measure.window) || measure.window.length < BL.MIN_PEERS || measure.sample < BL.MIN_PEERS)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} has a typical from fewer than ${BL.MIN_PEERS} peers`); }
                if (measure.typical != null && measure.window.includes(measure.episodeRead)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} window includes the episode it reads`); }
                if (measure.typical != null && measure.window.length > BL.WINDOW_N) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} window exceeds WINDOW_N`); }
                const expectedNote = measure.ageBasis === "sameAge" ? BL.NOTES.sameAge : measure.ageBasis === "mature" ? BL.NOTES.mature : null;
                if ((measure.note ?? null) !== expectedNote) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} note does not match its basis`); }
                if (measure.absoluteScale && measure.typical != null) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} is absolute-scale yet carries a typical`); }
              }
            }
          }
          const expectedScore = measureScores.length ? Math.round(measureScores.reduce((sum, value) => sum + value, 0) / measureScores.length) : null;
          if (part.score !== expectedScore) { bad++; fail(`health: ${entry.date} ${key} score does not equal its available measures`); }
          if (part.score == null && (!part.reason || part.effectiveWeight !== 0)) { bad++; fail(`health: ${entry.date} ${key} absence lacks a reason or carries weight`); }
          if (part.score != null) {
            const expectedWeight = v3
              ? Math.round(effectiveWeightOf(part) * 10000) / 10000
              : Math.round(part.baseWeight / availableWeight * 10000) / 10000;
            if (part.effectiveWeight !== expectedWeight) { bad++; fail(`health: ${entry.date} ${key} shared weight is wrong`); }
            if (v3 && part.absoluteScale && part.effectiveWeight > part.baseWeight + 1e-9) { bad++; fail(`health: ${entry.date} ${key} is absolute-scale but absorbed redistributed weight`); }
          }
        }
        const recomputed = v3 ? health.deterministicMean(entry.subScores) : (() => {
          // pre-v3 entries shared weight among all available checks
          const avail = Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
          const wm = avail > 0 ? Math.round(Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.score * part.baseWeight / avail : 0), 0) * 10) / 10 : null;
          return { weightedMean: wm };
        })();
        if (entry.weightedMean !== recomputed.weightedMean) { bad++; fail(`health: ${entry.date} stored mean ${entry.weightedMean} != recomputed ${recomputed.weightedMean}`); }
        if (v3) {
          const expectedSet = expectedParts.filter((key) => Number.isFinite(entry.subScores[key]?.score)).sort();
          if (JSON.stringify([...(entry.checkSet || [])].sort()) !== JSON.stringify(expectedSet)) { bad++; fail(`health: ${entry.date} checkSet does not list exactly the scored checks`); }
        }
        if (Math.abs(entry.score - entry.weightedMean) > 8) { bad++; fail(`health: ${entry.date} model score moves more than eight points from the deterministic mean`); }
        if (entry.deviation !== Math.round((entry.score - entry.weightedMean) * 10) / 10) { bad++; fail(`health: ${entry.date} stored score move is wrong`); }
        try {
          health.validateSynthesis(
            { score: entry.score, headline: entry.headline, pros: entry.pros, cons: entry.cons, drivers: entry.drivers },
            { allowedScore: { min: Math.max(0, Math.ceil(entry.weightedMean - 8)), max: Math.min(100, Math.floor(entry.weightedMean + 8)) }, facts: entry.facts || [], checkSetChange: entry.checkSetChange ?? null },
          );
        } catch (error) {
          bad++; fail(`health: ${entry.date} model copy/grounding is invalid — ${error.message}`);
        }
      }

      const expectedProjection = health.projectHealth(store, { now: Date.parse(data.generatedAt) });
      if (JSON.stringify(data.health) !== JSON.stringify(expectedProjection)) {
        bad++; fail("health: data.json does not exactly project the latest saved entry and real history");
      }
      const latestEntry = store.entries.filter((entry) => entry.date <= currentDate).at(-1);
      const expectedReadState = Object.values(latestEntry?.subScores || {}).some((section) =>
        section?.score == null || Object.values(section?.measures || {}).some((measure) => measure?.score == null))
        || (latestEntry?.facts || []).some((fact) => fact?.requiredPhrase === "still early")
        ? "early" : "settled";
      if (data.health?.readState !== expectedReadState) {
        bad++; fail("health: the public early/settled state does not match the saved checks");
      }
      // the trend plots only entries written under the running formula (F5)
      const runningEntries = store.entries.filter((entry) => entry.date <= currentDate && entry.formulaVersion === health.FORMULA_VERSION);
      if (runningEntries.length < 7 && data.health?.trend != null) { bad++; fail("health: trend surfaced before seven real saved days under the running formula exist"); }
      if (runningEntries.length >= 7) {
        const expectedPoints = runningEntries.map((entry) => ({ date: entry.date, score: entry.score }));
        if (JSON.stringify(data.health?.trend?.points) !== JSON.stringify(expectedPoints)) { bad++; fail("health: trend points do not exactly match saved days under the running formula"); }
      }
      // freshness (1v, PRD v9 rule 15): the served read's age is stated; past
      // STALE_WITHHOLD_DAYS the score is withheld; a stale formula only warns
      if (latestEntry) {
        const age = Math.round((Date.parse(`${currentDate}T12:00:00Z`) - Date.parse(`${latestEntry.date}T12:00:00Z`)) / DAY);
        if (data.health?.ageDays !== age) { bad++; fail(`health: projected ageDays ${data.health?.ageDays} != ${age}`); }
        if (age > health.STALE_WITHHOLD_DAYS && (data.health?.withheld !== true || data.health?.score != null)) { bad++; fail(`health: the served read is ${age} days old and must be withheld`); }
        if (age <= health.STALE_WITHHOLD_DAYS && data.health?.withheld) { bad++; fail("health: a fresh read is wrongly withheld"); }
        if (age > 1) warn(`health: the served read is ${age} day(s) behind the data (saved ${latestEntry.date})`);
        if (latestEntry.formulaVersion !== health.FORMULA_VERSION) warn(`health: the served read was written under ${latestEntry.formulaVersion}; the running formula is ${health.FORMULA_VERSION} — the next successful run replaces it`);
      }

      const latest = store.entries.at(-1);
      // Same-day recompute only proves pipeline ordering when the entry was
      // written by the CURRENT formula version — an entry saved under an older
      // version legitimately cannot be reproduced by newer code.
      if (latest?.date === currentDate && latest.formulaVersion === health.FORMULA_VERSION) {
        try {
          const recomputed = health.computeHealthInputs({ data, now: Date.parse(latest.dataGeneratedAt), root: ROOT });
          if (recomputed.bundleHash !== latest.bundleHash || JSON.stringify(recomputed.subScores) !== JSON.stringify(latest.subScores) || JSON.stringify(recomputed.facts) !== JSON.stringify(latest.facts)) {
            bad++; fail("health: today's entry does not recompute from the current source stores");
          }
        } catch (error) {
          bad++; fail(`health: today's source recompute threw — ${error.message}`);
        }
      }
      if (!bad && store.entries.length) ok(`health: ${store.entries.length} saved day(s), deterministic mean and model move valid, bullets grounded, surface definition-locked`);
    }
  }
}

// --- 1i. plain reader-facing words (constitution rule 6) ---
{
  let bad = 0;
  const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
  const readerStrings = [];
  for (const insight of data.insights || []) {
    for (const key of ["text", "recommendation", "caveat"]) if (insight[key]) readerStrings.push(`insight ${insight.id} ${key}: ${insight[key]}`);
  }
  if (data.health) {
    readerStrings.push(`health headline: ${data.health.headline}`);
    for (const item of [...(data.health.pros || []), ...(data.health.cons || [])]) readerStrings.push(`health bullet: ${item.text}`);
  }
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    readerStrings.push(`Slack trends: ${build.trendsText(data)}`);
  } catch (err) {
    bad++; fail(`plain words: could not build the Slack text — ${err.message}`);
  }
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const about = html.match(/function buildAbout\(\) \{[\s\S]*?innerHTML = `([\s\S]*?)`;\n\}/)?.[1];
  if (!about) { bad++; fail("plain words: About copy could not be found in index.html"); }
  else readerStrings.push(`About: ${about.replace(/<[^>]+>/g, " ")}`);
  for (const line of readerStrings) {
    const hit = line.match(BANNED);
    if (hit) { bad++; fail(`plain words: reader-facing copy contains "${hit[0]}" — ${line.slice(0, 180)}`); }
  }
  if (!bad) ok("plain words: insights, Slack, and About avoid the banned dashboard jargon");
}

// --- 1j. trend and strip honesty gates (critic follow-up) ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/if\s*\(vals\.length\s*<\s*3\)/.test(html)) {
    bad++; fail("dashboard: first-week trend verdict is not gated until three clean weeks exist");
  }
  if (!/const p = DATA\.baselines\?\.pace\?\.\[e\.slug\];/.test(html)
    || /peers\.length < 3/.test(html)
    || /filter\(i => i\.id !== "pace-rank"\)/.test(html)
    || !/after three other episodes have real data at that age/.test(html)
    || !/appears after three of them have real data at that age/.test(html)) {
    bad++; fail("dashboard: same-age pace must be read from data.baselines.pace (never recomputed in the browser) and say so in the panel tip and About");
  }
  // quiet zone and bands are read from data.baselines.constants (PRD v9 rule 16);
  // the page carries no second definition of either
  if (!/const QUIET_ZONE = BASE_CONST\.QUIET_ZONE_PCT \?\? 5;/.test(html) || !/pct <= QUIET_ZONE/.test(html) || !/Math\.abs\(pct\) <= QUIET_ZONE/.test(html)
    || /pct\s*<=\s*5\b/.test(html) || /Math\.abs\(pct\)\s*<=\s*5\b/.test(html) || /> 0\.05\)/.test(html)) {
    bad++; fail("dashboard: comparison conclusions must read the quiet zone from data.baselines.constants and nowhere else");
  }
  if (!/score >= BANDS\.healthy/.test(html) || !/score >= BANDS\.steady/.test(html) || /score >= 55\b/.test(html)) {
    bad++; fail("dashboard: health bands must read data.baselines.constants.BANDS");
  }
  if (/provisional\s+—\s+settles/i.test(html)) {
    bad++; fail('dashboard: strip uses "provisional" instead of the plain "Not final" label');
  }
  // 21-day gate (W12): every score render goes through the finished-read gate,
  // and young episodes get wait-date words, never a number
  if (!html.includes("function healthOf(e) { return e.health && !e.health.pending && e.health.score != null ? e.health : null; }")) {
    bad++; fail("dashboard: episode health is not locked behind the finished-three-week gate (healthOf)");
  }
  // W15 (owner directive 2026-08-23): absence renders as absence — no wait
  // dates, no sat-out notes, no baseline chips. The gate itself still holds:
  // nothing score-like may render before healthOf() passes.
  if (/healthWaitDate|sat out|sets the baseline<\/span>|not in yet/.test(html)) {
    bad++; fail("dashboard: retired absence copy (wait dates, sat-out notes, baseline chips, not-in-yet suffixes) is back on a surface");
  }
  // W13/PRD v9 F29: the typical watch line is read from data.baselines.typicalCurve
  // (mature, unflagged curves, three or nothing) — never computed in the browser
  if (!/const typical = DATA\.baselines\?\.typicalCurve;/.test(html) || /curves\.length >= 3/.test(html) || /const mid = \(vals\)/.test(html)) {
    bad++; fail("dashboard: the typical watch line must be read from data.baselines.typicalCurve, never computed in the page");
  }
  // F16/F15: watched-vs-typical and the trend verdict read data.baselines too
  if (!/DATA\.baselines\?\.watchPctBySlug\?\.\[e\.slug\]\?\.typical/.test(html) || /const watchedVals = EPS\.map/.test(html)) {
    bad++; fail("dashboard: the table's watched typical must come from data.baselines.watchPctBySlug");
  }
  if (!/DATA\.baselines\?\.newestVsPrevious\?\.\[metric\]/.test(html) || /Climbing on the newest episode/.test(html)) {
    bad++; fail("dashboard: the trend-card verdict must compare like for like from data.baselines.newestVsPrevious");
  }
  if (!/health read is \$\{h\.withheld \? "withheld" : "behind"\}/.test(html)) {
    bad++; fail("dashboard: the header stamp must say when the saved health read is behind the data (D5)");
  }
  if (/"<th>Episode<\/th>[^\n]*\$\{PLOGO/.test(html)) { bad++; fail("dashboard: the table header is not a template literal (F25)"); }
  if (!bad) ok("dashboard honesty: trend waits for three clean weeks, scores wait for finished three-week reads, plain words throughout");
}

// --- 1j2. missing dashboard values never become visible zeroes ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const tooltipSource = html.match(/function externalTooltip\(context\) \{[\s\S]*?\n\}\n\nlet chart;/)?.[0] || "";
  const tableSource = html.match(/function buildTable\(\) \{[\s\S]*?\n\}\n\n\/\* M-1/)?.[0] || "";
  if (!tooltipSource || !tableSource) {
    bad++; fail("dashboard absence: could not locate tooltip and table renderers");
  } else if (/\?\?\s*0/.test(tooltipSource + tableSource)) {
    bad++; fail("dashboard absence: a tooltip or table can turn a missing value into zero");
  }
  if (!/function metricText\(value, missing = "–"\) \{ return value == null \? missing : nfmt\(value\); \}/.test(html)) {
    bad++; fail("dashboard absence: the shared missing-value formatter could hide a real zero or lacks a plain missing state");
  }
  if (!bad) ok("dashboard absence: tables and tooltips keep missing values distinct from real zeroes");
}

// --- 1k. W12 card layout and progressive-disclosure contract ---
// The page is a card system: health cards (gauge → diagnosis → today's read),
// then the latest-episode and growth-trend cards, then the episode carousel
// ABOVE the chart (owner directive 2026-08-23), panel and evidence on demand.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const between = (start, end) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from + start.length);
    return from >= 0 && to > from ? html.slice(from, to) : "";
  };
  const healthSource = between("function buildHealth()", "/* ================= hero");
  const heroSource = between("function buildHero()", "/* ================= episode carousel");
  const stripSource = between("function buildStrip()", "/* ================= detail panel");
  const panelSource = between("function buildPanel()", "/* ================= drilldown modal");
  const compoundSource = between("function buildCompound()", "function renderDrill()");
  const chipSource = between("function healthChip(", "function healthTipHTML");

  if (!healthSource || !heroSource || !stripSource || !panelSource || !compoundSource || !chipSource) {
    bad++; fail("card layout: could not locate every dashboard surface in index.html");
  } else {
    // reading order: health cards → latest/trend cards → carousel → panel → chart
    const order = ['id="health"', 'id="hero"', 'id="strip"', 'id="chartcard"', 'id="panel"'].map((m) => html.indexOf(m));
    if (order.some((at) => at < 0) || order.some((at, i) => i > 0 && at < order[i - 1])) {
      bad++; fail("card layout: locked order broken — health, latest episode, episode carousel, the chart, then the panel (the chart must never be displaced by an open panel)");
    }
    // glance-number discipline: gauge 1; hero one primary number per tab;
    // cards one primary number per tab; the health chip exactly one score
    if ((healthSource.match(/data-fold-number/g) || []).length !== 1) {
      bad++; fail("card layout: the gauge must contribute exactly its saved score to the glance-number budget");
    }
    // one tagged number per measure branch (views/watched/live/reach); exactly
    // one branch ever renders, so the glance budget stays at one number
    if ((heroSource.match(/data-fold-number/g) || []).length !== 4) {
      bad++; fail("card layout: the hero must expose exactly one primary number per measure branch");
    }
    if ((stripSource.match(/data-fold-number/g) || []).length !== 2) {
      bad++; fail("card layout: each episode card must expose exactly one tagged glance number per measure branch");
    }
    // the hero and the cards follow the chart: same measure, same selection
    if (!/const sel = state\.solo \|\| state\.panel/.test(heroSource)
      || !/heroMetricKey\(\)/.test(heroSource) || !/heroMetricKey\(\)/.test(stripSource)
      || !/function heroMetricKey\(\) \{ return state\.mode === "live" \? "live" : state\.metric; \}/.test(html)) {
      bad++; fail("card layout: the hero and episode cards must read the chart's measure and its selected episode (latest when none)");
    }
    // the Growth/Live page tabs are retired: the chart's own views are the
    // only view switch, and they carry the tablist semantics
    if (/id="view"/.test(html) || /class="tabs"/.test(html)) {
      bad++; fail("card layout: the retired Growth/Live page tabs are back");
    }
    if (!/<div class="viewmenu" id="viewmenu" role="listbox"/.test(html) || !/mode: "live"/.test(html)) {
      bad++; fail("card layout: the chart view switch must be the one dropdown and must carry the live per-minute view");
    }
    if ((chipSource.match(/data-fold-number/g) || []).length !== 1) {
      bad++; fail("card layout: the health chip must carry exactly one tagged score");
    }
    // diagnosis: the six saved checks render as plain-word states from the
    // projection only — never from scoring inputs, never as numbers
    if (!/h\.checks/.test(healthSource) || !/checkState/.test(healthSource) || !/Not in yet/.test(html)) {
      bad++; fail("card layout: the diagnosis card does not render every saved check as a plain-word state");
    }
    // diagnosis drill (owner directive 2026-08-23): every row is a keyboard-
    // reachable tooltip target whose numbers come from the projection's saved
    // measures — value against typical, stored reason when absent
    if (!/c\.measures/.test(healthSource) || !/MEASURE_WORDS/.test(healthSource)
      || !healthSource.includes('<div class="checkrow" tabindex="0" data-stat=')) {
      bad++; fail("card layout: diagnosis rows must offer saved-measure drill tooltips (value vs typical), keyboard-reachable");
    }
    // Today's read (owner directive 2026-08-23): the grounded headline plus
    // the top do-next actions read verbatim from the saved recommendation
    // store — no methodology copy on the card (About carries it)
    if (!/DATA\.insights/.test(healthSource) || !/esc\(r\.recommendation\)/.test(healthSource)
      || !/esc\(h\.headline\)/.test(healthSource) || /Saved once a day:/.test(healthSource)) {
      bad++; fail("card layout: Today's read must lead with the saved headline and store-backed do-next actions, without methodology copy");
    }
    // the do-next actions are plain ranked rows: no tooltips, no rules, and
    // the leading ordinal is decorative only (owner directive 2026-08-23)
    if (/class="dnrow"[^`]*data-tip/.test(healthSource) || /\.dnrow \+ \.dnrow \{ border-top/.test(html)
      || !/<span class="dnnum" aria-hidden="true">\$\{i \+ 1\}<\/span>/.test(healthSource)) {
      bad++; fail("card layout: Today's read actions must be plain ranked rows — decorative ordinal, no tooltip, no dividing rule");
    }
    // the hero states one measure: episode health rides the cards and panel
    if (/healthChip\(/.test(heroSource)) {
      bad++; fail("card layout: the hero must not carry the episode-health chip");
    }
    // "Why this score" lives under the gauge, before the diagnosis card
    if (!(healthSource.indexOf('id="whyscore"') > -1 && healthSource.indexOf('id="whyscore"') < healthSource.indexOf('hc-diag'))) {
      bad++; fail("card layout: the Why-this-score disclosure must sit under the gauge, ahead of the diagnosis card");
    }
    // evidence: starts closed, is a real disclosure, and carries every saved fact
    if (!/evidenceOpen: false/.test(html) || !/state\.evidenceOpen/.test(healthSource)
      || !/aria-expanded/.test(healthSource)
      || !healthSource.includes("bullets(h.pros") || !healthSource.includes("bullets(h.cons")) {
      bad++; fail("card layout: health evidence must start closed behind a real button and contain every exact saved fact");
    }
    // Retired 2026-08-23 (owner directive): the saved-age and early-read line
    // is off the card. Freshness lives in the header stamp, and an early read
    // shows itself as a diagnosis check that isn't in yet — so the gate still
    // holds without a status line announcing it.
    if (/Updated \$\{esc\(saved\)\}/.test(healthSource) || /Early read/.test(healthSource)) {
      bad++; fail("card layout: the retired saved-age / early-read line is back on the health surface");
    }
    if (!/document\.createElement\("button"\)/.test(stripSource) || !/it\.type = "button"/.test(stripSource)) {
      bad++; fail("card layout: episode cards are not real keyboard-operable buttons");
    }
    // locked carousel order: oldest → newest with the newest landed in view
    if (!/strip\.scrollLeft = strip\.scrollWidth/.test(stripSource)) {
      bad++; fail("card layout: the carousel does not land on the newest episode (far right, locked rule)");
    }
    // the one freshness statement left on the page still reads as words
    if (!/relativeDayWords\(phoenixDateKey\(DATA\.generatedAt\)\)/.test(html)
      || !/Data refreshed \$\{esc\(when\)\}/.test(html)) {
      bad++; fail("card layout: the header freshness stamp must render as relative words, not numeric tokens");
    }
    if (/addSentimentChip|chip\.senti/.test(html) || !/Audience feedback/.test(panelSource)) {
      bad++; fail("card layout: audience feedback counts must live only in the click-open episode panel");
    }
    if (/sameAgeSub\s*\(/.test(stripSource) || /class=["']r3["']/.test(stripSource)) {
      bad++; fail("card layout: pace and status lines still render on the episode cards");
    }
    if (!/const pace = sameAgeSub\(e\)/.test(panelSource) || !/YouTube views at the same age/.test(panelSource)) {
      bad++; fail("card layout: the same-age pace comparison is not present in the click-open episode panel");
    }
    // trend card (re-ruled 2026-08-23): bars name value and episode in small
    // print with ONE emphasized bar — still no tagged glance numbers and no
    // clean-week bookkeeping copy
    if (/data-fold-number|clean weeks:/.test(compoundSource)) {
      bad++; fail("card layout: the trend card must not tag glance numbers or carry clean-week counts");
    }
    if (!/class="bnum"/.test(compoundSource) || !/class="bep"/.test(compoundSource)
      || (compoundSource.match(/cbar\$\{hot \? " hot" : ""\}/g) || []).length !== 2) {
      bad++; fail("card layout: trend bars must label value and episode with one emphasized bar, in both trend branches");
    }
    if (!/splitReady = Number\.isFinite\(tv\)[\s\S]*yt \+ x === tv/.test(heroSource)
      || /e\.latest\.(?:ytTotal|xPlays) \?\? 0/.test(heroSource)) {
      bad++; fail("card layout: the platform bar is not locked to complete stored YouTube and X values");
    }
    // the panel must explain the score's basis and its missing checks
    if (!/Episode health/.test(panelSource) || !/healthOf\(e\)/.test(panelSource) || !/newer episodes never change this score/.test(panelSource)) {
      bad++; fail("card layout: the episode panel does not gate and explain the finished score");
    }
    if (!/How people watch/.test(panelSource) || !/Where views came from/.test(panelSource)) {
      bad++; fail("card layout: the episode panel is missing its watching and view-source sections");
    }
    if (!html.includes('role="listbox"') || !/setAttribute\("aria-selected"/.test(html)
      || !/addEventListener\("focusin"[\s\S]*showRtt/.test(html)) {
      bad++; fail("card layout: the view switch or health-chip help is not keyboard-readable");
    }
  }
  if (!bad) {
    const latest = data.episodes?.at(-1);
    const finished = (data.episodes || []).filter((e) => e.health && !e.health.pending && e.health.score != null).length;
    const cardNumbers = (data.episodes || []).filter((e) => (e.latest?.totalViews ?? e.latest?.ytTotal) != null).length;
    const heroChip = latest?.health && !latest.health.pending && latest.health.score != null ? 1 : 0;
    const literalBudget = (data.health ? 1 : 0) + 1 + heroChip + cardNumbers + finished;
    ok(`card layout: ${literalBudget} visible numeric tokens at glance (gauge, hero, ${cardNumbers} card totals, ${finished} finished read(s)); evidence, panel, feedback, and pace are on demand`);
  }
}

// --- 1p. chart metric picker + platform marks (owner directives 2026-08-23) ---
// Each alternate measure charts one stored per-episode number in its own
// unit; nothing is summed across units, a missing value never becomes a zero
// bar, and the live tooltip carries the episode's lowest/highest concurrents.
// Platform marks always keep an accessible text name.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  // A template placeholder inside a QUOTED string never interpolates — it
  // renders as literal ${...} text on the page (the table header shipped
  // that way 2026-08-23). Quoted strings must not carry placeholders.
  for (const m of html.matchAll(/[+=]=? ("[^"\n]*\$\{[^"\n]*"|'[^'\n]*\$\{[^'\n]*')/g)) {
    bad++; fail(`template hygiene: a quoted string carries an uninterpolated placeholder — ${m[1].slice(0, 60)}`);
  }
  // ONE control for one decision (owner directive 2026-08-23): every chart the
  // dashboard draws lives in a single dropdown whose current item IS the
  // heading. No parallel tab strip, no native select.
  const defsBlock = html.match(/const VIEW_DEFS = \[([\s\S]*?)\n\];/)?.[1] || "";
  const defs = [...defsBlock.matchAll(/\{ key: "([a-z]+)", group: "([^"]+)", title: "([^"]+)", mode: "([a-z]+)"(?:, metric: "([a-z]+)")? \}/g)]
    .map(([, key, group, title, mode, metric]) => ({ key, group, title, mode, metric }));
  if (defs.length < 5) { bad++; fail("chart metrics: the view list could not be read — every chart must be declared in VIEW_DEFS"); }
  const modes = new Set(defs.map((d) => d.mode));
  for (const required of ["standings", "race", "watch", "live"]) {
    if (!modes.has(required)) { bad++; fail(`chart metrics: the view list is missing the ${required} chart`); }
  }
  for (const metric of ["views", "watched", "live", "reach"]) {
    if (!defs.some((d) => d.mode === "standings" && d.metric === metric)) {
      bad++; fail(`chart metrics: the per-episode ${metric} measure is missing from the view list`);
    }
  }
  if (/id="mode"/.test(html) || /data-v="standings"/.test(html) || /<select id="metric"/.test(html)) {
    bad++; fail("chart metrics: the retired tab strip or native measure select is back — one dropdown owns this decision");
  }
  if (!/<button type="button" class="viewbtn" id="viewbtn" aria-haspopup="listbox"/.test(html)
    || !/<div class="viewmenu" id="viewmenu" role="listbox"/.test(html)
    || !/o\.setAttribute\("role", "option"\)/.test(html)
    || !/o\.setAttribute\("aria-selected", String\(selected\)\)/.test(html)
    || !/ev\.key === "Escape"/.test(html) || !/ev\.key === "ArrowDown"/.test(html)) {
    bad++; fail("chart metrics: the view dropdown must be a keyboard-operable listbox whose button reports its expanded state");
  }
  // a scope tag never repeats the heading, and never rides on gray text alone
  if (!/function scopeTag\(mark, name\)/.test(html) || !/<span class="sr">\$\{esc\(name\)\}<\/span>/.test(html)) {
    bad++; fail("chart metrics: platform scope tags must carry a spoken name beside the mark");
  }
  for (const d of defs) {
    const scopes = [...html.matchAll(new RegExp(`METRIC_TITLES\\.${d.metric}, \`([^\`]*)\``, "g"))].map((m) => m[1]);
    for (const scope of scopes) {
      if (scope.includes(d.title)) { bad++; fail(`chart metrics: the ${d.key} scope line repeats its own heading ("${d.title}")`); }
    }
  }
  // hero split bar: both the segments and their labels explain themselves,
  // from one definition, with the labels keyboard-reachable
  if (!/function splitBar\(segments, wholeWords\)/.test(html)
    || !/<span class="pseg"[^`]*\$\{tip\}/.test(html)
    || !/<span class="sl" \$\{tip\} tabindex="0" aria-label=/.test(html)
    || (html.match(/html \+= splitBar\(/g) || []).length !== 2) {
    bad++; fail("chart metrics: the hero split bar's segments and labels must share one tooltip definition and stay keyboard-reachable");
  }
  // one text edge inside the chart tooltip: chips hang in a fixed gutter
  if (!/\.tt \{ --chip: 15px; \}/.test(html)
    || !/\.tt \.meta, \.tt \.big, \.tt \.chg, \.tt \.note \{ padding-left: var\(--chip\); \}/.test(html)) {
    bad++; fail("chart metrics: the chart tooltip's title, number, and rows must share one left text edge");
  }
  // bar totals anchor to the rightmost VISIBLE segment and count only what is
  // drawn — hiding a destination from the legend must never strand the label
  // on the axis or leave it describing bars that are off screen
  const totalsPlugin = html.match(/const barTotals = \{[\s\S]*?\n\};/)?.[0] || "";
  if (!/chart\.isDatasetVisible\(meta\.index\)/.test(totalsPlugin)
    || !/const endX = Math\.max\(\.\.\.bars\.map\(\(b\) => b\.x\)\);/.test(totalsPlugin)
    || !/const whole = visible\.length === chart\.data\.datasets\.length;/.test(totalsPlugin)
    || !/const total = whole \? \(e\.latest\.totalViews \?\? e\.latest\.ytTotal\) : drawn;/.test(totalsPlugin)
    || /getDatasetMeta\(chart\.data\.datasets\.length - 1\)/.test(totalsPlugin)
    || !/const segVis = chart\.data\.datasets\.map\(\(_, di\) => chart\.isDatasetVisible\(di\)\);/.test(html)
    || !/across shown destinations/.test(html)) {
    bad++; fail("chart metrics: bar totals AND the tooltip must follow legend visibility — one rule for both numbers");
  }
  // reader-facing prose rows fill their card: no arbitrary character caps
  if (/\.insight \.body \{[^}]*max-width/.test(html) || /\.health-evidence li span \{[^}]*max-width/.test(html)) {
    bad++; fail("chart metrics: insight and evidence rows must fill the card, not a fixed character measure");
  }
  if (!/state\.metric = "views"; state\.byDate = false/.test(html) && !/state\.metric = "views";/.test(html)) {
    bad++; fail("chart metrics: reset does not restore the views measure");
  }
  if (!html.includes("watched: { get: (e) => e.watch?.avgPercent ?? null")
    || !html.includes("live: { get: (e) => e.live?.avg ?? null")
    || !html.includes("reach: { get: (e) => e.latest?.xImpressions ?? null")) {
    bad++; fail("chart metrics: each measure must read exactly its stored per-episode number, null when absent (never zero)");
  }
  if (!/state\.metric === "live" && ep\.live/.test(html)
    || !html.includes(">Lowest<") || !html.includes(">Highest<")) {
    bad++; fail("chart metrics: the live tooltip must show the episode's lowest and highest concurrents");
  }
  if (!/Exposure, not watching — never added into views/.test(html)) {
    bad++; fail("chart metrics: the reach view must state its unit is exposure, outside every views total");
  }
  const logoCount = (html.match(/role="img" aria-label="(?:YouTube|X)"/g) || []).length;
  if (logoCount !== 2 || !/const PLOGO = \{/.test(html) || !/TT_HTML/.test(html)) {
    bad++; fail("platform marks: the YouTube and X logos must exist exactly once each, with accessible names, and label the destination rows");
  }
  if (!bad) ok("chart metrics: measure picker unit-scoped with silent absence, live lowest/highest on the tooltip, platform marks accessibly named");
}

// --- 1q. one page gutter (owner directive 2026-08-23) ---
// Every card, column, and row on the page grid shares a single spacing token,
// and any container inset (scroll padding, borders) is compensated so the
// PAINTED card edges land on the same grid. Measured in a browser at both
// widths on 2026-08-23: all edges flush, every gap identical.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/--gap: 14px;/.test(html) || !/:root \{ --gap: 10px; \}/.test(html)) {
    bad++; fail("page gutter: the spacing token must be defined once for desktop and once for the phone cut");
  }
  const GUTTERED = [
    [".healthrow", /\.healthrow \{[^}]*gap: var\(--gap\); margin-bottom: var\(--gap\);/],
    [".overview", /\.overview \{[^}]*gap: var\(--gap\); margin-bottom: var\(--gap\);/],
    [".carousel", /\.carousel \{ display: flex; gap: var\(--gap\);/],
    ["#chartcard", /#chartcard \{[^}]*margin-bottom: var\(--gap\);/],
    [".panel", /\.panel \{[^}]*padding: var\(--gap\); margin: var\(--gap\) 0;/],
    [".pgrid", /\.panel \.pgrid \{[^}]*gap: var\(--gap\); margin-top: var\(--gap\);/],
    [".insights", /\.insights \{ display: grid; gap: var\(--gap\); \}/],
    ["header", /header \{[^}]*margin-bottom: var\(--gap\);/],
  ];
  for (const [name, re] of GUTTERED) {
    if (!re.test(html)) { bad++; fail(`page gutter: ${name} does not use the shared spacing token`); }
  }
  // page cards carry no border: the fill is the whole edge, so nothing eats
  // into the gutter (the panel's inset is the token exactly)
  for (const [name, re] of [[".card", /\.card \{ background: var\(--s1\); border: 0;/],
    ["#chartcard", /#chartcard \{ background: var\(--s1\); border: 0;/],
    [".sitem", /\.sitem \{[^}]*border: 0;/], [".insight", /\.insight \{ background: var\(--s1\); border: 0;/],
    [".panel", /\.panel \{ background: var\(--s2\); border: 0;/]]) {
    if (!re.test(html)) { bad++; fail(`page gutter: ${name} still draws a border — cards are fill only`); }
  }
  // the carousel's focus-ring inset must be pulled back out, or its cards sit
  // off the grid every other row lands on
  if (!/\.carousel \{[^}]*padding: 2px;\s*\n\s*margin: -2px -2px calc\(var\(--gap\) - 2px\);/.test(html)) {
    bad++; fail("page gutter: the carousel's scroll inset is not compensated — its painted card edges would sit inside the page grid");
  }
  if (!bad) ok("page gutter: one spacing token drives every card, column, and row; container insets compensated so painted edges align");
}

// --- 1r. destination links (W18): stored, recomputed from the registry, opened safely ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const e of eps) {
    const show = registry.shows.find((s) => s.slug === e.slug);
    const expected = {};
    for (const t of show?.targets || []) {
      if (t.kind === "youtube" && t.videoId) expected[`yt:${t.account}`] = `https://youtube.com/watch?v=${t.videoId}`;
      if (t.kind === "x" && t.role !== "promo") {
        if (t.broadcastId) expected[`x:${t.account}`] = `https://x.com/i/broadcasts/${t.broadcastId}`;
        else if (t.postId) expected[`x:${t.account}`] = `https://x.com/${t.account}/status/${t.postId}`;
      }
    }
    const want = Object.keys(expected).length ? expected : undefined;
    if (JSON.stringify(e.links ?? null) !== JSON.stringify(want ?? null)) { bad++; fail(`links: ${e.slug} stored destination links do not recompute from the registry`); }
    for (const url of Object.values(e.links || {})) {
      if (!/^https:\/\/(youtube\.com\/watch\?v=[A-Za-z0-9_-]+|x\.com\/(i\/broadcasts\/[A-Za-z0-9]+|[A-Za-z0-9_]+\/status\/\d+))$/.test(url)) {
        bad++; fail(`links: ${e.slug} link has an unexpected shape — ${url}`);
      }
    }
  }
  if (!html.includes('const url = e.links?.[d.key];')
    || !/class="plink" href="\$\{esc\(url\)\}" target="_blank" rel="noopener">/.test(html)) {
    bad++; fail("links: the panel must render destination links only from stored e.links, opened in a new tab with noopener");
  }
  if (!bad) ok(`links: ${eps.filter((e) => e.links).length} episode(s) store destination links — registry-locked, safe URL shapes, panel renders only what is stored`);
}

// --- 1u. baselines (PRD v9 W22a): one definition of "typical", re-derived and fixture-tested ---
{
  let bad = 0;
  try {
    execFileSync(process.execPath, [join(HERE, "baselines.test.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    bad++; fail(`baselines: fixture test failed — ${String(err.stderr || err.message).split("\n").find((l) => /AssertionError|Error/.test(l)) || err.message}`);
  }
  let B = null;
  try { B = await import(join(TOOL, "baselines.mjs")); }
  catch (err) { bad++; fail(`baselines: module failed to load — ${err.message}`); }
  if (B) {
    const shipped = data.baselines;
    if (!shipped) { bad++; fail("baselines: data.json carries no baselines projection"); }
    else {
      const again = B.computeBaselines(eps);
      if (JSON.stringify(again) !== JSON.stringify(shipped)) { bad++; fail("baselines: data.baselines does not re-derive from the shipped episodes"); }
      if (JSON.stringify(shipped.constants) !== JSON.stringify(B.CONSTANTS)) { bad++; fail("baselines: shipped constants differ from baselines.mjs"); }
      if (shipped.constants.MIN_PEERS < 3) { bad++; fail("baselines: MIN_PEERS below the constitution's small-n rule"); }
      for (const [slug, a] of Object.entries(shipped.anomaly)) {
        for (const [unit, u] of Object.entries(a.units)) {
          if (u.window.includes(slug)) { bad++; fail(`baselines: ${slug} ${unit} outlier window includes itself`); }
          if (u.tier != null && u.n < shipped.constants.MIN_PEERS) { bad++; fail(`baselines: ${slug} ${unit} outlier test ran on ${u.n} peers`); }
          if (u.flag && a.flagged !== true) { bad++; fail(`baselines: ${slug} ${unit} flags but the episode is not marked flagged`); }
        }
        if (a.flagged && a.provisional !== Object.values(a.units).some((u) => u.flag && u.tier !== 1)) { bad++; fail(`baselines: ${slug} provisional stamp disagrees with its tiers`); }
      }
      for (const [slug, p] of Object.entries(shipped.pace)) {
        if (p && p.peers.includes(slug)) { bad++; fail(`baselines: ${slug} pace peers include itself`); }
        if (p && p.rank != null && p.n < shipped.constants.MIN_PEERS) { bad++; fail(`baselines: ${slug} pace ranked on ${p.n} peers`); }
        if (p && p.rank == null && !p.reason) { bad++; fail(`baselines: ${slug} pace absent without a reason`); }
        for (const x of p?.peers || []) if (shipped.anomaly[x]?.flagged) { bad++; fail(`baselines: ${slug} pace peers include outlier ${x}`); }
      }
      const flagsAgain = B.anomalyFlags(eps);
      for (const e of eps) {
        const want = flagsAgain.get(e.slug)?.text ?? null;
        if ((e.metrics?.anomaly ?? null) !== want) { bad++; fail(`baselines: ${e.slug} metrics.anomaly does not match the baselines outlier test`); }
      }
      if (shipped.typicalCurve.points && shipped.typicalCurve.n < shipped.constants.MIN_PEERS) { bad++; fail("baselines: typical curve drawn from fewer than MIN_PEERS curves"); }
      for (const x of shipped.typicalCurve.window) if (shipped.anomaly[x]?.flagged) { bad++; fail(`baselines: typical curve includes outlier ${x}`); }
      if (shipped.watchPct.typical != null && shipped.watchPct.n < shipped.constants.MIN_PEERS) { bad++; fail("baselines: watched typical from fewer than MIN_PEERS episodes"); }
    }
  }
  if (!bad) ok(`baselines: fixture test green; data.baselines re-derives — ${Object.values(data.baselines?.anomaly || {}).filter((a) => a.flagged).length} outlier(s), windows exclude self and outliers, nothing below ${data.baselines?.constants?.MIN_PEERS} peers`);
}

// --- 1v. chain freshness (PRD v9 W24): every required input store is fresh against the chain definition ---
{
  let bad = 0;
  let chain = null;
  try { chain = JSON.parse(readFileSync(join(TOOL, "chain.json"), "utf8")); } catch (err) { bad++; fail(`chain: tools/dive-analytics/chain.json unreadable — ${err.message}`); }
  if (chain) {
    const builtAt = Date.parse(data.generatedAt);
    const publishIdx = chain.steps.findIndex((s) => s.step === "publish");
    const order = chain.steps.map((s) => s.step);
    for (const must of ["snapshot", "ratings", "build-data", "validate", "publish"]) if (!order.includes(must)) { bad++; fail(`chain: step ${must} missing from chain.json`); }
    if (order.lastIndexOf("validate") > publishIdx || order.indexOf("health") > order.lastIndexOf("build-data")) { bad++; fail("chain: validate must run before publish and health before the final build-data"); }
    const within60d = (slug) => { const e = eps.find((x) => x.slug === slug); return e && e.ageDays <= 60; };
    const active = (slug) => { const e = eps.find((x) => x.slug === slug); return !!e; };
    const inScope = (scope, slug) => scope === "all" || (scope === "episodes-within-60d" ? within60d(slug) : active(slug));
    for (const step of chain.steps) {
      if (!step.freshnessKey) continue;
      for (const pattern of step.writes) {
        if (!pattern.includes("*")) {
          const path = join(ROOT, pattern);
          if (!existsSync(path)) { if (step.required) { bad++; fail(`chain: required store ${pattern} is missing`); } continue; }
          let stamp = null;
          try {
            const j = JSON.parse(readFileSync(path, "utf8"));
            stamp = step.freshnessKey === "updatedAt" ? j.updatedAt : step.freshnessKey === "generatedAt" ? j.generatedAt : step.freshnessKey === "entries[-1].date" ? `${j.entries?.at(-1)?.date}T12:00:00Z` : null;
          } catch { /* non-JSON */ }
          if (!stamp) continue;
          const lag = builtAt - Date.parse(stamp);
          if (lag > FRESH_MS) {
            const msg = `chain: ${pattern} is ${Math.round(lag / 3600000)} h behind the build (${stamp})`;
            if (step.required) { bad++; fail(msg); } else warn(msg);
          }
          continue;
        }
        const dir = join(ROOT, pattern.slice(0, pattern.lastIndexOf("/")));
        const ext = pattern.slice(pattern.lastIndexOf("."));
        if (!existsSync(dir)) { if (step.required && step.freshnessKey !== "updatedAt") { bad++; fail(`chain: required store directory ${dir} is missing`); } continue; }
        for (const file of readdirSync(dir).filter((f) => f.endsWith(ext))) {
          const slug = file.slice(0, -ext.length);
          if (!inScope(step.scope, slug)) continue;
          const path = join(dir, file);
          let stamp = null;
          try {
            if (ext === ".jsonl") { const lines = readFileSync(path, "utf8").split("\n").filter(Boolean); stamp = lines.length ? JSON.parse(lines.at(-1)).pulledAt : null; }
            else { const j = JSON.parse(readFileSync(path, "utf8")); stamp = step.freshnessKey === "snapshots[-1].ts" ? j.snapshots?.at(-1)?.ts : j.updatedAt; }
          } catch { /* unreadable */ }
          if (!stamp) continue;
          const lag = builtAt - Date.parse(stamp);
          if (lag > FRESH_MS) {
            const msg = `chain: ${pattern.replace("*", slug)} is ${Math.round(lag / 3600000)} h behind the build (${stamp})`;
            if (step.required && ext !== ".jsonl") { bad++; fail(msg); } else warn(msg);
          }
        }
      }
    }
    const publish = readFileSync(join(ROOT, "scripts", "restream", "postlive-publish.sh"), "utf8");
    if (!/git pull --rebase/.test(publish) || publish.indexOf("git pull --rebase") > publish.indexOf("git push origin main")) { bad++; fail("chain: publish must pull --rebase before it pushes main (F26)"); }
  }
  if (!bad) ok(`chain: ${chain?.steps.length ?? 0} steps defined; required input stores are within ${FRESH_MS / 3600000} h of the build; publish pulls before it pushes`);
}

// --- 1x/1y/1z (PRD v9 W26): small-n on data, no trend words over episode health, stored notes only ---
{
  let bad = 0;
  const BL = await import(join(TOOL, "baselines.mjs"));
  const build = await import(join(TOOL, "build-data.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const TREND_WORDS = /\b(trending|improving|declining|climbing|slipping|best|worst|getting|trajectory)\b/i;
  // 1x: every Slack or alert line with a direction rests on MIN_PEERS or more
  const slackLines = build.trendsLines(data);
  for (const line of slackLines) {
    if (line.direction && !(line.sample >= BL.MIN_PEERS)) { bad++; fail(`small-n: Slack line carries a direction on ${line.sample} samples — ${line.text.slice(0, 80)}`); }
    if (line.kind !== "insight" && line.direction == null && /\btrending (up|down)\b/i.test(line.text)) { bad++; fail(`small-n: Slack line says trending without a stamped direction — ${line.text.slice(0, 80)}`); }
  }
  if (build.trendsText(data) !== ["", "Trends", ...slackLines.map((l) => l.text)].join("\n")) { bad++; fail("small-n: trendsText does not join trendsLines — two definitions of the Slack block"); }
  try {
    const alerts = await import(join(TOOL, "alerts.mjs"));
    let prev = null;
    try { prev = JSON.parse(readFileSync(join(ROOT, "data", "restream", "alerts-state.json"), "utf8")); } catch { /* first run */ }
    if (prev) {
      for (const line of alerts.alertLines(prev, alerts.snapshotState(data), data)) {
        if (line.direction && !(line.sample >= BL.MIN_PEERS)) { bad++; fail(`small-n: alert carries a direction on ${line.sample} samples — ${line.text.slice(0, 80)}`); }
      }
    }
  } catch (err) { bad++; fail(`small-n: alerts.mjs failed to load — ${err.message}`); }
  // 1y: the episode-health sequence is never read as a trend
  for (const line of slackLines.filter((l) => l.kind === "episode-health")) {
    if (TREND_WORDS.test(line.text)) { bad++; fail(`episode health: Slack sequence uses a trend word — ${line.text.slice(0, 80)}`); }
  }
  const aboutHealth = html.match(/<p><b>Episode health<\/b>[\s\S]*?<\/p>/)?.[0] || "";
  if (!aboutHealth || TREND_WORDS.test(aboutHealth.replace(/<[^>]+>/g, ""))) { bad++; fail("episode health: About paragraph missing or uses a trend word over the sequence"); }
  if (!/measured against different earlier episodes/.test(aboutHealth)) { bad++; fail("episode health: About must say two scores were measured against different earlier episodes"); }
  for (const fn of ["healthChip", "healthTipHTML", "healthCell"]) {
    const src = html.match(new RegExp(`(?:function ${fn}\\(|const ${fn} = )[\\s\\S]*?\\n(?:\\}|      html \\+=)`))?.[0] || "";
    if (TREND_WORDS.test(src)) { bad++; fail(`episode health: ${fn} carries a trend word`); }
  }
  // 1z: notes are the fixed strings from baselines.mjs; reasons and notes pass the plain-words ban
  const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b/i;
  const allowedNotes = new Set([BL.NOTES.sameAge, BL.NOTES.mature]);
  let healthStore = null;
  try { healthStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "health-history.json"), "utf8")); } catch { /* absent */ }
  const newestEntry = healthStore?.entries?.at(-1);
  if (newestEntry) {
    for (const [key, part] of Object.entries(newestEntry.subScores || {})) {
      if (part.reason && BANNED.test(part.reason)) { bad++; fail(`notes: health ${key} reason uses banned words — ${part.reason}`); }
      for (const [mk, m] of Object.entries(part.measures || {})) {
        if (m.note != null && !allowedNotes.has(m.note)) { bad++; fail(`notes: health ${key}.${mk} note is not one of the fixed strings`); }
        if (m.reason && BANNED.test(m.reason)) { bad++; fail(`notes: health ${key}.${mk} reason uses banned words — ${m.reason}`); }
      }
    }
  }
  let ratings = null;
  try { ratings = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  for (const r of ratings?.scores || []) {
    if (r.reason && BANNED.test(r.reason)) { bad++; fail(`notes: episode health ${r.slug} reason uses banned words`); }
    for (const [c, cs] of Object.entries(r.checks || {})) {
      if (cs.note != null && !allowedNotes.has(cs.note)) { bad++; fail(`notes: episode health ${r.slug} ${c} note is not one of the fixed strings`); }
      if (cs.reason && BANNED.test(cs.reason)) { bad++; fail(`notes: episode health ${r.slug} ${c} reason uses banned words`); }
    }
  }
  // the drill-in tooltip is the structured measure-block layout (owner
  // directive 2026-08-23): the builder must carry each measure's stored note
  // into the block payload, and the renderer must draw it as its own line
  if (!/note: m\.note \|\| null/.test(html)
    || !/m\.note \? `<div class="mnote">\$\{esc\(m\.note\)\}<\/div>` : ""/.test(html)
    || !/const rowTip = c\.note \? `\$\{tip\} — \$\{c\.note\}` : tip;/.test(html)) {
    bad++; fail("notes: the page must render each measure's stored note in the health drill-in and the panel tile");
  }
  if (!bad) ok(`honesty on data: ${slackLines.length} Slack lines and the alert lines carry directions only on ${BL.MIN_PEERS}+ samples; episode-health surfaces carry no trend word; every stored note is one of the fixed strings`);
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
