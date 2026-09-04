#!/usr/bin/env node
// beehiiv-promotions-pull.mjs — find exact Dive Radio episode links in the
// UX Tools newsletter and save Beehiiv's link-click facts. Network access
// lives here, never in build-data.mjs. The API key is supplied by the
// OpenClaw 1Password environment and is never printed or written.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const STORE_PATH = join(ROOT, "data", "restream", "beehiiv-promotions.json");
export const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
export const DEFAULT_PUBLICATION_ID = "pub_b43b31ae-c4fc-46ab-a61b-f164a693180d";
export const PUBLICATION_NAME = "UX Tools";
const API = "https://api.beehiiv.com/v2";

function isDiveRadio(show) {
  return /dive.?radio/i.test(show?.title || "") || /dive-radio/.test(show?.slug || "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function extractAnchorUrls(html) {
  const urls = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const value = decodeHtml(match[1] ?? match[2] ?? match[3]);
    if (value) urls.push(value);
  }
  return urls;
}

export function targetKeyFromUrl(value) {
  let url;
  try { url = new URL(decodeHtml(value)); }
  catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id ? `youtube:${id}` : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = url.pathname === "/watch" ? url.searchParams.get("v") : parts[0] === "live" || parts[0] === "shorts" ? parts[1] : null;
    return id ? `youtube:${id}` : null;
  }
  if (host === "x.com" || host === "twitter.com") {
    const match = url.pathname.match(/^\/i\/broadcasts\/([A-Za-z0-9_-]+)/);
    return match ? `x:${match[1]}` : null;
  }
  return null;
}

export function canonicalTrackedUrl(value) {
  let url;
  try { url = new URL(decodeHtml(value)); }
  catch { return null; }
  // Beehiiv adds a different subscriber link id to each rendered anchor, then
  // omits that id from its click-stat URL. Removing only that private id makes
  // the email anchors comparable to the returned rows without collapsing
  // genuinely different tracked links.
  url.searchParams.delete("_bhlid");
  return url.toString();
}

export function registeredTargetKeys(show) {
  const keys = new Set();
  for (const target of show?.targets || []) {
    if (target.kind === "youtube" && target.videoId) keys.add(`youtube:${target.videoId}`);
    if (target.kind === "x" && target.broadcastId) keys.add(`x:${target.broadcastId}`);
  }
  return keys;
}

function count(value, label) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole number`);
  return value;
}

function sumComplete(values) {
  return values.length && values.every((value) => value != null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function isoFromPost(post) {
  if (!Number.isFinite(post?.publish_date)) throw new Error(`Beehiiv post ${post?.id || "without an id"} has no publish date`);
  return new Date(post.publish_date * 1000).toISOString();
}

export function promotionForEpisode(show, posts, { now = Date.now() } = {}) {
  const episodeTargets = registeredTargetKeys(show);
  const newsletters = [];
  for (const post of posts || []) {
    const publishedAt = isoFromPost(post);
    if (Date.parse(publishedAt) > now) continue;
    const anchors = extractAnchorUrls(post?.content?.free?.email);
    const matchingAnchors = anchors.map((url) => ({ url: canonicalTrackedUrl(url), target: targetKeyFromUrl(url) }))
      .filter((item) => item.target && episodeTargets.has(item.target));
    if (!matchingAnchors.length) continue;
    const matchedTargets = [...new Set(matchingAnchors.map((item) => item.target))].sort();
    const matchedAnchorUrls = [...new Set(matchingAnchors.map((item) => item.url))].sort();
    const seenUrls = new Set();
    const links = [];
    for (const row of post?.stats?.clicks || []) {
      const rowUrl = canonicalTrackedUrl(row?.url);
      if (!rowUrl) continue;
      if (seenUrls.has(rowUrl)) throw new Error(`Beehiiv post ${post.id} repeats a click row for ${rowUrl}`);
      seenUrls.add(rowUrl);
      const key = targetKeyFromUrl(row.base_url) || targetKeyFromUrl(rowUrl);
      if (!key || !matchedTargets.includes(key) || !matchedAnchorUrls.includes(rowUrl)) continue;
      links.push({
        url: rowUrl,
        baseUrl: row.base_url || null,
        target: key,
        emailClicks: count(row?.email?.clicks, `${post.id} email clicks`),
        verifiedEmailClicks: count(row?.email?.verified_clicks, `${post.id} verified email clicks`),
        uniqueClicksForThisLink: count(row?.email?.unique_clicks, `${post.id} unique clicks`),
        uniqueVerifiedClicksForThisLink: count(row?.email?.unique_verified_clicks, `${post.id} unique verified clicks`),
      });
    }
    links.sort((a, b) => a.url.localeCompare(b.url));
    const complete = matchedAnchorUrls.every((url) => links.some((link) => link.url === url));
    const emailClicks = complete ? sumComplete(links.map((link) => link.emailClicks)) : null;
    const verifiedEmailClicks = complete ? sumComplete(links.map((link) => link.verifiedEmailClicks)) : null;
    newsletters.push({
      postId: post.id,
      title: post.title || "Untitled newsletter",
      slug: post.slug || null,
      publishedAt,
      webUrl: post.web_url || null,
      matchedTargets,
      anchorCount: matchingAnchors.length,
      trackedLinkCount: matchedAnchorUrls.length,
      links,
      emailClicks,
      verifiedEmailClicks,
      clicksReason: !complete
        ? "Beehiiv has not returned stats for every tracked episode link."
        : emailClicks == null || verifiedEmailClicks == null
          ? "Beehiiv returned a tracked episode link without complete email click counts."
          : null,
      combinedUniqueReaders: null,
      uniqueReason: "Beehiiv does not dedupe one reader across different tracked links.",
    });
  }
  newsletters.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.postId.localeCompare(b.postId));
  return {
    status: newsletters.length ? "found" : "no-direct-link",
    reason: newsletters.length ? null : "No newsletter link could be tied to this episode exactly.",
    newsletters,
    totals: newsletters.length ? {
      emailClicks: sumComplete(newsletters.map((newsletter) => newsletter.emailClicks)),
      verifiedEmailClicks: sumComplete(newsletters.map((newsletter) => newsletter.verifiedEmailClicks)),
      combinedUniqueReaders: null,
      uniqueReason: "Beehiiv does not dedupe one reader across different tracked links.",
    } : null,
  };
}

export function phoenixDateKey(value = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function mergeSnapshot(previous, result, pulledAt) {
  const snapshots = Array.isArray(previous) ? previous.filter((row) => row && typeof row.date === "string") : [];
  if (result.status !== "found" || !result.totals || (result.totals.emailClicks == null && result.totals.verifiedEmailClicks == null)) return snapshots;
  const next = {
    date: phoenixDateKey(pulledAt),
    pulledAt: new Date(pulledAt).toISOString(),
    emailClicks: result.totals.emailClicks,
    verifiedEmailClicks: result.totals.verifiedEmailClicks,
  };
  return [...snapshots.filter((row) => row.date !== next.date), next].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildPromotionStore({ registry, posts, previous = null, now = Date.now(), publicationId = DEFAULT_PUBLICATION_ID } = {}) {
  const updatedAt = new Date(now).toISOString();
  const episodes = {};
  const shows = (registry?.shows || [])
    .filter((show) => isDiveRadio(show))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));
  for (const show of shows) {
    const result = promotionForEpisode(show, posts, { now });
    if (previous?.episodes?.[show.slug]?.status === "found" && result.status !== "found") {
      throw new Error(`Beehiiv no longer returned the exact link previously saved for ${show.slug}; previous promotion facts were kept`);
    }
    episodes[show.slug] = {
      ...result,
      snapshots: mergeSnapshot(previous?.episodes?.[show.slug]?.snapshots, result, now),
    };
  }
  for (const [slug, episode] of Object.entries(previous?.episodes || {})) {
    if (!Object.hasOwn(episodes, slug)) episodes[slug] = episode;
  }
  return {
    schemaVersion: 1,
    publication: { id: publicationId, name: PUBLICATION_NAME },
    updatedAt,
    lastSuccessfulAt: updatedAt,
    episodes,
  };
}

export async function fetchConfirmedPosts({ apiKey, publicationId = DEFAULT_PUBLICATION_ID, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("BEEHIIV_API_KEY is not available; run through the OpenClaw 1Password environment");
  const posts = [];
  let page = 1;
  let totalPages = 1;
  do {
    if (page > 100) throw new Error("Beehiiv returned more than 100 pages; refusing an unbounded scan");
    const url = new URL(`${API}/publications/${encodeURIComponent(publicationId)}/posts`);
    for (const [key, value] of [
      ["status", "confirmed"], ["platform", "all"], ["order_by", "publish_date"], ["direction", "desc"],
      ["limit", "100"], ["page", String(page)], ["expand[]", "stats"], ["expand[]", "free_email_content"],
    ]) url.searchParams.append(key, value);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Beehiiv posts request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error("Beehiiv posts response has no data list");
    posts.push(...body.data);
    totalPages = Number(body.total_pages || 1);
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error("Beehiiv posts response has an invalid page count");
    page++;
  } while (page <= totalPages);
  return posts;
}

export function assertUsablePosts(posts) {
  if (!Array.isArray(posts) || !posts.length) throw new Error("Beehiiv returned no confirmed posts; previous promotion facts were kept");
  if (!posts.some((post) => typeof post?.content?.free?.email === "string" && Array.isArray(post?.stats?.clicks))) {
    throw new Error("Beehiiv returned no usable email content and click stats; previous promotion facts were kept");
  }
  return posts;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

export async function run({
  root = ROOT,
  storePath = join(root, "data", "restream", "beehiiv-promotions.json"),
  registryPath = join(root, "data", "restream", "postlive-registry.json"),
  apiKey = process.env.BEEHIIV_API_KEY,
  publicationId = DEFAULT_PUBLICATION_ID,
  now = Date.now(),
  dryRun = false,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const previous = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : null;
  const posts = await fetchConfirmedPosts({ apiKey, publicationId, fetchImpl });
  assertUsablePosts(posts);
  const store = buildPromotionStore({ registry, posts, previous, now, publicationId });
  if (!dryRun) writeJsonAtomic(storePath, store);
  const found = Object.entries(store.episodes).filter(([, episode]) => episode.status === "found");
  const current = found.at(-1);
  const currentText = current && current[1].totals?.verifiedEmailClicks != null
    ? `; latest match ${current[0]} has ${current[1].totals.verifiedEmailClicks} verified email clicks`
    : "";
  log(`newsletter promotions: checked ${Object.keys(store.episodes).length} episodes, found ${found.length}${currentText}${dryRun ? " (dry run)" : ""}`);
  return store;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    process.stderr.write(`newsletter promotions: ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 300)}\n`);
    process.exit(1);
  });
}
