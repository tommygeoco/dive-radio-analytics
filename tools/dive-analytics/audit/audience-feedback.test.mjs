import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { publicAudienceStore, eligibleAudienceRecord, textHash, runAudienceFeedback } from '../../../scripts/restream/audience-feedback.mjs';
import { audienceView } from '../audience-view.mjs';
import { validateAudienceStore } from '../audience-integrity.mjs';
import { THEME_VOCABULARY, CLASSIFIER_VERSION, PROMPT_VERSION } from '../../../scripts/restream/comments-classify.mjs';
const now = '2026-09-11T22:00:00Z';
const config = { classifierVersion: CLASSIFIER_VERSION, promptVersion: PROMPT_VERSION, promptHash: createHash('sha256').update(readFileSync(new URL('../../../scripts/restream/comments-classify-prompt.md', import.meta.url))).digest('hex'), model: 'fixture', provider: 'fixture' };
config.configHash = createHash('sha256').update(JSON.stringify({ version: CLASSIFIER_VERSION, promptVersion: PROMPT_VERSION, promptHash: config.promptHash, model: config.model, provider: config.provider, vocabulary: THEME_VOCABULARY })).digest('hex');
config.golden = { passed: true, configHash: config.configHash, relevance: { pct: 100 }, sentiment: { pct: 100 } };
const row = (id, text = 'Best episode ever!') => ({ id, text, source: id.startsWith('x:') ? 'x' : 'live-chat', author: 'Person 60', platform: 'YouTube', channel: 'Dive Club', publishedAt: now, firstSeenAt: now, raw: { private: 'must never leave archive' }, evidenceDirectory: '/private/path' });
const label = r => ({ id: r.id, contentHash: textHash(r.text), configHash: config.configHash, state: 'ready', confidence: 0.95, relevance: 'feedback', sentiment: 'positive', themes: ['other'], classifiedAt: now });
const slug = '2026-09-10-dive-radio-test';
const chatId = `chat:${'a'.repeat(64)}:1`;
const shows = [{ slug, targets: [{ kind: 'youtube', account: 'joindiveclub', url: 'https://www.youtube.com/watch?v=abc' }] }];
test('public bridge exports full approved text and provenance, excludes noise, review, uncertain and host rows', () => {
  const records = [row('x:123', 'A wonderful show. '.repeat(50)), row(chatId), { ...row('x:456'), author: '@designertom' }, row('x:789'), row('x:890'), row('x:901')];
  const labels = Object.fromEntries(records.map(r => [r.id, label(r)]));
  labels['x:789'].state = 'review'; labels['x:890'].relevance = 'noise'; labels['x:901'].confidence = 0.5;
  const out = publicAudienceStore([{ slug, records, captures: [] }], labels, { [config.configHash]: config }, shows, now);
  assert.equal(out.episodes[slug].list.length, 2); assert.equal(out.episodes[slug].list[0].text, records[0].text);
  assert.equal(out.episodes[slug].list[1].url, shows[0].targets[0].url);
  assert(!JSON.stringify(out).includes('/private/path')); assert(!JSON.stringify(out).includes('must never'));
  assert.deepEqual(validateAudienceStore(out), []);
  const tampered = structuredClone(out); tampered.episodes[slug].list[0].text += ' altered';
  assert(validateAudienceStore(tampered).some(error => error.includes('provenance')));
});
test('display merges by native ID, includes chat, keeps mixed reactions in both lists and leaves scored counts unchanged', () => {
  const scored = { uniqueCommenters: 1, list: [{ id: 'x:123', source: 'x', text: 'Original', author: 'viewer', sentiment: 'positive', at: now }, { id: 'yt:abc', source: 'yt', text: 'Great episode', author: 'viewer2', sentiment: 'positive', at: now }] };
  const before = structuredClone(scored);
  const records = [row('x:123'), row(chatId)]; const labels = Object.fromEntries(records.map(r => [r.id, label(r)])); labels[chatId].sentiment = 'mixed';
  const out = publicAudienceStore([{ slug, records, captures: [] }], labels, { [config.configHash]: config }, shows, now);
  const view = audienceView(scored, out.episodes[slug]);
  assert.equal(view.count, 3); assert.equal(view.positiveCount, 3); assert.equal(view.negativeCount, 1);
  assert(!view.featured.some(r => r.id === chatId)); assert.deepEqual(scored, before);
  assert.equal(view.list.find(r => r.id === 'x:123').text, records[0].text);
});
test('daily bridge persists labels, avoids repeated calls and preserves prior labels when source text changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audience-bridge-')); const archive = join(root, 'private');
  mkdirSync(join(root, 'data/restream'), { recursive: true }); mkdirSync(archive);
  writeFileSync(join(root, 'data/restream/postlive-registry.json'), JSON.stringify({ shows }));
  const source = { slug, records: [row('x:123')], captures: [] };
  const sourcePath = join(archive, `${slug}.json`); writeFileSync(sourcePath, JSON.stringify(source));
  let calls = 0;
  const classify = async rows => { calls++; return { config, labels: rows.map(label) }; };
  try {
    await runAudienceFeedback({ root, archive, now, classify, log: () => {} });
    await runAudienceFeedback({ root, archive, now, classify, log: () => {} });
    assert.equal(calls, 1);
    source.records[0].text = 'Changed to another meaning'; writeFileSync(sourcePath, JSON.stringify(source));
    await runAudienceFeedback({ root, archive, now, classify, log: () => {} });
    assert.equal(calls, 2);
    const labels = JSON.parse(readFileSync(join(archive, 'audience-labels.json')));
    assert.equal(labels.superseded.length, 1);
    const published = JSON.parse(readFileSync(join(root, 'data/restream/audience-feedback.json')));
    assert.equal(published.episodes[slug].list.length, 1);
    assert.equal(published.episodes[slug].list[0].text, source.records[0].text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source failures, staleness and pending classification remain visible with expanded feedback', () => {
  const archive = { list: [], sources: { x: { state: 'failed', checkedAt: now }, 'live-chat': { state: 'ready', checkedAt: '2026-09-01T12:00:00Z' } }, processing: { pending: 2, review: 1 } };
  const view = audienceView({ list: [] }, archive, { now: Date.parse(now), commentState: { state: 'failed' } });
  assert.equal(view.notices.length, 5);
  assert(view.notices.some(note => note.includes('over a day old')));
  assert(view.notices.some(note => note.includes('still being processed')));
});
test('unsupported old configurations are withheld and never poison the public configuration list', () => {
  const record = row('x:123'); const previous = { ...config, promptVersion: 0 };
  const labels = { [record.id]: label(record) };
  const output = publicAudienceStore([{ slug, records: [record], captures: [] }], labels, { [config.configHash]: previous }, shows, now);
  assert.deepEqual(output.configurations, {}); assert.equal(output.episodes[slug].processing.pending, 1); assert.equal(output.episodes[slug].list.length, 0);
});

test('approved LinkedIn feedback links to its registered broadcast and passes public provenance checks', () => {
  const record = { ...row(chatId), platform: 'LinkedIn', channel: 'Michael Riddering' };
  const linkedin = { url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:123456/' };
  const output = publicAudienceStore([{ slug, records: [record], captures: [] }], { [record.id]: label(record) }, { [config.configHash]: config }, [{ ...shows[0], linkedin }], now);
  assert.equal(output.episodes[slug].list[0].url, linkedin.url);
  assert.deepEqual(validateAudienceStore(output), []);
  output.episodes[slug].list[0].url = 'https://www.linkedin.com.evil.test/feed/update/urn:li:ugcPost:123456/';
  assert(validateAudienceStore(output).some(error => error.includes('provenance')));
});

test('targeted LinkedIn classification leaves unrelated historical records honestly pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audience-linkedin-')); const archive = join(root, 'private');
  mkdirSync(join(root, 'data/restream'), { recursive: true }); mkdirSync(archive);
  writeFileSync(join(root, 'data/restream/postlive-registry.json'), JSON.stringify({ shows }));
  const records = [{ ...row(chatId), platform: 'LinkedIn' }, row('x:123')];
  writeFileSync(join(archive, `${slug}.json`), JSON.stringify({ slug, records, captures: [] }));
  const requested = [];
  try {
    const output = await runAudienceFeedback({ root, archive, now, onlyPlatform: 'LinkedIn', classify: async rows => { requested.push(...rows.map(r => r.id)); return { config, labels: rows.map(label) }; }, log: () => {} });
    assert.deepEqual(requested, [chatId]);
    assert.equal(output.episodes[slug].processing.pending, 1);
    assert.equal(output.episodes[slug].list.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
