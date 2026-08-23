#!/usr/bin/env node
// recommendations.mjs — W15 tactical recommendation engine (model-backed).
//
// Reads EVERYTHING the pipeline stores — episode totals, the verified
// YouTube analytics (watch curves, traffic sources, per-channel subscribers
// and watch shares), episode health reads, live sessions, and classified
// feedback — and writes a small set of tactical, number-grounded
// recommendations to data/restream/recommendations.json. build-data.mjs
// projects the saved items into "What matters"; the old deterministic
// rule-based insights remain only as the fallback when no store exists.
//
// Discipline (mirrors health.mjs):
//   - The model receives a deterministic fact sheet and may only use numbers
//     from it. Every number token in a saved item must appear in the facts.
//     The payload carries the exact allowed spellings, and a grounding
//     failure is fed back to the model for up to two retries (v7 W18).
//   - Plain words: the banned-jargon list is enforced on every item.
//   - Failure is non-fatal AND never leaves the store stale (v7 W17): when
//     the model cannot produce a grounded set, the saved store is pruned
//     item-by-item against the CURRENT facts. Items that no longer ground
//     are dropped (recorded in prunedAt/prunedIds); fewer than three
//     survivors and the store file is removed entirely — build-data then
//     falls back to the deterministic rule-based insights and validate
//     treats the absent store as WARN, not FAIL. Keep-previous is retired:
//     it turned one bad model call into a blocked publish (2026-08-23).
//
// Run:
//   node tools/dive-analytics/recommendations.mjs --facts   # print the fact sheet
//   node tools/dive-analytics/recommendations.mjs --prune   # deterministic prune only (no model)
//   node tools/dive-analytics/recommendations.mjs           # regenerate; prune is the floor
//
// Chain (cron + owner machine): … ratings → build-data →
//   recommendations (this script, non-fatal) → build-data → validate →
//   publish → alerts. The second build-data projects the store into the
//   page so validate's page-matches-store lock holds.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "recommendations.json");
const MAX_TOKENS = 8000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

export const STORE_VERSION = 1;
export const PROMPT_VERSION = 3; // v7: allowed-number list in the payload + grounding-error retries
const CATEGORIES = new Set(["content", "distribution", "promotion", "audience", "data"]);
// exported so other prose surfaces (the Slack trends line) can gate spoken
// quotes with the same plain-words contract the validator enforces
export const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function saveAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n");
  renameSync(tmp, path);
}

const r1 = (x) => Math.round(x * 10) / 10;

// --- deterministic fact sheet: everything the model may cite ---

export function collectFacts(data = readJson(DATA_PATH)) {
  if (!data?.episodes?.length) throw new Error("data.json has no episodes");
  const facts = [];
  const add = (id, value, text) => { if (Number.isFinite(value)) facts.push({ id, value: r1(value), text }); };

  const eps = data.episodes;
  for (const e of eps) {
    const w = e.watch;
    if (w?.curve?.length) {
      const start = w.curve[0];
      const at2 = w.curve.find((p) => p.at >= 0.02);
      add(`open-start-E${e.ep}`, start.watching * 100, `E${e.ep} share still watching near the start`);
      if (at2) add(`open-at2-E${e.ep}`, at2.watching * 100, `E${e.ep} share still watching at the 2% mark`);
    }
    if (w?.avgPercent != null) add(`watched-E${e.ep}`, w.avgPercent, `E${e.ep} average share of the video watched`);
    const subRows = (w?.byChannel || []).filter((c) => c.subs != null && c.views > 0);
    if (subRows.length) {
      const subs = subRows.reduce((a, c) => a + c.subs, 0);
      const views = subRows.reduce((a, c) => a + c.views, 0);
      add(`subs1k-E${e.ep}`, (subs / views) * 1000, `E${e.ep} subscribers per 1,000 views, both channels`);
    }
    for (const c of w?.byChannel || []) {
      add(`watched-E${e.ep}-${c.key.slice(3)}`, c.avgPercent, `E${e.ep} ${c.key} share watched`);
      add(`subs1k-E${e.ep}-${c.key.slice(3)}`, c.subsPer1k, `E${e.ep} ${c.key} subscribers per 1,000 views`);
      add(`subs-E${e.ep}-${c.key.slice(3)}`, c.subs, `E${e.ep} ${c.key} subscribers gained`);
    }
    if (e.health?.score != null) add(`health-E${e.ep}`, e.health.score, `E${e.ep} episode health`);
    if (e.live) { add(`peak-E${e.ep}`, e.live.peak, `E${e.ep} peak live viewers`); add(`chat-E${e.ep}`, e.live.chatMessages, `E${e.ep} chat messages`); }
  }

  // v6 W16: curve shape + transcript-anchored moments. The numbers become
  // facts; the excerpts ride ALONGSIDE as quotable context (never numbers).
  const excerpts = [];
  for (const e of eps) {
    const s = e.watch?.shape;
    if (s) {
      add(`open-floor-E${e.ep}`, s.openFloor, `E${e.ep} lowest share watching inside the first 5% of the video`);
      add(`recovery-peak-E${e.ep}`, s.recoveryPeak, `E${e.ep} share watching at the early rebound peak`);
      add(`mid-hold-E${e.ep}`, s.midHold, `E${e.ep} average share watching through the middle half`);
      add(`end-hold-E${e.ep}`, s.endHold, `E${e.ep} share still watching near the end`);
    }
    for (const mo of e.watch?.moments || []) {
      const pos = Math.round(mo.at * 100);
      const id = `${mo.kind}-E${e.ep}-${pos}`;
      add(id, mo.points, mo.kind === "drop"
        ? `E${e.ep} viewers of every 100 who left around ${pos}% of the way in`
        : `E${e.ep} extra viewers of every 100 watching around ${pos}% of the way in`);
      add(`${mo.kind}-min-E${e.ep}-${pos}`, Math.round(mo.estSec / 60), `E${e.ep} minutes into the video at that moment`);
      excerpts.push({ id, text: mo.excerpt });
    }
  }

  // whole-show traffic mix + per-channel totals from the analytics stores
  const traffic = {}; let trafficTotal = 0;
  const byChannel = {};
  const yta = join(ROOT, "data", "restream", "yt-analytics");
  for (const e of eps) {
    const j = readJson(join(yta, `${e.slug}.json`));
    for (const [key, ch] of Object.entries(j?.channels || {})) {
      const t = ch?.totals; if (!t) continue;
      const a = byChannel[key] = byChannel[key] || { views: 0, subs: 0, weighted: 0 };
      a.views += t.views || 0; a.subs += t.subscribersGained || 0; a.weighted += (t.averageViewPercentage || 0) * (t.views || 0);
      for (const row of ch.trafficSources || []) { traffic[row.insightTrafficSourceType] = (traffic[row.insightTrafficSourceType] || 0) + row.views; trafficTotal += row.views; }
    }
  }
  for (const [src, views] of Object.entries(traffic)) {
    add(`traffic-${src}`, views, `whole-show YouTube views from ${src}`);
    if (trafficTotal > 0) add(`traffic-share-${src}`, (views / trafficTotal) * 100, `share of YouTube views from ${src}`);
  }
  for (const [key, a] of Object.entries(byChannel)) {
    add(`channel-views-${key.slice(3)}`, a.views, `${key} total analytics views`);
    add(`channel-subs-${key.slice(3)}`, a.subs, `${key} total subscribers gained`);
    if (a.views > 0) {
      add(`channel-subs1k-${key.slice(3)}`, (a.subs / a.views) * 1000, `${key} subscribers per 1,000 views`);
      add(`channel-watched-${key.slice(3)}`, a.weighted / a.views, `${key} average share watched`);
    }
  }

  // platform split (plays are real watching; reach is not)
  const ytAll = eps.reduce((a, e) => a + (e.latest.ytTotal || 0), 0);
  const xAll = eps.reduce((a, e) => a + (e.latest.xPlays || 0), 0);
  add("views-yt-all", ytAll, "all-show YouTube views");
  add("views-x-all", xAll, "all-show X broadcast plays");
  if (ytAll + xAll > 0) add("share-x-all", (xAll / (ytAll + xAll)) * 100, "share of all watching on X");
  add("views-total-all", ytAll + xAll, "all-show total views");

  return { generatedAt: data.generatedAt, facts, excerpts };
}

// --- validation: every number in an item must exist in the fact sheet ---

function numberTokens(text) {
  // thousands groups must be exact (12,710) — a sentence comma after a digit
  // ("minute 2–3, right…") is punctuation, not part of the number
  return String(text).match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [];
}

// every spelling of every fact value the model may write; also sent to the
// model verbatim (v7 W18) so compliance is copy-work, not arithmetic
function allowedTokens(facts) {
  const allowed = new Set();
  for (const f of facts) {
    const v = f.value;
    for (const s of [String(v), v.toLocaleString("en-US"), String(Math.round(v)), Math.round(v).toLocaleString("en-US"), v.toFixed(1), v.toFixed(2)]) allowed.add(s);
  }
  // small structural constants an action may name (positions, ranges, dates)
  for (const s of ["1", "2", "3", "5", "90", "100", "1,000", "07", "17", "23", "30"]) allowed.add(s);
  return allowed;
}

function checkItem(item, allowed, seen) {
  if (!item || typeof item !== "object") throw new Error("item must be an object");
  if (typeof item.id !== "string" || !/^[a-z0-9-]{3,40}$/.test(item.id) || seen.has(item.id)) throw new Error(`bad or duplicate id ${JSON.stringify(item.id)}`);
  seen.add(item.id);
  if (!CATEGORIES.has(item.category)) throw new Error(`${item.id}: illegal category`);
  for (const key of ["text", "recommendation"]) {
    const value = item[key];
    if (typeof value !== "string" || !value.trim() || value.length > 260) throw new Error(`${item.id}: ${key} missing or too long`);
    if (BANNED.test(value) || MARKUP.test(value)) throw new Error(`${item.id}: ${key} contains banned jargon or markup`);
    for (const token of numberTokens(value)) {
      if (!allowed.has(token)) throw new Error(`${item.id}: number ${token} is not in the fact sheet`);
    }
  }
  if (item.caveat != null && (typeof item.caveat !== "string" || item.caveat.length > 200 || BANNED.test(item.caveat))) throw new Error(`${item.id}: bad caveat`);
}

// Exports for build-data's currency check (PRD v7 baselines F32): an item
// whose numbers have since left today's fact sheet is held back as stale.
export const allowedNumbers = allowedTokens;
export function validateItem(item, facts, allowed = allowedTokens(facts)) {
  checkItem(item, allowed, new Set());
  return item;
}

export function validateItems(items, facts) {
  if (!Array.isArray(items) || items.length < 3 || items.length > 8) throw new Error("between three and eight items required");
  const allowed = allowedTokens(facts);
  const seen = new Set();
  for (const item of items) checkItem(item, allowed, seen);
  return items;
}

// --- v7 W17: deterministic prune — the store can always be made true ---

// Re-validate the saved store item-by-item against the CURRENT fact sheet
// and drop what no longer grounds. Below three survivors the store file is
// deleted (build-data falls back to the deterministic insights; validate
// WARNs on an absent store). Never calls a model.
export function pruneStore(sheet) {
  const store = readJson(STORE_PATH);
  if (!store?.items?.length) {
    console.log("recommendations: prune — no store on disk, nothing to prune");
    return { kept: 0, prunedIds: [], existed: false };
  }
  const allowed = allowedTokens(sheet.facts);
  const seen = new Set();
  const kept = [], prunedIds = [];
  for (const item of store.items) {
    try { checkItem(item, allowed, seen); kept.push(item); }
    catch (error) { prunedIds.push(String(item?.id ?? "?")); console.log(`recommendations: prune dropped ${item?.id ?? "?"} — ${error.message}`); }
  }
  if (!prunedIds.length) {
    console.log(`recommendations: prune — all ${kept.length} item(s) still ground against the current facts; store untouched`);
    return { kept: kept.length, prunedIds, existed: true };
  }
  if (kept.length < 3) {
    unlinkSync(STORE_PATH);
    console.log(`recommendations: prune left ${kept.length} item(s) — below the three-item floor, store removed; the page falls back to the deterministic insights`);
    return { kept: 0, prunedIds, existed: true, removed: true };
  }
  saveAtomic(STORE_PATH, {
    ...store,
    updatedAt: new Date().toISOString(),
    factsGeneratedAt: sheet.generatedAt,
    // the facts the items were grounded on (baselines PRD v7 §4.6)
    facts: sheet.facts.map((f) => ({ id: f.id, value: f.value })),
    prunedAt: new Date().toISOString(),
    prunedIds,
    items: kept,
  });
  console.log(`recommendations: prune dropped ${prunedIds.length} item(s) (${prunedIds.join(", ")}), kept ${kept.length} — store re-grounded`);
  return { kept: kept.length, prunedIds, existed: true };
}

// --- model call (same provider plumbing as health.mjs) ---

const SYSTEM = `You are the tactical recommendation engine for the two Dive Radio owners. You receive a deterministic fact sheet of everything the pipeline measured. Return raw JSON only: {"items":[{"id":"kebab-id","category":"content|distribution|promotion|audience","text":"...","recommendation":"..."}]} with four to seven items.

Rules:
1. text states ONE finding in at most 260 characters using only numbers copied exactly from the fact sheet. recommendation is ONE concrete action the hosts can take this week — imperative, specific, no hedging, at most 260 characters.
2. Prefer the findings with the largest lever: where viewers are lost, which channel converts, which surfaces bring nothing, what the best episode did differently.
3. Call out per-channel differences (Dive Club vs DesignerTom) whenever the gap matters, alongside the blended number.
4. Plain words. Never write: composite, percentile, pillar, ratio, multiple-times comparisons, velocity, coverage, basis, median, delta, or cumulative. No markup, no links.
5. Association is not cause — recommend tests and changes, never certainties.
6. Watch-moment facts (drop-*/hold-*) arrive with transcript excerpts in the payload. Excerpts are quotable context, not numbers. Name a moment's position in plain words ("about a third of the way in") and treat its timing as approximate — it comes from the live recording. Never claim the words caused the exit; recommend a test instead (trim, tighten, re-order).
7. The payload's allowedNumbers list is the complete set of number spellings you may write. Every digit sequence in your output must appear verbatim in that list. Never compute, round, combine, or convert numbers — if the number you want is not in the list, make the point without a number.`;

async function callModel(messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const model = process.env.RECS_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, model };
}

// v7 W18: up to three attempts; a grounding failure goes back to the model
// verbatim so the retry is a correction, not a re-roll. Transport errors
// (no key, HTTP, timeout) throw immediately — retrying those wastes the
// window and the prune floor handles the day.
async function regenerate(sheet) {
  const messages = [{ role: "user", content: JSON.stringify({
    task: "Write this week's tactical recommendations.",
    facts: sheet.facts,
    excerpts: sheet.excerpts,
    allowedNumbers: [...allowedTokens(sheet.facts)].sort((a, b) =>
      (parseFloat(a.replace(/,/g, "")) - parseFloat(b.replace(/,/g, ""))) || a.localeCompare(b)),
  }) }];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callModel(messages);
    try {
      const parsed = JSON.parse(result.text);
      validateItems(parsed.items, sheet.facts);
      return { items: parsed.items, model: result.model, attempts: attempt };
    } catch (error) {
      console.log(`recommendations: attempt ${attempt}/3 failed grounding — ${error.message}`);
      messages.push({ role: "assistant", content: result.text });
      messages.push({ role: "user", content: `Your reply failed validation: ${error.message}. Return the corrected full JSON now — same rules, every digit sequence copied verbatim from allowedNumbers.` });
    }
  }
  throw new Error("three attempts all failed grounding");
}

async function main() {
  const sheet = collectFacts();
  if (process.argv.includes("--facts")) {
    console.log(JSON.stringify(sheet, null, 1));
    return;
  }
  if (process.argv.includes("--prune")) {
    pruneStore(sheet);
    return;
  }
  // default: regenerate; on ANY model or grounding failure the deterministic
  // prune is the floor — the store on disk always grounds in the current
  // facts when this script exits (v7 W17)
  try {
    const gen = await regenerate(sheet);
    saveAtomic(STORE_PATH, {
      version: STORE_VERSION,
      promptVersion: PROMPT_VERSION,
      updatedAt: new Date().toISOString(),
      provider: "anthropic",
      model: gen.model,
      factsGeneratedAt: sheet.generatedAt,
    // the facts the items were grounded on (baselines PRD v7 §4.6)
    facts: sheet.facts.map((f) => ({ id: f.id, value: f.value })),
      attempts: gen.attempts,
      items: gen.items,
    });
    console.log(`recommendations: saved ${gen.items.length} item(s) after ${gen.attempts} attempt(s) — rebuild data to publish`);
  } catch (error) {
    console.log(`WARN recommendations: ${error.message}; falling back to the deterministic prune`);
    pruneStore(sheet);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  process.stderr.write(`recommendations: ${error.message}\n`);
  process.exit(1);
});
