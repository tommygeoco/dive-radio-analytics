#!/usr/bin/env node
// moment-summaries.mjs — v6.1 W17: model-written context for watch moments.
//
// The panel pins and the Slack sharpest-exit line no longer show raw
// transcript quotes (owner directive 2026-08-23): each moment carries ONE
// written summary of what was being discussed or shown at that stretch of
// the show, and by whom. Summaries are editorial prose, so build-data
// (deterministic, never calls a model) can never write them — they live in
// this store, written by a model or seeded from an owner session, and
// build-data attaches them verbatim. A moment without a summary renders no
// context line at all: absence stays silent, and a raw quote is never the
// fallback. The verbatim excerpt stays in the data for provenance and as
// the engine's quotable context.
//
// Discipline (mirrors recommendations.mjs):
//   - A summary describes; it never introduces numbers. Digits are banned
//     outright — the pin's meta line already carries position and time.
//   - Plain words (the shared banned-jargon list), no markup, no links,
//     one line, 20–220 characters.
//   - Keys are slug|kind|at. Moments can move as the analytics refresh; an
//     entry whose moment vanished goes stale and unused (kept for history),
//     and a brand-new moment renders without context until the next run.
//   - Failure keeps the previous store as the public truth.
//
// Run:
//   node tools/dive-analytics/moment-summaries.mjs           # write missing summaries
//   node tools/dive-analytics/moment-summaries.mjs --check   # validate the store only
//
// Chain (owner machine): ratings → build-data → validate → health →
//   recommendations → moment-summaries → build-data → validate → publish

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BANNED } from "./recommendations.mjs";
import { parseTranscript } from "./watch-moments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STORE_PATH = join(ROOT, "data", "restream", "moment-summaries.json");
const TRANSCRIPTS = join(ROOT, "transcripts");
const MAX_TOKENS = 4000;
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";
const WINDOW_SEC = 120; // context handed to the model, wider than the excerpt

export const STORE_VERSION = 1;
export const PROMPT_VERSION = 1;
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

export function momentKey(slug, m) {
  return `${slug}|${m.kind}|${m.at}`;
}

// One summary's content contract. Throws with the reason on violation.
export function validateSummary(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("summary missing");
  if (text.length < 20 || text.length > 220) throw new Error(`summary length ${text.length} outside 20–220`);
  if (/\n/.test(text)) throw new Error("summary must be one line");
  if (/\d/.test(text)) throw new Error("summary contains a digit — numbers live in the pin's meta line, never here");
  if (BANNED.test(text)) throw new Error("summary contains banned jargon");
  if (MARKUP.test(text)) throw new Error("summary contains markup or a link");
  return text;
}

export function validateStore(store) {
  if (!store || store.version !== STORE_VERSION) throw new Error("unsupported store version");
  if (!store.provider || !store.updatedAt) throw new Error("store missing provenance stamps");
  if (!store.entries || typeof store.entries !== "object" || Array.isArray(store.entries)) throw new Error("entries must be an object");
  for (const [key, entry] of Object.entries(store.entries)) {
    if (!/^[a-z0-9-]+\|(?:drop|hold)\|0?\.\d+$/.test(key) && !/\|1$/.test(key)) throw new Error(`bad key ${JSON.stringify(key)}`);
    if (!entry.writtenAt) throw new Error(`${key}: entry missing writtenAt`);
    try { validateSummary(entry.summary); } catch (error) { throw new Error(`${key}: ${error.message}`); }
  }
  return store;
}

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

// Transcript context for the model: spoken words around each moment, wider
// than the stored excerpt, headers reduced to speaker changes.
export function momentWindows() {
  const data = readJson(DATA_PATH);
  if (!data?.episodes?.length) throw new Error("data.json has no episodes");
  const out = [];
  for (const e of data.episodes) {
    const moments = e.watch?.moments || [];
    if (!moments.length) continue;
    const path = join(TRANSCRIPTS, `${e.slug}.txt`);
    if (!existsSync(path)) continue;
    const { text, blocks } = parseTranscript(readFileSync(path, "utf8"));
    for (const m of moments) {
      const win = blocks.filter((b) => b.sec >= m.estSec - WINDOW_SEC && b.sec <= m.estSec + WINDOW_SEC);
      const words = win.map((b) => `${b.speaker ? `[${b.speaker}] ` : ""}${text.slice(b.textStart, b.textEnd)}`).join(" ").replace(/\s+/g, " ").trim();
      out.push({ key: momentKey(e.slug, m), episode: `E${e.ep} — ${e.title}`, kind: m.kind, estSec: m.estSec, words });
    }
  }
  return out;
}

const SYSTEM = `You write one-line context notes for a podcast analytics dashboard. Each input is a transcript window around a moment where the audience left (drop) or extra viewers were watching (hold). Return raw JSON only: {"summaries":{"<key>":"<summary>", ...}}.

Rules for every summary:
1. Describe what was being discussed or shown at that stretch, and by whom — hosts, a guest, a caller, a recorded nomination video. Attribute only what the words support; speaker labels are automatic and unverified, so use roles, or a name only when it is spoken in the window.
2. One line, 20–220 characters, present tense, plain words. Never write: composite, percentile, pillar, ratio, velocity, coverage, basis, median, delta, or cumulative.
3. NO digits at all — position and time render elsewhere. No markup, no links, no quotation of full sentences.
4. Describe; never speculate about WHY people left, and never editorialize about the show's quality.`;

async function callModel(payload) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const model = process.env.SUMMARIES_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(payload) }] }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { text: (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"), model };
}

async function main() {
  const store = readJson(STORE_PATH) || { version: STORE_VERSION, promptVersion: PROMPT_VERSION, updatedAt: null, provider: null, model: null, entries: {} };
  if (process.argv.includes("--check")) {
    validateStore(store);
    console.log(`moment-summaries: store valid — ${Object.keys(store.entries).length} entr${Object.keys(store.entries).length === 1 ? "y" : "ies"}`);
    return;
  }
  const windows = momentWindows();
  const missing = windows.filter((w) => !store.entries[w.key]);
  if (!missing.length) {
    console.log("moment-summaries: every current moment already has a summary");
    return;
  }
  let result;
  try {
    result = await callModel({ task: "Write one context note per key.", moments: missing });
  } catch (error) {
    console.log(`WARN moment-summaries: ${error.message}; previous store kept`);
    return;
  }
  let added = 0;
  try {
    const parsed = JSON.parse(result.text);
    for (const w of missing) {
      const text = parsed.summaries?.[w.key];
      if (text == null) continue;
      validateSummary(text);
      store.entries[w.key] = { summary: text, writtenAt: new Date().toISOString() };
      added++;
    }
  } catch (error) {
    console.log(`WARN moment-summaries: invalid model output (${error.message}); previous store kept`);
    return;
  }
  if (!added) { console.log("WARN moment-summaries: model returned no usable summaries; previous store kept"); return; }
  store.version = STORE_VERSION;
  store.promptVersion = PROMPT_VERSION;
  store.updatedAt = new Date().toISOString();
  store.provider = "anthropic";
  store.model = result.model;
  validateStore(store);
  saveAtomic(STORE_PATH, store);
  console.log(`moment-summaries: wrote ${added} new summar${added === 1 ? "y" : "ies"} (${missing.length - added} skipped) — rebuild data to publish`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((error) => {
  process.stderr.write(`moment-summaries: ${error.message}\n`);
  process.exit(1);
});
