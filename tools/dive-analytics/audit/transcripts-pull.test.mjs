#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTranscriptDue,
  planVaultTranscript,
  phoenixCalendarAgeDays,
  restreamTranscriptHeader,
  runTranscriptPull,
  speakerBody,
  transcriptHeader,
  vttToTranscript,
  writeTranscriptOnce,
} from "../../../scripts/restream/transcripts-pull.mjs";

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
  assert.deepEqual(result, { created: 1, waiting: 0, planned: 1 });
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
  assert.deepEqual(missing, { created: 0, waiting: 1, planned: 1 });
  assert.equal(existsSync(transcriptPath), false);
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
  assert.deepEqual(sameDay, { created: 1, waiting: 0, planned: 1 });
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

  writeFileSync(join(cases, "e8-transcript-2026-09-03.txt"), "not a timed speaker transcript\n");
  assert.throws(() => planVaultTranscript(show, 8, cases), /no timed speaker body/);
  rmSync(join(cases, "e8-transcript-2026-09-03.txt"));

  writeFileSync(join(cases, "e8-transcript-2026-09-03-a.txt"), expectedBody);
  writeFileSync(join(cases, "e8-transcript-2026-09-03-b.txt"), "00:03:17 [Speaker 1]\nDifferent body.\n");
  assert.throws(() => planVaultTranscript(show, 8, cases), /conflicting vault transcripts/);
  rmSync(join(cases, "e8-transcript-2026-09-03-b.txt"));
  writeFileSync(join(cases, "e8-transcript-2026-09-03-b.txt"), expectedBody);
  assert.equal(planVaultTranscript(show, 8, cases).file, "e8-transcript-2026-09-03-a.txt", "identical copies choose the first filename deterministically");
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
}

console.log("ok    transcripts pull: day-two gate, vault import and parity, conflict guard, caption fallback, retry, and no-overwrite passed");
