#!/usr/bin/env node
// critic.mjs — standing critic for the shipped dashboard (PRD v4 Part 3).
// Audits the ARTIFACT (data.json + index.html as a reader experiences it)
// through five lenses: cognitive load, readability, verbosity/suppression,
// fact-check, decision usefulness. One model call, temperature 0. Findings go
// to tools/dive-analytics/audit/CRITIC-<date>.md. The critic never edits
// anything and never blocks publish: on model failure it writes "did not run"
// and exits 0. Prompt lives in critic-prompt.md (versioned; changes are commits).
//
// Run: node tools/dive-analytics/critic.mjs            (full run)
//      node tools/dive-analytics/critic.mjs --dry      (print bundle stats, no call)
//      node tools/dive-analytics/critic.mjs --tag W8   (keep same-day workstream reports separate)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(HERE, "audit");
const MODEL = "claude-fable-5";
const MAX_TOKENS = 16000;

// --- harvest: compact, deterministic audit bundle ---

function harvest() {
  const data = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  let ratings = null;
  try { ratings = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  let healthHistory = null;
  try { healthHistory = JSON.parse(readFileSync(join(ROOT, "data", "restream", "health-history.json"), "utf8")); } catch { /* absent */ }

  // episodes: the numbers a reader can see, compact
  const episodes = data.episodes.map((e) => ({
    ep: e.ep,
    title: e.title,
    premiere: e.premiere,
    ageDays: e.ageDays,
    trackedLate: e.partialHistory,
    totalViews: e.latest.totalViews,
    ytViews: e.latest.ytTotal,
    xPlays: e.latest.xPlays,
    xReach: e.latest.xImpressions,
    playsCoverage: e.latest.totalViewsInfo,
    week1Views: e.metrics.week1Velocity,
    week1Note: e.metrics.week1Note,
    engagementPer1k: e.metrics.engagementPer1k,
    anomaly: e.metrics.anomaly,
    live: e.live ? { peak: e.live.peak, avg: e.live.avg, chat: e.live.chatMessages, durationMin: e.live.durationMin } : null,
    comments: e.comments ? {
      captured: e.comments.captured,
      feedbackCount: e.comments.feedbackCount,
      uniqueCommenters: e.comments.uniqueCommenters,
      enjoyCount: e.comments.enjoyCount,
      complaintCount: e.comments.complaintCount,
      commentersPer1k: e.comments.commentersPer1k,
      enjoyThemes: e.comments.enjoyThemes,
      complaintThemes: e.comments.complaintThemes,
      xReplies: e.comments.xCoverage,
    } : null,
    rating: e.rating ? { rank: e.rating.rank, n: e.rating.n, score: e.rating.score, provisional: e.rating.provisional, coverage: e.rating.coverage, pillarScores: e.rating.pillarScores } : null,
  }));

  return {
    generatedAt: data.generatedAt,
    episodes,
    insights: data.insights.map((i) => ({ id: i.id, category: i.category, text: i.text, recommendation: i.recommendation, caveat: i.caveat })),
    showTrend: data.showTrend,
    commentSummary: data.commentSummary,
    health: data.health || null,
    healthStore: healthHistory?.entries?.length ? {
      count: healthHistory.entries.length,
      latest: healthHistory.entries.at(-1),
    } : null,
    ratingsStoreMeta: ratings ? { algorithm: ratings.algorithm, updatedAt: ratings.updatedAt, count: ratings.ratings?.length } : null,
    indexHtml: html,
  };
}

// --- model call ---

async function callModel(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // determinism note: this model rejects the temperature param; runs are
      // near-deterministic but not byte-stable — findings are advisory anyway.
      // adaptive thinking is always on for this model; max_tokens is sized so
      // the report fits after the reasoning spend.
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text.trim()) throw new Error("empty critic response");
  return text;
}

// --- main ---

const dry = process.argv.includes("--dry");
const date = new Date().toISOString().slice(0, 10);
const tagAt = process.argv.indexOf("--tag");
const tag = tagAt >= 0 ? process.argv[tagAt + 1] : null;
if (tagAt >= 0 && (!tag || !/^[A-Za-z0-9-]+$/.test(tag))) throw new Error("--tag requires letters, numbers, or hyphens");
const outPath = join(OUT_DIR, `CRITIC-${date}${tag ? `-${tag}` : ""}.md`);

const bundle = harvest();
const system = readFileSync(join(HERE, "critic-prompt.md"), "utf8");
const user = [
  "Audit this shipped dashboard state.",
  "",
  "## data (what renders; compact export of data.json + ratings)",
  "```json",
  JSON.stringify({ ...bundle, indexHtml: undefined }, null, 1),
  "```",
  "",
  "## index.html (full page source — CSS, copy templates, render logic, About text)",
  "```html",
  bundle.indexHtml,
  "```",
].join("\n");

if (dry) {
  console.log(`critic --dry: bundle ${Math.round(user.length / 1024)}KB, ${bundle.episodes.length} episodes, ${bundle.insights.length} insights. No call made.`);
  process.exit(0);
}

let report;
let ran = true;
try {
  report = await callModel(system, user);
} catch (err) {
  // one retry, then never block the chain
  try {
    report = await callModel(system, user);
  } catch (err2) {
    ran = false;
    report = `# Critic did not run — ${date}\n\nModel call failed twice: ${err2.message}\n\nPublish is unaffected; rerun manually: node tools/dive-analytics/critic.mjs`;
  }
}

const header = `# Dashboard critic — ${date}\n\nModel: ${MODEL} · prompt: critic-prompt.md · artifact: data.json generated ${bundle.generatedAt}\n\n---\n\n`;
writeFileSync(outPath, (ran ? header : "") + report + "\n");

if (ran) {
  const fails = (report.match(/^- FAIL/gm) || []).length;
  const warns = (report.match(/^- WARN/gm) || []).length;
  const passes = (report.match(/^- PASS/gm) || []).length;
  console.log(`critic: ${fails} FAIL, ${warns} WARN, ${passes} PASS -> ${outPath}`);
  if (fails > 0) console.log(`critic: FAILURES flagged — read ${outPath}`);
} else {
  console.log(`critic: did not run (model unavailable) -> ${outPath}`);
}
process.exit(0);
