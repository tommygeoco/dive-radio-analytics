#!/usr/bin/env node
// Verify a committed candidate in a disposable checkout. Caller files are never rebuilt or restored.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function checkedCommand(executable, args, { cwd, timeout = 120_000, env = process.env } = {}) {
  const r = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
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
export function verifyCheckout(root, { run = checkedCommand, log = console.log } = {}) {
  const node = process.execPath;
  const invoke = (args, timeout) => run(node, args, { cwd: root, timeout });
  invoke(['tools/dive-analytics/ratings.mjs']);
  invoke(['tools/dive-analytics/build-data.mjs']);
  const validation = invoke(['tools/dive-analytics/audit/validate.mjs'], 180_000);
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
  const summary = validation.trim().split('\n').filter(l => /failure\(s\)|drift\(s\)/.test(l)).at(-1) || 'validator exited 0';
  log(`release-gate: ${files.length} audit files; ${scripts.length} script syntax checks; ${inlineScripts} page scripts; ${summary}`);
  return { tests: files.length, syntax: scripts.length, inlineScripts, validation: summary };
}

export function verifyCandidate({ root = ROOT, revision = 'HEAD', log = console.log } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'dive-release-gate-'));
  try {
    const sha = checkedCommand('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root }).trim();
    checkedCommand('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', root, scratch]);
    checkedCommand('git', ['checkout', '--quiet', '--detach', sha], { cwd: scratch });
    return { sha, ...verifyCheckout(scratch, { log }) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { verifyCandidate(); } catch (e) { console.error(`release-gate: ${e.message}`); process.exitCode = 1; }
}
