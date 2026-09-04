import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Exercise the real CLI exit path with isolated stores and an intercepted
// network. No model, credentials, or canonical store can be touched.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dive-model-failures-')));
const root = join(temp, 'repo');
try {
  execFileSync('git', ['clone', '--quiet', '--shared', ROOT, root]);
  cpSync(join(ROOT, 'tools'), join(root, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'data.json'), join(root, 'data.json'));
  const load = (name) => readFileSync(join(root, 'data/restream', name), 'utf8');
  const save = (name, value) => writeFileSync(join(root, 'data/restream', name), JSON.stringify(value, null, 2) + '\n');
  const countPath = join(temp, 'calls');
  const preload = join(temp, 'model-stub.mjs');
  writeFileSync(preload, `import { appendFileSync, readFileSync } from 'node:fs';
  globalThis.fetch = async (_url, options) => {
    appendFileSync(process.env.DIVE_FIXTURE_CALLS, 'call\\n');
    if (process.env.DIVE_FIXTURE_MODE === 'mixed-chapters') {
      const fixture = JSON.parse(readFileSync(process.env.DIVE_FIXTURE_CHAPTERS, 'utf8'));
      if (JSON.parse(options.body).messages[0].content.startsWith('Episode: ' + fixture.title + '\\n')) return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ chapters: fixture.chapters }) }] }) };
      throw new Error('fixture model request failed for another episode');
    }
    if (process.env.DIVE_FIXTURE_MODE === 'request') throw new Error('fixture model request failed');
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: process.env.DIVE_FIXTURE_MODE === 'invalid-json' ? 'not valid JSON' : JSON.stringify({ summaries: {}, chapters: [{ start: '99:99', title: 'Fixture', gist: 'This cannot ground.', quote: 'fictional quote' }], items: [{ id: 'fixture' }] }) }] }) };
  };\n`);
  const run = (script, args = [], mode = 'request') => {
    writeFileSync(countPath, '');
    const result = spawnSync(process.execPath, ['--import', preload, join(root, 'tools/dive-analytics', script), ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-only', HEALTH_MODEL: 'fixture-model', DIVE_FIXTURE_CALLS: countPath, DIVE_FIXTURE_MODE: mode, DIVE_FIXTURE_CHAPTERS: join(temp, 'chapters-fixture.json') },
    });
    const calls = readFileSync(countPath, 'utf8').split('\n').filter(Boolean).length;
    return { ...result, calls };
  };
  const originalChapters = JSON.parse(load('chapters.json'));
  const cases = [
    ['health.mjs', 'health-history.json', 'entries', []],
    ['moment-summaries.mjs', 'moment-summaries.json', 'entries', {}],
    ['chapters.mjs', 'chapters.json', 'entries', {}],
  ];
  for (const [script, storeName, field, empty] of cases) {
    const store = JSON.parse(load(storeName));
    store[field] = empty;
    save(storeName, store);
    const before = load(storeName);
    for (const mode of ['request', 'invalid-json', 'ungrounded']) {
      const result = run(script, [], mode);
      assert.equal(result.status, 1, `${script} ${mode} must fail: ${result.stdout} ${result.stderr}`);
      assert.ok(result.calls > 0, `${script} must reach the injected model`);
      if (script !== 'chapters.mjs') assert.ok(result.calls <= 2, `${script} must stop after one retry`);
      assert.equal(load(storeName), before, `${script} ${mode} must preserve the previous store bytes`);
      assert.equal(existsSync(join(root, 'data/restream', `${storeName}.lock.tmp`)), false, 'source lock must be released after failure');
    }
  }
  for (const mode of ['request', 'invalid-json', 'ungrounded']) {
    const result = run('recommendations.mjs', [], mode);
    assert.equal(result.status, 1, `recommendation ${mode} must fail after pruning: ${result.stdout} ${result.stderr}`);
    assert.ok(result.calls > 0 && result.calls <= 2, 'recommendations have one retry at most');
    assert.equal(run('recommendations.mjs', ['--prune']).status, 0, 'the deterministic prune remains an intentional successful action');
  }
  const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf8'));
  const success = data.episodes.find((episode) => originalChapters.entries[episode.slug]?.status === 'complete');
  assert.ok(success, 'fixture needs one existing grounded chapter list');
  writeFileSync(join(temp, 'chapters-fixture.json'), JSON.stringify({title:success.title,chapters:originalChapters.entries[success.slug].chapters}));
  save('chapters.json',{...originalChapters,entries:{}});
  const mixed = run('chapters.mjs', [], 'mixed-chapters');
  assert.equal(mixed.status, 1, 'a mixed batch must report its failed episodes');
  const saved = JSON.parse(load('chapters.json'));
  assert.deepEqual(Object.keys(saved.entries), [success.slug], `only the grounded candidate should be promoted: ${mixed.stdout} ${mixed.stderr}`);
  // Explicit diagnostic and no-input paths retain their normal successful exit.
  const checked = run('moment-summaries.mjs', ['--check']);
  assert.equal(checked.status, 0); assert.equal(checked.calls, 0);
  const noTranscript = run('chapters.mjs', ['--only', 'fixture-does-not-exist']);
  assert.equal(noTranscript.status, 0); assert.equal(noTranscript.calls, 0);
  console.log('model-failures.test: request/JSON/grounding failures exit nonzero, old stores survive, locks release, safe skips stay successful');
} finally { rmSync(temp, { recursive: true, force: true }); }
