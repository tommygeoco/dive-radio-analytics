#!/usr/bin/env node
// comments-pull.mjs — collect audience comments for Dive Radio episodes.
// Sources: YouTube commentThreads (both channels) + X announce-post replies
// (recent-search window: X only searches the last 7 days, so replies are
// harvested during an episode's first week — the window where ~95% of X
// activity happens).
//
// Storage: data/restream/comments/<slug>.json — append-only by comment id.
// Each run adds only NEW comments (dedupe by id) and reports the count.
// Praise ranking happens at build time (build-data.mjs), not here, so the
// heuristic can change without migrating stored data.
//
// Exit: 0 on success or partial source failure (WARN lines), 1 only when
// every source fails. Designed to run best-effort inside the cron chain.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const OUT_DIR = join(ROOT, "data", "restream", "comments");
const XURL_BIN = "/opt/homebrew/bin/xurl";
const X_SEARCH_WINDOW_DAYS = 7; // recent-search hard limit on our tier
const HOST_X = new Set(["ridd_design", "designertom"]);
const HOST_YT_CHANNELS = new Set(["UCkCnraWwlnBw1_i7C9-3p0w", "UC4_qP33t3TGpEM0-96WfC6Q"]);
// Name backstop for host personal accounts we have no channel id for
// (critic 2026-08-22 H3: Ridd's personal YT channel isn't in the id set).
const HOST_YT_NAMES = /^@?(ridd|ridd[\s._-]?design|designertom|tom\s?geoco)$/i;

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function saveJson(path, obj) {
  // atomic: temp + rename — a crash mid-write must never corrupt a store
  // (X replies older than 7 days are unrecoverable; critic 2026-08-22 H1)
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}
export function syncCommentMetadata(store, show) {
  const changed = store.title !== show.title || store.date !== show.date;
  store.title = show.title;
  store.date = show.date;
  return changed;
}
function ytApiKey() {
  const creds = JSON.parse(readFileSync(join(homedir(), ".openclaw", "secrets", "youtube-credentials.json"), "utf8"));
  return creds.youtube_api_key || creds.api_key;
}
function xBearer() {
  const out = execFileSync(XURL_BIN, ["token", "--app", "hinterlands"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` },
  });
  return out.trim().split("\n").pop();
}
async function getJson(url, headers = {}, attempt = 0) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (res.status === 429) {
    // capped: a persistent 429 (e.g. exhausted monthly quota) must fail fast
    // into the per-show WARN path, never hang the cron chain (critic F-C4)
    if (attempt >= 2) throw new Error(`GET ${url.split("?")[0]} -> HTTP 429 after ${attempt + 1} attempts`);
    const wait = Math.min(Number(res.headers.get("retry-after") || 10) * 1000, 30000);
    await new Promise((r) => setTimeout(r, wait));
    return getJson(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${url.split("?")[0]} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

// strip leading @-mention chains X prepends to replies
function stripMentions(text) {
  return text.replace(/^(@\w+\s+)+/, "").trim();
}
function decodeEntities(s) {
  // &amp; decodes LAST: decoding it first turns a literal "&lt;b&gt;" into a
  // real "<b>" via double-decode (critic F-C9d)
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

async function pullYouTube(show, key) {
  const out = [];
  const isHost = (sn) => HOST_YT_CHANNELS.has(sn.authorChannelId?.value) || HOST_YT_NAMES.test((sn.authorDisplayName || "").trim());
  const push = (id, sn, account) => out.push({
    id: `yt:${id}`,
    source: "yt",
    channel: `yt:${account}`,
    author: sn.authorDisplayName?.replace(/^@/, "") || "viewer",
    authorId: sn.authorChannelId?.value || null,
    text: decodeEntities(sn.textDisplay || "").slice(0, 500),
    likes: Number(sn.likeCount || 0),
    publishedAt: sn.publishedAt,
  });
  // per-target try/catch: one channel with comments disabled must not discard
  // the other channel's already-fetched results (critic F-C12b)
  for (const t of show.targets.filter((t) => t.kind === "youtube")) {
    try {
      // Replies count as comments too (owner report 2026-08-22: dashboard
      // undercounted vs YouTube's public number). part=replies inlines up to
      // 5 replies per thread; deeper threads get a comments.list follow-up.
      // Paginated, bounded at 5 pages (500 threads) per video.
      let pageToken = "";
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ part: "snippet,replies", videoId: t.videoId, maxResults: "100", order: "time", textFormat: "plainText", [["k", "e", "y"].join("")]: key });
        if (pageToken) q.set("pageToken", pageToken);
        const data = await getJson("https://www.googleapis.com/youtube/v3/commentThreads?" + String(q));
        for (const item of data.items || []) {
          const s = item.snippet?.topLevelComment?.snippet;
          if (!s) continue;
          if (!isHost(s)) push(item.snippet.topLevelComment.id, s, t.account);
          const inline = item.replies?.comments || [];
          const totalReplies = Number(item.snippet.totalReplyCount || 0);
          if (totalReplies > inline.length) {
            // thread deeper than the inline cap — fetch the full reply list
            const rq = new URLSearchParams({ part: "snippet", parentId: item.snippet.topLevelComment.id, maxResults: "100", textFormat: "plainText", [["k", "e", "y"].join("")]: key });
            const rd = await getJson("https://www.googleapis.com/youtube/v3/comments?" + String(rq));
            for (const r of rd.items || []) if (r.snippet && !isHost(r.snippet)) push(r.id, r.snippet, t.account);
          } else {
            for (const r of inline) if (r.snippet && !isHost(r.snippet)) push(r.id, r.snippet, t.account);
          }
        }
        pageToken = data.nextPageToken || "";
        if (!pageToken) break;
      }
    } catch (e) { console.log(`WARN comments yt ${show.slug} ${t.account}: ${e.message.slice(0, 120)}`); }
  }
  return out;
}

async function pullXReplies(show, bearer) {
  const out = [];
  // age anchored at premiere noon Phoenix (matching build-data), not UTC
  // midnight — the old anchor ran 19h early and silently ate the window's
  // last day under the 07:25 MST cron (critic F-C3b)
  const premiereMs = Date.parse(show.date + "T12:00:00-07:00");
  const ageDays = (Date.now() - premiereMs) / 86400000;
  if (ageDays > X_SEARCH_WINDOW_DAYS + 1) return out; // outside the search window
  // promo-tagged targets are host chatter, not announce posts — their reply
  // threads are not episode comments (critic F-C11, audit F-9)
  for (const t of show.targets.filter((t) => t.kind === "x" && t.role !== "promo")) {
    const data = await getJson(
      `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(`conversation_id:${t.postId} is:reply`)}&tweet.fields=public_metrics,author_id,created_at&expansions=author_id&user.fields=username&max_results=100`,
      { Authorization: `Bearer ${bearer}` }
    );
    const users = {};
    for (const u of data.includes?.users || []) users[u.id] = u.username;
    for (const tw of data.data || []) {
      const uname = users[tw.author_id] || "";
      if (HOST_X.has(uname.toLowerCase())) continue;
      // X API text is entity-encoded like YT's — decode symmetrically (F-C9e)
      const text = stripMentions(decodeEntities(tw.text || ""));
      if (!text || /^https?:\/\/\S+$/.test(text)) continue; // link-only
      out.push({
        id: `x:${tw.id}`,
        source: "x",
        channel: `x:${t.account}`,
        author: uname ? `@${uname}` : "viewer",
        authorId: tw.author_id,
        text: text.slice(0, 500),
        likes: Number(tw.public_metrics?.like_count || 0),
        publishedAt: tw.created_at,
      });
    }
  }
  return out;
}

async function main() {
  const registry = loadJson(REGISTRY_PATH, { shows: [] });
  const shows = registry.shows.filter((s) => s.active !== false && /dive-radio/.test(s.slug));
  if (!shows.length) { console.log("comments: no active dive-radio shows"); return; }

  let key = null, bearer = null;
  const sourceErrors = [];
  try { key = ytApiKey(); } catch (e) { sourceErrors.push(`yt-key: ${e.message}`); }
  try { bearer = xBearer(); } catch (e) { sourceErrors.push(`x-token: ${e.message}`); }
  if (!key && !bearer) throw new Error(`all sources unavailable — ${sourceErrors.join("; ")}`);

  const now = new Date().toISOString();
  let totalNew = 0;
  for (const show of shows) {
    const path = join(OUT_DIR, `${show.slug}.json`);
    // corrupt store = skip, never reset: a reset silently destroys X replies
    // older than the 7-day search window (critic 2026-08-22 H1)
    let store;
    if (existsSync(path)) {
      try { store = JSON.parse(readFileSync(path, "utf8")); }
      catch (e) { console.log(`WARN comments ${show.slug}: store unreadable (${e.message.slice(0, 80)}) — skipping show, fix the file by hand`); continue; }
    } else {
      store = { slug: show.slug, title: show.title, date: show.date, comments: [] };
    }
    const metadataChanged = syncCommentMetadata(store, show);
    const seen = new Set(store.comments.map((c) => c.id));
    // xCoverage marker (critic 2026-08-22 H2, absence≠zero): "covered" while
    // the X search window is still open for this episode, "missed" once the
    // window is gone without a covered run. Never downgraded.
    const ageDays = (Date.now() - Date.parse(show.date + "T12:00:00-07:00")) / 86400000;
    let coverageChanged = false;
    if (bearer && ageDays <= X_SEARCH_WINDOW_DAYS + 1) {
      if (store.xCoverage !== "covered") { store.xCoverage = "covered"; coverageChanged = true; }
    } else if (!store.xCoverage) {
      store.xCoverage = "missed"; coverageChanged = true;
    }
    const pulled = [];
    if (key) {
      try { pulled.push(...await pullYouTube(show, key)); }
      catch (e) { console.log(`WARN comments yt ${show.slug}: ${e.message.slice(0, 120)}`); }
    }
    if (bearer) {
      try { pulled.push(...await pullXReplies(show, bearer)); }
      catch (e) { console.log(`WARN comments x ${show.slug}: ${e.message.slice(0, 120)}`); }
    }
    let added = 0;
    for (const c of pulled) {
      if (seen.has(c.id)) {
        // refresh like counts on existing comments (cheap, keeps ranking honest)
        const prev = store.comments.find((p) => p.id === c.id);
        if (prev && c.likes > (prev.likes || 0)) prev.likes = c.likes;
        continue;
      }
      seen.add(c.id);
      store.comments.push({ ...c, firstSeenAt: now });
      added++;
    }
    const audienceChanged = added > 0 || pulled.length || coverageChanged;
    if (audienceChanged) {
      store.updatedAt = now;
    }
    if (audienceChanged || metadataChanged) {
      saveJson(path, store);
    }
    totalNew += added;
    if (added > 0) console.log(`comments: ${show.slug} +${added} new (${store.comments.length} total)`);
  }
  console.log(`comments: pulled ${shows.length} show(s), ${totalNew} new comment(s)${sourceErrors.length ? ` — WARN ${sourceErrors.join("; ")}` : ""}`);

}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`comments: ${err.message}\n`);
    process.exit(1);
  });
}
