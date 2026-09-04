#!/usr/bin/env node
// chapters.mjs — topics with timestamps, one list per episode (PRD v12 W43).
//
// The only place a model reads a transcript end to end. For every episode
// with a transcript and no chapters yet, the model returns 6–12 chapters:
//   { start: "HH:MM:SS", title ≤ 80 chars, gist ≤ 160 chars, quote ≤ 12 words }
// Grounding (enforced here, re-checked by the validator from the store alone):
//   • start is a timestamp that EXISTS in the transcript (transcripts.hasTimestamp)
//   • quote is found verbatim within QUOTE_WINDOW_SEC after start (quoteFoundAfter)
//   • starts strictly increase; the first sits within FIRST_WITHIN_SEC of the
//     transcript's first timestamp; titles and gists carry no digits and no
//     banned jargon
// A chapter that fails is dropped; fewer than MIN_CHAPTERS survivors marks the
// episode "incomplete" and the brief says so. Chapters are written once per
// transcript (keyed by its sha256) and never rewritten without a
// PROMPT_VERSION bump — a re-pulled transcript gets a fresh list.
//
//   node tools/dive-analytics/chapters.mjs            # write missing chapters
//   node tools/dive-analytics/chapters.mjs --check    # validate the store, no model
//   node tools/dive-analytics/chapters.mjs --dry      # list what would be written

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BANNED } from "./recommendations.mjs";
import { readTranscript, hasTimestamp, quoteFoundAfter, toSeconds, slice } from "./transcripts.mjs";

import { atomicWriteText, withSourceLock } from "./source-io.mjs";
import { assertSourceStoreIntegrity } from "./source-integrity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
export const STORE_PATH = join(ROOT, "data", "restream", "chapters.json");
export const STORE_VERSION = 1;
export const PROMPT_VERSION = 1;
export const MIN_CHAPTERS = 6;
export const MAX_CHAPTERS = 10;   // review 2026-09-01: size budget — ten per episode
export const QUOTE_WINDOW_SEC = 90;
export const FIRST_WITHIN_SEC = 300;
export const MIN_GAP_SEC = 180;        // chapters at least three minutes apart (review 2026-09-01)
export const END_MARGIN_SEC = 60;      // the last chapter starts at least a minute before the transcript ends (a closing segment can be short)
const MAX_TOKENS = 24000;   // the model reasons over a whole transcript before it writes; the JSON itself is small
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";
const MARKUP = /<\/?[a-z]|```|https?:\/\/|\[[^\]]+\]\(/i;

function readJson(path, fallback = null) { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback; }
function saveAtomic(path, value) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

// one chapter's contract against its transcript; throws with the reason
export function validateChapter(ch, parsed, previous = null) {
  if (!ch || typeof ch !== "object") throw new Error("chapter must be an object");
  if (typeof ch.start !== "string" || !hasTimestamp(parsed, ch.start)) throw new Error(`start ${JSON.stringify(ch.start)} is not a timestamp in the transcript`);
  if (previous && toSeconds(ch.start) < toSeconds(previous.start) + MIN_GAP_SEC) throw new Error(`start ${ch.start} is under ${MIN_GAP_SEC / 60} minutes after ${previous.start}`);
  for (const [key, max] of [["title", 80], ["gist", 120]]) {
    const v = ch[key];
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${key} missing or longer than ${max}`);
    if (/\d/.test(v)) throw new Error(`${key} contains a digit — numbers live in the timestamp, never in the words`);
    if (BANNED.test(v) || MARKUP.test(v) || /\n/.test(v)) throw new Error(`${key} contains banned jargon, markup, or a line break`);
  }
  if (typeof ch.quote !== "string" || !ch.quote.trim() || ch.quote.trim().split(/\s+/).length > 12) throw new Error("quote missing or longer than twelve words");
  if (!quoteFoundAfter(parsed, ch.start, ch.quote, QUOTE_WINDOW_SEC)) throw new Error(`quote ${JSON.stringify(ch.quote)} is not found within ${QUOTE_WINDOW_SEC}s after ${ch.start}`);
  return ch;
}

// keep the chapters that ground, in order; report what was dropped
export function groundChapters(chapters, parsed) {
  const kept = [], dropped = [];
  let previous = null;
  for (const ch of Array.isArray(chapters) ? chapters : []) {
    try { validateChapter(ch, parsed, previous); kept.push({ start: ch.start, seconds: toSeconds(ch.start), title: ch.title.trim(), gist: ch.gist.trim(), quote: ch.quote.trim() }); previous = ch; }
    catch (error) { dropped.push({ start: ch?.start ?? null, why: error.message }); }
  }
  // the first chapter sits within FIRST_WITHIN_SEC of the first SPOKEN words —
  // caption transcripts open with tags like [music] minutes before anyone speaks
  const firstSpeech = parsed.segments.find((seg) => seg.text.replace(/\[[^\]]*\]|>>/g, "").trim().split(/\s+/).filter(Boolean).length >= 3) || parsed.segments[0];
  const firstOk = kept.length ? kept[0].seconds - (firstSpeech?.seconds ?? 0) <= FIRST_WITHIN_SEC : false;
  const list = kept.slice(0, MAX_CHAPTERS);
  const endOk = list.length ? parsed.durationSec - list.at(-1).seconds >= END_MARGIN_SEC : false;
  const status = list.length >= MIN_CHAPTERS && firstOk && endOk ? "complete" : "incomplete";
  return { chapters: list, dropped, status, firstOk, endOk };
}

export function validateStore(store, root = ROOT) {
  if (!store || store.version !== STORE_VERSION) throw new Error("unsupported store version");
  if (!store.entries || typeof store.entries !== "object" || Array.isArray(store.entries)) throw new Error("entries must be an object keyed by slug");
  if (store.superseded != null && !Array.isArray(store.superseded)) throw new Error("superseded must be a list");
  for (const [slug, entry] of Object.entries(store.entries)) {
    const parsed = readTranscript(root, slug);
    if (!parsed) throw new Error(`${slug}: transcript missing`);
    if (entry.sha256 !== parsed.sha256) throw new Error(`${slug}: chapters were written for a different transcript (sha mismatch)`);
    if (!["complete", "incomplete"].includes(entry.status)) throw new Error(`${slug}: bad status`);
    if (!entry.writtenAt || !entry.promptVersion) throw new Error(`${slug}: missing stamps`);
    const re = groundChapters(entry.chapters, parsed);
    if (re.dropped.length) throw new Error(`${slug}: stored chapter no longer grounds — ${re.dropped[0].why}`);
    if (re.status !== entry.status) throw new Error(`${slug}: status ${entry.status} does not re-derive (${re.status})`);
  }
  return store;
}

const SYSTEM = `You write chapter lists for episodes of Dive Radio, a live design show, from a full transcript. Return raw JSON only: {"chapters":[{"start":"HH:MM:SS","title":"…","gist":"…","quote":"…"}]} with six to ten chapters in order, at least three minutes apart.

Rules:
1. start must be copied EXACTLY from a timestamp line in the transcript (the line "HH:MM:SS [Speaker n]" or "HH:MM:SS  text") — the moment the topic begins. Never invent or round a timestamp.
2. title: what the stretch is about, at most 80 characters, plain words, no digits. gist: one sentence, at most 120 characters, no digits, describing what is discussed or shown and by whom (hosts, a guest, a caller) — describe, never judge the show.
3. quote: three to twelve consecutive words copied verbatim from the transcript within ninety seconds after start. This is how the chapter is verified; a paraphrase fails.
4. Chapters cover the whole episode from its first spoken minutes to its end; a live show has segments (intro, main topic, demos, call-ins, nominations, closing) — follow the actual flow.
5. Never write: composite, percentile, pillar, ratio, velocity, coverage, basis, median, delta, or cumulative. No markup, no links.`;

async function callModel(payload) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const model = process.env.CHAPTERS_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: "user", content: payload }] }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
  const body = await res.json();
  return { text: (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"), model, stopReason: body.stop_reason || null };
}

// the model may wrap the object in prose or a fence; take the outermost object
function extractJson(text) {
  const clean = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("no JSON object in the reply");
}

// the transcript as the model sees it: every timestamp line kept verbatim,
// spoken text compacted — the whole episode fits well inside the context
function transcriptForModel(parsed) {
  return parsed.segments.map((s) => `${s.stamp}${s.speaker ? ` [${s.speaker}]` : ""}  ${s.text}`).join("\n");
}

async function main() {
  assertSourceStoreIntegrity(ROOT);
  const check = process.argv.includes("--check");
  const dry = process.argv.includes("--dry");
  const store = readJson(STORE_PATH) || { version: STORE_VERSION, promptVersion: PROMPT_VERSION, updatedAt: null, provider: null, model: null, entries: {} };
  if (check) { validateStore(store); console.log(`chapters: store valid — ${Object.keys(store.entries).length} episode(s)`); return; }
  if (process.argv.includes("--regrade")) {
    // status is derived, never model output: re-derive it for every entry under the current rules (no model call)
    let changed = 0;
    for (const [slug, entry] of Object.entries(store.entries)) {
      const parsed = readTranscript(ROOT, slug);
      if (!parsed) continue;
      const re = groundChapters(entry.chapters, parsed);
      if (re.status !== entry.status) { entry.status = re.status; changed++; }
    }
    if (changed) { store.updatedAt = new Date().toISOString(); saveAtomic(STORE_PATH, store); }
    validateStore(store);
    console.log(`chapters: regraded ${changed} entr${changed === 1 ? "y" : "ies"}; store valid`);
    return;
  }
  const data = readJson(DATA_PATH);
  if (!data) throw new Error("data.json is missing — run build-data first");
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;   // one slug, for probes
  const episodes = data.episodes.filter((e) => e.transcript && (!only || e.slug === only)).sort((a, b) => a.premiere.localeCompare(b.premiere));
  const todo = [];
  for (const e of episodes) {
    const parsed = readTranscript(ROOT, e.slug);
    if (!parsed || parsed.segments.length < 20) continue;
    const have = store.entries[e.slug];
    if (have && have.sha256 === parsed.sha256 && have.promptVersion === PROMPT_VERSION) continue;
    todo.push({ episode: e, parsed, replaces: have || null });
  }
  if (!todo.length) { console.log("chapters: every transcript already has chapters under this prompt"); return; }
  if (dry) { for (const t of todo) console.log(`chapters: would write E${t.episode.ep} ${t.episode.slug} (${t.parsed.format}, ${t.parsed.segments.length} segments)`); return; }
  let written = 0;
  for (const { episode, parsed, replaces } of todo) {
    let result;
    try {
      result = await callModel(`Episode: ${episode.title}\nAired: ${episode.premiere}\nTranscript clock: ${parsed.clock === "upload" ? "the YouTube upload's" : "the live stream's"}\n\nTRANSCRIPT\n${transcriptForModel(parsed)}`);
    } catch (error) { console.log(`WARN chapters: E${episode.ep} model call failed — ${error.message}; skipped`); continue; }
    let parsedOut;
    try { parsedOut = extractJson(result.text); }
    catch (error) { console.log(`WARN chapters: E${episode.ep} returned no JSON (${error.message}; stop_reason ${result.stopReason}; reply starts: ${JSON.stringify(result.text.slice(0, 200))}); skipped`); continue; }
    const grounded = groundChapters(parsedOut.chapters, parsed);
    if (!grounded.chapters.length) { console.log(`WARN chapters: E${episode.ep} — none of the returned chapters ground (${grounded.dropped[0]?.why}); skipped`); continue; }
    if (replaces) {
      // rule 9: a changed transcript or prompt re-derives the list visibly —
      // the older list is kept byte-identical under superseded
      store.superseded = [...(store.superseded || []), { slug: episode.slug, supersededOn: new Date().toISOString().slice(0, 10), why: replaces.sha256 !== parsed.sha256 ? "transcript changed" : "prompt version changed", entry: replaces }];
    }
    store.entries[episode.slug] = {
      sha256: parsed.sha256, format: parsed.format, clock: parsed.clock, status: grounded.status,
      chapters: grounded.chapters, dropped: grounded.dropped.length,
      promptVersion: PROMPT_VERSION, model: result.model, writtenAt: new Date().toISOString(),
      ...(replaces ? { rederivedFrom: { sha256: replaces.sha256, promptVersion: replaces.promptVersion } } : {}),
    };
    written++;
    console.log(`chapters: E${episode.ep} — ${grounded.chapters.length} chapter(s) kept, ${grounded.dropped.length} dropped, ${grounded.status}`);
  }
  if (!written) { console.log("WARN chapters: nothing written; previous store kept"); return; }
  store.version = STORE_VERSION; store.promptVersion = PROMPT_VERSION; store.updatedAt = new Date().toISOString(); store.provider = "anthropic";
  validateStore(store);
  saveAtomic(STORE_PATH, store);
  console.log(`chapters: wrote ${written} episode(s) — rebuild data to publish`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) Promise.resolve().then(() => withSourceLock(STORE_PATH, main)).catch((error) => { process.stderr.write(`chapters: ${error.message}\n`); process.exit(1); });
