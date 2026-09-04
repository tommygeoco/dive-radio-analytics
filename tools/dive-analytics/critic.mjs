#!/usr/bin/env node
// critic.mjs — standing critic for the shipped dashboard (PRD v4 Part 3).
// Audits the ARTIFACT (data.json + index.html as a reader experiences it)
// through five lenses: cognitive load, readability, verbosity/suppression,
// fact-check, decision usefulness. One model call plus one retry. Findings go
// to tools/dive-analytics/audit/CRITIC-<date>.md. The critic never edits
// anything. Findings are advisory; a failed or incomplete audit exits nonzero
// and preserves the previous report. Prompt lives in critic-prompt.md.
//
// Run: node tools/dive-analytics/critic.mjs            (full run)
//      node tools/dive-analytics/critic.mjs --dry      (print bundle stats, no call)
//      node tools/dive-analytics/critic.mjs --tag W8   (keep same-day workstream reports separate)

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText, fetchJson, phoenixDateKey, readJsonFile, withSourceLock } from "./source-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(HERE, "audit");
const MODEL = "claude-fable-5";
const MAX_TOKENS = 16000;

// --- harvest: compact, deterministic audit bundle ---

function harvest() {
  const data = readJsonFile(join(ROOT, "data.json"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const ratings = readJsonFile(join(ROOT, "data", "restream", "episode-ratings.json"), { fallback: null });
  const healthHistory = readJsonFile(join(ROOT, "data", "restream", "health-history.json"), { fallback: null });

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
    live: e.live ? { peak: e.live.peak, avg: e.live.avg, chat: e.live.chatMessages, chatters: e.live.chatters, durationMin: e.live.durationMin } : null,
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
    health: e.health?.pending
      ? { pending: true, readCompleteOn: e.health.readCompleteOn }
      : e.health
        ? { score: e.health.score, atDay: e.health.atDay, readCompleteOn: e.health.readCompleteOn, checks: e.health.checks, missingChecks: e.health.missingChecks, reason: e.health.reason, excluded: e.health.excluded, reproducible: e.health.reproducible }
        : null,
    // PRD v9 W26: the page's pace for this episode, as shipped
    pace: data.baselines?.pace?.[e.slug] ?? null,
    outlier: data.baselines?.anomaly?.[e.slug] ?? null,
  }));
  // analytics history lines behind the newest health read (if any exist yet)
  const historyLines = {};
  for (const e of data.episodes) {
    const hp = join(ROOT, "data", "restream", "yt-analytics-history", `${e.slug}.jsonl`);
    if (existsSync(hp)) {
      try { historyLines[e.slug] = readFileSync(hp, "utf8").split("\n").filter(Boolean).slice(-3).map((l) => JSON.parse(l)); }
      catch { throw new Error("critic analytics history is unreadable or malformed"); }
    }
  }

  return {
    generatedAt: data.generatedAt,
    episodes,
    insights: data.insights.map((i) => ({ id: i.id, category: i.category, text: i.text, recommendation: i.recommendation, caveat: i.caveat })),
    showTrend: data.showTrend,
    commentSummary: data.commentSummary,
    health: data.health || null,
    // PRD v9 W26: the one baselines definition, so typicals re-derive from
    // their stamped windows — never from the full episode array
    baselines: data.baselines ? { constants: data.baselines.constants, watchPct: data.baselines.watchPct, typicalCurve: { n: data.baselines.typicalCurve?.n, window: data.baselines.typicalCurve?.window }, newestVsPrevious: data.baselines.newestVsPrevious } : null,
    historyLines,
    insightsStale: data.insightsStale || [],
    healthStore: healthHistory?.entries?.length ? {
      count: healthHistory.entries.length,
      latest: healthHistory.entries.at(-1),
    } : null,
    ratingsStoreMeta: ratings ? { algorithm: ratings.algorithm, updatedAt: ratings.updatedAt, count: (ratings.scores ?? ratings.ratings)?.length } : null,
    indexHtml: html,
  };
}

// --- model call ---

async function callModel(system, user, { fetchImpl = fetch, key = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const j = await fetchJson("https://api.anthropic.com/v1/messages", {
    label: "critic model", fetchImpl, timeoutMs: 180000, maxAttempts: 1,
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
  });
  if (j.stop_reason !== "end_turn" || !Array.isArray(j.content)) throw new Error("critic model returned an incomplete response");
  const text = j.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  const findings = text.match(/^- (?:PASS|WARN|FAIL)\s+[—–-]\s+\S/gm) || [];
  if (![1,2,3,4,5].every((lens) => new RegExp(`^## ${lens}\\. \\S`, "m").test(text))
    || !/^## Verdict\s*\n\s*\S/m.test(text) || !/^## The one recommendation\s*\n\s*\S/m.test(text)
    || findings.length < 1 || findings.length > 12) throw new Error("critic model returned an invalid report");
  return text;
}

// --- main ---

export async function run({ dry = false, tag = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const date = phoenixDateKey(now);
  if (tag != null && (typeof tag !== "string" || !/^[A-Za-z0-9-]+$/.test(tag))) throw new Error("--tag requires letters, numbers, or hyphens");
  const outPath = join(OUT_DIR, `CRITIC-${date}${tag ? `-${tag}` : ""}.md`);
  return withSourceLock(outPath, async () => {
    const bundle = harvest();
    const system = readFileSync(join(HERE, "critic-prompt.md"), "utf8");
    const user = [
      "Audit this shipped dashboard state.",
      "",
      "## data (what renders; compact export of data.json + episode health)",
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
      return { dry: true, outPath };
    }

    let report;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { report = await callModel(system, user, { fetchImpl }); break; }
      catch (error) {
        if (attempt === 2) throw error;
      }
    }

    const header = `# Dashboard critic — ${date}\n\nModel: ${MODEL} · prompt: critic-prompt.md · artifact: data.json generated ${bundle.generatedAt}\n\n---\n\n`;
    atomicWriteText(outPath, header + report + "\n");
    const fails = (report.match(/^- FAIL/gm) || []).length;
    const warns = (report.match(/^- WARN/gm) || []).length;
    const passes = (report.match(/^- PASS/gm) || []).length;
    console.log(`critic: ${fails} FAIL, ${warns} WARN, ${passes} PASS -> ${outPath}`);
    if (fails > 0) console.log(`critic: FAILURES flagged — read ${outPath}`);
    return { outPath, fails, warns, passes };
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const tagAt = process.argv.indexOf("--tag");
  try {
    if (tagAt >= 0 && !process.argv[tagAt + 1]) throw new Error("--tag requires letters, numbers, or hyphens");
    await run({ dry: process.argv.includes("--dry"), tag: tagAt >= 0 ? process.argv[tagAt + 1] : null });
  } catch (error) {
    console.error(`critic: ${error.message}`);
    process.exitCode = 1;
  }
}
