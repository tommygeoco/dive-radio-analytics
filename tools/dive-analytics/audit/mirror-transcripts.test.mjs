// mirror-transcripts.test.mjs — the dedicated checkout is the source and an
// existing hand-supplied vault transcript is never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE, mirrorTranscripts } from "../../../scripts/restream/mirror-transcripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "restream", "mirror-transcripts.mjs");
const base = mkdtempSync(join(tmpdir(), "dive-transcript-mirror."));
const source = join(base, "source");
const vault = join(base, "vault");
const refreshState = join(base, "runtime", "refresh-needed.json");
mkdirSync(source);
mkdirSync(vault);
try {
  writeFileSync(join(source, "one.txt"), "Dive Radio E1 — One\nAired: 2026-08-01\nsource one\n");
  writeFileSync(join(source, "two.txt"), "Dive Radio E2 — Two\nAired: 2026-08-08\nsource two\n");
  writeFileSync(join(vault, "e1-transcript-2026-08-01.txt"), "hand supplied\n");
  const result = mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} });
  assert.deepEqual(result.copied, ["e2-transcript-2026-08-08.txt"]);
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
  assert.equal(mirrorTranscripts({ source, vault, refreshState, noQmd: true, log: () => {} }).copied.length, 0);
  assert.match(DEFAULT_SOURCE, /Dive Radio Analytics\/publisher-main\/transcripts$/, "default source belongs to the isolated publisher");

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

console.log("mirror-transcripts.test: isolated source, protected copies, durable search-refresh retry, quiet no-op, and loud failure pass");
