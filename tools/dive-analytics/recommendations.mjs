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
//     failure is fed back to the model for up to two retries (v8 W20).
//   - Plain words: the banned-jargon list is enforced on every item.
//   - Failure is non-fatal AND never leaves the store stale (v8 W19): when
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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveDepthOf } from "./baselines.mjs";

import { currentAnalyticsCohort, assertSourceStoreIntegrity } from "./source-integrity.mjs";

import { atomicWriteText, withSourceLock } from "./source-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "recommendations.json");
// claude-fable-5 uses adaptive thinking from this same budget.
const MAX_TOKENS = 16000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

export const STORE_VERSION = 1;
export const PROMPT_VERSION = 4; // v3: allowed-number list + grounding-error retries (v8) + like-for-like rate facts (v9); v4 (PRD v10 §11, W35): exactly five items ranked by lever, anchored in the day's show-health read (states, direction, outlook, launch words, live depth, discovery) — `serves` names the check each action helps
export const TOP_N = 5;           // What matters = the five things to do this week, in order
export const CHECK_KEYS = new Set(["growth", "audienceQuality", "reachEfficiency", "livePull", "participation", "conversion", "sentiment"]);
const CATEGORIES = new Set(["content", "distribution", "promotion", "audience", "data"]);
// exported so other prose surfaces (the Slack trends line) can gate spoken
// quotes with the same plain-words contract the validator enforces
export const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAtomic(path, value) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

const r1 = (x) => Math.round(x * 10) / 10;

// --- deterministic fact sheet: everything the model may cite ---

export function collectFacts(data = readJson(DATA_PATH)) {
  if (!data?.episodes?.length) throw new Error("data.json has no episodes");
  const facts = [];
  const add = (id, value, text, extra = {}) => { if (Number.isFinite(value)) facts.push({ id, value: r1(value), text, ...extra }); };

  const eps = data.episodes;
  // PRD v9 F28: every per-episode RATE fact carries the episode's age and a
  // basis so the model (and validateItem) can keep comparisons like for like —
  // "mature" at three weeks or more, "young" before. Rates of young episodes
  // are still listed for reading, never for ranking against mature ones.
  const MATURE_DAYS = data.baselines?.constants?.MATURITY_DAYS?.analytics ?? 21;
  const basisOf = (e) => (e.ageDays >= MATURE_DAYS ? "mature" : "young");
  const rate = (e) => ({ episode: e.ep, ageDays: e.ageDays, basis: basisOf(e), kind: "episode-rate" });
  for (const e of eps) {
    const w = e.watch;
    if (w?.curve?.length) {
      const start = w.curve[0];
      const at2 = w.curve.find((p) => p.at >= 0.02);
      add(`open-start-E${e.ep}`, start.watching * 100, `E${e.ep} share still watching near the start`);
      if (at2) add(`open-at2-E${e.ep}`, at2.watching * 100, `E${e.ep} share still watching at the 2% mark`);
    }
    if (w?.avgPercent != null) add(`watched-E${e.ep}`, w.avgPercent, `E${e.ep} average share of the video watched${basisOf(e) === "young" ? ` (only ${e.ageDays} days in — not comparable with finished episodes)` : ""}`, rate(e));
    const subRows = (w?.byChannel || []).filter((c) => c.subs != null && c.views > 0);
    if (subRows.length) {
      const subs = subRows.reduce((a, c) => a + c.subs, 0);
      const views = subRows.reduce((a, c) => a + c.views, 0);
      add(`subs1k-E${e.ep}`, (subs / views) * 1000, `E${e.ep} subscribers per 1,000 views, both channels${basisOf(e) === "young" ? ` (only ${e.ageDays} days in — not comparable with finished episodes)` : ""}`, rate(e));
    }
    for (const c of w?.byChannel || []) {
      add(`watched-E${e.ep}-${c.key.slice(3)}`, c.avgPercent, `E${e.ep} ${c.key} share watched`, rate(e));
      add(`subs1k-E${e.ep}-${c.key.slice(3)}`, c.subsPer1k, `E${e.ep} ${c.key} subscribers per 1,000 views`, rate(e));
      add(`subs-E${e.ep}-${c.key.slice(3)}`, c.subs, `E${e.ep} ${c.key} subscribers gained`);
    }
    if (e.health?.score != null) add(`health-E${e.ep}`, e.health.score, `E${e.ep} episode health`);
    if (e.live) {
      add(`peak-E${e.ep}`, e.live.peak, `E${e.ep} peak live viewers`);
      add(`avg-E${e.ep}`, e.live.avg, `E${e.ep} average live viewers`);
      add(`chat-E${e.ep}`, e.live.chatMessages, `E${e.ep} chat messages`);
      add(`chatters-E${e.ep}`, e.live.chatters, `E${e.ep} people who chatted`);
      // PRD v10 §11: the whole live session — one definition (baselines.liveDepthOf)
      if (e.live.liveViews > 0) add(`live-viewers-E${e.ep}`, e.live.liveViews, `E${e.ep} people who watched live`);
      if (e.live.watchedMin > 0) add(`live-minutes-E${e.ep}`, e.live.watchedMin, `E${e.ep} minutes watched live, all together`);
      const depth = liveDepthOf(e);
      if (depth?.minutesPerViewer != null) add(`stay-min-E${e.ep}`, depth.minutesPerViewer, `E${e.ep} minutes each live viewer stayed`);
      if (depth?.holdRate != null) add(`hold-E${e.ep}`, depth.holdRate, `E${e.ep} share of the peak still watching in the last ten minutes`);
    }
    if (Number.isFinite(e.discoveryShare)) add(`discovery-E${e.ep}`, e.discoveryShare, `E${e.ep} share of YouTube views from search and suggested videos${basisOf(e) === "young" ? ` (only ${e.ageDays} days in — not comparable with finished episodes)` : ""}`, rate(e));
  }

  // --- the day's show-health read (PRD v10 §11, W35): the checks, their
  // states, each measure's own value and typical, the direction of every
  // durable measure, the outlook, and each episode's launch word. Words ride
  // in `context` (never numbers); every number is a fact here. ---
  const context = { showHealth: null, direction: null, outlook: null, launch: {} };
  const h = data.health;
  if (h && Number.isFinite(h.score)) {
    add("show-health-score", h.score, "today's show-health score (50 is the show's usual level)");
    const states = {};
    for (const c of h.checks || []) {
      states[c.key] = c.state || (c.score == null ? "waiting" : null);
      if (Number.isFinite(c.score)) add(`check-${c.key}`, c.score, `show-health check ${c.key}: ${c.state || "scored"} (50 is usual)`);
      for (const mm of c.measures || []) {
        if (mm.value == null) continue;
        const tag = `${mm.qualified ? " — promo-driven lift, shown not scored" : ""}${mm.carried ? " — carried from an older finished episode" : ""}${mm.note ? ` (${mm.note})` : ""}`;
        add(`hm-${c.key}-${mm.key}`, mm.value, `show-health ${c.key} / ${mm.key}: the newest reading${tag}`);
        if (mm.typical != null) add(`hm-typical-${c.key}-${mm.key}`, mm.typical, `show-health ${c.key} / ${mm.key}: the show's typical level`);
      }
    }
    context.showHealth = {
      score: h.score, readState: h.readState, headline: h.headline, states,
      readsOn: h.asOf ? { newest: h.asOf.newestTitle || h.asOf.newest, provisional: !!h.asOf.provisional, carried: h.asOf.carried || [], promoQualified: h.asOf.qualified || [] } : null,
      drivers: h.drivers || [],
    };
  }
  const dir = data.baselines?.direction;
  if (dir?.measures) {
    context.direction = { overall: dir.overall ?? null, words: Object.fromEntries(dir.measures.map((t) => [t.key, t.direction || (t.n >= 3 ? "too few episodes for a word" : "too few episodes")])) };
    for (const t of dir.measures) if (t.pctPerEpisode != null) add(`dir-${t.key}`, Math.abs(t.pctPerEpisode), `${t.key}: change each episode over the last ${t.n} clean episodes, ${t.pctPerEpisode >= 0 ? "up" : "down"}${t.direction ? ` (${t.direction})` : " (too few for a direction word)"}`);
  }
  const nfw = data.baselines?.outlook?.nextFirstWeek;
  if (nfw?.low != null) {
    add("outlook-first-week-low", nfw.low, "lowest of the last three clean first weeks, YouTube views");
    add("outlook-first-week-high", nfw.high, "highest of the last three clean first weeks, YouTube views");
    add("outlook-first-week-typical", nfw.typical, "typical of the last three clean first weeks, YouTube views");
    context.outlook = { firstWeek: nfw.direction || "no direction word yet", coolOff: data.baselines?.outlook?.coolOff?.word || null, coolOffPromo: !!(data.baselines?.outlook?.coolOff?.reason && /promo/.test(data.baselines.outlook.coolOff.reason)) };
  }
  for (const e of eps) {
    const l = data.baselines?.launch?.[e.slug];
    if (!l?.word) continue;
    context.launch[`E${e.ep}`] = `${l.promoDriven ? "promo-driven" : l.word}${l.provisional ? " so far" : ""}`;
    add(`launch-E${e.ep}`, l.value, `E${e.ep} YouTube views at its launch read${l.provisional ? " (still under a week old)" : ""}${l.promoDriven ? " — promo-driven" : ""}`);
    if (l.typical != null) add(`launch-typical-E${e.ep}`, l.typical, `typical YouTube views at that age for the episodes around E${e.ep}`);
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

  // Whole-show traffic mix + per-channel totals from the analytics stores.
  // These are whole-show claims, so one episode without a positive YouTube
  // reading with finite channel counts withholds the entire aggregate. Missing
  // analytics must never enter a recommendation fact as a zero.
  const traffic = {}; let trafficTotal = 0;
  const byChannel = {};
  let analyticsComplete = true;
  const yta = join(ROOT, "data", "restream", "yt-analytics");
  for (const e of eps) {
    const j = readJson(join(yta, `${e.slug}.json`));
    const expected = Object.keys(e.latest?.byDest || {}).filter((key) => key.startsWith("yt:"));
    const cohort = currentAnalyticsCohort(e, j, Date.parse(data.generatedAt));
    const channelTotals = cohort.map(([, channel]) => channel.totals);
    if (!cohort.length || channelTotals.some((t) => !Number.isFinite(t?.views)) || channelTotals.reduce((sum, t) => sum + (t?.views ?? 0), 0) <= 0) {
      analyticsComplete = false;
    }
    for (const [key, ch] of cohort) {
      const t = ch?.totals; if (!t) continue;
      const a = byChannel[key] = byChannel[key] || { views: 0, subs: 0, weighted: 0 };
      if (Number.isFinite(t.views)) a.views += t.views;
      if (!Number.isFinite(t.subscribersGained) || !Number.isFinite(t.averageViewPercentage) || !Array.isArray(ch.trafficSources) || !ch.trafficSources.length || ch.trafficSources.some((row) => !Number.isFinite(row.views))) analyticsComplete = false;
      if (Number.isFinite(t.subscribersGained)) a.subs += t.subscribersGained;
      if (Number.isFinite(t.averageViewPercentage) && Number.isFinite(t.views)) a.weighted += t.averageViewPercentage * t.views;
      for (const row of ch.trafficSources || []) { traffic[row.insightTrafficSourceType] = (traffic[row.insightTrafficSourceType] || 0) + row.views; trafficTotal += row.views; }
    }
  }
  if (analyticsComplete) {
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
  }

  // platform split (plays are real watching; reach is not)
  const youtubeComplete = eps.every((e) => Number.isFinite(e.latest?.ytTotal) && e.latest.ytTotal >= 0);
  const xValues = eps.map((e) => e.latest?.xPlays).filter(Number.isFinite);
  const ytAll = youtubeComplete ? eps.reduce((a, e) => a + e.latest.ytTotal, 0) : null;
  const xAll = xValues.length === eps.length && eps.every((e) => !e.latest?.xPlaysInfo?.partial && !e.latest?.xPlaysInfo?.stale)
    ? xValues.reduce((a, value) => a + value, 0) : null;
  add("views-yt-all", ytAll, "all-show YouTube views");
  add("views-x-all", xAll, "all-show X broadcast plays");
  if (ytAll != null && xAll != null && ytAll + xAll > 0) add("share-x-all", (xAll / (ytAll + xAll)) * 100, "share of all watching on X");
  add("views-total-all", ytAll != null && xAll != null ? ytAll + xAll : null, "all-show total views");

  return { generatedAt: data.generatedAt, facts, excerpts, context };
}

// --- validation: every number in an item must exist in the fact sheet ---

function numberTokens(text) {
  // thousands groups must be exact (12,710) — a sentence comma after a digit
  // ("minute 2–3, right…") is punctuation, not part of the number
  return String(text).match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [];
}

function displaysOf(v) {
  return new Set([String(v), v.toLocaleString("en-US"), String(Math.round(v)), Math.round(v).toLocaleString("en-US"), v.toFixed(1), v.toFixed(2)]);
}

// small structural constants an action may name (positions, ranges, dates)
const STRUCTURAL = ["1", "2", "3", "5", "90", "100", "1,000", "07", "17", "23", "30"];

// every spelling of every fact value the model may write; also sent to the
// model verbatim (v8 W20) so compliance is copy-work, not arithmetic
function allowedTokens(facts) {
  const allowed = new Set();
  for (const f of facts) for (const s of displaysOf(f.value)) allowed.add(s);
  for (const s of STRUCTURAL) allowed.add(s);
  return allowed;
}

function checkItem(item, allowed, seen, facts = []) {
  if (!item || typeof item !== "object") throw new Error("item must be an object");
  if (typeof item.id !== "string" || !/^[a-z0-9-]{3,40}$/.test(item.id) || seen.has(item.id)) throw new Error(`bad or duplicate id ${JSON.stringify(item.id)}`);
  seen.add(item.id);
  if (!CATEGORIES.has(item.category)) throw new Error(`${item.id}: illegal category`);
  if (item.serves != null && !CHECK_KEYS.has(item.serves)) throw new Error(`${item.id}: serves names an unknown check`);
  const basesCited = new Set();
  for (const key of ["text", "recommendation"]) {
    const value = item[key];
    if (typeof value !== "string" || !value.trim() || value.length > 260) throw new Error(`${item.id}: ${key} missing or too long`);
    if (BANNED.test(value) || MARKUP.test(value)) throw new Error(`${item.id}: ${key} contains banned jargon or markup`);
    for (const token of numberTokens(value)) {
      if (!allowed.has(token)) throw new Error(`${item.id}: number ${token} is not in the fact sheet`);
    }
    // like for like (PRD v9 F28): a number that can only be a young episode's
    // rate must not sit beside one that can only be a mature episode's rate.
    // Basis evidence comes only from distinctive citations: an episode label
    // ("E5") names an episode without citing a rate, and a structural constant
    // can be a position or a date — neither counts as evidence.
    for (const token of numberTokens(value.replace(/\bE\d+\b/g, ""))) {
      if (STRUCTURAL.includes(token)) continue;
      const matches = facts.filter((f) => f.kind === "episode-rate" && displaysOf(f.value).has(token));
      if (matches.length && matches.every((f) => f.basis === "young")) basesCited.add("young");
      if (matches.length && matches.every((f) => f.basis === "mature")) basesCited.add("mature");
    }
  }
  if (basesCited.has("young") && basesCited.has("mature")) throw new Error(`${item.id}: compares a young episode's rate with a finished episode's`);
  if (item.caveat != null && (typeof item.caveat !== "string" || item.caveat.length > 200 || BANNED.test(item.caveat))) throw new Error(`${item.id}: bad caveat`);
}

// Exports for build-data's currency check (PRD v9 baselines F32): an item
// whose numbers have since left today's fact sheet is held back as stale.
export const allowedNumbers = allowedTokens;
export function validateItem(item, facts, allowed = allowedTokens(facts)) {
  checkItem(item, allowed, new Set(), facts);
  return item;
}

export function validateItems(items, facts) {
  if (!Array.isArray(items) || items.length < 3 || items.length > 8) throw new Error("between three and eight items required");
  const allowed = allowedTokens(facts);
  const seen = new Set();
  for (const item of items) checkItem(item, allowed, seen, facts);
  return items;
}

// --- v8 W19: deterministic prune — the store can always be made true ---

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
    try { checkItem(item, allowed, seen, sheet.facts); kept.push(item); }
    catch (error) { prunedIds.push(String(item?.id ?? "?")); console.log(`recommendations: prune dropped ${item?.id ?? "?"} — ${error.message}`); }
  }
  // the three-item floor comes FIRST: a store that is already under three
  // items (however it got that way) must not survive as "untouched" — the
  // gate would fail it and block publish, the exact failure this retires
  if (kept.length < 3) {
    unlinkSync(STORE_PATH);
    console.log(`recommendations: prune left ${kept.length} item(s) — below the three-item floor, store removed; the page falls back to the deterministic insights`);
    return { kept: 0, prunedIds, existed: true, removed: true };
  }
  if (!prunedIds.length) {
    // The prose may still ground while an unused stamped fact changed. Keep
    // the fact inventory current so corrected source data cannot remain in a
    // supposedly current recommendation store.
    const facts = sheet.facts.map((f) => ({ id: f.id, value: f.value }));
    const factsChanged = JSON.stringify(store.facts || null) !== JSON.stringify(facts);
    if (factsChanged || store.factsGeneratedAt !== sheet.generatedAt) {
      saveAtomic(STORE_PATH, {
        ...store,
        updatedAt: new Date().toISOString(),
        factsGeneratedAt: sheet.generatedAt,
        facts,
        regroundedAt: new Date().toISOString(),
      });
      console.log(`recommendations: prune — all ${kept.length} item(s) still ground; stamped facts refreshed`);
      return { kept: kept.length, prunedIds, existed: true, refreshed: true };
    }
    console.log(`recommendations: prune — all ${kept.length} item(s) still ground against the current facts; store untouched`);
    return { kept: kept.length, prunedIds, existed: true, refreshed: false };
  }
  saveAtomic(STORE_PATH, {
    ...store,
    updatedAt: new Date().toISOString(),
    factsGeneratedAt: sheet.generatedAt,
    // the facts the items were grounded on (baselines PRD v9 §4.6)
    facts: sheet.facts.map((f) => ({ id: f.id, value: f.value })),
    prunedAt: new Date().toISOString(),
    prunedIds,
    items: kept,
  });
  console.log(`recommendations: prune dropped ${prunedIds.length} item(s) (${prunedIds.join(", ")}), kept ${kept.length} — store re-grounded`);
  return { kept: kept.length, prunedIds, existed: true };
}

// --- model call (same provider plumbing as health.mjs) ---

const SYSTEM = `You are the tactical recommendation engine for the two Dive Radio owners. You receive a deterministic fact sheet of everything the pipeline measured, plus context: today's show-health read (each check's state — healthy, steady, fragile, or waiting — its headline and reasoning), which way every durable measure is heading over the last clean episodes, the outlook for the next first week, and each episode's launch word. Return raw JSON only: {"items":[{"id":"kebab-id","category":"content|distribution|promotion|audience","serves":"growth|audienceQuality|reachEfficiency|livePull|participation|conversion|sentiment|null","text":"...","recommendation":"..."}]} with EXACTLY FIVE items, in order: item one is the single most valuable thing to do this week, item five the least.

Rules:
1. text states ONE finding in at most 260 characters using only numbers copied exactly from the fact sheet. recommendation is ONE concrete action the hosts can take this week — imperative, specific, no hedging, at most 260 characters. serves names the show-health check the action helps most, or null.
2. Anchor the five in today's read: lead with the checks whose state is fragile and the measures heading down that the hosts can act on (a chat that thinned, a launch that ran soft, an announce that few played, viewers who left early); a healthy check earns an action only to protect or extend it. Never recommend against a promo-driven lift as if it were organic. Then the largest remaining levers: where viewers are lost, which channel converts, which surfaces bring nothing, what the best finished episode did differently. Cover at least three different checks across the five.
3. Call out per-channel differences (Dive Club vs DesignerTom) whenever the gap matters, alongside the blended number.
4. Plain words. Never write: composite, percentile, pillar, ratio, multiple-times comparisons, velocity, coverage, basis, median, delta, or cumulative. No markup, no links.
5. Association is not cause — recommend tests and changes, never certainties.
6. Watch-moment facts (drop-*/hold-*) arrive with transcript excerpts in the payload. Excerpts are quotable context, not numbers. Name a moment's position in plain words ("about a third of the way in") and treat its timing as approximate — it comes from the live recording. Never claim the words caused the exit; recommend a test instead (trim, tighten, re-order).
7. The payload's allowedNumbers list is the complete set of number spellings you may write. Every digit sequence in your output must appear verbatim in that list. Never compute, round, combine, or convert numbers — if the number you want is not in the list, make the point without a number.
8. Facts marked basis "young" belong to episodes under three weeks old; their rates are not comparable with finished episodes. Never rank, compare, or call "best" across a young and a mature episode's rates; compare finished episodes with finished ones, and say when a number is from an episode still in its first weeks.
9. context carries words, not numbers: a state word, a direction word, a launch word may be quoted; every digit you write still comes from allowedNumbers. A measure marked "carried from an older finished episode" describes that episode, not the newest; a "promo-driven lift" is shown, never scored, and never a reason to celebrate or to worry.`;

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
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
  const body = await res.json();
  const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, model };
}

// v8 W20: up to three attempts; a grounding failure goes back to the model
// verbatim so the retry is a correction, not a re-roll. Transport errors
// (no key, HTTP, timeout) throw immediately — retrying those wastes the
// window and the prune floor handles the day.
async function regenerate(sheet) {
  const messages = [{ role: "user", content: JSON.stringify({
    task: `Write this week's five tactical recommendations, ranked, anchored in today's show-health read.`,
    context: sheet.context,
    facts: sheet.facts,
    excerpts: sheet.excerpts,
    allowedNumbers: [...allowedTokens(sheet.facts)].sort((a, b) =>
      (parseFloat(a.replace(/,/g, "")) - parseFloat(b.replace(/,/g, ""))) || a.localeCompare(b)),
  }) }];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callModel(messages);
    let parsed = null;
    try {
      parsed = JSON.parse(result.text);
      validateItems(parsed.items, sheet.facts);
      if (parsed.items.length !== TOP_N) throw new Error(`exactly ${TOP_N} ranked items required, got ${parsed.items.length}`);
      return { items: parsed.items, model: result.model, attempts: attempt };
    } catch (error) {
      console.log(`recommendations: attempt ${attempt}/3 failed grounding — ${error.message}`);
      // the exact failure and the item it points at go back with the reply,
      // so the retry is a targeted correction (v8 W20)
      const id = /^([a-z0-9-]{3,40}): /.exec(error.message)?.[1];
      const offender = (id && Array.isArray(parsed?.items) && parsed.items.find((x) => x?.id === id)) || null;
      messages.push({ role: "assistant", content: result.text });
      messages.push({ role: "user", content: `Your reply failed validation: ${error.message}.${offender ? ` The offending item was: ${JSON.stringify(offender)}.` : ""} Return the corrected full JSON now — same rules, every digit sequence copied verbatim from allowedNumbers.` });
    }
  }
  throw new Error("three attempts all failed grounding");
}

async function main() {
  assertSourceStoreIntegrity(ROOT);
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
  // facts when this script exits (v8 W19)
  try {
    const gen = await regenerate(sheet);
    saveAtomic(STORE_PATH, {
      version: STORE_VERSION,
      promptVersion: PROMPT_VERSION,
      updatedAt: new Date().toISOString(),
      provider: "anthropic",
      model: gen.model,
      factsGeneratedAt: sheet.generatedAt,
    // the facts the items were grounded on (baselines PRD v9 §4.6)
    facts: sheet.facts.map((f) => ({ id: f.id, value: f.value })),
      attempts: gen.attempts,
      // W35: the items are in rank order — the first is this week's biggest lever
      ranked: true,
      items: gen.items,
    });
    console.log(`recommendations: saved ${gen.items.length} ranked item(s) after ${gen.attempts} attempt(s) — rebuild data to publish`);
  } catch (error) {
    console.log(`WARN recommendations: ${error.message}; falling back to the deterministic prune`);
    pruneStore(sheet);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) Promise.resolve().then(() => withSourceLock(STORE_PATH, main)).catch((error) => {
  process.stderr.write(`recommendations: ${error.message}\n`);
  process.exit(1);
});
