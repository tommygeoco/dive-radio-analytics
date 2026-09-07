import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCandidate, checkedCommand } from '../release-gate.mjs';
const root = mkdtempSync(join(tmpdir(), 'dive-source-adoption-'));
const run = (args) => checkedCommand('git', args, { cwd: root });
try {
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'Fixture']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(root, 'tools/dive-analytics/audit'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/fix.mjs'), 'export const fixed = false;\n');
  writeFileSync(join(root, 'tools/dive-analytics/audit/validate.mjs'), 'process.exit(1); // stale stored data\n');
  writeFileSync(join(root, 'tools/dive-analytics/audit/behavior.test.mjs'), 'process.exit(0);\n');
  writeFileSync(join(root, 'data.json'), '{"generatedAt":"old"}\n');
  run(['add', '--all']); run(['commit', '-qm', 'fixture']);
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(join(root, 'scripts/fix.mjs'), 'export const fixed = true;\n');
  run(['add', '--all']); run(['commit', '-qm', 'source repair']);
  assert.throws(() => verifyCandidate({ root, log: () => {} }), /failed/);
  assert.equal(verifyCandidate({ root, sourceOnly: true, log: () => {} }).tests, 1);
  for (const path of ['data.json', 'data/restream/state.json', 'index.html', 'agent.json', 'transcripts/show.txt', '.vercel/project.json']) {
    const before = run(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'changed');
    run(['add', '--all']); run(['commit', '-qm', 'forbidden fixture']);
    assert.throws(() => verifyCandidate({ root, sourceOnly: true, log: () => {} }), /identical source stores/);
    run(['reset', '--hard', before]); // disposable fixture only
  }
  writeFileSync(join(root, 'tools/dive-analytics/audit/behavior.test.mjs'), 'process.exit(7);\n');
  run(['add', '--all']); run(['commit', '-qm', 'failed test fixture']);
  assert.throws(() => verifyCandidate({ root, sourceOnly: true, log: () => {} }), /failed/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('source-only release: unchanged stored/public bytes, full tests, and mandatory production validation pass');
