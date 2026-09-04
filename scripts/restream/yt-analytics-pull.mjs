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
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(30000) });
  const j = await res.json();
  if (!j.access_token) throw new Error(`token refresh failed (${tokenFile}): ${j.error ?? res.status}`);
  return j.access_token;
}
async function query(token, params) {
  const url = "https://youtubeanalytics.googleapis.com/v2/reports?" + new URLSearchParams({ ids: "channel==MINE", ...params });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`analytics ${params.metrics ?? ""} -> HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return res.json();
}
function rowsToObjects(report) {
  const cols = (report.columnHeaders || []).map((h) => h.name);
  return (report.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}
export function phoenixDate(iso) {
  return new Date(Date.parse(iso) - PHX_OFFSET).toISOString().slice(0, 10);
}
function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET;
}
// One history line from a freshly pulled store. Pure; exported for the test.
export function historyLine({ premiere, pulledAt, endDate, channels }) {
  const out = {};
  for (const [key, ch] of Object.entries(channels || {})) {
    const t = ch?.totals;
    if (!t) continue;
    out[key] = {
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
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
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
function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const shows = registry.shows.filter((s) => s.active !== false && /dive-radio/.test(s.slug));
  const now = new Date().toISOString();
  const today = phoenixDate(now);
  const dueShows = shows.filter((show) => typeof show.date === "string" && show.date <= today);

  const tokens = {};
  const warns = [];
  for (const [account, cfg] of Object.entries(CHANNEL_TOKENS)) {
    try { tokens[account] = await accessToken(cfg.tokenFile); }
    catch (e) { tokens[account] = null; warns.push(e.message.slice(0, 120)); }
  }
  const authorized = Object.entries(tokens).filter(([, t]) => t).map(([a]) => a);
  if (!authorized.length) { console.error(`yt-analytics: no authorized channels — ${warns.join("; ")}`); process.exit(1); }
  const missingAccounts = missingYoutubeAccounts(dueShows, tokens);
  if (missingAccounts.length) {
    console.error(`yt-analytics: missing owner access for ${missingAccounts.join(", ")} — no one-channel report was published`);
    process.exit(1);
  }

  let pulled = 0, failed = 0, appended = 0;
  const missingTotals = [];
  for (const show of dueShows) {
    const path = join(OUT_DIR, `${show.slug}.json`);
    let store = { slug: show.slug, title: show.title, premiere: show.date, channels: {} };
    if (existsSync(path)) {
      try { store = JSON.parse(readFileSync(path, "utf8")); }
      catch (e) { console.log(`WARN yt-analytics ${show.slug}: store unreadable — skipping show (${e.message.slice(0, 60)})`); continue; }
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
        const totals = rowsToObjects(totalsRep)[0] || null;
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
        const traffic = rowsToObjects(trafficRep);
        let retention = null;
        let requestFailed = totalsProbe.result === "request-failed";
        try {
          const r = await query(token, { ...base, metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio" });
          retention = rowsToObjects(r);
        } catch (e) {
          failed++;
          requestFailed = true;
          showRequestFailures.push(key);
          console.log(`WARN yt-analytics ${show.slug} ${t.account}: retention request failed (${e.message.slice(0, 80)})`);
        }
        candidateChannels[key] = {
          videoId: t.videoId,
          pulledAt: now,
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
        const line = historyLine({ premiere: show.date, pulledAt: now, endDate: today, channels: candidateChannels });
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
  if (exitCode !== 0) process.exit(exitCode);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`yt-analytics: ${err.message}\n`);
    process.exit(1);
  });
}
