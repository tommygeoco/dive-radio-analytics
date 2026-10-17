#!/usr/bin/env node
// clock-check.mjs — measure whether each episode's transcript runs on its
// YouTube uploads' clocks, so a timestamp can link to the exact second.
//
// For every aired episode with a transcript, and every registered YouTube
// upload of it, the upload's English auto-captions (json3, word-level times;
// "en-orig", else "en") are matched against the transcript with clock.mjs:
// six-word phrases that occur exactly once in both pin the same moment on
// both clocks; the median difference is the offset, the 10th–90th percentile
// spread says whether it holds for the whole episode. A check is redone only
// when the transcript changes (its sha256), the upload changes, or the
// previous check is still `pending`; a `failed` check (captions with no
// phrase in common, as when YouTube's captions are in the wrong language)
// waits for a new transcript. Captions come from yt-dlp, or from a folder of
// already-downloaded `<videoId>.<en-orig|en>.json3` files (--captions).
// Nothing else touches the network.
//
// A daily chain step (2026-10-16): downloads are spaced (PAUSE_MS), and the
// first refusal from YouTube (HTTP 429, "confirm you're not a bot") ends this
// run's downloads, leaving the rest as they were for the next morning. A
// failed download is never a failed step: it is `pending` with yt-dlp's own
// error line as its reason, and a check that ends the same way again keeps
// its record, so `checkedAt` is when that outcome was first seen.
//
// Store: data/restream/clock-checks.json — { schemaVersion, method, updatedAt,
// entries: { <slug>: { uploads: { <yt:account>: { videoId, transcriptSha256,
// checkedAt, state, anchors, offsetSec, spreadSec, reason } } } } }.
// A missing caption track is `pending` with its reason — never an offset of 0.
//
// Usage:
//   node scripts/restream/clock-check.mjs [--captions <dir>] [--dry-run]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile, withSourceLock } from "../../tools/dive-analytics/source-io.mjs";
import { parseTranscript } from "../../tools/dive-analytics/transcripts.mjs";
import { captionWords, clockOffset, CLOCK_PHRASE_WORDS } from "../../tools/dive-analytics/clock.mjs";
import { airedEpisodes } from "./contributors-import.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const YTDLP_BIN = process.env.YTDLP_BIN || "/opt/homebrew/bin/yt-dlp";
export const PAUSE_MS = 5000;
// YouTube turning this host away for now: every later download this run would be turned away too
export const REFUSED = /HTTP Error 429|Too Many Requests|confirm you(?:['’]| a)re not a bot|Sign in to confirm/i;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const METHOD = `${CLOCK_PHRASE_WORDS}-word phrases that occur once in both the transcript and the upload's English auto-captions; offset = median(caption time − transcript time); spread = 90th − 10th percentile`;

// The upload's own English speech recognition ("en-orig") first: "en" can be YouTube's machine translation of
// another track, and those downloads are the ones YouTube rate-limits (HTTP 429). "en" only when no "en-orig" exists.
export const CAPTION_LANGS = Object.freeze(["en-orig", "en"]);
function downloadCaptions(videoId, { ytdlpBin = YTDLP_BIN } = {}) {
  const work = mkdtempSync(join(tmpdir(), "dive-radio-clock-"));
  try {
    for (const lang of CAPTION_LANGS) {
      execFileSync(ytdlpBin, [
        "--no-playlist", "--no-warnings", "--no-progress", "--skip-download",
        "--write-auto-subs", "--sub-langs", lang, "--sub-format", "json3",
        "--retries", "1", "--socket-timeout", "20",
        "--output", join(work, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` } });
      const file = readdirSync(work).find((name) => name === `${videoId}.${lang}.json3`);
      if (file) return JSON.parse(readFileSync(join(work, file), "utf8"));
    }
    throw new Error("YouTube has not published English auto-captions yet");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// why a download failed, in yt-dlp's own words (its last "ERROR:" line), never the command it ran
export function downloadReason(error) {
  const said = `${error?.stderr || ""}`.split("\n").map((line) => line.trim()).filter((line) => /^ERROR:/.test(line)).pop();
  const text = said ? said.replace(/^ERROR:\s*(?:\[[^\]]+\]\s*)?(?:[\w-]{11}:\s*)?/, "") : String(error?.message || error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function checkUpload({ transcript, captions }) {
  const words = captionWords(captions);
  if (!words.length) return { state: "pending", anchors: 0, offsetSec: null, spreadSec: null, reason: "The upload's captions are empty." };
  const found = clockOffset(transcript.segments, words);
  if (!found) return { state: "failed", anchors: 0, offsetSec: null, spreadSec: null, reason: "No phrase occurs once in both the transcript and the captions." };
  return { state: "ready", ...found, reason: null };
}

export async function runClockCheck({ root = ROOT, now = Date.now(), captionsDir = null, dryRun = false, download = downloadCaptions, pauseMs = PAUSE_MS, logger = console } = {}) {
  const registry = JSON.parse(readFileSync(join(root, "data", "restream", "postlive-registry.json"), "utf8"));
  const today = new Date(new Date(now).getTime() - 7 * 3600000).toISOString().slice(0, 10);
  const path = join(root, "data", "restream", "clock-checks.json");
  return withSourceLock(path, async () => {
    const store = readJsonFile(path, { fallback: { schemaVersion: 1, method: METHOD, updatedAt: null, entries: {} } });
    let changed = false;
    let downloads = 0;
    let refused = null;
    const checkedAt = new Date(now).toISOString();
    for (const { slug } of airedEpisodes(registry, today)) {
      const file = join(root, "transcripts", `${slug}.txt`);
      if (!existsSync(file)) continue;
      const transcript = parseTranscript(readFileSync(file, "utf8"));
      const show = registry.shows.find((s) => s.slug === slug);
      for (const target of (show.targets || []).filter((t) => t.kind === "youtube" && t.videoId && t.account)) {
        const key = `yt:${target.account}`;
        const prior = store.entries[slug]?.uploads?.[key];
        const same = prior?.transcriptSha256 === transcript.sha256 && prior?.videoId === target.videoId;
        if (same && (prior.state === "ready" || prior.state === "failed")) continue;
        let result;
        try {
          const local = captionsDir ? CAPTION_LANGS.map((lang) => join(captionsDir, `${target.videoId}.${lang}.json3`)).find((f) => existsSync(f)) ?? null : null;
          if (captionsDir && !local) { logger.log(`clock-check: ${slug} ${key} — no local captions, left as it was`); continue; }
          if (!local && refused) { logger.log(`clock-check: ${slug} ${key} — left for the next run (${refused})`); continue; }
          if (!local && downloads++ && pauseMs > 0) await sleep(pauseMs);
          const captions = local ? JSON.parse(readFileSync(local, "utf8")) : download(target.videoId);
          result = checkUpload({ transcript, captions });
        } catch (error) {
          result = { state: "pending", anchors: 0, offsetSec: null, spreadSec: null, reason: downloadReason(error) };
          if (REFUSED.test(result.reason)) refused = result.reason;
        }
        logger.log(`clock-check: ${slug} ${key} ${result.state}${result.state === "ready" ? ` — offset ${result.offsetSec}s, spread ${result.spreadSec}s, ${result.anchors} phrases` : ` — ${result.reason}`}`);
        // the same outcome again keeps its record: checkedAt is when it was first seen
        if (same && prior.state === result.state && prior.reason === result.reason) continue;
        store.entries[slug] ||= { uploads: {} };
        store.entries[slug].uploads[key] = { videoId: target.videoId, transcriptSha256: transcript.sha256, checkedAt, ...result };
        changed = true;
      }
    }
    if (changed) {
      store.method = METHOD;
      store.updatedAt = checkedAt;
      store.entries = Object.fromEntries(Object.entries(store.entries).sort(([a], [b]) => a.localeCompare(b)).map(([slug, entry]) => [slug, { uploads: Object.fromEntries(Object.entries(entry.uploads).sort(([a], [b]) => a.localeCompare(b))) }]));
      if (!dryRun) atomicWriteJson(path, store);
    }
    if (refused) logger.log(`clock-check: YouTube refused caption downloads this run (${refused}); the rest wait for the next run`);
    return store;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--captions");
  runClockCheck({ captionsDir: at >= 0 ? resolve(args[at + 1]) : null, dryRun: args.includes("--dry-run") })
    .catch((error) => { process.stderr.write(`clock-check: ${error.message}\n`); process.exit(1); });
}
