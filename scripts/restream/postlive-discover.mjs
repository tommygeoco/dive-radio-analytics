#!/usr/bin/env node
// postlive-discover.mjs — find new Dive Radio episodes published in the last
// N days (default 10) and register them in the postlive registry across all
// 4 destinations. Closes the gap that let E3–E5 go untracked: the snapshot
// cron only reads the registry; nothing was writing new episodes into it.
//
// Sources:
//   YouTube — uploads playlists of joindiveclub + DesignerTom, title ^Dive Radio
//   X       — recent posts from @ridd_design + @designertom that mention
//             "dive radio" or link a discovered/registered episode video
//
// Registration is delegated to postlive-track.mjs register (subprocess), so
// slug/merge behavior stays in one place. Idempotent: already-registered
// video IDs and post IDs are skipped; re-running is safe.
//
// Usage: node scripts/restream/postlive-discover.mjs [--days 10] [--dry-run]
// Zero-model, deterministic. Exits 0 with "no new episodes" when idle.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const TRACK = join(HERE, "postlive-track.mjs");
const XURL_BIN = "/opt/homebrew/bin/xurl";

const YT_CHANNELS = [
  { account: "joindiveclub", uploads: "UUkCnraWwlnBw1_i7C9-3p0w" },
  { account: "designertom", uploads: "UU4_qP33t3TGpEM0-96WfC6Q" },
];
const X_ACCOUNTS = ["ridd_design", "designertom"];
const TITLE_RE = /dive\s*radio/i; // anywhere in title — channels are curated, prefix requirement was brittle

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const LOOKBACK_DAYS = daysIdx > -1 ? Number(args[daysIdx + 1]) : 10;
const since = Date.now() - LOOKBACK_DAYS * 86400000;

function ytApiKey() {
  const creds = JSON.parse(
    readFileSync(join(homedir(), ".openclaw", "secrets", "youtube-credentials.json"), "utf8")
  );
  const key = creds.youtube_api_key || creds.api_key;
  if (!key) throw new Error("no youtube api key in secrets");
  return key;
}

function xBearer() {
  const out = execFileSync(XURL_BIN, ["token", "--app", "hinterlands"], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` },
  });
  const token = out.trim().split("\n").pop();
  if (!token) throw new Error("xurl token returned empty output");
  return token;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") || 10) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
    return getJson(url, headers);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`GET ${url.split("?")[0]} -> HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export function phxDate(iso) {
  return new Date(Date.parse(iso) - 7 * 3600000).toISOString().slice(0, 10);
}

// Live uploads often enter the uploads playlist before they air. Their episode
// day comes from the broadcast clock, not the playlist publication clock.
export function episodeDateForVideo(video) {
  const live = video?.liveStreamingDetails;
  const broadcastState = video?.snippet?.liveBroadcastContent;
  const isLiveUpload = live != null || broadcastState === "upcoming" || broadcastState === "live";
  if (isLiveUpload) {
    const startsAt = live?.actualStartTime || live?.scheduledStartTime;
    return startsAt ? phxDate(startsAt) : null;
  }
  return video?.snippet?.publishedAt ? phxDate(video.snippet.publishedAt) : null;
}

// --- load registry state for idempotency ---
const registry = existsSync(REGISTRY_PATH)
  ? JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
  : { shows: [] };
const knownVideoIds = new Set();
const knownPostIds = new Set();
for (const s of registry.shows) {
  for (const t of s.targets || []) {
    if (t.videoId) knownVideoIds.add(t.videoId);
    if (t.postId) knownPostIds.add(t.postId);
  }
}

// --- 1. YouTube: new Dive Radio uploads ---
async function discoverYouTube() {
  const key = ytApiKey();
  const found = []; // { videoId, title, publishedAt, date, account }
  for (const ch of YT_CHANNELS) {
    const playlist = await getJson(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${ch.uploads}&maxResults=15&key=${key}`
    );
    const candidates = [];
    for (const item of playlist.items || []) {
      const sn = item.snippet || {};
      const vid = sn.resourceId?.videoId;
      if (!vid || knownVideoIds.has(vid)) continue;
      if (!TITLE_RE.test(sn.title || "")) continue;
      if (Date.parse(sn.publishedAt) < since) continue;
      candidates.push({ videoId: vid, playlistSnippet: sn });
    }
    if (!candidates.length) continue;
    const details = await getJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${candidates.map((v) => v.videoId).join(",")}&key=${key}`
    );
    const byId = new Map((details.items || []).map((video) => [video.id, video]));
    for (const candidate of candidates) {
      const video = byId.get(candidate.videoId);
      if (!video) {
        console.log(`WARN discover: YouTube video ${candidate.videoId} returned no details — skipping`);
        continue;
      }
      const date = episodeDateForVideo(video);
      if (!date) {
        console.log(`WARN discover: live YouTube video ${candidate.videoId} has no start time — skipping`);
        continue;
      }
      const sn = video.snippet || candidate.playlistSnippet;
      found.push({
        videoId: candidate.videoId,
        title: sn.title,
        publishedAt: sn.publishedAt,
        date,
        account: ch.account,
        url: `https://www.youtube.com/watch?v=${candidate.videoId}`,
      });
    }
  }
  return found;
}

// --- 2. X: recent announce posts from both hosts ---
async function discoverX(episodeVideoIds) {
  const bearer = xBearer();
  const headers = { Authorization: `Bearer ${bearer}` };
  const found = []; // { postId, account, createdAt, date, text, linkedVideoId }
  const allEpisodeIds = new Set([...episodeVideoIds, ...knownVideoIds]);
  for (const account of X_ACCOUNTS) {
    let user;
    try {
      user = await getJson(`https://api.x.com/2/users/by/username/${account}`, headers);
    } catch (err) {
      console.error(`discover: X user lookup failed for ${account}: ${err.message}`);
      continue;
    }
    const uid = user.data?.id;
    if (!uid) continue;
    let tl;
    try {
      // include replies: hosts sometimes announce inside threads. Chatter is
      // filtered downstream (must mention dive radio or link a known episode).
      tl = await getJson(
        `https://api.x.com/2/users/${uid}/tweets?max_results=50&exclude=retweets&tweet.fields=created_at,entities,text`,
        headers
      );
    } catch (err) {
      console.error(`discover: X timeline failed for ${account}: ${err.message}`);
      continue;
    }
    for (const t of tl.data || []) {
      if (knownPostIds.has(t.id)) continue;
      if (Date.parse(t.created_at) < since) continue;
      const urls = (t.entities?.urls || []).map((u) => u.expanded_url || u.url || "");
      let linkedVideoId = null;
      for (const u of urls) {
        const m = u.match(/(?:youtube\.com\/(?:watch\?v=|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
        if (m && allEpisodeIds.has(m[1])) { linkedVideoId = m[1]; break; }
      }
      const mentions = /dive\s*radio/i.test(t.text || "");
      if (!linkedVideoId && !mentions) continue;
      found.push({
        postId: t.id,
        account,
        createdAt: t.created_at,
        date: phxDate(t.created_at),
        linkedVideoId,
        url: `https://x.com/${account}/status/${t.id}`,
      });
    }
  }
  return found;
}

// --- 3. group into episodes and register ---
function daysBetween(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
}

async function main() {
  const ytFound = await discoverYouTube();
  const xFound = await discoverX(new Set(ytFound.map((v) => v.videoId)));

  // staleness tripwire: the show is weekly — if nothing new was found AND the
  // newest registered episode is older than 9 days, say so loudly so the
  // Monday announce carries the warning instead of silently looking healthy.
  if (!ytFound.length) {
    const newest = registry.shows
      .filter((s) => s.active !== false)
      .map((s) => s.date)
      .sort()
      .pop();
    const ageDays = newest ? Math.floor((Date.now() - Date.parse(newest)) / 86400000) : null;
    if (ageDays !== null && ageDays > 9) {
      console.log(
        `⚠️ discover: no new episode found and the newest registered episode (${newest}) is ${ageDays} days old — weekly cadence implies one is missing. Check YT uploads + X manually.`
      );
    }
  }

  if (!ytFound.length && !xFound.length) {
    console.log(`discover: no new Dive Radio destinations in the last ${LOOKBACK_DAYS} days.`);
    return;
  }

  // group new YT videos by Phoenix publish date => episode
  const byDate = new Map();
  for (const v of ytFound) {
    if (!byDate.has(v.date)) byDate.set(v.date, []);
    byDate.get(v.date).push(v);
  }

  const registrations = []; // { title, date, urls, why }

  for (const [date, vids] of byDate) {
    // prefer the joindiveclub title as canonical
    const canon = vids.find((v) => v.account === "joindiveclub") || vids[0];
    const urls = vids.map((v) => v.url);
    // attach X posts that link one of these videos, or mention dive radio within 3 days
    for (const p of xFound) {
      if (p.claimed) continue;
      const links = p.linkedVideoId && vids.some((v) => v.videoId === p.linkedVideoId);
      const near = !p.linkedVideoId && daysBetween(p.date, date) <= 3;
      if (links || near) { p.claimed = true; urls.push(p.url); }
    }
    registrations.push({ title: canon.title, date, urls, why: `new episode (${vids.length} YT, ${urls.length - vids.length} X)` });
  }

  // leftover X posts that link an ALREADY-registered episode => merge into that show
  for (const p of xFound) {
    if (p.claimed) continue;
    if (!p.linkedVideoId) {
      console.log(`discover: skipping X post ${p.url} — mentions Dive Radio but matches no episode within 3 days`);
      continue;
    }
    const show = registry.shows.find((s) => (s.targets || []).some((t) => t.videoId === p.linkedVideoId));
    if (!show) continue;
    registrations.push({ title: show.title, date: show.date, urls: [p.url], why: `late X announce for ${show.slug}` });
    p.claimed = true;
  }

  for (const r of registrations) {
    console.log(`discover: registering "${r.title}" (${r.date}) — ${r.why}`);
    for (const u of r.urls) console.log(`  + ${u}`);
    if (dryRun) continue;
    execFileSync(process.execPath, [TRACK, "register", "--title", r.title, "--date", r.date, ...r.urls], {
      stdio: "inherit",
      cwd: ROOT,
      timeout: 120000,
    });
  }
  if (dryRun) console.log("discover: dry run — nothing written.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`discover: ${err.message}\n`);
    process.exit(1);
  });
}
