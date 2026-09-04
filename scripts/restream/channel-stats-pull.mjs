#!/usr/bin/env node
// channel-stats-pull.mjs — daily snapshot of the audience ASSETS: YouTube
// subscribers per channel + X followers per host. Views are rented attention;
// subs and followers are what the show keeps. (PRD v2 W5, 2026-08-22)
//
// Sources: YouTube channels.list statistics (API key), X users lookup
// (bearer via xurl, same pattern as comments-pull).
// Store: data/restream/channel-stats.json — append-only, ONE point per
// channel per Phoenix day (legacy UTC dates remain unchanged). Absent days stay absent (absence ≠ zero; never
// backfilled, never interpolated). Series starts the day this shipped.
//
// Exit 0 only when all four registered accounts return complete statistics.
// Partial checks retain prior series/current facts and save failed evidence.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile, withSourceLock, fetchJson, readingEnvelope, phoenixDateKey } from "../../tools/dive-analytics/source-io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_PATH = join(ROOT, "data", "restream", "channel-stats.json");
const XURL_BIN = "/opt/homebrew/bin/xurl";

export const YT_CHANNELS = [
  { key: "yt:joindiveclub", id: "UCkCnraWwlnBw1_i7C9-3p0w" },
  { key: "yt:designertom", id: "UC4_qP33t3TGpEM0-96WfC6Q" },
];
export const X_USERS = [
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
function knownCount(value, label) {
  if (value === null || value === undefined || value === "" || !/^\d+$/.test(String(value))) throw new Error(`${label} is unavailable or invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

export async function runChannelStats({ root = ROOT, now = new Date().toISOString(), apiKey, bearer, fetchImpl = fetch, log = console.log } = {}) {
  const path = join(root, "data", "restream", "channel-stats.json");
  return withSourceLock(path, async () => {
    const store = readJsonFile(path, { fallback: { note: "New points use Phoenix calendar dates; legacy dates retain their original UTC meaning. Missing days are never backfilled.", series: {} } });
    if (!store.series || typeof store.series !== "object" || Array.isArray(store.series)) throw new Error("channel history is invalid");
    const pulledAt = new Date(now).toISOString();
    const date = phoenixDateKey(pulledAt);
    const staged = {};
    const sources = [];
    const failures = [];
    try {
      if (!apiKey) throw new Error("YouTube credential is unavailable");
      const q = new URLSearchParams({ part: "statistics", id: YT_CHANNELS.map((channel) => channel.id).join(","), key: apiKey });
      const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?${q}`, { label: "YouTube channel statistics", fetchImpl });
      if (!Array.isArray(data.items) || data.items.length !== YT_CHANNELS.length) throw new Error("YouTube did not return every registered channel");
      const ids = new Set(data.items.map((item) => item.id));
      if (ids.size !== data.items.length || YT_CHANNELS.some((channel) => !ids.has(channel.id))) throw new Error("YouTube returned unexpected channel IDs");
      for (const channel of YT_CHANNELS) {
        const item = data.items.find((candidate) => candidate.id === channel.id);
        const reading = readingEnvelope({ source: "youtube-channel", episode: null, objectId: channel.id, pulledAt });
        staged[channel.key] = { date, subscribers: knownCount(item.statistics?.subscriberCount, "subscriber count"), totalViews: knownCount(item.statistics?.viewCount, "channel views"), videos: knownCount(item.statistics?.videoCount, "channel videos"), reading };
        sources.push(reading);
      }
    } catch (error) { failures.push(error.message); }
    try {
      if (!bearer) throw new Error("X credential is unavailable");
      const data = await fetchJson(`https://api.x.com/2/users/by?usernames=${X_USERS.map((user) => user.username).join(",")}&user.fields=public_metrics`, { label: "X follower statistics", headers: { Authorization: `Bearer ${bearer}` }, fetchImpl });
      if (data.errors?.length || !Array.isArray(data.data) || data.data.length !== X_USERS.length) throw new Error("X did not return every registered account");
      const names = data.data.map((user) => user.username?.toLowerCase());
      if (new Set(names).size !== names.length || X_USERS.some((user) => !names.includes(user.username))) throw new Error("X returned unexpected accounts");
      for (const account of X_USERS) {
        const user = data.data.find((candidate) => candidate.username.toLowerCase() === account.username);
        if (typeof user.id !== "string" || !user.id) throw new Error("X account ID is missing");
        const reading = readingEnvelope({ source: "x-account", episode: null, objectId: user.id, pulledAt });
        staged[account.key] = { date, followers: knownCount(user.public_metrics?.followers_count, "X followers"), tweets: knownCount(user.public_metrics?.tweet_count, "X post count"), reading };
        sources.push(reading);
      }
    } catch (error) { failures.push(error.message); }
    store.capture = { checkedAt: pulledAt, state: failures.length ? "failed" : "ready", sources, errors: failures };
    if (failures.length) {
      atomicWriteJson(path, store);
      throw new Error(`channel capture incomplete — ${failures.join("; ")}`);
    }
    let wrote = 0;
    for (const [key, point] of Object.entries(staged)) {
      const series = store.series[key] ??= [];
      if (!Array.isArray(series)) throw new Error(`channel history is invalid for ${key}`);
      if (!series.some((prior) => prior.date === date)) { series.push(point); wrote++; }
    }
    store.current = staged;
    store.updatedAt = pulledAt;
    atomicWriteJson(path, store);
    log(`channel-stats: ${wrote} new Phoenix-day point(s); all four registered sources complete`);
    return { wrote, date };
  });
}
async function main() {
  let apiKey = null, bearer = null;
  try { apiKey = ytApiKey(); } catch { /* The source receipt records missing credentials. */ }
  try { bearer = xBearer(); } catch { /* The source receipt records missing credentials. */ }
  return runChannelStats({ apiKey, bearer });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`channel-stats: ${error.message}\n`); process.exit(1); });
}
