#!/usr/bin/env node
// Registers exact Restream destinations and imports optional owner observations.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readLinkedinSources, validateMetricImport, validateLinkedinStore } from '../../tools/dive-analytics/linkedin.mjs';
import { atomicWriteJson, withSourceLock } from '../../tools/dive-analytics/source-io.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function syncLinkedin({ root = ROOT, inbox = join(homedir(), 'Library/Application Support/Dive Radio Analytics/linkedin-imports'), now = Date.now() } = {}) {
  const path = join(root, 'data/restream/postlive-registry.json');
  return withSourceLock(path, async () => {
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    const { discovered } = readLinkedinSources(root, registry.shows);
    const metricsPath = join(root, 'data/restream/linkedin-metrics.json');
    const store = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf8')) : { version: 1, episodes: {} };
    validateLinkedinStore(store, discovered, now);
    let added = 0;
    for (const filename of existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith('.json')).sort() : []) {
      const bytes = readFileSync(join(inbox, filename));
      const input = JSON.parse(bytes);
      const reading = validateMetricImport(input, discovered[input.slug], now);
      const source = discovered[input.slug];
      const entry = store.episodes[input.slug] ||= { urn: source.urn, readings: [] };
      if (entry.urn !== source.urn) throw new Error('LinkedIn import broadcast identity changed');
      const existing = entry.readings.find(r => r.observedAt === reading.observedAt);
      if (existing) {
        if (JSON.stringify(existing.metrics) !== JSON.stringify(reading.metrics) || existing.source !== reading.source) throw new Error('Conflicting LinkedIn observation; preserve the original and use a new observation time');
        continue;
      }
      entry.readings.push({ ...reading, importedAt: new Date(now).toISOString(), evidenceSha256: createHash('sha256').update(bytes).digest('hex') });
      entry.readings.sort((a,b) => a.observedAt.localeCompare(b.observedAt)); added++;
    }
    for (const show of registry.shows) if (discovered[show.slug]) {
      if (show.linkedin && show.linkedin.urn !== discovered[show.slug].urn) throw new Error('Registered LinkedIn broadcast changed');
      show.linkedin = discovered[show.slug];
    }
    validateLinkedinStore(store, discovered, now);
    // Validate the entire input batch before either public source store advances.
    if (added) atomicWriteJson(metricsPath, store);
    atomicWriteJson(path, registry);
    console.log(`LinkedIn: ${Object.keys(discovered).length} registered broadcasts; ${added} owner observations imported; API access not connected`);
    return { discovered, added };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncLinkedin().catch(e => { console.error(e.message); process.exitCode = 1; });
