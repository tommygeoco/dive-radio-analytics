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
// Exit: 0 only when every due registered source returned a complete list.
// Failed or partial pulls preserve the previous complete comment cohort.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile, withSourceLock, fetchJson, readingEnvelope, phoenixDateKey } from "../../tools/dive-analytics/source-io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XURL_BIN = "/opt/homebrew/bin/xurl";
const X_SEARCH_WINDOW_DAYS = 7;
const HOST_X = new Set(["ridd_design", "designertom"]);
const HOST_YT_CHANNELS = new Set(["UCkCnraWwlnBw1_i7C9-3p0w", "UC4_qP33t3TGpEM0-96WfC6Q"]);
const HOST_YT_NAMES = /^@?(ridd|ridd[\s._-]?design|designertom|tom\s?geoco)$/i;
const MAX_PAGES = 20;

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
  const token = out.trim().split("\n").pop();
  if (!token) throw new Error("X credential is unavailable");
  return token;
}
function likes(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error("comment like count is invalid");
  return value;
}
function requiredId(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}
function requiredTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("comment publication time is invalid");
  return value;
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

export async function pullYouTubeTarget(show, target, { apiKey, now, get }) {
  if (!apiKey) throw new Error("YouTube credential is unavailable");
  const out = [];
  const isHost = (sn) => HOST_YT_CHANNELS.has(sn.authorChannelId?.value) || HOST_YT_NAMES.test((sn.authorDisplayName || "").trim());
  const push = (id, sn) => {
    requiredId(id, "YouTube comment id");
    if (typeof sn.textDisplay !== "string") throw new Error("YouTube comment text is missing");
    if (isHost(sn)) return;
    out.push({
      id: `yt:${id}`, source: "yt", channel: `yt:${target.account}`, sourceObjectId: target.videoId,
      author: sn.authorDisplayName?.replace(/^@/, "") || "viewer", authorId: sn.authorChannelId?.value || null,
      text: decodeEntities(sn.textDisplay).slice(0, 500), likes: likes(sn.likeCount), publishedAt: requiredTime(sn.publishedAt),
      reading: readingEnvelope({ source: "youtube-comments", episode: show.slug, objectId: id, pulledAt: now }),
    });
  };
  const list = async (endpoint, params, visit) => {
    let token = "";
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ ...params, maxResults: "100", textFormat: "plainText", key: apiKey });
      if (token) q.set("pageToken", token);
      const data = await get(`https://www.googleapis.com/youtube/v3/${endpoint}?${q}`);
      if (!Array.isArray(data.items)) throw new Error("YouTube comment response has no item list");
      for (const item of data.items) await visit(item);
      const next = data.nextPageToken;
      if (!next) return;
      if (typeof next !== "string" || seen.has(next)) throw new Error("YouTube comment pagination repeated or is invalid");
      seen.add(next); token = next;
    }
    throw new Error("YouTube comment pagination exceeded its bounded limit");
  };
  await list("commentThreads", { part: "snippet,replies", videoId: target.videoId, order: "time" }, async (item) => {
    const comment = item.snippet?.topLevelComment;
    if (!comment?.snippet) throw new Error("YouTube comment thread is malformed");
    push(comment.id, comment.snippet);
    const inline = item.replies?.comments || [];
    const total = item.snippet.totalReplyCount;
    if (!Array.isArray(inline) || !Number.isInteger(total) || total < 0) throw new Error("YouTube reply counts are invalid");
    if (total > inline.length) {
      let fetched = 0;
      await list("comments", { part: "snippet", parentId: comment.id }, (reply) => {
        if (!reply?.snippet) throw new Error("YouTube reply is malformed");
        fetched++; push(reply.id, reply.snippet);
      });
      if (fetched < total) throw new Error("YouTube returned an incomplete reply list");
    } else for (const reply of inline) {
      if (!reply?.snippet) throw new Error("YouTube inline reply is malformed");
      push(reply.id, reply.snippet);
    }
  });
  return out;
}

export async function pullXTarget(show, target, { bearer, now, get }) {
  if (!bearer) throw new Error("X credential is unavailable");
  const out = [];
  const seen = new Set();
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ query: `conversation_id:${target.postId} is:reply`, "tweet.fields": "public_metrics,author_id,created_at", expansions: "author_id", "user.fields": "username", max_results: "100" });
    if (token) q.set("next_token", token);
    const data = await get(`https://api.x.com/2/tweets/search/recent?${q}`, { Authorization: `Bearer ${bearer}` });
    if (data.errors?.length || (!Array.isArray(data.data) && !(data.meta?.result_count === 0 && data.data === undefined))) throw new Error("X reply response has no complete result list");
    const users = Object.fromEntries((data.includes?.users || []).map((u) => [u.id, u.username]));
    for (const tweet of data.data || []) {
      requiredId(tweet.id, "X reply id");
      requiredId(tweet.author_id, "X reply author");
      if (typeof tweet.text !== "string") throw new Error("X reply text is missing");
      const username = users[tweet.author_id] || "";
      if (HOST_X.has(username.toLowerCase())) continue;
      const text = stripMentions(decodeEntities(tweet.text));
      if (!text || /^https?:\/\/\S+$/.test(text)) continue;
      out.push({
        id: `x:${tweet.id}`, source: "x", channel: `x:${target.account}`, sourceObjectId: target.postId,
        author: username ? `@${username}` : "viewer", authorId: tweet.author_id,
        text: text.slice(0, 500), likes: likes(tweet.public_metrics?.like_count), publishedAt: requiredTime(tweet.created_at),
        reading: readingEnvelope({ source: "x-replies", episode: show.slug, objectId: tweet.id, pulledAt: now }),
      });
    }
    const next = data.meta?.next_token;
    if (!next) return out;
    if (typeof next !== "string" || seen.has(next)) throw new Error("X reply pagination repeated or is invalid");
    seen.add(next); token = next;
  }
  throw new Error("X reply pagination exceeded its bounded limit");
}

export async function runCommentsPull({ root = ROOT, now = new Date().toISOString(), apiKey, bearer, fetchImpl = fetch, log = console.log } = {}) {
  const pulledAt = new Date(now).toISOString();
  const registry = readJsonFile(join(root, "data", "restream", "postlive-registry.json"));
  if (!Array.isArray(registry.shows)) throw new Error("comment registry has no shows");
  const shows = registry.shows.filter((show) => show.active !== false && /dive-radio/.test(show.slug) && show.date <= phoenixDateKey(pulledAt));
  const failures = [];
  let added = 0;
  for (const show of shows) {
    const path = join(root, "data", "restream", "comments", `${show.slug}.json`);
    await withSourceLock(path, async () => {
      const store = readJsonFile(path, { fallback: { slug: show.slug, title: show.title, date: show.date, comments: [] } });
      if (store.slug !== show.slug || !Array.isArray(store.comments)) throw new Error("comment store identity or rows are invalid");
      const ageDays = (Date.parse(pulledAt) - Date.parse(`${show.date}T12:00:00-07:00`)) / 86400000;
      const xDue = ageDays <= X_SEARCH_WINDOW_DAYS + 1;
      const targets = (show.targets || []).filter((target) => target.kind === "youtube" || (xDue && target.kind === "x" && target.role !== "promo"));
      const sources = [];
      const staged = [];
      for (const target of targets) {
        const source = target.kind === "youtube" ? "youtube-comments" : "x-replies";
        const objectId = target.videoId || target.postId;
        try {
          requiredId(objectId, "comment source object");
          const get = (url, headers) => fetchJson(url, { label: `${source} ${target.account}`, headers, fetchImpl });
          const comments = target.kind === "youtube"
            ? await pullYouTubeTarget(show, target, { apiKey, now: pulledAt, get })
            : await pullXTarget(show, target, { bearer, now: pulledAt, get });
          staged.push(...comments);
          sources.push({ ...readingEnvelope({ source, episode: show.slug, objectId, pulledAt }), count: comments.length });
        } catch (error) {
          sources.push({ ...readingEnvelope({ source, episode: show.slug, objectId: objectId || "unregistered", pulledAt, state: "failed" }), reason: String(error.message).slice(0, 180) });
        }
      }
      const complete = sources.length > 0 && sources.every((source) => source.state === "ready");
      store.capture = { checkedAt: pulledAt, state: complete ? "ready" : "failed", sources };
      if (!complete) {
        atomicWriteJson(path, store);
        failures.push(`${show.slug}: ${sources.filter((source) => source.state !== "ready").map((source) => `${source.source} ${source.objectId}: ${source.reason}`).join("; ") || "no registered comment sources"}`);
        return;
      }
      syncCommentMetadata(store, show);
      const seen = new Map(store.comments.map((comment) => [comment.id, comment]));
      for (const comment of staged) {
        if (seen.has(comment.id)) {
          const prior = seen.get(comment.id);
          if (comment.likes != null) { prior.likes = comment.likes; prior.likesReading = comment.reading; }
          continue;
        }
        const next = { ...comment, firstSeenAt: pulledAt };
        store.comments.push(next); seen.set(comment.id, next); added++;
      }
      if (xDue && sources.some((source) => source.source === "x-replies")) store.xCoverage = "covered";
      else if (!store.xCoverage) store.xCoverage = "missed";
      store.updatedAt = pulledAt;
      atomicWriteJson(path, store);
    });
  }
  log(`comments: ${shows.length} due show(s), ${added} new comment(s), ${failures.length} incomplete show(s)`);
  if (failures.length) throw new Error(`comment capture incomplete — ${failures.join("; ")}`);
  return { shows: shows.length, added };
}

async function main() {
  let apiKey = null, bearer = null;
  try { apiKey = ytApiKey(); } catch { /* Captured as a failed source for each due episode. */ }
  try { bearer = xBearer(); } catch { /* Captured as a failed source for each due episode. */ }
  return runCommentsPull({ apiKey, bearer });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`comments: ${error.message}\n`); process.exit(1); });
}
