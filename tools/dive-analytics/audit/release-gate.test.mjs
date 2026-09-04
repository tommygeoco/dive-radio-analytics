import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyCandidate, checkedCommand } from '../release-gate.mjs';

const root = mkdtempSync(join(tmpdir(), 'dive-gate-fixture-'));
const run = (exe, args) => checkedCommand(exe, args, { cwd: root });
try {
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 'fixture@example.test']);
  run('git', ['config', 'user.name', 'Fixture']);
  mkdirSync(join(root, 'tools/dive-analytics/audit'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/.keep'), 'fixture');
  writeFileSync(join(root, 'tools/dive-analytics/ratings.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('ratings-output','called');\n");
  writeFileSync(join(root, 'tools/dive-analytics/build-data.mjs'), "import{writeFileSync,readFileSync}from'node:fs';if(readFileSync('ratings-output','utf8')!=='called')process.exit(2);writeFileSync('data.json','rebuilt');\n");
  writeFileSync(join(root, 'tools/dive-analytics/audit/validate.mjs'), "import{readFileSync}from'node:fs';if(readFileSync('data.json','utf8')!=='rebuilt')process.exit(3);\n");
  writeFileSync(join(root, 'tools/dive-analytics/audit/one.test.mjs'), "import{readFileSync}from'node:fs';if(readFileSync('data.json','utf8')!=='rebuilt')process.exit(4);\n");
  writeFileSync(join(root, 'data.json'), 'rebuilt');
  run('git', ['add', '--all']); run('git', ['commit', '-qm', 'fixture']);
  writeFileSync(join(root, 'data.json'), 'user data');
  writeFileSync(join(root, 'agent.md'), 'user untracked');
  const before = run('git', ['status', '--porcelain']);
  const good = verifyCandidate({ root, log: () => {} });
  assert.equal(good.tests, 1);
  assert.equal(good.syntax, 4);
  assert.equal(readFileSync(join(root, 'data.json'), 'utf8'), 'user data');
  assert.equal(readFileSync(join(root, 'agent.md'), 'utf8'), 'user untracked');
  assert.equal(run('git', ['status', '--porcelain']), before);
  writeFileSync(join(root, 'data.json'), 'broken committed artifact');
  run('git', ['add', '--', 'data.json']); run('git', ['commit', '-qm', 'broken candidate fixture']);
  assert.throws(() => verifyCandidate({ root, log: () => {} }), /failed/);
  writeFileSync(join(root, 'data.json'), 'rebuilt');
  run('git', ['add', '--', 'data.json']); run('git', ['commit', '-qm', 'restore candidate fixture']);
  writeFileSync(join(root, 'data.json'), 'user data');
  for (const [path, code] of [['tools/dive-analytics/build-data.mjs', 7], ['tools/dive-analytics/audit/validate.mjs', 8], ['tools/dive-analytics/audit/one.test.mjs', 9]]) {
    const prior = readFileSync(join(root, path));
    writeFileSync(join(root, path), `process.exit(${code});\n`);
    run('git', ['add', '--', path]); run('git', ['commit', '-qm', 'negative fixture']);
    assert.throws(() => verifyCandidate({ root, log: () => {} }), /failed/);
    assert.equal(readFileSync(join(root, 'data.json'), 'utf8'), 'user data');
    writeFileSync(join(root, path), prior);
    run('git', ['add', '--', path]); run('git', ['commit', '-qm', 'restore fixture']);
  }
  assert.throws(() => checkedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 40 }), /ETIMEDOUT/);
  assert.throws(() => checkedCommand(process.execPath, ['-e', 'process.kill(process.pid,"SIGKILL")']), /SIGKILL/);
  assert.throws(() => checkedCommand('/does-not-exist', []), /ENOENT/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('release-gate: committed candidate isolation, caller byte preservation, every audit, build/validator/test failure, timeout/signal/missing status pass');
