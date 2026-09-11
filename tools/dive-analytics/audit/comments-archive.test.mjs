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
  save(join(root, 'data/restream/postlive-registry.json'), { shows: [{ slug: 'dive-radio-test', date: '2026-09-10', targets: [{ kind: 'youtube', url: 'https://example.test/video' }, { kind: 'x', postId: 'one' }] }] });
  save(join(root, 'data/restream/events/e.json'), { event: { id: 'e', status: 'finished', destinations: [{ externalUrl: 'https://example.test/video' }] } });
  const opts = { root, archive, now: '2026-09-11T12:00:00Z', log: () => {}, xGet: async () => { throw new Error('secret upstream message'); }, chatGet: async () => ({ messages: [{ timestamp: '2026-09-10T12:00:00Z', text: 'wonderful', author: 'Person 2' }] }) };
  try {
    await assert.rejects(runArchive(opts), /incomplete/); await assert.rejects(runArchive(opts), /incomplete/);
    const path = join(archive, 'dive-radio-test.json'); const store = JSON.parse(readFileSync(path));
    assert.equal(store.records.length, 1); assert.equal(store.captures.filter(c => c.state === 'failed').length, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(archive).mode & 0o777, 0o700);
    assert(!readFileSync(path, 'utf8').includes('secret upstream'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
