// agent-brief.test.mjs — PRD v12 fixtures: the census grammar, absence shape,
// determinism, chapter grounding, and the size budget.
// Run: node tools/dive-analytics/audit/agent-brief.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AB from "../agent-brief.mjs";
import { validateChapter, groundChapters, MIN_GAP_SEC } from "../chapters.mjs";
import { parseTranscript } from "../transcripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

// The agent instructions are a separate destination, never dashboard content.
{
  const dashboard = readFileSync(join(ROOT, "index.html"), "utf8");
  const agentsPage = readFileSync(join(ROOT, "agents.html"), "utf8");
  assert.match(dashboard, /<a class="agentslink" href="agents\.html">Agents<\/a>/);
  assert.doesNotMatch(dashboard, /#agents|id="agents"|function buildAgents|function syncAgentsView|AGENT_PROMPT/);
  assert.match(agentsPage, /Read https:\/\/dive-radio-analytics\.vercel\.app\/agent\.md in full/);
  assert.match(agentsPage, /<a class="back" href="\.\/">Dashboard<\/a>/);
}

// 1. the census grammar: arrays as [], slug maps as {slug}, dest maps as {dest}, depth ≤ 4
{
  const paths = AB.censusPaths({
    a: 1,
    list: [{ x: 1, y: { z: 2 } }, { x: 2, w: 3 }],
    bySlug: { "2026-07-17-a": { v: 1 }, "2026-07-23-b": { v: 2 } },
    byDest: { "yt:one": { views: 1 }, "x:two": { views: 2 } },
    deep: { l1: { l2: { l3: { l4: { l5: 1 } } } } },
  });
  assert.ok(paths.includes("list[]") && paths.includes("list[].x") && paths.includes("list[].w") && paths.includes("list[].y.z"));
  assert.ok(paths.includes("bySlug.{slug}") && paths.includes("bySlug.{slug}.v"));
  assert.ok(paths.includes("byDest.{dest}") && paths.includes("byDest.{dest}.views"));
  assert.ok(paths.includes("deep.l1.l2.l3") && !paths.includes("deep.l1.l2.l3.l4.l5"), "depth is capped at four");
}

// 2. on the real data every path is covered or left out — and the brief is deterministic
{
  const data = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
  const missing = AB.uncovered(data);
  assert.deepEqual(missing, [], `uncovered paths: ${missing.join(", ")}`);
  const a = AB.buildBrief(data), b = AB.buildBrief(JSON.parse(JSON.stringify(data)));
  assert.equal(a.md, b.md); assert.equal(a.json, b.json); assert.equal(a.llms, b.llms);
  assert.ok(!/\btoLocale|Date\.now\(/.test(readFileSync(join(HERE, "..", "agent-brief.mjs"), "utf8")), "the writer uses neither the clock nor a locale");
  for (const hd of AB.HEADINGS) assert.ok(a.md.includes(`\n${hd}\n`), `heading ${hd}`);
  assert.ok(Buffer.byteLength(a.md, "utf8") <= AB.BUDGET.failBytes, "within the size budget");
  // absences are {value: null, reason}, never empty stand-ins
  for (const e of a.digest.episodes) for (const k of ["firstWeek", "launch", "pace", "watching", "live", "feedback", "chapters", "health"]) { const v = e[k]; if (v && "value" in v && v.value === null) assert.ok(v.reason, `${e.slug} ${k} reason`); }
}

// 3. chapter grounding: timestamp must exist, quote verbatim within the window, spacing enforced
{
  const raw = ["Dive Radio E0 — fixture", "Aired: 2026-01-01 · YouTube: https://youtube.com/watch?v=abc", "Source: Restream speaker transcript", "",
    "00:00:10 [Speaker 1]", "welcome to the show everybody we are live",
    "00:04:20 [Speaker 2]", "let's talk about the news of the week",
    "00:09:00 [Speaker 1]", "our guest walks through the portfolio now",
    "00:15:00 [Speaker 2]", "closing thoughts and the winner reveal"].join("\n");
  const t = parseTranscript(raw);
  const good = { start: "00:04:20", title: "News of the week", gist: "The hosts run through the week's news.", quote: "the news of the week" };
  assert.deepEqual(validateChapter(good, t), good);
  assert.throws(() => validateChapter({ ...good, start: "00:04:21" }, t), /not a timestamp/);
  assert.throws(() => validateChapter({ ...good, quote: "words never spoken here" }, t), /not found/);
  assert.throws(() => validateChapter({ ...good, title: "News at 9" }, t), /digit/);
  assert.throws(() => validateChapter({ start: "00:04:20", title: "x", gist: "y", quote: "the news" }, t, { start: "00:04:00" }), new RegExp(`under ${MIN_GAP_SEC / 60} minutes`));
  const g = groundChapters([
    { start: "00:00:10", title: "Welcome", gist: "The hosts open the show.", quote: "welcome to the show" },
    { start: "00:04:20", title: "News", gist: "News of the week.", quote: "news of the week" },
    { start: "00:04:30", title: "Too close", gist: "x", quote: "news" },
    { start: "00:09:00", title: "Guest portfolio", gist: "A guest shows work.", quote: "walks through the portfolio" },
  ], t);
  assert.equal(g.chapters.length, 3); assert.equal(g.dropped.length, 1); assert.equal(g.status, "incomplete");
}

// 4. Missing YouTube stays missing in the episode and whole-show digest.
// Unknown tracking start remains distinct from an on-time start, and an old
// positive reading carries a plain marker instead of looking current.
{
  const episode = (ep, partialHistory, latest) => ({
    ep, slug: `fixture-${ep}`, title: `Dive Radio E${ep}`, premiere: `2026-09-0${ep}`,
    ageDays: 2, partialHistory, latest, metrics: { week1Velocity: null, week1Note: "YouTube views are not available yet." },
  });
  const current = episode(1, false, {
    ts: "2026-09-03T12:00:00.000Z", ytTotal: 100, youtubeAsOf: "2026-09-03T12:00:00.000Z", youtubeStale: false,
    xPlays: 20, xImpressions: 200, totalViews: 120, byDest: { "yt:one": { views: 100 }, "x:one": { views: 200, plays: 20 } },
    xPlaysInfo: { partial: false, stale: false }, totalViewsInfo: { incomplete: false, reason: null },
  });
  const missing = episode(2, null, {
    ts: "2026-09-04T12:00:00.000Z", ytTotal: null, youtubeAsOf: null, youtubeStale: false,
    xPlays: 10, xImpressions: 300, totalViews: 10, byDest: { "yt:one": { views: 0 }, "x:one": { views: 300, plays: 10 } },
    xPlaysInfo: { partial: false, stale: false }, totalViewsInfo: { incomplete: true, reason: "YouTube views are not available." },
  });
  const digest = AB.buildDigest({ generatedAt: "2026-09-04T12:00:00.000Z", episodes: [current, missing], dests: [], baselines: {} });
  assert.equal(digest.episodes[0].trackedLate, false, "an on-time start stays false");
  assert.equal(digest.episodes[0].views.total, current.latest.totalViews, "complete agent totals stay equal to canonical data");
  assert.equal(digest.episodes[1].trackedLate, null, "an unknown tracking start does not become false");
  assert.equal(digest.episodes[1].views.youtube, null);
  assert.equal(digest.episodes[1].views.total, null, "an X-only subtotal is not presented as the whole episode total");
  assert.equal(digest.episodes[1].views.youtubeMarker, "missing");
  assert.match(digest.episodes[1].views.reason, /YouTube views are not available/);
  assert.equal(digest.show.totals.youtube, null, "one missing episode withholds the whole-show YouTube total");
  assert.equal(digest.show.totals.views, null, "one missing episode withholds the whole-show view total");
  assert.deepEqual(digest.show.totals.youtubeMarkers, ["E2 missing"]);
  assert.match(AB.renderMarkdown(digest), /E2 missing/);

  const old = episode(2, false, {
    ...missing.latest, ytTotal: 40, youtubeAsOf: "2026-09-03T12:00:00.000Z", youtubeStale: true, totalViews: 50,
    byDest: { ...missing.latest.byDest, "yt:one": { views: 40 } },
    totalViewsInfo: { incomplete: true, reason: "YouTube views are from an older reading." },
  });
  const oldDigest = AB.buildDigest({ generatedAt: "2026-09-04T12:00:00.000Z", episodes: [current, old], dests: [], baselines: {} });
  assert.equal(oldDigest.episodes[1].views.youtubeMarker, "old");
  assert.equal(oldDigest.episodes[1].views.youtubeStale, true);
  assert.equal(oldDigest.episodes[1].views.youtubeAsOf, "2026-09-03T12:00:00.000Z");
  assert.deepEqual(oldDigest.show.totals.youtubeMarkers, ["E2 old (2026-09-03)"]);
  assert.match(AB.renderMarkdown(oldDigest), /old reading from 2026-09-03/);
}
console.log("agent-brief.test: census grammar, coverage on the real data, determinism, absence shape, chapter grounding pass");
