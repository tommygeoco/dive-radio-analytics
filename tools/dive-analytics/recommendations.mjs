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
//     The payload carries the exact allowed-number list so the model can
//     comply, and a failed attempt is retried with the validation error and
//     the offending item appended to the conversation (up to 3 attempts).
//   - Plain words: the banned-jargon list is enforced on every item.
//   - Failure is non-fatal but never leaves stale numbers behind (PRD v8 W19):
//     when the model cannot produce a valid store, the saved items are pruned
//     against the CURRENT fact sheet instead of kept as-is. Items that no
//     longer ground are dropped; fewer than 3 survivors deletes the store and
//     the page falls back to the rule-based insights. The store on disk is
//     grounded in the current facts on every exit path.
//
// Run:
//   node tools/dive-analytics/recommendations.mjs --facts   # print the fact sheet
//   node tools/dive-analytics/recommendations.mjs --prune   # drop stored items that
//                                                           # no longer ground (no model)
//   node tools/dive-analytics/recommendations.mjs           # regenerate the store
//
// Chain (owner machine): ratings → build-data → recommendations (non-fatal
//   wrapper) → build-data → validate → publish → alerts

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
export const PROMPT_VERSION = 3; // v8: allowed-number list rides in the payload
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

export function collectFacts() {
  const data = readJson(DATA_PATH);
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

// The exact set of number tokens an item may contain. This same set rides in
// the model payload (W20) so the model sees precisely what the validator will
// accept — one list, two consumers, no drift.
export function allowedTokens(facts) {
  const allowed = new Set();
  for (const f of facts) {
    const v = f.value;
    for (const s of [String(v), v.toLocaleString("en-US"), String(Math.round(v)), Math.round(v).toLocaleString("en-US"), v.toFixed(1), v.toFixed(2)]) allowed.add(s);
  }
  // small structural constants an action may name (positions, ranges, dates)
  for (const s of ["1", "2", "3", "5", "90", "100", "1,000", "07", "17", "23", "30"]) allowed.add(s);
  return allowed;
}

// One item's checks, exactly as validateItems applies them. Shared with the
// W19 prune so "does this stored item still hold" can never drift from the
// set-level validation.
function validateItem(item, allowed, seen) {
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

export function validateItems(items, facts) {
  if (!Array.isArray(items) || items.length < 3 || items.length > 8) throw new Error("between three and eight items required");
  const allowed = allowedTokens(facts);
  const seen = new Set();
  for (const item of items) validateItem(item, allowed, seen);
  return items;
}

// --- W19 deterministic prune: the stored items re-earn their place against
// the CURRENT facts, no model involved. Items that no longer ground are
// dropped with an audit trail; fewer than 3 survivors deletes the store
// (build-data falls back to the rule-based insights, validate WARNs). ---

export function pruneStore(sheet, { attempts = null } = {}) {
  const store = readJson(STORE_PATH);
  if (!store || !Array.isArray(store.items)) {
    console.log("prune: no recommendations store on disk — nothing to prune");
    return { kept: 0, prunedIds: [], deleted: false, absent: true };
  }
  const allowed = allowedTokens(sheet.facts);
  const seen = new Set();
  const kept = [];
  const prunedIds = [];
  for (const item of store.items) {
    try {
      validateItem(item, allowed, seen);
      kept.push(item);
    } catch (error) {
      prunedIds.push(typeof item?.id === "string" ? item.id : "unknown");
      console.log(`prune: dropped ${typeof item?.id === "string" ? item.id : "an item with no id"} — ${error.message}`);
    }
  }
  if (kept.length < 3) {
    unlinkSync(STORE_PATH);
    console.log(`prune: only ${kept.length} of ${store.items.length} item(s) still hold against the current facts — store deleted; the page falls back to the rule-based insights`);
    return { kept: kept.length, prunedIds, deleted: true, absent: false };
  }
  saveAtomic(STORE_PATH, {
    ...store,
    items: kept,
    prunedAt: new Date().toISOString(),
    prunedIds,
    ...(attempts != null ? { attempts } : {}),
  });
  console.log(prunedIds.length
    ? `prune: kept ${kept.length} of ${store.items.length} item(s); store rewritten against the current facts — rebuild data to publish`
    : `prune: all ${kept.length} item(s) still hold against the current facts`);
  return { kept: kept.length, prunedIds, deleted: false, absent: false };
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
7. The payload's allowedNumbers list is every number token the validator accepts. Every digit sequence in your output must appear verbatim in that list. Never compute, round, combine, or convert numbers — if the number you want is not in the list, make the point without a number.`;

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

// The item a validation error points at, so the retry conversation can show
// the model exactly what it wrote wrong (W20). Errors are prefixed with the
// item id by validateItem; anything unprefixed (bad JSON, bad shape) has no
// single item to blame.
function offendingItem(error, items) {
  const id = /^([a-z0-9-]{3,40}): /.exec(error.message)?.[1];
  return (id && Array.isArray(items) && items.find((item) => item?.id === id)) || null;
}

const MAX_ATTEMPTS = 3;

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
  // sorted numerically so the list reads as a list, not a grab bag
  const allowedNumbers = [...allowedTokens(sheet.facts)]
    .sort((a, b) => parseFloat(a.replace(/,/g, "")) - parseFloat(b.replace(/,/g, "")) || a.localeCompare(b));
  const payload = { task: "Write this week's tactical recommendations.", allowedNumbers, facts: sheet.facts, excerpts: sheet.excerpts };
  const messages = [{ role: "user", content: JSON.stringify(payload) }];
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    let result;
    try {
      result = await callModel(messages);
    } catch (error) {
      console.log(`WARN recommendations: attempt ${attempt}/${MAX_ATTEMPTS}: ${error.message}`);
      if (!process.env.ANTHROPIC_API_KEY) break; // no key — more attempts cannot help
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(result.text);
      validateItems(parsed.items, sheet.facts);
    } catch (error) {
      console.log(`WARN recommendations: attempt ${attempt}/${MAX_ATTEMPTS}: ${error.message}`);
      // hand the model its own output plus the exact failure, and ask again
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: JSON.stringify({
          validationError: error.message,
          offendingItem: offendingItem(error, parsed?.items),
          instruction: "Your last answer failed validation. Fix it and return the complete corrected JSON. Every digit sequence must appear verbatim in the allowedNumbers list — never compute, round, combine, or convert numbers.",
        }),
      });
      continue;
    }
    saveAtomic(STORE_PATH, {
      version: STORE_VERSION,
      promptVersion: PROMPT_VERSION,
      updatedAt: new Date().toISOString(),
      provider: "anthropic",
      model: result.model,
      attempts: attempt,
      factsGeneratedAt: sheet.generatedAt,
      items: parsed.items,
    });
    console.log(`recommendations: saved ${parsed.items.length} item(s) in ${attempt} attempt(s) — rebuild data to publish`);
    return;
  }
  // W19: a failed regeneration never leaves stale numbers behind — prune the
  // saved items against the current facts instead of keeping them as-is.
  console.log(`WARN recommendations: no valid store after ${attempts} attempt(s) — pruning the saved items against the current facts`);
  pruneStore(sheet, { attempts });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  process.stderr.write(`recommendations: ${error.message}\n`);
  process.exit(1);
});
