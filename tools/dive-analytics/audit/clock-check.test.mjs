#!/usr/bin/env node
// clock-check.test.mjs — the clock check as a daily chain step (2026-10-16).
// A refusal from YouTube (HTTP 429) ends the run's downloads and leaves the
// rest as they were for the next morning; a `failed` check waits for a new
// transcript; the same outcome again keeps its record; a failed download
// records yt-dlp's own error line, never the command it ran. No network:
// captions come from an injected download, in a throwaway folder.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClockCheck, downloadReason, REFUSED, CAPTION_LANGS } from "../../../scripts/restream/clock-check.mjs";
import { toStamp } from "../transcripts.mjs";

const quiet = { log() {} };
const root = mkdtempSync(join(tmpdir(), "dive-clock-check-test-"));
const NOW = Date.parse("2026-10-16T14:00:00Z");
const LATER = Date.parse("2026-10-17T14:00:00Z");
try {
  mkdirSync(join(root, "data", "restream"), { recursive: true });
  mkdirSync(join(root, "transcripts"), { recursive: true });
  const shows = [1, 2, 3].map((n) => ({
    slug: `2026-07-1${n}-dive-radio-e${n}`, date: `2026-07-1${n}`, title: `Dive Radio: E${n}`,
    targets: [{ kind: "youtube", account: "joindiveclub", videoId: `video${n}xxxxx`.slice(0, 11) }],
  }));
  writeFileSync(join(root, "data", "restream", "postlive-registry.json"), JSON.stringify({ shows }));
  // each transcript: 200 segments, each opening with its own six-word phrase
  const words = (n) => Array.from({ length: 1200 }, (_, i) => `e${n}w${i}`);
  for (const [i, show] of shows.entries()) {
    const w = words(i + 1);
    const body = Array.from({ length: 200 }, (_, k) => `${toStamp(k * 10)} [Speaker 1]\n${w.slice(k * 6, k * 6 + 6).join(" ")}\n`).join("\n");
    writeFileSync(join(root, "transcripts", `${show.slug}.txt`), `Dive Radio E${i + 1}\nAired: ${show.date}\nSource: Restream speaker transcript\n\n${body}`);
  }
  // the same words 2 s later on the upload's clock
  const captionsFor = (n) => ({ events: words(n).map((word, i) => ({ tStartMs: (Math.floor(i / 6) * 10 + 2) * 1000, segs: [{ utf8: word }] })) });
  const store = () => JSON.parse(readFileSync(join(root, "data", "restream", "clock-checks.json"), "utf8"));
  const refusal = Object.assign(new Error("Command failed: /opt/homebrew/bin/yt-dlp --no-playlist …"), {
    stderr: "WARNING: something\nERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests\n",
  });

  assert.equal(downloadReason(refusal), "Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests", "yt-dlp's own words, never the command");
  assert.equal(downloadReason(new Error("YouTube has not published English auto-captions yet")), "YouTube has not published English auto-captions yet");
  assert.equal(downloadReason(Object.assign(new Error("x"), { stderr: "ERROR: [youtube] video1xxxxx: Sign in to confirm you’re not a bot\n" })), "Sign in to confirm you’re not a bot");
  assert.ok(REFUSED.test("HTTP Error 429: Too Many Requests") && REFUSED.test("Sign in to confirm you're not a bot") && !REFUSED.test("YouTube has not published English auto-captions yet"));
  assert.deepEqual([...CAPTION_LANGS], ["en-orig", "en"], "the upload's own English speech recognition before YouTube's translated track");

  // run 1: E1 matches, E2 is turned away, so E3 is left for the next run untouched
  const asked = [];
  await runClockCheck({ root, now: NOW, pauseMs: 0, logger: quiet, download: (videoId) => {
    asked.push(videoId);
    if (videoId === shows[0].targets[0].videoId) return captionsFor(1);
    throw refusal;
  } });
  assert.deepEqual(asked, [shows[0].targets[0].videoId, shows[1].targets[0].videoId], "the first refusal ends this run's downloads");
  let s = store();
  const up = (n, st = s) => st.entries[shows[n - 1].slug]?.uploads["yt:joindiveclub"];
  assert.equal(up(1).state, "ready");
  assert.equal(up(1).offsetSec, 2);
  assert.equal(up(2).state, "pending");
  assert.match(up(2).reason, /HTTP Error 429/);
  assert.equal(up(2).offsetSec, null, "a refused download is pending with its reason, never an offset of 0");
  assert.equal(up(3), undefined, "left as it was");

  // run 2, a day later: E1 is held; E2 is refused again (its record keeps the day it was first seen);
  // E3 still waits. A failed check would be retried only for a new transcript.
  const asked2 = [];
  await runClockCheck({ root, now: LATER, pauseMs: 0, logger: quiet, download: (videoId) => { asked2.push(videoId); throw refusal; } });
  assert.deepEqual(asked2, [shows[1].targets[0].videoId], "a ready check is never downloaded again");
  const s2 = store();
  assert.equal(up(2, s2).checkedAt, up(2).checkedAt, "the same outcome again keeps its record");
  assert.equal(s2.updatedAt, s.updatedAt, "nothing changed, nothing written");

  // run 3: captions whose words share nothing with the transcript fail; E3 matches
  await runClockCheck({ root, now: LATER, pauseMs: 0, logger: quiet, download: (videoId) => (videoId === shows[2].targets[0].videoId ? captionsFor(3) : { events: [{ tStartMs: 0, segs: [{ utf8: "nothing in common" }] }] }) });
  s = store();
  assert.equal(up(2).state, "failed");
  assert.equal(up(3).state, "ready");
  const asked4 = [];
  await runClockCheck({ root, now: LATER, pauseMs: 0, logger: quiet, download: (videoId) => { asked4.push(videoId); return captionsFor(2); } });
  assert.deepEqual(asked4, [], "a failed check waits for a new transcript");
  // a new transcript for E2 (a late speaker export) is checked again
  writeFileSync(join(root, "transcripts", `${shows[1].slug}.txt`), `${readFileSync(join(root, "transcripts", `${shows[1].slug}.txt`), "utf8")}\n`);
  await runClockCheck({ root, now: LATER, pauseMs: 0, logger: quiet, download: () => captionsFor(2) });
  assert.equal(up(2, store()).state, "ready", "a new transcript is checked again");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("clock-check.test: a refusal ends the run's downloads and leaves the rest for the next morning; ready and failed checks wait for a new transcript; a repeated outcome keeps its record; a failed download records yt-dlp's own words");
