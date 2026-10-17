#!/usr/bin/env node
// transcripts-pull.mjs — import a timestamped Restream speaker transcript
// from the owner vault when one exists, otherwise try YouTube auto-captions
// once a Dive Radio episode reaches its second Phoenix calendar day.
//
// Deterministic outside the yt-dlp fetch: no model calls and no runtime
// dependencies. Existing transcript files are never opened for writing, so a
// manually supplied canonical transcript always wins — with one declared
// exception (2026-10-16): a copy saved from YouTube auto-captions is replaced,
// once, by the episode's Restream speaker export when that export reaches the
// vault later. The episode's chapters are superseded first and the ledger
// names the copy it replaced. A vault speaker
// transcript is selected only by exact episode number plus registry air date;
// a file under that name with no timed speaker lines (a Whisper copy) is
// skipped with a warning; conflicting speaker copies stop the step instead of
// guessing. Caption delays are expected: a due episode with no source stays
// absent and is tried again on the next daily run.
//
// Captions are each upload's own English speech recognition ("en-orig"), and
// YouTube's "en" track only when an upload has none (2026-10-16). YouTube
// turning a download away (HTTP 429, its sign-in or bot check) is a delay too:
// the episode stays pending, its reason names the refusal, and the next run
// asks again. Only a download that fails for any other reason, a missing
// yt-dlp or unreadable captions stop the step
// (audit/AUDIT-2026-10-16-caption-refusals.md).
//
// Operator wiring (do not edit cron here): run after postlive-discover.mjs and
// before snapshot/build-data so the newly created file reaches data.json.
//
// Usage:
//   node scripts/restream/transcripts-pull.mjs
//   node scripts/restream/transcripts-pull.mjs --dry-run

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, atomicWriteText, readJsonFile, withSourceLock, readingEnvelope } from "../../tools/dive-analytics/source-io.mjs";
import { readVerifiedSource, SOURCE_CACHE_DIR } from "../../tools/dive-analytics/verified-source-read.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY_PATH = join(ROOT, "data", "restream", "postlive-registry.json");
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
export const DEFAULT_VAULT = join(homedir(), "Documents", "Obsidian", "Hinterlands", "Dive Media Group", "Dive Radio");
const YTDLP_BIN = process.env.YTDLP_BIN || "/opt/homebrew/bin/yt-dlp";
const DAY = 86400000;

export function phoenixDateKey(value = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const take = (type) => parts.find((part) => part.type === type)?.value;
  return `${take("year")}-${take("month")}-${take("day")}`;
}

function dayNumber(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY;
}

export function phoenixCalendarAgeDays(dateKey, now = Date.now()) {
  return dayNumber(phoenixDateKey(now)) - dayNumber(dateKey);
}

export function isTranscriptDue(dateKey, now = Date.now()) {
  // The air date is day one; the next Phoenix calendar date is day two.
  return phoenixCalendarAgeDays(dateKey, now) >= 1;
}

function isDiveRadio(show) {
  return /dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug || "");
}

export function orderedEpisodes(registry) {
  return (registry.shows || [])
    .filter((show) => show.active !== false && isDiveRadio(show))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cueTimestamp(value) {
  const parts = value.replace(",", ".").split(":");
  const seconds = Number.parseFloat(parts.pop());
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  if (![seconds, minutes, hours].every(Number.isFinite)) throw new Error(`invalid VTT timestamp ${JSON.stringify(value)}`);
  const wholeSeconds = Math.floor(seconds);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
}

export function vttToTranscript(vtt) {
  const blocks = String(vtt).replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  const cues = [];
  let priorWords = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const start = lines[timingIndex].split("-->")[0].trim();
    const text = decodeEntities(lines.slice(timingIndex + 1).join(" ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()).replace(/\s+([,.!?;:])/g, "$1");
    if (!text) continue;
    const words = text.split(/\s+/);
    const comparable = (word) => word.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
    let overlap = 0;
    const limit = Math.min(priorWords.length, words.length);
    for (let size = limit; size >= 2; size--) {
      const priorTail = priorWords.slice(-size).map(comparable).join("\u0000");
      const nextHead = words.slice(0, size).map(comparable).join("\u0000");
      if (priorTail && priorTail === nextHead) { overlap = size; break; }
    }
    if (words.length === priorWords.length && words.every((word, index) => comparable(word) === comparable(priorWords[index]))) {
      priorWords = words;
      continue;
    }
    const freshText = words.slice(overlap).join(" ");
    if (freshText) cues.push(`${cueTimestamp(start)}  ${freshText}`);
    priorWords = words;
  }
  if (!cues.length) throw new Error("caption file contains no readable timestamped cues");
  return cues.join("\n");
}

export function shortTitle(title) {
  return String(title || "Untitled episode").replace(/^Dive Radio:\s*/i, "").trim();
}

export function episodeHeader(show, ep) {
  return `Dive Radio E${ep} — ${shortTitle(show.title)}`;
}

export function transcriptHeader(show, ep, youtubeTarget, pulledDate) {
  const url = `https://youtube.com/watch?v=${youtubeTarget.videoId}`;
  return [
    episodeHeader(show, ep),
    `Aired: ${show.date} · YouTube: ${url}`,
    `Source: YouTube auto-captions (pulled ${pulledDate}). No speaker labels; auto-transcription — verify quotes against video.`,
    "",
  ].join("\n");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSpeakerBody(raw) {
  const text = String(raw).replace(/^\uFEFF/, "");
  const match = /^\d{2}:\d{2}:\d{2} \[Speaker [^\]\r\n]+\]\r?$/m.exec(text);
  if (!match) return null;
  return text.slice(match.index).replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function speakerBody(raw) {
  const body = findSpeakerBody(raw);
  if (body == null) throw new Error("vault transcript has no timed speaker body");
  return body;
}

export function hasSpeakerBody(raw) {
  return findSpeakerBody(raw) != null;
}

// A vault file can carry an episode's transcript name without being a Restream
// speaker export: the transcript mirror's copy of a captions transcript (E1's
// and E5's, before the mirror began naming those e<n>-autocaptions-<date>.txt
// on 2026-10-16), or a Whisper copy saved under the reserved name (E14's,
// before the episode-notes job began saving them as
// e<n>-whisper-transcript-<date>.txt the same day).
// Such a file is not a source. It is skipped (onSkip names it) and the
// remaining files are read as usual.
export function vaultTranscriptCandidates(show, ep, vaultDir = process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT, { onSkip = () => {} } = {}) {
  if (!existsSync(vaultDir)) return [];
  const pattern = new RegExp(`^e${ep}-transcript-${regexEscape(show.date)}(?:-[^.]+)?\\.txt$`);
  const candidates = [];
  for (const file of readdirSync(vaultDir).filter((name) => pattern.test(name)).sort()) {
    const path = join(vaultDir, file);
    const body = findSpeakerBody(readVerifiedSource(path, { cacheDir: resolve(vaultDir) === resolve(DEFAULT_VAULT) ? SOURCE_CACHE_DIR : null }));
    if (body == null) { onSkip(file); continue; }
    candidates.push({ file, path, body });
  }
  return candidates;
}

export function planVaultTranscript(show, ep, vaultDir = process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT, { onSkip } = {}) {
  const candidates = vaultTranscriptCandidates(show, ep, vaultDir, { onSkip });
  if (!candidates.length) return null;
  const hashes = new Set(candidates.map((candidate) => createHash("sha256").update(candidate.body).digest("hex")));
  if (hashes.size > 1) {
    throw new Error(`E${ep} has conflicting vault transcripts for ${show.date}: ${candidates.map((candidate) => candidate.file).join(", ")}`);
  }
  return candidates[0];
}

export function restreamTranscriptHeader(show, ep, youtubeTarget, vaultFile) {
  if (!youtubeTarget?.videoId) throw new Error(`E${ep} has no registered YouTube upload for its transcript header`);
  const url = `https://youtube.com/watch?v=${youtubeTarget.videoId}`;
  return [
    episodeHeader(show, ep),
    `Aired: ${show.date} · YouTube: ${url}`,
    `Source: Restream speaker transcript (vault ${vaultFile}). Speaker labels are automatic — verify quotes against video.`,
    "",
  ].join("\n") + "\n";
}

export function writeTranscriptOnce(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return false;
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
  try {
    linkSync(tempPath, path);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The one transcript that may be replaced: a copy of YouTube auto-captions
// (header line three, as transcriptHeader writes it) with no timed speaker lines.
export function isCaptionsTranscript(raw) {
  const text = String(raw).replace(/^﻿/, "").replace(/\r/g, "");
  return /^Source: YouTube auto-captions\b/.test(text.split("\n")[2] || "") && findSpeakerBody(text) == null;
}

// Replace the captions copy only if it is still the bytes that were read.
export function replaceCaptionsTranscript(path, content, expectedSha256) {
  if (!existsSync(path) || sha256Of(readFileSync(path)) !== expectedSha256) return false;
  atomicWriteText(path, content);
  return true;
}

// A replaced transcript takes its chapters with it, before the transcript
// changes: the entry moves unchanged under superseded[] with the reason
// chapters.mjs gives a changed transcript, so the store never holds chapters
// for a transcript that is not on disk, and the chapters step writes a fresh
// list. The chapters clock (updatedAt) stays the time of the last model write.
export function supersedeChapters(chaptersPath, slug, sha256, now = Date.now()) {
  if (!existsSync(chaptersPath)) return false;
  return withSourceLock(chaptersPath, () => {
    const store = readJsonFile(chaptersPath);
    const entry = store.entries?.[slug];
    if (!entry || entry.sha256 === sha256) return false;
    store.superseded = [...(store.superseded || []), { slug, supersededOn: new Date(now).toISOString().slice(0, 10), why: "transcript changed", entry }];
    delete store.entries[slug];
    atomicWriteText(chaptersPath, JSON.stringify(store, null, 2) + "\n");
    return true;
  });
}

// The upload's own English speech recognition ("en-orig") first, as clock-check.mjs asks: "en" can be YouTube's
// machine translation of another track, and those are the downloads YouTube refused with HTTP 429 on 2026-10-16.
// "en" only when no "en-orig" file appears. transcripts-pull.test.mjs holds this list equal to clock-check's.
export const CAPTION_LANGS = Object.freeze(["en-orig", "en"]);
// YouTube turning this machine away for now — clock-check.mjs's test, held equal to it by transcripts-pull.test.mjs
export const REFUSED = /HTTP Error 429|Too Many Requests|confirm you(?:['’]| a)re not a bot|Sign in to confirm/i;

// One request per track, in CAPTION_LANGS order. A request that fails (a refusal included) ends the
// download, so "en" is never asked for after YouTube turned "en-orig" away.
function downloadEnglishVtt(target, { ytdlpBin = YTDLP_BIN } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "dive-radio-transcript-"));
  try {
    for (const lang of CAPTION_LANGS) {
      execFileSync(ytdlpBin, [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs", lang,
        "--sub-format", "vtt",
        "--retries", "1",
        "--fragment-retries", "1",
        "--socket-timeout", "20",
        "--output", join(workDir, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${target.videoId}`,
      ], {
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}` },
      });
      const files = readdirSync(workDir).filter((name) => name.startsWith(`${target.videoId}.`) && name.endsWith(".vtt")).sort();
      if (files.length) return readFileSync(join(workDir, files[0]), "utf8");
    }
    throw new Error("YouTube has not published English auto-captions yet");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Why a refused episode waits, in plain words: the page's episode note and the morning alert show it.
// yt-dlp's own line goes to the run log.
export function refusalReason(said) {
  return /HTTP Error 429|Too Many Requests/i.test(said)
    ? "YouTube refused the caption download for now (too many requests); it is tried again on the next run."
    : "YouTube refused the caption download until this machine signs in; it is tried again on the next run.";
}

function errorLine(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : "";
  return (stderr || error?.message || String(error)).replace(/\s+/g, " ").slice(0, 240);
}

export function planTranscriptPulls(registry, { now = Date.now(), transcriptsDir = TRANSCRIPTS_DIR } = {}) {
  return orderedEpisodes(registry).map((show, index) => {
    const path = join(transcriptsDir, `${show.slug}.txt`);
    const seenVideoIds = new Set();
    const accountOrder = new Map([["joindiveclub", 0], ["designertom", 1]]);
    const youtubeTargets = (show.targets || [])
      .filter((target) => target.kind === "youtube" && target.videoId)
      .sort((a, b) => (accountOrder.get(a.account) ?? 9) - (accountOrder.get(b.account) ?? 9))
      .filter((target) => {
        if (seenVideoIds.has(target.videoId)) return false;
        seenVideoIds.add(target.videoId);
        return true;
      });
    return {
      show,
      ep: index + 1,
      path,
      due: isTranscriptDue(show.date, now),
      exists: existsSync(path),
      youtubeTargets,
    };
  });
}

function pullTranscriptFiles({
  now = Date.now(),
  dryRun = false,
  root = ROOT,
  ytdlpBin = YTDLP_BIN,
  vaultDir = process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT,
  downloadVtt = (target) => downloadEnglishVtt(target, { ytdlpBin }),
  writeOnce = writeTranscriptOnce,
  logger = console,
} = {}) {
  const registryPath = join(root, "data", "restream", "postlive-registry.json");
  const transcriptsDir = join(root, "transcripts");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const plans = planTranscriptPulls(registry, { now, transcriptsDir });
  const statePath = join(root, "data", "restream", "transcript-state.json");
  const state = readJsonFile(statePath, { fallback: { schemaVersion: 1, entries: {} } });
  if (state.schemaVersion !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) throw new Error("transcript source state is invalid");
  const pulledAt = new Date(now).toISOString();
  const chaptersPath = join(root, "data", "restream", "chapters.json");
  const record = (plan, sourceState, objectId, reason = null, replaced = null) => {
    if (dryRun) return;
    const sha256 = existsSync(plan.path) ? sha256Of(readFileSync(plan.path)) : null;
    const previous = state.entries[plan.show.slug];
    const replacedCopies = [...(previous?.replaced || []), ...(replaced ? [replaced] : [])];
    state.entries[plan.show.slug] = {
      reading: sourceState === "ready" && previous?.reading?.state === "ready" && previous?.sha256 === sha256
        ? previous.reading
        : readingEnvelope({ source: "transcript", episode: plan.show.slug, objectId, pulledAt, state: sourceState }),
      checkedAt: pulledAt,
      reason, file: existsSync(plan.path) ? `transcripts/${plan.show.slug}.txt` : null,
      ...(sha256 ? { sha256 } : {}),
      ...(replacedCopies.length ? { replaced: replacedCopies } : {}),
    };
    state.checkedAt = pulledAt;
    atomicWriteJson(statePath, state);
  };
  let created = 0;
  let replacedCount = 0;
  let waiting = 0;
  for (const plan of plans) {
    if (plan.show.date > phoenixDateKey(now)) continue;
    if (existsSync(plan.path)) {
      // 2026-10-16: captions are the fallback, never the end state. A Restream
      // speaker export that reaches the vault after captions were saved replaces
      // them once; a speaker transcript is never replaced.
      const current = readFileSync(plan.path);
      const vaultTranscript = isCaptionsTranscript(current.toString("utf8")) ? planVaultTranscript(plan.show, plan.ep, vaultDir) : null;
      if (vaultTranscript && dryRun) {
        logger.log(`transcripts: E${plan.ep} would replace its YouTube auto-captions with ${vaultTranscript.file} from the owner vault`);
        continue;
      }
      if (vaultTranscript) {
        const content = restreamTranscriptHeader(plan.show, plan.ep, plan.youtubeTargets[0], vaultTranscript.file) + vaultTranscript.body;
        const captionsSha256 = sha256Of(current);
        const supersededChapters = supersedeChapters(chaptersPath, plan.show.slug, sha256Of(content), now);
        if (replaceCaptionsTranscript(plan.path, content, captionsSha256)) {
          replacedCount++;
          logger.log(`transcripts: E${plan.ep} replaced its YouTube auto-captions with ${vaultTranscript.file} from the owner vault${supersededChapters ? "; its chapters were superseded" : ""}`);
          record(plan, "ready", `vault:${vaultTranscript.file}`, null, { sha256: captionsSha256, objectId: state.entries[plan.show.slug]?.reading?.objectId ?? null, replacedAt: pulledAt });
          continue;
        }
        logger.log(`transcripts: E${plan.ep} transcript changed while the vault source was being read — kept that file unchanged`);
      }
      record(plan, "ready", `file:transcripts/${plan.show.slug}.txt`);
      logger.log(`transcripts: E${plan.ep} already has a transcript — kept unchanged`);
      continue;
    }
    const vaultTranscript = planVaultTranscript(plan.show, plan.ep, vaultDir, {
      onSkip: (file) => logger.warn(`WARN  transcripts: E${plan.ep} skipped ${file} in the owner vault — it has no timed speaker lines, so it is not a Restream speaker transcript`),
    });
    if (vaultTranscript) {
      if (dryRun) {
        logger.log(`transcripts: E${plan.ep} would import ${vaultTranscript.file} from the owner vault`);
        continue;
      }
      const content = restreamTranscriptHeader(plan.show, plan.ep, plan.youtubeTargets[0], vaultTranscript.file) + vaultTranscript.body;
      const stored = writeOnce(plan.path, content);
      if (stored) {
        created++;
        logger.log(`transcripts: E${plan.ep} imported ${vaultTranscript.file} from the owner vault`);
        record(plan, "ready", `vault:${vaultTranscript.file}`);
      } else {
        logger.log(`transcripts: E${plan.ep} gained a transcript while the vault source was being read — kept that file unchanged`);
        record(plan, "ready", `file:transcripts/${plan.show.slug}.txt`);
      }
      continue;
    }
    if (!plan.due) {
      logger.log(`transcripts: E${plan.ep} is not on day two yet — no transcript expected`);
      continue;
    }
    if (dryRun) {
      logger.log(`transcripts: E${plan.ep} is due and would try ${plan.youtubeTargets.length} YouTube upload(s)`);
      continue;
    }
    let stored = false;
    const hardErrors = [];
    let refusal = null;
    for (const target of plan.youtubeTargets) {
      let body;
      try {
        body = vttToTranscript(downloadVtt(target));
      } catch (error) {
        // 2026-10-16: a refusal is a wait, like captions not yet published (PRD v11 rule 24, v13 rules 30–31).
        // The next upload is still asked: it is another video, and its own English track may be served.
        const said = `${error?.stderr || ""}\n${error?.message || error}`;
        if (REFUSED.test(said)) {
          refusal ||= refusalReason(said);
          logger.warn(`WARN  transcripts: E${plan.ep} ${target.account || target.videoId} captions refused by YouTube for now — ${errorLine(error)}`);
          continue;
        }
        const expectedDelay = /captions pending|not published English auto-captions|no subtitles|no automatic captions|no English auto-captions/i.test(errorLine(error));
        if (!expectedDelay) {
          hardErrors.push(error?.code === "ENOENT" ? `yt-dlp is unavailable at ${ytdlpBin}` : `caption download failed for E${plan.ep}: ${errorLine(error)}`);
          continue;
        }
        logger.warn(`WARN  transcripts: E${plan.ep} ${target.account || target.videoId} captions unavailable — ${errorLine(error)}`);
        continue;
      }
      const content = transcriptHeader(plan.show, plan.ep, target, phoenixDateKey(now)) + body + "\n";
      // Storage failures are infrastructure failures, not caption misses.
      // Let them stop the script so the operator sees the real problem.
      stored = writeOnce(plan.path, content);
      if (stored) {
        created++;
        logger.log(`transcripts: E${plan.ep} saved YouTube auto-captions from ${target.account || target.videoId}`);
        record(plan, "ready", `youtube:${target.videoId}`);
      } else {
        logger.log(`transcripts: E${plan.ep} gained a transcript while captions were downloading — kept that file unchanged`);
        record(plan, "ready", `file:transcripts/${plan.show.slug}.txt`);
      }
      break;
    }
    if (!stored && !existsSync(plan.path)) {
      if (hardErrors.length) {
        record(plan, "failed", `youtube:${plan.youtubeTargets.map((target) => target.videoId).join(",") || "unregistered"}`, "Caption downloads failed; no transcript was promoted.");
        throw new Error(hardErrors.join("; "));
      }
      waiting++;
      record(plan, "pending", `youtube:${plan.youtubeTargets.map((target) => target.videoId).join(",") || "unregistered"}`, refusal || "No English captions or owner transcript are available yet.");
      logger.warn(refusal
        ? `WARN  transcripts: E${plan.ep} is due but YouTube refused its caption download for now; it will be tried again on the next run`
        : `WARN  transcripts: E${plan.ep} is due but no English auto-captions are available; it will be tried again tomorrow`);
    }
  }
  return { created, replaced: replacedCount, waiting, planned: plans.length };
}

export function runTranscriptPull(options = {}) {
  const statePath = join(options.root || ROOT, "data", "restream", "transcript-state.json");
  return withSourceLock(statePath, () => pullTranscriptFiles(options));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = runTranscriptPull({ dryRun });
  console.log(`transcripts: ${result.created} created, ${result.replaced} replaced, ${result.waiting} waiting, ${result.planned} tracked episode(s)`);
  if (result.waiting && !dryRun) process.exitCode = 20;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`transcripts: ${errorLine(error)}\n`);
    process.exit(1);
  });
}
