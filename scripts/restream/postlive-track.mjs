#!/usr/bin/env node
// postlive-track.mjs — track accumulated post-live views for published shows
// across destinations: YouTube (joindiveclub, DesignerTom) and X (ridd_design,
// designertom). Restream analytics stop at the live window; this covers the
// long tail after publish.
//
// Registry:  data/restream/postlive-registry.json   (show -> destination IDs)
// History:   data/restream/postlive/<slug>.json     (daily metric snapshots)
// Vault:     Ops/Bones/live-show-analytics.md       ("Post-Live Accumulation"
//            section between <!-- POSTLIVE:BEGIN --> / <!-- POSTLIVE:END -->)
//
// Usage:
//   node postlive-track.mjs register --title "Show name" --date 2026-07-15 <url> [<url> ...]
//   node postlive-track.mjs snapshot            # pull metrics, append history, re-render vault
//   node postlive-track.mjs snapshot --all      # include shows older than the 60-day window
//   node postlive-track.mjs list
//
// Auth: YouTube key from ~/.openclaw/secrets/youtube-credentials.json.
//       X bearer via short-lived `xurl token --app hinterlands` (same pattern
//       the xapi proxy uses; short-lived calls re-read the token file fresh).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY_DIR = join(ROOT, "data", "restream", "postlive");
const LOG_PATH =
  "/Users/bones/Documents/Obsidian/Hinterlands/Ops/Bones/live-show-analytics.md";
const BEGIN = "<!-- POSTLIVE:BEGIN -->";
const END = "<!-- POSTLIVE:END -->";
const XURL_BIN = "/opt/homebrew/bin/xurl";
const YTDLP_BIN = process.env.YTDLP_BIN || "/opt/homebrew/bin/yt-dlp";
const TRACK_WINDOW_DAYS = 60;
const MAX_RESOLVE_ATTEMPTS = 5; // distinct failed runs before a target latches as "none"

// Fixed destination columns (order matters for the vault table).
// Unit discipline: YT columns are video views; X columns are post impressions
// (reach). They are different units and are never summed together.
const COLUMNS = [
  { key: "yt:joindiveclub", label: "YT dive" },
  { key: "yt:designertom", label: "YT tom" },
  { key: "x:ridd_design", label: "X ridd reach" },
  { key: "x:designertom", label: "X tom reach" },
];
const KNOWN_YT_CHANNELS = {
  "UCkCnraWwlnBw1_i7C9-3p0w": "joindiveclub",
  "UC4_qP33t3TGpEM0-96WfC6Q": "designertom",
};

// --- IO helpers ---

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

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

// --- URL parsing ---

export function parseTarget(url) {
  let m = url.match(
    /(?:youtube\.com\/(?:watch\?v=|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  );
  if (m) return { kind: "youtube", videoId: m[1] };
  m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/);
  if (m) return { kind: "x", account: m[1].toLowerCase(), postId: m[2] };
  return null;
}

function targetKey(t) {
  return t.kind === "youtube" ? `yt:${t.account}` : `x:${t.account}`;
}

// --- metric fetchers (batched) ---

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function countOrNull(value) {
  if (value == null || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

// The Data API omits statistics while an upload is still waiting to air.
// An omitted count is absence, not a measured zero; an explicit "0" remains 0.
export function youtubeStatsOf(item) {
  return {
    views: countOrNull(item?.statistics?.viewCount),
    likes: countOrNull(item?.statistics?.likeCount),
    comments: countOrNull(item?.statistics?.commentCount),
    title: item?.snippet?.title,
    channelId: item?.snippet?.channelId,
  };
}

export function mergedViewCount(previous, current) {
  if (!Number.isFinite(current)) return Number.isFinite(previous) ? previous : null;
  return (Number.isFinite(previous) ? previous : 0) + current;
}

export function syncPostliveMetadata(store, show) {
  const changed = store.title !== show.title || store.date !== show.date;
  store.title = show.title;
  store.date = show.date;
  return changed;
}

// Public YouTube can return an all-zero row before a scheduled stream airs.
// Keep that raw row for audit, but it is not yet a usable audience reading.
export function youtubeViewsForDisplay(metrics) {
  const counts = Object.entries(metrics || {})
    .filter(([key]) => key.startsWith("yt:"))
    .map(([, value]) => value?.views);
  if (!counts.some((value) => Number.isFinite(value) && value > 0)) return null;
  return counts.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

export function destinationViewsForDisplay(metrics, key) {
  if (key.startsWith("yt:") && youtubeViewsForDisplay(metrics) == null) return null;
  const value = metrics?.[key]?.views;
  return Number.isFinite(value) ? value : null;
}

export function youtubeDeltaForDisplay(currentMetrics, previousMetrics) {
  const current = youtubeViewsForDisplay(currentMetrics);
  const previous = youtubeViewsForDisplay(previousMetrics);
  return Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
}

async function fetchYouTubeStats(videoIds) {
  if (!videoIds.length) return {};
  const key = ytApiKey();
  const stats = {};
  for (const batch of chunk(videoIds, 50)) {
    const data = await getJson(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${batch.join(",")}&key=${key}`
    );
    for (const item of data.items || []) {
      stats[item.id] = youtubeStatsOf(item);
    }
  }
  return stats;
}

async function fetchXStats(postIds) {
  if (!postIds.length) return {};
  const bearer = xBearer();
  const stats = {};
  for (const batch of chunk(postIds, 100)) {
    // Tweet metrics are reach/engagement only. Episode plays MUST come from
    // the resolved X broadcast below; native tweet-video view_count is never
    // requested or accepted as an episode view. Attachments are requested
    // only to identify native-video promos, without media public_metrics.
    const data = await getJson(
      `https://api.x.com/2/tweets?ids=${batch.join(",")}&tweet.fields=public_metrics,attachments,entities&expansions=attachments.media_keys&media.fields=type`,
      { Authorization: `Bearer ${bearer}` }
    );
    const mediaTypes = {};
    for (const m of data.includes?.media || []) {
      mediaTypes[m.media_key] = m.type;
    }
    for (const t of data.data || []) {
      const pm = t.public_metrics || {};
      const mediaKeys = t.attachments?.media_keys || [];
      const urls = [];
      for (const u of t.entities?.urls || []) {
        const cand = u.unwound_url || u.expanded_url || u.url;
        if (cand) urls.push(cand);
      }
      const broadcastIds = [
        ...new Set(urls.map((u) => (u.match(/x\.com\/i\/broadcasts\/(\w+)/) || [])[1]).filter(Boolean)),
      ];
      stats[t.id] = {
        views: Number(pm.impression_count ?? 0),
        likes: Number(pm.like_count ?? 0),
        replies: Number(pm.reply_count ?? 0),
        reposts: Number(pm.retweet_count ?? 0),
        bookmarks: Number(pm.bookmark_count ?? 0),
        quotes: Number(pm.quote_count ?? 0),
        urls,
        broadcastIds,
        hasNativeVideo: mediaKeys.some((k) => mediaTypes[k] === "video"),
      };
    }
  }
  return stats;
}

// Strip resolution-only fields before persisting a stats object into history.
function detailOf(s) {
  // `plays` is stripped defensively so an old/mocked tweet payload can never
  // persist native-media plays into the episode history.
  const { urls, broadcastIds, hasNativeVideo, plays, ...detail } = s;
  return detail;
}

// --- X broadcast resolution + stats ---
// Announce posts embed the live broadcast as a card. The broadcast's real
// view count (what the card shows) is not in the v2 API; we resolve the
// broadcast id once via the syndication card, then pull views with yt-dlp's
// Periscope extractor on every snapshot.

async function resolveBroadcastId(postId) {
  const j = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${postId}&token=x`);
  const name = j?.card?.name || "";
  if (!name.includes("broadcast")) return null;
  return j?.card?.binding_values?.broadcast_id?.string_value || null;
}

const FINISHED_OR_LIVE = new Set(["is_live", "post_live", "was_live"]);

export function parseBroadcastStatsLine(line) {
  const [liveStatus, vc, cvc] = String(line || "").trim().split("|");
  const views = Number(vc);
  if (!FINISHED_OR_LIVE.has(liveStatus) || !Number.isFinite(views) || views <= 0) return null;
  const concurrent = Number(cvc);
  return {
    views,
    peakConcurrent: Number.isFinite(concurrent) && concurrent > 0 ? concurrent : null,
    liveStatus,
  };
}

function fetchBroadcastStats(broadcastIds) {
  const stats = {};
  const failed = new Set();
  for (const id of broadcastIds) {
    try {
      const r = execFileSync(
        YTDLP_BIN,
        ["--no-download", "--print", "%(live_status)s|%(view_count)s|%(concurrent_view_count)s", `https://x.com/i/broadcasts/${id}`],
        { encoding: "utf8", timeout: 90000 }
      );
      const parsed = parseBroadcastStatsLine(r.trim().split("\n").pop());
      // Upcoming containers and zero/unknown counters are absence, not plays.
      if (parsed) stats[id] = parsed;
    } catch (err) {
      failed.add(id);
      process.stderr.write(`postlive: broadcast ${id} stats failed: ${String(err.message).slice(0, 120)}\n`);
    }
  }
  return { stats, failed };
}

// --- registry ops ---

function slugify(title, date) {
  return `${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
}

const registryTitleKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findExistingShow(shows, title, date) {
  const slug = slugify(title, date);
  const exactSlug = (shows || []).find((show) => show.slug === slug);
  if (exactSlug) return exactSlug;
  const matches = (shows || []).filter((show) => show.date === date && registryTitleKey(show.title) === registryTitleKey(title));
  return matches.length === 1 ? matches[0] : null;
}

async function register(args) {
  const title = argValue(args, "--title");
  const date = argValue(args, "--date");
  if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('register needs --title "..." --date YYYY-MM-DD plus at least one URL');
  }
  const urls = args.filter((a) => /^https?:\/\//.test(a));
  if (!urls.length) throw new Error("no destination URLs given");

  const targets = [];
  for (const url of urls) {
    const t = parseTarget(url);
    if (!t) throw new Error(`unrecognized URL (expected YouTube or X status): ${url}`);
    targets.push({ ...t, url });
  }

  // resolve YouTube channel accounts
  const ytIds = targets.filter((t) => t.kind === "youtube").map((t) => t.videoId);
  if (ytIds.length) {
    const stats = await fetchYouTubeStats(ytIds);
    for (const t of targets) {
      if (t.kind !== "youtube") continue;
      const s = stats[t.videoId];
      if (!s) throw new Error(`YouTube video not found: ${t.videoId}`);
      t.account = KNOWN_YT_CHANNELS[s.channelId] || s.channelId;
      t.videoTitle = s.title;
    }
  }

  const registry = loadJson(REGISTRY_PATH, { shows: [] });
  const slug = slugify(title, date);
  const existing = findExistingShow(registry.shows, title, date);
  if (existing) {
    // merge new targets into an existing show
    for (const t of targets) {
      if (!existing.targets.some((e) => targetKey(e) === targetKey(t) && (e.videoId ?? e.postId) === (t.videoId ?? t.postId))) {
        existing.targets.push(t);
      }
    }
  } else {
    registry.shows.push({ slug, title, date, active: true, targets });
  }
  saveJson(REGISTRY_PATH, registry);
  console.log(
    `registered "${title}" (${existing?.slug || slug}) with ${targets.length} destination(s):\n` +
      targets.map((t) => `  ${targetKey(t)} -> ${t.videoId ?? t.postId}`).join("\n")
  );
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
}

// --- snapshot + render ---

function num(v) {
  return typeof v === "number" ? v.toLocaleString("en-US") : "–";
}

function fmtShort(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Phoenix",
  });
}

// Episode-level X plays summary from a snapshot's metrics + the registry
// targets. Falls back to a target's persisted high-water mark when the
// current pull failed (stale), and counts coverage so partial aggregates are
// never presented as complete. Absence is never rendered as 0.
export function playsSummary(show, metrics) {
  const targets = (show.targets || []).filter(
    (t) => t.kind === "x" && t.role !== "promo" && t.playsStatus !== "none" && t.broadcastId
  );
  const keys = [...new Set(targets.map((t) => `x:${t.account}`))];
  const out = { value: null, have: 0, total: keys.length, partial: false, stale: false, asOf: null };
  for (const key of keys) {
    const metric = metrics[key];
    const p = metric?.playsSource === "x-broadcast" || Object.hasOwn(metric || {}, "peakConcurrent")
      ? metric?.plays
      : null;
    if (p != null) {
      out.value = (out.value ?? 0) + p;
      out.have += 1;
      continue;
    }
    const highWater = targets
      .filter((t) => `x:${t.account}` === key && t.playsHighWater?.value != null)
      .reduce((sum, t) => sum + t.playsHighWater.value, 0);
    if (highWater > 0) {
      out.value = (out.value ?? 0) + highWater;
      out.have += 1;
      out.stale = true;
      const asOf = targets
        .filter((t) => `x:${t.account}` === key && t.playsHighWater?.asOf)
        .map((t) => t.playsHighWater.asOf)
        .sort()[0];
      if (asOf && (!out.asOf || asOf < out.asOf)) out.asOf = asOf;
    }
  }
  out.partial = out.have < out.total;
  return out;
}

// Assemble one show's source snapshot. X post metrics contribute reach and
// engagement only. The sole path that can create `plays` is a successfully
// resolved X broadcast whose extractor confirms it is live or was live.
export function buildShowMetrics(show, ytStats, xStats, broadcastStats) {
  const metrics = {};
  const seenBroadcasts = new Set();
  for (const t of show.targets || []) {
    const s = t.kind === "youtube" ? ytStats[t.videoId] : xStats[t.postId];
    if (!s) continue;
    const key = targetKey(t);
    const current = metrics[key] || {};
    metrics[key] = {
      ...current,
      views: mergedViewCount(current.views, s.views),
      detail: detailOf(s),
    };

    if (t.kind !== "x" || !t.broadcastId || seenBroadcasts.has(t.broadcastId)) continue;
    const broadcast = broadcastStats[t.broadcastId];
    if (!broadcast || !Number.isFinite(broadcast.views) || broadcast.views <= 0) continue;
    seenBroadcasts.add(t.broadcastId);
    metrics[key].plays = (metrics[key].plays || 0) + broadcast.views;
    metrics[key].playsSource = "x-broadcast";
    metrics[key].peakConcurrent = broadcast.peakConcurrent;
  }
  return metrics;
}

async function snapshot(args) {
  const registry = loadJson(REGISTRY_PATH, { shows: [] });
  const includeAll = args.includes("--all");
  const cutoff = Date.now() - TRACK_WINDOW_DAYS * 86400000;
  const shows = registry.shows.filter(
    (s) => s.active !== false && (includeAll || Date.parse(s.date) >= cutoff)
  );
  if (!shows.length) {
    console.log("postlive: no active shows registered — nothing to snapshot");
    return;
  }

  const now = new Date().toISOString();
  const ytIds = [...new Set(shows.flatMap((s) => s.targets.filter((t) => t.kind === "youtube").map((t) => t.videoId)))];
  const xIds = [...new Set(shows.flatMap((s) => s.targets.filter((t) => t.kind === "x").map((t) => t.postId)))];

  const errors = [];
  let ytStats = {},
    xStats = {};
  let xFetchOk = false;
  try {
    ytStats = await fetchYouTubeStats(ytIds);
  } catch (err) {
    errors.push(`youtube: ${err.message}`);
  }
  try {
    xStats = await fetchXStats(xIds);
    xFetchOk = true;
  } catch (err) {
    errors.push(`x: ${err.message}`);
  }
  if (errors.length === 2) throw new Error(`both sources failed — ${errors.join("; ")}`);

  // Resolve broadcast ids for X announce posts (F-1b latch semantics):
  //   1. entities.urls from the v2 tweet payload (first-class source)
  //   2. syndication card (secondary)
  // Never latch broadcastResolved on a null/failed resolution. A target only
  // latches when (a) an id is found, (b) its known links are clearly not a
  // broadcast (e.g. a YouTube promo post -> playsStatus "none", role "promo"),
  // or (c) MAX_RESOLVE_ATTEMPTS distinct runs answered with no broadcast
  // (-> playsStatus "none").
  let registryDirty = false;
  for (const show of shows) {
    for (const t of show.targets) {
      if (t.kind !== "x" || t.broadcastId) continue;
      if (t.playsStatus === "none" || t.role === "promo") continue;
      const xs = xFetchOk ? xStats[t.postId] : null;
      let bid = null;
      let source = null;
      let definitive = false; // at least one source answered authoritatively
      if (xs) {
        definitive = true;
        if (xs.broadcastIds?.length) {
          bid = xs.broadcastIds[0];
          source = "entities.urls";
        }
      }
      if (!bid) {
        try {
          const sbid = await resolveBroadcastId(t.postId);
          definitive = true;
          if (sbid) {
            bid = sbid;
            source = "syndication";
          }
        } catch (err) {
          process.stderr.write(`postlive: broadcast resolve failed for ${t.postId}: ${String(err.message).slice(0, 120)}\n`);
        }
      }
      if (bid) {
        t.broadcastId = bid;
        t.broadcastResolved = true;
        t.broadcastIdSource = source;
        delete t.broadcastResolveAttempts;
        delete t.broadcastResolveFailedAt;
        registryDirty = true;
      } else if (definitive) {
        if (xs?.hasNativeVideo || (xs?.urls?.length && !xs.broadcastIds?.length && xs.urls.some((u) => /youtube\.com|youtu\.be/.test(u)))) {
          // Native-video and YouTube-link posts are promos, not X broadcasts.
          t.broadcastResolved = true;
          t.playsStatus = "none";
          if (!t.role) t.role = "promo";
        } else {
          t.broadcastResolveAttempts = (t.broadcastResolveAttempts || 0) + 1;
          t.broadcastResolveFailedAt = now;
          if (t.broadcastResolveAttempts >= MAX_RESOLVE_ATTEMPTS) {
            t.broadcastResolved = true; // latch: repeatedly answered "no broadcast"
            t.playsStatus = "none";
          }
        }
        registryDirty = true;
      }
    }
  }

  const broadcastIds = [...new Set(shows.flatMap((s) => s.targets.filter((t) => t.kind === "x" && t.broadcastId).map((t) => t.broadcastId)))];
  const { stats: broadcastStats } = fetchBroadcastStats(broadcastIds);

  mkdirSync(HISTORY_DIR, { recursive: true });
  const rows = [];
  const playsWarnings = [];
  for (const show of shows) {
    const metrics = buildShowMetrics(show, ytStats, xStats, broadcastStats);

    // Per-target plays bookkeeping (F-4): status enum + high-water mark.
    //   ok               — broadcast pull succeeded this run
    //   stale-high-water — previously had plays, current pull failed/expired
    //   none             — no broadcast exists for this target (latched)
    //   unresolved       — no broadcast id yet, or id known but never pulled
    for (const t of show.targets) {
      if (t.kind !== "x") continue;
      const set = (status) => {
        if (t.playsStatus !== status) {
          t.playsStatus = status;
          registryDirty = true;
        }
      };
      if (t.role === "promo" || t.playsStatus === "none") {
        set("none");
        continue;
      }
      if (!t.broadcastId) {
        set("unresolved");
        continue;
      }
      const bs = broadcastStats[t.broadcastId];
      if (bs) {
        if (!t.playsHighWater || bs.views >= t.playsHighWater.value) {
          t.playsHighWater = { value: bs.views, asOf: now };
          registryDirty = true;
        }
        set("ok");
      } else if (t.playsHighWater) {
        set("stale-high-water");
        playsWarnings.push(
          `WARN plays pull failed for ${show.slug} x:${t.account} (broadcast ${t.broadcastId}) — reporting high water ${t.playsHighWater.value.toLocaleString("en-US")} as of ${fmtShort(t.playsHighWater.asOf)}`
        );
      } else {
        set("unresolved");
      }
    }

    const ytViews = youtubeViewsForDisplay(metrics);
    let xReach = 0;
    for (const [k, m] of Object.entries(metrics)) {
      if (k.startsWith("x:")) xReach += m.views || 0;
    }
    const histPath = join(HISTORY_DIR, `${show.slug}.json`);
    const hist = loadJson(histPath, { slug: show.slug, title: show.title, date: show.date, snapshots: [] });
    syncPostliveMetadata(hist, show);
    const prev = hist.snapshots[hist.snapshots.length - 1];
    hist.snapshots.push({ ts: now, metrics });
    saveJson(histPath, hist);
    rows.push({
      show,
      metrics,
      ytViews,
      xReach,
      plays: playsSummary(show, metrics),
      deltaYt: prev ? youtubeDeltaForDisplay(metrics, prev.metrics) : null,
    });
  }
  if (registryDirty) saveJson(REGISTRY_PATH, registry);

  renderVault(rows, now, errors);
  for (const w of playsWarnings) console.log(w);
  console.log(
    `postlive: snapshotted ${rows.length} show(s), ${ytIds.length} YT videos, ${xIds.length} X posts` +
      (errors.length ? ` — WARN ${errors.join("; ")}` : "")
  );
}

// Render an episode's X-plays summary: real number, partiality, staleness.
// Never renders absence as 0.
function playsCell(p) {
  if (!p || p.value == null) return "–";
  let s = num(p.value);
  if (p.partial) s += ` ◐ ${p.have}/${p.total}`;
  if (p.stale && p.asOf) s += ` (as of ${fmtShort(p.asOf)})`;
  return s;
}

function signedNum(d) {
  return d === null || d === undefined ? "–" : `${d >= 0 ? "+" : ""}${num(d)}`;
}

// Total views = YT views + X broadcast plays (both video playback events;
// CARD-RULING-2026-08-21). X impressions are exposure and never included.
// Coverage markers survive: a partial sum is never presented as a whole.
export function totalViewsCell(ytViews, p) {
  if (!Number.isFinite(ytViews)) {
    if (p?.value == null) return "–";
    let xOnly = `${num(p.value)} (X only)`;
    if (p.partial) xOnly += ` ◐ ${p.have}/${p.total}`;
    else if (p.stale && p.asOf) xOnly += ` (as of ${fmtShort(p.asOf)})`;
    return xOnly;
  }
  const v = ytViews + (p?.value ?? 0);
  let s = num(v);
  if (!p || p.value == null) s += " (YT only)";
  else if (p.partial) s += ` ◐ ${p.have}/${p.total}`;
  else if (p.stale && p.asOf) s += ` (as of ${fmtShort(p.asOf)})`;
  return s;
}

function renderVault(rows, now, errors) {
  if (!existsSync(LOG_PATH)) throw new Error(`log file missing: ${LOG_PATH}`);
  const content = readFileSync(LOG_PATH, "utf8");
  const bi = content.indexOf(BEGIN);
  const ei = content.indexOf(END);
  if (bi === -1 || ei === -1) throw new Error("vault log missing POSTLIVE markers");

  rows.sort((a, b) => (a.show.date < b.show.date ? 1 : -1));
  const lines = [];
  lines.push("");
  lines.push(`_Last snapshot: ${now}${errors.length ? ` — partial (${errors.join("; ")})` : ""}_`);
  lines.push("");
  lines.push("_Units: Total views = YT views + X broadcast plays (both video playback; ◐ = partial plays coverage). X reach = post impressions (exposure), never included in views._");
  lines.push("");
  lines.push(`| Date | Show | Total views | ${COLUMNS.map((c) => c.label).join(" | ")} | Other reach | YT views | X reach | X plays | Δ YT day |`);
  lines.push(`|------|------|-------|${COLUMNS.map(() => "------").join("|")}|-------|-------|-------|-------|-------|`);
  for (const r of rows) {
    const cols = COLUMNS.map((c) => num(destinationViewsForDisplay(r.metrics, c.key)));
    const otherKeys = Object.keys(r.metrics).filter((k) => !COLUMNS.some((c) => c.key === k));
    const other = otherKeys.length ? num(otherKeys.reduce((a, k) => a + r.metrics[k].views, 0)) : "–";
    lines.push(
      `| ${r.show.date} | ${r.show.title.replace(/\|/g, "/").slice(0, 50)} | ${totalViewsCell(r.ytViews, r.plays)} | ${cols.join(" | ")} | ${other} | ${num(r.ytViews)} | ${num(r.xReach)} | ${playsCell(r.plays)} | ${signedNum(r.deltaYt)} |`
    );
  }
  lines.push("");

  const next = content.slice(0, bi + BEGIN.length) + "\n" + lines.join("\n") + content.slice(ei);
  writeFileSync(LOG_PATH, next);
}

// --- weekly report (stdout, Slack-friendly plain text) ---
// Unit discipline: YT views, X reach (impressions), and X broadcast plays are
// three different units. Reported side by side, never summed together.

function snapshotUnit(snap, prefix) {
  return Object.entries(snap.metrics).reduce(
    (a, [k, m]) => a + (k.startsWith(prefix) ? m.views || 0 : 0),
    0
  );
}

function snapshotPlays(snap) {
  let sum = null;
  for (const m of Object.values(snap.metrics)) {
    if (m.plays != null) sum = (sum ?? 0) + m.plays;
  }
  return sum;
}

function closestSnapshotBefore(snapshots, cutoffMs) {
  let best = null;
  for (const s of snapshots) {
    const t = Date.parse(s.ts);
    if (t <= cutoffMs && (!best || t > Date.parse(best.ts))) best = s;
  }
  return best;
}

async function report(args) {
  const registry = loadJson(REGISTRY_PATH, { shows: [] });
  const includeAll = args.includes("--all");
  const cutoff = Date.now() - TRACK_WINDOW_DAYS * 86400000;
  const shows = registry.shows.filter(
    (s) => s.active !== false && (includeAll || Date.parse(s.date) >= cutoff)
  );
  if (!shows.length) {
    console.log("Post-live weekly: no shows in the tracking window.");
    return;
  }
  const weekAgo = Date.now() - 7 * 86400000;
  const lines = [`Post-live watch report — week of ${new Date().toLocaleDateString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric", year: "numeric" })}`];
  lines.push("Units: Total views = YT views + X broadcast plays (both video playback). X reach = post impressions (exposure), never included in views.");
  const sorted = [...shows].sort((a, b) => (a.date < b.date ? 1 : -1));
  const grand = { yt: 0, ytComplete: true, dYt: 0, reach: 0, dReach: 0, plays: null, playsPartial: false };
  let anyBaseline = false;
  for (const show of sorted) {
    const hist = loadJson(join(HISTORY_DIR, `${show.slug}.json`), null);
    if (!hist || !hist.snapshots.length) {
      lines.push(`\n${show.title} (${show.date}): no snapshots yet`);
      continue;
    }
    const latest = hist.snapshots[hist.snapshots.length - 1];
    const baseline = closestSnapshotBefore(hist.snapshots, weekAgo);
    const yt = youtubeViewsForDisplay(latest.metrics);
    const reach = snapshotUnit(latest, "x:");
    const plays = playsSummary(show, latest.metrics);
    if (Number.isFinite(yt)) grand.yt += yt;
    else grand.ytComplete = false;
    grand.reach += reach;
    if (plays.value != null) {
      grand.plays = (grand.plays ?? 0) + plays.value;
      if (plays.partial || plays.stale) grand.playsPartial = true;
    }
    if (plays.value == null) grand.playsPartial = true; // grand total is missing this episode's plays
    const dYt = baseline ? youtubeDeltaForDisplay(latest.metrics, baseline.metrics) : null;
    const dReach = baseline ? reach - snapshotUnit(baseline, "x:") : null;
    if (dYt !== null) {
      grand.dYt += dYt;
      grand.dReach += dReach;
      anyBaseline = true;
    }
    const wk = (d) => (d === null ? "first week tracked" : `${signedNum(d)} this week`);
    const ytWeek = yt == null ? "no reading yet" : wk(dYt);
    lines.push(`\n${show.title} (${show.date})`);
    lines.push(
      `  Total views ${totalViewsCell(yt, plays)} (YT ${num(yt)} + X plays ${plays.value == null ? "–" : num(plays.value)}) · YT ${ytWeek} · X reach ${num(reach)} (${wk(dReach)})`
    );
    for (const c of COLUMNS) {
      if (!Object.hasOwn(latest.metrics, c.key)) continue;
      const cur = destinationViewsForDisplay(latest.metrics, c.key);
      const prev = baseline ? destinationViewsForDisplay(baseline.metrics, c.key) : null;
      const d = Number.isFinite(cur) && Number.isFinite(prev) ? cur - prev : null;
      lines.push(
        `  • ${c.label}: ${num(cur)}${d === null ? "" : ` (${signedNum(d)})`}`
      );
    }
  }
  const allViews = grand.ytComplete
    ? `${num(grand.yt + (grand.plays ?? 0))}${grand.playsPartial ? " ◐ some episodes' plays partial/stale/missing" : ""}`
    : "– (some YouTube views missing)";
  const allYt = grand.ytComplete ? num(grand.yt) : "– (some episodes missing)";
  lines.push(
    `\nAll tracked shows — Total views: ${allViews} · YT: ${allYt}${grand.ytComplete && anyBaseline ? ` (${signedNum(grand.dYt)} this week)` : ""} · X plays: ${grand.plays == null ? "–" : num(grand.plays)} · X reach: ${num(grand.reach)}${anyBaseline ? ` (${signedNum(grand.dReach)} this week)` : ""}.`
  );
  if (args.includes("--trends")) {
    try {
      const mod = await import(new URL("../../tools/dive-analytics/build-data.mjs", import.meta.url));
      lines.push(mod.trendsText(mod.computeAll()));
    } catch (err) {
      lines.push(`\nTrends: unavailable (${err.message})`);
    }
  }
  console.log(lines.join("\n"));
}

function list() {
  const registry = loadJson(REGISTRY_PATH, { shows: [] });
  if (!registry.shows.length) return console.log("postlive: registry empty");
  for (const s of registry.shows) {
    console.log(
      `${s.slug}  active=${s.active !== false}  targets=${s.targets.map((t) => targetKey(t)).join(",")}`
    );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = { register, snapshot, list, report }[cmd || "snapshot"];
  if (!run) {
    process.stderr.write("usage: postlive-track.mjs [register|snapshot|list] ...\n");
    process.exit(2);
  }
  Promise.resolve(run(rest)).catch((err) => {
    process.stderr.write(`postlive: ${err.message}\n`);
    process.exit(1);
  });
}
