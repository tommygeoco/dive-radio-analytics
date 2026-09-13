#!/usr/bin/env node
// Model-backed bridge from private source capture to public audience feedback.
// Only high-confidence, independently sampled, relevant labels may leave the archive.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ARCHIVE } from './comments-archive.mjs';
import { classifyAudienceBatch, CLASSIFIER_VERSION, PROMPT_VERSION } from './comments-classify.mjs';
import { atomicWriteJson, readJsonFile, withSourceLock } from '../../tools/dive-analytics/source-io.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOSTS = new Set(['designertom', 'ridd_design']);
const CONTRACT = { classifierVersion: CLASSIFIER_VERSION, promptVersion: PROMPT_VERSION, promptHash: createHash('sha256').update(readFileSync(new URL('./comments-classify-prompt.md', import.meta.url))).digest('hex') };
export const supportedAudienceConfig = (config, contract = CONTRACT) => config && ['classifierVersion', 'promptVersion', 'promptHash'].every(key => config[key] === contract[key]);
const DIRECTIONAL = new Set(['positive', 'negative', 'mixed']);
export const textHash = text => createHash('sha256').update(text).digest('hex');
export function eligibleAudienceRecord(row) {
  return row && typeof row.id === 'string' && typeof row.text === 'string' && row.text.trim().length > 0
    && ['x', 'live-chat'].includes(row.source)
    && !(row.source === 'x' && HOSTS.has(String(row.author || '').replace(/^@/, '').toLowerCase()));
}
function chatUrl(row, show) {
  if (/^linkedin$/i.test(row.platform || '')) return show.linkedin?.url || null;
  const channel = String(row.channel || '').toLowerCase();
  const account = /dive club/.test(channel) ? 'joindiveclub' : /tommy|designertom/.test(channel) ? 'designertom' : /ridd/.test(channel) ? 'ridd_design' : null;
  const kind = /youtube/i.test(row.platform || '') ? 'youtube' : /^x$/i.test(row.platform || '') ? 'x' : null;
  return show.targets?.find(t => t.account === account && t.kind === kind && t.role !== 'promo')?.url || null;
}
export function publicAudienceStore(archives, labels, configurations, shows, now, contract = CONTRACT) {
  const episodes = {}; const usedConfigurations = {};
  for (const archive of archives) {
    const show = shows.find(s => s.slug === archive.slug);
    if (!show) continue;
    const sources = Object.fromEntries((archive.captures || []).map(c => [c.source.startsWith('chat:') ? 'live-chat' : c.source, { state: c.state, checkedAt: c.pulledAt }]));
    const eligible = archive.records.filter(eligibleAudienceRecord);
    const processing = { pending: eligible.filter(r => !labels[r.id] || labels[r.id].contentHash !== textHash(r.text) || !supportedAudienceConfig(configurations[labels[r.id].configHash], contract)).length, review: eligible.filter(r => labels[r.id]?.state === 'review').length };
    const list = [];
    for (const row of archive.records) {
      const label = labels[row.id];
      const config = configurations[label?.configHash];
      if (!eligibleAudienceRecord(row) || !label || label.state !== 'ready' || label.confidence < 0.8 || label.relevance !== 'feedback' || !DIRECTIONAL.has(label.sentiment)
        || label.contentHash !== textHash(row.text) || !supportedAudienceConfig(config, contract) || !config?.golden?.passed || config.golden.configHash !== label.configHash) continue;
      usedConfigurations[label.configHash] = config;
      list.push({
        id: row.id, source: row.source, author: row.author || 'Viewer', text: row.text,
        platform: row.source === 'x' ? 'X' : row.platform || null, channel: row.channel || null,
        at: row.publishedAt, url: row.source === 'x' ? `https://x.com/i/status/${row.id.slice(2)}` : chatUrl(row, show),
        likes: Number.isInteger(row.metrics?.like_count) ? row.metrics.like_count : null,
        capturedAt: row.firstSeenAt, contentHash: label.contentHash,
        label: { state: label.state, relevance: label.relevance, sentiment: label.sentiment, themes: label.themes, confidence: label.confidence, configHash: label.configHash, classifiedAt: label.classifiedAt },
      });
    }
    episodes[archive.slug] = { sources, processing, list };
  }
  return { version: 1, updatedAt: now, configurations: usedConfigurations, episodes };
}
export async function runAudienceFeedback({ root = ROOT, archive = ARCHIVE, now = new Date().toISOString(), maxBatches = 12, batchSize = 40, concurrency = 2, budgetMs = 300000, classify = classifyAudienceBatch, log = console.log } = {}) {
  if (!existsSync(archive)) throw new Error('Audience source archive is missing');
  const registry = readJsonFile(join(root, 'data/restream/postlive-registry.json'));
  const archives = readdirSync(archive).filter(f => f.endsWith('.json') && f.includes('dive-radio')).sort().reverse()
    .map(f => readJsonFile(join(archive, f)));
  if (!archives.length) throw new Error('No captured audience episodes are available');
  const path = join(archive, 'audience-labels.json');
  return withSourceLock(path, async () => {
    const store = readJsonFile(path, { fallback: { version: 1, labels: {}, configurations: {} } });
    if (store.version !== 1 || !store.labels || !store.configurations) throw new Error('Audience label store is invalid');
    const records = [...new Map(archives.flatMap(a => a.records.filter(eligibleAudienceRecord)).map(row => [row.id, row])).values()];
    const pending = records.filter(row => !store.labels[row.id] || store.labels[row.id].contentHash !== textHash(row.text) || !supportedAudienceConfig(store.configurations[store.labels[row.id].configHash]));
    let added = 0; let failure = null; let diagnostic = null;
    const deadline = Date.now() + budgetMs;
    const publishApproved = () => atomicWriteJson(join(root, 'data/restream/audience-feedback.json'), publicAudienceStore(archives, store.labels, store.configurations, registry.shows, now));
    for (let batch = 0; batch < maxBatches && batch * batchSize < pending.length; batch += concurrency) {
      if (Date.now() >= deadline) break;
      const inputs = Array.from({ length: Math.min(concurrency, maxBatches - batch) }, (_, index) => pending.slice((batch + index) * batchSize, (batch + index + 1) * batchSize)).filter(input => input.length);
      const results = await Promise.allSettled(inputs.map(input => classify(input, { now, goldenStorePath: join(root, 'data/restream/comments-classified.json') })));
      for (const [index, settled] of results.entries()) {
      const input = inputs[index];
      try {
        if (settled.status !== 'fulfilled') throw settled.reason;
        const result = settled.value;
        const byId = new Map(input.map(row => [row.id, row]));
        if (!supportedAudienceConfig(result.config) || !result.config?.golden?.passed || result.config.golden.configHash !== result.config.configHash || !Array.isArray(result.labels) || result.labels.length !== input.length || new Set(result.labels.map(row => row.id)).size !== input.length || result.labels.some(row => !byId.has(row.id))) throw new Error('Audience classifier returned incomplete labels');
        store.configurations[result.config.configHash] = result.config;
        for (const label of result.labels) {
          const prior = store.labels[label.id];
          if (prior) { store.superseded ||= []; store.superseded.push({ id: label.id, ...prior, supersededAt: now }); }
          store.labels[label.id] = { ...label, configHash: result.config.configHash, contentHash: textHash(byId.get(label.id).text) };
        }
        added += input.length;
        atomicWriteJson(path, store, { mode: 0o600 });
        publishApproved();
        log(`audience feedback: labeled ${added}/${pending.length} new source records`);
      } catch (error) { failure = 'Audience classification did not complete; previous approved feedback retained'; diagnostic = String(error.message).replace(/https?:\/\/\S+/g, '[url]').slice(0, 200); }
      }
      if (failure) break;
    }
    const remaining = pending.length - added;
    store.lastRun = { at: now, state: failure || remaining ? 'pending' : 'ready', added, remaining, ...(diagnostic ? { diagnostic } : {}) };
    atomicWriteJson(path, store, { mode: 0o600 });
    const output = publicAudienceStore(archives, store.labels, store.configurations, registry.shows, now);
    atomicWriteJson(join(root, 'data/restream/audience-feedback.json'), output);
    log(`audience feedback: ${Object.values(output.episodes).reduce((n, e) => n + e.list.length, 0)} approved comments for the dashboard; ${remaining} pending`);
    if (failure || remaining) throw new Error(failure ? `${failure}: ${diagnostic}` : `${remaining} audience records remain for the next classification run`);
    return output;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAudienceFeedback({ maxBatches: process.argv.includes('--all') ? 50 : 12, budgetMs: process.argv.includes('--all') ? 3600000 : 300000 }).catch(error => { console.error(error.message); process.exitCode = 1; });
