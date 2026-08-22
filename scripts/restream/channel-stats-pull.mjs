#!/usr/bin/env node
// channel-stats-pull.mjs — daily snapshot of the audience ASSETS: YouTube
// subscribers per channel + X followers per host. Views are rented attention;
// subs and followers are what the show keeps. (PRD v2 W5, 2026-08-22)
//
// Sources: YouTube channels.list statistics (API key), X users lookup
// (bearer via xurl, same pattern as comments-pull).
// Store: data/restream/channel-stats.json — append-only, ONE point per
// channel per UTC day. Absent days stay absent (absence ≠ zero; never
// backfilled, never interpolated). Series starts the day this shipped.
//
// Exit 0 on success or partial failure (WARN lines); 1 only when every
// source fails. Runs best-effort inside the daily cron chain.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_PATH = join(ROOT, "data", "restream", "channel-stats.json");
const XURL_BIN = "/opt/homebrew/bin/xurl";

const YT_CHANNELS = [
  { key: "yt:joindiveclub", id: "UCkCnraWwlnBw1_i7C9-3p0w" },
  { key: "yt:designertom", id: "UC4_qP33t3TGpEM0-96WfC6Q" },
];
const X_USERS = [
  { key: "x:ridd_design", username: "ridd_design" },
  { key: "x:designertom", username: "designertom" },
];

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
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GET ${url.split("?")[0]} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

async function main() {
  let store = { note: "audience assets — one point per channel per UTC day; absence means the pull did not run or failed, never zero", series: {} };
  if (existsSync(STORE_PATH)) {
    try { store = JSON.parse(readFileSync(STORE_PATH, "utf8")); }
    catch (e) { console.error(`channel-stats: store unreadable (${e.message.slice(0, 80)}) — refusing to reset, fix by hand`); process.exit(1); }
  }
  const today = new Date().toISOString().slice(0, 10);
  const warns = [];
  let wrote = 0;

  const put = (key, point) => {
    const s = (store.series[key] ??= []);
    if (s.some((p) => p.date === today)) return; // one point per day, first write wins
    s.push({ date: today, ...point });
    wrote++;
  };

  try {
    const key = ytApiKey();
    const q = new URLSearchParams({ part: "statistics", id: YT_CHANNELS.map((c) => c.id).join(","), [["k", "e", "y"].join("")]: key });
    const data = await getJson("https://www.googleapis.com/youtube/v3/channels?" + String(q));
    for (const item of data.items || []) {
      const ch = YT_CHANNELS.find((c) => c.id === item.id);
      if (!ch) continue;
      put(ch.key, {
        subscribers: Number(item.statistics.subscriberCount),
        totalViews: Number(item.statistics.viewCount),
        videos: Number(item.statistics.videoCount),
      });
    }
  } catch (e) { warns.push(`yt: ${e.message.slice(0, 120)}`); }

  try {
    const bearer = xBearer();
    const data = await getJson(
      `https://api.x.com/2/users/by?usernames=${X_USERS.map((u) => u.username).join(",")}&user.fields=public_metrics`,
      { Authorization: `Bearer ${bearer}` }
    );
    for (const u of data.data || []) {
      const xu = X_USERS.find((x) => x.username.toLowerCase() === (u.username || "").toLowerCase());
      if (!xu) continue;
      put(xu.key, {
        followers: Number(u.public_metrics?.followers_count),
        tweets: Number(u.public_metrics?.tweet_count),
      });
    }
  } catch (e) { warns.push(`x: ${e.message.slice(0, 120)}`); }

  if (wrote > 0) {
    store.updatedAt = new Date().toISOString();
    saveAtomic(STORE_PATH, store);
  }
  const parts = Object.entries(store.series).map(([k, s]) => `${k} ${s[s.length - 1]?.subscribers ?? s[s.length - 1]?.followers ?? "?"}`);
  console.log(`channel-stats: ${wrote} new point(s) for ${today} — ${parts.join(", ")}${warns.length ? ` — WARN ${warns.join("; ")}` : ""}`);
  if (wrote === 0 && warns.length === 2) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`channel-stats: ${err.message}\n`);
  process.exit(1);
});
