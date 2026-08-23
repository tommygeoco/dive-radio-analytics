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
      commentersPer1kNote: rateComplete ? null : "Not available because some replies or watch counts are missing.",
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
  if (liveChat && (/\btrending\b/i.test(liveChat.text) || !/(from launch|where it started)/i.test(liveChat.text))) {
    bad++; fail("insight live-chat: direction must say whether the newest show is up or down from launch");
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
    if (store.version !== health.HEALTH_STORE_VERSION || !Array.isArray(store.entries)) {
      bad++; fail("health: store schema/version is unsupported");
    } else {
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
        if (entry.formulaVersion !== health.FORMULA_VERSION) { bad++; fail(`health: ${entry.date} uses formula ${entry.formulaVersion}, expected ${health.FORMULA_VERSION}`); }
        if (entry.promptVersion !== health.PROMPT_VERSION || entry.promptHash !== promptHash) { bad++; fail(`health: ${entry.date} prompt stamp is stale`); }
        if (!entry.model || !entry.provider || !entry.bundleHash || !entry.dataGeneratedAt || !entry.dataThrough) { bad++; fail(`health: ${entry.date} is missing provenance stamps`); }
        if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) { bad++; fail(`health: ${entry.date} score is outside 0..100`); }

        const partKeys = Object.keys(entry.subScores || {}).sort();
        if (JSON.stringify(partKeys) !== JSON.stringify(expectedParts)) {
          bad++; fail(`health: ${entry.date} does not carry exactly the six required checks`);
          continue;
        }
        const availableWeight = Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
        for (const key of expectedParts) {
          const part = entry.subScores[key];
          if (part.baseWeight !== health.BASE_WEIGHTS[key]) { bad++; fail(`health: ${entry.date} ${key} has the wrong planned weight`); }
          if (!part.measures || !Object.keys(part.measures).length) { bad++; fail(`health: ${entry.date} ${key} has no recorded measures`); continue; }
          const measureScores = [];
          for (const [measureKey, measure] of Object.entries(part.measures)) {
            if (measure.score == null) {
              if (!measure.reason) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} is missing without a reason`); }
            } else {
              if (!Number.isFinite(measure.score) || measure.score < 0 || measure.score > 100 || !Number.isFinite(measure.value)) {
                bad++; fail(`health: ${entry.date} ${key}.${measureKey} has an invalid score/value`);
              } else measureScores.push(measure.score);
            }
          }
          const expectedScore = measureScores.length ? Math.round(measureScores.reduce((sum, value) => sum + value, 0) / measureScores.length) : null;
          if (part.score !== expectedScore) { bad++; fail(`health: ${entry.date} ${key} score does not equal its available measures`); }
          if (part.score == null && (!part.reason || part.effectiveWeight !== 0)) { bad++; fail(`health: ${entry.date} ${key} absence lacks a reason or carries weight`); }
          if (part.score != null) {
            const expectedWeight = Math.round(part.baseWeight / availableWeight * 10000) / 10000;
            if (part.effectiveWeight !== expectedWeight) { bad++; fail(`health: ${entry.date} ${key} shared weight is wrong`); }
          }
        }
        const recomputed = health.deterministicMean(entry.subScores);
        if (entry.weightedMean !== recomputed.weightedMean) { bad++; fail(`health: ${entry.date} stored mean ${entry.weightedMean} != recomputed ${recomputed.weightedMean}`); }
        if (Math.abs(entry.score - entry.weightedMean) > 8) { bad++; fail(`health: ${entry.date} model score moves more than eight points from the deterministic mean`); }
        if (entry.deviation !== Math.round((entry.score - entry.weightedMean) * 10) / 10) { bad++; fail(`health: ${entry.date} stored score move is wrong`); }
        try {
          health.validateSynthesis(
            { score: entry.score, headline: entry.headline, pros: entry.pros, cons: entry.cons, drivers: entry.drivers },
            { allowedScore: { min: Math.max(0, Math.ceil(entry.weightedMean - 8)), max: Math.min(100, Math.floor(entry.weightedMean + 8)) }, facts: entry.facts || [] },
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
      if (store.entries.length < 7 && data.health?.trend != null) { bad++; fail("health: trend surfaced before seven real saved days exist"); }
      if (store.entries.length >= 7) {
        const expectedPoints = store.entries.filter((entry) => entry.date <= currentDate).map((entry) => ({ date: entry.date, score: entry.score }));
        if (JSON.stringify(data.health?.trend?.points) !== JSON.stringify(expectedPoints)) { bad++; fail("health: trend points do not exactly match saved days"); }
      }

      const latest = store.entries.at(-1);
      if (latest?.date === currentDate) {
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
  if (!/pct\s*<=\s*5/.test(html) || !/Math\.abs\(pct\)\s*<=\s*5/.test(html)) {
    bad++; fail("dashboard: rating and growth conclusions do not suppress small differences");
  }
  if (/provisional\s+—\s+settles/i.test(html)) {
    bad++; fail('dashboard: strip uses "provisional" instead of the plain "Not final" label');
  }
  if (!bad) ok("dashboard honesty: trend waits for three clean weeks and unfinished ratings use plain words");
}

// --- 1k. W11 fold budget and progressive-disclosure contract ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const between = (start, end) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from + start.length);
    return from >= 0 && to > from ? html.slice(from, to) : "";
  };
  const healthSource = between("function buildHealth()", "/* ================= hero");
  const heroSource = between("function buildHero()", "/* ================= strip");
  const stripSource = between("function buildStrip()", "/* ================= detail panel");
  const panelSource = between("function buildPanel()", "/* ================= drilldown modal");
  const compoundSource = between("function buildCompound()", "function renderDrill()");

  if (!healthSource || !heroSource || !stripSource || !panelSource || !compoundSource) {
    bad++; fail("fold trim: could not locate every dashboard surface in index.html");
  } else {
    if ((healthSource.match(/data-fold-number/g) || []).length !== 1) {
      bad++; fail("fold trim: health must contribute exactly its saved score to the glance-number budget");
    }
    if ((heroSource.match(/data-fold-number/g) || []).length !== 2) {
      bad++; fail("fold trim: each hero tab must expose only its one primary number");
    }
    if ((stripSource.match(/data-fold-number/g) || []).length !== 2) {
      bad++; fail("fold trim: each episode card must expose exactly one tagged glance number in either tab");
    }
    if (!/const evidenceWasOpen = el\.querySelector\("\.health-evidence"\)\?\.open === true/.test(healthSource)
      || !healthSource.includes('<details class="health-evidence"')
      || !healthSource.includes("bullets(h.pros)") || !healthSource.includes("bullets(h.cons)")
      || /trend-note/.test(healthSource)) {
      bad++; fail("fold trim: health evidence must start closed, preserve an owner-opened state, and contain every exact saved fact without a waiting placeholder");
    }
    if (!/h\.readState === "early"/.test(healthSource) || !/Updated \$\{esc\(saved\)\}/.test(healthSource)) {
      bad++; fail("fold trim: the health surface does not show its saved age and projected early-read state");
    }
    const episodeBrowser = html.match(/<details class="episode-browser" id="episodebrowser"([^>]*)>/)?.[1];
    if (episodeBrowser == null || /\bopen\b/.test(episodeBrowser)) {
      bad++; fail("fold trim: the episode-card browser must start closed so its comparison numbers stay in the click layer");
    }
    if (html.indexOf('id="chartcard"') > html.indexOf('id="episodebrowser"')) {
      bad++; fail("fold trim: episode browsing must sit below the primary chart");
    }
    if (!/document\.createElement\("button"\)/.test(stripSource) || !/it\.type = "button"/.test(stripSource)) {
      bad++; fail("fold trim: episode choices are not real keyboard-operable buttons");
    }
    const latest = data.episodes?.at(-1);
    const latestRatingTokens = data.episodes?.at(-1)?.rating ? 2 : 0;
    const latestTotal = latest?.latest?.totalViews ?? latest?.latest?.ytTotal;
    const growthTokens = (latestTotal == null ? 0 : 1) + latestRatingTokens;
    const liveTokens = Number.isFinite(latest?.live?.peak) ? 1 : 0;
    const literalBudget = (data.health ? 1 : 0) + Math.max(growthTokens, liveTokens);
    if (literalBudget > 12) {
      bad++; fail(`fold trim: ${literalBudget} visible numeric tokens would render in the default overview (limit 12)`);
    }
    if (!/const saved = relativeDayWords\(h\.date\)/.test(healthSource)
      || !/stamp\.textContent = `Data refreshed \$\{relativeDayWords/.test(html)
      || /E\$\{e\.ep\} · latest episode/.test(heroSource)
      || /freezeDateOf\(e\)/.test(heroSource)) {
      bad++; fail("fold trim: dates or episode identifiers still add numeric tokens to the default glance layer");
    }
    if (/addSentimentChip|chip\.senti/.test(html) || !/Audience feedback/.test(panelSource)) {
      bad++; fail("fold trim: audience feedback counts must live only in the click-open episode panel");
    }
    if (/sameAgeSub\s*\(/.test(stripSource) || /class=["']r3["']/.test(stripSource)) {
      bad++; fail("fold trim: pace and status lines still render on the episode cards");
    }
    if (!/const pace = sameAgeSub\(e\)/.test(panelSource) || !/YouTube views at the same age/.test(panelSource)) {
      bad++; fail("fold trim: the removed pace comparison is not present in the click-open episode panel");
    }
    if (/data-fold-number|class="(?:bl|bv)"|clean weeks:/.test(compoundSource)) {
      bad++; fail("fold trim: the growth glance still carries visible counts instead of a quiet readiness state");
    }
    if (!/splitReady = Number\.isFinite\(tv\)[\s\S]*yt \+ x === tv/.test(heroSource)
      || /e\.latest\.(?:ytTotal|xPlays) \?\? 0/.test(heroSource)) {
      bad++; fail("fold trim: the platform bar is not locked to complete stored YouTube and X values");
    }
    if (!/missingPillars/.test(heroSource) || !/Rating is still settling/.test(heroSource)) {
      bad++; fail("fold trim: the compact hero does not explain an unfinished rating in plain words");
    }
    if (!html.includes('role="tablist"') || !/setAttribute\("aria-selected"/.test(html)
      || !/addEventListener\("focusin"[\s\S]*showRtt/.test(html)) {
      bad++; fail("fold trim: tabs or rating help are not keyboard-readable");
    }
  }
  if (!bad) {
    const latest = data.episodes?.at(-1);
    const latestRatingTokens = latest?.rating ? 2 : 0;
    const latestTotal = latest?.latest?.totalViews ?? latest?.latest?.ytTotal;
    const growthTokens = (latestTotal == null ? 0 : 1) + latestRatingTokens;
    const liveTokens = Number.isFinite(latest?.live?.peak) ? 1 : 0;
    const literalBudget = (data.health ? 1 : 0) + Math.max(growthTokens, liveTokens);
    ok(`fold trim: ${literalBudget} visible numeric tokens in the default overview; evidence, episodes, feedback, and pace are on demand`);
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
