// mirror-transcripts.test.mjs — the dedicated checkout is the source and an
// existing hand-supplied vault transcript is never overwritten.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorTranscripts, ROOT } from "../../../scripts/restream/mirror-transcripts.mjs";

const base = mkdtempSync(join(tmpdir(), "dive-transcript-mirror."));
const source = join(base, "source");
const vault = join(base, "vault");
mkdirSync(source);
mkdirSync(vault);
try {
  writeFileSync(join(source, "one.txt"), "Dive Radio E1 — One\nAired: 2026-08-01\nsource one\n");
  writeFileSync(join(source, "two.txt"), "Dive Radio E2 — Two\nAired: 2026-08-08\nsource two\n");
  writeFileSync(join(vault, "e1-transcript-2026-08-01.txt"), "hand supplied\n");
  const result = mirrorTranscripts({ source, vault, noQmd: true, log: () => {} });
  assert.deepEqual(result.copied, ["e2-transcript-2026-08-08.txt"]);
  assert.equal(readFileSync(join(vault, "e1-transcript-2026-08-01.txt"), "utf8"), "hand supplied\n");
  assert.match(readFileSync(join(vault, "e2-transcript-2026-08-08.txt"), "utf8"), /source two/);
  assert.equal(mirrorTranscripts({ source, vault, noQmd: true, log: () => {} }).copied.length, 0);
  assert.match(ROOT, /dive-radio-analytics-publisher$/, "default source belongs to this checkout");
} finally {
  rmSync(base, { force: true, recursive: true });
}

console.log("mirror-transcripts.test: dedicated source, missing-only copy, hand transcript protection, and idempotence pass");
