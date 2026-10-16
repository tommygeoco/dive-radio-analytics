// mirror-transcripts.test.mjs — the dedicated checkout is the source, an
// existing hand-supplied vault transcript is never overwritten, and a YouTube
// captions transcript never takes the name reserved for the Restream export.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE, mirrorTranscripts } from "../../../scripts/restream/mirror-transcripts.mjs";
import { isCaptionsTranscript, planVaultTranscript, restreamTranscriptHeader, transcriptHeader, vaultTranscriptCandidates } from "../../../scripts/restream/transcripts-pull.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "restream", "mirror-transcripts.mjs");
const base = mkdtempSync(join(tmpdir(), "dive-transcript-mirror."));
const source = join(base, "source");
const vault = join(base, "vault");
const refreshState = join(base, "runtime", "refresh-needed.json");
mkdirSync(source);
mkdirSync(vault);

// Publisher transcripts in the two shapes transcripts-pull writes.
const show = (ep, date) => ({ title: `Dive Radio: Episode ${ep}`, date });
const upload = (ep) => ({ kind: "youtube", videoId: `video${ep}` });
const speaker = (ep, date, words) => restreamTranscriptHeader(show(ep, date), ep, upload(ep), `e${ep}-transcript-${date}.txt`)
  + `00:03:15 [Speaker 1]\n${words}`;
const captions = (ep, date, words) => transcriptHeader(show(ep, date), ep, upload(ep), "2026-10-16") + `00:00:01  ${words}\n`;
const reserved = (ep) => new RegExp(`^e${ep}-transcript-.*\\.txt$`);
const vaultNames = (ep) => readdirSync(vault).filter((name) => name.startsWith(`e${ep}-`)).sort();

try {
  writeFileSync(join(source, "one.txt"), speaker(1, "2026-08-01", "source one"));
  writeFileSync(join(source, "two.txt"), speaker(2, "2026-08-08", "source two"));
  writeFileSync(join(vault, "e1-transcript-2026-08-01.txt"), "hand supplied\n");
  const result = mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} });
  assert.deepEqual(result.copied, ["e2-transcript-2026-08-08.txt"], "a speaker transcript takes the reserved name when the vault has none");
  assert.equal(readFileSync(join(vault, "e1-transcript-2026-08-01.txt"), "utf8"), "hand supplied\n");
  assert.match(readFileSync(join(vault, "e2-transcript-2026-08-08.txt"), "utf8"), /source two/);
  assert.equal(result.refreshPending, true);
  assert.equal(existsSync(refreshState), true, "copying marks the search refresh as pending before the copy can be forgotten");
  assert.throws(() => mirrorTranscripts({ source, vault, refreshState, refresh: () => { throw new Error("qmd offline"); }, log: () => {} }), /search index refresh failed/);
  assert.equal(existsSync(refreshState), true, "a failed search refresh remains pending for the next run");
  let refreshes = 0;
  const retried = mirrorTranscripts({ source, vault, refreshState, refresh: () => { refreshes++; }, log: () => {} });
  assert.equal(retried.copied.length, 0, "the retry does not need to recopy a protected transcript");
  assert.equal(refreshes, 1, "the next run retries the previously failed search refresh");
  assert.equal(existsSync(refreshState), false, "only a successful refresh clears pending state");
  const messages = [];
  mirrorTranscripts({ source, vault, refreshState, quietCurrent: true, refresh: () => { refreshes++; }, log: (m) => messages.push(m) });
  assert.equal(refreshes, 2, "an already-complete vault without a pending marker still checks its search index");
  assert.deepEqual(messages, [], "quiet current still performs indexing without routine announcements");
  assert.equal(existsSync(refreshState), false);
  assert.throws(() => mirrorTranscripts({ source, vault, refreshState, refresh: () => { throw new Error("index unavailable on unchanged vault"); }, log: () => {} }), /search index refresh failed/);
  assert.equal(existsSync(refreshState), true, "an unchanged vault cannot mask a failed index refresh");
  mirrorTranscripts({ source, vault, refreshState, refresh: () => { refreshes++; }, log: () => {} });
  assert.equal(existsSync(refreshState), false);
  mirrorTranscripts({ source, vault, refreshState, dryRun: true, refresh: () => { throw new Error("dry run must not index"); }, log: () => {} });
  assert.equal(existsSync(refreshState), false, "dry run never creates refresh state");
  assert.equal(mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} }).copied.length, 0);
  assert.match(DEFAULT_SOURCE, /Dive Radio Analytics\/publisher-main\/transcripts$/, "default source belongs to the isolated publisher");

  // --- 2026-10-16: captions never take the Restream export's name ---------
  // E16 replays E14's morning with today's mirror. Day two 07:00: the
  // publisher saves captions. 08:00: the mirror copies them. 09:20: the export
  // lands. Day three 07:00: the export replaces the publisher's captions.
  const e16Captions = captions(16, "2026-10-22", "hello there");
  writeFileSync(join(source, "2026-10-22-sixteen.txt"), e16Captions);
  // E17: clips.mjs already pulled its own captions (named by the Pacific date).
  writeFileSync(join(source, "2026-10-29-seventeen.txt"), captions(17, "2026-10-29", "clips pulled these"));
  writeFileSync(join(vault, "e17-autocaptions-2026-10-28.txt"), "clips.mjs captions pull\n");
  // E18: a captions copy the mirror wrote under the reserved name before the
  // change (E1 and E5 in the owner vault). It stays, and is not doubled.
  const e18Captions = captions(18, "2026-11-05", "legacy copy");
  writeFileSync(join(source, "2026-11-05-eighteen.txt"), e18Captions);
  writeFileSync(join(vault, "e18-transcript-2026-11-05.txt"), e18Captions);
  // E19: a vault with nothing yet, read in a dry run.
  writeFileSync(join(source, "2026-11-12-nineteen.txt"), captions(19, "2026-11-12", "dry run"));

  const dry = mirrorTranscripts({ source, vault, refreshState, dryRun: true, log: () => {} });
  assert.deepEqual(dry.copied, ["e16-autocaptions-2026-10-22.txt", "e19-autocaptions-2026-11-12.txt"]);
  assert.deepEqual(vaultNames(16), [], "a dry run writes nothing");

  const dayTwo = mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} });
  assert.deepEqual(dayTwo.copied, ["e16-autocaptions-2026-10-22.txt", "e19-autocaptions-2026-11-12.txt"], "captions are copied under the captions name");
  assert.deepEqual(vaultNames(16), ["e16-autocaptions-2026-10-22.txt"], "the reserved name stays free for the export");
  assert.equal(readFileSync(join(vault, "e16-autocaptions-2026-10-22.txt"), "utf8"), e16Captions, "the copy is the publisher's bytes");
  for (const name of readdirSync(vault).filter((file) => /^e\d+-transcript-/.test(file) && !file.startsWith("e18-"))) {
    assert.equal(isCaptionsTranscript(readFileSync(join(vault, name), "utf8")), false, `${name}: the mirror wrote captions under the reserved name`);
  }
  assert.deepEqual(vaultNames(17), ["e17-autocaptions-2026-10-28.txt"], "an episode's captions already in the vault win");
  assert.equal(readFileSync(join(vault, "e17-autocaptions-2026-10-28.txt"), "utf8"), "clips.mjs captions pull\n");
  assert.deepEqual(vaultNames(18), ["e18-transcript-2026-11-05.txt"], "a transcript under the reserved name wins over a captions copy");
  const skipped = [];
  assert.deepEqual(vaultTranscriptCandidates(show(16, "2026-10-22"), 16, vault, { onSkip: (file) => skipped.push(file) }), []);
  assert.deepEqual(skipped, [], "the importer never sees the mirror's captions copy");

  // 09:20: the Restream export lands under its own name, which is free.
  const exportBody = "00:03:15 [Speaker 1]\nhello there, welcome to the show";
  writeFileSync(join(vault, "e16-transcript-2026-10-22.txt"), `${exportBody}\n`, { flag: "wx" });
  assert.equal(planVaultTranscript(show(16, "2026-10-22"), 16, vault).file, "e16-transcript-2026-10-22.txt");

  // Day three: the publisher's captions are now the export, and the mirror
  // leaves both vault files as they are.
  writeFileSync(join(source, "2026-10-22-sixteen.txt"), speaker(16, "2026-10-22", "hello there, welcome to the show"));
  const dayThree = mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} });
  assert.deepEqual(dayThree.copied, []);
  assert.deepEqual(vaultNames(16), ["e16-autocaptions-2026-10-22.txt", "e16-transcript-2026-10-22.txt"]);
  assert.equal(readFileSync(join(vault, "e16-transcript-2026-10-22.txt"), "utf8"), `${exportBody}\n`, "the export is never overwritten");
  assert.deepEqual(readdirSync(vault).filter((file) => reserved(16).test(file)), ["e16-transcript-2026-10-22.txt"],
    "a reader of e<n>-transcript-… (clips.mjs findTranscript) finds only the export");

  // A publisher file of neither shape never reaches the vault under any name.
  writeFileSync(join(source, "2026-11-19-twenty.txt"), "Dive Radio E20 — Twenty\nAired: 2026-11-19\nSource: something new\n\nwords\n");
  assert.throws(() => mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} }),
    /2026-11-19-twenty\.txt: is neither a Restream speaker transcript nor YouTube auto-captions/);
  assert.deepEqual(vaultNames(20), []);
  rmSync(join(source, "2026-11-19-twenty.txt"));

  const quiet = spawnSync(process.execPath, [SCRIPT, "--quiet-current", "--no-qmd"], {
    encoding: "utf8",
    env: { ...process.env, DIVE_TRANSCRIPT_SOURCE: source, DIVE_TRANSCRIPT_VAULT: vault, DIVE_TRANSCRIPT_REFRESH_STATE: refreshState },
  });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "", "a healthy current mirror can stay silent for a native command job");

  const missing = spawnSync(process.execPath, [SCRIPT, "--quiet-current", "--no-qmd"], {
    encoding: "utf8",
    env: { ...process.env, DIVE_TRANSCRIPT_SOURCE: join(base, "missing"), DIVE_TRANSCRIPT_VAULT: vault, DIVE_TRANSCRIPT_REFRESH_STATE: refreshState },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /source folder missing/);
} finally {
  rmSync(base, { force: true, recursive: true });
}

console.log("mirror-transcripts.test: isolated source, protected copies, captions kept off the reserved name, durable search-refresh retry, quiet no-op, and loud failure pass");
