#!/usr/bin/env node
// yt-analytics-pull.mjs — owner-level YouTube Analytics per episode video.
// (PRD v2 W7, 2026-08-22.) Public APIs say how many watched; this says how
// long they stayed, where they came from, and how many subscribed.
//
// Auth: OAuth per channel OWNER (channel-scoped tokens):
//   ~/.openclaw/secrets/youtube-oauth-token.json           -> designertom (Tommy, live since May)
//   ~/.openclaw/secrets/youtube-oauth-token-diveclub.json  -> joindiveclub (Ridd; created when his code lands)
// Every registered YouTube target must have its owner token. A missing or
// rejected token stops the pull; one channel can never stand in for two.
//
// Pulled per episode video (lifetime, premiere → today):
//   views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage,
//   subscribersGained, likes, comments + traffic-source breakdown + retention
//   curve (elapsedVideoTimeRatio → audienceWatchRatio).
// Store: data/restream/yt-analytics/<slug>.json — one episode cohort whose
// registered channel blocks share a pulledAt stamp. A pull is staged first and
// replaces the cohort only when every registered channel is usable in that same
// pull. Nothing here is a high-water guess and partial pulls never mix dates.
//
// History (PRD v9 W22a): data/restream/yt-analytics-history/<slug>.jsonl —
// one line per episode per Phoenix day, appended only after a pull in which
// every authorized channel for that episode succeeded; skipped when a line
// for that date exists. A successful response with no totals or no positive
// view count is also skipped, so it cannot reserve that day's reading; lines are never rewritten (a
// YouTube restatement shows up as the next day's line). This is what makes share watched and subscribers
// age-pinnable later. No backfill: history starts the day this shipped.
//
// Exit 0 on success. Exit 20 only when the newest episode's reports are the
// sole missing data after its Phoenix air date; run-chain publishes the other
// current data and run-daily records a noon retry. Exit 1 for a real
// request/auth failure or an older episode losing its report.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  missingYoutubeAccounts,
  usableYoutubeWatchTotals,
  YOUTUBE_WATCH_PENDING_EXIT,
  youtubeChannelsFingerprint,
  youtubeCohortAfterPull,
  youtubePullExitCode,
  youtubeWatchProbe,
  youtubeWatchReport,
} from "../../tools/dive-analytics/youtube-readiness.mjs";
import { atomicWriteJson, atomicWriteText, withSourceLock, fetchJson, readingEnvelope, validateReadingEnvelope } from "../../tools/dive-analytics/source-io.mjs";
import { acquireLock } from "../../tools/dive-analytics/alert-queue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const OUT_DIR = join(ROOT, "data", "restream", "yt-analytics");
export const HISTORY_DIR = join(ROOT, "data", "restream", "yt-analytics-history");
const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
const SECRETS = join(homedir(), ".openclaw", "secrets");

const CHANNEL_TOKENS = {
  designertom: { tokenFile: "youtube-oauth-token.json", channelId: "UC4_qP33t3TGpEM0-96WfC6Q" },
  joindiveclub: { tokenFile: "youtube-oauth-token-diveclub.json", channelId: "UCkCnraWwlnBw1_i7C9-3p0w" },
};

function clientCreds() {
  const c = JSON.parse(readFileSync(join(SECRETS, "youtube-oauth-client.json"), "utf8"));
  return c.installed || c.web;
}
async function accessToken(tokenFile) {
  const path = join(SECRETS, tokenFile);
  if (!existsSync(path)) return null; // not authorized yet — skip, never fake
  const t = JSON.parse(readFileSync(path, "utf8"));
  const { client_id, client_secret } = clientCreds();
  const body = new URLSearchParams({ client_id, client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" });
  const j = await fetchJson("https://oauth2.googleapis.com/token", { method: "POST", body, label: "YouTube owner token refresh" });
  if (typeof j.access_token !== "string" || !j.access_token) throw new Error("YouTube owner token refresh returned no token");
  return j.access_token;
}
async function query(token, params) {
  const url = "https://youtubeanalytics.googleapis.com/v2/reports?" + new URLSearchParams({ ids: "channel==MINE", ...params });
  return fetchJson(url, { headers: { Authorization: `Bearer ${token}` }, label: "YouTube Analytics report" });
}
export function rowsToObjects(report, required = []) {
  if (!Array.isArray(report?.columnHeaders) || !report.columnHeaders.length) throw new Error("YouTube report has no column schema");
  const cols = report.columnHeaders.map(h => h?.name);
  if (cols.some(c => typeof c !== "string") || new Set(cols).size !== cols.length || required.some(c => !cols.includes(c))) throw new Error("YouTube report has incomplete column schema");
  if (report.rows != null && !Array.isArray(report.rows)) throw new Error("YouTube report rows are malformed");
  return (report.rows || []).map(row => {
    if (!Array.isArray(row) || row.length !== cols.length) throw new Error("YouTube report row is incomplete");
    return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
  });
}
export function phoenixDate(iso) {
  return new Date(Date.parse(iso) - PHX_OFFSET).toISOString().slice(0, 10);
}
function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET;
}
// One history line from a freshly pulled store. Pure; exported for the test.
export function historyLine({ slug, premiere, pulledAt, endDate, channels }) {
  const out = {};
  for (const [key, ch] of Object.entries(channels || {})) {
    const t = ch?.totals;
    if (!t) continue;
    out[key] = {
      ...(ch.videoId ? { videoId: ch.videoId, pulledAt: ch.pulledAt || pulledAt,
        ...(slug ? { reading: readingEnvelope({ source: "youtube-analytics", episode: slug, objectId: ch.videoId, pulledAt: ch.pulledAt || pulledAt }) } : {}) } : {}),
      views: t.views ?? null,
      averageViewPercentage: t.averageViewPercentage ?? null,
      averageViewDuration: t.averageViewDuration ?? null,
      estimatedMinutesWatched: t.estimatedMinutesWatched ?? null,
      subscribersGained: t.subscribersGained ?? null,
      likes: t.likes ?? null,
      comments: t.comments ?? null,
    };
  }
  return {
    ...(slug ? { reading: readingEnvelope({ source: "youtube-analytics", episode: slug, objectId: slug, pulledAt }) } : {}),
    date: phoenixDate(pulledAt),
    pulledAt,
    endDate,
    ageDays: Math.round(((Date.parse(pulledAt) - premiereMs(premiere)) / DAY) * 10) / 10,
    channels: out,
  };
}
export function readHistory(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
// Append-only, one line per Phoenix date; returns false when that date exists.
export function appendHistoryLine(path, line, { expectedChannels = [], premiere = null } = {}) {
  if (!line?.reading) return false;
  {
    if (validateReadingEnvelope(line.reading, { source: "youtube-analytics", now: Date.now() }).length || line.reading.state !== "ready" || line.reading.pulledAt !== line.pulledAt || line.date !== phoenixDate(line.pulledAt) || line.endDate !== line.date) return false;
    if (Object.values(line.channels || {}).some(c => c.pulledAt !== line.pulledAt || validateReadingEnvelope(c.reading, { source: "youtube-analytics", episode: line.reading.episode, objectId: c.videoId }).length)) return false;
  }
  if (!line?.channels || !Object.keys(line.channels).length) return false;
  const storedChannels = Object.keys(line.channels);
  if (!expectedChannels.length
    || storedChannels.length !== expectedChannels.length
    || storedChannels.some((key) => !expectedChannels.includes(key))) return false;
  if (expectedChannels.some((key) => !Number.isFinite(line.channels[key]?.views)
    || line.channels[key].views <= 0
    || !Number.isFinite(line.channels[key]?.averageViewPercentage))) return false;
  if (!Number.isFinite(line.ageDays) || line.ageDays < 0) return false;
  if (premiere && (typeof line.date !== "string" || line.date <= premiere)) return false;
  mkdirSync(dirname(path), { recursive: true });
  // Keep the crash-recovery lock ignored by Git so an interrupted manual pull
  // cannot make the next publisher preflight reject its own checkout.
  const release = acquireLock(`${path}.lock.tmp`, { label: "YouTube watch history" });
  try {
    const lines = readHistory(path);
    if (lines.some((l) => l.date === line.date)) return false;
    const next = (lines.length ? readFileSync(path, "utf8").replace(/\n?$/, "\n") : "") + JSON.stringify(line) + "\n";
    atomicWriteText(path, next);
    return true;
  } finally {
    release();
  }
}
export function syncAnalyticsMetadata(store, show) {
  const changed = store.title !== show.title || store.premiere !== show.date;
  store.title = show.title;
  store.premiere = show.date;
  return changed;
}
const saveAtomic = atomicWriteJson;

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const shows = registry.shows.filter((s) => s.active !== false && /dive-radio/.test(s.slug));
  const now = new Date().toISOString();
  const today = phoenixDate(now);
  const dueShows = shows.filter((show) => typeof show.date === "string" && show.date <= today);

  const tokens = {};
  const warns = [];
  for (const [account, cfg] of Object.entries(CHANNEL_TOKENS)) {
    try {
      tokens[account] = await accessToken(cfg.tokenFile);
      if (tokens[account]) {
        const owner = await fetchJson("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", { label: "YouTube owner identity", headers: { Authorization: `Bearer ${tokens[account]}` } });
        if (owner.items?.length !== 1 || owner.items[0].id !== cfg.channelId) throw new Error(`YouTube owner identity does not match ${account}`);
      }
    }
    catch { tokens[account] = null; warns.push(`YouTube owner authorization failed for ${account}`); }
  }
  const authorized = Object.entries(tokens).filter(([, t]) => t).map(([a]) => a);
  if (!authorized.length) throw new Error(`no authorized YouTube channels — ${warns.join("; ")}`);
  const missingAccounts = missingYoutubeAccounts(dueShows, tokens);
  if (missingAccounts.length) {
    console.error(`yt-analytics: missing owner access for ${missingAccounts.join(", ")} — no one-channel report was published`);
    throw new Error("YouTube owner access incomplete");
  }

  let pulled = 0, failed = 0, appended = 0;
  const missingTotals = [];
  for (const show of dueShows) {
    const path = join(OUT_DIR, `${show.slug}.json`);
    let store = { slug: show.slug, title: show.title, premiere: show.date, channels: {} };
    if (existsSync(path)) {
      try { store = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`YouTube store unreadable for ${show.slug}`); }
    }
    const previousStore = structuredClone(store);
    let changed = syncAnalyticsMetadata(store, show);
    const showRequestFailures = [];
    const expectedTargets = (show.targets || [])
      .filter((target) => target.kind === "youtube" && target.videoId && tokens[target.account])
      .map((target) => ({ key: `yt:${target.account}`, videoId: target.videoId }));
    const candidateChannels = Object.fromEntries(expectedTargets.map(({ key, videoId }) => [key, {
      videoId,
      pulledAt: now,
      totals: null,
      trafficSources: [],
      retention: null,
    }]));
    const probesByKey = new Map(expectedTargets.map(({ key, videoId }) => [key, youtubeWatchProbe({ key, videoId, failed: true })]));
    for (const t of (show.targets || []).filter((target) => target.kind === "youtube" && target.videoId)) {
      const token = tokens[t.account];
      if (!token) continue; // unauthorized channel: absent, never zero
      const key = `yt:${t.account}`;
      try {
        const base = { startDate: show.date, endDate: today, filters: `video==${t.videoId}` };
        const totalsRep = await query(token, { ...base, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments" });
        const totalsRows = rowsToObjects(totalsRep, ["views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained", "likes", "comments"]);
        if (totalsRows.length > 1) throw new Error("YouTube totals report returned multiple ungrouped rows");
        const totals = totalsRows[0] || null;
        if (totals && Object.values(totals).some(v => !Number.isFinite(v) || v < 0)) throw new Error("YouTube totals contain invalid or negative metrics");
        const totalsProbe = youtubeWatchProbe({ key, videoId: t.videoId, totals });
        if (totalsProbe.result === "request-failed") {
          failed++;
          showRequestFailures.push(key);
          console.log(`WARN yt-analytics ${show.slug} ${t.account}: report returned a malformed watch row; history not advanced`);
        } else if (!usableYoutubeWatchTotals(totals)) {
          missingTotals.push({ slug: show.slug, channel: key });
          console.log(`WARN yt-analytics ${show.slug} ${t.account}: report returned no usable watch totals; history not advanced`);
        }
        const trafficRep = await query(token, { ...base, metrics: "views,estimatedMinutesWatched", dimensions: "insightTrafficSourceType", sort: "-views" });
        const traffic = rowsToObjects(trafficRep, ["insightTrafficSourceType", "views", "estimatedMinutesWatched"]);
        if (traffic.some(r => typeof r.insightTrafficSourceType !== "string" || !r.insightTrafficSourceType || [r.views, r.estimatedMinutesWatched].some(v => !Number.isFinite(v) || v < 0))) throw new Error("YouTube traffic report contains invalid rows");
        let retention = null;
        let requestFailed = totalsProbe.result === "request-failed";
        try {
          const r = await query(token, { ...base, metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio" });
          retention = rowsToObjects(r, ["elapsedVideoTimeRatio", "audienceWatchRatio"]);
          if (retention.some(v => !Number.isFinite(v.elapsedVideoTimeRatio) || v.elapsedVideoTimeRatio < 0 || v.elapsedVideoTimeRatio > 1 || !Number.isFinite(v.audienceWatchRatio) || v.audienceWatchRatio < 0)) throw new Error("YouTube retention report contains invalid rows");
        } catch (e) {
          failed++;
          requestFailed = true;
          showRequestFailures.push(key);
          console.log(`WARN yt-analytics ${show.slug} ${t.account}: retention request failed (${e.message.slice(0, 80)})`);
        }
        candidateChannels[key] = {
          videoId: t.videoId,
          pulledAt: now,
          reading: readingEnvelope({ source: "youtube-analytics", episode: show.slug, objectId: t.videoId, pulledAt: now, state: usableYoutubeWatchTotals(totals) ? "ready" : "pending" }),
          totals: totals ?? null,
          trafficSources: traffic,
          retention,
        };
        probesByKey.set(key, requestFailed
          ? youtubeWatchProbe({ key, videoId: t.videoId, failed: true })
          : totalsProbe);
        changed = true; pulled++;
      } catch (e) {
        failed++;
        showRequestFailures.push(key);
        probesByKey.set(key, youtubeWatchProbe({ key, videoId: t.videoId, failed: true }));
        console.log(`WARN yt-analytics ${show.slug} ${t.account}: ${e.message.slice(0, 140)}`);
      }
    }
    if (expectedTargets.length) {
      const cohort = youtubeCohortAfterPull({
        previousStore,
        expectedTargets,
        candidateChannels,
        checkedAt: now,
        acceptCandidate: showRequestFailures.length === 0,
      });
      store.channels = cohort.channels;
      if (cohort.advanced) store.reading = readingEnvelope({ source: "youtube-analytics", episode: show.slug, objectId: show.slug, pulledAt: now });
      if (cohort.updatedAt) store.updatedAt = cohort.updatedAt;
      else delete store.updatedAt;
      store.watchReport = youtubeWatchReport({
        checkedAt: now,
        airDate: show.date,
        probes: expectedTargets.map(({ key }) => probesByKey.get(key)),
        previous: previousStore.watchReport,
        previousTargetFingerprint: youtubeChannelsFingerprint(previousStore.channels),
      });
      changed = true;
      // history line only when every authorized channel for this episode
      // formed the newly staged cohort — preserved old data is never a new read
      if (cohort.advanced) {
        const line = historyLine({ slug: show.slug, premiere: show.date, pulledAt: now, endDate: today, channels: candidateChannels });
        const expectedChannels = expectedTargets.map(({ key }) => key);
        if (appendHistoryLine(join(HISTORY_DIR, `${show.slug}.jsonl`), line, { expectedChannels, premiere: show.date })) appended++;
      }
    }
    if (changed) saveAtomic(path, store);
  }
  console.log(`yt-analytics: pulled ${pulled} video report(s) across ${dueShows.length} due episode(s); ${appended} history line(s) appended; authorized: ${authorized.join(", ")}${failed ? ` — ${failed} failure(s)` : ""}${warns.length ? ` — WARN ${warns.join("; ")}` : ""}`);
  const exitCode = youtubePullExitCode({
    shows,
    missingTotals,
    hardFailures: failed + warns.length,
    now,
  });
  if (exitCode === YOUTUBE_WATCH_PENDING_EXIT) {
    console.log("yt-analytics: newest episode watch data is not ready yet; the morning build can publish and noon will try the whole chain once more");
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  withSourceLock(OUT_DIR, main).catch((err) => {
    process.stderr.write(`yt-analytics: ${err.message}\n`);
    process.exit(1);
  });
}
