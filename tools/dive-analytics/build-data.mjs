#!/usr/bin/env node
// build-data.mjs — export dive-analytics data.json/data.js from data/restream/postlive/*.json
// Deterministic: no model calls, no network. Same math feeds the dashboard and the
// Monday Slack report (postlive-track.mjs report --trends imports computeAll/trendsText).
// PRD: Dive Media Group/Dive Radio/prd-episode-analytics-chart.md

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
// negative-signal veto for featured quotes (comments critic 2026-08-22 C1):
// same deterministic wordlist the sentiment labels come from
import { hasNegativeSignal } from "../../scripts/restream/comments-sentiment.mjs";
import { CHECK_LABELS as HEALTH_CHECK_LABELS, projectHealth } from "./health.mjs";
import { watchMoments } from "./watch-moments.mjs";
import { momentKey } from "./moment-summaries.mjs";
// PRD v9 W22a: the one definition of "typical" — projected as data.baselines
// so the page, the scorers, and the critic all read the same windows, flags,
// and constants. No consumer is switched in W22a; this only adds the projection.
import { buildBrief } from "./agent-brief.mjs";
import { atomicWriteText, acquireSourceLock } from "./source-io.mjs";
import { currentAnalyticsCohort, assertSourceStoreIntegrity } from "./source-integrity.mjs";
import { completeYoutubeWatchCohort, summedYoutubeMetric, weightedYoutubeMetric } from "./youtube-readiness.mjs";
import {
  computeBaselines, anomalyFlags, paceFor, ytSnapshotAt,
  firstYtSnapshot, latestCurrentYtSnapshot, ytCurrentAge, ytSnapshotsOf, subsPer1kOf, LAUNCH_AGE,
  ytViewsOf, ytEngagementOf, engagementPer1kOf, discoveryShareOf, liveDepthOf, KNOWN_BREAKS, NOTES,
} from "./baselines.mjs";
import { collectFacts, validateItem, allowedNumbers } from "./recommendations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY_DIR = join(ROOT, "data", "restream", "postlive");
const EVENTS_DIR = join(ROOT, "data", "restream", "events");
const COMMENTS_DIR = join(ROOT, "data", "restream", "comments");
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
const HEALTH_PATH = join(ROOT, "data", "restream", "health-history.json");
const BEEHIIV_PATH = join(ROOT, "data", "restream", "beehiiv-promotions.json");

export const DESTS = [
  { key: "yt:joindiveclub", label: "YT Dive Club", platform: "yt" },
  { key: "yt:designertom", label: "YT DesignerTom", platform: "yt" },
  { key: "x:ridd_design", label: "X @ridd_design", platform: "x" },
  { key: "x:designertom", label: "X @designertom", platform: "x" },
];

const YT_KEYS = ["yt:joindiveclub", "yt:designertom"];
const X_KEYS = ["x:ridd_design", "x:designertom"];
const DAY = 86400000;
const WEEK = 7 * DAY;
const PHX_OFFSET = 7 * 3600000; // America/Phoenix is UTC-7 year-round (no DST)
const FLATLINE_RATIO = 0.03;
const PARTIAL_THRESHOLD_DAYS = 5; // first snapshot > 5d after premiere => partial history

// --- time helpers (Monday-noon-Phoenix week boundaries, matching the cron anchor) ---

function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET; // noon Phoenix on premiere date
}

export function mondayNoonAtOrBefore(ms) {
  const shifted = new Date(ms - PHX_OFFSET); // read UTC fields as Phoenix wall clock
  const noon =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 12) +
    PHX_OFFSET;
  const dow = shifted.getUTCDay(); // 0 Sun .. 6 Sat, in Phoenix terms
  let candidate = noon - ((dow + 6) % 7) * DAY;
  if (candidate > ms) candidate -= WEEK;
  return candidate;
}

function fmtDate(ms) {
  return new Date(ms - PHX_OFFSET).toISOString().slice(0, 10);
}

// --- snapshot access ---

export function compactSnap(s) {
  const byDest = {};
  for (const [k, m] of Object.entries(s.metrics || {})) {
    const d = m.detail || {};
    const comments = Number.isFinite(d.comments)
      ? d.comments
      : Number.isFinite(d.replies)
        ? d.replies
        : null;
    byDest[k] = {
      views: Number.isFinite(m.views) ? m.views : null,
      likes: Number.isFinite(d.likes) ? d.likes : null,
      comments,
    };
    // X plays are accepted only with broadcast provenance. Historical
    // snapshots predate playsSource but carry peakConcurrent exclusively from
    // the broadcast extractor; native tweet-media detail is never a fallback.
    const broadcastProvenance = m.playsSource === "x-broadcast" || Object.hasOwn(m, "peakConcurrent");
    const plays = broadcastProvenance ? m.plays : null;
    if (plays != null) {
      byDest[k].plays = plays;
      byDest[k].playsSource = "x-broadcast";
    }
    if (m.peakConcurrent != null) byDest[k].peakConcurrent = m.peakConcurrent;
  }
  return { ts: s.ts, byDest, ...(s.reading ? { reading: s.reading } : {}) };
}

function total(byDest, keys) {
  const use = keys || DESTS.map((d) => d.key);
  return totalOrNull(byDest, use);
}

function totalOrNull(byDest, keys) {
  const values = keys.map((key) => byDest[key]?.views);
  return values.length && values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function lastAtOrBefore(snaps, cutoffMs) {
  let best = null;
  for (const s of snaps) {
    const t = Date.parse(s.ts);
    if (t <= cutoffMs && (!best || t > Date.parse(best.ts))) best = s;
  }
  return best;
}

// X broadcast-plays summary for an episode (F-2/F-4): sums per-account plays,
// falls back to a target's persisted high-water mark when the latest snapshot
// lacks plays (stale), and reports coverage so a partial sum is never shown
// as a whole. Targets latched "none"/promo don't count toward coverage.
// Absence is never rendered as 0.
export function xPlaysSummary(show, byDest) {
  const targets = (show.targets || []).filter(
    (t) => t.kind === "x" && t.role !== "promo" && t.playsStatus !== "none" && t.broadcastId
  );
  const keys = [...new Set(targets.map((t) => `x:${t.account}`))];
  const out = { value: null, have: 0, total: keys.length, partial: false, stale: false, asOf: null };
  for (const k of keys) {
    const p = byDest[k]?.playsSource === "x-broadcast" ? byDest[k].plays : null;
    if (p != null) {
      out.value = (out.value ?? 0) + p;
      out.have += 1;
      continue;
    }
    const hwTargets = targets.filter((t) => `x:${t.account}` === k && t.playsHighWater?.value != null);
    if (hwTargets.length) {
      out.value = (out.value ?? 0) + hwTargets.reduce((a, t) => a + t.playsHighWater.value, 0);
      out.have += 1;
      out.stale = true;
      const asOf = hwTargets.map((t) => t.playsHighWater.asOf).sort()[0];
      if (asOf && (!out.asOf || asOf < out.asOf)) out.asOf = asOf;
    }
  }
  out.partial = out.have < out.total;
  return out;
}

function num(n) {
  return Math.round(n).toLocaleString("en-US");
}

export function partialHistoryOf(snapshots, premiere) {
  const first = firstYtSnapshot({ snapshots, premiere });
  return first ? Date.parse(first.ts) - premiereMs(premiere) > PARTIAL_THRESHOLD_DAYS * DAY : null;
}

// Per-episode latest block. totalViewsInfo mirrors xPlaysInfo so partial/
// stale coverage markers survive from build to render (audit F-2 guard).
export function buildLatest(show, latest, selectedYt) {
  const latestYt = selectedYt !== undefined
    ? selectedYt
    : latestCurrentYtSnapshot({ snapshots: latest ? [latest] : [], premiere: show?.date || show?.premiere });
  const playsInfo = xPlaysSummary(show, latest.byDest);
  const ytTotal = latestYt ? ytViewsOf(latestYt) : null;
  const youtubeAsOf = ytTotal != null ? latestYt.ts : null;
  const youtubeStale = ytTotal != null && latestYt.ts !== latest.ts;
  const byDest = { ...latest.byDest };
  if (ytTotal != null) {
    for (const key of YT_KEYS) byDest[key] = latestYt.byDest[key] ?? null;
  } else {
    for (const key of YT_KEYS) {
      if (byDest[key]) byDest[key] = { ...byDest[key], views: null };
    }
  }
  const totalViews = ytTotal != null || playsInfo.value != null
    ? (ytTotal ?? 0) + (playsInfo.value ?? 0)
    : null;
  const xExpected = playsInfo.total > 0;
  const xMissing = xExpected && playsInfo.value == null;
  const incomplete = ytTotal == null || youtubeStale || xMissing || playsInfo.partial || playsInfo.stale;
  const reasons = [];
  if (ytTotal == null) reasons.push("YouTube views are not available.");
  else if (youtubeStale) reasons.push("YouTube views are from an older reading.");
  if (xMissing) reasons.push("X plays are not available.");
  else if (playsInfo.partial) reasons.push("Some X plays are not available.");
  else if (playsInfo.stale) reasons.push("Some X plays are from an older reading.");
  const reason = reasons.length ? reasons.join(" ") : null;
  return {
    ts: latest.ts,
    byDest,
    ytTotal,
    youtubeAsOf,
    youtubeStale,
    xImpressions: totalOrNull(latest.byDest, X_KEYS),
    xPlays: playsInfo.value,
    xPlaysInfo: playsInfo,
    totalViews,
    totalViewsInfo: {
      includesYoutube: ytTotal != null,
      includesPlays: playsInfo.value != null,
      youtubeMissing: ytTotal == null,
      youtubeAsOf,
      youtubeStale,
      missing: totalViews == null,
      incomplete,
      reason,
      partial: playsInfo.partial,
      stale: playsInfo.stale,
      asOf: playsInfo.asOf,
      have: playsInfo.have,
      total: playsInfo.total,
    },
  };
}

// --- core computation ---

export function computeAll({ now = Date.now() } = {}) {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const episodes = [];

  for (const show of registry.shows) {
    if (show.date > fmtDate(now)) continue;
    const histPath = join(HISTORY_DIR, `${show.slug}.json`);
    if (!existsSync(histPath)) continue;
    const hist = JSON.parse(readFileSync(histPath, "utf8"));
    if (!hist.snapshots?.length) continue;

    const snaps = hist.snapshots.map(compactSnap).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const prem = premiereMs(show.date);
    const ytSnaps = ytSnapshotsOf({ snapshots: snaps, premiere: show.date });
    const lastTs = Date.parse(snaps[snaps.length - 1].ts);
    const isDiveRadio = /dive.?radio/i.test(show.title) || /dive-radio/.test(show.slug);
    if (!isDiveRadio) continue; // Dive Radio only (owner directive 2026-08-21)
    const partialHistory = partialHistoryOf(snaps, show.date);

    // weekly resample: Monday-noon-Phoenix boundaries; last snapshot at-or-before each;
    // nothing rendered before the first snapshot (no fabricated zeros).
    const weekly = [];
    if (ytSnaps.length) {
      const firstYtTs = Date.parse(ytSnaps[0].ts);
      let b = mondayNoonAtOrBefore(firstYtTs) + WEEK; // first boundary at/after first real YouTube reading
      if (b - WEEK >= firstYtTs) b -= WEEK;
      for (; b <= now; b += WEEK) {
        const snap = lastAtOrBefore(ytSnaps, b);
        if (!snap) continue;
        weekly.push({
          week: Math.max(0, Math.floor((b - prem) / WEEK)),
          boundary: new Date(b).toISOString(),
          byDest: snap.byDest,
        });
      }
    }

    const latest = snaps[snaps.length - 1];

    // metrics
    const ageDays = (lastTs - prem) / DAY;
    // All pace/velocity/decay metrics use YT views ONLY — real video plays.
    // X reports post impressions (reach), a different unit; never mixed in.
    let week1Velocity = null;
    let week1Note = null;
    if (partialHistory == null) {
      week1Note = latestCurrentYtSnapshot({ snapshots: snaps, premiere: show.date })
        ? NOTES.noFullDayReading
        : NOTES.noYtReading;
    } else if (partialHistory) {
      week1Note = "excluded: partial history";
    } else if (ageDays < 7) {
      week1Note = "pending: episode under 7 days old";
    } else {
      // ONE reading rule for "first-week views" (PRD v10 rule 16): the day-7
      // reading via the shared reading rule, the last snapshot inside the
      // week only when no reading sits within tolerance of day 7
      const s7 = ytSnapshotAt({ snapshots: ytSnaps, premiere: show.date }, LAUNCH_AGE) || lastAtOrBefore(ytSnaps, prem + 7 * DAY);
      week1Velocity = s7 ? ytViewsOf(s7) : null;
      if (week1Velocity == null) week1Note = "no snapshot inside first week";
    }

    let flatlineWeek = null;
    if (partialHistory === false) {
      for (let i = 1; i < weekly.length; i++) {
        const t0 = total(weekly[i - 1].byDest, YT_KEYS);
        const t1 = total(weekly[i].byDest, YT_KEYS);
        if (Number.isFinite(t0) && t1 > 0 && (t1 - t0) / t1 < FLATLINE_RATIO) {
          flatlineWeek = weekly[i].week;
          break;
        }
      }
    }

    const latestYt = latestCurrentYtSnapshot({ snapshots: snaps, premiere: show.date });
    const ytViews = ytViewsOf(latestYt);
    const engagementPer1k = engagementPer1kOf(latestYt);

    // Announce receipts (PRD v2 W6): when each host's X post went out.
    // Timestamps come from the tweet id itself (snowflake epoch) — stored
    // fact, no network, no guessing.
    const announces = (show.targets || [])
      .filter((t) => t.kind === "x" && t.postId)
      .map((t) => ({
        account: t.account,
        role: t.role || "announce",
        ts: new Date(Number((BigInt(t.postId) >> 22n) + 1288834974657n)).toISOString(),
        url: t.url || null,
      }))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));

    // Where the episode lives on each destination (W18): YouTube watch pages
    // from the registered videoIds; on X the broadcast itself when its id was
    // resolved, else the announce post. A destination with neither stores no
    // link — absence stays silent on the page.
    const links = {};
    for (const t of show.targets || []) {
      if (t.kind === "youtube" && t.videoId) links[`yt:${t.account}`] = `https://youtube.com/watch?v=${t.videoId}`;
      if (t.kind === "x" && t.role !== "promo") {
        if (t.broadcastId) links[`x:${t.account}`] = `https://x.com/i/broadcasts/${t.broadcastId}`;
        else if (t.postId) links[`x:${t.account}`] = `https://x.com/${t.account}/status/${t.postId}`;
      }
    }

    const latestBlock = buildLatest(show, latest, latestYt);
    const capture = hist.capture;
    const staleCapture = capture?.state && capture.state !== "ready";
    const staleAge = now - Date.parse(latest.ts) > 26 * 3600000;
    if (staleCapture || staleAge) {
      const reason = capture?.reason || "The latest source reading is old.";
      latestBlock.youtubeStale = latestBlock.ytTotal != null;
      latestBlock.xPlaysInfo.stale = latestBlock.xPlays != null;
      latestBlock.xPlaysInfo.asOf = latest.ts;
      Object.assign(latestBlock.totalViewsInfo, { youtubeStale: latestBlock.youtubeStale, stale: latestBlock.xPlaysInfo.stale, asOf: latest.ts, incomplete: true, reason });
    }
    episodes.push({
      slug: show.slug,
      title: show.title,
      premiere: show.date,
      show: isDiveRadio ? "dive-radio" : "other",
      active: show.active !== false,
      partialHistory,
      historyReady: ytSnaps.length > 0,
      historyReason: ytSnaps.length ? null : NOTES.noFullDayReading,
      announces,
      snapshots: snaps,
      weekly,
      // Unit discipline (CARD-RULING-2026-08-21): totalViews = ytTotal +
      // xPlays — both count video playback events. xImpressions (reach) is
      // exposure, a different unit, and is NEVER part of any views total.
      latest: latestBlock,
      sourceStates: {
        youtube: { state: staleCapture ? capture.state : staleAge ? "stale" : latestBlock.ytTotal == null ? "pending" : "ready", checkedAt: capture?.checkedAt || latest.ts, reason: staleCapture ? capture.reason : staleAge ? "The latest source reading is old." : latestBlock.ytTotal == null ? "YouTube views are not available." : null },
        x: { state: staleCapture ? capture.state : staleAge ? "stale" : latestBlock.xPlays == null || latestBlock.xImpressions == null || latestBlock.xPlaysInfo.partial ? "pending" : "ready", checkedAt: capture?.checkedAt || latest.ts, reason: staleCapture ? capture.reason : staleAge ? "The latest source reading is old." : latestBlock.xPlays == null || latestBlock.xImpressions == null ? "X viewing data is not available." : null },
      },
      links: Object.keys(links).length ? links : undefined,
      // transcript flag: a per-episode file under transcripts/ (served statically);
      // link renders only when the file actually exists — absence ≠ broken link
      transcript: existsSync(join(TRANSCRIPTS_DIR, `${show.slug}.txt`)),
      ageDays: Math.round(ageDays * 10) / 10,
      metrics: { week1Velocity, week1Note, flatlineWeek, engagementPer1k, anomaly: null },
    });
  }

  episodes.sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  episodes.forEach((e, i) => { e.ep = i + 1; });
  const dive = episodes;

  // Exact newsletter promotion evidence is attached before comparisons are
  // built. The click counts stay separate from views; matched destination
  // ids only tell baselines which viewing unit received a known push.
  const promotionUpdatedAt = attachNewsletterPromotions(dive, now);

  // Promo-outlier flags (PRD v9 W22b): the one definition lives in
  // baselines.mjs — a unit more than double the SAME-AGE typical of the
  // nearby episodes (settled at day 21; provisional before that; the
  // window-limited lifetime test only while history is too thin for either).
  // A flagged episode is left out of host, announce, topic, and every typical.
  const flags = anomalyFlags(dive);
  for (const e of dive) e.metrics.anomaly = flags.get(e.slug)?.text ?? null;
  // PRD v10 F3: a first week whose YouTube views are promo-flagged is not a
  // clean first week — the same rule that keeps the episode out of every
  // typical keeps its week out of the first-week series (growth slope, trend
  // card, Slack line). The number stays visible on the episode itself.
  for (const e of dive) {
    if (e.metrics.week1Velocity != null && flags.get(e.slug)?.units?.ytViews?.flag === true) {
      e.metrics.week1Velocity = null;
      e.metrics.week1Note = "excluded: promo-driven outlier";
    }
  }

  attachLiveSessions(dive, registry);
  const commentSummary = attachComments(dive, now);
  attachEpisodeHealth(dive);
  attachWatch(dive, now);
  const transcriptStatePath = join(ROOT, "data", "restream", "transcript-state.json");
  const transcriptState = existsSync(transcriptStatePath) ? JSON.parse(readFileSync(transcriptStatePath, "utf8")) : null;
  const liveStatePath = join(ROOT, "data", "restream", "state.json");
  const liveState = existsSync(liveStatePath) ? JSON.parse(readFileSync(liveStatePath, "utf8")) : null;
  for (const e of dive) {
    e.sourceStates.watch = { state: e.watch ? "ready" : e.watchReport?.state === "ready" ? "stale" : e.watchReport?.state || "missing", checkedAt: e.watchReport?.checkedAt || e.watch?.updatedAt || null, reason: e.watch ? null : e.watchReport?.state === "ready" ? "The saved YouTube watch reading is old." : e.watchReport?.reason || "YouTube watch data is not available." };
    const liveEntry = Object.values(liveState?.events || {}).find((entry) => entry.reading?.episode === e.slug);
    e.sourceStates.live ||= { state: e.live ? "ready" : liveEntry?.reading?.state || "pending", checkedAt: liveEntry?.reading?.pulledAt || null, reason: e.live ? null : liveEntry?.reason || "Restream live data is not available." };
    const transcriptEntry = transcriptState?.entries?.[e.slug];
    e.sourceStates.transcript = { state: transcriptEntry?.reading?.state || (e.transcript ? "ready" : "pending"), checkedAt: transcriptEntry?.reading?.pulledAt || null, reason: transcriptEntry?.reason || (e.transcript ? null : "No transcript has been returned.") };
  }
  const baselines = computeBaselines(dive, { flags, history: readHistoryLines });

  // the saved show-health read is projected first: the recommendation fact
  // sheet (W35) cites its numbers, so it must exist before the insights build
  const health = (() => {
    if (!existsSync(HEALTH_PATH)) return null;
    const store = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
    return projectHealth(store, { now });
  })();

  // W15 recommendation engine: when the saved store exists, its model-written,
  // number-grounded items ARE "What matters" — the deterministic rule-based
  // insights remain only as the fallback when no store has ever been written.
  let insights;
  let recStore = null;
  let insightsStale = [];
  try { recStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "recommendations.json"), "utf8")); } catch { /* no store yet */ }
  if (Array.isArray(recStore?.items) && recStore.items.length) {
    // Currency (PRD v9 F32): an item stays on the page only while every
    // number it cites still exists in TODAY's fact sheet. A number that moved
    // or was retired (a re-derived score, a changed rate) makes the item stale:
    // dropped here with its reason, never shown against numbers it no longer
    // matches; the next model run rewrites the store.
    const sheet = collectFacts({ episodes: dive, baselines, health, generatedAt: new Date(now).toISOString() });
    const allowed = allowedNumbers(sheet.facts);
    const current = [];
    for (const r of recStore.items) {
      try { validateItem(r, sheet.facts, allowed); current.push(r); }
      catch (err) { insightsStale.push({ id: r.id, why: String(err.message).replace(/^[a-z0-9-]+: /, "") }); }
    }
    // W35: a ranked store ships in its own order — item one is this week's
    // biggest lever — and each item carries its rank and the check it serves
    insights = current.map((r, i) => ({ id: r.id, text: r.text, recommendation: r.recommendation, ...(r.caveat ? { caveat: r.caveat } : {}), category: r.category, ...(recStore.ranked ? { rank: i + 1 } : {}), ...(r.serves ? { serves: r.serves } : {}) }));
  }
  if (!insights || !insights.length) {
    insightsStale = insights ? insightsStale : [];
    insights = buildInsights(dive, { flags });
    insights.push(...liveInsights(dive));
    // Strategy-impact categories (owner directive 2026-08-22): each insight is
    // tagged by the DECISION it informs, not the data type it reads.
    for (const i of insights) i.category = categoryFor(i.id);
  } else {
    // Owner directive 2026-09-01 (W35 final): What matters is EXACTLY the
    // five ranked actions — nothing is appended to them. The newest episode's
    // same-age pace claim (once required here, 2026-08-31) lives on its card
    // and in the chart standings, locked to data.baselines.pace by the
    // validator; the model's five may cite it from the launch facts when it
    // matters. The deterministic list remains the fallback when no store exists.
  }
  const catRank = { content: 0, distribution: 1, promotion: 2, audience: 3, data: 4 };
  // ranked items keep their order (W35); anything unranked (the deterministic
  // fallback, or the validator-locked pace-rank claim) follows by category
  insights.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (catRank[a.category] ?? 9) - (catRank[b.category] ?? 9));
  const showTrend = {
    week1VelocityByEpisode: dive.map((e) => ({
      slug: e.slug,
      title: e.title,
      premiere: e.premiere,
      value: e.metrics.week1Velocity,
      note: e.metrics.week1Note,
    })),
    cumulativeAllEpisodes: cumulativeSeries(dive, now),
    // newest episode's same-age YouTube pace rank, exported as data so the
    // alerts diff (W4) never has to parse insight prose
    paceRank: (() => {
      const p = sameAgePace(dive, flags);
      return p && p.rank ? { slug: p.newest.slug, rank: p.rank, of: p.of } : null;
    })(),
  };

  // PRD v12: chapters (model-written, grounded; store keyed by slug) ride on
  // each episode for the panel and the brief; the announce-post URLs come
  // from the registry targets; known reporting breaks from baselines
  let chapterStore = null;
  try { chapterStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "chapters.json"), "utf8")); } catch { /* not written yet */ }
  for (const e of episodes) {
    const entry = chapterStore?.entries?.[e.slug] || null;
    e.chapters = entry
      ? { status: entry.status, clock: entry.clock, format: entry.format, writtenAt: entry.writtenAt, list: entry.chapters.map((c) => ({ start: c.start, seconds: c.seconds, title: c.title, gist: c.gist, quote: c.quote })) }
      : (e.transcript ? { status: "none", clock: null, format: null, writtenAt: null, list: [], reason: "chapters not written yet" } : { status: "none", clock: null, format: null, writtenAt: null, list: [], reason: "no transcript" });
  }
  baselines.knownBreaks = KNOWN_BREAKS.map((b) => ({ ...b }));
  return {
    generatedAt: new Date(now).toISOString(),
    chaptersUpdatedAt: chapterStore?.updatedAt || null,
    promotionUpdatedAt,
    dests: DESTS,
    episodes,
    insights,
    insightsStale,
    showTrend,
    commentSummary,
    health,
    baselines,
  };
}

// --- UX Tools newsletter promotion -----------------------------------------
// The dedicated pull script owns network access and the raw Beehiiv store.
// This projection is deliberately small: exact issue links and click facts
// for the dashboard, agent brief, Slack, and comparison exclusions.
function attachNewsletterPromotions(dive, now = Date.now()) {
  if (!existsSync(BEEHIIV_PATH)) {
    for (const e of dive) e.sourceStates.promotion = { state: "missing", checkedAt: null, reason: "Newsletter result is not available." };
    return null;
  }
  const store = JSON.parse(readFileSync(BEEHIIV_PATH, "utf8"));
  for (const episode of dive) {
    const entry = store?.episodes?.[episode.slug];
    const checkedAt = entry?.capture?.reading?.state === "ready" ? entry.capture.reading.pulledAt : store.lastSuccessfulAt || store.updatedAt || null;
    const stale = !Number.isFinite(Date.parse(checkedAt)) || now - Date.parse(checkedAt) > 26 * 3600000;
    const capture = store.capture?.state === "failed" ? store.capture : entry?.capture;
    episode.sourceStates.promotion = { state: capture?.state && capture.state !== "ready" ? capture.state : (entry?.status === "found" || entry?.status === "no-direct-link" ? stale ? "stale" : "ready" : "pending"), checkedAt: capture?.checkedAt || checkedAt, reason: capture?.reason || entry?.reason || (entry ? null : "Newsletter result is not available.") };
    if (episode.sourceStates.promotion.state !== "ready" || entry?.status !== "found" || !Array.isArray(entry.newsletters) || !entry.newsletters.length) continue;
    const matchedTargets = [...new Set(entry.newsletters.flatMap((newsletter) => newsletter.matchedTargets || []))].sort();
    const matchedUnits = [...new Set(matchedTargets.map((target) => target.startsWith("youtube:") ? "ytViews" : target.startsWith("x:") ? "xPlays" : null).filter(Boolean))].sort();
    episode.promotion = {
      status: "found",
      source: store.publication?.name || "UX Tools",
      updatedAt: checkedAt,
      emailClicks: entry.totals?.emailClicks ?? null,
      verifiedEmailClicks: entry.totals?.verifiedEmailClicks ?? null,
      clicksReason: entry.totals?.emailClicks == null || entry.totals?.verifiedEmailClicks == null
        ? (entry.newsletters.find((newsletter) => newsletter.clicksReason)?.clicksReason || "Click count not available.")
        : null,
      combinedUniqueReaders: null,
      uniqueReason: entry.totals?.uniqueReason || "Beehiiv does not dedupe one reader across different tracked links.",
      matchedTargets,
      matchedUnits,
      newsletters: entry.newsletters.map((newsletter) => ({
        postId: newsletter.postId,
        title: newsletter.title,
        publishedAt: newsletter.publishedAt,
        url: newsletter.webUrl,
        emailClicks: newsletter.emailClicks ?? null,
        verifiedEmailClicks: newsletter.verifiedEmailClicks ?? null,
      })),
      snapshots: (entry.snapshots || []).map((snapshot) => ({
        date: snapshot.date,
        pulledAt: snapshot.pulledAt,
        emailClicks: snapshot.emailClicks ?? null,
        verifiedEmailClicks: snapshot.verifiedEmailClicks ?? null,
      })),
    };
  }
  return store.lastSuccessfulAt || store.updatedAt || null;
}

// analytics history lines (PRD v9 W22a) for same-age comparisons of analytics measures
const ANALYTICS_HISTORY_DIR = join(ROOT, "data", "restream", "yt-analytics-history");
function readHistoryLines(slug) {
  const p = join(ANALYTICS_HISTORY_DIR, `${slug}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// --- episode health (W12): computed + frozen by ratings.mjs, attached from its store ---
// Definition-lock: every surface (card chip, panel, table, Slack line) reads
// THIS attached entry — nobody recomputes a score at render time. An episode
// younger than the 21-day read window carries only the date its read completes;
// no score exists anywhere before then.
const RATINGS_PATH = join(ROOT, "data", "restream", "episode-ratings.json");
const READ_DAYS = 21; // must match READ_DAYS in ratings.mjs
function attachEpisodeHealth(dive) {
  let store = null;
  try { store = JSON.parse(readFileSync(RATINGS_PATH, "utf8")); } catch { store = null; /* store absent → scores simply don't render (absence ≠ zero) */ }
  const bySlug = new Map(((store?.scores) || []).map((r) => [r.slug, r]));
  for (const e of dive) {
    const r = bySlug.get(e.slug);
    if (r) {
      e.health = r;
      continue;
    }
    const ytAge = ytCurrentAge(e);
    e.health = {
      pending: true,
      readCompleteOn: new Date(premiereMs(e.premiere) + READ_DAYS * DAY - PHX_OFFSET).toISOString().slice(0, 10),
      ...(!Number.isFinite(ytAge) ? { reason: e.latest?.ytTotal != null ? NOTES.noFullDayReading : NOTES.noYtReading } : {}),
    };
  }
}

// --- W13 watching: verified YouTube Analytics exported for the page ---
// Owner-level analytics (yt-analytics-pull.mjs) hold how LONG people watch,
// where they came from, and the drop-off curve. This attaches a per-episode
// view-weighted blend of the two channels so the page never recomputes:
//   avgPercent      share of the video watched on average (both channels,
//                   weighted by their views)
//   avgDurationSec  average time watched, same weighting; null if any channel omits it
//   minutesWatched  total minutes watched; null if any channel omits it
//   curve           still-watching share at each point of the video (the
//                   channels' aligned 100-point curves, view-weighted);
//                   null until YouTube produces the curves — absence ≠ zero
//   traffic         top view sources summed across channels + the remainder
// A missing channel withholds the episode blend; an episode without every
// registered report carries no watch block, but may carry the source's
// explicit watchReport state so the page can explain the wait without
// inventing data.
const WATCH_DIR = join(ROOT, "data", "restream", "yt-analytics");
function attachWatch(dive, now) {
  // W17 moment summaries: model-written context notes (owner directive
  // 2026-08-23 — the pins summarize what was happening, never raw quotes).
  // Attached verbatim from the store; a moment without an entry carries no
  // summary and renders no context line (absence is silent, quotes are
  // never the fallback).
  let summaryStore = null;
  try { summaryStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "moment-summaries.json"), "utf8")); } catch { /* no store yet */ }
  for (const e of dive) {
    let j = null;
    try { j = JSON.parse(readFileSync(join(WATCH_DIR, `${e.slug}.json`), "utf8")); } catch { continue; }
    // Straight-through source state for honest pending UI. The page never
    // guesses from episode age: it names YouTube's wait only when the latest
    // pull stored that state, with the checked time and affected channels.
    if (["pending", "ready", "failed"].includes(j.watchReport?.state)) {
      e.watchReport = {
        state: j.watchReport.state,
        checkedAt: j.watchReport.checkedAt ?? null,
        missingChannels: Array.isArray(j.watchReport.missingChannels) ? [...j.watchReport.missingChannels] : [],
        reason: j.watchReport.reason ?? null,
      };
    }
    const expectedChannels = Object.entries(e.links || {})
      .filter(([key]) => key.startsWith("yt:"))
      .map(([key, url]) => ({ key, videoId: new URL(url).searchParams.get("v") }));
    const chans = currentAnalyticsCohort(e, j, now);
    if (!chans.length) continue;
    const currentChannels = Object.fromEntries(chans);
    const avgPercent = weightedYoutubeMetric(chans, "averageViewPercentage");
    const avgDurationSec = weightedYoutubeMetric(chans, "averageViewDuration");
    const minutesWatched = summedYoutubeMetric(chans, "estimatedMinutesWatched");

    const withCurve = chans.every(([, c]) => Array.isArray(c.retention) && c.retention.length) ? chans : [];
    let curve = null;
    if (withCurve.length) {
      const pointMaps = withCurve.map(([, c]) => new Map(c.retention
        .filter((p) => Number.isFinite(p.elapsedVideoTimeRatio) && Number.isFinite(p.audienceWatchRatio))
        .map((p) => [p.elapsedVideoTimeRatio, p.audienceWatchRatio])));
      const commonPoints = [...pointMaps[0].keys()].filter((at) => pointMaps.every((points) => points.has(at)));
      const totalViews = withCurve.reduce((sum, [, c]) => sum + c.totals.views, 0);
      curve = commonPoints.sort((a, b) => a - b).map((at) => ({
        at,
        watching: Math.round((withCurve.reduce((sum, [, c], index) => sum + pointMaps[index].get(at) * c.totals.views, 0) / totalViews) * 1000) / 1000,
      }));
      if (!curve.length) curve = null;
    }

    const bySource = new Map();
    let trafficTotal = 0;
    const trafficChannels = chans.every(([, c]) => Array.isArray(c.trafficSources) && c.trafficSources.length && c.trafficSources.every((row) => Number.isFinite(row.views) && row.views >= 0 && typeof row.insightTrafficSourceType === "string")) ? chans : [];
    for (const [, c] of trafficChannels) {
      for (const t of c.trafficSources || []) {
        if (!Number.isFinite(t.views) || t.views <= 0) continue;
        bySource.set(t.insightTrafficSourceType, (bySource.get(t.insightTrafficSourceType) || 0) + t.views);
        trafficTotal += t.views;
      }
    }
    let traffic = null;
    if (trafficTotal > 0) {
      const rows = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
      traffic = rows.slice(0, 5).map(([source, views]) => ({ source, views, share: Math.round((views / trafficTotal) * 1000) / 10 }));
      const rest = rows.slice(5).reduce((a, [, v]) => a + v, 0);
      if (rest > 0) traffic.push({ source: "OTHER_COMBINED", views: rest, share: Math.round((rest / trafficTotal) * 1000) / 10 });
    }

    // PRD v10: subscribers per thousand analytics views for the direction
    // lens (the same definition health.mjs and ratings.mjs read)
    e.subsPer1k = (() => { const v = subsPer1kOf(currentChannels); return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; })();
    // rule 23: the share of YouTube views that YouTube found for the viewer (search, suggested, Shorts, browse) — one definition, baselines.discoveryShareOf
    e.discoveryShare = discoveryShareOf(currentChannels);
    e.watch = {
      channels: chans.map(([k]) => k),
      // per-channel split (owner directive 2026-08-23): the blend never hides
      // which channel a number came from
      byChannel: chans.map(([k, c]) => ({
        key: k,
        views: c.totals.views,
        avgPercent: Number.isFinite(c.totals.averageViewPercentage) ? Math.round(c.totals.averageViewPercentage * 100) / 100 : null,
        avgDurationSec: Number.isFinite(c.totals.averageViewDuration) ? Math.round(c.totals.averageViewDuration) : null,
        subs: Number.isFinite(c.totals.subscribersGained) ? c.totals.subscribersGained : null,
        subsPer1k: Number.isFinite(c.totals.subscribersGained) && c.totals.views > 0 ? Math.round((c.totals.subscribersGained / c.totals.views) * 10000) / 10 : null,
      })),
      avgPercent: avgPercent != null ? Math.round(avgPercent * 100) / 100 : null,
      avgDurationSec: avgDurationSec != null ? Math.round(avgDurationSec) : null,
      minutesWatched: minutesWatched != null ? Math.round(minutesWatched) : null,
      curve,
      traffic,
      updatedAt: j.updatedAt ?? null,
    };

    // W16 (v6): transcript × retention moments — deterministic shape facts and
    // annotated exit/jump-in moments, only when BOTH a blended curve and the
    // episode's transcript exist. An episode missing either carries neither
    // block, and nothing anywhere says so (absence is silent).
    const transcriptPath = join(TRANSCRIPTS_DIR, `${e.slug}.txt`);
    if (curve && existsSync(transcriptPath)) {
      const wm = watchMoments({
        curve,
        channelTotals: chans.map(([, c]) => c.totals),
        transcriptText: readFileSync(transcriptPath, "utf8"),
      });
      if (wm?.shape) e.watch.shape = wm.shape;
      if (wm?.moments?.length) {
        e.watch.moments = wm.moments.map((m) => {
          const entry = summaryStore?.entries?.[momentKey(e.slug, m)];
          return entry ? { ...m, summary: entry.summary } : m;
        });
      }
    }
  }
}

// --- audience comments (captured by comments-pull.mjs, labeled by comments-classify.mjs) ---
// The model store is the only surfacing source of truth. This exporter stays
// deterministic. The old wordlist remains only as the featured-quote negative
// veto required by the W8 cross-check contract.
const PRAISE = /love|great|awesome|amazing|best|fantastic|incredible|fire|banger|peak|favorite|favourite|brilliant|gold|smiled|laughed|chuckl|funny|haha|enjoyed|insightful|learned|excellent|goated|so good|well done|nailed|\ud83d\udd25|\ud83d\ude02|\u2764|\ud83d\udcaf|\ud83d\udc4f/i;
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
const SURFACE_SENTIMENTS = new Set(["positive", "negative", "mixed"]);

function commenterKey(c) {
  if (c.authorId) return `${c.source}:id:${c.authorId}`;
  const name = String(c.author || "viewer").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ");
  return `${c.source}:name:${name}`;
}

function peopleCount(rows) {
  return new Set(rows.map(commenterKey)).size;
}

function topThemes(rows) {
  const peopleByTheme = new Map();
  for (const { comment, label } of rows) {
    const person = commenterKey(comment);
    for (const theme of label.themes || []) {
      if (!peopleByTheme.has(theme)) peopleByTheme.set(theme, new Set());
      peopleByTheme.get(theme).add(person);
    }
  }
  // A theme claim needs at least three clean people behind it.
  return [...peopleByTheme.entries()]
    .map(([theme, people]) => ({ theme, count: people.size }))
    .filter((x) => x.count >= 3)
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme))
    .slice(0, 3);
}

function summarizeComments(rows, { totalViews = null, rateComplete = false } = {}) {
  const feedback = rows.filter(({ label }) => label?.state === "ready" && label.relevance === "feedback");
  const enjoy = feedback.filter(({ label }) => label.sentiment === "positive" || label.sentiment === "mixed");
  const complaints = feedback.filter(({ label }) => label.sentiment === "negative" || label.sentiment === "mixed");
  const uniqueCommenters = peopleCount(feedback.map(({ comment }) => comment));
  return {
    captured: rows.length,
    feedbackCount: feedback.length,
    uniqueCommenters,
    enjoyCount: peopleCount(enjoy.map(({ comment }) => comment)),
    complaintCount: peopleCount(complaints.map(({ comment }) => comment)),
    commentersPer1k: rateComplete && totalViews > 0
      ? Math.round((uniqueCommenters / totalViews) * 10000) / 10
      : null,
    commentersPer1kNote: rateComplete
      ? null
      : "The commenting rate isn’t available — some replies or watch counts are missing.",
    enjoyThemes: topThemes(enjoy),
    complaintThemes: topThemes(complaints),
  };
}

function attachComments(dive, now = Date.now()) {
  let labels = {};
  if (existsSync(CLASSIFIED_PATH)) labels = JSON.parse(readFileSync(CLASSIFIED_PATH, "utf8")).classified || {};
  const showRows = [];
  let showViews = 0;
  let showRateComplete = true;
  for (const e of dive) {
    const path = join(COMMENTS_DIR, `${e.slug}.json`);
    if (!existsSync(path)) {
      e.sourceStates.comments = { state: "missing", checkedAt: null, reason: "Comments have not been returned." };
      showRateComplete = false;
      continue;
    }
    const store = JSON.parse(readFileSync(path, "utf8"));
    const commentState = store.capture?.state && store.capture.state !== "ready" ? store.capture.state : now - Date.parse(store.updatedAt) > 26 * 3600000 ? "stale" : "ready";
    e.sourceStates.comments = { state: commentState, checkedAt: store.capture?.checkedAt || store.updatedAt || null, reason: store.capture?.reason || null };
    const all = store.comments || [];
    const labeled = all.map((comment) => ({ comment, label: labels[comment.id] || null }));
    showRows.push(...labeled);
    showViews += e.latest.totalViews || 0;
    const tvi = e.latest.totalViewsInfo || {};
    const rateComplete = store.xCoverage === "covered" && commentState === "ready" && tvi.includesYoutube === true && tvi.includesPlays === true && !tvi.incomplete && !tvi.partial && !tvi.stale;
    if (!rateComplete) showRateComplete = false;
    const summary = summarizeComments(labeled, { totalViews: e.latest.totalViews, rateComplete });
    if (commentState !== "ready") summary.commentersPer1kNote = `Comments are from ${store.updatedAt?.slice(0, 10) || "an earlier reading"}; the latest source check is ${commentState}. The commenting rate is not available.`;
    const featured = labeled
      .filter(({ label }) => label?.state === "ready" && label.relevance === "feedback" && label.sentiment === "positive")
      .map(({ comment }) => comment)
      .filter((c) => c.text && c.text.length >= 8 && c.text.length <= 300 && !hasNegativeSignal(c.text))
      .map((c) => ({ ...c, score: (c.likes || 0) * 2 + (PRAISE.test(c.text) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || (a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, 3)
      .map((c) => ({ source: c.source, author: c.author, text: c.text.slice(0, 200), likes: Number.isFinite(c.likes) ? c.likes : null }));
    const list = labeled
      .filter(({ label }) => label?.state === "ready" && label.relevance === "feedback" && SURFACE_SENTIMENTS.has(label.sentiment))
      .map(({ comment: c, label }) => ({
        id: c.id,
        author: c.author,
        text: c.text,
        source: c.source,
        likes: Number.isFinite(c.likes) ? c.likes : null,
        at: c.publishedAt,
        sentiment: label.sentiment,
        themes: label.themes,
      }))
      .sort((a, b) => b.likes - a.likes || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.text < b.text ? -1 : 1));
    // xCoverage: "covered" = the X reply window was actually searched during
    // this episode's first week; "missed" = the episode aired before comment
    // tracking existed (X search only reaches back 7 days). Absence ≠ zero:
    // the UI must say "couldn't see it", never imply "no X replies".
    e.comments = { ...summary, featured, list, xCoverage: store.xCoverage ?? null };
  }
  return summarizeComments(showRows, { totalViews: showViews, rateComplete: showRateComplete });
}

// --- Restream live-session data (archived by restream-analytics-ingest) ---
// A Restream event is joined to an episode only by a destination id already
// stored in the registry. Time proximity is deliberately not a key: two shows
// close together must never be allowed to borrow each other's live record.
function liveSourceMaps(registry) {
  const youtube = new Map();
  const xBroadcast = new Map();
  const add = (map, id, row, kind) => {
    if (!id) return;
    const prior = map.get(id);
    if (prior && prior.slug !== row.slug) {
      throw new Error(`live source ${kind}:${id} belongs to both ${prior.slug} and ${row.slug}`);
    }
    map.set(id, row);
  };
  for (const show of registry.shows || []) {
    for (const target of show.targets || []) {
      const row = { slug: show.slug, account: target.account };
      if (target.kind === "youtube") add(youtube, target.videoId, row, "youtube");
      if (target.kind === "x") add(xBroadcast, target.broadcastId, row, "x-broadcast");
    }
  }
  return { youtube, xBroadcast };
}

function destinationSource(url, maps) {
  const value = typeof url === "string" ? url : "";
  const yt = value.match(/(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (yt) return { kind: "youtube", id: yt[1], row: maps.youtube.get(yt[1]) || null };
  const xb = value.match(/(?:x|twitter)\.com\/i\/broadcasts\/([A-Za-z0-9_-]+)/);
  if (xb) return { kind: "x", id: xb[1], row: maps.xBroadcast.get(xb[1]) || null };
  return null;
}

export function liveEventSlug(ev, registry) {
  const maps = liveSourceMaps(registry);
  const slugs = new Set();
  for (const dest of ev?.event?.destinations || []) {
    const source = destinationSource(dest.externalUrl, maps);
    if (source?.row?.slug) slugs.add(source.row.slug);
  }
  if (slugs.size > 1) {
    throw new Error(`Restream event ${ev?.event?.id || "unknown"} points at more than one registered episode`);
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}

function sourceNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function eventMs(value) {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function liveChannelLabel(dest, maps) {
  const source = destinationSource(dest?.externalUrl, maps);
  if (source?.row?.account) {
    const key = source.kind === "youtube" ? `yt:${source.row.account}` : `x:${source.row.account}`;
    return DESTS.find((d) => d.key === key)?.label || key;
  }
  const url = typeof dest?.externalUrl === "string" ? dest.externalUrl : "";
  if (/linkedin\.com/.test(url)) return "LinkedIn";
  try { return new URL(url).hostname.replace(/^www\./, "") || null; }
  catch { return null; }
}

// Pure projection used by both the build and validator fixtures. Missing
// provider fields stay null; an explicit provider zero stays zero.
export function projectLiveSession(ev, registry) {
  const maps = liveSourceMaps(registry);
  const started = eventMs(ev?.event?.startedAt);
  const finished = eventMs(ev?.event?.finishedAt);
  const vt = ev?.viewers?.total || {};
  const mt = ev?.messages?.total || {};
  const hasChatSeries = Array.isArray(mt.messagesPerMinute);
  const chatByMin = new Map();
  if (hasChatSeries && Number.isFinite(started)) {
    for (const point of mt.messagesPerMinute) {
      const at = eventMs(point?.timestamp);
      const messages = sourceNumber(point?.messages);
      if (Number.isFinite(at) && messages != null) chatByMin.set(Math.round((at - started) / 60000), messages);
    }
  }

  const chanLabel = {};
  for (const dest of ev?.event?.destinations || []) {
    chanLabel[String(dest.channelId)] = liveChannelLabel(dest, maps) || `channel ${dest.channelId}`;
  }
  const chanMinutes = {};
  if (Number.isFinite(started)) {
    for (const [cid, cv] of Object.entries(ev?.viewers?.byChannel || {})) {
      if (!Array.isArray(cv?.viewersPerMinute)) continue;
      const minuteMap = new Map();
      for (const point of cv.viewersPerMinute) {
        const at = eventMs(point?.timestamp);
        const viewers = sourceNumber(point?.viewers);
        if (Number.isFinite(at) && viewers != null) minuteMap.set(Math.round((at - started) / 60000), viewers);
      }
      chanMinutes[chanLabel[cid] || `channel ${cid}`] = minuteMap;
    }
  }

  const series = [];
  let chatCum = hasChatSeries ? 0 : null;
  if (Number.isFinite(started) && Array.isArray(vt.viewersPerMinute)) {
    for (const point of vt.viewersPerMinute) {
      const at = eventMs(point?.timestamp);
      if (!Number.isFinite(at)) continue;
      const m = Math.round((at - started) / 60000);
      if (m < 0) continue;
      const c = hasChatSeries && chatByMin.has(m) ? chatByMin.get(m) : null;
      // Once a minute is unsampled, the running total is unknown for the rest
      // of this timeline. The independent provider session total stays valid.
      chatCum = c != null && chatCum != null ? chatCum + c : null;
      const byChan = {};
      // A sparse per-destination series is not proof of zero viewers between
      // its saved points. Keep the destination present but mark an unsampled
      // minute as missing; an explicit saved zero still passes through as zero.
      for (const [label, minuteMap] of Object.entries(chanMinutes)) {
        byChan[label] = minuteMap.has(m) ? minuteMap.get(m) : null;
      }
      series.push({ m, v: sourceNumber(point?.viewers), c, ct: chatCum, byChan });
    }
  }

  const byChannel = [];
  const channelIds = new Set([
    ...Object.keys(ev?.viewers?.byChannel || {}),
    ...Object.keys(ev?.messages?.byChannel || {}),
  ]);
  for (const cid of channelIds) {
    const cv = ev?.viewers?.byChannel?.[cid] || {};
    const cm = ev?.messages?.byChannel?.[cid] || {};
    const row = {
      label: chanLabel[cid] || `channel ${cid}`,
      peak: sourceNumber(cv.max),
      avg: sourceNumber(cv.mean),
      views: sourceNumber(cv.viewsTotal),
      watchedMin: sourceNumber(cv.watchedTime),
      messages: sourceNumber(cm.messagesTotal),
      chatters: sourceNumber(cm.chattersTotal),
    };
    if (Object.values(row).some((value) => typeof value === "number")) byChannel.push(row);
  }
  byChannel.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.label.localeCompare(b.label));

  return {
    peak: sourceNumber(vt.max),
    avg: sourceNumber(vt.mean),
    liveViews: sourceNumber(vt.viewsTotal),
    watchedMin: sourceNumber(vt.watchedTime),
    chatMessages: sourceNumber(mt.messagesTotal),
    chatters: sourceNumber(mt.chattersTotal),
    durationMin: Number.isFinite(started) && Number.isFinite(finished) && finished > started
      ? Math.round((finished - started) / 60000)
      : null,
    series,
    byChannel,
  };
}

// Attaches per-episode `live` block: peak/avg concurrent viewers, people who
// watched live, watched minutes, chat totals, per-minute series, and channels.
function attachLiveSessions(dive, registry) {
  if (!existsSync(EVENTS_DIR)) return;
  const eventsBySlug = new Map();
  for (const f of readdirSync(EVENTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    let ev = null;
    try { ev = JSON.parse(readFileSync(join(EVENTS_DIR, f), "utf8")); }
    catch { continue; }
    if (!ev?.event?.startedAt || (!ev?.viewers && !ev?.messages)) continue;
    const slug = liveEventSlug(ev, registry);
    if (!slug) continue;
    if (eventsBySlug.has(slug)) throw new Error(`more than one Restream event matches ${slug}`);
    eventsBySlug.set(slug, ev);
  }
  for (const e of dive) {
    const ev = eventsBySlug.get(e.slug);
    if (!ev) continue;
    e.live = projectLiveSession(ev, registry);
    e.sourceStates.live = { state: "ready", checkedAt: ev.reading?.pulledAt || ev.fetchedAt || null, reason: null };
    // PRD v12: the two live-depth readings per episode, from the one definition
    const depth = liveDepthOf(e);
    e.live.minutesPerViewer = depth?.minutesPerViewer ?? null;
    e.live.holdRate = depth?.holdRate ?? null;
  }
}

export function liveChatText(launchChat, latestChat) {
  if (latestChat === launchChat) {
    return `Live chat is where it started: ${launchChat} messages on both the first and latest shows.`;
  }
  const direction = latestChat > launchChat ? "up from launch" : "down from launch";
  return `Live chat is ${direction}: ${launchChat} messages on the first show, ${latestChat} on the latest.`;
}

function liveInsights(dive) {
  const withLive = dive.filter((e) => e.live);
  if (withLive.length < 2) return [];
  const out = [];
  const newest = withLive[withLive.length - 1];
  const priors = withLive.slice(0, -1);
  const peaks = priors.map((e) => e.live.peak).sort((a, b) => a - b);
  const medPeak = peaks[Math.floor(peaks.length / 2)];
  const rank = withLive.filter((e) => e.live.peak > newest.live.peak).length + 1;
  const held = newest.live.peak >= medPeak;
  out.push({
    id: "live-peak",
    text: `${shortTitle(newest.title)} drew a live peak of ${newest.live.peak} concurrent viewers (avg ${newest.live.avg}) — #${rank} of ${withLive.length} episodes, against a typical peak of ${medPeak}.`,
    recommendation: held
      ? `Turnout held up — keep the same time slot and announce rhythm.`
      : `Turnout dipped — vary the announce timing or day before touching the format itself.`,
    caveat: `Peak concurrents from Restream across all simulcast destinations; compared with the typical result from ${withLive.length - 1} prior episodes.`,
    chartState: { view: "live" },
  });
  const launchChat = withLive[0].live.chatMessages;
  const latestChat = newest.live.chatMessages;
  out.push({
    id: "live-chat",
    text: liveChatText(launchChat, latestChat),
    recommendation: latestChat >= launchChat
      ? `Chat is climbing — keep the call-in segments; they're feeding it.`
      : `Chat is the call-in pipeline — seed prompts and questions mid-show instead of waiting for organic chat.`,
    caveat: `Message totals from Restream chat archives, all destinations combined.`,
    chartState: { view: "live" },
  });
  return out;
}

// Per-unit cumulative series (F-7): YT views and X reach reported side by
// side, never summed together.
function cumulativeSeries(dive, now) {
  if (!dive.length) return [];
  const first = Math.min(...dive.map((e) => Date.parse(e.snapshots[0].ts)));
  const out = [];
  for (let b = mondayNoonAtOrBefore(first) + WEEK; b <= now; b += WEEK) {
    const eligible = dive.filter((e) => premiereMs(e.premiere) <= b);
    const readings = eligible.map((e) => lastAtOrBefore(e.snapshots, b));
    const sumUnit = (keys) => {
      const values = readings.map((s) => s ? totalOrNull(s.byDest, keys) : null);
      return values.length && values.every(Number.isFinite) ? values.reduce((a, v) => a + v, 0) : null;
    };
    const ytViews = sumUnit(YT_KEYS);
    const xReach = sumUnit(X_KEYS);
    out.push({ boundary: new Date(b).toISOString(), ytViews, xReach });
  }
  return out;
}

// Same-age pace for the newest episode (PRD v9 W22b): read from baselines.mjs
// — YouTube views at the newest episode's current age against the other
// episodes' readings at that same age, promo outliers left out, at least
// three peers or nothing. Same function feeds data.baselines.pace for the
// panel and table, so every surface shows one pace.
export function sameAgePace(dive, flags = anomalyFlags(dive)) {
  if (dive.length < 2) return null;
  const newest = dive[dive.length - 1];
  const p = paceFor(newest, dive, flags);
  if (!p) return null;
  const bySlug = new Map(dive.map((e) => [e.slug, e]));
  const peers = p.peers.map((slug) => ({ title: bySlug.get(slug)?.title, slug, partial: bySlug.get(slug)?.partialHistory }));
  return { newest, ageMs: p.ageDays * DAY, peers, rank: p.rank, of: p.of, median: p.typical, newestVal: p.value, pct: p.pct, excluded: p.excluded };
}

function shortTitle(t) {
  return t.replace(/^Dive Radio:\s*/i, "");
}

// Compact episode reference for insight prose: "E4 (Backyard Designers…)" —
// full titles chained mid-sentence are unparseable (critic re-review).
function refOf(e) {
  const first = shortTitle(e.title).split(/[,+]/)[0].trim();
  return `E${e.ep} (${first})`;
}

// Strategy-impact taxonomy (2026-08-22). Five categories, each named for the
// founder decision it informs — never for the math that produced it:
//   content      — what topics/formats to make more (or less) of
//   distribution — where and when to push episodes (platform mix, timing windows)
//   promotion    — announce/paid machinery: whose posts travel, hooks, promo ROI
//   audience     — audience health: engagement, live turnout, chat, sentiment
//   data         — caveats about the data itself (coverage, partial history)
// New insight ids MUST be added here; unknown ids fall back to "data" (a
// caveat is the only safe default) and the validator warns on the fallback.
export function categoryFor(id) {
  if (id === "pace-rank") return "content";               // is the newest topic landing?
  if (id === "engagement") return "audience";             // resonance per view
  if (id === "flatline") return "distribution";           // promo-window timing
  if (id === "platform-phase") return "distribution";     // when each platform delivers
  if (id === "watch-split") return "distribution";        // where watching actually happens
  if (id === "host-plays-split") return "distribution";   // whose room to broadcast from
  if (id === "host-split") return "promotion";            // whose announce travels
  if (id === "reach-conversion") return "promotion";      // does the hook close?
  if (id.startsWith("anomaly")) return "promotion";       // promo-driven outlier flag
  if (id.startsWith("live")) return "audience";           // live turnout / chat health
  if (id === "partial-history") return "data";
  return "data";
}

function buildInsights(dive, { flags }) {
  const insights = [];
  const full = dive.filter((e) => e.partialHistory === false);
  const state = (o) => ({ xMode: "weeks", yMode: "cumulative", dests: DESTS.map((d) => d.key), solo: null, ...o });

  // 1. same-age pace rank for the newest episode
  // Insight texts are written for a human first: a plain-English claim up
  // front, action in `recommendation`, methodology in `caveat` (small print).
  const pace = sameAgePace(dive, flags);
  if (pace && pace.rank) {
    const days = Math.round((pace.ageMs / DAY) * 10) / 10;
    const ahead = pace.newestVal >= pace.median;
    const pct = Math.abs(pace.pct ?? 0);
    // rule 18 (PRD v10): a promo-driven lift is shown, never presented as the
    // format landing — the newest episode's own flag (settled or provisional)
    // turns the claim into a caution
    const promo = !!flags?.get?.(pace.newest.slug)?.flagged;
    insights.push({
      id: "pace-rank",
      text: `${shortTitle(pace.newest.title)} has ${num(pace.newest.latest.totalViews)} total views ${days} days in — on YouTube it's pacing #${pace.rank} of ${pace.of} at this age, ${pct}% ${ahead ? "ahead of" : "behind"} the typical episode${promo ? " — a promo-driven lift so far, shown here and not scored in show health" : ""}.`,
      recommendation: promo
        ? `Its first days ran on promotion. Watch whether it keeps pace after the push fades before repeating the format.`
        : ahead
          ? `This topic/format is landing. Note what's different about it and repeat that on the next episode.`
          : `If this episode deserves a push, push now — gains concentrate in the first weeks and the gap won't close on its own.`,
      caveat: `Pace compares YouTube views only at matching ages (X plays have no history to compare); typical result from ${pace.peers.length} other episode${pace.peers.length === 1 ? "" : "s"} at the same age, promo outliers left out.`,
      chartState: state({ chart: "standings", solo: pace.newest.slug }),
    });
  }

  // 2. flatline / shelf life — suppressed below 3 clean samples (simplicity
  // contract: n<3 claims don't ship as trends; critic 2026-08-22)
  const flats = full.filter((e) => e.metrics.flatlineWeek !== null);
  if (flats.length >= 3) {
    const weeks = flats.map((e) => e.metrics.flatlineWeek);
    const maxW = Math.max(...weeks);
    insights.push({
      id: "flatline",
      text: `Episodes stop growing after about ${maxW} week${maxW === 1 ? "" : "s"}: ${flats.map((e) => `${refOf(e)} flatlined at week ${e.metrics.flatlineWeek}`).join("; ")}.`,
      recommendation: `Spend promo inside the first ${maxW} week${maxW === 1 ? "" : "s"} — a push after the flatline is fighting a dead curve.`,
      caveat: `Flatline = a week that adds under 3% of the running total; only ${flats.length} full-history episode${flats.length === 1 ? "" : "s"} so far.`,
      chartState: state({ yMode: "delta" }),
    });
  }

  // 3. platform phase mix (full-history episodes only) — within-unit shares
  // (F-7): X week-1 share of lifetime X reach vs YT week-1 share of lifetime
  // YT views. Cross-unit sums are forbidden math and never happen here.
  // ≥7-day-old episodes only: a 1-day-old episode's "week 1" IS its lifetime,
  // which trivially inflates the share (review H-4).
  // suppressed below 3 clean samples (simplicity contract; critic 2026-08-22)
  const phasePool = full.filter((e) => {
    const firstWeek = lastAtOrBefore(e.snapshots, premiereMs(e.premiere) + 7 * DAY);
    return e.ageDays >= 7 && firstWeek && [firstWeek, e.latest].every((s) => [YT_KEYS, X_KEYS].every((keys) => Number.isFinite(total(s.byDest, keys))));
  });
  if (phasePool.length >= 3) {
    let w1x = 0, w1yt = 0, lifeX = 0, lifeYt = 0;
    for (const e of phasePool) {
      const prem = premiereMs(e.premiere);
      const s7 = lastAtOrBefore(e.snapshots, prem + 7 * DAY);
      if (s7) {
        w1x += total(s7.byDest, X_KEYS);
        w1yt += total(s7.byDest, YT_KEYS);
      }
      lifeX += total(e.latest.byDest, X_KEYS);
      lifeYt += total(e.latest.byDest, YT_KEYS);
    }
    if (lifeX > 0 && lifeYt > 0 && (w1x > 0 || w1yt > 0)) {
      const xShare = Math.round((w1x / lifeX) * 100);
      const ytShare = Math.round((w1yt / lifeYt) * 100);
      insights.push({
        id: "platform-phase",
        text: `Launch week is nearly the whole story on both platforms: ${xShare}% of an episode's X reach and ${ytShare}% of its YouTube views arrive in the first 7 days.`,
        recommendation: `Treat launch week as the entire campaign — announce, clip, and cross-post inside it instead of drip-feeding afterward.`,
        caveat: `Within-platform shares (units never mixed); ≥7-day-old episodes only, sample of ${phasePool.length}.`,
        chartState: state({ chart: "standings" }),
      });
    }
  }

  // 4. host account split (X post impressions — reach, not video plays).
  // Outlier-flagged episodes are excluded: one promoted announce (E3) flips
  // the sign of this claim, so it cannot sit in the aggregate (review H-3).
  const splitPool = dive.filter((e) => !e.metrics.anomaly && X_KEYS.every((key) => Number.isFinite(e.latest.byDest[key]?.views)));
  let ridd = 0, tom = 0;
  for (const e of splitPool) {
    ridd += e.latest.byDest["x:ridd_design"].views;
    tom += e.latest.byDest["x:designertom"].views;
  }
  if (ridd + tom > 0 && splitPool.length >= 3) {
    const lead = ridd >= tom ? "@ridd_design" : "@designertom";
    const other = ridd >= tom ? "@designertom" : "@ridd_design";
    const pct = Math.round((Math.max(ridd, tom) / (ridd + tom)) * 100);
    const excluded = dive.length - splitPool.length;
    insights.push({
      id: "host-split",
      text: `${lead}'s announce posts travel further on X — ${pct}% of announce impressions (${num(ridd)} ridd vs ${num(tom)} tom).`,
      recommendation: `Lead each announcement from ${lead}'s account and have ${other} quote-post it — order the announce machine around what actually travels.`,
      caveat: `Reach = exposure, not watching, and is never charted or summed with views. ${excluded ? `Promo outlier${excluded > 1 ? "s" : ""} excluded; ` : ""}small sample (${splitPool.length} episodes) — read as tendency.`,
      chartState: state({ chart: "standings" }),
    });
  }

  // 4b. watch-platform split — X plays share of total views (same unit
  // family: both are video playback counts; point-in-time, not a trend)
  const withPlays = dive.filter((e) => e.latest.ytTotal != null && e.latest.totalViews != null && e.latest.xPlays != null && !e.latest.xPlaysInfo?.partial);
  if (withPlays.length >= 3) {
    const plays = withPlays.reduce((a, e) => a + e.latest.xPlays, 0);
    const views = withPlays.reduce((a, e) => a + e.latest.totalViews, 0);
    const shares = withPlays.map((e) => ({ e, s: e.latest.xPlays / e.latest.totalViews })).sort((a, b) => b.s - a.s);
    insights.push({
      id: "watch-split",
      text: `This is a genuinely two-platform show: ${Math.round((plays / views) * 100)}% of all actual watching happens on X broadcasts (${num(plays)} of ${num(views)} total views), not just YouTube with an X echo.`,
      recommendation: `Give X broadcasts first-class treatment — real titles, thumbnails, and call-outs, not simulcast leftovers.`,
      caveat: `Per-episode X share ranges ${Math.round(shares[shares.length - 1].s * 100)}% (${refOf(shares[shares.length - 1].e)}) to ${Math.round(shares[0].s * 100)}% (${refOf(shares[0].e)}); only episodes with complete X play counts are included (${withPlays.length}).`,
      chartState: state({ chart: "standings" }),
    });
  }

  // 4c. reach→watch conversion on X (plays per announce impression — a
  // within-platform ratio, the legitimate way to relate the two X units).
  // Episodes under 7 days old are excluded: early reach spikes bias the
  // ratio low before plays accumulate. Promo outliers are excluded because
  // promotion changes the audience mix and makes the hook comparison noisy.
  const cleanWithPlays = withPlays.filter((e) => !e.metrics.anomaly);
  const convPool = cleanWithPlays.filter((e) => e.ageDays >= 7 && e.latest.xImpressions > 0);
  if (convPool.length >= 3) {
    const ranked = convPool.map((e) => ({ e, r: e.latest.xPlays / e.latest.xImpressions })).sort((a, b) => b.r - a.r);
    const hi = ranked[0], lo = ranked[ranked.length - 1];
    insights.push({
      id: "reach-conversion",
      text: `Announce hooks close very differently: ${refOf(hi.e)} turned ${Math.round(hi.r * 100)} of every 100 announce impressions into actual plays; ${refOf(lo.e)} managed only ${Math.round(lo.r * 100)}.`,
      recommendation: `Reuse ${refOf(hi.e)}'s announce format — more of the people who saw that post chose to watch. High reach with few plays means the post traveled but didn't sell the click.`,
      caveat: `X broadcast plays for every 100 announce impressions; episodes at least 7 days old, with promo outliers left out, sample of ${ranked.length}.`,
      chartState: state({ chart: "standings" }),
    });
  }

  // 4d. host broadcast split — real watches per host's broadcast (plays),
  // the watch-side complement to the reach-based host split above
  {
    let riddP = 0, tomP = 0, n = 0;
    for (const e of cleanWithPlays) {
      const r = e.latest.byDest["x:ridd_design"]?.plays;
      const t = e.latest.byDest["x:designertom"]?.plays;
      if (r != null && t != null) { riddP += r; tomP += t; n++; }
    }
    if (n >= 3 && riddP + tomP > 0) {
      const lead = riddP >= tomP ? "@ridd_design" : "@designertom";
      const other = riddP >= tomP ? "@designertom" : "@ridd_design";
      const pct = Math.round((Math.max(riddP, tomP) / (riddP + tomP)) * 100);
      // a 53/47 split is a coin flip, not a claim — don't overcall it (critic)
      const nearEven = pct < 55;
      insights.push({
        id: "host-plays-split",
        text: nearEven
          ? `Broadcast watching splits nearly evenly — ${pct}% ${lead === "@ridd_design" ? "ridd" : "tom"} / ${100 - pct}% ${other === "@designertom" ? "tom" : "ridd"} (${num(riddP)} vs ${num(tomP)} plays). Announce reach is where the hosts actually differ.`
          : `People actually sit in ${lead}'s room: ${pct}% of broadcast watching happens there (${num(riddP)} ridd vs ${num(tomP)} tom).`,
        recommendation: nearEven
          ? `No flagship change warranted — both rooms pull their weight. Optimize the announces (where the split is real) instead.`
          : `If the split holds, make ${lead}'s account the flagship broadcast and use ${other}'s for clips and reposts.`,
        caveat: `Episodes where both hosts' plays are known, with promo outliers left out (${n}).`,
        chartState: state({ chart: "standings" }),
      });
    }
  }

  // 5. anomalies
  for (const e of dive) {
    if (e.metrics.anomaly) {
      insights.push({
        id: `anomaly-${e.slug}`,
        text: `${refOf(e)} is a promo-driven outlier, not a topic winner: ${e.metrics.anomaly.replace(/ — treat as promo-driven outlier, not topic signal$/, "")}.`,
        recommendation: `Don't copy this episode's topic because of its numbers — separate the paid/promo lift from organic pull first.`,
        caveat: `Outlier = more than double what nearby episodes did on that unit at the same age${flags.get(e.slug)?.provisional ? " (an early read until three of them reach three weeks)" : ""}; left out of host, announce, and topic comparisons automatically.`,
        chartState: state({ chart: "standings", solo: e.slug }),
      });
    }
  }

  // 6. engagement — ≥7-day episodes only: ratios drift with age, so a 1-day
  // episode vs a 35-day episode is a lifecycle comparison, not a topic one
  const eng = dive.filter((e) => e.metrics.engagementPer1k !== null && e.ageDays >= 7).sort((a, b) => b.metrics.engagementPer1k - a.metrics.engagementPer1k);
  if (eng.length >= 2) {
    const hi = eng[0], lo = eng[eng.length - 1];
    insights.push({
      id: "engagement",
      text: `${refOf(hi)} pulled the most engaged viewers — ${hi.metrics.engagementPer1k} likes+comments per 1,000 YouTube views; ${refOf(lo)} the least at ${lo.metrics.engagementPer1k}.`,
      recommendation: `Mine ${refOf(hi)}'s comments for what hooked people — that topic drove interaction, not just plays.`,
      caveat: `YouTube only; episodes at least 7 days old because likes and comments per 1,000 views change with age, sample of ${eng.length}.`,
      chartState: state({ chart: "trajectory" }),
    });
  }

  // 7. partial-history note
  const partial = dive.filter((e) => e.partialHistory);
  if (partial.length) {
    const codes = partial.map((e) => "E" + e.ep);
    const codeList = codes.length > 1 ? codes.slice(0, -1).join(", ") + " and " + codes[codes.length - 1] : codes[0];
    insights.push({
      id: "partial-history",
      text: `${codeList} ${partial.length === 1 ? "was" : "were"} registered late — ${partial.length === 1 ? "its" : "their"} early weekly history doesn't exist. Totals are right; first-week growth comparisons aren't.`,
      recommendation: `Nothing to do — the flags are automatic. Just don't read first-week growth comparisons for these episodes.`,
      caveat: `Tracked late: ${partial.map((e) => refOf(e)).join(", ")}. Marked "tracked late" in the episode panel.`,
      chartState: state({}),
    });
  }

  return insights;
}

// --- Slack trends block (used by postlive-track.mjs report --trends) ---

// exported so the validator can recompute the sharpest-exit line verbatim
export function minutesInWords(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} in`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}${m % 60 ? ` ${m % 60} minutes` : ""} in`;
}

// Structured Slack lines (PRD v9 1x): each carries its sample and direction
// so the validator checks the small-n rule on data, not by reading prose.
export function trendsLines(data) {
  const CAT_LABEL = { content: "Content", distribution: "Distribution", promotion: "Promotion", audience: "Audience health", data: "Data note" };
  const lines = [];
  const push = (text, meta = {}) => lines.push({ text, sample: meta.sample ?? null, direction: meta.direction ?? null, kind: meta.kind ?? "line" });
  for (const i of data.insights) {
    push(`• [${CAT_LABEL[i.category] ?? "Note"}] ${i.text}`, { kind: "insight" });
    if (i.recommendation) push(`   ↳ ${i.recommendation}`, { kind: "insight" });
  }
  if (data.insights.length === 0) push("• Not enough data for trend calls yet.");
  const vels = data.showTrend.week1VelocityByEpisode.filter((v) => v.value !== null);
  // first-week line only from three clean weeks (rule 7; PRD v9 F14) — below
  // that the numbers are listed without a direction word
  if (vels.length >= 3) {
    // PRD v10 rule 20: the ONE first-week direction — the stored lens
    // (baselines.direction, Theil–Sen over the last clean weeks by episode
    // number); a word only with four clean weeks, the slope alone with three
    const fwTrend = (data.baselines?.direction?.measures || []).find((m) => m.key === "firstWeek") || null;
    const dir = fwTrend?.direction || null;
    const tail = dir
      ? `${dir}${dir !== "holding" ? ` about ${Math.abs(fwTrend.pctPerEpisode)}% each episode` : ""} over the last ${fwTrend.n} clean weeks`
      : `the slope over the last ${fwTrend?.n ?? vels.length} clean weeks is ${fwTrend?.pctPerEpisode != null ? `${fwTrend.pctPerEpisode > 0 ? "+" : ""}${fwTrend.pctPerEpisode}% each episode` : "not yet readable"}; a direction word needs four`;
    push(`• First-week YouTube views in air order: ${vels.map((v) => `${v.premiere.slice(5)} ${num(v.value)}`).join(" → ")} — ${tail}.`, { sample: fwTrend?.n ?? vels.length, direction: dir });
  } else if (vels.length) {
    push(`• First-week YouTube views so far: ${vels.map((v) => `${v.premiere.slice(5)} ${num(v.value)}`).join(" · ")} — a direction needs three clean first weeks.`, { sample: vels.length });
  }
  // W12/PRD v9: episode health, read from the same store as every dashboard
  // surface. Only finished reads WITH a score appear; an episode with too few
  // comparison episodes is simply not listed (absence is silent; the panel
  // carries its reason). The wording says what each number is — its own read
  // against the episodes before it — never a trend across them.
  const newest = data.episodes[data.episodes.length - 1];
  if (newest?.promotion?.status === "found") {
    const p = newest.promotion;
    const clicks = p.emailClicks == null
      ? "tracked email click count is not available"
      : p.emailClicks === 0 ? "no tracked email clicks yet" : `${num(p.emailClicks)} tracked email clicks`;
    const verified = p.verifiedEmailClicks == null
      ? "verified click count is not available"
      : p.verifiedEmailClicks === 0 ? "no clicks verified by Beehiiv yet" : `${num(p.verifiedEmailClicks)} verified by Beehiiv`;
    push(`• Promotion: ${p.source || "UX Tools"} linked ${shortTitle(newest.title)} — ${clicks}; ${verified}. These clicks are not part of views.`, { kind: "newsletter-promotion" });
  }
  const scored = data.episodes.filter((e) => e.health && !e.health.pending && e.health.score != null);
  if (scored.length) {
    const seq = scored.map((e) => `${e.premiere.slice(5)} ${e.health.score}`).join(" · ");
    push(`• Episode health, each against the episodes before it (50 is a typical episode): ${seq}.`, { sample: scored.length, kind: "episode-health" });
  }
  if (newest?.health?.pending) {
    push(`• ${shortTitle(newest.title)} gets its health score after ${newest.health.readCompleteOn.slice(5).replace("-", "/")}, when its first three weeks are complete.`);
  }
  // W27: a change in which checks scored is a change in what the number means,
  // and Slack says so the same day (2026-08-24: two checks left, the score held
  // still, and the digest was silent). One name definition: health.mjs.
  const setChange = data.health?.checkSetChange;
  if (setChange && (setChange.left?.length || setChange.joined?.length)) {
    const words = (keys) => keys.map((k) => HEALTH_CHECK_LABELS[k] ?? k).map((w, i, all) =>
      (i === 0 ? "" : i === all.length - 1 ? " and " : ", ") + w).join("");
    const parts = [];
    if (setChange.left?.length) parts.push(`${words(setChange.left)} left`);
    if (setChange.joined?.length) parts.push(`${words(setChange.joined)} joined`);
    const expected = data.health?.asOf?.provisional ? " Expected while the newest episode is under a week old: its same-age checks join as earlier episodes reach its age." : "";
    push(`• Show health now rests on a different set of checks than the last saved read: ${parts.join("; ")}. Same show, different checks — the diagnosis card says why each is in or out.${expected}`, { kind: "health-checkset" });
  }
  // PRD v10: which way the durable measures are moving and where the next
  // first week is expected to land — read verbatim from the saved entry's
  // direction and outlook blocks (one definition: health.mjs over
  // baselines.mjs); a direction word rides only on three or more episodes
  const dir = data.baselines?.direction;
  if (dir?.overall && Array.isArray(dir.measures)) {
    const named = { firstWeek: "clean first weeks", liveAverage: "average live viewers", livePeak: "peak live viewers", chattersPer100: "chatters per hundred at the peak", messagesPerHour: "chat messages an hour", engagementWeekOne: "first-week likes and comments", exposureWeekOne: "first-week X reach", announceToPlay: "announce-to-play on X", watching: "share watched", subscribers: "subscribers per thousand views" };
    const words = (w) => dir.measures.filter((m) => m.direction === w).map((m) => named[m.key] || m.key);
    const parts = [];
    if (words("building").length) parts.push(`building: ${words("building").join(", ")}`);
    if (words("softening").length) parts.push(`softening: ${words("softening").join(", ")}`);
    const sample = Math.max(0, ...dir.measures.map((m) => m.n || 0));
    const votes = (dir.votes || []).map((v) => `${HEALTH_CHECK_LABELS[v.check] ?? v.check} ${v.direction}`).join(", ");
    push(`• Show health direction over the last few clean episodes: ${dir.overall}${votes ? ` (${votes})` : ""}${parts.length ? ` — ${parts.join("; ")}` : ""}.`, { sample, direction: dir.overall === "mixed" || dir.overall === "holding" ? null : dir.overall, kind: "health-direction" });
  }
  const nfw = data.baselines?.outlook?.nextFirstWeek;
  if (nfw && nfw.low != null && nfw.high != null) {
    push(`• The last three clean launches' first weeks ran ${num(nfw.low)}–${num(nfw.high)} YouTube views (typical ${num(nfw.typical)})${nfw.direction ? `, ${nfw.direction}` : nfw.pctPerEpisode != null ? `, slope ${nfw.pctPerEpisode > 0 ? "+" : ""}${nfw.pctPerEpisode}% each episode` : ""} — where the next one lands if it follows them.`, { sample: nfw.n, direction: nfw.direction, kind: "health-outlook" });
  }
  // v6 W16/W17: the newest episode's sharpest exit moment, read from the same
  // stored moments the panel pins render. Context is the model-written summary
  // from the moment-summaries store — never a raw transcript quote; without a
  // stored summary the numbers stand alone.
  const momentEp = [...data.episodes].reverse().find((e) => e.watch?.moments?.some((m) => m.kind === "drop"));
  if (momentEp) {
    const drop = momentEp.watch.moments.filter((m) => m.kind === "drop").sort((a, b) => b.points - a.points || a.at - b.at)[0];
    push(`• Sharpest exit in ${shortTitle(momentEp.title)}: ${drop.points} of every 100 viewers leave ${drop.approx ? "roughly" : "about"} ${minutesInWords(drop.estSec)}${drop.summary ? ` — ${drop.summary}` : ""}.`);
  }
  // W8: newest-episode feedback, read from the same exported rollup as the page.
  const c = newest?.comments;
  if (c) {
    const enjoyed = c.enjoyCount ? `${c.enjoyCount} ${c.enjoyCount === 1 ? "person enjoyed" : "people enjoyed"} something` : "no praise yet";
    const concerns = c.complaintCount ? `${c.complaintCount} ${c.complaintCount === 1 ? "person raised" : "people raised"} a concern` : "no complaints";
    const rate = c.commentersPer1k != null ? `; ${c.commentersPer1k} people per 1,000 watches` : "";
    const top = c.enjoyThemes?.[0] ? `; top bright spot: ${c.enjoyThemes[0].theme} — ${c.enjoyThemes[0].count} people` : "";
    push(`• Audience feedback: ${c.uniqueCommenters} ${c.uniqueCommenters === 1 ? "person" : "people"} commented; ${enjoyed}; ${concerns}${rate}${top}.`);
  }
  return lines;
}

export function trendsText(data) {
  return ["", "Trends", ...trendsLines(data).map((l) => l.text)].join("\n");
}

// --- main ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const release = acquireSourceLock(join(ROOT, "data", "restream", "public-build"));
  try {
  assertSourceStoreIntegrity(ROOT);
  const data = computeAll();
  // "<" escaped in the JSON so a "</script>" inside user comment text can
  // never break out of a script context, even if the data is ever inlined
  // into HTML (critic F-C9a). Valid JSON either way; byte-identical between
  // data.json and data.js so the validator's byte-match stays meaningful.
  const json = JSON.stringify(data, null, 1).replace(/</g, "\\u003c");
  // artifacts live at the repo root — the same directory Vercel serves
  const brief = buildBrief(data);
  atomicWriteText(join(ROOT, "data.json"), json);
  atomicWriteText(join(ROOT, "data.js"), `window.DIVE_DATA = ${json};\n`);
  // PRD v12: the agent brief, its digest, and the index — pure over the same object
  atomicWriteText(join(ROOT, "agent.md"), brief.md);
  atomicWriteText(join(ROOT, "agent.json"), brief.json);
  atomicWriteText(join(ROOT, "llms.txt"), brief.llms);
  const dive = data.episodes.filter((e) => e.show === "dive-radio");
  console.log(
    `dive-analytics: wrote data.json + data.js + agent.md/agent.json/llms.txt — ${data.episodes.length} episodes (${dive.length} dive-radio), ${data.insights.length} insights, generated ${data.generatedAt}`
  );
  } finally { release(); }
}
