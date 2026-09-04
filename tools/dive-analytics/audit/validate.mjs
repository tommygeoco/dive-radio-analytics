#!/usr/bin/env node
// validate.mjs — read-only validation gate for the Dive Radio analytics pipeline.
// No model calls, no network, no writes. Exit 0 = all checks pass, exit 1 = failure.
//
// Run:            node tools/dive-analytics/audit/validate.mjs
// Monday gate:    insert into restream-postlive-weekly payload between build and
//                 report:  ... && node tools/dive-analytics/audit/validate.mjs && ...
//                 A failure then blocks the Slack trends report instead of shipping
//                 numbers that fail unit/freshness/consistency checks.
//
// Checks:
//   1. unit sanity        — X plays require resolved-broadcast provenance;
//                           native tweet media and impressions can never enter plays,
//                           no plays on YT, and absence is never stored as zero
//   2. monotonic views    — cumulative views never decrease per destination
//   3. late-reg flags     — partialHistory starts at the first positive YouTube
//                            read on a later Phoenix date; air date is current only
//                           reading after premiere (>5d); pre-air and startup-zero
//                           rows are evidence, not day one
//   4. freshness          — newest snapshot and generatedAt both < 26h old,
//                           build not older than newest snapshot
//   5. roster consistency — registry active dive-radio shows == data.json episodes,
//                           ep numbers sequential in premiere order
//   6. publish integrity  — public repo data.json/data.js byte-match the source
//   7. rebuild currency   — computeAll() over current history reproduces data.json
//                           (catches "snapshot ran but build/publish didn't")
//   Warnings (non-fatal): unresolved broadcast latches, resolved-broadcast targets
//   missing plays in the latest snapshot, snapshot gaps > 26h in the last 7 days.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // tools/dive-analytics/audit
const TOOL = join(HERE, "..");
const ROOT = join(TOOL, "..", "..");
const REGISTRY = join(ROOT, "data", "restream", "postlive-registry.json");
const HISTORY = join(ROOT, "data", "restream", "postlive");
const EVENTS = join(ROOT, "data", "restream", "events");
const TRANSCRIPTS = join(ROOT, "transcripts");
const DAY = 86400000;
const FRESH_MS = 26 * 3600000;
const PARTIAL_DAYS = 5; // must match PARTIAL_THRESHOLD_DAYS in build-data.mjs

let failures = 0;
let warnings = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
// PRD v11 rule 24 / W36 — two tiers. `fail` re-derives a shipped number,
// definition, grounding, absence, freshness, or store integrity from the
// stores: it always blocks. `drift` inspects source (index.html, a script,
// a prompt, chain.json) or copy: in strict mode (a person, the pre-push
// hook) it blocks like fail; in publish mode (`--publish`, the chain's two
// validate steps) it is reported, counted, and never withholds the day's
// data — the chain queues one Slack line naming it.
const publishMode = process.argv.includes("--publish");
let drifts = 0;
const drift = (m) => { drifts++; if (!publishMode) failures++; console.log(`DRIFT ${m}`); };
const warn = (m) => { warnings++; console.log(`WARN  ${m}`); };
const ok = (m) => console.log(`ok    ${m}`);

const data = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const eps = data.episodes;

function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + 7 * 3600000;
}

// --- 1. unit sanity ---
{
  let bad = 0;
  for (const e of eps) {
    const show = registry.shows.find((s) => s.slug === e.slug);
    for (const s of e.snapshots) {
      for (const [k, m] of Object.entries(s.byDest)) {
        if (k.startsWith("yt:") && m.plays != null) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays field on a YouTube destination`); }
        if (k.startsWith("x:") && m.plays != null) {
          if (m.plays === 0) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays recorded as 0 — unavailable must be absent, never zero`); }
          if (m.playsSource !== "x-broadcast") { bad++; fail(`${e.slug} ${s.ts} ${k}: plays lack x-broadcast provenance`); }
          const account = k.slice(2);
          const resolved = (show?.targets || []).some((t) => t.kind === "x" && t.account === account && t.role !== "promo" && t.broadcastId);
          if (!resolved) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays exist without a resolved X broadcast for that account`); }
          // conflation heuristic: broadcast plays exactly equal to post impressions
          if (m.plays > 100 && m.plays === m.views) { bad++; fail(`${e.slug} ${s.ts} ${k}: plays === impressions (${m.plays}) — unit conflation`); }
        }
      }
    }
    if (e.latest.xPlays === 0) { bad++; fail(`${e.slug}: latest.xPlays is 0 — must be null when unavailable`); }
  }
  // Raw capture provenance: historical broadcast rows predate playsSource but
  // carry peakConcurrent only because the broadcast extractor wrote them.
  // Native tweet media lived only in detail.plays and is always forbidden.
  for (const show of registry.shows) {
    const path = join(HISTORY, `${show.slug}.json`);
    if (!existsSync(path)) continue;
    const history = JSON.parse(readFileSync(path, "utf8"));
    for (const snapshot of history.snapshots || []) {
      for (const [key, metric] of Object.entries(snapshot.metrics || {})) {
        if (!key.startsWith("x:")) continue;
        if (metric.detail?.plays != null) {
          bad++; fail(`${show.slug} ${snapshot.ts} ${key}: native tweet-media plays are present in detail`);
        }
        if (metric.playsSource != null && metric.playsSource !== "x-broadcast") {
          bad++; fail(`${show.slug} ${snapshot.ts} ${key}: illegal playsSource "${metric.playsSource}"`);
        }
        if (metric.plays == null) continue;
        const account = key.slice(2);
        const resolved = (show.targets || []).some((t) => t.kind === "x" && t.account === account && t.role !== "promo" && t.broadcastId);
        const proven = metric.playsSource === "x-broadcast" || Object.hasOwn(metric, "peakConcurrent");
        if (!resolved) { bad++; fail(`${show.slug} ${snapshot.ts} ${key}: raw plays exist without a resolved X broadcast`); }
        if (!proven) { bad++; fail(`${show.slug} ${snapshot.ts} ${key}: raw plays have no broadcast-extractor provenance`); }
      }
    }
  }
  if (!bad) ok("unit sanity: every X play is broadcast-sourced; native tweet media, impressions, YT plays, and zero placeholders are excluded");
}

// --- 1b. unit separation + Total views definition (F-3/F-7 + CARD-RULING) ---
// Total views = ytTotal + xPlays (both video playback). xImpressions is
// exposure and must NEVER leak into any views total, under any field name.
{
  let bad = 0;
  const BL = await import(join(TOOL, "baselines.mjs"));
  for (const e of eps) {
    if ("total" in e.latest) { bad++; fail(`${e.slug}: latest.total exists — mixed impressions+views field must not ship`); }
    const latestSnap = e.snapshots.at(-1);
    const latestYtSnap = BL.latestCurrentYtSnapshot(e);
    const expectedYt = BL.ytViewsOf(latestYtSnap);
    if (e.latest.ytTotal !== expectedYt) { bad++; fail(`${e.slug}: latest.ytTotal ${e.latest.ytTotal} does not match the latest confirmed current YouTube reading (${expectedYt})`); }
    if (e.latest.youtubeAsOf !== (latestYtSnap?.ts ?? null) || e.latest.youtubeStale !== !!(latestYtSnap && latestYtSnap.ts !== latestSnap.ts)) {
      bad++; fail(`${e.slug}: latest YouTube reading time or old-reading marker does not match history`);
    }
    if (e.latest.xImpressions == null) { bad++; fail(`${e.slug}: latest.xImpressions missing`); }
    const info = e.latest.xPlaysInfo;
    if (info && info.value !== e.latest.xPlays) { bad++; fail(`${e.slug}: xPlays (${e.latest.xPlays}) != xPlaysInfo.value (${info.value})`); }
    // Total views: canonical definition, coverage-marker parity, no smuggled reach
    const expectedTotal = e.latest.ytTotal != null || e.latest.xPlays != null
      ? (e.latest.ytTotal ?? 0) + (e.latest.xPlays ?? 0)
      : null;
    if (e.latest.totalViews !== expectedTotal) { bad++; fail(`${e.slug}: totalViews (${e.latest.totalViews}) != available ytTotal + xPlays (${expectedTotal}) — definition violated`); }
    if (e.latest.totalViews != null && e.latest.ytTotal != null) {
      if (
        e.latest.totalViews - e.latest.ytTotal === e.latest.xImpressions &&
        e.latest.xImpressions > 0 &&
        e.latest.xImpressions !== e.latest.xPlays
      ) { bad++; fail(`${e.slug}: totalViews appears to include xImpressions — impressions smuggled into the plays slot`); }
    }
    const tvi = e.latest.totalViewsInfo;
    if (!tvi) { bad++; fail(`${e.slug}: totalViewsInfo missing — coverage markers cannot render`); continue; }
    if (info && (tvi.partial !== info.partial || tvi.stale !== info.stale)) { bad++; fail(`${e.slug}: totalViewsInfo partial/stale disagrees with xPlaysInfo — marker state dropped between build and render`); }
    const youtubeMissing = e.latest.ytTotal == null;
    const xMissing = (info?.total ?? 0) > 0 && e.latest.xPlays == null;
    const missing = e.latest.totalViews == null;
    const youtubeStale = !!e.latest.youtubeStale;
    const incomplete = youtubeMissing || youtubeStale || xMissing || !!info?.partial || !!info?.stale;
    if (tvi.includesYoutube !== !youtubeMissing || tvi.youtubeMissing !== youtubeMissing || tvi.youtubeStale !== youtubeStale || tvi.youtubeAsOf !== (latestYtSnap?.ts ?? null) || tvi.missing !== missing || tvi.incomplete !== incomplete) {
      bad++; fail(`${e.slug}: totalViewsInfo does not state which view sources are missing`);
    }
    if (incomplete && (typeof tvi.reason !== "string" || !tvi.reason.trim())) { bad++; fail(`${e.slug}: incomplete total views have no plain missing-data reason`); }
    if (!incomplete && tvi.reason != null) { bad++; fail(`${e.slug}: complete total views carry a missing-data reason`); }
  }
  for (const p of data.showTrend?.cumulativeAllEpisodes || []) {
    if ("total" in p) { bad++; fail(`showTrend.cumulativeAllEpisodes carries mixed-unit 'total' — must be per-unit (ytViews/xReach)`); }
    if ("totalViews" in p) { bad++; fail(`showTrend.cumulativeAllEpisodes carries 'totalViews' — plays have no history; a blended time series is fabricated`); }
    if (p.ytViews == null || p.xReach == null) { bad++; fail(`showTrend.cumulativeAllEpisodes entry missing per-unit fields`); }
  }
  if (!bad) ok("unit separation: totalViews uses available YouTube views and X plays; missing sources stay null and named");
}

// --- 1c. playsStatus/high-water schema (F-4) ---
{
  let bad = 0;
  try {
    execFileSync(process.execPath, [join(HERE, "x-broadcast-plays.test.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    bad++; fail(`plays fixture failed — ${String(err.stderr || err.message).split("\n").find((l) => /AssertionError|Error/.test(l)) || err.message}`);
  }
  const LEGAL = new Set(["ok", "stale-high-water", "none", "unresolved"]);
  for (const show of registry.shows) {
    if (show.active === false) continue;
    const e = eps.find((x) => x.slug === show.slug);
    const latest = e ? e.snapshots[e.snapshots.length - 1] : null;
    for (const t of show.targets || []) {
      if (t.kind !== "x") continue;
      if (t.playsStatus != null && !LEGAL.has(t.playsStatus)) { bad++; fail(`${show.slug} x:${t.account}: illegal playsStatus "${t.playsStatus}"`); }
      if (t.playsHighWater && (typeof t.playsHighWater.value !== "number" || !t.playsHighWater.asOf)) { bad++; fail(`${show.slug} x:${t.account}: malformed playsHighWater`); }
      if (["ok", "stale-high-water"].includes(t.playsStatus) && !t.broadcastId) { bad++; fail(`${show.slug} x:${t.account}: ${t.playsStatus} requires a resolved broadcastId`); }
      if (t.playsHighWater && !t.broadcastId) { bad++; fail(`${show.slug} x:${t.account}: broadcast high-water exists without a broadcastId`); }
      if (t.role === "promo" && (t.broadcastId || t.playsHighWater || t.playsStatus !== "none")) { bad++; fail(`${show.slug} x:${t.account}: promo target carries broadcast state`); }
      if (t.playsStatus === "ok" && latest && latest.byDest[`x:${t.account}`]?.plays == null) { bad++; fail(`${show.slug} x:${t.account}: playsStatus "ok" but latest snapshot has NO plays — silent absence`); }
      if (t.playsStatus === "stale-high-water" && !t.playsHighWater) { bad++; fail(`${show.slug} x:${t.account}: stale-high-water without a persisted high-water mark`); }
    }
  }
  if (!bad) ok("plays schema: broadcast-only fixture green; statuses, resolved IDs, provenance, and high-water marks agree");
}

// --- 2. monotonic cumulative views ---
{
  let bad = 0;
  for (const e of eps) {
    const last = {};
    for (const s of e.snapshots) {
      for (const [k, m] of Object.entries(s.byDest)) {
        if (last[k] != null && m.views < last[k]) {
          const drop = last[k] - m.views;
          if (drop > Math.max(50, last[k] * 0.02)) { bad++; fail(`${e.slug} ${k}: views dropped ${last[k]} -> ${m.views} at ${s.ts}`); }
          else warn(`${e.slug} ${k}: small views dip ${last[k]} -> ${m.views} at ${s.ts} (API jitter?)`);
        }
        last[k] = m.views;
      }
    }
  }
  if (!bad) ok("monotonic: cumulative views never materially decrease");
}

// --- 3. late-reg flags present and honored ---
{
  let bad = 0;
  const BL = await import(join(TOOL, "baselines.mjs"));
  for (const e of eps) {
    const first = BL.firstYtSnapshot(e);
    const expected = first ? Date.parse(first.ts) - premiereMs(e.premiere) > PARTIAL_DAYS * DAY : null;
    const historical = BL.historicalSnapshotsOf(e);
    const currentYt = BL.latestCurrentYtSnapshot(e);
    if (historical.some((snap) => BL.phoenixDateOf(snap.ts) <= e.premiere)) { bad++; fail(`${e.slug}: an air-date snapshot entered historical selection`); }
    if (e.partialHistory !== expected) { bad++; fail(`${e.slug}: partialHistory=${e.partialHistory}, expected ${expected} from the first positive next-date YouTube reading${first ? ` (${first.ts})` : " (none yet)"}`); }
    if (e.historyReady !== (BL.ytSnapshotsOf(e).length > 0)) { bad++; fail(`${e.slug}: historyReady disagrees with the next-date reading rule`); }
    if (!e.historyReady && e.historyReason !== BL.NOTES.noFullDayReading) { bad++; fail(`${e.slug}: waiting history has no plain full-day reason`); }
    if (e.historyReady && e.historyReason != null) { bad++; fail(`${e.slug}: ready history still carries a waiting reason`); }
    if (e.partialHistory == null && e.metrics.week1Velocity !== null) { bad++; fail(`${e.slug}: no YouTube reading exists but week1Velocity=${e.metrics.week1Velocity}`); }
    const expectedWaitReason = currentYt ? BL.NOTES.noFullDayReading : BL.NOTES.noYtReading;
    if (e.partialHistory == null && e.metrics.week1Note !== expectedWaitReason) { bad++; fail(`${e.slug}: unknown tracking start has the wrong missing-data reason`); }
    if (e.partialHistory && e.metrics.week1Velocity !== null) { bad++; fail(`${e.slug}: late-reg episode has week1Velocity=${e.metrics.week1Velocity} — must be excluded`); }
    if (e.partialHistory && !/partial/i.test(e.metrics.week1Note || "")) { bad++; fail(`${e.slug}: late-reg episode missing exclusion note`); }
    if (!historical.length) {
      const anomaly = data.baselines?.anomaly?.[e.slug];
      if (anomaly?.flagged || Object.values(anomaly?.units || {}).some((unit) => unit?.value != null)) {
        bad++; fail(`${e.slug}: air-date values entered anomaly history`);
      }
    }
  }
  if (!bad) ok("day-one gate: air-date rows remain current-only; history starts with a positive reading on a later Phoenix date");
}

// --- 3a. Restream live-session provenance + air-day isolation ---
// A live event is an age-free, finished-session fact, so it may appear on air
// day. It must still come straight from one archived Restream event, while the
// same episode stays out of every historical comparison until a later-date
// YouTube reading exists.
{
  let bad = 0;
  const BL = await import(join(TOOL, "baselines.mjs"));
  let liveBuild = null;
  try { liveBuild = await import(join(TOOL, "build-data.mjs")); }
  catch (error) { bad++; fail(`live sessions: builder could not load — ${error.message}`); }
  const archive = [];
  if (!existsSync(EVENTS)) {
    if (eps.some((e) => e.live)) { bad++; fail("live sessions: data.json contains live readings but the Restream event archive is missing"); }
  } else {
    for (const file of readdirSync(EVENTS).filter((name) => name.endsWith(".json")).sort()) {
      try {
        const event = JSON.parse(readFileSync(join(EVENTS, file), "utf8"));
        if (!event?.event?.id || !event?.event?.startedAt || (!event?.viewers && !event?.messages)) {
          bad++; fail(`live sessions: ${file} is missing its event id, start time, or analytics`);
          continue;
        }
        if (file !== `${event.event.id}.json`) { bad++; fail(`live sessions: ${file} does not match stored event id ${event.event.id}`); }
        archive.push({ file, event });
      } catch (error) {
        bad++; fail(`live sessions: ${file} is not valid JSON — ${error.message}`);
      }
    }
  }

  const showBySlug = new Map(registry.shows.map((show) => [show.slug, show]));
  const targetIdentity = (target) => {
    if (target.kind === "youtube" && target.videoId) return `youtube:${target.videoId}`;
    if (target.kind === "x" && target.role !== "promo" && target.broadcastId) return `x:${target.broadcastId}`;
    return null;
  };
  const urlIdentity = (url) => {
    const yt = String(url || "").match(/(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (yt) return `youtube:${yt[1]}`;
    const x = String(url || "").match(/(?:x|twitter)\.com\/i\/broadcasts\/([A-Za-z0-9_-]+)/);
    if (x) return `x:${x[1]}`;
    return null;
  };
  const candidatesFor = (episode) => archive.filter(({ event }) => {
    try { return liveBuild?.liveEventSlug(event, registry) === episode.slug; }
    catch (error) { bad++; fail(`live sessions: ${event.event.id} has an ambiguous registry match — ${error.message}`); return false; }
  });
  const matchesByEvent = new Map();
  const valueOf = (object, key) => Number.isFinite(object?.[key]) ? object[key] : null;
  const sameValue = (episode, got, key, source, sourceKey, where = "live") => {
    const expected = valueOf(source, sourceKey);
    const actual = got?.[key];
    if (expected == null) {
      if (actual != null) { bad++; fail(`${episode.slug}: ${where}.${key} is ${actual}, but the Restream source has no reading`); }
    } else if (actual !== expected) {
      bad++; fail(`${episode.slug}: ${where}.${key} ${actual} does not match Restream ${expected}`);
    }
  };
  const round1 = (number) => Math.round(number * 10) / 10;
  const phoenixBuildDate = new Date(Date.parse(data.generatedAt) - 7 * 3600000).toISOString().slice(0, 10);

  for (const episode of eps) {
    const matches = candidatesFor(episode);
    if (episode.premiere < phoenixBuildDate && matches.length !== 1) {
      bad++; fail(`${episode.slug}: finished episode has ${matches.length} Restream event records, expected exactly one`);
    }
    if (episode.live && matches.length !== 1) {
      bad++; fail(`${episode.slug}: exported live session traces to ${matches.length} Restream events, not exactly one`);
      continue;
    }
    if (!episode.live) {
      if (matches.length) { bad++; fail(`${episode.slug}: ${matches.length} archived Restream event(s) exist but the live session is absent from data.json`); }
      continue;
    }

    const { event: raw, file } = matches[0];
    if (matchesByEvent.has(raw.event.id)) {
      bad++; fail(`${episode.slug}: Restream event ${raw.event.id} is already attached to ${matchesByEvent.get(raw.event.id)}`);
    } else {
      matchesByEvent.set(raw.event.id, episode.slug);
    }
    const show = showBySlug.get(episode.slug);
    const started = raw.event.startedAt * 1000;
    const finished = Number.isFinite(raw.event.finishedAt) ? raw.event.finishedAt * 1000 : null;
    const viewers = raw.viewers?.total || {};
    const messages = raw.messages?.total || null;

    try {
      const projected = liveBuild.projectLiveSession(raw, registry);
      const depth = BL.liveDepthOf({ live: projected });
      const expectedLive = {
        ...projected,
        minutesPerViewer: depth?.minutesPerViewer ?? null,
        holdRate: depth?.holdRate ?? null,
      };
      if (JSON.stringify(episode.live) !== JSON.stringify(expectedLive)) {
        bad++; fail(`${episode.slug}: exported live block does not exactly rebuild from ${file}`);
      }
    } catch (error) {
      bad++; fail(`${episode.slug}: live projection failed — ${error.message}`);
    }

    sameValue(episode, episode.live, "peak", viewers, "max");
    sameValue(episode, episode.live, "avg", viewers, "mean");
    sameValue(episode, episode.live, "liveViews", viewers, "viewsTotal");
    sameValue(episode, episode.live, "watchedMin", viewers, "watchedTime");
    sameValue(episode, episode.live, "chatMessages", messages, "messagesTotal");
    sameValue(episode, episode.live, "chatters", messages, "chattersTotal");
    const expectedDuration = finished != null && finished > started ? Math.round((finished - started) / 60000) : null;
    if ((episode.live.durationMin ?? null) !== expectedDuration) {
      bad++; fail(`${episode.slug}: live.durationMin ${episode.live.durationMin} does not match ${file} (${expectedDuration})`);
    }

    const descriptorFor = (destination) => {
      const identity = urlIdentity(destination.externalUrl);
      const matchingTargets = (show?.targets || []).filter((target) => targetIdentity(target) === identity);
      if (identity && matchingTargets.length !== 1) {
        bad++; fail(`${episode.slug}: Restream channel ${destination.channelId} maps to ${matchingTargets.length} registry targets`);
      }
      const target = matchingTargets[0];
      if (identity?.startsWith("youtube:")) {
        const label = target?.account === "joindiveclub" ? "YT Dive Club" : target?.account === "designertom" ? "YT DesignerTom" : "YouTube";
        return { key: target ? `yt:${target.account}` : null, label };
      }
      if (identity?.startsWith("x:")) {
        return { key: target ? `x:${target.account}` : null, label: target ? `X @${target.account}` : "X" };
      }
      try {
        const hostname = new URL(destination.externalUrl).hostname.replace(/^www\./, "");
        const label = hostname === "linkedin.com" ? "LinkedIn" : hostname;
        return { key: hostname, label };
      } catch {
        return { key: null, label: `channel ${destination.channelId}` };
      }
    };
    const descriptors = new Map();
    for (const destination of raw.event.destinations || []) {
      descriptors.set(String(destination.channelId), descriptorFor(destination));
    }

    const hasChatSeries = Array.isArray(messages?.messagesPerMinute);
    const chatByMinute = new Map();
    for (const point of messages?.messagesPerMinute || []) {
      if (!Number.isFinite(point?.timestamp)) continue;
      chatByMinute.set(Math.round((point.timestamp - started) / 60000), valueOf(point, "messages"));
    }
    const viewersByChannelMinute = new Map();
    for (const [channelId, channel] of Object.entries(raw.viewers?.byChannel || {})) {
      if (!Array.isArray(channel?.viewersPerMinute)) continue;
      const descriptor = descriptors.get(String(channelId)) || { key: null, label: `channel ${channelId}` };
      const points = new Map();
      for (const point of channel.viewersPerMinute || []) {
        if (!Number.isFinite(point?.timestamp)) continue;
        points.set(Math.round((point.timestamp - started) / 60000), valueOf(point, "viewers"));
      }
      if (viewersByChannelMinute.has(descriptor.label)) {
        bad++; fail(`${episode.slug}: two Restream channels collapse into live series label ${descriptor.label}`);
      }
      viewersByChannelMinute.set(descriptor.label, points);
    }

    const expectedSeries = [];
    let chatTotal = hasChatSeries ? 0 : null;
    for (const point of viewers.viewersPerMinute || []) {
      if (!Number.isFinite(point?.timestamp)) continue;
      const minute = Math.round((point.timestamp - started) / 60000);
      if (minute < 0) continue;
      const chat = hasChatSeries ? (chatByMinute.get(minute) ?? 0) : null;
      if (chat != null) chatTotal += chat;
      const byChannel = {};
      for (const [label, points] of viewersByChannelMinute) byChannel[label] = points.get(minute) ?? 0;
      expectedSeries.push({ m: minute, v: valueOf(point, "viewers"), c: chat, ct: chatTotal, byChan: byChannel });
    }
    const gotSeries = Array.isArray(episode.live.series) ? episode.live.series : [];
    if (gotSeries.length !== expectedSeries.length) {
      bad++; fail(`${episode.slug}: live series has ${gotSeries.length} points, Restream has ${expectedSeries.length}`);
    }
    let seriesProblem = null;
    for (let index = 0; index < Math.min(gotSeries.length, expectedSeries.length); index++) {
      const got = gotSeries[index];
      const expected = expectedSeries[index];
      for (const key of ["m", "v", "c", "ct"]) {
        if ((got?.[key] ?? null) !== expected[key] && !seriesProblem) seriesProblem = `point ${index} ${key}`;
      }
      const labels = new Set([...Object.keys(got?.byChan || {}), ...Object.keys(expected.byChan)]);
      for (const label of labels) {
        if ((got?.byChan?.[label] ?? null) !== (expected.byChan[label] ?? null) && !seriesProblem) seriesProblem = `point ${index} channel ${label}`;
      }
    }
    if (seriesProblem) { bad++; fail(`${episode.slug}: live series does not match Restream at ${seriesProblem}`); }

    const expectedChannels = new Map();
    const rawChannelIds = new Set([
      ...Object.keys(raw.viewers?.byChannel || {}),
      ...Object.keys(raw.messages?.byChannel || {}),
    ]);
    for (const channelId of rawChannelIds) {
      const channel = raw.viewers?.byChannel?.[channelId] || null;
      const sourceMessages = raw.messages?.byChannel?.[channelId] || null;
      const values = {
        peak: valueOf(channel, "max"),
        avg: valueOf(channel, "mean"),
        views: valueOf(channel, "viewsTotal"),
        watchedMin: valueOf(channel, "watchedTime"),
        messages: valueOf(sourceMessages, "messagesTotal"),
        chatters: valueOf(sourceMessages, "chattersTotal"),
      };
      if (!Object.values(values).some((value) => Number.isFinite(value))) continue;
      const descriptor = descriptors.get(String(channelId)) || { key: null, label: `channel ${channelId}` };
      if (expectedChannels.has(descriptor.label)) { bad++; fail(`${episode.slug}: two Restream channels collapse into live row ${descriptor.label}`); }
      expectedChannels.set(descriptor.label, { ...descriptor, ...values });
    }
    const gotChannels = Array.isArray(episode.live.byChannel) ? episode.live.byChannel : [];
    const gotByLabel = new Map(gotChannels.map((channel) => [channel.label, channel]));
    if (gotByLabel.size !== gotChannels.length) { bad++; fail(`${episode.slug}: live.byChannel contains a duplicate label`); }
    if (gotByLabel.size !== expectedChannels.size) {
      bad++; fail(`${episode.slug}: live.byChannel has ${gotByLabel.size} rows, Restream has ${expectedChannels.size}`);
    }
    for (const [label, expected] of expectedChannels) {
      const got = gotByLabel.get(label);
      if (!got) { bad++; fail(`${episode.slug}: live.byChannel is missing ${label}`); continue; }
      if (got.key != null && got.key !== expected.key) { bad++; fail(`${episode.slug}: ${label} carries channel key ${got.key}, expected ${expected.key}`); }
      for (const key of ["peak", "avg", "views", "watchedMin", "messages", "chatters"]) {
        if ((got[key] ?? null) !== expected[key]) { bad++; fail(`${episode.slug}: ${label} ${key} does not match Restream`); }
      }
    }

    const expectedMinutesPerViewer = valueOf(viewers, "watchedTime") > 0 && valueOf(viewers, "viewsTotal") > 0
      ? round1(viewers.watchedTime / viewers.viewsTotal) : null;
    if ((episode.live.minutesPerViewer ?? null) !== expectedMinutesPerViewer) {
      bad++; fail(`${episode.slug}: live.minutesPerViewer does not rebuild from watched minutes and live viewers`);
    }
    const viewerSeries = expectedSeries.filter((point) => Number.isFinite(point.v));
    const tail = viewerSeries.slice(-10);
    const expectedHold = valueOf(viewers, "max") > 0 && tail.length >= 10
      ? round1((tail.reduce((sum, point) => sum + point.v, 0) / tail.length) / viewers.max * 100) : null;
    if ((episode.live.holdRate ?? null) !== expectedHold) {
      bad++; fail(`${episode.slug}: live.holdRate does not rebuild from the final ten Restream minutes`);
    }
  }

  for (const { event } of archive) {
    if (!matchesByEvent.has(event.event.id)) { bad++; fail(`live sessions: archived event ${event.event.id} is not attached to exactly one episode`); }
  }

  const newest = eps.at(-1);
  if (newest && newest.premiere === phoenixBuildDate) {
    if (newest.historyReady !== false || newest.partialHistory !== null || (newest.weekly || []).length) {
      bad++; fail(`${newest.slug}: air-day episode entered weekly history`);
    }
    if (newest.metrics?.week1Velocity != null || newest.metrics?.flatlineWeek != null) {
      bad++; fail(`${newest.slug}: air-day episode received a first-week or cool-off reading`);
    }
    const pace = data.baselines?.pace?.[newest.slug] ?? null;
    const launch = data.baselines?.launch?.[newest.slug] ?? null;
    const anomaly = data.baselines?.anomaly?.[newest.slug] ?? null;
    if (pace != null || launch != null || data.showTrend?.paceRank?.slug === newest.slug) {
      bad++; fail(`${newest.slug}: air-day episode entered pace or launch comparisons`);
    }
    if (newest.metrics?.anomaly != null || anomaly?.flagged || Object.values(anomaly?.units || {}).some((unit) => unit?.value != null)) {
      bad++; fail(`${newest.slug}: air-day episode entered outlier comparisons`);
    }
    if (data.health && JSON.stringify(data.health).includes(newest.slug)) {
      bad++; fail(`${newest.slug}: air-day episode entered the saved show-health read`);
    }
  }

  // A tiny pure fixture makes the absence rule executable even when today's
  // real Restream records happen to contain every field.
  try {
    const fixtureRegistry = { shows: [{ slug: "fixture", targets: [{ kind: "youtube", account: "joindiveclub", videoId: "fixtureVideo" }] }] };
    const fixture = {
      event: {
        id: "fixture-event",
        startedAt: 1800000000,
        destinations: [{ channelId: 1, externalUrl: "https://youtube.com/watch?v=fixtureVideo" }],
      },
      viewers: {
        total: { max: 0, viewersPerMinute: [{ timestamp: 1800000000000, viewers: 0 }] },
        byChannel: { 1: { max: 0, viewersPerMinute: [{ timestamp: 1800000000000, viewers: 0 }] } },
      },
      messages: { total: { messagesTotal: 0 }, byChannel: { 1: { messagesTotal: 0 } } },
    };
    const projected = liveBuild.projectLiveSession(fixture, fixtureRegistry);
    if (liveBuild.liveEventSlug(fixture, fixtureRegistry) !== "fixture") { bad++; fail("live sessions: exact destination fixture did not resolve its episode"); }
    for (const key of ["avg", "liveViews", "watchedMin", "chatters", "durationMin"]) {
      if (projected[key] !== null) { bad++; fail(`live sessions: missing fixture ${key} became ${projected[key]} instead of null`); }
    }
    if (projected.peak !== 0 || projected.chatMessages !== 0) {
      bad++; fail("live sessions: explicit provider zeros did not remain zero in the fixture");
    }
    const fixtureChannel = projected.byChannel?.[0];
    for (const key of ["avg", "views", "watchedMin", "chatters"]) {
      if (fixtureChannel?.[key] !== null) { bad++; fail(`live sessions: missing channel fixture ${key} became ${fixtureChannel?.[key]} instead of null`); }
    }
    if (fixtureChannel?.peak !== 0 || fixtureChannel?.messages !== 0) {
      bad++; fail("live sessions: explicit channel zeros did not remain zero in the fixture");
    }
  } catch (error) {
    bad++; fail(`live sessions: missing-field fixture threw — ${error.message}`);
  }

  const buildSource = readFileSync(join(TOOL, "build-data.mjs"), "utf8");
  const liveSourceStart = buildSource.indexOf("function sourceNumber");
  const liveSourceEnd = buildSource.indexOf("export function liveChatText", liveSourceStart);
  const liveSource = liveSourceStart >= 0 && liveSourceEnd > liveSourceStart ? buildSource.slice(liveSourceStart, liveSourceEnd) : "";
  if (!liveSource || /(?:max|mean|viewsTotal|watchedTime|messagesTotal|chattersTotal)\s*\|\|\s*0/.test(liveSource) || /\.get\(m\)\s*\|\|\s*0/.test(liveSource)) {
    bad++; drift("live sessions: builder can turn a missing Restream reading into zero");
  }
  const pageSource = readFileSync(join(ROOT, "index.html"), "utf8");
  const heroStart = pageSource.indexOf("function buildHero()");
  const heroEnd = pageSource.indexOf("function buildStrip", heroStart);
  const heroSource = heroStart >= 0 && heroEnd > heroStart ? pageSource.slice(heroStart, heroEnd) : "";
  const panelStart = pageSource.indexOf("function buildPanel()");
  const tableStart = pageSource.indexOf("function buildTable()");
  const panelSource = panelStart >= 0 && tableStart > panelStart ? pageSource.slice(panelStart, tableStart) : "";
  const tableEnd = pageSource.indexOf("function buildEmptyNote", tableStart);
  const tableSource = tableStart >= 0 && tableEnd > tableStart ? pageSource.slice(tableStart, tableEnd) : "";
  for (const [surface, source] of [["summary", heroSource], ["episode panel", panelSource], ["live table", tableSource]]) {
    if (!source.includes("e.live.liveViews") || !/live viewers|watched live|people watched live/i.test(source)) {
      bad++; drift(`live sessions: ${surface} does not expose the stored live-viewer count in plain words`);
    }
    if (!source.includes("e.live.watchedMin") || !/minutes watched|watched minutes|watch time/i.test(source)) {
      bad++; drift(`live sessions: ${surface} does not expose the stored watched-minute count in plain words`);
    }
  }
  if (!bad) ok(`live sessions: ${matchesByEvent.size} episode(s) trace exactly to Restream; totals, timeline, channels, air-day history, and dashboard surfaces agree`);
}

// --- 4. freshness ---
{
  const newest = Math.max(...eps.filter((e) => e.active).map((e) => Date.parse(e.snapshots[e.snapshots.length - 1].ts)));
  const gen = Date.parse(data.generatedAt);
  const now = Date.now();
  if (now - newest > FRESH_MS) fail(`freshness: newest snapshot is ${((now - newest) / 3600000).toFixed(1)}h old (limit 26h)`);
  else ok(`freshness: newest snapshot ${((now - newest) / 3600000).toFixed(1)}h old`);
  if (now - gen > FRESH_MS) fail(`freshness: data.json generated ${((now - gen) / 3600000).toFixed(1)}h ago (limit 26h)`);
  else ok(`freshness: data.json generated ${((now - gen) / 3600000).toFixed(1)}h ago`);
  if (gen < newest - 60000) fail(`freshness: data.json (${data.generatedAt}) is OLDER than the newest snapshot — build did not run after last snapshot`);
}

// --- 5. roster consistency ---
{
  const expected = registry.shows.filter(
    (s) => s.active !== false && (/dive.?radio/i.test(s.title) || /dive-radio/.test(s.slug)) && existsSync(join(HISTORY, `${s.slug}.json`))
  );
  const expectedSlugs = new Set(expected.map((s) => s.slug));
  const gotSlugs = new Set(eps.map((e) => e.slug));
  let bad = 0;
  for (const s of expectedSlugs) if (!gotSlugs.has(s)) { bad++; fail(`roster: registry show ${s} missing from data.json`); }
  for (const s of gotSlugs) if (!expectedSlugs.has(s)) { bad++; fail(`roster: data.json episode ${s} not an active dive-radio registry show`); }
  const sorted = [...eps].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  sorted.forEach((e, i) => { if (e.ep !== i + 1) { bad++; fail(`roster: ${e.slug} has ep=${e.ep}, expected ${i + 1}`); } });
  if (!bad) ok(`roster: ${eps.length} episodes match registry (active dive-radio with history)`);
}

// --- 5a. W12 transcript continuity: file/link parity, headers, and safe pull ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const scriptPath = join(ROOT, "scripts", "restream", "transcripts-pull.mjs");
  let pull = null;
  let transcriptReader = null;
  try { pull = await import(scriptPath); }
  catch (error) { bad++; fail(`transcripts: pull script could not load — ${error.message}`); }
  try { transcriptReader = await import(join(TOOL, "transcripts.mjs")); }
  catch (error) { bad++; fail(`transcripts: shared parser could not load — ${error.message}`); }
  const vaultDir = process.env.DIVE_TRANSCRIPT_VAULT || pull?.DEFAULT_VAULT;

  if (!/if\s*\(e\.transcript\)\s*\{[\s\S]{0,400}href="transcripts\/\$\{esc\(e\.slug\)\}\.txt"/.test(html)) {
    bad++; drift("transcripts: episode download is not gated by the stored transcript flag and slug");
  }

  const registeredDiveShows = registry.shows.filter(
    (show) => /dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug || "")
  );
  const registeredSlugs = new Set(registeredDiveShows.map((show) => show.slug));
  const files = existsSync(TRANSCRIPTS)
    ? readdirSync(TRANSCRIPTS).filter((name) => name.endsWith(".txt")).sort()
    : [];
  for (const name of files) {
    const slug = name.slice(0, -4);
    if (!registeredSlugs.has(slug)) { bad++; fail(`transcripts: ${name} does not map to a registered Dive Radio episode`); }
  }

  for (const episode of eps) {
    const show = registeredDiveShows.find((candidate) => candidate.slug === episode.slug);
    const path = join(TRANSCRIPTS, `${episode.slug}.txt`);
    const fileExists = existsSync(path);
    const raw = fileExists ? readFileSync(path, "utf8") : null;
    const text = raw == null ? "" : raw.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const lines = text.split("\n");
    const declaresVaultSource = lines[2]?.startsWith("Source: Restream speaker transcript (vault") || false;
    let vaultPlan = null;
    if (show && pull && vaultDir && existsSync(vaultDir) && (!fileExists || declaresVaultSource)) {
      try { vaultPlan = pull.planVaultTranscript(show, episode.ep, vaultDir); }
      catch (error) { bad++; fail(`${episode.slug}: ${error.message}`); }
      if (vaultPlan && !fileExists) {
        bad++; fail(`${episode.slug}: ${vaultPlan.file} exists in the owner vault but was not imported`);
      }
    }
    if (typeof episode.transcript !== "boolean" || episode.transcript !== fileExists) {
      bad++; fail(`${episode.slug}: stored transcript flag does not exactly match file existence`);
    }
    if (!fileExists || !show) continue;

    if (!lines[0]?.startsWith(`Dive Radio E${episode.ep} — `) || !lines[0].slice(`Dive Radio E${episode.ep} — `.length).trim()) {
      bad++; fail(`${episode.slug}: transcript does not begin with its episode header`);
    }
    if (!lines.slice(1).join("\n").trim()) { bad++; fail(`${episode.slug}: transcript has a header but no transcript body`); }
    const vaultLine = lines[2] || "";
    const vaultSource = vaultLine.match(/^Source: Restream speaker transcript \(vault ([^/\\]+\.txt)\)\./)?.[1] || null;
    if (vaultLine.startsWith("Source: Restream speaker transcript (vault") && !vaultSource) {
      bad++; fail(`${episode.slug}: vault source header is malformed`);
    }
    if (vaultSource && pull && transcriptReader) {
      const sourcePath = join(vaultDir, vaultSource);
      if (!vaultPlan || vaultPlan.file !== vaultSource) { bad++; fail(`${episode.slug}: named vault source is not the exact episode-and-air-date source selected by the importer`); }
      if (lines[0] !== pull.episodeHeader(show, episode.ep)) { bad++; fail(`${episode.slug}: vault transcript title header does not match the registry`); }
      const primaryYoutube = (show.targets || []).find((target) => target.kind === "youtube" && target.account === "joindiveclub")
        || (show.targets || []).find((target) => target.kind === "youtube");
      const expectedAired = `Aired: ${show.date} · YouTube: https://youtube.com/watch?v=${primaryYoutube?.videoId || ""}`;
      if (lines[1] !== expectedAired) { bad++; fail(`${episode.slug}: vault transcript air date or YouTube source does not match the registry`); }
      if (!existsSync(sourcePath)) { bad++; fail(`${episode.slug}: named vault source ${vaultSource} is missing`); }
      else {
        try {
          if (pull.speakerBody(raw) !== pull.speakerBody(readFileSync(sourcePath, "utf8"))) {
            bad++; fail(`${episode.slug}: canonical transcript body differs from ${vaultSource}`);
          }
          const parsed = transcriptReader.parseTranscript(raw);
          if (parsed.format !== "speaker" || parsed.clock !== "stream") {
            bad++; fail(`${episode.slug}: vault transcript is not parsed as a Restream speaker transcript on the live clock`);
          }
        } catch (error) { bad++; fail(`${episode.slug}: vault transcript parity check failed — ${error.message}`); }
      }
    }
  }

  if (pull) {
    const fridayMorningPhoenix = Date.parse("2026-08-21T14:00:00Z");
    if (!pull.isTranscriptDue("2026-08-20", fridayMorningPhoenix)
      || pull.isTranscriptDue("2026-08-21", fridayMorningPhoenix)) {
      bad++; fail("transcripts: day-two gate is not based on the Phoenix calendar");
    }
    for (const show of registeredDiveShows.filter((candidate) => candidate.active !== false && pull.isTranscriptDue(candidate.date))) {
      if (!existsSync(join(TRANSCRIPTS, `${show.slug}.txt`))) {
        warn(`transcripts: ${show.slug} reached day two without a vault transcript or captions — no link will render; the pull will try again tomorrow`);
      }
    }
  }

  if (!bad) ok(`transcripts: ${files.length} registered file(s), links, episode headers, bodies, and Phoenix day-two gate are valid`);
}

// --- 5aa. UX Tools newsletter promotion: exact links, safe sums, projection parity ---
{
  let bad = 0;
  const storePath = join(ROOT, "data", "restream", "beehiiv-promotions.json");
  let pull = null;
  let store = null;
  try { pull = await import(join(ROOT, "scripts", "restream", "beehiiv-promotions-pull.mjs")); }
  catch (error) { bad++; fail(`newsletter promotion: pull script could not load — ${error.message}`); }
  try { store = JSON.parse(readFileSync(storePath, "utf8")); }
  catch (error) { bad++; fail(`newsletter promotion: store could not be read — ${error.message}`); }

  const validCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
  const completeSum = (values) => values.length && values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const registeredDiveShows = registry.shows.filter(
    (show) => /dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug || ""),
  );

  if (store && pull) {
    if (store.schemaVersion !== 1) { bad++; fail("newsletter promotion: unsupported store version"); }
    if (store.publication?.id !== pull.DEFAULT_PUBLICATION_ID || store.publication?.name !== pull.PUBLICATION_NAME) {
      bad++; fail("newsletter promotion: store is not tied to the fixed UX Tools publication");
    }
    if (store.updatedAt !== store.lastSuccessfulAt || !Number.isFinite(Date.parse(store.lastSuccessfulAt))) {
      bad++; fail("newsletter promotion: successful pull time is missing or disagrees with the store update time");
    }

    for (const show of registeredDiveShows) {
      const entry = store.episodes?.[show.slug];
      if (!entry) { bad++; fail(`newsletter promotion: ${show.slug} has no checked result`); continue; }
      if (!new Set(["found", "no-direct-link"]).has(entry.status)) { bad++; fail(`newsletter promotion: ${show.slug} has an unknown status`); continue; }
      if (entry.status === "no-direct-link") {
        if (typeof entry.reason !== "string" || !entry.reason.trim() || !same(entry.newsletters, []) || entry.totals !== null) {
          bad++; fail(`newsletter promotion: ${show.slug} has no exact link but does not preserve that absence plainly`);
        }
      } else {
        if (entry.reason !== null || !Array.isArray(entry.newsletters) || !entry.newsletters.length || !entry.totals) {
          bad++; fail(`newsletter promotion: ${show.slug} says found without newsletter facts`);
          continue;
        }
        const allowedTargets = pull.registeredTargetKeys(show);
        const seenPosts = new Set();
        for (const newsletter of entry.newsletters) {
          if (!newsletter.postId || seenPosts.has(newsletter.postId)) { bad++; fail(`newsletter promotion: ${show.slug} repeats or omits a newsletter id`); }
          seenPosts.add(newsletter.postId);
          if (!newsletter.title || !Number.isFinite(Date.parse(newsletter.publishedAt)) || Date.parse(newsletter.publishedAt) > Date.parse(store.lastSuccessfulAt)) {
            bad++; fail(`newsletter promotion: ${show.slug} has an untitled, undated, or future newsletter`);
          }
          if (!/^https:\/\/uxtools\.beehiiv\.com\/p\//.test(newsletter.webUrl || "")) {
            bad++; fail(`newsletter promotion: ${show.slug} has an unexpected issue link`);
          }
          if (!Array.isArray(newsletter.matchedTargets) || !newsletter.matchedTargets.length || newsletter.matchedTargets.some((target) => !allowedTargets.has(target))) {
            bad++; fail(`newsletter promotion: ${show.slug} is attributed to an unregistered episode destination`);
          }
          if (!Number.isInteger(newsletter.anchorCount) || newsletter.anchorCount < 1 || !Number.isInteger(newsletter.trackedLinkCount) || newsletter.trackedLinkCount < 1 || newsletter.trackedLinkCount > newsletter.anchorCount) {
            bad++; fail(`newsletter promotion: ${show.slug} has invalid matched-link counts`);
          }
          if (!Array.isArray(newsletter.links)) { bad++; fail(`newsletter promotion: ${show.slug} has no tracked-link list`); continue; }
          const seenLinks = new Set();
          for (const link of newsletter.links) {
            if (!link.url || seenLinks.has(link.url) || /[?&]_bhlid=/i.test(link.url)) { bad++; fail(`newsletter promotion: ${show.slug} repeats or retains a private subscriber link id`); }
            seenLinks.add(link.url);
            const parsedTarget = pull.targetKeyFromUrl(link.url);
            if (parsedTarget !== link.target || !newsletter.matchedTargets.includes(link.target) || pull.targetKeyFromUrl(link.baseUrl) !== link.target) {
              bad++; fail(`newsletter promotion: ${show.slug} tracked-link destination does not match the registered episode`);
            }
            for (const [label, value] of Object.entries({ emailClicks: link.emailClicks, verifiedEmailClicks: link.verifiedEmailClicks, uniqueClicksForThisLink: link.uniqueClicksForThisLink, uniqueVerifiedClicksForThisLink: link.uniqueVerifiedClicksForThisLink })) {
              if (!validCount(value)) { bad++; fail(`newsletter promotion: ${show.slug} ${label} is not a known whole count or missing`); }
            }
            if (link.emailClicks !== null && link.verifiedEmailClicks !== null && link.verifiedEmailClicks > link.emailClicks) { bad++; fail(`newsletter promotion: ${show.slug} verified clicks exceed tracked clicks`); }
            if (link.emailClicks !== null && link.uniqueClicksForThisLink !== null && link.uniqueClicksForThisLink > link.emailClicks) { bad++; fail(`newsletter promotion: ${show.slug} unique link clicks exceed tracked clicks`); }
            if (link.verifiedEmailClicks !== null && link.uniqueVerifiedClicksForThisLink !== null && link.uniqueVerifiedClicksForThisLink > link.verifiedEmailClicks) { bad++; fail(`newsletter promotion: ${show.slug} unique verified link clicks exceed verified clicks`); }
          }
          const allRowsReturned = newsletter.links.length === newsletter.trackedLinkCount;
          const expectedClicks = allRowsReturned ? completeSum(newsletter.links.map((link) => link.emailClicks)) : null;
          const expectedVerified = allRowsReturned ? completeSum(newsletter.links.map((link) => link.verifiedEmailClicks)) : null;
          if (newsletter.emailClicks !== expectedClicks || newsletter.verifiedEmailClicks !== expectedVerified) {
            bad++; fail(`newsletter promotion: ${show.slug} issue totals do not equal its complete tracked-link rows`);
          }
          if ((expectedClicks === null || expectedVerified === null) !== !!newsletter.clicksReason) {
            bad++; fail(`newsletter promotion: ${show.slug} incomplete click facts are not named`);
          }
          if (newsletter.combinedUniqueReaders !== null || typeof newsletter.uniqueReason !== "string" || !newsletter.uniqueReason.trim()) {
            bad++; fail(`newsletter promotion: ${show.slug} invents a reader total across different links`);
          }
        }
        const expectedClicks = completeSum(entry.newsletters.map((newsletter) => newsletter.emailClicks));
        const expectedVerified = completeSum(entry.newsletters.map((newsletter) => newsletter.verifiedEmailClicks));
        if (entry.totals.emailClicks !== expectedClicks || entry.totals.verifiedEmailClicks !== expectedVerified || entry.totals.combinedUniqueReaders !== null || typeof entry.totals.uniqueReason !== "string") {
          bad++; fail(`newsletter promotion: ${show.slug} episode totals do not equal its complete issue totals`);
        }
      }

      const snapshots = Array.isArray(entry.snapshots) ? entry.snapshots : [];
      const dates = snapshots.map((snapshot) => snapshot.date);
      if (!same(dates, [...new Set(dates)].sort())) { bad++; fail(`newsletter promotion: ${show.slug} daily click snapshots repeat or are out of order`); }
      for (const snapshot of snapshots) {
        if (!Number.isFinite(Date.parse(snapshot.pulledAt)) || snapshot.date !== pull.phoenixDateKey(Date.parse(snapshot.pulledAt)) || !validCount(snapshot.emailClicks) || !validCount(snapshot.verifiedEmailClicks) || (snapshot.emailClicks === null && snapshot.verifiedEmailClicks === null)) {
          bad++; fail(`newsletter promotion: ${show.slug} has a malformed Phoenix-day snapshot`);
        }
      }
      if (entry.status === "found" && entry.totals?.emailClicks !== null && entry.totals?.verifiedEmailClicks !== null) {
        const today = pull.phoenixDateKey(Date.parse(store.lastSuccessfulAt));
        const snapshot = snapshots.find((row) => row.date === today);
        if (!snapshot || snapshot.emailClicks !== entry.totals.emailClicks || snapshot.verifiedEmailClicks !== entry.totals.verifiedEmailClicks) {
          bad++; fail(`newsletter promotion: ${show.slug} current daily snapshot does not match current totals`);
        }
      }
    }

    if (data.promotionUpdatedAt !== store.lastSuccessfulAt) { bad++; fail("newsletter promotion: data update time does not match the source store"); }
    for (const episode of eps) {
      const entry = store.episodes?.[episode.slug];
      if (entry?.status !== "found") {
        if (episode.promotion != null) { bad++; fail(`newsletter promotion: ${episode.slug} exposes promotion facts without an exact link`); }
        continue;
      }
      const matchedTargets = [...new Set(entry.newsletters.flatMap((newsletter) => newsletter.matchedTargets || []))].sort();
      const matchedUnits = [...new Set(matchedTargets.map((target) => target.startsWith("youtube:") ? "ytViews" : target.startsWith("x:") ? "xPlays" : null).filter(Boolean))].sort();
      const expectedProjection = {
        status: "found",
        source: store.publication.name,
        updatedAt: store.lastSuccessfulAt,
        emailClicks: entry.totals?.emailClicks ?? null,
        verifiedEmailClicks: entry.totals?.verifiedEmailClicks ?? null,
        clicksReason: entry.totals?.emailClicks == null || entry.totals?.verifiedEmailClicks == null
          ? (entry.newsletters.find((newsletter) => newsletter.clicksReason)?.clicksReason || "Click count not available.")
          : null,
        combinedUniqueReaders: null,
        uniqueReason: entry.totals?.uniqueReason || "Beehiiv does not dedupe one reader across different tracked links.",
        matchedTargets,
        matchedUnits,
        newsletters: entry.newsletters.map((newsletter) => ({ postId: newsletter.postId, title: newsletter.title, publishedAt: newsletter.publishedAt, url: newsletter.webUrl, emailClicks: newsletter.emailClicks ?? null, verifiedEmailClicks: newsletter.verifiedEmailClicks ?? null })),
        snapshots: (entry.snapshots || []).map((snapshot) => ({ date: snapshot.date, pulledAt: snapshot.pulledAt, emailClicks: snapshot.emailClicks ?? null, verifiedEmailClicks: snapshot.verifiedEmailClicks ?? null })),
      };
      if (!same(episode.promotion, expectedProjection)) { bad++; fail(`newsletter promotion: ${episode.slug} dashboard facts do not match the source store`); }
    }

    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    if (!/e\.promotion\?\.status === "found"/.test(html) || !/promotion\.emailClicks/.test(html) || !/promotion\.verifiedEmailClicks/.test(html) || !/not in views/.test(html) || !/never added to views/.test(html)) {
      bad++; drift("newsletter promotion: dashboard does not show the stored counts separately from views");
    }
  }
  if (!bad) ok(`newsletter promotion: ${Object.values(store?.episodes || {}).filter((entry) => entry.status === "found").length} exact episode match(es); links, click sums, daily snapshots, and dashboard projection agree`);
}

// --- 5b. episode tags schema (PRD v2 W3) ---
{
  const FORMATS = new Set(["topic", "interview", "call-in", "bts", "panel"]);
  let bad = 0, tagged = 0, unconfirmed = 0;
  for (const s of registry.shows) {
    if (s.active === false || !s.tags) continue;
    tagged++;
    if (s.tags.unconfirmed) unconfirmed++;
    if (!FORMATS.has(s.tags.format)) { bad++; fail(`${s.slug}: illegal tag format "${s.tags.format}"`); }
    if (!Array.isArray(s.tags.guests)) { bad++; fail(`${s.slug}: tags.guests must be an array`); }
    if (typeof s.tags.unconfirmed !== "boolean") { bad++; fail(`${s.slug}: tags.unconfirmed must be a boolean`); }
  }
  if (!bad) ok(`tags: ${tagged} episode(s) tagged, schema-legal (${unconfirmed} unconfirmed draft(s) — excluded from insights until blessed)`);
}

// --- 6. publish integrity (public repo copies match source of truth) ---
// The cron chain runs build && validate && publish: at validate time a fresh
// build legitimately puts the source AHEAD of the public repo, so that state
// is a WARN (publish about to catch up), never a FAIL — a hard fail here
// would deadlock the chain on every fresh build. The FAIL cases are the real
// corruptions: public repo AHEAD of source (a rollback/divergence) or a
// mismatch with no fresh-build explanation.
// Single-repo layout (2026-08-22 migration): source of truth and served site
// are the same directory, so there is no second copy to drift. What can still
// go wrong locally: data.js not rebuilt alongside data.json, or a missing
// artifact. The release flow verifies exact production bytes after deployment.
{
  let bad = 0;
  const expectedPublic = ["index.html", "agents.html", "data.json", "data.js", "agent.md", "agent.json", "llms.txt", "agent-skill.md"];
  for (const f of [...expectedPublic, "chart.umd.js"]) {
    if (!existsSync(join(ROOT, f))) { bad++; fail(`publish: ${join(ROOT, f)} missing from repo root`); }
  }
  try {
    const manifest = await import(join(TOOL, "public-artifacts.mjs"));
    if (JSON.stringify(manifest.PUBLIC_ARTIFACTS) !== JSON.stringify(expectedPublic)) {
      bad++; drift(`publish: public byte-check list changed (expected ${expectedPublic.join(", ")})`);
    }
  } catch (err) { bad++; drift(`publish: public artifact list is unreadable — ${err.message}`); }
  const js = readFileSync(join(ROOT, "data.js"), "utf8");
  const expected = `window.DIVE_DATA = ${readFileSync(join(ROOT, "data.json"), "utf8").trimEnd()};\n`;
  if (js !== expected) { bad++; fail("publish: data.js does not wrap data.json byte-for-byte — artifacts out of sync (rerun build-data.mjs)"); }
  if (!bad) ok("publish: root artifacts present, data.js wraps data.json exactly");
}

// --- 7. rebuild currency (deterministic recompute reproduces committed data.json) ---
{
  try {
    const mod = await import(join(TOOL, "build-data.mjs"));
    const rebuilt = mod.computeAll({ now: Date.parse(data.generatedAt) });
    // PRD v12: the agent brief, its digest, and the index reproduce byte for
    // byte from the same object (the writer is pure and locale-free)
    try {
      const AB = await import(join(TOOL, "agent-brief.mjs"));
      const brief = AB.buildBrief(rebuilt);
      for (const [file, text] of [["agent.md", brief.md], ["agent.json", brief.json], ["llms.txt", brief.llms]]) {
        const onDisk = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : null;
        if (onDisk !== text) fail(`rebuild: ${file} does not reproduce from the stores — rerun build-data.mjs`);
      }
    } catch (err) { fail(`rebuild: agent brief could not be rebuilt — ${err.message}`); }
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.generatedAt; return JSON.stringify(c); };
    if (strip(rebuilt) !== strip(data)) fail("rebuild: computeAll() over current history does NOT reproduce data.json — snapshots advanced without a rebuild, or build is non-deterministic");
    else ok("rebuild: computeAll() reproduces committed data.json exactly");
  } catch (err) {
    fail(`rebuild: computeAll threw — ${err.message}`);
  }
}

// --- 1d. featured comments sanity (comments-pull + attachComments) ---
{
  let bad = 0;
  const HOSTS = new Set(["@ridd_design", "@designertom", "ridd_design", "designertom"]);
  // Featured quotes still pass the old deterministic negative-word cross-check.
  let negSignal = null;
  try { ({ hasNegativeSignal: negSignal } = await import(join(ROOT, "scripts", "restream", "comments-sentiment.mjs"))); }
  catch { warn("comments: sentiment module unavailable — negative-veto check skipped"); }
  let classifiedStore = null;
  try { classifiedStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-classified.json"), "utf8")); } catch { /* absent */ }
  const XCOV = new Set(["covered", "missed", null]);
  for (const e of eps) {
    if (!e.comments) continue;
    if (!XCOV.has(e.comments.xCoverage ?? null)) { bad++; fail(`${e.slug}: illegal xCoverage "${e.comments.xCoverage}"`); }
    const f = e.comments.featured || [];
    let raw = null;
    try { raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8")); } catch { /* checked in 1e */ }
    if (f.length > 3) { bad++; fail(`${e.slug}: ${f.length} featured comments — cap is 3`); }
    for (const q of f) {
      if (!q.author || !q.text) { bad++; fail(`${e.slug}: featured comment missing author/text`); }
      if (HOSTS.has((q.author || "").toLowerCase())) { bad++; fail(`${e.slug}: host account "${q.author}" in featured comments — hosts must be excluded`); }
      if ((q.text || "").length > 200) { bad++; fail(`${e.slug}: featured comment exceeds 200-char cap`); }
      if (/<script|javascript:/i.test(q.text || "")) { bad++; fail(`${e.slug}: featured comment contains active content — escape/render risk`); }
      if (negSignal && negSignal(q.text || "")) { bad++; fail(`${e.slug}: featured quote by "${q.author}" carries negative wording ("${(q.text || "").slice(0, 60)}…") — complaints must never be pull-quotes`); }
      // provenance: a featured quote must be a prefix of a stored comment (F-C8),
      // and — when the sentiment store has labels — that comment must be
      // classified positive (F-C1: no complaint may ever ship as praise)
      if (raw) {
        const src = (raw.comments || []).find((c) => c.author === q.author && c.text.startsWith(q.text.replace(/…$/, "")));
        if (!src) { bad++; fail(`${e.slug}: featured quote by "${q.author}" not found in the comments store — provenance broken`); }
        else if (classifiedStore?.classified) {
          const lbl = classifiedStore.classified[src.id];
          if (lbl?.state !== "ready" || lbl.relevance !== "feedback" || lbl.sentiment !== "positive") {
            bad++; fail(`${e.slug}: featured quote by "${q.author}" is not ready positive feedback — only confirmed praise may be featured`);
          }
        }
      }
    }
  }
  if (!bad) ok("comments: featured quotes capped, host-free, length-bounded, inert, provenance-checked, sentiment-positive");
}

// --- 1e. W8 audience feedback: model store, gates, rollups, and surface exclusion ---
{
  let bad = 0;
  const RELEVANCE = new Set(["feedback", "noise"]);
  const SENTIMENTS = new Set(["positive", "negative", "neutral", "mixed"]);
  const SURFACED = new Set(["positive", "negative", "mixed"]);
  const ACTIVE = /<script|javascript:|on\w+\s*=|<iframe|data:text\/html/i;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments-classified.json"), "utf8")); } catch { /* absent */ }
  const labels = store?.classified || {};
  if (!store) {
    bad++; fail("comments: comments-classified.json absent — no feedback may publish without the gated store");
  } else {
    try {
      const classifier = await import(join(ROOT, "scripts", "restream", "comments-classify.mjs"));
      const vocabulary = classifier.THEME_VOCABULARY;
      const prompt = readFileSync(join(ROOT, "scripts", "restream", "comments-classify-prompt.md"), "utf8");
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      const configHash = createHash("sha256").update(JSON.stringify({
        version: classifier.CLASSIFIER_VERSION,
        promptVersion: classifier.PROMPT_VERSION,
        promptHash,
        model: store.model,
        provider: store.provider,
        vocabulary,
      })).digest("hex");
      if (store.version !== classifier.CLASSIFIER_VERSION) { bad++; fail(`comments: store version ${store.version} != classifier version ${classifier.CLASSIFIER_VERSION}`); }
      if (store.promptVersion !== classifier.PROMPT_VERSION || store.promptHash !== promptHash) { bad++; drift("comments: prompt stamp does not match the versioned classifier prompt"); }
      if (JSON.stringify(store.vocabulary) !== JSON.stringify(vocabulary)) { bad++; fail("comments: stored theme vocabulary does not match the classifier"); }
      if (store.configHash !== configHash) { bad++; fail("comments: classifier config hash does not match model, prompt, version, and vocabulary"); }
      if (!store.golden?.passed || store.golden.configHash !== configHash || store.golden.relevance?.pct !== 100 || store.golden.sentiment?.pct < 95) {
        bad++; fail("comments: current classifier config lacks a passing 100% relevance / 95% sentiment golden gate");
      }
      if (store.lastRun?.status !== "complete" || store.lastRun?.pendingIds?.length) { warn(`comments: latest classifier run is pending (${(store.lastRun?.pendingIds || []).length} comment(s)) — they stay off the page; publish proceeds`); }
      const themeSet = new Set(vocabulary);
      for (const [id, label] of Object.entries(labels)) {
        if (!new Set(["ready", "review"]).has(label.state)) { bad++; fail(`comments: ${id} has illegal state "${label.state}"`); }
        if (!RELEVANCE.has(label.relevance) || !SENTIMENTS.has(label.sentiment)) { bad++; fail(`comments: ${id} has an illegal relevance or sentiment label`); }
        if (!Array.isArray(label.themes) || label.themes.length > 2 || label.themes.some((t) => !themeSet.has(t))) { bad++; fail(`comments: ${id} has illegal themes`); }
        if (label.relevance === "noise" && (label.sentiment !== "neutral" || label.themes.length)) { bad++; fail(`comments: ${id} noise must be neutral with no themes`); }
        if (label.relevance === "feedback" && label.sentiment !== "neutral" && label.themes.length < 1) { bad++; fail(`comments: ${id} evaluative feedback needs a theme`); }
        if (typeof label.confidence !== "number" || label.confidence < 0 || label.confidence > 1) { bad++; fail(`comments: ${id} confidence outside 0..1`); }
        if (label.classifierVersion !== store.version || label.promptVersion == null || !label.model || !label.classifiedAt) { bad++; fail(`comments: ${id} missing classifier stamps`); }
      }
    } catch (err) {
      bad++; fail(`comments: classifier config validation threw — ${err.message}`);
    }
  }

  const personKey = (c) => {
    if (c.authorId) return `${c.source}:id:${c.authorId}`;
    return `${c.source}:name:${String(c.author || "viewer").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ")}`;
  };
  const peopleCount = (rows) => new Set(rows.map(personKey)).size;
  const topThemes = (rows) => {
    const byTheme = new Map();
    for (const { comment, label } of rows) {
      for (const theme of label.themes || []) {
        if (!byTheme.has(theme)) byTheme.set(theme, new Set());
        byTheme.get(theme).add(personKey(comment));
      }
    }
    return [...byTheme.entries()].map(([theme, people]) => ({ theme, count: people.size }))
      .filter((x) => x.count >= 3)
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme)).slice(0, 3);
  };
  const summarize = (rows, totalViews, rateComplete) => {
    const feedback = rows.filter(({ label }) => label?.state === "ready" && label.relevance === "feedback");
    const enjoy = feedback.filter(({ label }) => label.sentiment === "positive" || label.sentiment === "mixed");
    const complaints = feedback.filter(({ label }) => label.sentiment === "negative" || label.sentiment === "mixed");
    const uniqueCommenters = peopleCount(feedback.map(({ comment }) => comment));
    return {
      captured: rows.length,
      feedbackCount: feedback.length,
      uniqueCommenters,
      enjoyCount: peopleCount(enjoy.map(({ comment }) => comment)),
      complaintCount: peopleCount(complaints.map(({ comment }) => comment)),
      commentersPer1k: rateComplete && totalViews > 0 ? Math.round((uniqueCommenters / totalViews) * 10000) / 10 : null,
      commentersPer1kNote: rateComplete ? null : "The commenting rate isn’t available — some replies or watch counts are missing.",
      enjoyThemes: topThemes(enjoy),
      complaintThemes: topThemes(complaints),
    };
  };

  const known = new Set();
  const showRows = [];
  let showViews = 0;
  let showRateComplete = true;
  let reviewCount = 0;
  for (const e of eps) {
    if (!e.comments) continue;
    try {
      const raw = JSON.parse(readFileSync(join(ROOT, "data", "restream", "comments", `${e.slug}.json`), "utf8"));
      const rows = (raw.comments || []).map((comment) => {
        known.add(comment.id);
        if (!labels[comment.id]) { warn(`${e.slug}: ${comment.id} has no classifier entry — held off the page until classified`); }
        return { comment, label: labels[comment.id] || null };
      });
      showRows.push(...rows);
      showViews += e.latest.totalViews || 0;
      const tvi = e.latest.totalViewsInfo || {};
      const rateComplete = raw.xCoverage === "covered" && tvi.includesYoutube === true && tvi.includesPlays === true && !tvi.partial && !tvi.stale;
      if (!rateComplete) showRateComplete = false;
      const expected = summarize(rows, e.latest.totalViews, rateComplete);
      for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(e.comments[key]) !== JSON.stringify(value)) { bad++; fail(`${e.slug}: comments.${key} disagrees with the classified-store recompute`); }
      }
      if ((e.comments.xCoverage ?? null) !== (raw.xCoverage ?? null)) { bad++; fail(`${e.slug}: X reply marker was lost between capture and export`); }

      const expectedIds = rows.filter(({ label }) => label?.state === "ready" && label.relevance === "feedback" && SURFACED.has(label.sentiment)).map(({ comment }) => comment.id).sort();
      const gotIds = (e.comments.list || []).map((row) => row.id).sort();
      if (JSON.stringify(gotIds) !== JSON.stringify(expectedIds)) { bad++; fail(`${e.slug}: public feedback rows do not exactly match ready positive, negative, and mixed feedback`); }
      for (const row of e.comments.list || []) {
        const rawComment = (raw.comments || []).find((c) => c.id === row.id);
        const label = labels[row.id];
        if (!rawComment || label?.state !== "ready" || label.relevance !== "feedback" || !SURFACED.has(label.sentiment)) { bad++; fail(`${e.slug}: ${row.id} surfaced without a ready feedback label`); continue; }
        if (row.sentiment !== label.sentiment || JSON.stringify(row.themes) !== JSON.stringify(label.themes) || row.text !== rawComment.text || row.author !== rawComment.author) { bad++; fail(`${e.slug}: ${row.id} public row drifted from raw text or stored label`); }
        if (ACTIVE.test(row.text || "") || ACTIVE.test(row.author || "")) { bad++; fail(`${e.slug}: active content in shipped feedback text or author`); }
      }
    } catch (err) {
      bad++; fail(`${e.slug}: cannot recompute audience feedback — ${err.message}`);
    }
  }
  if (store) {
    const orphans = Object.keys(labels).filter((id) => !known.has(id));
    if (orphans.length) warn(`comments: ${orphans.length} stored label${orphans.length === 1 ? "" : "s"} no longer has a raw comment — kept for id stability`);
    reviewCount = Object.values(labels).filter((label) => label.state === "review").length;
    if (reviewCount) warn(`comments: ${reviewCount} label disagreement${reviewCount === 1 ? "" : "s"} held for human review and absent from the export`);
  }
  const expectedShow = summarize(showRows, showViews, showRateComplete);
  if (JSON.stringify(data.commentSummary) !== JSON.stringify(expectedShow)) { bad++; fail("comments: show-level summary disagrees with the classified-store recompute"); }

  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!html.includes('c.sentiment === "positive" || c.sentiment === "mixed"') || !html.includes('c.sentiment === "negative" || c.sentiment === "mixed"')) {
    bad++; drift("comments: mixed feedback is not wired into both dashboard reading lists");
  }
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const slack = build.trendsText(data);
    const newest = eps[eps.length - 1]?.comments;
    const commenterPhrase = newest ? `${newest.uniqueCommenters} ${newest.uniqueCommenters === 1 ? "person" : "people"} commented` : "";
    if (!slack.includes("• Audience feedback:") || (newest && !slack.includes(commenterPhrase))) {
      bad++; fail("comments: Monday Slack line is missing or does not read the newest exported count");
    }
  } catch (err) {
    bad++; fail(`comments: Slack definition-lock check threw — ${err.message}`);
  }
  try {
    const alerts = await import(join(TOOL, "alerts.mjs"));
    const alertState = alerts.snapshotState(data);
    for (const e of eps) {
      if (alertState.complaints?.[e.slug] !== e.comments?.complaintCount) { bad++; fail(`${e.slug}: alert concern count does not read the exported feedback count`); }
    }
    if (alertState.reviewCount !== reviewCount) { bad++; fail("comments: alert review count does not match the classified store"); }
  } catch (err) {
    bad++; fail(`comments: alert definition-lock check threw — ${err.message}`);
  }
  if (!bad) ok(`comments: gated model store and golden scores valid; counts/themes/store/Slack match; noise, neutral text, pending and ${reviewCount} review item(s) stay off the page`);
}

// --- 1f. insight strategy categories ---
{
  let bad = 0;
  const LEGAL_CATS = new Set(["content", "distribution", "promotion", "audience", "data"]);
  const KNOWN_DATA_IDS = new Set(["partial-history"]);
  for (const i of data.insights) {
    if (!i.category) { bad++; fail(`insight ${i.id}: category missing — strategy-impact category must ship`); }
    else if (!LEGAL_CATS.has(i.category)) { bad++; fail(`insight ${i.id}: illegal category "${i.category}"`); }
    else if (i.category === "data" && !KNOWN_DATA_IDS.has(i.id)) warn(`insight ${i.id}: landed on the "data" fallback category — add it to categoryFor()`);
    if (!i.recommendation) { bad++; fail(`insight ${i.id}: recommendation missing — every insight ships the decision it informs`); }
    if (!i.text || i.text.length < 20) { bad++; fail(`insight ${i.id}: text missing or too short to be an insight`); }
  }
  const liveChat = data.insights.find((i) => i.id === "live-chat");
  // The deterministic live-chat sentence is a FALLBACK contract: when the
  // recommendation engine's store drives What matters, it replaces the
  // rule-based insights wholesale (W15).
  const recStorePresent = existsSync(join(ROOT, "data", "restream", "recommendations.json"));
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const withLive = eps.filter((episode) => episode.live);
    const launchChat = withLive[0]?.live?.chatMessages;
    const latestChat = withLive.at(-1)?.live?.chatMessages;
    const expectedChat = !recStorePresent && withLive.length >= 2 ? build.liveChatText(launchChat, latestChat) : null;
    if (expectedChat && liveChat?.text !== expectedChat) {
      bad++; fail("insight live-chat: text does not exactly compare the stored first and latest message totals");
    }
    if (liveChat && ((liveChat.text.match(/\b\d[\d,]*\b/g) || []).length > 2 || /\bE\d+\b|→/.test(liveChat.text))) {
      bad++; fail("insight live-chat: history sequence adds more numbers than the decision needs");
    }
    if (build.liveChatText(10, 20) !== "Live chat is up from launch: 10 messages on the first show, 20 on the latest."
      || build.liveChatText(20, 10) !== "Live chat is down from launch: 20 messages on the first show, 10 on the latest."
      || build.liveChatText(10, 10) !== "Live chat is where it started: 10 messages on both the first and latest shows.") {
      bad++; fail("insight live-chat: up, down, and unchanged copy branches are not deterministic");
    }
    if (expectedChat && !build.trendsText(data).includes(`• [Audience health] ${expectedChat}`)) {
      bad++; fail("insight live-chat: Slack does not read the same stored sentence as the dashboard");
    }
  } catch (error) {
    bad++; fail(`insight live-chat: definition-lock check threw — ${error.message}`);
  }
  const paceInsights = data.insights.filter((insight) => insight.id === "pace-rank");
  const newest = eps.at(-1);
  // PRD v9 W22b: pace readiness and rank come from the one baselines definition
  const pacePublic = data.baselines?.pace?.[newest.slug] || null;
  const paceReady = !!(pacePublic && pacePublic.rank != null);
  if (paceReady !== (data.showTrend?.paceRank != null)) {
    bad++; fail("insight pace-rank: public pace readiness does not match the baselines three-peer gate");
  }
  if (paceReady && (data.showTrend.paceRank.rank !== pacePublic.rank || data.showTrend.paceRank.of !== pacePublic.of)) {
    bad++; fail("insight pace-rank: showTrend.paceRank disagrees with data.baselines.pace");
  }
  // W35 final (owner directive 2026-09-01): when the ranked recommendation
  // store drives What matters it is exactly the five ranked items and the
  // pace claim is not an insight (it stays on the newest episode's card and
  // in the chart standings, locked above); the deterministic fallback list
  // still carries pace-rank exactly when the three-peer gate is met
  const rankedStoreDrives = data.insights.some((i) => i.rank != null);
  const expectedPace = rankedStoreDrives ? 0 : (paceReady ? 1 : 0);
  if (paceInsights.length !== expectedPace) {
    bad++; fail(`insight pace-rank: expected ${expectedPace ? "one grounded insight" : rankedStoreDrives ? "none beside the five ranked items" : "no small-sample insight"}, found ${paceInsights.length}`);
  } else if (paceInsights.length && paceInsights[0].chartState?.solo !== newest.slug) {
    bad++; fail("insight pace-rank: actionable pace insight does not open the newest episode");
  }
  const anomalyEpisodes = eps.filter((e) => e.metrics?.anomaly);
  for (const id of ["reach-conversion", "host-plays-split"]) {
    const insight = data.insights.find((i) => i.id === id);
    if (!insight || !anomalyEpisodes.length) continue;
    if (!/promo outliers left out/i.test(insight.caveat || "")) {
      bad++; fail(`insight ${id}: caveat does not say promo outliers were left out`);
    }
    if (id === "reach-conversion") {
      const copy = `${insight.text} ${insight.recommendation}`;
      for (const e of anomalyEpisodes) {
        if (new RegExp(`\\bE${e.ep}\\b`).test(copy)) { bad++; fail(`insight ${id}: cites promo outlier E${e.ep}`); }
      }
    }
  }
  // W35: a ranked store ships in rank order — ranks 1..n contiguous, first on
  // the page, matching the store's own item order; unranked claims follow
  const ranked = data.insights.filter((i) => i.rank != null);
  if (ranked.length) {
    if (data.insights.length !== ranked.length) { bad++; fail(`insight ranks: What matters must be exactly the ranked items, found ${data.insights.length - ranked.length} unranked card(s) beside them`); }
    const ranks = ranked.map((i) => i.rank);
    if (ranks.some((r, i) => r !== i + 1)) { bad++; fail(`insight ranks are not 1..${ranked.length} in page order (${ranks.join(",")})`); }
    if (data.insights.findIndex((i) => i.rank != null) !== 0 || data.insights.slice(0, ranked.length).some((i) => i.rank == null)) { bad++; fail("insight ranks: ranked items must come first on the page"); }
    try {
      const recStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "recommendations.json"), "utf8"));
      const storeOrder = (recStore.items || []).map((i) => i.id).filter((id) => ranked.some((i) => i.id === id));
      if (JSON.stringify(storeOrder) !== JSON.stringify(ranked.map((i) => i.id))) { bad++; fail("insight ranks do not follow the recommendation store's own order"); }
      if (recStore.ranked && !("prunedAt" in recStore) && (recStore.items || []).length !== 5) { bad++; fail(`recommendations: a fresh ranked store must hold exactly five items, found ${(recStore.items || []).length}`); }
      for (const item of recStore.items || []) if (item.serves != null && !["growth", "audienceQuality", "reachEfficiency", "livePull", "participation", "conversion", "sentiment"].includes(item.serves)) { bad++; fail(`recommendations: ${item.id} serves an unknown check`); }
    } catch (error) { bad++; fail(`insight ranks: store check threw — ${error.message}`); }
    const pageSource = readFileSync(join(ROOT, "index.html"), "utf8");
    const panel = pageSource.match(/function buildInsightsPanel\(\) \{[\s\S]*?\n\}/)?.[0] || "";
    if (!/\(a\.rank \?\? 99\) - \(b\.rank \?\? 99\)/.test(panel) || !/ins\.rank/.test(panel)) { bad++; drift("insight ranks: the page does not render ranked items in rank order with their rank"); }
    if (!/ranked\.slice\(0, 2\)/.test(pageSource)) { bad++; drift("insight ranks: the health card's Do next does not take the top two by rank"); }
  }
  if (!bad) ok(`insight categories: ${data.insights.length} insights all carry a legal strategy category + recommendation${ranked.length ? `; ${ranked.length} ranked in store order` : ""}`);
}

// --- 1g. episode health (W12): 21-day gate, frozen immutability, window sanity, weight math, definition-lock ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  if (!store) {
    warn("episode health: episode-ratings.json absent — health surfaces will not render (run tools/dive-analytics/ratings.mjs)");
  } else {
    const BL = await import(join(TOOL, "baselines.mjs"));
    if (store.algorithm !== "health21-v2") { bad++; fail(`episode health: store algorithm "${store.algorithm}" — expected health21-v2 (stale store; rerun ratings.mjs)`); }
    if (store.readDays !== 21) { bad++; fail(`episode health: store readDays ${store.readDays} — the read window is 21 days`); }
    if (store.windowN !== BL.WINDOW_N || store.minPeers !== BL.MIN_PEERS) { bad++; fail("episode health: store window/min-peers stamps differ from baselines.mjs"); }
    const flagsNow = BL.anomalyFlags(eps);
    const bySlug = new Map((store.scores || []).map((r) => [r.slug, r]));
    const epOrder = [...eps].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
    for (const e of epOrder) {
      const r = bySlug.get(e.slug);
      const a = e.health;
      const ytAge = BL.ytCurrentAge(e);
      const readReady = Number.isFinite(ytAge) && ytAge >= 21;
      // The 21-day gate starts from a real YouTube reading. A raw startup zero
      // cannot create an entry or make the pending state look complete.
      if (!readReady) {
        if (r) { bad++; fail(`episode health: ${e.slug} has no real three-week YouTube reading but has a stored score`); }
        if (!a || a.pending !== true || "score" in a) { bad++; fail(`episode health: ${e.slug} must ship only a pending marker before day 21`); continue; }
        const expectOn = new Date(premiereMs(e.premiere) + 21 * DAY - 7 * 3600000).toISOString().slice(0, 10);
        if (a.readCompleteOn !== expectOn) { bad++; fail(`episode health: ${e.slug} readCompleteOn ${a.readCompleteOn} != premiere + 21 days (${expectOn})`); }
        const expectedReason = e.latest?.ytTotal != null ? BL.NOTES.noFullDayReading : BL.NOTES.noYtReading;
        if (!Number.isFinite(ytAge) && a.reason !== expectedReason) { bad++; fail(`episode health: ${e.slug} has no historical YouTube reading and no explicit reason`); }
        continue;
      }
      if (!r) { bad++; fail(`episode health: ${e.slug} has a ${ytAge.toFixed(1)}d YouTube reading but no store entry`); continue; }
      // definition-lock: what shipped in data.json IS the store entry
      if (JSON.stringify(a) !== JSON.stringify(r)) { bad++; fail(`episode health: ${e.slug} attached entry disagrees with store — definition-lock broken`); }
      // window (PRD v9): this episode + the WINDOW_N that aired before it, never later
      const expectedWin = [...BL.windowFor(e, epOrder).map((x) => x.slug), e.slug];
      if (JSON.stringify(r.windowIds) !== JSON.stringify(expectedWin)) { bad++; fail(`episode health: ${e.slug} windowIds != itself + the ${BL.WINDOW_N} episodes that aired before it`); }
      if (!r.frozenAt || !r.computedAt || !Number.isFinite(r.frozenAtDay) || r.frozenAtDay < 21) { bad++; fail(`episode health: ${e.slug} entry is missing its frozen/computed stamps or froze before day 21`); }
      if (!Array.isArray(r.excluded)) { bad++; fail(`episode health: ${e.slug} entry carries no excluded[] list`); }
      for (const x of r.excluded || []) if (!r.windowIds.includes(x.slug) || !x.why) { bad++; fail(`episode health: ${e.slug} excludes ${x.slug} outside its window or without a reason`); }
      // rule 13: every contributing check has MIN_PEERS stored peers, its typical is
      // the true median of those peers, and its score rebuilds from value vs typical
      for (const [c, cs] of Object.entries(r.checks || {})) {
        if (!["sameAge", "mature", "ageFree", null].includes(cs.ageBasis ?? null)) { bad++; fail(`episode health: ${e.slug} check ${c} has an unknown ageBasis`); }
        if (cs.ratio == null) { if (!cs.reason && r.score != null) { bad++; fail(`episode health: ${e.slug} check ${c} is absent without a reason`); } continue; }
        if (!Array.isArray(cs.peers) || cs.peers.length < BL.MIN_PEERS) { bad++; fail(`episode health: ${e.slug} check ${c} contributes with ${cs.peers?.length ?? 0} peers — fewer than MIN_PEERS`); continue; }
        for (const p of cs.peers) if (!r.windowIds.includes(p.slug) || p.slug === e.slug || (r.excluded || []).some((x) => x.slug === p.slug)) { bad++; fail(`episode health: ${e.slug} check ${c} peer ${p.slug} is outside the window, itself, or an excluded outlier`); }
        if (c === "live") {
          const tp = BL.round1(BL.trueMedian(cs.peers.map((p) => p.value.peak)));
          const tc = BL.round1(BL.trueMedian(cs.peers.map((p) => p.value.chat)));
          if (tp !== cs.typical.peak || tc !== cs.typical.chat) { bad++; fail(`episode health: ${e.slug} live typicals do not rebuild from stored peers`); }
        } else {
          if (cs.typical !== BL.round1(BL.trueMedian(cs.peers.map((p) => p.value)))) { bad++; fail(`episode health: ${e.slug} check ${c} typical does not rebuild from its stored peers`); }
          if (cs.score !== BL.scoreOf(cs.value, cs.typical)) { bad++; fail(`episode health: ${e.slug} check ${c} score does not rebuild from value vs typical`); }
          if (cs.ageBasis === "sameAge" && cs.peers.some((p) => Math.abs(p.atDay - (c === "engagement" ? p.atDay : cs.atDay ?? r.atDay)) > BL.SNAPSHOT_TOL + 1e-9)) { bad++; fail(`episode health: ${e.slug} check ${c} claims same age but a peer was read at another age`); }
          if (cs.ageBasis === "sameAge" && cs.note !== BL.NOTES.sameAge) { bad++; fail(`episode health: ${e.slug} check ${c} note does not match its basis`); }
          if (cs.ageBasis === "mature" && cs.note !== BL.NOTES.mature) { bad++; fail(`episode health: ${e.slug} check ${c} note does not match its basis`); }
        }
        // inputs from append-only stores rebuild exactly (1w); the overwritten
        // analytics file is stamped unreproducible rather than pretended
        for (const p of cs.peers) {
          if (p.source === "snapshot") {
            const pe = epOrder.find((x) => x.slug === p.slug);
            const snap = pe && BL.ytSnapshotAt(pe, p.atDay);
            const v = snap ? (c === "watch" ? BL.ytViewsOf(snap) : BL.engagementPer1kOf(snap)) : null;
            if (v !== p.value) { bad++; fail(`episode health: ${e.slug} check ${c} peer ${p.slug} value ${p.value} does not rebuild from the snapshot at day ${p.atDay} (${v})`); }
          }
          if (p.source === "analytics-file" && r.reproducible !== false) { bad++; fail(`episode health: ${e.slug} reads a current analytics file but is stamped reproducible`); }
        }
      }
      if (r.score == null) {
        if (!r.reason) { bad++; fail(`episode health: ${e.slug} has no score and no reason — absence must explain itself`); }
      } else {
        if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) { bad++; fail(`episode health: ${e.slug} score ${r.score} outside 0..100`); }
        // weight math: redistributed weights sum to 1; absent checks carry weight 0
        let sum = 0;
        let weighted = 0;
        for (const [c, cs] of Object.entries(r.checks || {})) {
          sum += cs.weight || 0;
          if (cs.ratio == null && (cs.weight || 0) !== 0) { bad++; fail(`episode health: ${e.slug} check ${c} has no honest number but weight ${cs.weight}`); }
          // a comparison of exactly 0 is legal: a real zero (e.g. no subscribers
          // gained) is an honest value, never conflated with a missing one
          if (cs.ratio != null && !(cs.ratio >= 0 && cs.ratio < 100)) { bad++; fail(`episode health: ${e.slug} check ${c} comparison ${cs.ratio} outside sane range`); }
          if (cs.ratio != null && cs.typical == null) { bad++; fail(`episode health: ${e.slug} check ${c} compares against nothing — the typical value must ship`); }
          if (cs.score != null && (!Number.isInteger(cs.score) || cs.score < 0 || cs.score > 100)) { bad++; fail(`episode health: ${e.slug} check ${c} score outside 0..100`); }
          if (cs.ratio != null && cs.weight) weighted += cs.score * cs.weight;
        }
        if (Math.abs(sum - 1) > 0.002) { bad++; fail(`episode health: ${e.slug} redistributed weights sum to ${sum.toFixed(4)}, not 1`); }
        if (Math.round(weighted) !== r.score) { bad++; fail(`episode health: ${e.slug} score ${r.score} != weighted mean of its checks (${Math.round(weighted)})`); }
        const expectMissing = Object.entries(r.checks || {}).filter(([, cs]) => cs.ratio == null).map(([c]) => c);
        if (JSON.stringify(r.missingChecks) !== JSON.stringify(expectMissing)) { bad++; fail(`episode health: ${e.slug} missingChecks does not list exactly the checks without honest numbers`); }
      }
    }
    // frozen immutability (1w): a re-run keeps stored entries by construction,
    // so the real check is above — every score rebuilds from what the entry
    // stores. Here: the stored outlier verdicts never change with today's flags.
    for (const r of store.scores || []) {
      for (const x of r.excluded || []) if (x.why === "promo outlier" && !r.windowIds.includes(x.slug)) { bad++; fail(`episode health: ${r.slug} excluded ${x.slug} is not in its window`); }
    }
    try {
      const mod = await import(join(TOOL, "ratings.mjs"));
      const rerun = mod.computeRatings({ now: Date.parse(data.generatedAt) });
      for (const r of store.scores || []) {
        const again = rerun.scores.find((x) => x.slug === r.slug);
        if (JSON.stringify(again) !== JSON.stringify(r)) { bad++; fail(`episode health: frozen entry ${r.slug} CHANGED on recompute — frozen must be immutable`); }
      }
      if (rerun.algorithm !== store.algorithm) { bad++; fail("episode health: store algorithm differs from the running one — rerun ratings.mjs"); }
    } catch (err) {
      bad++; fail(`episode health: recompute threw — ${err.message}`);
    }
    if (!bad) ok(`episode health: ${(store.scores || []).length} finished read(s) — nothing scored before day 21, windows exclude the future and outliers, every contributing check has ${BL.MIN_PEERS}+ peers and rebuilds from its stored inputs, weights sum to 1, surfaces definition-locked`);
  }
}

// --- 1m. W13 watching export: verified-analytics blend sanity ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/mode: "watch"/.test(html)) { bad++; drift("watching: the chart has no Watching view"); }
  for (const e of eps) {
    const w = e.watch;
    const storePath = join(ROOT, "data", "restream", "yt-analytics", `${e.slug}.json`);
    if (!w) {
      if (existsSync(storePath)) {
        try {
          const j = JSON.parse(readFileSync(storePath, "utf8"));
          const usable = Object.values(j.channels || {}).some((c) => c?.totals && c.totals.views > 0);
          if (usable) { bad++; fail(`watching: ${e.slug} has analytics but no exported watch block`); }
        } catch { /* unreadable store — pull warns separately */ }
      }
      continue;
    }
    if (!existsSync(storePath)) { bad++; fail(`watching: ${e.slug} exports watch data with no analytics store — fabricated`); continue; }
    if (!Array.isArray(w.channels) || !w.channels.length) { bad++; fail(`watching: ${e.slug} watch block names no channels`); }
    if (w.avgPercent != null && !(w.avgPercent >= 0 && w.avgPercent <= 100)) { bad++; fail(`watching: ${e.slug} average share ${w.avgPercent} outside 0..100`); }
    if (w.avgDurationSec != null && !(w.avgDurationSec > 0)) { bad++; fail(`watching: ${e.slug} average duration must be positive when present`); }
    if (w.curve) {
      let last = -1;
      for (const point of w.curve) {
        if (!(point.at > 0 && point.at <= 1) || !(point.watching >= 0 && point.watching <= 3) || point.at <= last) {
          bad++; fail(`watching: ${e.slug} curve point out of range or order (at=${point.at})`); break;
        }
        last = point.at;
      }
    }
    if (w.traffic) {
      const shareSum = w.traffic.reduce((sum, t) => sum + t.share, 0);
      if (shareSum > 100.6) { bad++; fail(`watching: ${e.slug} view-source shares sum to ${shareSum.toFixed(1)}`); }
      if (w.traffic.some((t) => !(t.views > 0) || !(t.share >= 0 && t.share <= 100))) { bad++; fail(`watching: ${e.slug} view-source row out of range`); }
    }
  }
  if (!bad) ok(`watching: ${eps.filter((e) => e.watch).length} episode(s) export verified watch data — blends in range, curves ordered, absence never zero`);
}

// --- 1m2. W16 transcript × retention moments: recompute lock, ranges, verbatim excerpts, silent absence ---
// Contract (PRD v6, calibration frozen 2026-08-23): moments exist only for
// episodes with BOTH a blended curve and a transcript; each is at least the
// frozen point floor over a 2-step window, globally spaced, capped at
// 3 drops + 2 holds; excerpts are verbatim substrings of the transcript file;
// timing sits inside the duration derived from the analytics totals; episodes
// missing either input carry neither block and no surface says so.
{
  let bad = 0;
  const wm = await import(join(TOOL, "watch-moments.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const e of eps) {
    const w = e.watch;
    const transcriptPath = join(TRANSCRIPTS, `${e.slug}.txt`);
    const hasBoth = !!(w?.curve?.length && existsSync(transcriptPath));
    if (!hasBoth) {
      if (w && ("shape" in w || "moments" in w)) { bad++; fail(`moments: ${e.slug} carries shape/moments without both a curve and a transcript`); }
      continue;
    }
    const raw = readFileSync(transcriptPath, "utf8");
    const store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "yt-analytics", `${e.slug}.json`), "utf8"));
    const chans = Object.entries(store.channels || {}).filter(([, c]) => c?.totals && Number.isFinite(c.totals.views) && c.totals.views > 0);
    const expected = wm.watchMoments({ curve: w.curve, channelTotals: chans.map(([, c]) => c.totals), transcriptText: raw });
    if (JSON.stringify(w.shape ?? null) !== JSON.stringify(expected?.shape ?? null)) { bad++; fail(`moments: ${e.slug} shape disagrees with the deterministic recompute`); }
    const expectedMoments = expected?.moments?.length ? expected.moments : null;
    // summaries are store-attached prose; strip them before the deterministic compare
    const strippedMoments = w.moments ? w.moments.map(({ summary, ...rest }) => rest) : null;
    if (JSON.stringify(strippedMoments) !== JSON.stringify(expectedMoments)) { bad++; fail(`moments: ${e.slug} moments disagree with the deterministic recompute`); }
    const duration = wm.deriveDuration(chans.map(([, c]) => c.totals));
    const text = raw.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const ms = w.moments || [];
    if (ms.length > 5 || ms.filter((m) => m.kind === "drop").length > 3 || ms.filter((m) => m.kind === "hold").length > 2) { bad++; fail(`moments: ${e.slug} exceeds the 3-drop/2-hold cap`); }
    for (const m of ms) {
      if (m.kind !== "drop" && m.kind !== "hold") { bad++; fail(`moments: ${e.slug} illegal kind "${m.kind}"`); continue; }
      if (!(m.at >= 0.05 && m.at <= 1) || (m.kind === "hold" && m.at < wm.HOLD_SCAN_FROM)) { bad++; fail(`moments: ${e.slug} ${m.kind} at ${m.at} outside its scan range`); }
      if (!w.curve.some((p) => p.at === m.at)) { bad++; fail(`moments: ${e.slug} moment at ${m.at} is not a curve grid point — its marker could not sit on the line`); }
      if (!(m.points >= wm.MOMENT_POINTS_MIN)) { bad++; fail(`moments: ${e.slug} ${m.kind} of ${m.points} points is under the frozen ${wm.MOMENT_POINTS_MIN}-point floor`); }
      if (!duration || !(m.estSec >= 0 && m.estSec <= duration.durationSec)) { bad++; fail(`moments: ${e.slug} estSec ${m.estSec} outside the derived video length`); }
      if (duration && m.approx !== duration.approx) { bad++; fail(`moments: ${e.slug} approx flag disagrees with the channel-duration disagreement`); }
      if (typeof m.excerpt !== "string" || !m.excerpt.trim() || m.excerpt.length > wm.EXCERPT_MAX) { bad++; fail(`moments: ${e.slug} excerpt missing, empty, or over ${wm.EXCERPT_MAX} chars`); }
      else if (!text.includes(m.excerpt)) { bad++; fail(`moments: ${e.slug} excerpt is NOT a verbatim substring of its transcript file`); }
      if (m.speaker !== null && (typeof m.speaker !== "string" || !m.speaker.trim())) { bad++; fail(`moments: ${e.slug} speaker must be a transcript label or null`); }
    }
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        if (Math.abs(ms[i].at - ms[j].at) < wm.MOMENT_SPACING) { bad++; fail(`moments: ${e.slug} moments at ${ms[i].at} and ${ms[j].at} sit closer than ${wm.MOMENT_SPACING}`); }
      }
    }
  }
  // W17 moment summaries: model-written context in a validated store; the page
  // and the Slack line attach it verbatim, and NOTHING ever falls back to a
  // raw transcript quote (owner directive 2026-08-23)
  try {
    const ms = await import(join(TOOL, "moment-summaries.mjs"));
    let sumStore = null;
    try { sumStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "moment-summaries.json"), "utf8")); } catch { /* absent */ }
    if (!sumStore) {
      warn("moments: no summaries store — pins render without context lines (run tools/dive-analytics/moment-summaries.mjs)");
      for (const e of eps) for (const m of e.watch?.moments || []) {
        if ("summary" in m) { bad++; fail(`moments: ${e.slug} carries a summary with no store — fabricated context`); }
      }
    } else {
      ms.validateStore(sumStore);
      const liveKeys = new Set();
      for (const e of eps) {
        for (const m of e.watch?.moments || []) {
          const key = ms.momentKey(e.slug, m);
          liveKeys.add(key);
          const entry = sumStore.entries[key];
          if (entry && m.summary !== entry.summary) { bad++; fail(`moments: ${e.slug} ${m.kind}@${m.at} summary drifted from the store`); }
          if (!entry && "summary" in m) { bad++; fail(`moments: ${e.slug} ${m.kind}@${m.at} carries a summary the store does not hold`); }
        }
      }
      const orphans = Object.keys(sumStore.entries).filter((k) => !liveKeys.has(k));
      if (orphans.length) warn(`moments: ${orphans.length} stored summar${orphans.length === 1 ? "y" : "ies"} no longer match a current moment — kept as history, unused`);
    }
  } catch (err) { bad++; fail(`moments: summaries store validation threw — ${err.message}`); }
  // panel pins: rendered ONLY from stored moments, as keyboard-reachable tooltip buttons on the positioned plot,
  // with the structured tooltip (payoff, position, stored summary) wired through the shared box
  if (!/\(w\.moments \|\| \[\]\)\.forEach/.test(html)
    || !/class="wmark \$\{mo\.kind\}"/.test(html)
    || !/<button type="button" class="wmark/.test(html)
    || !html.includes('data-stat="${esc(stat)}" data-meta="${esc(meta)}"')
    || !html.includes('data-note="${esc(mo.summary)}"')
    || !html.includes("aria-describedby=")
    || !html.includes("badge.dataset.stat")
    || !html.includes("badge.dataset.note")
    || html.includes("momentQuote")
    || !html.includes(".hs[data-hslug], [data-tip], [data-stat]")) {
    bad++; drift("moments: panel pins must render only from episode.watch.moments with store-attached summaries — never raw transcript quotes");
  }
  if (!/<div class="wcurve"><div class="wplot">/.test(html)) { bad++; drift("moments: curve markers lack the positioned plot wrapper — marker positions would drift off the curve"); }
  // engine parity: the excerpts handed to the engine ARE the stored moments' excerpts, and moment facts equal their points
  try {
    const recs = await import(join(TOOL, "recommendations.mjs"));
    const sheet = recs.collectFacts();
    const byId = new Map();
    for (const e of eps) for (const m of e.watch?.moments || []) byId.set(`${m.kind}-E${e.ep}-${Math.round(m.at * 100)}`, m);
    const ids = [...byId.keys()].sort();
    const sheetIds = (sheet.excerpts || []).map((x) => x.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(sheetIds)) { bad++; fail("moments: engine excerpt ids do not match the stored moments"); }
    for (const x of sheet.excerpts || []) {
      const m = byId.get(x.id);
      if (!m || x.text !== m.excerpt) { bad++; fail(`moments: engine excerpt ${x.id} drifted from the stored moment`); }
    }
    for (const f of sheet.facts) {
      const hit = /^(?:drop|hold)-E\d+-\d+$/.test(f.id);
      if (hit && (!byId.get(f.id) || f.value !== byId.get(f.id).points)) { bad++; fail(`moments: engine fact ${f.id} does not equal the stored moment's points`); }
    }
  } catch (err) { bad++; fail(`moments: engine parity check threw — ${err.message}`); }
  // Slack definition-lock: the Monday report's sharpest-exit line is rebuilt
  // verbatim from the stored moment and its store-attached summary — never a
  // transcript quote (1i re-checks the whole report for plain words)
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    const slack = build.trendsText(data);
    const exitLines = slack.split("\n").filter((l) => l.startsWith("• Sharpest exit in "));
    const momentEp = [...eps].reverse().find((x) => x.watch?.moments?.some((m) => m.kind === "drop"));
    if (!momentEp) {
      if (exitLines.length) { bad++; fail("moments: Slack reports an exit moment no episode carries"); }
    } else {
      const d = momentEp.watch.moments.filter((m) => m.kind === "drop").sort((a, b) => b.points - a.points || a.at - b.at)[0];
      const expected = `• Sharpest exit in ${momentEp.title.replace(/^Dive Radio:\s*/i, "")}: ${d.points} of every 100 viewers leave ${d.approx ? "roughly" : "about"} ${build.minutesInWords(d.estSec)}${d.summary ? ` — ${d.summary}` : ""}.`;
      if (exitLines.length !== 1 || exitLines[0] !== expected) { bad++; fail("moments: Slack sharpest-exit line does not exactly rebuild from the stored moment and its summary"); }
    }
  } catch (err) { bad++; fail(`moments: Slack line check threw — ${err.message}`); }
  if (!bad) ok(`moments: ${eps.filter((x) => x.watch?.moments).length} episode(s) carry transcript-anchored moments — recompute-locked, floors/spacing/caps hold, excerpts verbatim, absence silent, Slack line locked`);
}

// --- 1n. W15 recommendation engine: grounded store, definition-locked into insights ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "recommendations.json"), "utf8")); } catch { /* absent */ }
  if (!store) {
    warn("recommendations: no store — What matters falls back to the deterministic rules (run tools/dive-analytics/recommendations.mjs)");
  } else {
    let recs = null;
    try { recs = await import(join(TOOL, "recommendations.mjs")); } catch (err) { bad++; fail(`recommendations: module failed to load — ${err.message}`); }
    if (recs) {
      // grounding against the facts the store stamps (PRD v9 §4.6); stores
      // written before fact stamping can only be judged against today's sheet
      if (Array.isArray(store.facts)) {
        try { recs.validateItems(store.items, store.facts); }
        catch (err) { bad++; fail(`recommendations: store is not grounded in its own stamped facts — ${err.message}`); }
      } else warn("recommendations: store predates fact stamping — grounded against today's sheet only");
      // currency: shipped items pass today's sheet; stale items fail it, and
      // data.json names each stale item with its reason (F32)
      const sheet = recs.collectFacts(data);
      const allowed = recs.allowedNumbers(sheet.facts);
      const staleIds = (data.insightsStale || []).map((x) => x.id);
      for (const item of store.items || []) {
        let err = null;
        try { recs.validateItem(item, sheet.facts, allowed); } catch (e) { err = e; }
        const shipped = data.insights.some((i) => i.id === item.id);
        if (err && shipped) { bad++; fail(`recommendations: ${item.id} is shipped but no longer grounded — ${err.message}`); }
        if (!err && !shipped && data.insights.some((i) => !("chartState" in i))) { bad++; fail(`recommendations: ${item.id} is grounded today but missing from the page`); }
        if (err && !staleIds.includes(item.id)) { bad++; fail(`recommendations: ${item.id} is stale but not named in data.insightsStale`); }
        if (!err && staleIds.includes(item.id)) { bad++; fail(`recommendations: ${item.id} is named stale but still grounds`); }
      }
    }
    // v7 W17/W18 audit fields, when present: a prune records when and what it
    // dropped (and nothing dropped may still be in the store); a model run
    // records how many attempts the grounded set needed (three is the cap)
    if ("prunedIds" in store || "prunedAt" in store) {
      if (!Array.isArray(store.prunedIds) || !store.prunedIds.length || store.prunedIds.some((x) => typeof x !== "string")) {
        bad++; fail("recommendations: prunedIds must be a non-empty list of item ids");
      } else if (!Number.isFinite(Date.parse(store.prunedAt))) {
        bad++; fail("recommendations: a prune must stamp prunedAt");
      } else if ((store.items || []).some((item) => store.prunedIds.includes(item.id))) {
        bad++; fail("recommendations: a pruned id is still in the store");
      }
    }
    if ("attempts" in store && (!Number.isInteger(store.attempts) || store.attempts < 1 || store.attempts > 3)) {
      bad++; fail(`recommendations: attempts ${JSON.stringify(store.attempts)} outside 1..3`);
    }
    const storeIds = (store.items || []).map((r) => r.id).filter((id) => !(data.insightsStale || []).some((x) => x.id === id)).sort();
    const dataIds = (data.insights || []).map((i) => i.id).sort();
    // Definition-lock: every store item ships (minus stale) and nothing else
    // ships EXCEPT required deterministic insights that the page must render
    // regardless of the model store. Currently: `pace-rank` (locked in the
    // insight pace-rank check below to the baselines gate — when paceReady is
    // true it MUST be present on the page, and the model store is not the
    // authority for it). Preserves store-vs-page match for model-authored
    // items while acknowledging the deterministic honesty gate. (2026-08-31.)
    const REQUIRED_DETERMINISTIC_INSIGHTS = new Set(["pace-rank"]);
    const missingFromData = storeIds.filter((id) => !dataIds.includes(id));
    const extraInData = dataIds.filter((id) => !storeIds.includes(id));
    const unauthorizedExtras = extraInData.filter((id) => !REQUIRED_DETERMINISTIC_INSIGHTS.has(id));
    if (storeIds.length && (missingFromData.length || unauthorizedExtras.length)) {
      bad++; fail("recommendations: data.json insights do not match the saved store minus stale items — definition-lock broken");
    }
    for (const item of store.items || []) {
      const shipped = data.insights.find((i) => i.id === item.id);
      if (shipped && (shipped.text !== item.text || shipped.recommendation !== item.recommendation)) {
        bad++; fail(`recommendations: ${item.id} text drifted between store and page`);
      }
    }
    if (!bad) ok(`recommendations: ${(store.items || []).length} saved item(s), ${(data.insightsStale || []).length} stale and held back — every shipped number grounded in today's fact sheet, page matches the store`);
  }
}

// --- 1h. W10 show health: deterministic math, grounding, history, surface lock ---
{
  let bad = 0;
  let store = null;
  try { store = JSON.parse(readFileSync(join(ROOT, "data", "restream", "health-history.json"), "utf8")); } catch { /* first pre-health build is legal */ }
  const health = await import(join(TOOL, "health.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const phxDate = (value) => new Date(Date.parse(value) - 7 * 3600000).toISOString().slice(0, 10);
  // each entry carries exactly the checks its own formula defines (PRD v10:
  // health-v4 has seven; earlier formulas six)
  const partsOf = (formulaVersion) => Object.keys(health.WEIGHTS_BY_FORMULA[formulaVersion] || health.BASE_WEIGHTS).sort();

  if (!html.includes('id="health"') || !html.includes("function buildHealth()") || !html.includes("Number.isFinite(h.score)")) {
    bad++; fail("health: dashboard surface is missing or could turn a real zero score into absence");
  }
  const renderer = html.match(/function buildHealth\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  if (/subScores|weightedMean|BASE_WEIGHTS/.test(renderer)) {
    bad++; drift("health: browser renderer reaches into scoring inputs instead of reading the saved public projection");
  }

  if (!store) {
    if (data.health !== null) { bad++; fail("health: data.json exposes health without a health-history store"); }
    warn("health: no saved entry yet — page must show that the update is unavailable");
  } else {
    if (![1, 2, health.HEALTH_STORE_VERSION].includes(store.version) || !Array.isArray(store.entries)) {
      bad++; fail("health: store schema/version is unsupported");
    } else {
      const BL = await import(join(TOOL, "baselines.mjs"));
      const currentDate = phxDate(data.generatedAt);
      const seenDates = new Set();
      let previousDate = null;
      const prompt = readFileSync(join(TOOL, "health-prompt.md"), "utf8");
      const promptHash = createHash("sha256").update(prompt).digest("hex");

      // Strong local append-only guard: every entry already committed at HEAD
      // must remain byte-identical. Two honest exceptions (PRD v10 §11): a
      // committed day may be re-derived by a NEWER formula the same day,
      // provided the older read is kept byte-identical under `superseded` and
      // the new one names what it replaced (rule 9); and a run may carry more
      // than one new day when earlier runs saved reads that never got
      // published (catch-up days, strictly later than the last committed one).
      try {
        const committed = JSON.parse(execFileSync("git", ["show", "HEAD:data/restream/health-history.json"], { cwd: ROOT, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }));
        const formulaNumber = (v) => Number(String(v || "").replace(/\D/g, "")) || 0;
        const supersededSet = new Set((store.superseded || []).map((row) => JSON.stringify(row.entry)));
        if (store.entries.length < committed.entries.length) { bad++; fail("health: working store removed history"); }
        for (let index = 0; index < committed.entries.length; index++) {
          const was = committed.entries[index];
          const now = store.entries[index];
          if (JSON.stringify(now) === JSON.stringify(was)) continue;
          const rederived = now && now.date === was.date && formulaNumber(now.formulaVersion) > formulaNumber(was.formulaVersion)
            && now.rederivedFrom?.formulaVersion === was.formulaVersion && supersededSet.has(JSON.stringify(was));
          if (!rederived) { bad++; fail(`health: committed entry ${was.date} changed — history is append-only (a same-day re-derivation must keep the old read under superseded)`); }
        }
        for (let index = 0; index < (committed.superseded || []).length; index++) {
          if (JSON.stringify((store.superseded || [])[index]) !== JSON.stringify(committed.superseded[index])) { bad++; fail("health: a superseded read changed or vanished — superseded reads are append-only too"); }
        }
        const lastCommitted = committed.entries.at(-1)?.date ?? null;
        for (const extra of store.entries.slice(committed.entries.length)) {
          if (lastCommitted && extra.date <= lastCommitted) { bad++; fail(`health: new entry ${extra.date} is not later than the last committed day`); }
        }
      } catch { /* initial W10 commit has no HEAD store */ }

      for (const entry of store.entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || seenDates.has(entry.date) || (previousDate && entry.date <= previousDate)) {
          bad++; fail(`health: entry date ${JSON.stringify(entry.date)} is duplicate, malformed, or out of order`);
        }
        seenDates.add(entry.date);
        previousDate = entry.date;
        if (entry.date > currentDate) { bad++; fail(`health: ${entry.date} is future-dated`); }
        if (!entry.createdAt || phxDate(entry.createdAt) !== entry.date) { bad++; fail(`health: ${entry.date} does not match its Phoenix creation day`); }
        // Entries are immutable history: each is judged against ITS OWN stamped
        // versions. What must hold: stamps exist, and an entry claiming the
        // CURRENT prompt/formula version matches the current prompt/formula.
        if (typeof entry.formulaVersion !== "string" || !entry.formulaVersion) { bad++; fail(`health: ${entry.date} has no formula stamp`); }
        if (!Number.isInteger(entry.promptVersion)) { bad++; fail(`health: ${entry.date} has no prompt stamp`); }
        else if (entry.promptVersion > health.PROMPT_VERSION) { bad++; fail(`health: ${entry.date} claims prompt version ${entry.promptVersion}, newer than the current ${health.PROMPT_VERSION}`); }
        else if (entry.promptVersion === health.PROMPT_VERSION && entry.promptHash !== promptHash) { bad++; drift(`health: ${entry.date} prompt stamp is stale — prompt changed without a version bump`); }
        if (!entry.model || !entry.provider || !entry.bundleHash || !entry.dataGeneratedAt || !entry.dataThrough) { bad++; fail(`health: ${entry.date} is missing provenance stamps`); }
        if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) { bad++; fail(`health: ${entry.date} score is outside 0..100`); }

        const partKeys = Object.keys(entry.subScores || {}).sort();
        const expectedParts = partsOf(entry.formulaVersion);
        if (JSON.stringify(partKeys) !== JSON.stringify(expectedParts)) {
          bad++; fail(`health: ${entry.date} does not carry exactly the checks its formula (${entry.formulaVersion}) requires`);
          continue;
        }
        // weights are judged by the formula the entry was written under (PRD v9 F5)
        const plannedWeights = health.WEIGHTS_BY_FORMULA[entry.formulaVersion] || null;
        if (!plannedWeights) { bad++; fail(`health: ${entry.date} formula ${entry.formulaVersion} has no known weight table`); }
        const v3 = entry.formulaVersion === "health-v3" || (health.WEIGHTS_BY_FORMULA[entry.formulaVersion] && Number(entry.formulaVersion.replace(/\D/g, "")) >= 3);
        // PRD v10 (health-v4): qualified promo lifts score null with their
        // reason; carried reads count half inside the check and, when every
        // scored measure is carried, half in the mean
        const v4 = health.WEIGHTS_BY_FORMULA[entry.formulaVersion] && Number(entry.formulaVersion.replace(/\D/g, "")) >= 4;
        const v6 = health.WEIGHTS_BY_FORMULA[entry.formulaVersion] && Number(entry.formulaVersion.replace(/\D/g, "")) >= 6;
        const { effectiveWeightOf } = health.deterministicMean(entry.subScores);
        const availableWeight = Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
        for (const key of expectedParts) {
          const part = entry.subScores[key];
          if (plannedWeights && part.baseWeight !== plannedWeights[key]) { bad++; fail(`health: ${entry.date} ${key} has the wrong planned weight for ${entry.formulaVersion}`); }
          if (!part.measures || !Object.keys(part.measures).length) { bad++; fail(`health: ${entry.date} ${key} has no recorded measures`); continue; }
          const measureScores = [];
          for (const [measureKey, measure] of Object.entries(part.measures)) {
            if (v6 && key === "sentiment" && measureKey === "commentRate" && Number.isFinite(measure.value)) {
              const readEpisode = eps.find((episode) => episode.slug === measure.episodeRead);
              const ageAtRead = readEpisode
                ? (premiereMs(entry.date) - premiereMs(readEpisode.premiere)) / DAY
                : null;
              if (!readEpisode || ageAtRead < BL.MATURITY_DAYS.analytics) {
                bad++; fail(`health: ${entry.date} sentiment.commentRate reads an episode younger than ${BL.MATURITY_DAYS.analytics} days`);
              }
            }
            if (v4 && measure.qualified) {
              // a qualified measure keeps value and typical, scores nothing,
              // and says why in the one fixed string
              if (measure.score != null || measure.reason !== BL.NOTES.promoQualified || !Number.isFinite(measure.value) || !Number.isFinite(measure.typical)) {
                bad++; fail(`health: ${entry.date} ${key}.${measureKey} is qualified but not shown-not-scored with the fixed reason`);
              }
            }
            // a relative measure's score re-derives exactly from its stored
            // three-decimal comparison (the rounded value alone can land a point off)
            if (v4 && !measure.absoluteScale && measure.score != null && (!Number.isFinite(measure.ratio) || Math.round(Math.min(100, Math.max(0, 50 * measure.ratio))) !== measure.score)) {
              bad++; fail(`health: ${entry.date} ${key}.${measureKey} score does not re-derive from its stored comparison`);
            }
            if (v4 && measure.carried && (measure.score == null || !measure.episodeRead || !measure.carriedNote || !/counted at half weight/.test(measure.carriedNote))) {
              bad++; fail(`health: ${entry.date} ${key}.${measureKey} is carried without a scored value, a read episode, and the half-weight note`);
            }
            // rule 23: a measure's swing is a whole percent from at least
            // MIN_PEERS peers, absent on absolute-scale measures
            if (v4 && measure.swing != null && (!Number.isInteger(measure.swing) || measure.swing < 0 || measure.absoluteScale || measure.sample < BL.MIN_PEERS)) {
              bad++; fail(`health: ${entry.date} ${key}.${measureKey} carries an invalid swing`);
            }
            if (measure.score == null) {
              if (!measure.reason) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} is missing without a reason`); }
            } else {
              if (!Number.isFinite(measure.score) || measure.score < 0 || measure.score > 100 || !Number.isFinite(measure.value)) {
                bad++; fail(`health: ${entry.date} ${key}.${measureKey} has an invalid score/value`);
              } else measureScores.push(measure.score);
              if (v3) {
                // like-for-like (1s) and windowed typical (1u) on every v3 measure
                if (!["sameAge", "mature", "ageFree"].includes(measure.ageBasis)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} scored without a known basis`); }
                if (measure.typical != null && (!Array.isArray(measure.window) || measure.window.length < BL.MIN_PEERS || measure.sample < BL.MIN_PEERS)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} has a typical from fewer than ${BL.MIN_PEERS} peers`); }
                if (measure.typical != null && measure.window.includes(measure.episodeRead)) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} window includes the episode it reads`); }
                if (measure.typical != null && measure.window.length > BL.WINDOW_N) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} window exceeds WINDOW_N`); }
                const expectedNote = measure.ageBasis === "sameAge" ? BL.NOTES.sameAge : measure.ageBasis === "mature" ? BL.NOTES.mature : null;
                if ((measure.note ?? null) !== expectedNote) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} note does not match its basis`); }
                if (measure.absoluteScale && measure.typical != null) { bad++; fail(`health: ${entry.date} ${key}.${measureKey} is absolute-scale yet carries a typical`); }
              }
            }
          }
          const expectedScore = v4
            ? health.checkScoreOf(part.measures).score
            : (measureScores.length ? Math.round(measureScores.reduce((sum, value) => sum + value, 0) / measureScores.length) : null);
          if (part.score !== expectedScore) { bad++; fail(`health: ${entry.date} ${key} score does not equal its available measures`); }
          if (v4 && (part.carried === true) !== health.checkScoreOf(part.measures).carried) { bad++; fail(`health: ${entry.date} ${key} carried stamp does not match its measures`); }
          // rule 23: the check's bands follow its measures' swings and its
          // state word follows its bands — re-derived from the entry alone
          if (v4 && "state" in part) {
            const { swing, bands } = health.checkBandsOf(part.measures);
            if ((part.swing ?? null) !== (swing ?? null) || JSON.stringify(part.bands) !== JSON.stringify(bands) || part.state !== BL.stateOf(part.score, bands)) {
              bad++; fail(`health: ${entry.date} ${key} state/bands do not re-derive from its measures' swings`);
            }
            if (bands.healthy > 50 + BL.SWING_MAX_PCT / 2 + 1e-9 || bands.healthy < 50 + BL.SWING_MIN_PCT / 2 - 1e-9) { bad++; fail(`health: ${entry.date} ${key} bands fall outside the allowed swing`); }
          } else if (v4) { bad++; fail(`health: ${entry.date} ${key} carries no state word (rule 23)`); }
          if (part.score == null && (!part.reason || part.effectiveWeight !== 0)) { bad++; fail(`health: ${entry.date} ${key} absence lacks a reason or carries weight`); }
          if (part.score != null) {
            const expectedWeight = v3
              ? Math.round(effectiveWeightOf(part) * 10000) / 10000
              : Math.round(part.baseWeight / availableWeight * 10000) / 10000;
            if (part.effectiveWeight !== expectedWeight) { bad++; fail(`health: ${entry.date} ${key} shared weight is wrong`); }
            if (v3 && part.absoluteScale && part.effectiveWeight > part.baseWeight + 1e-9) { bad++; fail(`health: ${entry.date} ${key} is absolute-scale but absorbed redistributed weight`); }
          }
        }
        const recomputed = v3 ? health.deterministicMean(entry.subScores) : (() => {
          // pre-v3 entries shared weight among all available checks
          const avail = Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.baseWeight : 0), 0);
          const wm = avail > 0 ? Math.round(Object.values(entry.subScores).reduce((sum, part) => sum + (Number.isFinite(part.score) ? part.score * part.baseWeight / avail : 0), 0) * 10) / 10 : null;
          return { weightedMean: wm };
        })();
        if (entry.weightedMean !== recomputed.weightedMean) { bad++; fail(`health: ${entry.date} stored mean ${entry.weightedMean} != recomputed ${recomputed.weightedMean}`); }
        if (v3) {
          const expectedSet = expectedParts.filter((key) => Number.isFinite(entry.subScores[key]?.score)).sort();
          if (JSON.stringify([...(entry.checkSet || [])].sort()) !== JSON.stringify(expectedSet)) { bad++; fail(`health: ${entry.date} checkSet does not list exactly the scored checks`); }
        }
        if (v4) {
          const dir = entry.direction;
          if (!dir || !Array.isArray(dir.measures) || !dir.measures.length) { bad++; fail(`health: ${entry.date} carries no direction block`); }
          else {
            for (const t of dir.measures) {
              const expectedPct = BL.theilSenPctPerEpisode(t.points || []);
              const expectedWord = (t.points || []).length >= BL.TREND_MIN_WORD ? BL.directionOf(expectedPct) : null;
              if ((t.pctPerEpisode ?? null) !== (expectedPct ?? null) || (t.direction ?? null) !== (expectedWord ?? null)) { bad++; fail(`health: ${entry.date} direction ${t.key} does not re-derive from its stored points (word needs ${BL.TREND_MIN_WORD})`); }
              if (t.pctPerEpisode != null && (t.points || []).length < BL.MIN_PEERS) { bad++; fail(`health: ${entry.date} direction ${t.key} rests on fewer than ${BL.MIN_PEERS} episodes`); }
              if ((t.points || []).length > BL.TREND_N) { bad++; fail(`health: ${entry.date} direction ${t.key} spans more than ${BL.TREND_N} episodes`); }
              // every series carries its basis and note (rules 11, 17)
              const def = BL.TREND_MEASURES.find((m) => m.key === t.key);
              if (!def || (t.check ?? null) !== def.check) { bad++; fail(`health: ${entry.date} direction ${t.key} is not a known series or names the wrong check`); }
              if (t.pctPerEpisode != null && (t.ageBasis !== def?.basis || (t.note ?? null) !== (BL.NOTES[def?.basis] ?? null))) { bad++; fail(`health: ${entry.date} direction ${t.key} lacks its basis or note`); }
            }
            if ((dir.overall ?? null) !== (BL.overallDirection(dir.measures) ?? null)) { bad++; fail(`health: ${entry.date} overall direction does not follow its check votes`); }
            if (JSON.stringify(dir.votes || []) !== JSON.stringify(BL.checkVotes(dir.measures))) { bad++; fail(`health: ${entry.date} direction votes do not re-derive`); }
            // the entry copies the lens the page served that day (rule 4: one
            // definition, build-data's). A later same-day capture legitimately
            // moves the served lens (a new snapshot changes the cool-off or a
            // same-age reading) while the entry keeps the lens it was written
            // from — the same escape the same-day recompute proof uses
            // (2026-09-01 chain incident: the first real run after the v4
            // re-derivation stopped here for exactly that reason)
            if (entry.date === currentDate) {
              const latestSnapshotMs = Math.max(0, ...(data.episodes || []).map((e) => Date.parse(e.latest?.ts || "")).filter(Number.isFinite));
              const refreshedSinceSave = Number.isFinite(Date.parse(entry.createdAt)) && latestSnapshotMs > Date.parse(entry.createdAt);
              const dirDiffers = JSON.stringify(dir) !== JSON.stringify(data.baselines?.direction ?? null);
              const outDiffers = JSON.stringify(entry.outlook ?? null) !== JSON.stringify(data.baselines?.outlook ?? null);
              if ((dirDiffers || outDiffers) && refreshedSinceSave) warn(`health: ${entry.date} direction/outlook were re-read after today's entry was saved (a later snapshot) — the entry keeps the lens it was written from; the next daily run re-proves it`);
              else if (dirDiffers) { bad++; fail(`health: ${entry.date} direction block differs from data.baselines.direction`); }
              else if (outDiffers) { bad++; fail(`health: ${entry.date} outlook block differs from data.baselines.outlook`); }
            }
          }
          const nfw = entry.outlook?.nextFirstWeek;
          if (!nfw) { bad++; fail(`health: ${entry.date} carries no outlook`); }
          else if (nfw.low != null && (nfw.n < BL.MIN_PEERS || nfw.low > nfw.high || nfw.typical < nfw.low || nfw.typical > nfw.high)) { bad++; fail(`health: ${entry.date} outlook range is malformed or rests on fewer than ${BL.MIN_PEERS} clean first weeks`); }
          if (!entry.asOf?.newest || !Number.isFinite(entry.asOf?.ageDays)) { bad++; fail(`health: ${entry.date} does not say which episode the read is on`); }
          else {
            const carriedChecks = Object.entries(entry.subScores).filter(([, part]) => part.carried).map(([key]) => key);
            if (JSON.stringify(carriedChecks) !== JSON.stringify(entry.asOf.carried || [])) { bad++; fail(`health: ${entry.date} asOf.carried does not list the carried checks`); }
            const qualifiedMeasures = Object.entries(entry.subScores).flatMap(([key, part]) => Object.values(part.measures || {}).filter((m) => m.qualified).map((m) => `${key}.${m.id}`));
            if (JSON.stringify(qualifiedMeasures) !== JSON.stringify(entry.asOf.qualified || [])) { bad++; fail(`health: ${entry.date} asOf.qualified does not list the promo-qualified measures`); }
          }
        }
        if (Math.abs(entry.score - entry.weightedMean) > 8) { bad++; fail(`health: ${entry.date} model score moves more than eight points from the deterministic mean`); }
        if (entry.deviation !== Math.round((entry.score - entry.weightedMean) * 10) / 10) { bad++; fail(`health: ${entry.date} stored score move is wrong`); }
        try {
          // each entry is judged under the prompt version it was written with
          // (W27: v4 requires naming every changed check and digit-free
          // drivers; v3 entries keep the looser rule they were saved under)
          health.validateSynthesis(
            { score: entry.score, headline: entry.headline, pros: entry.pros, cons: entry.cons, drivers: entry.drivers },
            { allowedScore: { min: Math.max(0, Math.ceil(entry.weightedMean - 8)), max: Math.min(100, Math.floor(entry.weightedMean + 8)) }, facts: entry.facts || [], checkSetChange: entry.checkSetChange ?? null, promptVersion: entry.promptVersion ?? 0 },
          );
        } catch (error) {
          bad++; fail(`health: ${entry.date} model copy/grounding is invalid — ${error.message}`);
        }
      }

      const expectedProjection = health.projectHealth(store, { now: Date.parse(data.generatedAt) });
      if (JSON.stringify(data.health) !== JSON.stringify(expectedProjection)) {
        bad++; fail("health: data.json does not exactly project the latest saved entry and real history");
      }
      const latestEntry = store.entries.filter((entry) => entry.date <= currentDate).at(-1);
      const expectedReadState = Object.values(latestEntry?.subScores || {}).some((section) =>
        section?.score == null || Object.values(section?.measures || {}).some((measure) => measure?.score == null && !measure?.qualified))
        || (latestEntry?.facts || []).some((fact) => fact?.requiredPhrase === "still early")
        ? "early" : "settled";
      if (data.health?.readState !== expectedReadState) {
        bad++; fail("health: the public early/settled state does not match the saved checks");
      }
      // the trend plots only entries written under the running formula (F5)
      const runningEntries = store.entries.filter((entry) => entry.date <= currentDate && entry.formulaVersion === health.FORMULA_VERSION);
      if (runningEntries.length < 7 && data.health?.trend != null) { bad++; fail("health: trend surfaced before seven real saved days under the running formula exist"); }
      if (runningEntries.length >= 7) {
        const expectedPoints = runningEntries.map((entry) => ({ date: entry.date, score: entry.score }));
        if (JSON.stringify(data.health?.trend?.points) !== JSON.stringify(expectedPoints)) { bad++; fail("health: trend points do not exactly match saved days under the running formula"); }
      }
      // freshness (1v, PRD v9 rule 15): the served read's age is stated; past
      // STALE_WITHHOLD_DAYS the score is withheld; a stale formula only warns
      if (latestEntry) {
        const age = Math.round((Date.parse(`${currentDate}T12:00:00Z`) - Date.parse(`${latestEntry.date}T12:00:00Z`)) / DAY);
        if (data.health?.ageDays !== age) { bad++; fail(`health: projected ageDays ${data.health?.ageDays} != ${age}`); }
        if (age > health.STALE_WITHHOLD_DAYS && (data.health?.withheld !== true || data.health?.score != null)) { bad++; fail(`health: the served read is ${age} days old and must be withheld`); }
        if (age <= health.STALE_WITHHOLD_DAYS && data.health?.withheld) { bad++; fail("health: a fresh read is wrongly withheld"); }
        if (age > 1) warn(`health: the served read is ${age} day(s) behind the data (saved ${latestEntry.date})`);
        if (latestEntry.formulaVersion !== health.FORMULA_VERSION) warn(`health: the served read was written under ${latestEntry.formulaVersion}; the running formula is ${health.FORMULA_VERSION} — the next successful run replaces it`);
      }

      const latest = store.entries.at(-1);
      // Same-day recompute only proves pipeline ordering when the entry was
      // written by the CURRENT formula version — an entry saved under an older
      // version legitimately cannot be reproduced by newer code.
      // Compare the deterministic scoring inputs (weightedMean, subScores,
      // facts) — NOT bundleHash. The bundle hashes context.dataAge, whose
      // freshness timestamps legitimately move when later chain steps or
      // same-day retries refresh stores. And the comparison itself only
      // holds while the entry is newer than the stores it was computed
      // from: the store is append-only, so once a later run ingests fresh
      // views or comments, today's saved entry legitimately cannot match
      // and the gate must step aside instead of deadlocking the day
      // (2026-08-24 incident: four 7 AM runs failed here with identical
      // scores and facts, then intraday re-ingest made the mismatch real).
      if (latest?.date === currentDate && latest.formulaVersion === health.FORMULA_VERSION) {
        try {
          // the writer saw the previous entry (the sameAge-never-falls-back rule reads it); so must the proof
          const previousEntry = store.entries.filter((entry) => entry.date < latest.date).at(-1) ?? null;
          const recomputed = health.computeHealthInputs({ data, now: Date.parse(latest.dataGeneratedAt), root: ROOT, previous: previousEntry });
          const dataAge = recomputed.context?.dataAge || {};
          const freshestStore = [dataAge.latestSnapshot, dataAge.analyticsUpdatedAt, dataAge.commentsClassifiedAt]
            .filter(Boolean).map((ts) => Date.parse(ts)).filter(Number.isFinite).sort((a, b) => a - b).at(-1) ?? null;
          const storesRefreshedSinceSave = freshestStore != null && Number.isFinite(Date.parse(latest.createdAt)) && freshestStore > Date.parse(latest.createdAt);
          if (storesRefreshedSinceSave) {
            warn("health: source stores were refreshed after today's entry was saved — same-day recompute proof skipped; the next daily run re-proves it");
          } else if (recomputed.weightedMean !== latest.weightedMean || JSON.stringify(recomputed.subScores) !== JSON.stringify(latest.subScores) || JSON.stringify(recomputed.facts) !== JSON.stringify(latest.facts)
            || JSON.stringify(recomputed.direction) !== JSON.stringify(latest.direction ?? null) || JSON.stringify(recomputed.outlook) !== JSON.stringify(latest.outlook ?? null) || JSON.stringify(recomputed.asOf) !== JSON.stringify(latest.asOf ?? null)) {
            bad++; fail("health: today's entry does not recompute from the current source stores (checks, facts, direction, outlook, or as-of differ)");
          }
        } catch (error) {
          bad++; fail(`health: today's source recompute threw — ${error.message}`);
        }
      }
      if (!bad && store.entries.length) ok(`health: ${store.entries.length} saved day(s), deterministic mean and model move valid, bullets grounded, surface definition-locked`);
    }
  }
}

// --- 1i. plain reader-facing words (constitution rule 6) ---
{
  let bad = 0;
  const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
  const readerStrings = [];
  for (const insight of data.insights || []) {
    for (const key of ["text", "recommendation", "caveat"]) if (insight[key]) readerStrings.push(`insight ${insight.id} ${key}: ${insight[key]}`);
  }
  if (data.health) {
    readerStrings.push(`health headline: ${data.health.headline}`);
    for (const item of [...(data.health.pros || []), ...(data.health.cons || [])]) readerStrings.push(`health bullet: ${item.text}`);
  }
  try {
    const build = await import(join(TOOL, "build-data.mjs"));
    readerStrings.push(`Slack trends: ${build.trendsText(data)}`);
  } catch (err) {
    bad++; fail(`plain words: could not build the Slack text — ${err.message}`);
  }
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const about = html.match(/function buildAbout\(\) \{[\s\S]*?innerHTML = `([\s\S]*?)`;\n\}/)?.[1];
  if (!about) { bad++; drift("plain words: About copy could not be found in index.html"); }
  else readerStrings.push(`About: ${about.replace(/<[^>]+>/g, " ")}`);
  for (const line of readerStrings) {
    const hit = line.match(BANNED);
    if (hit) { bad++; fail(`plain words: reader-facing copy contains "${hit[0]}" — ${line.slice(0, 180)}`); }
  }
  if (!bad) ok("plain words: insights, Slack, and About avoid the banned dashboard jargon");
}

// --- 1j. trend and strip honesty gates (critic follow-up) ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/if\s*\(vals\.length\s*<\s*3\)/.test(html)) {
    bad++; drift("dashboard: first-week trend verdict is not gated until three clean weeks exist");
  }
  if (!/const p = DATA\.baselines\?\.pace\?\.\[e\.slug\];/.test(html)
    || /peers\.length < 3/.test(html)
    || /filter\(i => i\.id !== "pace-rank"\)/.test(html)
    || !/after three other episodes have real data at that age/.test(html)
    || !/appears after three of them have real data at that age/.test(html)) {
    bad++; fail("dashboard: same-age pace must be read from data.baselines.pace (never recomputed in the browser) and say so in the panel tip and About");
  }
  // quiet zone and bands are read from data.baselines.constants (PRD v9 rule 16);
  // the page carries no second definition of either
  if (!/const QUIET_ZONE = BASE_CONST\.QUIET_ZONE_PCT \?\? 5;/.test(html) || !/pct <= QUIET_ZONE/.test(html) || !/Math\.abs\(pct\) <= QUIET_ZONE/.test(html)
    || /pct\s*<=\s*5\b/.test(html) || /Math\.abs\(pct\)\s*<=\s*5\b/.test(html) || /> 0\.05\)/.test(html)) {
    bad++; drift("dashboard: comparison conclusions must read the quiet zone from data.baselines.constants and nowhere else");
  }
  if (!/score >= BANDS\.healthy/.test(html) || !/score >= BANDS\.steady/.test(html) || /score >= 55\b/.test(html)) {
    bad++; drift("dashboard: health bands must read data.baselines.constants.BANDS");
  }
  if (/provisional\s+—\s+settles/i.test(html)) {
    bad++; drift('dashboard: strip uses "provisional" instead of the plain "Not final" label');
  }
  // 21-day gate (W12): every score render goes through the finished-read gate,
  // and young episodes get wait-date words, never a number
  if (!html.includes("function healthOf(e) { return e.health && !e.health.pending && e.health.score != null ? e.health : null; }")) {
    bad++; drift("dashboard: episode health is not locked behind the finished-three-week gate (healthOf)");
  }
  // W15 (owner directive 2026-08-23): absence renders as absence — no wait
  // dates, no sat-out notes, no baseline chips. The gate itself still holds:
  // nothing score-like may render before healthOf() passes.
  if (/healthWaitDate|sat out|sets the baseline<\/span>|not in yet/.test(html)) {
    bad++; fail("dashboard: retired absence copy (wait dates, sat-out notes, baseline chips, not-in-yet suffixes) is back on a surface");
  }
  // W13/PRD v9 F29: the typical watch line is read from data.baselines.typicalCurve
  // (mature, unflagged curves, three or nothing) — never computed in the browser
  if (!/const typical = DATA\.baselines\?\.typicalCurve;/.test(html) || /curves\.length >= 3/.test(html) || /const mid = \(vals\)/.test(html)) {
    bad++; drift("dashboard: the typical watch line must be read from data.baselines.typicalCurve, never computed in the page");
  }
  // F16/F15: watched-vs-typical and the trend verdict read data.baselines too
  if (!/DATA\.baselines\?\.watchPctBySlug\?\.\[e\.slug\]\?\.typical/.test(html) || /const watchedVals = EPS\.map/.test(html)) {
    bad++; drift("dashboard: the table's watched typical must come from data.baselines.watchPctBySlug");
  }
  if (!/DATA\.baselines\?\.newestVsPrevious\?\.\[metric\]/.test(html) || /Climbing on the newest episode/.test(html)) {
    bad++; drift("dashboard: the trend-card verdict must compare like for like from data.baselines.newestVsPrevious");
  }
  if (!/health read is \$\{h\.withheld \? "withheld" : "behind"\}/.test(html)) {
    bad++; drift("dashboard: the header stamp must say when the saved health read is behind the data (D5)");
  }
  if (/"<th>Episode<\/th>[^\n]*\$\{PLOGO/.test(html)) { bad++; drift("dashboard: the table header is not a template literal (F25)"); }
  if (!bad) ok("dashboard honesty: trend waits for three clean weeks, scores wait for finished three-week reads, plain words throughout");
}

// --- 1j2. missing dashboard values never become visible zeroes ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const tooltipSource = html.match(/function externalTooltip\(context\) \{[\s\S]*?\n\}\n\nlet chart;/)?.[0] || "";
  const tableSource = html.match(/function buildTable\(\) \{[\s\S]*?\n\}\n\n\/\* M-1/)?.[0] || "";
  const seriesSource = html.match(/function seriesFor\(e\) \{[\s\S]*?\n\}/)?.[0] || "";
  if (!tooltipSource || !tableSource) {
    bad++; fail("dashboard absence: could not locate tooltip and table renderers");
  } else if (/\?\?\s*0/.test(tooltipSource + tableSource)) {
    bad++; fail("dashboard absence: a tooltip or table can turn a missing value into zero");
  }
  if (!/function metricText\(value, missing = "–"\) \{ return value == null \? missing : nfmt\(value\); \}/.test(html)) {
    bad++; fail("dashboard absence: the shared missing-value formatter could hide a real zero or lacks a plain missing state");
  }
  if (!/function hasYoutubeReading\(e\) \{ return e\?\.latest\?\.totalViewsInfo\?\.includesYoutube === true; \}/.test(html)
    || !/function youtubeValue\(e, value\)/.test(html)
    || !/if \(!hasPositive\) return null;/.test(html)
    || !/if \(!e\.historyReady\) return pts;/.test(seriesSource)
    || !/if \(views == null\) continue;/.test(seriesSource)
    || !/if \(phoenixDateKey\(t\) <= e\.premiere\) continue;/.test(seriesSource)
    || !/const value = byDest\?\.\[k\]\?\.plays;[\s\S]*if \(!Number\.isFinite\(value\)\) return null;/.test(html)
    || !/\["yt:joindiveclub", \(e\) => youtubeValue\(e, e\.latest\.byDest\["yt:joindiveclub"\]\?\.views\)\]/.test(html)) {
    bad++; fail("dashboard absence: current YouTube uses its availability flag; history skips air date and incomplete X play rows");
  }
  if (!bad) ok("dashboard absence: tables and tooltips keep missing values distinct from real zeroes");
}

// --- 1k. W12 card layout and progressive-disclosure contract ---
// The page is a card system: health cards (gauge → diagnosis → today's read),
// then the latest-episode and growth-trend cards, then the episode carousel
// ABOVE the chart (owner directive 2026-08-23), panel and evidence on demand.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const between = (start, end) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from + start.length);
    return from >= 0 && to > from ? html.slice(from, to) : "";
  };
  const healthSource = between("function buildHealth()", "/* ================= hero");
  const heroSource = between("function buildHero()", "/* ================= episode carousel");
  const stripSource = between("function buildStrip()", "/* ================= detail panel");
  const panelSource = between("function buildPanel()", "/* ================= drilldown modal");
  const compoundSource = between("function buildCompound()", "function renderDrill()");
  const chipSource = between("function healthChip(", "function healthTipHTML");

  if (!healthSource || !heroSource || !stripSource || !panelSource || !compoundSource || !chipSource) {
    bad++; drift("card layout: could not locate every dashboard surface in index.html");
  } else {
    // reading order: health cards → latest/trend cards → carousel → panel → chart
    const order = ['id="health"', 'id="hero"', 'id="strip"', 'id="chartcard"', 'id="panel"'].map((m) => html.indexOf(m));
    if (order.some((at) => at < 0) || order.some((at, i) => i > 0 && at < order[i - 1])) {
      bad++; drift("card layout: locked order broken — health, latest episode, episode carousel, the chart, then the panel (the chart must never be displaced by an open panel)");
    }
    // glance-number discipline: gauge 1; hero one primary number per tab;
    // cards one primary number per tab; the health chip exactly one score
    if ((healthSource.match(/data-fold-number/g) || []).length !== 1) {
      bad++; drift("card layout: the gauge must contribute exactly its saved score to the glance-number budget");
    }
    // one tagged number per measure branch (views/watched/live/reach); exactly
    // one branch ever renders, so the glance budget stays at one number
    if ((heroSource.match(/data-fold-number/g) || []).length !== 4) {
      bad++; drift("card layout: the hero must expose exactly one primary number per measure branch");
    }
    if ((stripSource.match(/data-fold-number/g) || []).length !== 2) {
      bad++; drift("card layout: each episode card must expose exactly one tagged glance number per measure branch");
    }
    // the hero and the cards follow the chart: same measure, same selection
    if (!/const sel = state\.solo \|\| state\.panel/.test(heroSource)
      || !/heroMetricKey\(\)/.test(heroSource) || !/heroMetricKey\(\)/.test(stripSource)
      || !/function heroMetricKey\(\) \{ return state\.mode === "live" \? "live" : state\.metric; \}/.test(html)) {
      bad++; drift("card layout: the hero and episode cards must read the chart's measure and its selected episode (latest when none)");
    }
    // the Growth/Live page tabs are retired: the chart's own views are the
    // only view switch, and they carry the tablist semantics
    if (/id="view"/.test(html) || /class="tabs"/.test(html)) {
      bad++; drift("card layout: the retired Growth/Live page tabs are back");
    }
    if (!/<div class="viewmenu" id="viewmenu" role="listbox"/.test(html) || !/mode: "live"/.test(html)) {
      bad++; drift("card layout: the chart view switch must be the one dropdown and must carry the live per-minute view");
    }
    if ((chipSource.match(/data-fold-number/g) || []).length !== 1) {
      bad++; drift("card layout: the health chip must carry exactly one tagged score");
    }
    // diagnosis: the six saved checks render as plain-word states from the
    // projection only — never from scoring inputs, never as numbers
    if (!/h\.checks/.test(healthSource) || !/checkState\(c\.score, c\.bands\)/.test(healthSource) || !/Not in yet/.test(html)) {
      bad++; drift("card layout: the diagnosis card does not render every saved check as a plain-word state");
    }
    // diagnosis drill (owner directive 2026-08-23; names since 2026-09-01):
    // every check name is a keyboard-reachable tooltip target whose numbers
    // come from the projection's saved measures — value against typical,
    // stored reason when absent
    if (!/c\.measures/.test(healthSource) || !/MEASURE_WORDS/.test(healthSource)
      || !healthSource.includes('<button type="button" class="hname" data-stat=')) {
      bad++; drift("card layout: check names must offer saved-measure drill tooltips (value vs typical), keyboard-reachable");
    }
    // Today's read (owner directive 2026-08-23): the grounded headline plus
    // the top do-next actions read verbatim from the saved recommendation
    // store — no methodology copy on the card (About carries it)
    if (!/DATA\.insights/.test(healthSource) || !/esc\(r\.recommendation\)/.test(healthSource)
      || !/esc\(h\.headline\)/.test(healthSource) || /Saved once a day:/.test(healthSource)) {
      bad++; drift("card layout: Today's read must lead with the saved headline and store-backed do-next actions, without methodology copy");
    }
    // the do-next actions are plain ranked rows: no tooltips, no rules, and
    // the leading ordinal is decorative only (owner directive 2026-08-23)
    if (/class="dnrow"[^`]*data-tip/.test(healthSource) || /\.dnrow \+ \.dnrow \{ border-top/.test(html)
      || !/<span class="dnnum" aria-hidden="true">\$\{i \+ 1\}<\/span>/.test(healthSource)) {
      bad++; drift("card layout: Today's read actions must be plain ranked rows — decorative ordinal, no tooltip, no dividing rule");
    }
    // the hero states one measure: episode health rides the cards and panel
    if (/healthChip\(/.test(heroSource)) {
      bad++; drift("card layout: the hero must not carry the episode-health chip");
    }
    // One strip, one disclosure (2026-09-01, round 2 the same day; owner
    // directive later that day): the glance row carries the gauge with its
    // band in words (the shared BANDS thresholds), the checks as pills grouped
    // fragile-first whose dot carries the state at a glance — the state WORD
    // rides the group's data-state, every pill's accessible name, and the
    // tooltip (the owner chose dots over labels at the glance layer) — and the headline
    // held to three lines; the Expand button opens the details region —
    // evidence and do-next — which is always rendered, inert while closed,
    // and toggled in place so it can move (no re-render on toggle)
    const whyAt = healthSource.indexOf('id="whyscore"');
    const detailsAt = healthSource.indexOf('id="hdetails"');
    if (whyAt < 0 || detailsAt < 0 || whyAt > detailsAt
      || !/aria-controls="hdetails"/.test(healthSource)
      || !/class="hgroups"/.test(healthSource) || !/data-state="\$\{esc\(members\[0\]\.word\)\}"/.test(healthSource)
      || !/aria-label="\$\{esc\(`\$\{c\.label\}: \$\{c\.word\}`\)\}"/.test(healthSource)
      || !/const GROUP_ORDER = \["fragile", "steady", "healthy", "waiting"\]/.test(healthSource)
      || /class="hchip"|class="checkrow"/.test(healthSource)
      || !/scoreBandWords\(h\.score\)/.test(healthSource)
      || !/function scoreBandWords\(score\) \{[\s\S]{0,240}BANDS\.healthy[\s\S]{0,240}BANDS\.steady/.test(html)
      || !/" inert"/.test(healthSource) || !/-webkit-line-clamp: 3/.test(html)
      || /state\.evidenceOpen = !state\.evidenceOpen;\s*render\(\)/.test(healthSource)) {
      bad++; fail("card layout: the health strip must carry the gauge with band words, the checks as state-grouped words (each name a drill target), the clamped headline, and one Expand disclosure ahead of an inert-while-closed details region toggled in place");
    }
    // PRD v10: the page reads the stored direction, outlook, and as-of blocks
    // and the launch words from data.baselines — never recomputing a slope,
    // a range, or a standing; the launch word on a card carries no number
    if (!/DATA\.baselines\?\.direction/.test(healthSource) || !/DATA\.baselines\?\.outlook/.test(healthSource) || !/h\.asOf\?\.newestTitle/.test(healthSource)
      || !/DATA\.baselines\?\.direction/.test(compoundSource) || /h\.direction|h\.outlook/.test(healthSource)
      || !/function launchOf\(e\) \{[\s\S]{0,180}hasYoutubeReading\(e\)[\s\S]{0,180}DATA\.baselines\?\.launch\?\.\[e\.slug\][\s\S]{0,180}launch\?\.value > 0/.test(html)
      || !/const launch = launchOf\(e\)/.test(stripSource) || !/const launch = launchOf\(e\)/.test(panelSource)
      || /theilSen|pctPerEpisode\s*=|Math\.log\(/.test(healthSource) || /class="hs launch[^`]*data-fold-number/.test(stripSource)) {
      bad++; fail("card layout: the page must render the stored direction, outlook, and as-of blocks and the launch words from data.baselines, with no slope or standing recomputed and no number on a launch word");
    }
    // the saved-score trend draws on a fixed scale with the usual level
    // marked (critic 2026-09-01 F6): a small drift must never be stretched to
    // the data's own range, and the first and newest scores are labeled
    const trendSource = html.match(/function healthTrend\(points\) \{[\s\S]*?\n\}/)?.[0] || "";
    if (!/const LO = 25, HI = 75/.test(trendSource) || /Math\.max\(1, hi - lo\)/.test(trendSource)
      || !/class="mid"/.test(trendSource) || !/class="tv now"/.test(trendSource) || !/points\.length < 7/.test(trendSource)) {
      bad++; drift("card layout: the saved-score trend must use the fixed 25–75 scale with the usual level marked and labeled endpoints, and still wait for seven saved days");
    }
    // evidence: starts closed, is a real disclosure, and carries every saved fact
    if (!/evidenceOpen: false/.test(html) || !/state\.evidenceOpen/.test(healthSource)
      || !/aria-expanded/.test(healthSource)
      || !healthSource.includes("bullets(h.pros") || !healthSource.includes("bullets(h.cons")) {
      bad++; drift("card layout: health evidence must start closed behind a real button and contain every exact saved fact");
    }
    // Retired 2026-08-23 (owner directive): the saved-age and early-read line
    // is off the card. Freshness lives in the header stamp, and an early read
    // shows itself as a diagnosis check that isn't in yet — so the gate still
    // holds without a status line announcing it.
    if (/Updated \$\{esc\(saved\)\}/.test(healthSource) || /Early read/.test(healthSource)) {
      bad++; drift("card layout: the retired saved-age / early-read line is back on the health surface");
    }
    if (!/document\.createElement\("button"\)/.test(stripSource) || !/it\.type = "button"/.test(stripSource)) {
      bad++; drift("card layout: episode cards are not real keyboard-operable buttons");
    }
    // locked carousel order: oldest → newest with the newest landed in view
    if (!/strip\.scrollLeft = strip\.scrollWidth/.test(stripSource)) {
      bad++; drift("card layout: the carousel does not land on the newest episode (far right, locked rule)");
    }
    // the one freshness statement left on the page still reads as words
    if (!/relativeDayWords\(phoenixDateKey\(DATA\.generatedAt\)\)/.test(html)
      || !/Data refreshed \$\{esc\(when\)\}/.test(html)) {
      bad++; drift("card layout: the header freshness stamp must render as relative words, not numeric tokens");
    }
    if (/addSentimentChip|chip\.senti/.test(html) || !/Audience feedback/.test(panelSource)) {
      bad++; drift("card layout: audience feedback counts must live only in the click-open episode panel");
    }
    if (/sameAgeSub\s*\(/.test(stripSource) || /class=["']r3["']/.test(stripSource)) {
      bad++; drift("card layout: pace and status lines still render on the episode cards");
    }
    if (!/const pace = sameAgeSub\(e\)/.test(panelSource) || !/YouTube views at the same age/.test(panelSource)) {
      bad++; drift("card layout: the same-age pace comparison is not present in the click-open episode panel");
    }
    // trend card (re-ruled 2026-08-23): bars name value and episode in small
    // print with ONE emphasized bar — still no tagged glance numbers and no
    // clean-week bookkeeping copy
    if (/data-fold-number|clean weeks:/.test(compoundSource)) {
      bad++; drift("card layout: the trend card must not tag glance numbers or carry clean-week counts");
    }
    if (!/class="bnum"/.test(compoundSource) || !/class="bep"/.test(compoundSource)
      || (compoundSource.match(/cbar\$\{hot \? " hot" : ""\}/g) || []).length !== 2) {
      bad++; drift("card layout: trend bars must label value and episode with one emphasized bar, in both trend branches");
    }
    if (!/splitReady = hasYoutube && Number\.isFinite\(tv\)[\s\S]*yt \+ x === tv/.test(heroSource)
      || /e\.latest\.(?:ytTotal|xPlays) \?\? 0/.test(heroSource)) {
      bad++; drift("card layout: the platform bar is not locked to complete stored YouTube and X values");
    }
    // the panel must explain the score's basis and its missing checks
    if (!/Episode health/.test(panelSource) || !/healthOf\(e\)/.test(panelSource) || !/newer episodes never change this score/.test(panelSource)) {
      bad++; drift("card layout: the episode panel does not gate and explain the finished score");
    }
    if (!/How people watch/.test(panelSource) || !/Where views came from/.test(panelSource)) {
      bad++; drift("card layout: the episode panel is missing its watching and view-source sections");
    }
    if (!html.includes('role="listbox"') || !/setAttribute\("aria-selected"/.test(html)
      || !/addEventListener\("focusin"[\s\S]*showRtt/.test(html)) {
      bad++; drift("card layout: the view switch or health-chip help is not keyboard-readable");
    }
  }
  if (!bad) {
    const latest = data.episodes?.at(-1);
    const finished = (data.episodes || []).filter((e) => e.health && !e.health.pending && e.health.score != null).length;
    const cardNumbers = (data.episodes || []).filter((e) => (e.latest?.totalViews ?? e.latest?.ytTotal) != null).length;
    const heroChip = latest?.health && !latest.health.pending && latest.health.score != null ? 1 : 0;
    const literalBudget = (data.health ? 1 : 0) + 1 + heroChip + cardNumbers + finished;
    ok(`card layout: ${literalBudget} visible numeric tokens at glance (gauge, hero, ${cardNumbers} card totals, ${finished} finished read(s)); evidence, panel, feedback, and pace are on demand`);
  }
}

// --- 1p. chart metric picker + platform marks (owner directives 2026-08-23) ---
// Each alternate measure charts one stored per-episode number in its own
// unit; nothing is summed across units, a missing value never becomes a zero
// bar, and the live tooltip carries the episode's lowest/highest concurrents.
// Platform marks always keep an accessible text name.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  // A template placeholder inside a QUOTED string never interpolates — it
  // renders as literal ${...} text on the page (the table header shipped
  // that way 2026-08-23). Quoted strings must not carry placeholders.
  for (const m of html.matchAll(/[+=]=? ("[^"\n]*\$\{[^"\n]*"|'[^'\n]*\$\{[^'\n]*')/g)) {
    bad++; drift(`template hygiene: a quoted string carries an uninterpolated placeholder — ${m[1].slice(0, 60)}`);
  }
  // ONE control for one decision (owner directive 2026-08-23): every chart the
  // dashboard draws lives in a single dropdown whose current item IS the
  // heading. No parallel tab strip, no native select.
  const defsBlock = html.match(/const VIEW_DEFS = \[([\s\S]*?)\n\];/)?.[1] || "";
  const defs = [...defsBlock.matchAll(/\{ key: "([a-z]+)", group: "([^"]+)", title: "([^"]+)", mode: "([a-z]+)"(?:, metric: "([a-z]+)")? \}/g)]
    .map(([, key, group, title, mode, metric]) => ({ key, group, title, mode, metric }));
  if (defs.length < 5) { bad++; fail("chart metrics: the view list could not be read — every chart must be declared in VIEW_DEFS"); }
  const modes = new Set(defs.map((d) => d.mode));
  for (const required of ["standings", "race", "watch", "live"]) {
    if (!modes.has(required)) { bad++; fail(`chart metrics: the view list is missing the ${required} chart`); }
  }
  for (const metric of ["views", "watched", "live", "reach"]) {
    if (!defs.some((d) => d.mode === "standings" && d.metric === metric)) {
      bad++; fail(`chart metrics: the per-episode ${metric} measure is missing from the view list`);
    }
  }
  if (/id="mode"/.test(html) || /data-v="standings"/.test(html) || /<select id="metric"/.test(html)) {
    bad++; drift("chart metrics: the retired tab strip or native measure select is back — one dropdown owns this decision");
  }
  if (!/<button type="button" class="viewbtn" id="viewbtn" aria-haspopup="listbox"/.test(html)
    || !/<div class="viewmenu" id="viewmenu" role="listbox"/.test(html)
    || !/o\.setAttribute\("role", "option"\)/.test(html)
    || !/o\.setAttribute\("aria-selected", String\(selected\)\)/.test(html)
    || !/ev\.key === "Escape"/.test(html) || !/ev\.key === "ArrowDown"/.test(html)) {
    bad++; drift("chart metrics: the view dropdown must be a keyboard-operable listbox whose button reports its expanded state");
  }
  // a scope tag never repeats the heading, and never rides on gray text alone
  if (!/function scopeTag\(mark, name\)/.test(html) || !/<span class="sr">\$\{esc\(name\)\}<\/span>/.test(html)) {
    bad++; drift("chart metrics: platform scope tags must carry a spoken name beside the mark");
  }
  for (const d of defs) {
    const scopes = [...html.matchAll(new RegExp(`METRIC_TITLES\\.${d.metric}, \`([^\`]*)\``, "g"))].map((m) => m[1]);
    for (const scope of scopes) {
      if (scope.includes(d.title)) { bad++; fail(`chart metrics: the ${d.key} scope line repeats its own heading ("${d.title}")`); }
    }
  }
  // hero split bar: both the segments and their labels explain themselves,
  // from one definition, with the labels keyboard-reachable
  if (!/function splitBar\(segments, wholeWords\)/.test(html)
    || !/<span class="pseg"[^`]*\$\{tip\}/.test(html)
    || !/<span class="sl" \$\{tip\} tabindex="0" aria-label=/.test(html)
    || (html.match(/html \+= splitBar\(/g) || []).length !== 2) {
    bad++; drift("chart metrics: the hero split bar's segments and labels must share one tooltip definition and stay keyboard-reachable");
  }
  // one text edge inside the chart tooltip: chips hang in a fixed gutter
  if (!/\.tt \{ --chip: 15px; \}/.test(html)
    || !/\.tt \.meta, \.tt \.big, \.tt \.chg, \.tt \.note \{ padding-left: var\(--chip\); \}/.test(html)) {
    bad++; drift("chart metrics: the chart tooltip's title, number, and rows must share one left text edge");
  }
  // bar totals anchor to the rightmost VISIBLE segment and count only what is
  // drawn — hiding a destination from the legend must never strand the label
  // on the axis or leave it describing bars that are off screen
  const totalsPlugin = html.match(/const barTotals = \{[\s\S]*?\n\};/)?.[0] || "";
  if (!/chart\.isDatasetVisible\(meta\.index\)/.test(totalsPlugin)
    || !/const endX = Math\.max\(\.\.\.bars\.map\(\(b\) => b\.x\)\);/.test(totalsPlugin)
    || !/const whole = visible\.length === chart\.data\.datasets\.length;/.test(totalsPlugin)
    || !/const available = showing\.filter\(Number\.isFinite\);/.test(totalsPlugin)
    || !/const total = whole \? displayedTotal\(e\) : drawn;/.test(totalsPlugin)
    || /getDatasetMeta\(chart\.data\.datasets\.length - 1\)/.test(totalsPlugin)
    || !/const segVis = chart\.data\.datasets\.map\(\(_, di\) => chart\.isDatasetVisible\(di\)\);/.test(html)
    || !/across shown destinations/.test(html)) {
    bad++; drift("chart metrics: bar totals AND the tooltip must follow legend visibility — one rule for both numbers");
  }
  // reader-facing prose rows fill their card: no arbitrary character caps
  if (/\.insight \.body \{[^}]*max-width/.test(html) || /\.health-evidence li span \{[^}]*max-width/.test(html)) {
    bad++; drift("chart metrics: insight and evidence rows must fill the card, not a fixed character measure");
  }
  if (!/state\.metric = "views"; state\.byDate = false/.test(html) && !/state\.metric = "views";/.test(html)) {
    bad++; drift("chart metrics: reset does not restore the views measure");
  }
  if (!html.includes("watched: { get: (e) => hasYoutubeReading(e) ? e.watch?.avgPercent ?? null : null")
    || !html.includes("live: { get: (e) => e.live?.avg ?? null")
    || !html.includes("reach: { get: (e) => e.latest?.xImpressions ?? null")) {
    bad++; drift("chart metrics: each measure must read exactly its stored per-episode number, null when absent (never zero)");
  }
  if (!/state\.metric === "live" && ep\.live/.test(html)
    || !html.includes(">Lowest<") || !html.includes(">Highest<")) {
    bad++; drift("chart metrics: the live tooltip must show the episode's lowest and highest concurrents");
  }
  if (!/Exposure, not watching — never added into views/.test(html)) {
    bad++; fail("chart metrics: the reach view must state its unit is exposure, outside every views total");
  }
  const logoCount = (html.match(/role="img" aria-label="(?:YouTube|X)"/g) || []).length;
  if (logoCount !== 2 || !/const PLOGO = \{/.test(html) || !/TT_HTML/.test(html)) {
    bad++; drift("platform marks: the YouTube and X logos must exist exactly once each, with accessible names, and label the destination rows");
  }
  if (!bad) ok("chart metrics: measure picker unit-scoped with silent absence, live lowest/highest on the tooltip, platform marks accessibly named");
}

// --- 1q. one page gutter (owner directive 2026-08-23) ---
// Every card, column, and row on the page grid shares a single spacing token,
// and any container inset (scroll padding, borders) is compensated so the
// PAINTED card edges land on the same grid. Measured in a browser at both
// widths on 2026-08-23: all edges flush, every gap identical.
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  if (!/--gap: 14px;/.test(html) || !/:root \{ --gap: 10px; \}/.test(html)) {
    bad++; drift("page gutter: the spacing token must be defined once for desktop and once for the phone cut");
  }
  const GUTTERED = [
    // the health row is one card since 2026-09-01 (no inner grid to gap);
    // its bottom margin still rides the token
    [".healthrow", /\.healthrow \{[^}]*margin-bottom: var\(--gap\);/],
    [".overview", /\.overview \{[^}]*gap: var\(--gap\); margin-bottom: var\(--gap\);/],
    [".carousel", /\.carousel \{ display: flex; gap: var\(--gap\);/],
    ["#chartcard", /#chartcard \{[^}]*margin-bottom: var\(--gap\);/],
    [".panel", /\.panel \{[^}]*padding: var\(--gap\); margin: var\(--gap\) 0;/],
    [".pgrid", /\.panel \.pgrid \{[^}]*gap: var\(--gap\); margin-top: var\(--gap\);/],
    [".insights", /\.insights \{ display: grid; gap: var\(--gap\); \}/],
    ["header", /header \{[^}]*margin-bottom: var\(--gap\);/],
  ];
  for (const [name, re] of GUTTERED) {
    if (!re.test(html)) { bad++; drift(`page gutter: ${name} does not use the shared spacing token`); }
  }
  // page cards carry no border: the fill is the whole edge, so nothing eats
  // into the gutter (the panel's inset is the token exactly)
  for (const [name, re] of [[".card", /\.card \{ background: var\(--s1\); border: 0;/],
    ["#chartcard", /#chartcard \{ background: var\(--s1\); border: 0;/],
    [".sitem", /\.sitem \{[^}]*border: 0;/], [".insight", /\.insight \{ background: var\(--s1\); border: 0;/],
    [".panel", /\.panel \{ background: var\(--s2\); border: 0;/]]) {
    if (!re.test(html)) { bad++; drift(`page gutter: ${name} still draws a border — cards are fill only`); }
  }
  // the carousel's focus-ring inset must be pulled back out, or its cards sit
  // off the grid every other row lands on
  if (!/\.carousel \{[^}]*padding: 2px;\s*\n\s*margin: -2px -2px calc\(var\(--gap\) - 2px\);/.test(html)) {
    bad++; drift("page gutter: the carousel's scroll inset is not compensated — its painted card edges would sit inside the page grid");
  }
  if (!bad) ok("page gutter: one spacing token drives every card, column, and row; container insets compensated so painted edges align");
}

// --- 1r. destination links (W18): stored, recomputed from the registry, opened safely ---
{
  let bad = 0;
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const e of eps) {
    const show = registry.shows.find((s) => s.slug === e.slug);
    const expected = {};
    for (const t of show?.targets || []) {
      if (t.kind === "youtube" && t.videoId) expected[`yt:${t.account}`] = `https://youtube.com/watch?v=${t.videoId}`;
      if (t.kind === "x" && t.role !== "promo") {
        if (t.broadcastId) expected[`x:${t.account}`] = `https://x.com/i/broadcasts/${t.broadcastId}`;
        else if (t.postId) expected[`x:${t.account}`] = `https://x.com/${t.account}/status/${t.postId}`;
      }
    }
    const want = Object.keys(expected).length ? expected : undefined;
    if (JSON.stringify(e.links ?? null) !== JSON.stringify(want ?? null)) { bad++; fail(`links: ${e.slug} stored destination links do not recompute from the registry`); }
    for (const url of Object.values(e.links || {})) {
      if (!/^https:\/\/(youtube\.com\/watch\?v=[A-Za-z0-9_-]+|x\.com\/(i\/broadcasts\/[A-Za-z0-9]+|[A-Za-z0-9_]+\/status\/\d+))$/.test(url)) {
        bad++; fail(`links: ${e.slug} link has an unexpected shape — ${url}`);
      }
    }
  }
  if (!html.includes('const url = e.links?.[d.key];')
    || !/class="plink" href="\$\{esc\(url\)\}" target="_blank" rel="noopener">/.test(html)) {
    bad++; drift("links: the panel must render destination links only from stored e.links, opened in a new tab with noopener");
  }
  if (!bad) ok(`links: ${eps.filter((e) => e.links).length} episode(s) store destination links — registry-locked, safe URL shapes, panel renders only what is stored`);
}

// --- 1u. baselines (PRD v9 W22a): one definition of "typical", re-derived and fixture-tested ---
{
  let bad = 0;
  try {
    execFileSync(process.execPath, [join(HERE, "baselines.test.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    bad++; fail(`baselines: fixture test failed — ${String(err.stderr || err.message).split("\n").find((l) => /AssertionError|Error/.test(l)) || err.message}`);
  }
  for (const fixture of [
    ["youtube-missing-data.test.mjs", "missing-data capture"],
    ["youtube-release-date.test.mjs", "broadcast-day discovery"],
    ["episode-date-sync.test.mjs", "episode-date store sync"],
    ["youtube-zero-downstream.test.mjs", "startup-zero downstream"],
    ["x-broadcast-discovery.test.mjs", "late X broadcast discovery"],
    ["transcripts-pull.test.mjs", "transcript source and no-overwrite"],
    ["beehiiv-promotions.test.mjs", "newsletter link attribution"],
    ["live-parity.test.mjs", "production transcript byte proof"],
  ]) {
    try {
      execFileSync(process.execPath, [join(HERE, fixture[0])], { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      bad++; fail(`${fixture[1]} regression failed — ${String(err.stderr || err.message).split("\n").find((l) => /AssertionError|Error/.test(l)) || err.message}`);
    }
  }
  let B = null;
  try { B = await import(join(TOOL, "baselines.mjs")); }
  catch (err) { bad++; fail(`baselines: module failed to load — ${err.message}`); }
  if (B) {
    const shipped = data.baselines;
    if (!shipped) { bad++; fail("baselines: data.json carries no baselines projection"); }
    else {
      // Re-derive through the SAME path build-data uses (computeAll → baselines
      // with the flags + analytics-history options). A naked computeBaselines(eps)
      // call lacks those options and diverges the first day a newestVsPrevious
      // reading comes from history lines instead of embedded episode data —
      // which is exactly what happened 2026-08-30 (E7 day-2 watched reading):
      // the gate failed on healthy data. Block 1c already proves computeAll
      // reproduces data.json byte-for-byte; this keeps 1u's structural checks
      // anchored to that same reproduction instead of a weaker second path.
      let again = null;
      try {
        const bd = await import(join(TOOL, "build-data.mjs"));
        again = bd.computeAll({ now: Date.parse(data.generatedAt) }).baselines;
      } catch (err) { bad++; fail(`baselines: re-derive via computeAll threw — ${err.message}`); }
      if (again && JSON.stringify(again) !== JSON.stringify(shipped)) { bad++; fail("baselines: data.baselines does not re-derive from the shipped episodes"); }
      if (JSON.stringify(shipped.constants) !== JSON.stringify(B.CONSTANTS)) { bad++; fail("baselines: shipped constants differ from baselines.mjs"); }
      if (shipped.constants.MIN_PEERS < 3) { bad++; fail("baselines: MIN_PEERS below the constitution's small-n rule"); }
      for (const [slug, a] of Object.entries(shipped.anomaly)) {
        for (const [unit, u] of Object.entries(a.units)) {
          if (u.window.includes(slug)) { bad++; fail(`baselines: ${slug} ${unit} outlier window includes itself`); }
          if (u.tier === "known-promotion") {
            if (u.source !== "newsletter" || u.n !== 0 || u.typical !== null || u.window.length !== 0 || u.flag !== true) {
              bad++; fail(`baselines: ${slug} ${unit} known newsletter promotion is not stored as a source fact outside the peer test`);
            }
          } else if (u.tier != null && u.n < shipped.constants.MIN_PEERS) {
            bad++; fail(`baselines: ${slug} ${unit} outlier test ran on ${u.n} peers`);
          }
          if (u.flag && a.flagged !== true) { bad++; fail(`baselines: ${slug} ${unit} flags but the episode is not marked flagged`); }
        }
        const expectedProvisional = Object.values(a.units).some((u) => u.flag && typeof u.tier === "number" && u.tier !== 1);
        if (a.provisional !== expectedProvisional) { bad++; fail(`baselines: ${slug} provisional stamp disagrees with its numbered tiers`); }
      }
      for (const e of eps.filter((episode) => !B.firstYtSnapshot(episode))) {
        const launch = shipped.launch?.[e.slug] ?? null;
        const pace = shipped.pace?.[e.slug] ?? null;
        const ytAnomaly = shipped.anomaly?.[e.slug]?.units?.ytViews;
        if (launch != null) { bad++; fail(`baselines: ${e.slug} has no YouTube reading but carries a launch result`); }
        if (pace != null) { bad++; fail(`baselines: ${e.slug} has no YouTube reading but carries a pace result`); }
        const emptyMarker = ytAnomaly && ytAnomaly.tier === null && ytAnomaly.value === null && ytAnomaly.typical === null && ytAnomaly.n === 0 && ytAnomaly.window?.length === 0 && ytAnomaly.flag === false;
        const knownMarker = e.promotion?.matchedUnits?.includes("ytViews") && ytAnomaly?.tier === "known-promotion" && ytAnomaly.value === null && ytAnomaly.typical === null && ytAnomaly.n === 0 && ytAnomaly.window?.length === 0 && ytAnomaly.flag === true && ytAnomaly.source === "newsletter";
        if (!emptyMarker && !knownMarker) {
          bad++; fail(`baselines: ${e.slug} pre-air or startup-zero row entered the YouTube outlier history`);
        }
        if (data.health?.asOf?.newest === e.slug) {
          const measures = (data.health.checks || []).flatMap((check) => check.measures || []);
          for (const measure of measures.filter((item) => ["sameAge", "engagement"].includes(item.key))) {
            if (measure.value != null || measure.episodeRead === e.slug) { bad++; fail(`health: ${e.slug} startup zero entered ${measure.key}`); }
          }
        }
      }
      for (const [slug, p] of Object.entries(shipped.pace)) {
        if (p && p.peers.includes(slug)) { bad++; fail(`baselines: ${slug} pace peers include itself`); }
        if (p && p.rank != null && p.n < shipped.constants.MIN_PEERS) { bad++; fail(`baselines: ${slug} pace ranked on ${p.n} peers`); }
        if (p && p.rank == null && !p.reason) { bad++; fail(`baselines: ${slug} pace absent without a reason`); }
        for (const x of p?.peers || []) if (shipped.anomaly[x]?.units?.ytViews?.flag) { bad++; fail(`baselines: ${slug} pace peers include a YouTube outlier ${x}`); }
      }
      const flagsAgain = B.anomalyFlags(eps);
      for (const e of eps) {
        const want = flagsAgain.get(e.slug)?.text ?? null;
        if ((e.metrics?.anomaly ?? null) !== want) { bad++; fail(`baselines: ${e.slug} metrics.anomaly does not match the baselines outlier test`); }
      }
      if (shipped.typicalCurve.points && shipped.typicalCurve.n < shipped.constants.MIN_PEERS) { bad++; fail("baselines: typical curve drawn from fewer than MIN_PEERS curves"); }
      for (const x of shipped.typicalCurve.window) if (shipped.anomaly[x]?.units?.ytViews?.flag) { bad++; fail(`baselines: typical curve includes a YouTube outlier ${x}`); }
      if (shipped.watchPct.typical != null && shipped.watchPct.n < shipped.constants.MIN_PEERS) { bad++; fail("baselines: watched typical from fewer than MIN_PEERS episodes"); }
    }
  }
  if (!bad) ok(`baselines: fixtures green; pre-air and startup-zero rows are absent from launch, pace, outliers, and health; ${Object.values(data.baselines?.anomaly || {}).filter((a) => a.flagged).length} outlier(s)`);
}

// --- 1v. chain freshness (PRD v9 W24): every required input store is fresh against the chain definition ---
{
  let bad = 0;
  let chain = null;
  try { chain = JSON.parse(readFileSync(join(TOOL, "chain.json"), "utf8")); } catch (err) { bad++; drift(`chain: tools/dive-analytics/chain.json unreadable — ${err.message}`); }
  if (chain) {
    const builtAt = Date.parse(data.generatedAt);
    const publishIdx = chain.steps.findIndex((s) => s.step === "publish");
    const order = chain.steps.map((s) => s.step);
    for (const must of ["transcripts", "newsletter-promotion", "snapshot", "ratings", "build-data", "validate", "publish"]) if (!order.includes(must)) { bad++; drift(`chain: step ${must} missing from chain.json`); }
    if (order.lastIndexOf("validate") > publishIdx || order.indexOf("health") > order.lastIndexOf("build-data")) { bad++; drift("chain: validate must run before publish and health before the final build-data"); }
    const firstBuild = order.indexOf("build-data");
    const transcriptStep = chain.steps.find((step) => step.step === "transcripts");
    const newsletterStep = chain.steps.find((step) => step.step === "newsletter-promotion");
    if (!transcriptStep?.required || order.indexOf("transcripts") > firstBuild) { bad++; drift("chain: transcript import must be required and run before build-data"); }
    if (!newsletterStep?.required || newsletterStep.freshnessKey !== "lastSuccessfulAt" || JSON.stringify(newsletterStep.writes) !== JSON.stringify(["data/restream/beehiiv-promotions.json"]) || order.indexOf("newsletter-promotion") > firstBuild) {
      bad++; drift("chain: newsletter promotion capture must be required, current, and run before build-data");
    }
    const within60d = (slug) => { const e = eps.find((x) => x.slug === slug); return e && e.ageDays <= 60; };
    const active = (slug) => { const e = eps.find((x) => x.slug === slug); return !!e; };
    const inScope = (scope, slug) => scope === "all" || (scope === "episodes-within-60d" ? within60d(slug) : active(slug));
    for (const step of chain.steps) {
      if (!step.freshnessKey) continue;
      for (const pattern of step.writes) {
        if (!pattern.includes("*")) {
          const path = join(ROOT, pattern);
          if (!existsSync(path)) { if (step.required) { bad++; fail(`chain: required store ${pattern} is missing`); } continue; }
          // A step-level freshness key applies to the JSON stores that carry
          // it. Sibling text/JavaScript outputs are checked byte-for-byte by
          // the rebuild and publish-integrity blocks instead.
          if (!pattern.endsWith(".json")) continue;
          let stamp = null;
          try {
            const j = JSON.parse(readFileSync(path, "utf8"));
            stamp = step.freshnessKey === "updatedAt" ? j.updatedAt
              : step.freshnessKey === "generatedAt" ? j.generatedAt
              : step.freshnessKey === "lastSuccessfulAt" ? j.lastSuccessfulAt
              : step.freshnessKey === "entries[-1].date" ? `${j.entries?.at(-1)?.date}T12:00:00Z`
              : null;
          } catch { /* checked as a missing stamp below */ }
          if (!stamp || !Number.isFinite(Date.parse(stamp))) {
            const msg = `chain: ${pattern} has no valid ${step.freshnessKey} stamp`;
            if (step.required) { bad++; fail(msg); } else warn(msg);
            continue;
          }
          const lag = builtAt - Date.parse(stamp);
          if (lag > FRESH_MS) {
            const msg = `chain: ${pattern} is ${Math.round(lag / 3600000)} h behind the build (${stamp})`;
            if (step.required) { bad++; fail(msg); } else warn(msg);
          }
          continue;
        }
        const dir = join(ROOT, pattern.slice(0, pattern.lastIndexOf("/")));
        const ext = pattern.slice(pattern.lastIndexOf("."));
        if (!existsSync(dir)) { if (step.required && step.freshnessKey !== "updatedAt") { bad++; fail(`chain: required store directory ${dir} is missing`); } continue; }
        for (const file of readdirSync(dir).filter((f) => f.endsWith(ext))) {
          const slug = file.slice(0, -ext.length);
          if (!inScope(step.scope, slug)) continue;
          const path = join(dir, file);
          let stamp = null;
          try {
            if (ext === ".jsonl") { const lines = readFileSync(path, "utf8").split("\n").filter(Boolean); stamp = lines.length ? JSON.parse(lines.at(-1)).pulledAt : null; }
            else { const j = JSON.parse(readFileSync(path, "utf8")); stamp = step.freshnessKey === "snapshots[-1].ts" ? j.snapshots?.at(-1)?.ts : j.updatedAt; }
          } catch { /* unreadable */ }
          if (!stamp) continue;
          const lag = builtAt - Date.parse(stamp);
          if (lag > FRESH_MS) {
            const msg = `chain: ${pattern.replace("*", slug)} is ${Math.round(lag / 3600000)} h behind the build (${stamp})`;
            if (step.required && ext !== ".jsonl") { bad++; fail(msg); } else warn(msg);
          }
        }
      }
    }
    const wrapperSource = readFileSync(join(ROOT, "scripts", "restream", "postlive-publish.sh"), "utf8");
    const publishSource = readFileSync(join(TOOL, "publish-flow.mjs"), "utf8");
    const runnerSource = readFileSync(join(TOOL, "run-chain.mjs"), "utf8");
    const checkoutSource = readFileSync(join(TOOL, "publisher-checkout.mjs"), "utf8");
    const scopeSource = readFileSync(join(TOOL, "publish-scope.mjs"), "utf8");
    const freshnessSource = readFileSync(join(TOOL, "freshness.mjs"), "utf8");
    const dailySource = readFileSync(join(TOOL, "run-daily.mjs"), "utf8");
    const recoverySource = readFileSync(join(TOOL, "recover-publish.mjs"), "utf8");
    const paritySource = readFileSync(join(TOOL, "live-parity.mjs"), "utf8");
    const alertsSource = readFileSync(join(TOOL, "alerts.mjs"), "utf8");
    const queueSource = readFileSync(join(TOOL, "alert-queue.mjs"), "utf8");
    const mirrorSource = readFileSync(join(ROOT, "scripts", "restream", "mirror-transcripts.mjs"), "utf8");
    if (!/set -eu/.test(wrapperSource) || !/exec node tools\/dive-analytics\/publish-flow\.mjs/.test(wrapperSource)) { bad++; drift("chain: publish wrapper must hand off to the checked release flow"); }
    if (!/branch !== "main"/.test(checkoutSource) || !/assertPublishScope\(root\)/.test(checkoutSource) || !/assertCommittedPublishScope\(root\)/.test(checkoutSource)) { bad++; drift("chain: the publisher checkout must require main and reject undeclared changes in files or local commits"); }
    if (!/assertPublisherCheckout\(ROOT\)/.test(runnerSource) && !/assertPublisherCheckout\(root\)/.test(runnerSource)) { bad++; drift("chain: runner must check the dedicated publisher checkout before capture"); }
    if (runnerSource.indexOf("pullFirst();") < 0 || runnerSource.indexOf("pullFirst();") > runnerSource.indexOf("for (const step of chain.steps)")) { bad++; drift("chain: runner must pull and check main before the first step"); }
    if (!/pullCurrentMain\(root/.test(publishSource) || publishSource.indexOf("pullCurrentMain(root") > publishSource.indexOf("commitFinalOutputs(root")) { bad++; drift("chain: release must pull main before committing data"); }
    if (!/\["push", "--quiet", "origin", "HEAD:main"\]/.test(publishSource) || /\["push"[^\n]+"origin", "main"\]/.test(publishSource)) { bad++; drift("chain: every release push must send the checked commit to GitHub main"); }
    if (!/stagePublishScope\(root\)/.test(publishSource) || !/\["add", "--all", "--", \.\.\.paths\]/.test(scopeSource)) { bad++; drift("chain: release staging must use only exact declared output paths"); }
    if (/git add -A|git add --all/.test(publishSource) || /vercel[^\n]*\|/.test(publishSource)) { bad++; drift("chain: release must not stage broadly or hide a Vercel failure in a pipe"); }
    if (!/MAX_ATTEMPTS = 2/.test(publishSource) || !/checkLiveParity/.test(publishSource) || !/validate\.mjs", "--publish"/.test(publishSource)) { bad++; drift("chain: release must stop after two tries, recheck final files, and prove production bytes"); }
    if (!/PUBLIC_ARTIFACTS/.test(paritySource) || !/parityArtifactsForRoot/.test(paritySource) || !/transcripts\/\$\{episode\.slug\}\.txt/.test(paritySource) || !/AbortSignal\.timeout\(20_000\)/.test(paritySource)) { bad++; drift("chain: production byte checks must include every served transcript and use a bounded request"); }
    if (!/newsletter-promotion/.test(runnerSource) || !/RETRY_ONCE/.test(runnerSource)) { bad++; drift("chain: the newsletter platform pull must stop after its one retry"); }
    if (/step\.step === "publish"\s*&&\s*code === 2/.test(runnerSource)) { bad++; drift("chain: an unconfirmed release exit must never be treated as published"); }
    if (!/America\/Phoenix/.test(freshnessSource) || !/kind: "prior-day"/.test(freshnessSource)) { bad++; drift("chain: freshness must reject a previous Phoenix day even when it is only a few hours old"); }
    if (!/MAX_DAILY_ATTEMPTS = 2/.test(dailySource) || !/acquireLock/.test(dailySource) || !/run-chain\.mjs/.test(dailySource)) { bad++; drift("chain: the scheduled entry point must lock and cap whole-chain work at two attempts a day"); }
    if (!/run-daily\.mjs", "--recovery"/.test(recoverySource) || /run-chain\.mjs/.test(recoverySource) || !/const after = await verify/.test(recoverySource)) { bad++; drift("chain: recovery must use the guarded second attempt and prove production again"); }
    const alertsStep = chain.steps.find((step) => step.step === "alerts");
    const freshnessStep = chain.steps.find((step) => step.step === "freshness");
    if (!alertsStep?.required || !freshnessStep?.required || !freshnessStep.script.includes("--strict")) { bad++; drift("chain: alert detection and the final production check must be required"); }
    if (!/acknowledgeQueueLines\(batch/.test(alertsSource) || !/message", "send"/.test(alertsSource) || !/\.delivery\.lock/.test(alertsSource)) { bad++; drift("chain: Slack alerts must stay queued until a locked delivery returns a receipt"); }
    if (!/openSync\(path, "wx"/.test(queueSource) || !/renameSync\(tmp, path\)/.test(queueSource)) { bad++; drift("chain: alert queue updates must be locked and atomic"); }
    if (!/DEFAULT_SOURCE = join\(ROOT, "transcripts"\)/.test(mirrorSource) || /Dev["', ]+2026["', ]+dive-radio-analytics["', ]+transcripts/.test(mirrorSource)) { bad++; drift("chain: transcript mirroring must read this dedicated checkout, not an active development tree"); }
  }
  if (!bad) ok(`chain: ${chain?.steps.length ?? 0} steps defined; required stores are current; daily runs are isolated, bounded, delivered, and proved on production`);
}

// --- 1w. agent brief (PRD v12): complete by construction, honest, grounded ---
{
  let bad = 0;
  try {
    const AB = await import(join(TOOL, "agent-brief.mjs"));
    const CH = await import(join(TOOL, "chapters.mjs"));
    const md = existsSync(join(ROOT, "agent.md")) ? readFileSync(join(ROOT, "agent.md"), "utf8") : "";
    const digest = existsSync(join(ROOT, "agent.json")) ? JSON.parse(readFileSync(join(ROOT, "agent.json"), "utf8")) : null;
    if (!md || !digest) { bad++; fail("agent: agent.md / agent.json missing — the brief does not reproduce"); }
    else {
      // census (rule 27): every data.json path is covered or left out with a reason — drift, fixed at push time
      const missing = AB.uncovered(data);
      if (missing.length) { bad++; drift(`agent: ${missing.length} data.json path(s) reach neither the brief nor its leaves-out list — ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}`); }
      // fixed headings, in order
      let at = -1;
      for (const hd of AB.HEADINGS) { const i = md.indexOf(`\n${hd}\n`); if (i < 0 || i < at) { bad++; drift(`agent: heading "${hd}" missing or out of order in agent.md`); } at = Math.max(at, i); }
      // numbers: the brief re-derives from data.json (fail)
      if (data.health && !data.health.withheld) {
        if (digest.health?.score !== data.health.score) { bad++; fail(`agent: health score in the brief (${digest.health?.score}) does not re-derive from data.json (${data.health.score})`); }
        if (digest.health?.provider !== data.health.provider || digest.health?.model !== data.health.model) { bad++; fail("agent: health writer source in the brief does not match data.json"); }
        const writerLabel = data.health.provider === "deterministic" ? "fixed fallback" : "model-written";
        if (!md.includes(`Headline (${writerLabel}):`)) { bad++; fail("agent: health headline does not name whether a model or the fixed fallback wrote it"); }
        for (const c of data.health.checks || []) { const d = (digest.health?.checks || []).find((x) => x.key === c.key); if (!d || d.score !== c.score || d.state !== c.state) { bad++; fail(`agent: check ${c.key} in the brief does not re-derive from data.json`); } }
        if (!md.includes(`**Score ${data.health.score} of 100`)) { bad++; fail("agent: agent.md does not print the health score it re-derives"); }
        for (const f of data.health.facts || []) if (!md.includes(`| ${f.id} |`)) { bad++; fail(`agent: fact ${f.id} is not citable from agent.md`); }
      }
      if (digest.promotionUpdatedAt !== data.promotionUpdatedAt || digest.clocks?.promotionChecked !== data.promotionUpdatedAt) {
        bad++; fail("agent: newsletter promotion update time does not match data.json");
      }
      const ranked = (data.insights || []).filter((i) => i.rank != null);
      for (const i of ranked) { const d = (digest.recommendations || []).find((r) => r.id === i.id); if (!d || d.finding !== i.text || d.action !== i.recommendation || d.rank !== i.rank) { bad++; fail(`agent: recommendation ${i.id} in the brief does not re-derive from data.json`); } if (!md.includes(i.recommendation)) { bad++; fail(`agent: recommendation ${i.id} action text is not in agent.md verbatim`); } }
      for (const e of data.episodes) {
        const d = (digest.episodes || []).find((x) => x.slug === e.slug);
        if (!d) { bad++; fail(`agent: episode ${e.slug} missing from the brief`); continue; }
        const agentYoutube = Number.isFinite(e.latest?.ytTotal) && e.latest.ytTotal > 0 ? e.latest.ytTotal : null;
        const agentTotal = agentYoutube == null ? null : (e.latest?.totalViews ?? null);
        if (d.views.total !== agentTotal || d.views.youtube !== agentYoutube) { bad++; fail(`agent: E${e.ep} views in the brief do not re-derive from data.json under the missing-YouTube rule`); }
        if (agentYoutube == null && (d.views.youtubeMarker !== "missing" || !d.views.reason)) { bad++; fail(`agent: E${e.ep} missing YouTube is not named in the brief`); }
        if (d.trackedLate !== (e.partialHistory == null ? null : e.partialHistory === true)) { bad++; fail(`agent: E${e.ep} tracking state does not preserve unknown separately from on-time`); }
        if (JSON.stringify(d.promotion ?? null) !== JSON.stringify(e.promotion ?? null)) { bad++; fail(`agent: E${e.ep} newsletter promotion facts do not re-derive from data.json`); }
        if (e.promotion?.status === "found") {
          if (!md.includes("These clicks are not part of views.")) { bad++; fail(`agent: E${e.ep} newsletter clicks are not kept separate from views in agent.md`); }
          if (e.promotion.emailClicks != null && e.promotion.emailClicks > 0 && !md.includes(e.promotion.emailClicks.toLocaleString("en-US"))) { bad++; fail(`agent: E${e.ep} tracked email clicks are missing from agent.md`); }
          if (e.promotion.verifiedEmailClicks != null && e.promotion.verifiedEmailClicks > 0 && !md.includes(e.promotion.verifiedEmailClicks.toLocaleString("en-US"))) { bad++; fail(`agent: E${e.ep} verified email clicks are missing from agent.md`); }
        }
        if (d.history?.ready !== e.historyReady || d.history?.reason !== e.historyReason) { bad++; fail(`agent: E${e.ep} history state does not match data.json`); }
        const launch = data.baselines?.launch?.[e.slug];
        if (launch?.word && (d.launch?.word !== launch.word || !!d.launch?.promoDriven !== !!launch.promoDriven)) { bad++; fail(`agent: E${e.ep} launch word in the brief does not re-derive`); }
        if (e.health?.score != null && d.health?.score !== e.health.score) { bad++; fail(`agent: E${e.ep} episode health in the brief does not re-derive`); }
        // absences carry reasons, never empty stand-ins (rule 2)
        for (const k of ["firstWeek", "launch", "pace", "watching", "live", "feedback", "chapters", "health"]) { const v = d[k]; if (v && typeof v === "object" && "value" in v && v.value === null && !v.reason) { bad++; fail(`agent: E${e.ep} ${k} is absent without a reason`); } }
        // links resolve: every link in the section is one data.json carries, a transcript on disk, or the site
        for (const [k, u] of Object.entries(e.links || {})) if (!md.includes(u)) { bad++; fail(`agent: E${e.ep} link ${k} is not in agent.md`); }
        if (e.transcript && !existsSync(join(ROOT, "transcripts", `${e.slug}.txt`))) { bad++; fail(`agent: E${e.ep} transcript link would not resolve`); }
        // chapters: the brief lists exactly what the store holds; each grounds
        if (e.chapters?.list?.length) {
          if ((d.chapters?.list || []).length !== e.chapters.list.length) { bad++; fail(`agent: E${e.ep} chapters in the brief (${(d.chapters?.list || []).length}) differ from the store (${e.chapters.list.length})`); }
          for (const c of e.chapters.list) if (!md.includes(`- ${c.start} — ${c.title}`)) { bad++; fail(`agent: E${e.ep} chapter at ${c.start} is not in agent.md`); }
          if (e.chapters.clock !== "upload" && /&t=\d+s/.test((md.split(`### E${e.ep} —`)[1] || "").split("\n### ")[0])) { bad++; fail(`agent: E${e.ep} carries a YouTube deep link on the live recording's clock`); }
        }
      }
      // chapters store grounds against the transcripts (fail)
      try { const store = existsSync(CH.STORE_PATH) ? JSON.parse(readFileSync(CH.STORE_PATH, "utf8")) : null; if (store) CH.validateStore(store, ROOT); }
      catch (err) { bad++; fail(`agent: chapters store does not re-derive against the transcripts — ${err.message}`); }
      // known breaks reach every affected row (fail)
      for (const b of data.baselines?.knownBreaks || []) { for (const c of data.health?.checks || []) for (const m of c.measures || []) if (b.measures.includes(m.key) && m.value != null && !md.includes(`known reporting break: ${b.note}`)) { bad++; fail(`agent: the known break is not noted on the ${m.key} row`); } }
      // links: every http(s) link in the brief is the site, a data link, or a transcript (fail)
      const known = new Set([...data.episodes.flatMap((e) => [...Object.values(e.links || {}), ...(e.announces || []).map((a) => a.url).filter(Boolean), ...(e.promotion?.newsletters || []).map((newsletter) => newsletter.url).filter(Boolean)])]);
      for (const url of md.match(/https?:\/\/[^\s)\]|"]+/g) || []) {
        const bare = url.replace(/[.,;:]+$/, "").replace(/&t=\d+s$/, "");
        if (bare.startsWith(AB.SITE) || known.has(bare)) continue;
        bad++; fail(`agent: unknown link in agent.md — ${bare}`);
      }
      // words: the served brief stays plain everywhere, including Definitions
      const BANNED_AGENT = /\b(composite|percentile|pillar|ratio|median|velocity|coverage|basis|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
      const hit = md.match(BANNED_AGENT);
      if (hit) { bad++; drift(`agent: banned word "${hit[0]}" appears in agent.md`); }
      // size
      const bytes = Buffer.byteLength(md, "utf8");
      if (bytes > AB.BUDGET.failBytes) { bad++; fail(`agent: agent.md is ${bytes} bytes — over the ${AB.BUDGET.failBytes} budget`); }
      else if (bytes > AB.BUDGET.warnBytes) warn(`agent: agent.md is ${bytes} bytes — over the ${AB.BUDGET.warnBytes} soft budget; older episodes collapse to their row at the next threshold`);
      // pages: the dashboard links out; agent instructions live only on their own route (drift)
      const html = readFileSync(join(ROOT, "index.html"), "utf8");
      const agentsHtml = readFileSync(join(ROOT, "agents.html"), "utf8");
      if (!/<a class="agentslink" href="agents\.html">Agents<\/a>/.test(html)) { bad++; drift("agent: the dashboard header does not link to the separate Agents page"); }
      if (/#agents|id="agents"|function buildAgents|function syncAgentsView|AGENT_PROMPT/.test(html)) { bad++; drift("agent: agent details still live inside the dashboard page"); }
      if (!agentsHtml.includes(`Read ${AB.SITE}/agent.md in full`)) { bad++; drift("agent: the Agents page prompt does not name the live brief address"); }
      if (!/<a class="back" href="\.\/">Dashboard<\/a>/.test(agentsHtml)) { bad++; drift("agent: the Agents page does not link back to the dashboard"); }
      for (const file of ["data.js", "agent.md", "agent.json", "llms.txt", "agent-skill.md", "data.json"]) {
        if (!agentsHtml.includes(file)) { bad++; drift(`agent: the Agents page does not name ${file}`); }
      }
      if (/id="view"|class="tabs"/.test(html)) { bad++; drift("agent: retired page-tab markers reappeared"); }
      if (/data-fold-number/.test(agentsHtml)) { bad++; drift("agent: the Agents page must carry no glance number"); }
      if (!bad) ok(`agent: brief reproduces, ${(data.episodes || []).length} episodes, ${ranked.length} actions, ${(data.episodes || []).filter((e) => e.chapters?.list?.length).length} episode(s) with grounded chapters, ${bytes} bytes, every data.json path covered or left out with a reason`);
    }
  } catch (err) { bad++; fail(`agent: block threw — ${err.message}`); }
}

// --- 1x/1y/1z (PRD v9 W26): small-n on data, no trend words over episode health, stored notes only ---
{
  let bad = 0;
  const BL = await import(join(TOOL, "baselines.mjs"));
  const build = await import(join(TOOL, "build-data.mjs"));
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const TREND_WORDS = /\b(trending|improving|declining|climbing|slipping|best|worst|getting|trajectory)\b/i;
  // 1x: every Slack or alert line with a direction rests on MIN_PEERS or more
  const slackLines = build.trendsLines(data);
  for (const line of slackLines) {
    if (line.direction && !(line.sample >= BL.MIN_PEERS)) { bad++; fail(`small-n: Slack line carries a direction on ${line.sample} samples — ${line.text.slice(0, 80)}`); }
    if (line.kind !== "insight" && line.direction == null && /\btrending (up|down)\b/i.test(line.text)) { bad++; fail(`small-n: Slack line says trending without a stamped direction — ${line.text.slice(0, 80)}`); }
  }
  const newest = data.episodes.at(-1);
  const promotionLines = slackLines.filter((line) => line.kind === "newsletter-promotion");
  if (newest?.promotion?.status === "found") {
    if (promotionLines.length !== 1) { bad++; fail("newsletter promotion: Slack does not carry exactly one newest-episode line"); }
    else {
      const text = promotionLines[0].text;
      if (!text.includes(newest.promotion.source || "UX Tools") || !text.includes("not part of views")) { bad++; fail("newsletter promotion: Slack drops the stored source or mixes clicks into views"); }
      if (newest.promotion.emailClicks == null && !/click count is not available/.test(text)) { bad++; fail("newsletter promotion: Slack hides a missing tracked-click count"); }
      if (newest.promotion.emailClicks === 0 && !/no tracked email clicks yet/.test(text)) { bad++; fail("newsletter promotion: Slack renders a source zero instead of plain absence wording"); }
      if (newest.promotion.emailClicks > 0 && !text.includes(newest.promotion.emailClicks.toLocaleString("en-US"))) { bad++; fail("newsletter promotion: Slack tracked-click count differs from data.json"); }
      if (newest.promotion.verifiedEmailClicks == null && !/verified click count is not available/.test(text)) { bad++; fail("newsletter promotion: Slack hides a missing verified-click count"); }
      if (newest.promotion.verifiedEmailClicks === 0 && !/no clicks verified by Beehiiv yet/.test(text)) { bad++; fail("newsletter promotion: Slack renders a verified zero instead of plain absence wording"); }
      if (newest.promotion.verifiedEmailClicks > 0 && !text.includes(newest.promotion.verifiedEmailClicks.toLocaleString("en-US"))) { bad++; fail("newsletter promotion: Slack verified-click count differs from data.json"); }
    }
  } else if (promotionLines.length) {
    bad++; fail("newsletter promotion: Slack claims a newest-episode promotion that data.json does not carry");
  }
  if (build.trendsText(data) !== ["", "Trends", ...slackLines.map((l) => l.text)].join("\n")) { bad++; fail("small-n: trendsText does not join trendsLines — two definitions of the Slack block"); }
  try {
    const alerts = await import(join(TOOL, "alerts.mjs"));
    let prev = null;
    try { prev = JSON.parse(readFileSync(join(ROOT, "data", "restream", "alerts-state.json"), "utf8")); } catch { /* first run */ }
    if (prev) {
      for (const line of alerts.alertLines(prev, alerts.snapshotState(data), data)) {
        if (line.direction && !(line.sample >= BL.MIN_PEERS)) { bad++; fail(`small-n: alert carries a direction on ${line.sample} samples — ${line.text.slice(0, 80)}`); }
      }
    }
    // W27: a served check-set or scoring-rule change must produce an alert
    // line naming the change — proven behaviorally with a synthetic previous
    // state, so the wiring cannot rot while the real state happens to agree
    const healthMod = await import(join(TOOL, "health.mjs"));
    const curState = alerts.snapshotState(data);
    if (curState.healthCheckSet?.length) {
      const dropped = curState.healthCheckSet[0];
      const synthetic = { ...curState, healthDate: "1970-01-01", healthCheckSet: curState.healthCheckSet.slice(1) };
      const lines = alerts.alertLines(synthetic, curState, data);
      const name = healthMod.CHECK_LABELS[dropped] ?? dropped;
      if (!lines.some((l) => /different set of checks/.test(l.text) && l.text.includes(name))) {
        bad++; fail(`alerts: a check-set change does not queue a plain line naming the check (${name})`);
      }
      const syntheticFormula = { ...curState, healthFormula: "health-v0" };
      if (!alerts.alertLines(syntheticFormula, curState, data).some((l) => /scoring rules changed/.test(l.text))) {
        bad++; fail("alerts: a scoring-rule change does not queue a plain line");
      }
      // an empty saved set means the read was withheld — recovery must NOT
      // read as every check joining (review finding, 2026-08-24)
      const syntheticWithheld = { ...curState, healthDate: "1970-01-01", healthCheckSet: [] };
      if (alerts.alertLines(syntheticWithheld, curState, data).some((l) => /different set of checks/.test(l.text))) {
        bad++; fail("alerts: recovery from a withheld read wrongly queues a check-set change line");
      }
      // the transition copy is reader-facing but dynamic, so the 1i scan
      // never sees it — scan the generated lines here with the same ban
      const READER_BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b|\d+(?:\.\d+)?×|\b\d+(?:\.\d+)?\s+times?\s+(?:better|worse|higher|lower|more|less)\b/i;
      for (const l of [...lines, ...alerts.alertLines(syntheticFormula, curState, data)].filter((x) => /set of checks|scoring rules/.test(x.text))) {
        if (READER_BANNED.test(l.text)) { bad++; fail(`plain words: transition alert copy contains banned jargon — ${l.text.slice(0, 100)}`); }
      }
    }
    // W27: the same change must reach the Slack digest the day it is served —
    // exactly one line, naming every check that joined or left; and never a
    // ghost line when the set held
    const servedChange = data.health?.checkSetChange;
    const changeLines = slackLines.filter((l) => l.kind === "health-checkset");
    if (servedChange && ((servedChange.left?.length ?? 0) + (servedChange.joined?.length ?? 0) > 0)) {
      const names = [...(servedChange.left ?? []), ...(servedChange.joined ?? [])].map((k) => healthMod.CHECK_LABELS[k] ?? k);
      if (changeLines.length !== 1 || !names.every((n) => changeLines[0].text.includes(n))) {
        bad++; fail(`small-n: Slack must carry one line naming the changed health checks (${names.join(", ")})`);
      }
      if (/\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b/i.test(changeLines[0]?.text ?? "")) {
        bad++; fail("plain words: the Slack check-set line contains banned jargon");
      }
    } else if (changeLines.length) {
      bad++; fail("small-n: Slack carries a health check-set line although the served set did not change");
    }
    // W27: the page renders the stored change and the saved judgment
    // sentences — the projection carries them (locked by the projection
    // byte-compare in 1h); this proves the page actually reads them
    if (!/h\.checkSetChange/.test(html) || !/class="setchange"/.test(html) || !/rests on different checks/.test(html)) {
      bad++; drift("dashboard: the diagnosis card must render the saved check-set change in plain words");
    }
    if (!/h\.drivers/.test(html) || !/class="drivers"/.test(html)) {
      bad++; drift("dashboard: the evidence card must render the saved judgment sentences (drivers)");
    }
  } catch (err) { bad++; drift(`small-n: alerts.mjs failed to load — ${err.message}`); }
  // 1y: the episode-health sequence is never read as a trend
  for (const line of slackLines.filter((l) => l.kind === "episode-health")) {
    if (TREND_WORDS.test(line.text)) { bad++; fail(`episode health: Slack sequence uses a trend word — ${line.text.slice(0, 80)}`); }
  }
  const aboutHealth = html.match(/<p><b>Episode health<\/b>[\s\S]*?<\/p>/)?.[0] || "";
  if (!aboutHealth || TREND_WORDS.test(aboutHealth.replace(/<[^>]+>/g, ""))) { bad++; drift("episode health: About paragraph missing or uses a trend word over the sequence"); }
  if (!/measured against different earlier episodes/.test(aboutHealth)) { bad++; drift("episode health: About must say two scores were measured against different earlier episodes"); }
  for (const fn of ["healthChip", "healthTipHTML", "healthCell"]) {
    const src = html.match(new RegExp(`(?:function ${fn}\\(|const ${fn} = )[\\s\\S]*?\\n(?:\\}|      html \\+=)`))?.[0] || "";
    if (TREND_WORDS.test(src)) { bad++; fail(`episode health: ${fn} carries a trend word`); }
  }
  // 1z: notes are the fixed strings from baselines.mjs; reasons and notes pass the plain-words ban
  const BANNED = /\b(composite|percentile|pillar|ratio|velocity|coverage|basis|median|delta|cumulative)\b/i;
  const allowedNotes = new Set([BL.NOTES.sameAge, BL.NOTES.mature]);
  let healthStore = null;
  try { healthStore = JSON.parse(readFileSync(join(ROOT, "data", "restream", "health-history.json"), "utf8")); } catch { /* absent */ }
  const newestEntry = healthStore?.entries?.at(-1);
  if (newestEntry) {
    for (const [key, part] of Object.entries(newestEntry.subScores || {})) {
      if (part.reason && BANNED.test(part.reason)) { bad++; fail(`notes: health ${key} reason uses banned words — ${part.reason}`); }
      for (const [mk, m] of Object.entries(part.measures || {})) {
        if (m.note != null && !allowedNotes.has(m.note)) { bad++; fail(`notes: health ${key}.${mk} note is not one of the fixed strings`); }
        if (m.reason && BANNED.test(m.reason)) { bad++; fail(`notes: health ${key}.${mk} reason uses banned words — ${m.reason}`); }
      }
    }
  }
  let ratings = null;
  try { ratings = JSON.parse(readFileSync(join(ROOT, "data", "restream", "episode-ratings.json"), "utf8")); } catch { /* absent */ }
  for (const r of ratings?.scores || []) {
    if (r.reason && BANNED.test(r.reason)) { bad++; fail(`notes: episode health ${r.slug} reason uses banned words`); }
    for (const [c, cs] of Object.entries(r.checks || {})) {
      if (cs.note != null && !allowedNotes.has(cs.note)) { bad++; fail(`notes: episode health ${r.slug} ${c} note is not one of the fixed strings`); }
      if (cs.reason && BANNED.test(cs.reason)) { bad++; fail(`notes: episode health ${r.slug} ${c} reason uses banned words`); }
    }
  }
  // the drill-in tooltip is the structured measure-block layout (owner
  // directive 2026-08-23): the builder must carry each measure's stored note
  // into the block payload, and the renderer must draw it as its own line
  if (!/note: m\.note \|\| null/.test(html)
    || !/\[m\.note, m\.q, m\.cn, m\.sw\]\.filter\(Boolean\)\.map\(\(t\) => `<div class="mnote">\$\{esc\(t\)\}<\/div>`\)/.test(html)
    || !/const rowTip = c\.note \? `\$\{tip\} — \$\{c\.note\}` : tip;/.test(html)) {
    bad++; drift("notes: the page must render each measure's stored note in the health drill-in and the panel tile");
  }
  if (!bad) ok(`honesty on data: ${slackLines.length} Slack lines and the alert lines carry directions only on ${BL.MIN_PEERS}+ samples; episode-health surfaces carry no trend word; every stored note is one of the fixed strings`);
}

// --- warnings: broadcast-resolution latches and plays coverage ---
{
  for (const show of registry.shows) {
    if (show.active === false) continue;
    for (const t of show.targets || []) {
      if (t.kind !== "x") continue;
      if (t.broadcastResolved && !t.broadcastId && t.playsStatus !== "none")
        warn(`latch: ${show.slug} ${t.account}/${t.postId} marked broadcastResolved with NO broadcastId and not latched "none" — will never be retried (plays lost unless latch cleared)`);
    }
  }
  for (const e of eps) {
    const latest = e.snapshots[e.snapshots.length - 1];
    const show = registry.shows.find((s) => s.slug === e.slug);
    for (const t of show?.targets || []) {
      if (t.kind === "x" && t.broadcastId) {
        const key = `x:${t.account}`;
        if (latest.byDest[key]?.plays == null)
          warn(`plays gap: ${e.slug} ${key} has a resolved broadcastId but no plays in latest snapshot (status=${t.playsStatus ?? "unset"}) — ${t.playsStatus === "stale-high-water" ? "reporting persisted high water" : "pull failing or broadcast newly expired"}`);
      }
    }
  }
  // snapshot cadence gaps over the last 7 days
  const weekAgo = Date.now() - 7 * DAY;
  for (const e of eps) {
    if (!e.active) continue;
    const recent = e.snapshots.map((s) => Date.parse(s.ts)).filter((t) => t >= weekAgo);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] - recent[i - 1] > FRESH_MS)
        warn(`cadence: ${e.slug} gap of ${((recent[i] - recent[i - 1]) / 3600000).toFixed(1)}h between snapshots ending ${new Date(recent[i]).toISOString()}`);
    }
  }
}

console.log(`\n${failures} failure(s), ${warnings} warning(s), ${drifts} drift(s)${publishMode ? " — publish mode: drift is reported, not blocking" : ""}.`);
if (publishMode && drifts) console.log(`DRIFT-SUMMARY ${drifts} contract drift(s) — fix at code time; the pre-push hook refuses them`);
process.exit(failures ? 1 : 0);
