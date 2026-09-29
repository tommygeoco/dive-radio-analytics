process.env.DIVE_MODEL_TRANSPORT = "api"; // Anthropic API path with an intercepted network.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// A model configuration earns the store only by passing the golden gate. A
// failing gate must leave the last passing stamps and labels byte-identical
// (on 2026-09-28 a failed gate was stamped onto the store and blocked every
// publish for two days) and must name the comments left waiting.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "dive-classifier-golden-")));
const root = join(temp, "repo");
try {
  execFileSync("git", ["clone", "--quiet", "--shared", ROOT, root]);
  cpSync(join(ROOT, "tools"), join(root, "tools"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(root, "scripts"), { recursive: true });
  const storePath = join(root, "data/restream/comments-classified.json");
  const golden = JSON.parse(readFileSync(join(root, "tools/dive-analytics/audit/golden-comments.json"), "utf8")).cases;
  const expected = Object.fromEntries(golden.map((c) => [c.text, c.expected]));
  writeFileSync(join(temp, "golden.json"), JSON.stringify(expected));
  const preload = join(temp, "model-stub.mjs");
  writeFileSync(preload, `import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync(${JSON.stringify(join(temp, "golden.json"))}, 'utf8'));
globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('unexpected request');
  const body = JSON.parse(options.body);
  if (body.model !== 'claude-sonnet-5-5') throw new Error('wrong model');
  const { comments } = JSON.parse(body.messages[0].content);
  const classifications = comments.map(({ id, text }) => {
    const want = expected[text];
    if (!want) return { id, relevance: 'feedback', sentiment: 'positive', themes: ['other'], confidence: 0.95 };
    const sentiment = want.relevance === 'noise' ? 'neutral' : process.env.DIVE_FIXTURE_MODE === 'fail' ? 'neutral' : want.sentiment;
    const themes = want.relevance === 'noise' || sentiment === 'neutral' ? [] : ['other'];
    return { id, relevance: want.relevance, sentiment, themes, confidence: 0.95 };
  });
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ classifications }) }] }) };
};\n`);
  const run = (mode) => spawnSync(process.execPath, ["--import", preload, join(root, "scripts/restream/comments-classify.mjs")], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "fixture-only", DIVE_FIXTURE_MODE: mode },
  });

  const before = JSON.parse(readFileSync(storePath, "utf8"));
  const waiting = JSON.parse(execFileSync("node", ["-e", `
    const { readdirSync, readFileSync } = require('node:fs');
    const dir = ${JSON.stringify(join(root, "data/restream/comments"))};
    const labels = JSON.parse(readFileSync(${JSON.stringify(storePath)}, 'utf8')).classified;
    const ids = readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(readFileSync(dir + '/' + f, 'utf8')).comments || []).map((c) => c.id).filter((id) => !labels[id]);
    console.log(JSON.stringify(ids.sort()));`], { encoding: "utf8" }));
  const stamps = (s) => JSON.stringify({ provider: s.provider, model: s.model, promptVersion: s.promptVersion, promptHash: s.promptHash, configHash: s.configHash, golden: s.golden, classified: s.classified });

  const failed = run("fail");
  assert.equal(failed.status, 1, `a failing golden gate must fail the step: ${failed.stdout}${failed.stderr}`);
  assert.match(failed.stderr + failed.stdout, /golden gate failed .*previous classifier configuration kept/);
  const afterFail = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(stamps(afterFail), stamps(before), "a failing configuration never replaces the last passing one");
  assert.equal(afterFail.lastRun.status, "pending");
  assert.deepEqual([...afterFail.lastRun.pendingIds].sort(), waiting, "the waiting comments are named");

  const passed = run("pass");
  assert.equal(passed.status, 0, `a passing golden gate must label: ${passed.stdout}${passed.stderr}`);
  const afterPass = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(afterPass.provider, "anthropic");
  assert.equal(afterPass.model, "claude-sonnet-5-5");
  assert.equal(afterPass.golden.passed, true);
  assert.equal(afterPass.golden.relevance.pct, 100);
  assert.equal(afterPass.lastRun.status, "complete");
  for (const id of waiting) assert.equal(afterPass.classified[id]?.model, "claude-sonnet-5-5", `${id} labelled by the gated model`);
  for (const [id, label] of Object.entries(before.classified)) assert.deepEqual(afterPass.classified[id], label, `${id} keeps its earlier label (append-only)`);
  console.log(`classifier-golden: failing gate keeps the proven store and names ${waiting.length} waiting comment(s); passing gate stamps Sonnet 5.5 and labels them append-only`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
