import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { phoenixDateKey } from '../source-io.mjs';

// Exercise actual CLI exits against disposable stores and a network stub.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dive-verification-failures-')));
const root = join(temp, 'repo');
try {
  execFileSync('git', ['clone', '--quiet', '--shared', ROOT, root]);
  cpSync(join(ROOT, 'tools'), join(root, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'data.json'), join(root, 'data.json'));
  const countPath = join(temp, 'calls');
  const preload = join(temp, 'model-stub.mjs');
  const report = Array.from({ length: 5 }, (_, index) => `## ${index + 1}. Lens\n- PASS — Fixture evidence.`).join('\n')
    + '\n## Verdict\nFixture complete.\n## The one recommendation\nnone — ship as is';
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (_url, options) => {
  appendFileSync(process.env.DIVE_FIXTURE_CALLS, 'call\\n');
  if (!options.signal) throw new Error('deadline absent');
  const mode = process.env.DIVE_FIXTURE_MODE;
  if (mode === 'request') throw new Error('fixture-secret-response');
  if (mode === 'http') return {ok:false,status:401,text:async()=> 'fixture-secret-response'};
  if (mode === 'json') return {ok:true,json:async()=>{throw new Error('fixture-secret-response')}};
  return {ok:true,json:async()=>({stop_reason:mode==='truncated'?'max_tokens':'end_turn',content:[{type:'text',text:mode==='invalid'?'unfinished':${JSON.stringify(report)}}]})};
};\n`);
  const run = (script, args = [], mode = 'request') => {
    writeFileSync(countPath, '');
    const result = spawnSync(process.execPath, ['--import', preload, join(root, 'tools/dive-analytics', script), ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ANTHROPIC_API_KEY: mode === 'missing-key' ? '' : 'fixture-only', DIVE_FIXTURE_CALLS: countPath, DIVE_FIXTURE_MODE: mode },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { ...result, calls: readFileSync(countPath, 'utf8').split('\n').filter(Boolean).length };
  };
  const criticPath = join(root, 'tools/dive-analytics/audit', `CRITIC-${phoenixDateKey()}-FIXTURE.md`);
  writeFileSync(criticPath, 'prior complete report\n');
  for (const mode of ['request', 'http', 'json', 'truncated', 'invalid', 'missing-key']) {
    const result = run('critic.mjs', ['--tag', 'FIXTURE'], mode);
    assert.equal(result.status, 1, `critic ${mode}: ${result.stdout} ${result.stderr}`);
    assert.equal(result.calls, mode === 'missing-key' ? 0 : 2);
    assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret-response|fixture-only|did not run/);
    assert.equal(readFileSync(criticPath, 'utf8'), 'prior complete report\n');
    assert.equal(existsSync(`${criticPath}.lock.tmp`), false);
  }
  const good = run('critic.mjs', ['--tag', 'FIXTURE'], 'ready');
  assert.equal(good.status, 0, good.stderr); assert.equal(good.calls, 1);
  assert.ok(readFileSync(criticPath, 'utf8').endsWith(report + '\n'));
  const dry = run('critic.mjs', ['--dry']); assert.equal(dry.status, 0); assert.equal(dry.calls, 0);

  const healthPath = join(root, 'data/restream/health-history.json');
  const dataPath = join(root, 'data.json');
  const ledgerPath = join(root, 'data/restream/health-verify.json');
  const feedbackPath = join(root, 'data/restream/health-feedback.jsonl');
  const verifyPath = join(root, 'tools/dive-analytics/audit/HEALTH-VERIFY.md');
  const originals = new Map([healthPath, dataPath, ledgerPath, feedbackPath, verifyPath].map((path) => [path, existsSync(path) ? readFileSync(path, 'utf8') : null]));
  const restore = () => { for (const [path, text] of originals) text == null ? rmSync(path, { force: true }) : writeFileSync(path, text); };
  const brokenCases = [
    () => { const store = JSON.parse(originals.get(healthPath)); store.entries.at(-1).score = store.entries.at(-1).weightedMean + 20; writeFileSync(healthPath, JSON.stringify(store)); },
    () => writeFileSync(healthPath, '{"entries":[]}'),
    () => writeFileSync(healthPath, '{"fixture-secret-response"'),
    () => writeFileSync(ledgerPath, '{"fixture-secret-response"'),
    () => writeFileSync(feedbackPath, '{"fixture-secret-response"'),
    () => { const data = JSON.parse(originals.get(dataPath)); data.generatedAt = 'invalid'; writeFileSync(dataPath, JSON.stringify(data)); },
  ];
  for (const mutate of brokenCases) {
    restore(); mutate();
    const before = readFileSync(ledgerPath, 'utf8');
    const failed = run('health-verify.mjs');
    assert.equal(failed.status, 1, `${failed.stdout} ${failed.stderr}`); assert.equal(failed.calls, 0);
    assert.doesNotMatch(failed.stderr + failed.stdout, /fixture-secret-response/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);
    assert.equal(readFileSync(verifyPath, 'utf8'), originals.get(verifyPath));
    assert.equal(existsSync(`${ledgerPath}.lock.tmp`), false);
  }
  restore();
  const verified = run('health-verify.mjs');
  assert.equal(verified.status, 0, `${verified.stdout} ${verified.stderr}`); assert.equal(verified.calls, 0);
  const resolved = JSON.parse(originals.get(ledgerPath)).claims.filter((claim) => claim.resolution);
  const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const claim of resolved) assert.deepEqual(saved.claims.find((row) => row.id === claim.id), claim, 'resolved claims are immutable');
  assert.match(readFileSync(verifyPath, 'utf8'), /invalid inputs or failed accuracy checks stop promotion/);
  console.log('verification-failures.test: bounded sanitized critic failures, malformed/truncated output, deterministic accuracy failure, preserved outputs, released locks and success pass');
} finally { rmSync(temp, { recursive: true, force: true }); }
