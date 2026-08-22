#!/usr/bin/env node
// yt-analytics-pull.mjs — owner-level YouTube Analytics per episode video.
// (PRD v2 W7, 2026-08-22.) Public APIs say how many watched; this says how
// long they stayed, where they came from, and how many subscribed.
//
// Auth: OAuth per channel OWNER (channel-scoped tokens):
//   ~/.openclaw/secrets/youtube-oauth-token.json           -> designertom (Tommy, live since May)
//   ~/.openclaw/secrets/youtube-oauth-token-diveclub.json  -> joindiveclub (Ridd; created when his code lands)
// A channel with no token file is SKIPPED and marked absent — absence ≠ zero.
//
// Pulled per episode video (lifetime, premiere → today):
//   views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage,
//   subscribersGained, likes, comments + traffic-source breakdown + retention
//   curve (elapsedVideoTimeRatio → audienceWatchRatio).
// Store: data/restream/yt-analytics/<slug>.json — one block per channel with
// pulledAt stamp; overwritten per pull (the Analytics API is the source of
// truth for its own aggregates; nothing here is a high-water guess).
//
// Exit 0 on success or partial (WARN lines); 1 when every authorized channel fails.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const OUT_DIR = join(ROOT, "data", "restream", "yt-analytics");
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
function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const shows = registry.shows.filter((s) => s.active !== false && /dive-radio/.test(s.slug));
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const tokens = {};
  const warns = [];
  for (const [account, cfg] of Object.entries(CHANNEL_TOKENS)) {
    try { tokens[account] = await accessToken(cfg.tokenFile); }
    catch (e) { tokens[account] = null; warns.push(e.message.slice(0, 120)); }
  }
  const authorized = Object.entries(tokens).filter(([, t]) => t).map(([a]) => a);
  if (!authorized.length) { console.error(`yt-analytics: no authorized channels — ${warns.join("; ")}`); process.exit(1); }

  let pulled = 0, failed = 0;
  for (const show of shows) {
    const path = join(OUT_DIR, `${show.slug}.json`);
    let store = { slug: show.slug, title: show.title, premiere: show.date, channels: {} };
    if (existsSync(path)) {
      try { store = JSON.parse(readFileSync(path, "utf8")); }
      catch (e) { console.log(`WARN yt-analytics ${show.slug}: store unreadable — skipping show (${e.message.slice(0, 60)})`); continue; }
    }
    let changed = false;
    for (const t of (show.targets || []).filter((t) => t.kind === "youtube" && t.videoId)) {
      const token = tokens[t.account];
      if (!token) continue; // unauthorized channel: absent, never zero
      try {
        const base = { startDate: show.date, endDate: today, filters: `video==${t.videoId}` };
        const totalsRep = await query(token, { ...base, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments" });
        const totals = rowsToObjects(totalsRep)[0] || null;
        const trafficRep = await query(token, { ...base, metrics: "views,estimatedMinutesWatched", dimensions: "insightTrafficSourceType", sort: "-views" });
        const traffic = rowsToObjects(trafficRep);
        let retention = null;
        try {
          const r = await query(token, { ...base, metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio" });
          retention = rowsToObjects(r);
        } catch (e) { console.log(`WARN yt-analytics ${show.slug} ${t.account}: retention unavailable (${e.message.slice(0, 80)})`); }
        store.channels[`yt:${t.account}`] = { videoId: t.videoId, pulledAt: now, totals, trafficSources: traffic, retention };
        changed = true; pulled++;
      } catch (e) { failed++; console.log(`WARN yt-analytics ${show.slug} ${t.account}: ${e.message.slice(0, 140)}`); }
    }
    if (changed) { store.updatedAt = now; saveAtomic(path, store); }
  }
  console.log(`yt-analytics: pulled ${pulled} video report(s) across ${shows.length} episode(s); authorized: ${authorized.join(", ")}${failed ? ` — ${failed} failure(s)` : ""}${warns.length ? ` — WARN ${warns.join("; ")}` : ""}`);
  if (pulled === 0 && failed > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`yt-analytics: ${err.message}\n`);
  process.exit(1);
});
