// live-parity.test.mjs — exact bytes, never timestamp-only parity.
// Run: node tools/dive-analytics/audit/live-parity.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLiveParity, compareArtifactMaps, PARITY_ARTIFACTS } from "../live-parity.mjs";
import { PUBLIC_ARTIFACTS } from "../public-artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

assert.deepEqual(PARITY_ARTIFACTS, ["index.html", "agents.html", "data.json", "data.js", "agent.md", "agent.json", "llms.txt", "agent-skill.md"]);
assert.equal(PARITY_ARTIFACTS, PUBLIC_ARTIFACTS, "local assembly and live parity share one eight-file manifest");

const fixture = Object.fromEntries(PARITY_ARTIFACTS.map((file) => [file, Buffer.from(`${file}\n`)]));
const transcriptSlug = "2026-09-03-dive-radio-parity-fixture";
const transcriptFile = `transcripts/${transcriptSlug}.txt`;
const transcriptBytes = Buffer.from("Dive Radio transcript parity fixture\n");
fixture["data.json"] = Buffer.from(JSON.stringify({
  generatedAt: "2026-09-03T14:00:00.000Z",
  episodes: [{ slug: transcriptSlug, transcript: true }],
}) + "\n");
assert.deepEqual(compareArtifactMaps(fixture, { ...fixture }).mismatches, []);

{
  const live = { ...fixture, "index.html": Buffer.from("index.html changed\n") };
  const result = compareArtifactMaps(fixture, live);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].file, "index.html");
  assert.match(result.mismatches[0].localSha256, /^[a-f0-9]{64}$/);
}

{
  const live = { ...fixture, "agents.html": Buffer.from("agents.html changed\n") };
  const result = compareArtifactMaps(fixture, live);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].file, "agents.html");
}

// Negative control: the old generatedAt-only proof would accept this pair.
// Exact parity must reject it even though both artifacts carry the same stamp.
{
  const stamp = "2026-09-02T01:06:07.447Z";
  const local = { ...fixture, "data.json": Buffer.from(JSON.stringify({ generatedAt: stamp, insights: ["one"] })) };
  const live = { ...fixture, "data.json": Buffer.from(JSON.stringify({ generatedAt: stamp, insights: ["two"] })) };
  const result = compareArtifactMaps(local, live);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map((item) => item.file), ["data.json"]);
}

{
  const missing = { ...fixture }; delete missing["agent.md"];
  assert.deepEqual(compareArtifactMaps(fixture, missing).mismatches[0], { file: "agent.md", reason: "live artifact missing" });
  const missingPage = { ...fixture }; delete missingPage["agents.html"];
  assert.deepEqual(compareArtifactMaps(fixture, missingPage).mismatches[0], { file: "agents.html", reason: "live artifact missing" });
  const newline = { ...fixture, "llms.txt": Buffer.from("llms.txt") };
  assert.equal(compareArtifactMaps(fixture, newline).ok, false, "a final-newline mismatch is a byte mismatch");
}

{
  const helper = readFileSync(join(HERE, "..", "live-parity.mjs"), "utf8");
  const publish = readFileSync(join(ROOT, "scripts", "restream", "postlive-publish.sh"), "utf8");
  const flow = readFileSync(join(HERE, "..", "publish-flow.mjs"), "utf8");
  assert.match(helper, /AbortSignal\.timeout\(20_000\)/, "every live fetch is bounded");
  assert.match(publish, /exec node tools\/dive-analytics\/publish-flow\.mjs/, "the shell cannot mask the checked release flow");
  assert.doesNotMatch(flow, /skipping deploy/, "an unchanged Git tree cannot bypass production repair");
  assert.match(flow, /vercel[\s\S]+checkLiveParity/, "the release proves exact live bytes after deployment");
}

{
  const root = mkdtempSync(join(tmpdir(), "dive-live-parity."));
  try {
    for (const [file, content] of Object.entries(fixture)) writeFileSync(join(root, file), content);
    mkdirSync(join(root, "transcripts"));
    writeFileSync(join(root, transcriptFile), transcriptBytes);
    const complete = { ...fixture, [transcriptFile]: transcriptBytes };
    const requested = [];
    const fetchFrom = (files) => async (url) => {
      const file = decodeURIComponent(new URL(url).pathname.slice(1));
      requested.push(file);
      if (!(file in files)) return { ok: false, status: 404 };
      const content = files[file];
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
        },
      };
    };

    const exact = await checkLiveParity({ root, fetchImpl: fetchFrom(complete) });
    assert.equal(exact.ok, true);
    assert.equal(exact.checked, PARITY_ARTIFACTS.length + 1);
    assert.ok(requested.includes(transcriptFile), "a data-declared transcript must be fetched for production parity");

    const missingTranscript = { ...complete };
    delete missingTranscript[transcriptFile];
    const missing = await checkLiveParity({ root, fetchImpl: fetchFrom(missingTranscript) });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.mismatches.find((item) => item.file === transcriptFile), { file: transcriptFile, reason: "HTTP 404" });

    const different = await checkLiveParity({
      root,
      fetchImpl: fetchFrom({ ...complete, [transcriptFile]: Buffer.from("different live transcript\n") }),
    });
    assert.equal(different.ok, false);
    assert.equal(different.mismatches.find((item) => item.file === transcriptFile)?.reason, "bytes differ");

    const result = await checkLiveParity({
      root,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(result.mismatches.length, PARITY_ARTIFACTS.length + 1, "one failed fetch produces one finding per file, including transcripts");
    assert.ok(result.mismatches.every((item) => item.reason === "HTTP 500"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

console.log("live-parity.test: eight core artifacts and data-declared transcripts are fetched and byte-checked; missing, changed, and failed live files are rejected");
