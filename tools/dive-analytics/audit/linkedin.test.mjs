import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linkedinIdentity, discoverLinkedin, projectLinkedin, validateMetricImport, unidentifiedLinkedin, isLinkedinChannel, LINKEDIN_CHANNELS } from '../linkedin.mjs';
const LINKEDIN_CHANNEL = LINKEDIN_CHANNELS[0];
import { syncLinkedin } from '../../../scripts/restream/linkedin-sync.mjs';
import { collectFacts } from '../recommendations.mjs';
import { computeAll, trendsLines, projectLiveSession } from '../build-data.mjs';
import { buildBrief } from '../agent-brief.mjs';
const now = Date.parse('2026-09-13T08:00:00Z');
const url = 'https://www.linkedin.com/feed/update/urn:li:ugcPost:123456/';
const shows = [{ slug: '2026-09-10-dive-radio-example', targets: [{ kind: 'youtube', videoId: 'verified', account: 'joindiveclub' }] }];
const raw = { event: { id: 'event-1', title: 'Unrelated title must not matter', startedAt: '2026-09-10T19:00:00Z', finishedAt: '2026-09-10T20:00:00Z', destinations: [{ channelId: LINKEDIN_CHANNEL, externalUrl: url }, { channelId: 2, externalUrl: 'https://youtube.com/watch?v=verified' }] }, fetchedAt: '2026-09-11T00:00:00Z', viewers: { total: { viewsTotal: 100 }, byChannel: { [LINKEDIN_CHANNEL]: { max: 0, mean: 0, viewsTotal: 0, watchedTime: 0, viewersPerMinute: [{ timestamp: 1789066800000, viewers: 0 }] } } }, messages: { total: { messagesTotal: 27 }, byChannel: { [LINKEDIN_CHANNEL]: { messagesTotal: 20, chattersTotal: 8 } } } };
const source = discoverLinkedin(shows, [raw])[shows[0].slug];
const input = { version: 1, slug: shows[0].slug, url, source: 'linkedin-owner-reading', observedAt: '2026-09-13T07:00:00Z', metrics: { plays: 100, impressions: 900, reactions: 0 } };
test('discovery uses exact shared broadcast identity, pins the approved channel and rejects ambiguity', () => {
  assert.equal(source.url, url);
  assert.deepEqual(discoverLinkedin([{ ...shows[0], targets: [] }], [raw]), {});
  assert.throws(() => discoverLinkedin([...shows, { ...shows[0], slug: 'other' }], [raw]), /ambiguous/);
  const changed = structuredClone(raw); changed.event.destinations[0].externalUrl = url.replace('123456', '999');
  assert.throws(() => discoverLinkedin(shows, [raw, changed]), /Conflicting/);
  changed.event.destinations[0].channelId = 999;
  assert.deepEqual(discoverLinkedin(shows, [changed]), {});
  assert.equal(linkedinIdentity('https://linkedin.com.evil.test/feed/update/urn:li:ugcPost:123/'), null);
  assert.equal(linkedinIdentity('https://www.linkedin.com/in/michaelriddering/'), null);
});
test('both verified Ridd channels register, each recording the channel its event used', () => {
  assert.deepEqual([...LINKEDIN_CHANNELS], ['17403676', '17833475']);
  assert(isLinkedinChannel(17403676) && isLinkedinChannel('17833475') && !isLinkedinChannel('999'));
  assert.equal(source.channelId, '17403676');
  const moved = structuredClone(raw);
  moved.event.destinations[0].channelId = 17833475;
  moved.messages.byChannel = { '17833475': { messagesTotal: 3, chattersTotal: 2 } };
  const next = discoverLinkedin(shows, [moved])[shows[0].slug];
  assert.equal(next.url, url);
  assert.equal(next.channelId, '17833475', 'records the actual channel, not a pinned constant');
  assert.equal(projectLinkedin(next, moved, [], now).liveChat.messages, 3, 'chat is read from the channel that carried it');
  assert.deepEqual(unidentifiedLinkedin(shows, [moved]), []);
  const both = structuredClone(moved); both.event.destinations.push({ channelId: '17403676', externalUrl: url.replace('123456', '777') });
  assert.throws(() => discoverLinkedin(shows, [both]), /ambiguous/);
});
test('an unverified LinkedIn channel is reported as a discovery gap, never registered', async () => {
  const unknown = structuredClone(raw); unknown.event.destinations[0].channelId = 555;
  assert.deepEqual(discoverLinkedin(shows, [unknown]), {});
  assert.deepEqual(unidentifiedLinkedin(shows, [unknown]), [{ slug: shows[0].slug, channelId: '555', eventId: 'event-1' }]);
  const root = mkdtempSync(join(tmpdir(), 'linkedin-gap-'));
  const data = join(root, 'data/restream'); mkdirSync(join(data, 'events'), { recursive: true });
  writeFileSync(join(data, 'postlive-registry.json'), JSON.stringify({ shows })); writeFileSync(join(data, 'events/event.json'), JSON.stringify(unknown));
  const logged = []; const log = console.log; console.log = (m) => logged.push(String(m));
  try {
    const result = await syncLinkedin({ root, inbox: join(root, 'none'), now });
    assert.equal(result.gaps.length, 1);
    assert(logged.some(l => /^WARN  LinkedIn: .*unverified Restream channel 555/.test(l)), 'the step warns instead of failing');
    assert.equal(JSON.parse(readFileSync(join(data, 'postlive-registry.json'))).shows[0].linkedin, undefined);
  } finally { console.log = log; rmSync(root, { recursive: true, force: true }); }
});
test('missing viewer access stays null while real chat and real observed zero survive', () => {
  const li = projectLinkedin(source, raw, [], now);
  assert.equal(li.state, 'awaiting-access');
  assert.equal(li.liveChat.messages, 20); assert.equal(li.metrics.plays, null); assert.equal(li.metrics.impressions, null);
  const actual = projectLinkedin(source, raw, [validateMetricImport(input, source, now)], now);
  assert.equal(actual.metrics.plays, 100); assert.equal(actual.metrics.impressions, 900);
  assert.equal(actual.metrics.reactions, 0); assert.equal(actual.metrics.comments, null);
  assert.equal(actual.history.length, 1);
  assert.equal(projectLinkedin(source, raw, actual.history, now + 27 * 3600000).state, 'stale');
  const live = projectLiveSession(raw, {});
  const row = live.byChannel.find(c => c.label === 'LinkedIn');
  assert.equal(row.views, null); assert.equal(row.peak, null); assert.equal(row.messages, 20);
  assert.equal(live.chatMessages, 27, 'LinkedIn is already in session total; do not add twice');
});
test('owner imports reject missing values, impossible counts, future time and wrong post', () => {
  for (const metrics of [{ plays: null }, { plays: -1 }, { plays: 1.5 }, { views: 12 }, {}]) assert.throws(() => validateMetricImport({ ...input, metrics }, source, now));
  assert.throws(() => validateMetricImport({ ...input, url: url.replace('123456', '999') }, source, now));
  assert.throws(() => validateMetricImport({ ...input, observedAt: '2099-01-01T00:00:00Z' }, source, now));
  assert.throws(() => validateMetricImport({ ...input, source: 'restream-zero' }, source, now));
});
test('sync backfills identities, preserves existing targets, imports once and refuses conflicting evidence atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-')); const inbox = join(root, 'private-inbox');
  const data = join(root, 'data/restream'); mkdirSync(join(data, 'events'), { recursive: true }); mkdirSync(inbox);
  const registryPath = join(data, 'postlive-registry.json'); const metricsPath = join(data, 'linkedin-metrics.json');
  writeFileSync(registryPath, JSON.stringify({ shows })); writeFileSync(join(data, 'events/event.json'), JSON.stringify(raw));
  writeFileSync(join(inbox, 'reading.json'), JSON.stringify(input));
  try {
    assert.equal((await syncLinkedin({ root, inbox, now })).added, 1);
    const registry = JSON.parse(readFileSync(registryPath)); assert.deepEqual(registry.shows[0].targets, shows[0].targets);
    assert.equal(registry.shows[0].linkedin.url, url);
    assert.equal((await syncLinkedin({ root, inbox, now })).added, 0);
    const before = readFileSync(metricsPath, 'utf8');
    writeFileSync(join(inbox, 'conflict.json'), JSON.stringify({ ...input, metrics: { plays: 999 } }));
    await assert.rejects(syncLinkedin({ root, inbox, now }), /Conflicting/);
    assert.equal(readFileSync(metricsPath, 'utf8'), before);
    assert(!before.includes('private-inbox'));
    assert.equal(JSON.parse(before).episodes[input.slug].readings.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('LinkedIn reaches recommendation facts, source context and weekly text without adding unavailable views', () => {
  const data = computeAll();
  const episode = data.episodes.at(-1);
  episode.linkedin = projectLinkedin(source, raw, [], now);
  const sheet = collectFacts(data);
  assert(sheet.facts.some(f => f.id === `linkedin-chat-E${episode.ep}` && f.value === episode.linkedin.liveChat.messages));
  assert(!sheet.facts.some(f => f.id === `linkedin-plays-E${episode.ep}`));
  assert.equal(sheet.context.linkedin[`E${episode.ep}`].state, 'awaiting-access');
  assert(trendsLines(data).some(row => row.kind === 'linkedin' && row.text.includes(episode.linkedin.url)));
  const expected = episode.latest.ytTotal != null || episode.latest.xPlays != null ? (episode.latest.ytTotal ?? 0) + (episode.latest.xPlays ?? 0) : null;
  assert.equal(episode.latest.totalViews, expected);
});

test('an imported LinkedIn plays reading never enters any views total the page, brief or Slack report', () => {
  const data = computeAll();
  const episode = data.episodes.at(-1);
  const digestTotals = (d) => { const g = buildBrief(d).digest; return JSON.stringify([g.show.totals, g.episodes.map((e) => e.views.total)]); };
  episode.linkedin = projectLinkedin(source, raw, [], now);
  const without = digestTotals(data);
  const slackWithout = trendsLines(data).filter((row) => row.kind !== 'linkedin').map((row) => row.text).join('\n');
  episode.linkedin = projectLinkedin(source, raw, [{ observedAt: '2026-09-12T08:00:00.000Z', source: 'linkedin-owner-reading', metrics: { plays: 5000 } }], now);
  assert.equal(episode.linkedin.metrics.plays, 5000, 'the fixture really carries LinkedIn plays');
  assert.equal(digestTotals(data), without, 'LinkedIn plays leave every brief views total unchanged');
  assert.equal(trendsLines(data).filter((row) => row.kind !== 'linkedin').map((row) => row.text).join('\n'), slackWithout, 'LinkedIn plays leave every non-LinkedIn Slack line unchanged');
  const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  const viewKeys = html.match(/const VIEW_KEYS = [^;]+;/)?.[0] || '';
  assert(viewKeys && !/linkedin/i.test(viewKeys), 'the page sums views over YouTube and X keys only');
});


test('feedback renderer exposes exact LinkedIn original links without allowing arbitrary profile or spoofed URLs', () => {
  const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  const functionText = html.match(/function feedbackOriginal\(comment\) \{[\s\S]*?\n\}/)?.[0];
  assert(functionText);
  const render = vm.runInNewContext(`(${functionText})`, { esc: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') });
  assert.match(render({ url }), /href="https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:ugcPost:123456\/"[^>]*>Original<svg class="ext"[^>]*aria-hidden="true"/);
  assert.match(render({ url }), /rel="noopener noreferrer"/);
  assert.equal(render({ url: 'https://www.linkedin.com/in/michaelriddering/' }), '');
  assert.equal(render({ url: 'https://www.linkedin.com.evil.test/feed/update/urn:li:ugcPost:123456/' }), '');
  assert.equal(render({ url: 'javascript:alert(1)' }), '');
  assert.match(render({ url: 'https://x.com/i/status/123456' }), />Original<svg class="ext"/);
});
