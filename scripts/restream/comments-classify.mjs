#!/usr/bin/env node
// comments-classify.mjs — model-backed relevance, sentiment, and theme labels.
// Dedicated model script: no SDK dependencies, fetch only. The deterministic
// exporter reads its persisted store; build-data.mjs never calls a model.
//
// First gate while bringing up a model id:
//   node scripts/restream/comments-classify.mjs --probe-model

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PROMPT_PATH = join(HERE, "comments-classify-prompt.md");
const COMMENTS_DIR = join(ROOT, "data", "restream", "comments");
const STORE_PATH = join(ROOT, "data", "restream", "comments-classified.json");
const GOLDEN_PATH = join(ROOT, "tools", "dive-analytics", "audit", "golden-comments.json");
const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";
const MAX_TOKENS = 16000;
export const CLASSIFIER_VERSION = 1;
export const PROMPT_VERSION = 1;
export const THEME_VOCABULARY = [
  "call-in segment", "host chemistry", "topic choice", "guest",
  "audio quality", "video quality", "episode length", "pacing", "format",
  "thumbnail/title", "other",
];
const THEMES = new Set(THEME_VOCABULARY);
const RELEVANCE = new Set(["feedback", "noise"]);
const SENTIMENTS = new Set(["positive", "negative", "neutral", "mixed"]);

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function promptText() {
  return readFileSync(PROMPT_PATH, "utf8");
}

function allComments() {
  const rows = [];
  if (!existsSync(COMMENTS_DIR)) return rows;
  for (const filename of readdirSync(COMMENTS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const raw = loadJson(join(COMMENTS_DIR, filename), null);
    if (!raw) throw new Error(`${filename}: comments store is unreadable`);
    for (const comment of raw.comments || []) rows.push({ ...comment, slug: raw.slug });
  }
  return rows;
}

function blankStore() {
  return {
    version: CLASSIFIER_VERSION,
    method: "model-v1",
    promptVersion: PROMPT_VERSION,
    promptHash: null,
    configHash: null,
    provider: null,
    model: null,
    vocabulary: THEME_VOCABULARY,
    updatedAt: null,
    classified: {},
  };
}

export function loadClassifiedStore() {
  return loadJson(STORE_PATH, blankStore());
}

export function providerConfig() {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.COMMENTS_MODEL || DEFAULT_ANTHROPIC_MODEL,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    if (!process.env.COMMENTS_MODEL) {
      throw new Error("COMMENTS_MODEL must name a live-tested OpenAI model when only OPENAI_API_KEY is set");
    }
    return { provider: "openai", key: process.env.OPENAI_API_KEY, model: process.env.COMMENTS_MODEL };
  }
  throw new Error("ANTHROPIC_API_KEY or OPENAI_API_KEY is required");
}

async function callOnce(system, payload) {
  const cfg = providerConfig();
  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (!text.trim()) throw new Error(`empty Anthropic response (stop_reason ${body.stop_reason}, blocks ${JSON.stringify((body.content || []).map((b) => b.type))}, output_tokens ${body.usage?.output_tokens})`);
    return { text, ...cfg };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      max_output_tokens: MAX_TOKENS,
      instructions: system,
      input: JSON.stringify(payload),
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.output_text || (body.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n");
  if (!text.trim()) throw new Error("empty OpenAI response");
  return { text, ...cfg };
}

const RETRY_DELAYS_MS = [2000, 8000, 20000, 45000];

async function callModel(system, payload) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.error(`classifier: attempt ${attempt} failed (${lastErr.message}) — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await callOnce(system, payload);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`model call failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastErr.message}`);
}

export function parseClassifications(text, expectedIds) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new Error(`response was not raw JSON: ${err.message}`); }
  const rows = parsed?.classifications;
  if (!Array.isArray(rows)) throw new Error("response.classifications must be an array");
  const expected = new Set(expectedIds);
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !expected.has(row.id) || seen.has(row.id)) throw new Error(`unexpected or duplicate id ${JSON.stringify(row?.id)}`);
    seen.add(row.id);
    if (!RELEVANCE.has(row.relevance)) throw new Error(`${row.id}: illegal relevance`);
    if (!SENTIMENTS.has(row.sentiment)) throw new Error(`${row.id}: illegal sentiment`);
    if (!Array.isArray(row.themes) || row.themes.length > 2 || row.themes.some((t) => !THEMES.has(t))) throw new Error(`${row.id}: illegal themes`);
    if (row.relevance === "noise" && (row.sentiment !== "neutral" || row.themes.length)) throw new Error(`${row.id}: noise must be neutral with no themes`);
    if (row.relevance === "feedback" && row.sentiment !== "neutral" && row.themes.length < 1) throw new Error(`${row.id}: evaluative feedback needs a theme`);
    if (typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) throw new Error(`${row.id}: confidence outside 0..1`);
  }
  if (seen.size !== expected.size) throw new Error(`response returned ${seen.size} of ${expected.size} ids`);
  return rows;
}

function currentConfig() {
  const cfg = providerConfig();
  const prompt = promptText();
  const promptHash = sha(prompt);
  const configHash = sha(JSON.stringify({
    version: CLASSIFIER_VERSION,
    promptVersion: PROMPT_VERSION,
    promptHash,
    model: cfg.model,
    provider: cfg.provider,
    vocabulary: THEME_VOCABULARY,
  }));
  return { ...cfg, prompt, promptHash, configHash };
}

function stampStore(store, cfg, now) {
  store.version = CLASSIFIER_VERSION;
  store.method = "model-v1";
  store.promptVersion = PROMPT_VERSION;
  store.promptHash = cfg.promptHash;
  store.configHash = cfg.configHash;
  store.provider = cfg.provider;
  store.model = cfg.model;
  store.vocabulary = THEME_VOCABULARY;
  store.updatedAt = now;
}

function assertVersionDiscipline(store, { reclassify = false } = {}) {
  const count = Object.keys(store.classified || {}).length;
  if (!count) return;
  if (store.version > CLASSIFIER_VERSION) {
    throw new Error(`store version ${store.version} is newer than classifier version ${CLASSIFIER_VERSION}`);
  }
  if (store.version < CLASSIFIER_VERSION && !reclassify) {
    throw new Error(`classifier version changed ${store.version} → ${CLASSIFIER_VERSION}; run --reclassify-all`);
  }
  if (reclassify && store.version >= CLASSIFIER_VERSION) {
    throw new Error(`--reclassify-all requires a visible version bump above store version ${store.version}`);
  }
  if (JSON.stringify(store.vocabulary || []) !== JSON.stringify(THEME_VOCABULARY) && store.version === CLASSIFIER_VERSION) {
    throw new Error("theme vocabulary changed without a classifier version bump");
  }
  if (store.promptVersion === PROMPT_VERSION && store.promptHash && store.promptHash !== sha(promptText())) {
    throw new Error("classifier prompt changed without a prompt version bump");
  }
}

function goldenCases() {
  const golden = loadJson(GOLDEN_PATH, null);
  if (!golden || !Array.isArray(golden.cases) || golden.cases.length < 35) {
    throw new Error("golden-comments.json must contain at least 35 hand-labeled cases");
  }
  const ids = new Set();
  for (const c of golden.cases) {
    if (!c.id || !c.text || ids.has(c.id)) throw new Error(`bad or duplicate golden id ${JSON.stringify(c.id)}`);
    ids.add(c.id);
    if (!RELEVANCE.has(c.expected?.relevance)) throw new Error(`${c.id}: bad golden relevance`);
    if (c.expected.relevance === "feedback" && !SENTIMENTS.has(c.expected.sentiment)) throw new Error(`${c.id}: bad golden sentiment`);
  }
  return golden.cases;
}

async function runGoldenGate(store, cfg, now) {
  const cases = goldenCases();
  const comments = cases.map((c) => ({ id: c.id, text: c.text }));
  const result = await callModel(cfg.prompt, { task: "classify", comments });
  const rows = parseClassifications(result.text, comments.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let relevanceCorrect = 0;
  let sentimentCorrect = 0;
  let sentimentTotal = 0;
  const misses = [];
  for (const c of cases) {
    const got = byId.get(c.id);
    if (got.relevance === c.expected.relevance) relevanceCorrect++;
    else misses.push(`${c.id}: relevance ${got.relevance}, expected ${c.expected.relevance}`);
    if (c.expected.relevance === "feedback") {
      sentimentTotal++;
      if (got.sentiment === c.expected.sentiment) sentimentCorrect++;
      else misses.push(`${c.id}: sentiment ${got.sentiment}, expected ${c.expected.sentiment}`);
    }
  }
  const relevancePct = Math.round((relevanceCorrect / cases.length) * 10000) / 100;
  const sentimentPct = sentimentTotal ? Math.round((sentimentCorrect / sentimentTotal) * 10000) / 100 : 100;
  const passed = relevanceCorrect === cases.length && sentimentPct >= 95;
  stampStore(store, cfg, now);
  store.golden = {
    at: now,
    passed,
    configHash: cfg.configHash,
    cases: cases.length,
    relevance: { correct: relevanceCorrect, total: cases.length, pct: relevancePct },
    sentiment: { correct: sentimentCorrect, total: sentimentTotal, pct: sentimentPct },
    misses,
  };
  saveAtomic(STORE_PATH, store);
  console.log(`classifier golden: relevance ${relevanceCorrect}/${cases.length} (${relevancePct}%), sentiment ${sentimentCorrect}/${sentimentTotal} (${sentimentPct}%)`);
  if (!passed) throw new Error(`golden gate failed${misses.length ? ` — ${misses.slice(0, 5).join("; ")}` : ""}`);
  return store.golden;
}

async function ensureGolden(store, cfg, now, { force = false } = {}) {
  if (!force && store.golden?.passed && store.golden.configHash === cfg.configHash) return store.golden;
  return runGoldenGate(store, cfg, now);
}

function deterministicAuditSample(rows, configHash) {
  const low = rows.filter((r) => r.confidence < 0.8);
  const lowIds = new Set(low.map((r) => r.id));
  const remaining = rows
    .filter((r) => !lowIds.has(r.id))
    .map((r) => ({ row: r, key: sha(`${configHash}:${r.id}`) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const sampleSize = Math.min(remaining.length, Math.max(1, Math.ceil(rows.length * 0.1)));
  return [...low, ...remaining.slice(0, sampleSize).map((x) => x.row)];
}

function sameLabel(a, b) {
  const at = [...a.themes].sort();
  const bt = [...b.themes].sort();
  return a.relevance === b.relevance && a.sentiment === b.sentiment && JSON.stringify(at) === JSON.stringify(bt);
}

async function classify({ reclassify = false } = {}) {
  const now = new Date().toISOString();
  const cfg = currentConfig();
  const store = loadClassifiedStore();
  store.classified ||= {};
  assertVersionDiscipline(store, { reclassify });
  await ensureGolden(store, cfg, now);

  const source = allComments();
  const comments = reclassify ? source : source.filter((c) => !store.classified[c.id]);
  if (!comments.length) {
    stampStore(store, cfg, now);
    store.lastRun = { at: now, status: "complete", added: 0, reviewed: 0, pendingIds: [] };
    saveAtomic(STORE_PATH, store);
    console.log(`classifier: 0 new comments (${Object.keys(store.classified).length} stored)`);
    return store.lastRun;
  }

  const input = comments.map((c) => ({ id: c.id, text: c.text }));
  let rows;
  let audits;
  try {
    const result = await callModel(cfg.prompt, { task: "classify", comments: input });
    rows = parseClassifications(result.text, input.map((c) => c.id));
    const auditSet = deterministicAuditSample(rows, cfg.configHash);
    const rawById = new Map(comments.map((c) => [c.id, c]));
    const auditInput = auditSet.map((r) => ({
      id: r.id,
      text: rawById.get(r.id).text,
      original: {
        relevance: r.relevance,
        sentiment: r.sentiment,
        themes: r.themes,
        confidence: r.confidence,
      },
    }));
    const auditPrompt = `${cfg.prompt}\n\n## Independent second read\nRe-classify each comment from scratch using only the rules above. Each comment carries the first pass's label under "original" for reference only. Form your own judgment; where your best label differs from the original, return yours. Return the same classifications JSON shape.`;
    const auditResult = await callModel(auditPrompt, { task: "second read", comments: auditInput });
    audits = parseClassifications(auditResult.text, auditInput.map((c) => c.id));
  } catch (err) {
    stampStore(store, cfg, now);
    store.lastRun = { at: now, status: "pending", added: 0, reviewed: 0, pendingIds: comments.map((c) => c.id), error: err.message };
    saveAtomic(STORE_PATH, store);
    throw err;
  }

  const auditById = new Map(audits.map((r) => [r.id, r]));
  let reviewed = 0;
  const next = reclassify ? {} : { ...store.classified };
  for (const row of rows) {
    const audit = auditById.get(row.id);
    const agreed = !audit || sameLabel(row, audit);
    if (!agreed) reviewed++;
    next[row.id] = {
      state: agreed ? "ready" : "review",
      relevance: row.relevance,
      sentiment: row.sentiment,
      themes: row.themes,
      confidence: row.confidence,
      classifierVersion: CLASSIFIER_VERSION,
      promptVersion: PROMPT_VERSION,
      model: cfg.model,
      classifiedAt: now,
      ...(audit ? {
        audit: {
          at: now,
          agreed,
          relevance: audit.relevance,
          sentiment: audit.sentiment,
          themes: audit.themes,
          confidence: audit.confidence,
        },
      } : {}),
    };
  }
  store.classified = next;
  stampStore(store, cfg, now);
  if (reclassify) store.reclassifiedAt = now;
  store.lastRun = { at: now, status: "complete", added: rows.length, reviewed, pendingIds: [] };
  saveAtomic(STORE_PATH, store);
  console.log(`classifier: ${rows.length} comment(s) labeled, ${reviewed} sent to review (${Object.keys(store.classified).length} stored)`);
  return store.lastRun;
}

async function probeModel() {
  const system = promptText();
  const comments = [{ id: "probe:mixed", text: "I love the new call-in format, but the audio keeps cutting out." }];
  const result = await callModel(system, { task: "classify", comments });
  const rows = parseClassifications(result.text, comments.map((c) => c.id));
  if (rows[0].relevance !== "feedback" || rows[0].sentiment !== "mixed") {
    throw new Error(`probe label was ${rows[0].relevance}/${rows[0].sentiment}, expected feedback/mixed`);
  }
  console.log(`classifier probe: ${result.provider}/${result.model} returned valid feedback/mixed JSON`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let task;
  if (process.argv.includes("--probe-model")) task = probeModel();
  else if (process.argv.includes("--golden")) {
    const now = new Date().toISOString();
    const store = loadClassifiedStore();
    const cfg = currentConfig();
    assertVersionDiscipline(store);
    task = ensureGolden(store, cfg, now, { force: true });
  } else task = classify({ reclassify: process.argv.includes("--reclassify-all") });
  task.catch((err) => {
    process.stderr.write(`classifier: ${err.message}\n`);
    process.exit(1);
  });
}
