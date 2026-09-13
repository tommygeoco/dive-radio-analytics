#!/usr/bin/env node
// Verify a committed candidate in a disposable checkout. Caller files are never rebuilt or restored.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Git hooks export repository-local variables. Child checkouts must resolve
// their own .git directory; otherwise scratch checkout can detach the caller.
export function isolatedGitEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_IMPLICIT_WORK_TREE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE']) delete result[key];
  return result;
}
export function checkedCommand(executable, args, { cwd, timeout = 120_000, env = process.env } = {}) {
  const r = spawnSync(executable, args, { cwd, env: isolatedGitEnvironment(env), encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.signal || r.status !== 0) {
    const detail = r.error?.code || r.signal || `exit ${r.status ?? 'missing'}`;
    // Commands can include source credentials in diagnostics. Never include arguments or raw output here.
    throw new Error(`${executable.split('/').at(-1)} failed (${detail})`);
  }
  return r.stdout;
}

function walk(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(root, join(path, e.name)) : [join(path, e.name)]);
}
export function assertSourceOnlyCandidate(root, revision, base = 'origin/main') {
  checkedCommand('git', ['merge-base', '--is-ancestor', base, revision], { cwd: root });
  const paths = checkedCommand('git', ['diff', '--name-only', '-z', base, revision, '--'], { cwd: root }).split('\0').filter(Boolean);
  if (!paths.length || paths.some(path => !/^(scripts\/|tools\/|docs\/|(?:README|CLAUDE|ARCHITECTURE)\.md$)/.test(path))) {
    throw new Error('source-only adoption requires code/docs changes and identical source stores and served artifacts');
  }
  return paths;
}

export function verifyCheckout(root, { run = checkedCommand, log = console.log, sourceOnly = false } = {}) {
  const node = process.execPath;
  const invoke = (args, timeout) => run(node, args, { cwd: root, timeout });
  // Validate the exact committed bytes before rebuilding this disposable copy.
  // Otherwise a build could repair a broken candidate only inside the gate.
  let validation = 'source-only adoption: data is unchanged; production validation remains required before publishing';
  if (!sourceOnly) {
    invoke(['tools/dive-analytics/audit/validate.mjs'], 180_000);
    invoke(['tools/dive-analytics/ratings.mjs']);
    invoke(['tools/dive-analytics/build-data.mjs']);
    validation = invoke(['tools/dive-analytics/audit/validate.mjs'], 180_000);
  }
  const files = walk(root, 'tools/dive-analytics/audit').filter(f => f.endsWith('.test.mjs')).sort();
  for (const file of files) { invoke([file], 180_000); log(`release-gate: passed ${file.split('/').at(-1)}`); }
  const scripts = [...walk(root, 'tools'), ...walk(root, 'scripts')].filter(f => /\.(mjs|js|sh)$/.test(f));
  for (const file of scripts) {
    if (file.endsWith('.sh')) run('sh', ['-n', file], { cwd: root });
    else if (file.endsWith('.js') && file.includes('cron')) new (Object.getPrototypeOf(async function() {}).constructor)('exec', readFileSync(join(root, file), 'utf8'));
    else invoke(['--check', file]);
  }
  let inlineScripts = 0;
  for (const file of ['index.html', 'agents.html']) {
    if (!existsSync(join(root, file))) continue;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc=|application\/ld\+json|application\/json/i.test(match[1])) continue;
      new vm.Script(match[2], { filename: file }); inlineScripts++;
    }
  }
  const summary = sourceOnly ? validation : validation.trim().split('\n').filter(l => /failure\(s\)|drift\(s\)/.test(l)).at(-1) || 'validator exited 0';
  log(`release-gate: ${files.length} audit files; ${scripts.length} script syntax checks; ${inlineScripts} page scripts; ${summary}`);
  return { tests: files.length, syntax: scripts.length, inlineScripts, validation: summary };
}

export function verifyCandidate({ root = ROOT, revision = 'HEAD', log = console.log, sourceOnly = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'dive-release-gate-'));
  try {
    const sha = checkedCommand('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root }).trim();
    if (sourceOnly) assertSourceOnlyCandidate(root, sha);
    checkedCommand('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', root, scratch]);
    checkedCommand('git', ['checkout', '--quiet', '--detach', sha], { cwd: scratch });
    return { sha, ...verifyCheckout(scratch, { log, sourceOnly }) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { verifyCandidate({ sourceOnly: process.argv.includes('--source-only') }); } catch (e) { console.error(`release-gate: ${e.message}`); process.exitCode = 1; }
}
