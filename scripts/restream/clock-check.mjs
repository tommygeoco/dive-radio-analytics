#!/usr/bin/env node
// clock-check.mjs — measure whether each episode's transcript runs on its
// YouTube uploads' clocks, so a timestamp can link to the exact second.
//
// For every aired episode with a transcript, and every registered YouTube
// upload of it, the upload's English auto-captions (json3, word-level times)
// are matched against the transcript with clock.mjs: six-word phrases that
// occur exactly once in both pin the same moment on both clocks; the median
// difference is the offset, the 10th–90th percentile spread says whether it
// holds for the whole episode. A check is redone only when the transcript
// changes (its sha256) or the previous check did not finish. Captions come
// from yt-dlp, or from a folder of already-downloaded `<videoId>.en.json3`
// files (--captions). Nothing else touches the network.
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
export const METHOD = `${CLOCK_PHRASE_WORDS}-word phrases that occur once in both the transcript and the upload's English auto-captions; offset = median(caption time − transcript time); spread = 90th − 10th percentile`;

function downloadCaptions(videoId, { ytdlpBin = YTDLP_BIN } = {}) {
  const work = mkdtempSync(join(tmpdir(), "dive-radio-clock-"));
  try {
    execFileSync(ytdlpBin, [
      "--no-playlist", "--no-warnings", "--no-progress", "--skip-download",
      "--write-auto-subs", "--sub-langs", "en", "--sub-format", "json3",
      "--retries", "1", "--socket-timeout", "20",
      "--output", join(work, "%(id)s.%(ext)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` } });
    const file = readdirSync(work).find((name) => name.startsWith(`${videoId}.`) && name.endsWith(".json3"));
    if (!file) throw new Error("YouTube has not published English auto-captions yet");
    return JSON.parse(readFileSync(join(work, file), "utf8"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function checkUpload({ transcript, captions }) {
  const words = captionWords(captions);
  if (!words.length) return { state: "pending", anchors: 0, offsetSec: null, spreadSec: null, reason: "The upload's captions are empty." };
  const found = clockOffset(transcript.segments, words);
  if (!found) return { state: "failed", anchors: 0, offsetSec: null, spreadSec: null, reason: "No phrase occurs once in both the transcript and the captions." };
  return { state: "ready", ...found, reason: null };
}

export async function runClockCheck({ root = ROOT, now = Date.now(), captionsDir = null, dryRun = false, download = downloadCaptions, logger = console } = {}) {
  const registry = JSON.parse(readFileSync(join(root, "data", "restream", "postlive-registry.json"), "utf8"));
  const today = new Date(new Date(now).getTime() - 7 * 3600000).toISOString().slice(0, 10);
  const path = join(root, "data", "restream", "clock-checks.json");
  return withSourceLock(path, async () => {
    const store = readJsonFile(path, { fallback: { schemaVersion: 1, method: METHOD, updatedAt: null, entries: {} } });
    let changed = false;
    const checkedAt = new Date(now).toISOString();
    for (const { slug } of airedEpisodes(registry, today)) {
      const file = join(root, "transcripts", `${slug}.txt`);
      if (!existsSync(file)) continue;
      const transcript = parseTranscript(readFileSync(file, "utf8"));
      const show = registry.shows.find((s) => s.slug === slug);
      for (const target of (show.targets || []).filter((t) => t.kind === "youtube" && t.videoId && t.account)) {
        const key = `yt:${target.account}`;
        const prior = store.entries[slug]?.uploads?.[key];
        if (prior?.state === "ready" && prior.transcriptSha256 === transcript.sha256 && prior.videoId === target.videoId) continue;
        let result;
        try {
          const local = captionsDir ? join(captionsDir, `${target.videoId}.en.json3`) : null;
          if (captionsDir && !existsSync(local)) { logger.log(`clock-check: ${slug} ${key} — no local captions, left as it was`); continue; }
          const captions = local ? JSON.parse(readFileSync(local, "utf8")) : download(target.videoId);
          result = checkUpload({ transcript, captions });
        } catch (error) {
          result = { state: "pending", anchors: 0, offsetSec: null, spreadSec: null, reason: String(error?.message || error).replace(/\s+/g, " ").slice(0, 200) };
        }
        store.entries[slug] ||= { uploads: {} };
        store.entries[slug].uploads[key] = { videoId: target.videoId, transcriptSha256: transcript.sha256, checkedAt, ...result };
        changed = true;
        logger.log(`clock-check: ${slug} ${key} ${result.state}${result.state === "ready" ? ` — offset ${result.offsetSec}s, spread ${result.spreadSec}s, ${result.anchors} phrases` : ` — ${result.reason}`}`);
      }
    }
    if (changed) {
      store.method = METHOD;
      store.updatedAt = checkedAt;
      store.entries = Object.fromEntries(Object.entries(store.entries).sort(([a], [b]) => a.localeCompare(b)).map(([slug, entry]) => [slug, { uploads: Object.fromEntries(Object.entries(entry.uploads).sort(([a], [b]) => a.localeCompare(b))) }]));
      if (!dryRun) atomicWriteJson(path, store);
    }
    return store;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--captions");
  runClockCheck({ captionsDir: at >= 0 ? resolve(args[at + 1]) : null, dryRun: args.includes("--dry-run") })
    .catch((error) => { process.stderr.write(`clock-check: ${error.message}\n`); process.exit(1); });
}
