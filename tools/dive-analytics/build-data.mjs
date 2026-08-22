#!/usr/bin/env node
// build-data.mjs — export dive-analytics data.json/data.js from data/restream/postlive/*.json
// Deterministic: no model calls, no network. Same math feeds the dashboard and the
// Monday Slack report (postlive-track.mjs report --trends imports computeAll/trendsText).
// PRD: Dive Media Group/Dive Radio/prd-episode-analytics-chart.md

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
// negative-signal veto for featured quotes (comments critic 2026-08-22 C1):
// same deterministic wordlist the sentiment labels come from
import { hasNegativeSignal } from "../../scripts/restream/comments-sentiment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY_DIR = join(ROOT, "data", "restream", "postlive");
const EVENTS_DIR = join(ROOT, "data", "restream", "events");
const COMMENTS_DIR = join(ROOT, "data", "restream", "comments");
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");

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

function compactSnap(s) {
  const byDest = {};
  for (const [k, m] of Object.entries(s.metrics || {})) {
    const d = m.detail || {};
    byDest[k] = {
      views: m.views || 0,
      likes: d.likes || 0,
      comments: d.comments ?? d.replies ?? 0,
    };
    // real plays: broadcast views (m.plays, from yt-dlp) or native-video views (detail)
    const plays = m.plays ?? d.plays;
    if (plays != null) byDest[k].plays = plays;
    if (m.peakConcurrent != null) byDest[k].peakConcurrent = m.peakConcurrent;
  }
  return { ts: s.ts, byDest };
}

function total(byDest, keys) {
  const use = keys || DESTS.map((d) => d.key);
  return use.reduce((a, k) => a + (byDest[k]?.views || 0), 0);
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
function xPlaysSummary(show, byDest) {
  const targets = (show.targets || []).filter(
    (t) => t.kind === "x" && t.role !== "promo" && t.playsStatus !== "none"
  );
  const keys = [...new Set(targets.map((t) => `x:${t.account}`))];
  const out = { value: null, have: 0, total: keys.length, partial: false, stale: false, asOf: null };
  for (const k of keys) {
    const p = byDest[k]?.plays;
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

// Per-episode latest block. totalViewsInfo mirrors xPlaysInfo so partial/
// stale coverage markers survive from build to render (audit F-2 guard).
function buildLatest(show, latest) {
  const playsInfo = xPlaysSummary(show, latest.byDest);
  const ytTotal = total(latest.byDest, YT_KEYS);
  return {
    ts: latest.ts,
    byDest: latest.byDest,
    ytTotal,
    xImpressions: total(latest.byDest, X_KEYS),
    xPlays: playsInfo.value,
    xPlaysInfo: playsInfo,
    totalViews: ytTotal + (playsInfo.value ?? 0),
    totalViewsInfo: {
      includesPlays: playsInfo.value != null,
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
    const histPath = join(HISTORY_DIR, `${show.slug}.json`);
    if (!existsSync(histPath)) continue;
    const hist = JSON.parse(readFileSync(histPath, "utf8"));
    if (!hist.snapshots?.length) continue;

    const snaps = hist.snapshots.map(compactSnap).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const prem = premiereMs(show.date);
    const firstTs = Date.parse(snaps[0].ts);
    const lastTs = Date.parse(snaps[snaps.length - 1].ts);
    const isDiveRadio = /dive.?radio/i.test(show.title) || /dive-radio/.test(show.slug);
    if (!isDiveRadio) continue; // Dive Radio only (owner directive 2026-08-21)
    const partialHistory = firstTs - prem > PARTIAL_THRESHOLD_DAYS * DAY;

    // weekly resample: Monday-noon-Phoenix boundaries; last snapshot at-or-before each;
    // nothing rendered before the first snapshot (no fabricated zeros).
    const weekly = [];
    let b = mondayNoonAtOrBefore(firstTs) + WEEK; // first boundary at/after first snapshot
    if (b - WEEK >= firstTs) b -= WEEK;
    for (; b <= now; b += WEEK) {
      const snap = lastAtOrBefore(snaps, b);
      if (!snap) continue;
      weekly.push({
        week: Math.max(0, Math.floor((b - prem) / WEEK)),
        boundary: new Date(b).toISOString(),
        byDest: snap.byDest,
      });
    }

    const latest = snaps[snaps.length - 1];

    // metrics
    const ageDays = (lastTs - prem) / DAY;
    // All pace/velocity/decay metrics use YT views ONLY — real video plays.
    // X reports post impressions (reach), a different unit; never mixed in.
    let week1Velocity = null;
    let week1Note = null;
    if (partialHistory) {
      week1Note = "excluded: partial history";
    } else if (ageDays < 7) {
      week1Note = "pending: episode under 7 days old";
    } else {
      const s7 = lastAtOrBefore(snaps, prem + 7 * DAY);
      week1Velocity = s7 ? total(s7.byDest, YT_KEYS) : null;
      if (!week1Velocity) week1Note = "no snapshot inside first week";
    }

    let flatlineWeek = null;
    if (!partialHistory) {
      for (let i = 1; i < weekly.length; i++) {
        const t0 = total(weekly[i - 1].byDest, YT_KEYS);
        const t1 = total(weekly[i].byDest, YT_KEYS);
        if (t1 > 0 && (t1 - t0) / t1 < FLATLINE_RATIO) {
          flatlineWeek = weekly[i].week;
          break;
        }
      }
    }

    const ytViews = (latest.byDest["yt:joindiveclub"]?.views || 0) + (latest.byDest["yt:designertom"]?.views || 0);
    const ytEng =
      (latest.byDest["yt:joindiveclub"]?.likes || 0) +
      (latest.byDest["yt:joindiveclub"]?.comments || 0) +
      (latest.byDest["yt:designertom"]?.likes || 0) +
      (latest.byDest["yt:designertom"]?.comments || 0);
    const engagementPer1k = ytViews > 0 ? Math.round((ytEng / ytViews) * 1000 * 10) / 10 : null;

    // Announce receipts (PRD v2 W6): when each host's X post went out.
    // Timestamps come from the tweet id itself (snowflake epoch) — stored
    // fact, no network, no guessing.
    const announces = (show.targets || [])
      .filter((t) => t.kind === "x" && t.postId)
      .map((t) => ({
        account: t.account,
        role: t.role || "announce",
        ts: new Date(Number((BigInt(t.postId) >> 22n) + 1288834974657n)).toISOString(),
      }))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));

    episodes.push({
      slug: show.slug,
      title: show.title,
      premiere: show.date,
      show: isDiveRadio ? "dive-radio" : "other",
      active: show.active !== false,
      partialHistory,
      announces,
      snapshots: snaps,
      weekly,
      // Unit discipline (CARD-RULING-2026-08-21): totalViews = ytTotal +
      // xPlays — both count video playback events. xImpressions (reach) is
      // exposure, a different unit, and is NEVER part of any views total.
      latest: buildLatest(show, latest),
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

  // anomaly flags: any unit >2x its all-episode median (YT views, X plays,
  // X reach each checked within their own unit — critic ruling item 7 / F-8)
  const medianOf = (vals) => {
    const v = vals.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; // true median (critic 2026-08-22: upper-middle convention overstated it)
  };
  const median = medianOf(dive.map((e) => e.latest.ytTotal));
  const medPlays = medianOf(dive.map((e) => e.latest.xPlays));
  const medReach = medianOf(dive.map((e) => e.latest.xImpressions));
  for (const e of dive) {
    const hits = [];
    if (median > 0 && e.latest.ytTotal > 2 * median) hits.push(`${num(e.latest.ytTotal)} YT views vs a typical ${num(median)}`);
    if (medPlays > 0 && e.latest.xPlays != null && e.latest.xPlays > 2 * medPlays) hits.push(`${num(e.latest.xPlays)} X plays vs a typical ${num(medPlays)}`);
    if (medReach > 0 && e.latest.xImpressions > 2 * medReach) hits.push(`${num(e.latest.xImpressions)} X reach vs a typical ${num(medReach)}`);
    if (hits.length) {
      e.metrics.anomaly = `more than double what a typical episode gets (${hits.join("; ")}) — treat as promo-driven outlier, not topic signal`;
    }
  }

  attachLiveSessions(dive, registry);
  attachComments(dive);
  attachRatings(dive);

  const insights = buildInsights(dive, { now, median });
  insights.push(...liveInsights(dive));
  // Strategy-impact categories (owner directive 2026-08-22): each insight is
  // tagged by the DECISION it informs, not the data type it reads, and the
  // list is ordered by decision priority (stable within a category).
  for (const i of insights) i.category = categoryFor(i.id);
  const catRank = { content: 0, distribution: 1, promotion: 2, audience: 3, data: 4 };
  insights.sort((a, b) => (catRank[a.category] ?? 9) - (catRank[b.category] ?? 9));
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
      const p = sameAgePace(dive);
      return p && p.rank ? { slug: p.newest.slug, rank: p.rank, of: p.of } : null;
    })(),
  };

  return {
    generatedAt: new Date(now).toISOString(),
    dests: DESTS,
    episodes,
    insights,
    showTrend,
  };
}

// --- episode ratings (W9): computed + frozen by ratings.mjs, attached from its store ---
// Definition-lock: every surface (card badge, hero verdict, panel, table, Slack
// line) reads THIS attached entry — nobody recomputes a rank at render time.
const RATINGS_PATH = join(ROOT, "data", "restream", "episode-ratings.json");
function attachRatings(dive) {
  let store = null;
  try { store = JSON.parse(readFileSync(RATINGS_PATH, "utf8")); } catch { return; /* store absent → ratings simply don't render (absence ≠ zero) */ }
  const bySlug = new Map((store.ratings || []).map((r) => [r.slug, r]));
  for (const e of dive) {
    const r = bySlug.get(e.slug);
    if (r) e.rating = r;
  }
}

// --- audience comments (collected by comments-pull.mjs) ---
// Featured = positive, non-host comments ranked by likes + positive signal.
// Hosts are excluded at pull time; ranking is deterministic (no model).
// PRAISE is a positive-signal booster for ranking, no longer the gate: a
// featured quote must ALSO be sentiment-positive (critic F-C1 \u2014 the regex
// alone featured "love the show, but the quality is sooo poor" as praise).
// \blol\b removed: a laugh marker is not praise.
const PRAISE = /love|great|awesome|amazing|best|fantastic|incredible|fire|banger|peak|favorite|favourite|brilliant|gold|smiled|laughed|chuckl|funny|haha|enjoyed|insightful|learned|excellent|goated|so good|well done|nailed|\ud83d\udd25|\ud83d\ude02|\u2764|\ud83d\udcaf|\ud83d\udc4f/i;
const SENTIMENT_PATH = join(ROOT, "data", "restream", "comments-sentiment.json");
const SENTIMENT_LABELS = new Set(["positive", "negative", "neutral"]);
function attachComments(dive) {
  // Labels come ONLY from the persisted store (written by comments-sentiment.mjs,
  // incremental, never silently reclassified). A comment with no stored label
  // counts as "unclassified" \u2014 absence is never turned into a label here.
  let labels = {};
  try { labels = JSON.parse(readFileSync(SENTIMENT_PATH, "utf8")).classified || {}; } catch { /* store absent \u2192 all unclassified */ }
  for (const e of dive) {
    const path = join(COMMENTS_DIR, `${e.slug}.json`);
    if (!existsSync(path)) continue;
    let store;
    try { store = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const all = store.comments || [];
    // Gate: sentiment-positive (when the store has labels) AND length-sane.
    // Rank: likes, with a PRAISE-regex hit as a positive-signal boost.
    // Falls back to PRAISE-only gating when no labels exist yet.
    const hasLabels = Object.keys(labels).length > 0;
    // Featuring is stricter than labeling: a quote with ANY negative evidence
    // is vetoed even when its net label is positive ("banger episode… pls fix
    // your streaming" must never be a pull-quote).
    const featured = all
      .filter((c) => c.text && c.text.length >= 8 && c.text.length <= 300 &&
        !hasNegativeSignal(c.text) &&
        (hasLabels ? labels[c.id]?.label === "positive" : PRAISE.test(c.text)))
      .map((c) => ({ ...c, score: (c.likes || 0) * 2 + (PRAISE.test(c.text) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || (a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, 3)
      .map((c) => ({ source: c.source, author: c.author, text: c.text.slice(0, 200), likes: c.likes || 0 }));
    const sentiment = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
    const list = all
      .map((c) => {
        const label = SENTIMENT_LABELS.has(labels[c.id]?.label) ? labels[c.id].label : null;
        sentiment[label ?? "unclassified"]++;
        return { author: c.author, text: c.text, source: c.source, likes: c.likes || 0, at: c.publishedAt, sentiment: label };
      })
      .sort((a, b) => b.likes - a.likes || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.text < b.text ? -1 : 1));
    // xCoverage: "covered" = the X reply window was actually searched during
    // this episode's first week; "missed" = the episode aired before comment
    // tracking existed (X search only reaches back 7 days). Absence ≠ zero:
    // the UI must say "couldn't see it", never imply "no X replies".
    e.comments = { total: all.length, featured, sentiment, list, xCoverage: store.xCoverage ?? null };
  }
}

// --- Restream live-session data (archived by restream-analytics-ingest) ---
// Attaches per-episode `live` block: peak/avg concurrents, live views,
// watched minutes, chat totals, per-minute series, per-channel splits.
function attachLiveSessions(dive, registry) {
  if (!existsSync(EVENTS_DIR)) {
    // The Restream event archive lives only on the pipeline machine. A live
    // session is an immutable historical fact — when the archive is absent
    // (e.g. building from a fresh checkout), carry the `live` blocks forward
    // from the last built artifact instead of silently dropping the Live tab
    // (absence ≠ zero). On the pipeline machine this path never runs.
    try {
      const prev = JSON.parse(readFileSync(join(HERE, "data.json"), "utf8"));
      let carried = 0;
      for (const e of dive) {
        const old = prev.episodes?.find((p) => p.slug === e.slug);
        if (old?.live) { e.live = old.live; carried++; }
      }
      if (carried) console.error(`build: events archive absent — carried ${carried} live block(s) forward from previous data.json`);
    } catch { /* no previous artifact — live stays absent */ }
    return;
  }
  const vidAccount = {};
  for (const s of registry.shows) {
    for (const t of s.targets || []) if (t.videoId) vidAccount[t.videoId] = t.account;
  }
  const events = [];
  for (const f of readdirSync(EVENTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const ev = JSON.parse(readFileSync(join(EVENTS_DIR, f), "utf8"));
      if (ev?.viewers?.total && ev?.event?.startedAt) events.push(ev);
    } catch { /* skip malformed archive */ }
  }
  for (const e of dive) {
    const prem = premiereMs(e.premiere);
    let best = null;
    for (const ev of events) {
      const diff = Math.abs(ev.event.startedAt * 1000 - prem);
      if (diff < 36 * 3600000 && (!best || diff < best.diff)) best = { ev, diff };
    }
    if (!best) continue;
    const ev = best.ev;
    const started = ev.event.startedAt * 1000;
    const finished = (ev.event.finishedAt || 0) * 1000;
    const vt = ev.viewers.total;
    const mt = ev.messages?.total || {};
    const chatByMin = new Map(
      (mt.messagesPerMinute || []).map((p) => [Math.round((p.timestamp - started) / 60000), p.messages])
    );
    // channel labels from event destinations (YT videoId -> registry account)
    const chanLabel = {};
    let xCount = 0;
    for (const d of ev.event.destinations || []) {
      const u = d.externalUrl || "";
      const ytm = u.match(/(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
      if (ytm) {
        const acct = vidAccount[ytm[1]];
        chanLabel[d.channelId] =
          acct === "joindiveclub" ? "YT Dive Club" : acct === "designertom" ? "YT DesignerTom" : "YouTube";
      } else if (/(?:x|twitter)\.com/.test(u)) {
        xCount += 1;
        chanLabel[d.channelId] = xCount === 1 ? "X" : `X #${xCount}`;
      } else if (u) {
        chanLabel[d.channelId] = new URL(u).hostname.replace(/^www\./, "");
      }
    }

    // per-channel per-minute concurrents (only channels that report any),
    // so the tooltip can show what the total is made of.
    const chanMinutes = {};
    for (const [cid, cv] of Object.entries(ev.viewers.byChannel || {})) {
      if (!(cv.max > 0)) continue;
      chanMinutes[chanLabel[cid] || `channel ${cid}`] = new Map(
        (cv.viewersPerMinute || []).map((p) => [Math.round((p.timestamp - started) / 60000), p.viewers])
      );
    }

    // series carries per-minute chat (c) AND running chat total (ct) so the
    // tooltip can show "N messages so far" — a lone per-minute 0 reads as broken.
    const series = [];
    let chatCum = 0;
    for (const p of vt.viewersPerMinute || []) {
      const m = Math.round((p.timestamp - started) / 60000);
      const c = chatByMin.get(m) || 0;
      chatCum += c;
      if (m >= 0) {
        const byChan = {};
        for (const [l, map] of Object.entries(chanMinutes)) byChan[l] = map.get(m) || 0;
        series.push({ m, v: p.viewers, c, ct: chatCum, byChan });
      }
    }

    const byChannel = [];
    for (const [cid, cv] of Object.entries(ev.viewers.byChannel || {})) {
      const cm = ev.messages?.byChannel?.[cid] || {};
      if (!(cv.max || cv.viewsTotal || cm.messagesTotal)) continue;
      byChannel.push({
        label: chanLabel[cid] || `channel ${cid}`,
        peak: cv.max || 0,
        avg: cv.mean || 0,
        views: cv.viewsTotal || 0,
        messages: cm.messagesTotal || 0,
        chatters: cm.chattersTotal || 0,
      });
    }
    byChannel.sort((a, b) => b.views - a.views);

    e.live = {
      peak: vt.max || 0,
      avg: vt.mean || 0,
      liveViews: vt.viewsTotal || 0,
      watchedMin: vt.watchedTime || 0,
      chatMessages: mt.messagesTotal || 0,
      chatters: mt.chattersTotal || 0,
      durationMin: finished > started ? Math.round((finished - started) / 60000) : null,
      series,
      byChannel,
    };
  }
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
    caveat: `Peak concurrents from Restream across all simulcast destinations; prior-episode median of ${withLive.length - 1}.`,
    chartState: { view: "live" },
  });
  const chatLine = withLive.map((e) => `E${e.ep} ${e.live.chatMessages}`).join(" → ");
  const chatUp =
    withLive[withLive.length - 1].live.chatMessages >= withLive[0].live.chatMessages;
  out.push({
    id: "live-chat",
    text: `Live chat is trending ${chatUp ? "up" : "down"}: ${chatLine} messages in air order. ${shortTitle(newest.title)} drew ${newest.live.chatMessages} from ${newest.live.chatters} chatters.`,
    recommendation: chatUp
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
    let ytViews = 0;
    let xReach = 0;
    for (const e of dive) {
      const s = lastAtOrBefore(e.snapshots, b);
      if (s) {
        ytViews += total(s.byDest, YT_KEYS);
        xReach += total(s.byDest, X_KEYS);
      }
    }
    out.push({ boundary: new Date(b).toISOString(), ytViews, xReach });
  }
  return out;
}

// same-age comparison: newest episode at its current age vs prior episodes at the same age.
// Only prior episodes whose first snapshot is at-or-before that age qualify (no extrapolation).
function sameAgePace(dive) {
  if (dive.length < 2) return null;
  const newest = dive[dive.length - 1];
  const ageMs = Date.parse(newest.latest.ts) - premiereMs(newest.premiere);
  const peers = [];
  for (const e of dive.slice(0, -1)) {
    const prem = premiereMs(e.premiere);
    if (Date.parse(e.snapshots[0].ts) - prem > ageMs) continue; // no real data at that age
    const s = lastAtOrBefore(e.snapshots, prem + ageMs);
    if (s) peers.push({ title: e.title, slug: e.slug, value: total(s.byDest, YT_KEYS), partial: e.partialHistory });
  }
  if (!peers.length) return { newest, ageMs, peers: [], rank: null };
  const sorted = [...peers].sort((a, b) => b.value - a.value);
  const newestVal = newest.latest.ytTotal;
  const rank = sorted.filter((p) => p.value > newestVal).length + 1;
  const vals = peers.map((p) => p.value).sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)];
  return { newest, ageMs, peers: sorted, rank, of: peers.length + 1, median: med, newestVal };
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

function buildInsights(dive, { median }) {
  const insights = [];
  const full = dive.filter((e) => !e.partialHistory);
  const state = (o) => ({ xMode: "weeks", yMode: "cumulative", dests: DESTS.map((d) => d.key), solo: null, ...o });

  // 1. same-age pace rank for the newest episode
  // Insight texts are written for a human first: a plain-English claim up
  // front, action in `recommendation`, methodology in `caveat` (small print).
  const pace = sameAgePace(dive);
  if (pace && pace.rank) {
    const days = Math.round((pace.ageMs / DAY) * 10) / 10;
    const ahead = pace.newestVal >= pace.median;
    const pct = pace.median > 0 ? Math.abs(Math.round(((pace.newestVal - pace.median) / pace.median) * 100)) : 0;
    insights.push({
      id: "pace-rank",
      text: `${shortTitle(pace.newest.title)} has ${num(pace.newest.latest.totalViews)} total views ${days} days in — on YouTube it's pacing #${pace.rank} of ${pace.of} at this age, ${pct}% ${ahead ? "ahead of" : "behind"} the typical episode.`,
      recommendation: ahead
        ? `This topic/format is landing. Note what's different about it and repeat that on the next episode.`
        : `If this episode deserves a push, push now — gains concentrate in the first weeks and the gap won't close on its own.`,
      caveat: `Pace compares YouTube views only at matching ages (X plays have no history to compare); median of ${pace.peers.length} prior episode${pace.peers.length === 1 ? "" : "s"}.`,
      chartState: state({ chart: "standings", solo: pace.newest.slug }),
    });
  } else if (pace) {
    insights.push({
      id: "pace-rank",
      text: `${shortTitle(pace.newest.title)} has ${num(pace.newest.latest.totalViews)} total views so far (${num(pace.newest.latest.ytTotal)} YouTube + ${num(pace.newest.latest.xPlays ?? 0)} X plays). Too early to compare — no prior episode has data this young.`,
      recommendation: `Nothing to decide yet. The first same-age comparison appears automatically as snapshots age.`,
      caveat: `Same-age pace math needs a prior episode with a snapshot at this age.`,
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
  const phasePool = full.filter((e) => e.ageDays >= 7);
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
  const splitPool = dive.filter((e) => !e.metrics.anomaly);
  let ridd = 0, tom = 0;
  for (const e of splitPool) {
    ridd += e.latest.byDest["x:ridd_design"]?.views || 0;
    tom += e.latest.byDest["x:designertom"]?.views || 0;
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
  const withPlays = dive.filter((e) => e.latest.xPlays != null && !e.latest.xPlaysInfo?.partial);
  if (withPlays.length >= 3) {
    const plays = withPlays.reduce((a, e) => a + e.latest.xPlays, 0);
    const views = withPlays.reduce((a, e) => a + e.latest.totalViews, 0);
    const shares = withPlays.map((e) => ({ e, s: e.latest.xPlays / e.latest.totalViews })).sort((a, b) => b.s - a.s);
    insights.push({
      id: "watch-split",
      text: `This is a genuinely two-platform show: ${Math.round((plays / views) * 100)}% of all actual watching happens on X broadcasts (${num(plays)} of ${num(views)} total views), not just YouTube with an X echo.`,
      recommendation: `Give X broadcasts first-class treatment — real titles, thumbnails, and call-outs, not simulcast leftovers.`,
      caveat: `Per-episode X share ranges ${Math.round(shares[shares.length - 1].s * 100)}% (${refOf(shares[shares.length - 1].e)}) to ${Math.round(shares[0].s * 100)}% (${refOf(shares[0].e)}); episodes with full plays coverage only (${withPlays.length}).`,
      chartState: state({ chart: "standings" }),
    });
  }

  // 4c. reach→watch conversion on X (plays per announce impression — a
  // within-platform ratio, the legitimate way to relate the two X units).
  // Episodes under 7 days old are excluded: early reach spikes bias the
  // ratio low before plays accumulate.
  const convPool = withPlays.filter((e) => e.ageDays >= 7 && e.latest.xImpressions > 0);
  if (convPool.length >= 3) {
    const ranked = convPool.map((e) => ({ e, r: e.latest.xPlays / e.latest.xImpressions })).sort((a, b) => b.r - a.r);
    const hi = ranked[0], lo = ranked[ranked.length - 1];
    insights.push({
      id: "reach-conversion",
      text: `Announce hooks close very differently: ${refOf(hi.e)} turned ${Math.round(hi.r * 100)} of every 100 announce impressions into actual plays; ${refOf(lo.e)} managed only ${Math.round(lo.r * 100)}.`,
      recommendation: `Reuse ${refOf(hi.e)}'s announce format — its hook converted ${Math.max(2, Math.round(hi.r / Math.max(lo.r, 0.001)))}× better. High reach with low conversion means the post traveled but didn't sell the click.`,
      caveat: `X-only ratio (broadcast plays per announce impression); ≥7-day-old episodes, sample of ${ranked.length}.`,
      chartState: state({ chart: "standings" }),
    });
  }

  // 4d. host broadcast split — real watches per host's broadcast (plays),
  // the watch-side complement to the reach-based host split above
  {
    let riddP = 0, tomP = 0, n = 0;
    for (const e of withPlays) {
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
        caveat: `Episodes where both hosts' plays are known (${n}).`,
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
        caveat: `Outlier = more than double the typical episode on that unit; excluded from host-split aggregates automatically.`,
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
      caveat: `YouTube only; ≥7-day-old episodes (engagement ratios drift with age), sample of ${eng.length}.`,
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
      text: `${codeList} ${partial.length === 1 ? "was" : "were"} registered late — ${partial.length === 1 ? "its" : "their"} early weekly history doesn't exist. Totals are right; week-1 and velocity comparisons aren't.`,
      recommendation: `Nothing to do — the flags are automatic. Just don't read week-1 or velocity comparisons for these episodes.`,
      caveat: `Tracked late: ${partial.map((e) => refOf(e)).join(", ")}. Marked "tracked late" in the episode panel.`,
      chartState: state({}),
    });
  }

  return insights;
}

// --- Slack trends block (used by postlive-track.mjs report --trends) ---

export function trendsText(data) {
  const CAT_LABEL = { content: "Content", distribution: "Distribution", promotion: "Promotion", audience: "Audience health", data: "Data note" };
  const lines = ["", "Trends"];
  for (const i of data.insights) {
    lines.push(`• [${CAT_LABEL[i.category] ?? "Note"}] ${i.text}`);
    if (i.recommendation) lines.push(`   ↳ ${i.recommendation}`);
  }
  if (data.insights.length === 0) lines.push("• Not enough data for trend calls yet.");
  const vels = data.showTrend.week1VelocityByEpisode.filter((v) => v.value !== null);
  if (vels.length >= 2) {
    const dir = vels[vels.length - 1].value >= vels[0].value ? "up" : "down";
    lines.push(
      `• Week-1 velocity in air order: ${vels.map((v) => `${v.premiere.slice(5)} ${num(v.value)}`).join(" → ")} — trending ${dir} (sample of ${vels.length}).`
    );
  }
  // W9: newest episode's rating, read from the same store as every dashboard surface
  const newest = data.episodes[data.episodes.length - 1];
  const r = newest?.rating;
  if (r && r.rank != null) {
    const missing = r.coverage?.missingPillars || [];
    const basis = missing.length
      ? ` — basis excludes ${missing.map((m) => m.replace(/ \(.*\)$/, "")).join(", ")}`
      : "";
    const prov = r.provisional
      ? ` (provisional; freezes ${new Date(premiereMs(newest.premiere) + 7 * DAY).toISOString().slice(5, 10).replace("-", "/")} when week 1 completes)`
      : "";
    lines.push(`• Rating: ${shortTitle(newest.title)} ranks #${r.rank} of ${r.n} against the most recent episodes as of its air date${prov}${basis}.`);
  }
  return lines.join("\n");
}

// --- main ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const data = computeAll();
  // "<" escaped in the JSON so a "</script>" inside user comment text can
  // never break out of a script context, even if the data is ever inlined
  // into HTML (critic F-C9a). Valid JSON either way; byte-identical between
  // data.json and data.js so the validator's byte-match stays meaningful.
  const json = JSON.stringify(data, null, 1).replace(/</g, "\\u003c");
  // artifacts live at the repo root — the same directory Vercel serves
  writeFileSync(join(ROOT, "data.json"), json);
  writeFileSync(join(ROOT, "data.js"), `window.DIVE_DATA = ${json};\n`);
  const dive = data.episodes.filter((e) => e.show === "dive-radio");
  console.log(
    `dive-analytics: wrote data.json + data.js — ${data.episodes.length} episodes (${dive.length} dive-radio), ${data.insights.length} insights, generated ${data.generatedAt}`
  );
}
