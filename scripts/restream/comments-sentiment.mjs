#!/usr/bin/env node
// comments-sentiment.mjs — legacy deterministic sentiment helper.
// W8 replaced this store as the source of truth with comments-classify.mjs.
// The dashboard now imports only hasNegativeSignal() as a conservative veto:
// a model-confirmed positive comment carrying complaint wording cannot become
// a featured quote. This script is not part of the daily classification chain.
//
// Method: wordlist-v1. Zero-model, zero-network, pure function of the text —
// same text always yields the same label. Known limits (accepted for v1, see
// the critic notes in the store header): sarcasm reads as its surface words,
// and sentiment is about the COMMENT's tone, not who/what it targets ("vscode
// is so dumb!" is negative-toned even though it agrees with the hosts).
//
// Storage: data/restream/comments-sentiment.json — one entry per comment id:
//   { label: "positive"|"negative"|"neutral", v: <classifier version>, at: ISO }
// Incremental and append-only: a run classifies ONLY ids not already in the
// store. Labels are never changed silently — an explicit `--reclassify-all`
// rewrites every entry under the current version and stamps reclassifiedAt
// at the store root, so any wholesale change is visible in the file history.
//
// CLI:  node scripts/restream/comments-sentiment.mjs            # classify new
//       node scripts/restream/comments-sentiment.mjs --reclassify-all
// API:  classifyText(text) -> label · classifyNew() -> {added, total}

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile, withSourceLock } from "../../tools/dive-analytics/source-io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMENTS_DIR = join(ROOT, "data", "restream", "comments");
const STORE_PATH = join(ROOT, "data", "restream", "comments-sentiment.json");

export const CLASSIFIER_VERSION = 1;
export const METHOD = "wordlist-v1";

// Word lists are matched on word boundaries against lowercased text.
// Multi-word phrases are checked before single words. Calibrated against the
// 2026-08 corpus (podcast audience language); extend lists in a version bump.
// Phrases must not restate a listed single word (that would double-count the
// same evidence: "love the" + "love" ≠ two signals).
const POS_PHRASES = [
  "well done", "keep it up", "more of this", "this is the kind of content",
  "thank you", "well made",
];
const POS_WORDS = [
  "love", "loved", "great", "awesome", "amazing", "best", "fantastic", "incredible",
  "fire", "banger", "peak", "favorite", "favourite", "brilliant", "gold", "goated",
  "excellent", "enjoyed", "enjoy", "insightful", "learned", "nailed", "smiled",
  "laughed", "funny", "haha", "thanks", "congrats", "cool", "nice", "dope",
  "informative", "inviting", "refreshing", "subscribed", "gem", "good",
  "excited", "perfect", "appreciate", "inspiring",
];
const NEG_PHRASES = [
  "fix your", "can't hear", "cant hear", "too long", "waste of time", "not for me",
  "makes me sick", "fell off", "let down",
];
const NEG_WORDS = [
  "hate", "hated", "worst", "terrible", "awful", "bad", "boring", "disappointing",
  "disappointed", "annoying", "cringe", "unwatchable", "clickbait", "meh",
  "broken", "unsubscribe", "dislike", "sucks", "trash", "garbage", "dumb",
  "stupid", "unlistenable", "grating", "offputting", "poor",
];
const NEGATORS = new Set([
  "not", "no", "never", "isnt", "isn't", "aint", "ain't", "dont", "don't",
  "didnt", "didn't", "wasnt", "wasn't", "hardly", "barely", "nothing", "cannot", "cant", "can't",
]);
// Raw-text scans (emoji don't tokenize) — counted once per distinct emoji kind.
const POS_EMOJI = /\u{1F525}|\u{2764}\u{FE0F}?|\u{1F602}|\u{1F4AF}|\u{1F44F}|\u{1F60D}|\u{1F979}|\u{1F642}|\u{1F44D}/gu;
const NEG_EMOJI = /\u{1F44E}|\u{1F4A9}/gu;

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}'@#]+/gu) || []);
}

function negatedAt(tokens, i) {
  for (let k = Math.max(0, i - 3); k < i; k++) if (NEGATORS.has(tokens[k])) return true;
  return false;
}

// Raw evidence counts — exposed so featuring can veto on ANY negative signal
// (a net-positive comment like "banger episode… pls fix your streaming" is a
// legal positive LABEL but an embarrassing featured QUOTE).
export function scoreText(text) {
  if (!text) return { pos: 0, neg: 0 };
  const lower = text.toLowerCase();
  const tokens = tokenize(text);
  let pos = 0;
  let neg = 0;

  for (const p of POS_PHRASES) if (lower.includes(p)) pos++;
  for (const p of NEG_PHRASES) if (lower.includes(p)) neg++;

  const posSet = new Set(POS_WORDS);
  const negSet = new Set(NEG_WORDS);
  tokens.forEach((t, i) => {
    if (posSet.has(t)) {
      // "not great" is negative evidence, not positive
      if (negatedAt(tokens, i)) neg++;
      else pos++;
    } else if (negSet.has(t)) {
      // "not bad" is mild praise at best — dampen to neutral, never flip
      if (!negatedAt(tokens, i)) neg++;
    }
  });

  pos += (text.match(POS_EMOJI) || []).length;
  neg += (text.match(NEG_EMOJI) || []).length;
  return { pos, neg };
}

export function hasNegativeSignal(text) {
  return scoreText(text).neg > 0;
}

export function classifyText(text) {
  const { pos, neg } = scoreText(text);
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

function loadJson(path, fallback) {
  return readJsonFile(path, { fallback });
}

export function loadStore() {
  return loadJson(STORE_PATH, {
    version: CLASSIFIER_VERSION,
    method: METHOD,
    updatedAt: null,
    classified: {},
  });
}

function saveStore(store) {
  atomicWriteJson(STORE_PATH, store);
}

function allComments() {
  const out = [];
  if (!existsSync(COMMENTS_DIR)) return out;
  for (const f of readdirSync(COMMENTS_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    const s = loadJson(join(COMMENTS_DIR, f), null);
    for (const c of s?.comments || []) out.push(c);
  }
  return out;
}

// Classify comments whose id is not yet in the store. Never touches existing
// labels. Returns counts; writes the store only when something was added.
function classifyNewUnlocked({ now = new Date().toISOString() } = {}) {
  const store = loadStore();
  let added = 0;
  for (const c of allComments()) {
    if (store.classified[c.id]) continue;
    store.classified[c.id] = { label: classifyText(c.text), v: CLASSIFIER_VERSION, at: now };
    added++;
  }
  if (added > 0) {
    store.updatedAt = now;
    saveStore(store);
  }
  return { added, total: Object.keys(store.classified).length };
}

// Explicit full reclassification under the current version — the ONLY path
// that may change an existing label, and it stamps itself at the store root.
function reclassifyAllUnlocked({ now = new Date().toISOString() } = {}) {
  const store = loadStore();
  let changed = 0;
  for (const c of allComments()) {
    const label = classifyText(c.text);
    const prev = store.classified[c.id];
    if (!prev || prev.label !== label || prev.v !== CLASSIFIER_VERSION) changed++;
    store.classified[c.id] = { label, v: CLASSIFIER_VERSION, at: prev?.at ?? now };
  }
  store.updatedAt = now;
  store.reclassifiedAt = now;
  store.version = CLASSIFIER_VERSION;
  saveStore(store);
  return { changed, total: Object.keys(store.classified).length };
}

export function classifyNew(options) { return withSourceLock(STORE_PATH, () => classifyNewUnlocked(options)); }
export function reclassifyAll(options) { return withSourceLock(STORE_PATH, () => reclassifyAllUnlocked(options)); }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--reclassify-all")) {
    const { changed, total } = reclassifyAll();
    console.log(`sentiment: reclassified all under wordlist-v${CLASSIFIER_VERSION} — ${changed} label(s) changed, ${total} total`);
  } else {
    const { added, total } = classifyNew();
    console.log(`sentiment: classified ${added} new comment(s) (${total} total in store)`);
  }
}
