#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  isCaptionsTranscript,
  isTranscriptDue,
  planVaultTranscript,
  phoenixCalendarAgeDays,
  replaceCaptionsTranscript,
  restreamTranscriptHeader,
  runTranscriptPull,
  speakerBody,
  transcriptHeader,
  vttToTranscript,
  writeTranscriptOnce,
} from "../../../scripts/restream/transcripts-pull.mjs";
import { validateStore as validateChapterStore } from "../chapters.mjs";
import { sourceStoreIntegrityErrors } from "../source-integrity.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const saturdayMorningPhoenix = Date.parse("2026-08-22T14:00:00Z");
const fridayMorningPhoenix = Date.parse("2026-08-21T14:00:00Z");
const thursdayMorningPhoenix = Date.parse("2026-08-20T14:00:00Z");
assert.equal(phoenixCalendarAgeDays("2026-08-20", saturdayMorningPhoenix), 2);
assert.equal(isTranscriptDue("2026-08-20", saturdayMorningPhoenix), true);
assert.equal(isTranscriptDue("2026-08-20", fridayMorningPhoenix), true);
assert.equal(isTranscriptDue("2026-08-20", thursdayMorningPhoenix), false);
assert.equal(isTranscriptDue("2026-08-23", saturdayMorningPhoenix), false);

const vtt = `WEBVTT
Kind: captions
Language: en

00:00:03.120 --> 00:00:05.000 align:start position:0%
<c>Hello &amp; welcome</c>

cue-2
00:00:05.100 --> 00:00:07.000
<00:00:05.100><c>Hello &amp; welcome</c>

00:01:07.900 --> 00:01:10.000
This is <c.colorE5E5E5>next</c>.
`;
assert.equal(vttToTranscript(vtt), "00:00:03  Hello & welcome\n00:01:07  This is next.");

const rollingVtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Welcome to Dive Radio

00:00:03.000 --> 00:00:05.000
Dive Radio with Ridd and Tom
`;
assert.equal(vttToTranscript(rollingVtt), "00:00:01  Welcome to Dive Radio\n00:00:03  with Ridd and Tom");

const show = { title: "Dive Radio: A New Episode", date: "2026-08-20" };
const target = { videoId: "abc123", url: "https://www.youtube.com/watch?v=abc123" };
assert.match(transcriptHeader(show, 7, target, "2026-08-22"), /^Dive Radio E7 — A New Episode\nAired: 2026-08-20 · YouTube:/);

const workDir = mkdtempSync(join(tmpdir(), "dive-radio-transcript-test-"));
try {
  const path = join(workDir, "episode.txt");
  assert.equal(writeTranscriptOnce(path, "manual transcript\n"), true);
  assert.equal(writeTranscriptOnce(path, "replacement\n"), false);
  assert.equal(readFileSync(path, "utf8"), "manual transcript\n");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const pipelineRoot = mkdtempSync(join(tmpdir(), "dive-radio-transcript-pipeline-test-"));
try {
  mkdirSync(join(pipelineRoot, "data", "restream"), { recursive: true });
  const emptyVault = join(pipelineRoot, "vault");
  mkdirSync(emptyVault);
  const slug = "2026-08-20-dive-radio-test";
  writeFileSync(join(pipelineRoot, "data", "restream", "postlive-registry.json"), JSON.stringify({
    shows: [{
      slug,
      title: "Dive Radio: Test",
      date: "2026-08-20",
      active: true,
      targets: [
        { kind: "youtube", account: "designertom", videoId: "second" },
        { kind: "youtube", account: "joindiveclub", videoId: "first" },
      ],
    }],
  }));
  const calls = [];
  const quiet = { log() {}, warn() {} };
  const result = runTranscriptPull({
    root: pipelineRoot,
    vaultDir: emptyVault,
    now: saturdayMorningPhoenix,
    logger: quiet,
    downloadVtt(target) {
      calls.push(target.videoId);
      if (target.videoId === "first") throw new Error("captions pending");
      return vtt;
    },
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(result, { created: 1, replaced: 0, waiting: 0, planned: 1 });
  const transcriptPath = join(pipelineRoot, "transcripts", `${slug}.txt`);
  const firstBytes = readFileSync(transcriptPath, "utf8");
  assert.match(firstBytes, /^Dive Radio E1 — Test\n/);
  runTranscriptPull({
    root: pipelineRoot,
    vaultDir: emptyVault,
    now: saturdayMorningPhoenix,
    logger: quiet,
    downloadVtt() { throw new Error("existing file must skip the downloader"); },
  });
  assert.equal(readFileSync(transcriptPath, "utf8"), firstBytes);

  rmSync(transcriptPath);
  const raceCalls = [];
  runTranscriptPull({
    root: pipelineRoot,
    vaultDir: emptyVault,
    now: saturdayMorningPhoenix,
    logger: quiet,
    downloadVtt(target) { raceCalls.push(target.videoId); return vtt; },
    writeOnce(path) {
      writeFileSync(path, "Dive Radio E1 — Test\nmanual Restream transcript\n", { flag: "wx" });
      return false;
    },
  });
  assert.deepEqual(raceCalls, ["first"]);
  assert.equal(readFileSync(transcriptPath, "utf8"), "Dive Radio E1 — Test\nmanual Restream transcript\n");

  rmSync(transcriptPath);
  const writeErrorCalls = [];
  assert.throws(() => runTranscriptPull({
    root: pipelineRoot,
    vaultDir: emptyVault,
    now: saturdayMorningPhoenix,
    logger: quiet,
    downloadVtt(target) { writeErrorCalls.push(target.videoId); return vtt; },
    writeOnce() { const error = new Error("read-only filesystem"); error.code = "EACCES"; throw error; },
  }), /read-only filesystem/);
  assert.deepEqual(writeErrorCalls, ["first"]);

  const missing = runTranscriptPull({
    root: pipelineRoot,
    vaultDir: emptyVault,
    now: saturdayMorningPhoenix,
    logger: quiet,
    downloadVtt() { throw new Error("captions pending"); },
  });
  assert.deepEqual(missing, { created: 0, replaced: 0, waiting: 1, planned: 1 });
  assert.equal(existsSync(transcriptPath), false);
  const statePath = join(pipelineRoot, "data", "restream", "transcript-state.json");
  let state = JSON.parse(readFileSync(statePath));
  assert.equal(state.entries[slug].reading.state, "pending");
  assert.equal(state.entries[slug].reading.episode, slug);
  assert.throws(() => runTranscriptPull({ root: pipelineRoot, vaultDir: emptyVault, now: saturdayMorningPhoenix, logger: quiet,
    downloadVtt() { throw new Error("HTTP 403 forbidden"); } }), /caption download failed/);
  state = JSON.parse(readFileSync(statePath));
  assert.equal(state.entries[slug].reading.state, "failed");
  assert.throws(() => runTranscriptPull({ root: pipelineRoot, vaultDir: emptyVault, now: saturdayMorningPhoenix, logger: quiet,
    downloadVtt() { return "malformed captions"; } }), /no readable timestamped cues/);
  runTranscriptPull({ root: pipelineRoot, vaultDir: emptyVault, now: thursdayMorningPhoenix - 86400000, logger: quiet,
    downloadVtt() { throw new Error("future source must never run"); } });
  assert.equal(JSON.parse(readFileSync(statePath)).entries[slug].reading.state, "failed", "future checks neither query nor record a missing result");
} finally {
  rmSync(pipelineRoot, { recursive: true, force: true });
}

const vaultRoot = mkdtempSync(join(tmpdir(), "dive-radio-vault-import-test-"));
try {
  const vault = join(vaultRoot, "vault");
  const root = join(vaultRoot, "publisher");
  mkdirSync(join(root, "data", "restream"), { recursive: true });
  mkdirSync(vault);
  const slug = "2026-09-02-dive-radio-vault-test";
  const show = {
    slug,
    title: "Dive Radio: Vault Test",
    date: "2026-09-03",
    active: true,
    targets: [{ kind: "youtube", account: "joindiveclub", videoId: "vault123" }],
  };
  writeFileSync(join(root, "data", "restream", "postlive-registry.json"), JSON.stringify({ shows: [show] }));
  const raw = "Export note that is not part of the transcript\n\n00:03:17 [Speaker 1]\nExact first line.\n\n00:03:21 [Speaker 2]\nExact second line.\n";
  const source = "e1-transcript-2026-09-03.txt";
  writeFileSync(join(vault, source), raw);
  const expectedBody = speakerBody(raw);
  let downloadCalls = 0;
  const sameDay = runTranscriptPull({
    root,
    vaultDir: vault,
    now: Date.parse("2026-09-03T23:00:00Z"),
    logger: { log() {}, warn() {} },
    downloadVtt() { downloadCalls++; throw new Error("vault must win"); },
  });
  assert.deepEqual(sameDay, { created: 1, replaced: 0, waiting: 0, planned: 1 });
  assert.equal(downloadCalls, 0, "same-air-day vault import must not call YouTube");
  const canonical = readFileSync(join(root, "transcripts", `${slug}.txt`), "utf8");
  const header = restreamTranscriptHeader(show, 1, show.targets[0], source);
  assert.equal(canonical, header + expectedBody, "vault speaker body must remain byte-for-byte identical after the canonical header");

  writeFileSync(join(vault, source), "00:03:17 [Speaker 1]\nChanged source must not replace canonical.\n");
  runTranscriptPull({
    root,
    vaultDir: vault,
    now: Date.parse("2026-09-04T14:00:00Z"),
    logger: { log() {}, warn() {} },
    downloadVtt() { throw new Error("existing canonical must skip every source"); },
  });
  assert.equal(readFileSync(join(root, "transcripts", `${slug}.txt`), "utf8"), canonical);

  const cases = join(vaultRoot, "cases");
  mkdirSync(cases);
  writeFileSync(join(cases, "e8-transcript-2026-09-02.txt"), expectedBody);
  assert.equal(planVaultTranscript(show, 8, cases), null, "wrong air date must not match");

  const whisper = "Dive Radio E8 — Vault Test\nSource: local Whisper of the replay audio, no speaker labels\n\n[00:00:00] Music\n[00:03:17] Exact first line.\n";
  writeFileSync(join(cases, "e8-transcript-2026-09-03.txt"), whisper);
  const skipped = [];
  assert.equal(planVaultTranscript(show, 8, cases, { onSkip: (file) => skipped.push(file) }), null, "a file without timed speaker lines is not a vault source");
  assert.deepEqual(skipped, ["e8-transcript-2026-09-03.txt"], "the skipped file is named");
  assert.throws(() => speakerBody(whisper), /no timed speaker body/, "the canonical parity check still refuses a body without speaker lines");
  writeFileSync(join(cases, "e8-transcript-2026-09-03-restream.txt"), expectedBody);
  assert.equal(planVaultTranscript(show, 8, cases).file, "e8-transcript-2026-09-03-restream.txt", "a speaker export beside a Whisper copy is selected");
  rmSync(join(cases, "e8-transcript-2026-09-03.txt"));
  rmSync(join(cases, "e8-transcript-2026-09-03-restream.txt"));

  writeFileSync(join(cases, "e8-transcript-2026-09-03-a.txt"), expectedBody);
  writeFileSync(join(cases, "e8-transcript-2026-09-03-b.txt"), "00:03:17 [Speaker 1]\nDifferent body.\n");
  assert.throws(() => planVaultTranscript(show, 8, cases), /conflicting vault transcripts/);
  rmSync(join(cases, "e8-transcript-2026-09-03-b.txt"));
  writeFileSync(join(cases, "e8-transcript-2026-09-03-b.txt"), expectedBody);
  assert.equal(planVaultTranscript(show, 8, cases).file, "e8-transcript-2026-09-03-a.txt", "identical copies choose the first filename deterministically");
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
}

// 2026-10-16: the episode-notes job saved a Whisper copy as e14-transcript-<date>.txt
// before the Restream export arrived. It must be skipped, not stop the required step.
const whisperRoot = mkdtempSync(join(tmpdir(), "dive-radio-vault-whisper-test-"));
try {
  const vault = join(whisperRoot, "vault");
  const root = join(whisperRoot, "publisher");
  mkdirSync(join(root, "data", "restream"), { recursive: true });
  mkdirSync(vault);
  const slug = "2026-10-15-dive-radio-whisper-test";
  const show = {
    slug,
    title: "Dive Radio: Whisper Test",
    date: "2026-10-15",
    active: true,
    targets: [{ kind: "youtube", account: "joindiveclub", videoId: "whisper123" }],
  };
  writeFileSync(join(root, "data", "restream", "postlive-registry.json"), JSON.stringify({ shows: [show] }));
  writeFileSync(join(vault, "e1-transcript-2026-10-15.txt"), "Dive Radio E1 — Whisper Test\nSource: local Whisper of the replay audio, no speaker labels\n\n[00:00:00] Music\n[00:03:15] First line.\n");
  const warnings = [];
  const logger = { log() {}, warn: (line) => warnings.push(line) };
  const morning = Date.parse("2026-10-16T14:00:00Z");
  const whisperOnly = runTranscriptPull({
    root,
    vaultDir: vault,
    now: morning,
    logger,
    downloadVtt() { throw new Error("YouTube has not published English auto-captions yet"); },
  });
  assert.deepEqual(whisperOnly, { created: 0, replaced: 0, waiting: 1, planned: 1 }, "a Whisper copy alone leaves the episode waiting instead of stopping the step");
  assert.ok(warnings.some((line) => /E1 skipped e1-transcript-2026-10-15\.txt in the owner vault/.test(line)), "the skip is logged");

  const speaker = "00:03:15 [Speaker 1]\nFirst line.\n\n00:03:25 [Speaker 2]\nSecond line.\n";
  writeFileSync(join(vault, "e1-transcript-2026-10-15-restream.txt"), speaker);
  const withExport = runTranscriptPull({
    root,
    vaultDir: vault,
    now: morning + 3600000,
    logger,
    downloadVtt() { throw new Error("the vault export must win"); },
  });
  assert.deepEqual(withExport, { created: 1, replaced: 0, waiting: 0, planned: 1 });
  const canonical = readFileSync(join(root, "transcripts", `${slug}.txt`), "utf8");
  assert.equal(canonical, restreamTranscriptHeader(show, 1, show.targets[0], "e1-transcript-2026-10-15-restream.txt") + speakerBody(speaker));
} finally {
  rmSync(whisperRoot, { recursive: true, force: true });
}

// 2026-10-16: E14's Restream export reached the vault at 09:20 on day two, after
// a 07:00 run could already have saved captions. A speaker export that arrives
// after captions were saved replaces them once, and the episode's chapters move
// under superseded in the same step, so the chapters store still grounds.
const lateRoot = mkdtempSync(join(tmpdir(), "dive-radio-late-export-test-"));
try {
  const vault = join(lateRoot, "vault");
  const root = join(lateRoot, "publisher");
  mkdirSync(join(root, "data", "restream"), { recursive: true });
  mkdirSync(vault);
  const slug = "2026-10-15-dive-radio-late-export";
  const show = {
    slug,
    title: "Dive Radio: Late Export",
    date: "2026-10-15",
    active: true,
    targets: [{ kind: "youtube", account: "joindiveclub", videoId: "late123" }],
  };
  writeFileSync(join(root, "data", "restream", "postlive-registry.json"), JSON.stringify({ shows: [show] }));
  const quiet = { log() {}, warn() {} };
  const transcriptPath = join(root, "transcripts", `${slug}.txt`);
  const chaptersPath = join(root, "data", "restream", "chapters.json");
  const statePath = join(root, "data", "restream", "transcript-state.json");
  const dayTwo = Date.parse("2026-10-16T14:00:00Z");     // 07:00 Phoenix, day two
  const dayThree = Date.parse("2026-10-17T14:00:00Z");   // 07:00 Phoenix, day three

  // 07:00 day two: no export yet, so captions are saved
  assert.deepEqual(runTranscriptPull({ root, vaultDir: vault, now: dayTwo, logger: quiet, downloadVtt: () => vtt }),
    { created: 1, replaced: 0, waiting: 0, planned: 1 });
  const captions = readFileSync(transcriptPath, "utf8");
  assert.equal(isCaptionsTranscript(captions), true);
  assert.equal(isCaptionsTranscript(restreamTranscriptHeader(show, 1, show.targets[0], "e1-transcript-2026-10-15.txt") + "00:03:15 [Speaker 1]\nLine.\n"), false);
  assert.equal(isCaptionsTranscript(captions.split("\n").slice(0, 4).join("\n") + "\n00:03:15 [Speaker 1]\nLine.\n"), false, "a file with timed speaker lines is never treated as captions");
  // the chapters step lists the captions copy; the 08:00 mirror copies it into the vault under the reserved name
  const captionsEntry = { sha256: sha256(captions), format: "captions", clock: "upload", status: "incomplete", chapters: [], dropped: 0, promptVersion: 1, model: "fixture", writtenAt: "2026-10-16T14:20:00.000Z" };
  const chapters = { version: 1, promptVersion: 1, updatedAt: "2026-10-16T14:20:00.000Z", provider: "anthropic", model: "fixture", entries: { [slug]: captionsEntry }, superseded: [] };
  writeFileSync(chaptersPath, JSON.stringify(chapters, null, 2) + "\n");
  validateChapterStore(JSON.parse(readFileSync(chaptersPath, "utf8")), root);
  writeFileSync(join(vault, "e1-transcript-2026-10-15.txt"), captions);

  // a later run that finds only that copy keeps the captions, silently
  const warnings = [];
  assert.deepEqual(runTranscriptPull({ root, vaultDir: vault, now: dayTwo + 4500000, logger: { log() {}, warn: (line) => warnings.push(line) },
    downloadVtt() { throw new Error("an existing transcript must skip the downloader"); } }), { created: 0, replaced: 0, waiting: 0, planned: 1 });
  assert.equal(readFileSync(transcriptPath, "utf8"), captions);
  assert.deepEqual(warnings, [], "the mirror's captions copy is not a source and is not warned about every morning");

  // 09:20 day two: the Restream export lands beside it
  const speaker = "00:03:15 [Speaker 1]\nWelcome back to Dive Radio.\n\n00:03:25 [Speaker 2]\nGlad to be here.\n";
  const exportFile = "e1-transcript-2026-10-15-restream.txt";
  writeFileSync(join(vault, exportFile), speaker);
  const dryLines = [];
  assert.deepEqual(runTranscriptPull({ root, vaultDir: vault, now: dayTwo + 9000000, dryRun: true, logger: { log: (line) => dryLines.push(line), warn() {} } }),
    { created: 0, replaced: 0, waiting: 0, planned: 1 });
  assert.ok(dryLines.some((line) => line.includes(`would replace its YouTube auto-captions with ${exportFile}`)));
  assert.equal(readFileSync(transcriptPath, "utf8"), captions, "a dry run changes nothing");

  // 07:00 day three: the export replaces the captions copy
  const stateBefore = JSON.parse(readFileSync(statePath, "utf8")).entries[slug];
  const lines = [];
  assert.deepEqual(runTranscriptPull({ root, vaultDir: vault, now: dayThree, logger: { log: (line) => lines.push(line), warn() {} },
    downloadVtt() { throw new Error("the replacement never calls YouTube"); } }), { created: 0, replaced: 1, waiting: 0, planned: 1 });
  const replaced = readFileSync(transcriptPath, "utf8");
  assert.equal(replaced, restreamTranscriptHeader(show, 1, show.targets[0], exportFile) + speakerBody(speaker), "the result is exactly what an on-time import writes");
  assert.ok(lines.some((line) => line === `transcripts: E1 replaced its YouTube auto-captions with ${exportFile} from the owner vault; its chapters were superseded`));
  const chaptersAfter = JSON.parse(readFileSync(chaptersPath, "utf8"));
  assert.equal(chaptersAfter.entries[slug], undefined, "the captions list leaves entries");
  assert.deepEqual(chaptersAfter.superseded, [{ slug, supersededOn: "2026-10-17", why: "transcript changed", entry: captionsEntry }], "and is kept unchanged under superseded");
  assert.equal(chaptersAfter.updatedAt, chapters.updatedAt, "the chapters clock stays the last model write");
  validateChapterStore(chaptersAfter, root);
  assert.throws(() => validateChapterStore({ ...chaptersAfter, entries: { [slug]: captionsEntry } }, root), /sha mismatch/, "without the supersede the validator's chapters check would fail the run");
  const stateAfter = JSON.parse(readFileSync(statePath, "utf8")).entries[slug];
  assert.equal(stateBefore.reading.objectId, "youtube:late123");
  assert.equal(stateAfter.reading.objectId, `vault:${exportFile}`);
  assert.equal(stateAfter.reading.state, "ready");
  assert.equal(stateAfter.sha256, sha256(replaced));
  assert.deepEqual(stateAfter.replaced, [{ sha256: sha256(captions), objectId: "youtube:late123", replacedAt: new Date(dayThree).toISOString() }]);
  assert.deepEqual(sourceStoreIntegrityErrors(root, dayThree), [], "the ledger matches the new bytes");

  // once: a speaker transcript is never replaced, and the ledger keeps the replaced copy
  writeFileSync(join(vault, exportFile), "00:03:15 [Speaker 1]\nAn edited export.\n");
  assert.deepEqual(runTranscriptPull({ root, vaultDir: vault, now: dayThree + 86400000, logger: quiet,
    downloadVtt() { throw new Error("an existing transcript must skip the downloader"); } }), { created: 0, replaced: 0, waiting: 0, planned: 1 });
  assert.equal(readFileSync(transcriptPath, "utf8"), replaced);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).entries[slug].replaced, stateAfter.replaced);

  // the swap refuses a file that changed after it was read
  const racePath = join(lateRoot, "race.txt");
  writeFileSync(racePath, captions);
  assert.equal(replaceCaptionsTranscript(racePath, replaced, sha256("something else")), false);
  assert.equal(readFileSync(racePath, "utf8"), captions);
  assert.equal(replaceCaptionsTranscript(racePath, replaced, sha256(captions)), true);
  assert.equal(readFileSync(racePath, "utf8"), replaced);
} finally {
  rmSync(lateRoot, { recursive: true, force: true });
}

console.log("ok    transcripts pull: day-two gate, vault import and parity, Whisper-copy skip, conflict guard, caption fallback, retry, no-overwrite, and late speaker export replacing captions once passed");
