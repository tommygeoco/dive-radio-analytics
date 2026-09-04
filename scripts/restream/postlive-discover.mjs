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
import {
  appendSourceReceipt,
  sourceAccountSummary,
  sourceStatus,
  X_ACCOUNTS as SOURCE_X_ACCOUNTS,
} from "./source-receipts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const TRACK = join(HERE, "postlive-track.mjs");
const XURL_BIN = "/opt/homebrew/bin/xurl";

const YT_CHANNELS = [
  { account: "joindiveclub", uploads: "UUkCnraWwlnBw1_i7C9-3p0w" },
  { account: "designertom", uploads: "UU4_qP33t3TGpEM0-96WfC6Q" },
];
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

export function broadcastIdFromUrls(urls = []) {
  for (const value of urls) {
    const match = String(value || "").match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([^/?#]+)/i);
    if (match) return match[1];
  }
  return null;
}

export function normalizedEpisodeTitle(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A late X broadcast may appear after YouTube has already registered the
// episode. Match an exact title first, then one same-day show. Anything
// ambiguous stays unregistered and loud rather than being guessed.
export function existingShowForXBroadcast(post, shows) {
  if (!post?.broadcastId) return null;
  const active = (shows || []).filter((show) => show.active !== false && (/dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug || "")));
  const postTitle = normalizedEpisodeTitle(post.text);
  const exact = active.filter((show) => normalizedEpisodeTitle(show.title) === postTitle);
  if (exact.length === 1) return exact[0];
  const sameDay = active.filter((show) => show.date === post.date);
  return sameDay.length === 1 ? sameDay[0] : null;
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
function errorText(err) {
  return String(err?.message || err || "unknown error").replace(/\s+/g, " ").slice(0, 240);
}

export async function discoverYouTube({ get = getJson, apiKey = null } = {}) {
  const found = []; // { videoId, title, publishedAt, date, account }
  const accounts = [];
  let key;
  try {
    key = apiKey || ytApiKey();
  } catch (err) {
    const error = errorText(err);
    return {
      found,
      accounts: YT_CHANNELS.map(({ account }) => ({ account, attempted: false, success: false, found: 0, error })),
    };
  }
  for (const ch of YT_CHANNELS) {
    const accountFound = [];
    try {
      const playlist = await get(
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
      if (candidates.length) {
        const details = await get(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${candidates.map((v) => v.videoId).join(",")}&key=${key}`
        );
        const byId = new Map((details.items || []).map((video) => [video.id, video]));
        for (const candidate of candidates) {
          const video = byId.get(candidate.videoId);
          if (!video) throw new Error(`video ${candidate.videoId} returned no details`);
          const date = episodeDateForVideo(video);
          if (!date) throw new Error(`live video ${candidate.videoId} has no start time`);
          const sn = video.snippet || candidate.playlistSnippet;
          accountFound.push({
            videoId: candidate.videoId,
            title: sn.title,
            publishedAt: sn.publishedAt,
            date,
            account: ch.account,
            url: `https://www.youtube.com/watch?v=${candidate.videoId}`,
          });
        }
      }
      found.push(...accountFound);
      accounts.push({ account: ch.account, attempted: true, success: true, found: accountFound.length, error: null });
    } catch (err) {
      accounts.push({ account: ch.account, attempted: true, success: false, found: 0, error: errorText(err) });
    }
  }
  return { found, accounts };
}

// --- 2. X: recent announce posts from both hosts ---
export async function discoverX(episodeVideoIds, { get = getJson, bearerToken = null } = {}) {
  let bearer;
  try {
    bearer = bearerToken || xBearer();
  } catch (err) {
    const error = errorText(err);
    return {
      found: [],
      accounts: SOURCE_X_ACCOUNTS.map((account) => ({ account, attempted: false, success: false, found: 0, error })),
    };
  }
  const headers = { Authorization: `Bearer ${bearer}` };
  const found = []; // { postId, account, createdAt, date, text, linkedVideoId, broadcastId }
  const accounts = [];
  const allEpisodeIds = new Set([...episodeVideoIds, ...knownVideoIds]);
  for (const account of SOURCE_X_ACCOUNTS) {
    let user;
    try {
      user = await get(`https://api.x.com/2/users/by/username/${account}`, headers);
    } catch (err) {
      console.error(`discover: X user lookup failed for ${account}: ${err.message}`);
      accounts.push({ account, attempted: true, success: false, found: 0, error: `user lookup: ${errorText(err)}` });
      continue;
    }
    const uid = user.data?.id;
    if (!uid) {
      accounts.push({ account, attempted: true, success: false, found: 0, error: "user lookup returned no id" });
      continue;
    }
    let tl;
    try {
      // include replies: hosts sometimes announce inside threads. Chatter is
      // filtered downstream (must mention dive radio or link a known episode).
      tl = await get(
        `https://api.x.com/2/users/${uid}/tweets?max_results=50&exclude=retweets&tweet.fields=created_at,entities,text`,
        headers
      );
    } catch (err) {
      console.error(`discover: X timeline failed for ${account}: ${err.message}`);
      accounts.push({ account, attempted: true, success: false, found: 0, error: `timeline: ${errorText(err)}` });
      continue;
    }
    if (!Array.isArray(tl.data) && Number(tl.meta?.result_count || 0) !== 0) {
      accounts.push({ account, attempted: true, success: false, found: 0, error: "timeline returned no post list" });
      continue;
    }
    const before = found.length;
    for (const t of tl.data || []) {
      if (knownPostIds.has(t.id)) continue;
      if (Date.parse(t.created_at) < since) continue;
      const urls = (t.entities?.urls || []).map((u) => u.expanded_url || u.url || "");
      const broadcastId = broadcastIdFromUrls(urls);
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
        text: t.text || "",
        linkedVideoId,
        broadcastId,
        url: `https://x.com/${account}/status/${t.id}`,
      });
    }
    accounts.push({ account, attempted: true, success: true, found: found.length - before, error: null });
  }
  return { found, accounts };
}

// --- 3. group into episodes and register ---
function daysBetween(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
}

async function main() {
  const startedAt = new Date().toISOString();
  const ytResult = await discoverYouTube();
  const ytFound = ytResult.found;
  const xResult = await discoverX(new Set(ytFound.map((v) => v.videoId)));
  const xFound = xResult.found;
  const sources = {
    youtube: sourceAccountSummary(ytResult.accounts),
    x: sourceAccountSummary(xResult.accounts),
  };

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
    const destinationAccounts = {
      youtube: [...new Set(vids.map((v) => v.account))],
      x: [],
    };
    // attach X posts that link one of these videos, or mention dive radio within 3 days
    for (const p of xFound) {
      if (p.claimed) continue;
      const links = p.linkedVideoId && vids.some((v) => v.videoId === p.linkedVideoId);
      const near = !p.linkedVideoId && daysBetween(p.date, date) <= 3;
      if (links || near) {
        p.claimed = true;
        urls.push(p.url);
        destinationAccounts.x.push(p.account);
      }
    }
    destinationAccounts.x = [...new Set(destinationAccounts.x)];
    registrations.push({
      title: canon.title,
      date,
      urls,
      why: `new episode (${vids.length} YT, ${urls.length - vids.length} X)`,
      newEpisode: true,
      destinationAccounts,
    });
  }

  // Leftover X posts may link an already-registered YouTube episode or carry
  // the X broadcast itself after the morning discovery pass.
  for (const p of xFound) {
    if (p.claimed) continue;
    const show = p.linkedVideoId
      ? registry.shows.find((s) => (s.targets || []).some((t) => t.videoId === p.linkedVideoId))
      : existingShowForXBroadcast(p, registry.shows);
    if (!show) {
      console.log(`discover: skipping X post ${p.url} — mentions Dive Radio but matches no episode within 3 days`);
      continue;
    }
    registrations.push({ title: show.title, date: show.date, urls: [p.url], why: `late X ${p.broadcastId ? "broadcast" : "announce"} for ${show.slug}`, newEpisode: false });
    p.claimed = true;
  }

  const coverageErrors = [];
  const episodeCoverage = registrations
    .filter((r) => r.newEpisode)
    .map((r) => {
      const missingYouTube = YT_CHANNELS.map((ch) => ch.account).filter(
        (account) => !r.destinationAccounts.youtube.includes(account)
      );
      const missingX = SOURCE_X_ACCOUNTS.filter((account) => !r.destinationAccounts.x.includes(account));
      if (missingYouTube.length) coverageErrors.push(`${r.date}: YouTube missing ${missingYouTube.join(", ")}`);
      if (missingX.length) coverageErrors.push(`${r.date}: X missing ${missingX.join(", ")}`);
      return {
        date: r.date,
        youtube: r.destinationAccounts.youtube,
        x: r.destinationAccounts.x,
        complete: missingYouTube.length === 0 && missingX.length === 0,
      };
    });

  const registrationErrors = [];
  let registered = 0;
  for (const r of registrations) {
    console.log(`discover: registering "${r.title}" (${r.date}) — ${r.why}`);
    for (const u of r.urls) console.log(`  + ${u}`);
    if (dryRun) continue;
    try {
      execFileSync(process.execPath, [TRACK, "register", "--title", r.title, "--date", r.date, ...r.urls], {
        stdio: "inherit",
        cwd: ROOT,
        timeout: 120000,
      });
      registered += 1;
    } catch (err) {
      registrationErrors.push(`${r.date}: ${errorText(err)}`);
    }
  }

  const errors = [
    ...Object.entries(sources).flatMap(([name, source]) =>
      source.success ? [] : [`${name}: ${source.accounts.filter((row) => !row.success).map((row) => `${row.account} ${row.error}`).join("; ")}`]
    ),
    ...coverageErrors,
    ...registrationErrors.map((error) => `register: ${error}`),
  ];
  const baseStatus = sourceStatus(sources);
  const status = baseStatus === "ok" && errors.length === 0 ? "ok" : "partial";
  const receipt = {
    startedAt,
    status,
    lookbackDays: LOOKBACK_DAYS,
    sources,
    found: { youtube: ytFound.length, x: xFound.length },
    registrations: {
      attempted: !dryRun,
      success: !dryRun && registrationErrors.length === 0,
      planned: registrations.length,
      completed: registered,
    },
    episodeCoverage,
    errors,
  };
  if (!dryRun) appendSourceReceipt("discovery", receipt);
  if (dryRun) console.log("discover: dry run — nothing written.");
  if (status !== "ok") {
    throw new Error(`source discovery incomplete — ${errors.join("; ")}`);
  }
  if (!ytFound.length && !xFound.length) {
    console.log(`discover: no new Dive Radio destinations in the last ${LOOKBACK_DAYS} days.`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`discover: ${err.message}\n`);
    process.exit(1);
  });
}
