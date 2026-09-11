import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureX, captureChat, runArchive } from '../../../scripts/restream/comments-archive.mjs';
const post = (id, root = id, refs = []) => ({ id, conversation_id: root, author_id: 'person', text: `text ${id}`, created_at: '2026-09-11T10:00:00Z', referenced_tweets: refs });
const response = rows => ({ data: rows, includes: { users: [{ id: 'person', username: 'audience' }] } });
test('X resolves promo parent and follows quote conversations, preserves long text and dedupes', async () => {
  const queries = []; const long = 'great '.repeat(200);
  const rows = await captureX([{ postId: 'promo', role: 'promo' }], { get: async url => {
    const u = new URL(url); if (u.pathname === '/2/tweets') return response([post('promo', 'parent')]);
    const q = u.searchParams.get('query'); queries.push(q);
    if (q.includes('conversation_id:parent ')) return response([post('reply', 'parent'), post('quote', 'quote', [{ type: 'quoted', id: 'parent' }])]);
    if (q.includes('conversation_id:quote ')) return response([{ ...post('glowing', 'quote'), note_tweet: { text: long } }, post('reply', 'parent')]);
    return { meta: { result_count: 0 } };
  } });
  assert.equal(rows.length, 4); assert.equal(rows.find(r => r.id === 'x:glowing').text, long);
  assert(queries.some(q => q.includes('conversation_id:quote ')));
});
test('X partial lookup and repeated cursors fail after preserving raw responses', async () => {
  let raw = 0;
  await assert.rejects(captureX([{ postId: 'missing' }], { get: async () => ({ errors: [{}] }), saveRaw: () => raw++ }), /incomplete/);
  assert.equal(raw, 1);
  await assert.rejects(captureX([{ postId: 'one' }], { get: async url => new URL(url).pathname === '/2/tweets' ? response([post('one')]) : { ...response([post('two', 'one')]), meta: { next_token: 'repeat' } } }), /pagination repeated/);
});
test('chat follows cursors and retains duplicate occurrences, source anonymity and null text', async () => {
  const message = { timestamp: '2026-09-11T10:00:00Z', author: 'Person 1', text: 'BEST EPISODE', platform: 'YouTube', channelName: 'Dive' };
  const get = async url => new URL(url).searchParams.get('pageToken') ? { messages: [message, { ...message, text: null }], nextPageToken: null } : { messages: [message], nextPageToken: 'next' };
  const first = await captureChat('event', { get }); const again = await captureChat('event', { get });
  assert.equal(first.length, 3); assert.notEqual(first[0].id, first[1].id); assert.deepEqual(first, again); assert.equal(first[0].author, 'Person 1'); assert.equal(first[2].text, null);
});
test('archive persists healthy source when another fails, is idempotent and private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audience-archive-')); const archive = join(root, 'owner');
  const save = (path, value) => writeFileSync(path, JSON.stringify(value));
  mkdirSync(join(root, 'data/restream/events'), { recursive: true });
  save(join(root, 'data/restream/postlive-registry.json'), { shows: [{ slug: 'dive-radio-test', date: '2026-09-10', targets: [{ kind: 'youtube', videoId: 'video', url: 'https://www.youtube.com/watch?v=video' }, { kind: 'x', postId: 'one' }] }] });
  save(join(root, 'data/restream/events/e.json'), { event: { id: 'e', status: 'finished', destinations: [{ externalUrl: 'https://www.youtube.com/live/video' }] } });
  const opts = { root, archive, now: '2026-09-11T12:00:00Z', log: () => {}, xGet: async () => { throw new Error('secret upstream message'); }, chatGet: async url => new URL(url).pathname.endsWith('/events/history') ? [] : ({ messages: [{ timestamp: '2026-09-10T12:00:00Z', text: 'wonderful', author: 'Person 2' }] }) };
  try {
    await assert.rejects(runArchive(opts), /incomplete/); await assert.rejects(runArchive(opts), /incomplete/);
    const path = join(archive, 'dive-radio-test.json'); const store = JSON.parse(readFileSync(path));
    assert.equal(store.records.length, 1); assert.equal(store.captures.filter(c => c.state === 'failed').length, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(archive).mode & 0o777, 0o700);
    assert(!readFileSync(path, 'utf8').includes('secret upstream'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('future episode auto-discovers chat without a local ingest and retains day-14 replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audience-future-')); const archive = join(root, 'owner');
  mkdirSync(join(root, 'data/restream'), { recursive: true });
  writeFileSync(join(root, 'data/restream/postlive-registry.json'), JSON.stringify({ shows: [{ slug: 'dive-radio-future', date: '2026-10-01', targets: [{ kind: 'youtube', videoId: 'new-video' }, { kind: 'x', postId: 'anchor' }] }] }));
  const queries = [];
  let day = 1;
  const xGet = async url => {
    const u = new URL(url); if (u.pathname === '/2/tweets') return response([post('anchor')]);
    const q = u.searchParams.get('query'); queries.push(q);
    if (q.includes('conversation_id:anchor ') && day === 1) return response([post('quote', 'quote', [{ type: 'quoted', id: 'anchor' }])]);
    if (q.includes('conversation_id:quote ') && day === 14) return response([post('late-reply', 'quote')]);
    return { meta: { result_count: 0 } };
  };
  const chatGet = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/events/history')) {
      const event = { id: u.searchParams.get('offset') === '0' ? 'future-event' : 'restarted-event', status: 'finished', destinations: [{ externalUrl: 'https://youtu.be/new-video' }] };
      return u.searchParams.get('offset') === '0' ? [event, ...Array.from({ length: 49 }, (_, i) => ({ id: `unrelated-${i}`, status: 'finished', destinations: [] }))] : [event];
    }
    return { messages: [{ timestamp: '2026-10-01T20:00:00Z', text: 'Outstanding episode', author: 'Person 1' }] };
  };
  try {
    await runArchive({ root, archive, now: '2026-10-02T12:00:00Z', xGet, chatGet, log: () => {} });
    day = 14; queries.length = 0;
    await runArchive({ root, archive, now: '2026-10-15T12:00:00Z', xGet, chatGet, log: () => {} });
    const store = JSON.parse(readFileSync(join(archive, 'dive-radio-future.json')));
    assert(store.records.some(r => r.id === 'x:late-reply'));
    assert.equal(store.records.filter(r => r.source === 'live-chat').length, 2);
    assert(store.records.some(r => r.eventId === 'restarted-event'));
    assert(queries.some(q => q.includes('conversation_id:quote ')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('scheduled archive runs before unrelated required analytics and declares private outputs', () => {
  const chain = JSON.parse(readFileSync(new URL('../chain.json', import.meta.url)));
  const archive = chain.steps.find(s => s.step === 'audience-archive');
  assert(archive); assert.equal(archive.required, false); assert.deepEqual(archive.writes, []);
  assert(archive.runtimeWrites[0].includes('audience-archive'));
  assert(chain.steps.indexOf(archive) < chain.steps.findIndex(s => s.step === 'transcripts'));
  assert(chain.steps.indexOf(archive) > chain.steps.findIndex(s => s.step === 'discover'));
});

test('archive budget stops source calls before they can consume the publishing run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-budget-')); const archive = join(root, 'owner');
  mkdirSync(join(root, 'data/restream'), { recursive: true });
  writeFileSync(join(root, 'data/restream/postlive-registry.json'), JSON.stringify({ shows: [{ slug: 'dive-radio-budget', date: '2026-09-10', targets: [{ kind: 'x', postId: 'anchor' }] }] }));
  let calls = 0;
  try {
    await assert.rejects(runArchive({ root, archive, now: '2026-09-11T12:00:00Z', budgetMs: 0, xGet: async () => { calls++; }, chatGet: async () => { calls++; }, log: () => {} }), /incomplete/);
    assert.equal(calls, 0);
    const store = JSON.parse(readFileSync(join(archive, 'dive-radio-budget.json')));
    assert.equal(store.captures.filter(c => c.state === 'failed').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
