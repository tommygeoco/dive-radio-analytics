import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageShowCapture, promoteShowCapture, youtubeViewsForDisplay, parseBroadcastStatsLine, youtubeStatsOf, xStatsOf } from '../../../scripts/restream/postlive-track.mjs';
import { rowsToObjects, historyLine, appendHistoryLine } from '../../../scripts/restream/yt-analytics-pull.mjs';
import { collectDiscoveryPages, discoverYouTube, discoverX } from '../../../scripts/restream/postlive-discover.mjs';
import { atomicWriteJson } from '../source-io.mjs';

const time = '2026-09-04T20:00:00.000Z';
const show = { slug: '2026-09-03-dive-radio-fixture', date: '2026-09-03', targets: [
  { kind: 'youtube', account: 'joindiveclub', videoId: 'vd' }, { kind: 'youtube', account: 'designertom', videoId: 'vt' },
  { kind: 'x', account: 'ridd_design', postId: 'pd', broadcastId: 'bd' }, { kind: 'x', account: 'designertom', postId: 'pt', broadcastId: 'bt' },
] };
const youtube = { vd: { views: 50, likes: null, comments: null, channelId: 'UCkCnraWwlnBw1_i7C9-3p0w' }, vt: { views: 20, likes: 0, comments: 0, channelId: 'UC4_qP33t3TGpEM0-96WfC6Q' } };
const xrow = { views: 0, likes: 0, replies: 0, reposts: 0, bookmarks: 0, quotes: 0, publicMetricsAvailable: true };
const args = { ytStats: youtube, xStats: { pd: xrow, pt: xrow }, broadcastStats: { bd: { views: 0 }, bt: { views: 10 } }, checkedAt: time };
const staged = stageShowCapture(show, args);
assert.equal(staged.capture.state, 'ready');
assert.equal(staged.snapshot.metrics['x:ridd_design'].plays, 0);
assert.equal(staged.snapshot.metrics['yt:joindiveclub'].detail.likes, null);
assert.equal(staged.snapshot.metrics['yt:joindiveclub'].reading.objectId, 'vd');
assert.equal(staged.snapshot.metrics['x:designertom'].playsReading.objectId, 'bt');
const multiShow = { ...show, targets: [...show.targets, { kind: 'x', account: 'ridd_design', postId: 'pd2', role: 'promo' }] };
const multi = stageShowCapture(multiShow, { ...args, xStats: { ...args.xStats, pd2: { ...xrow, views: 11, likes: 2 } } });
assert.equal(multi.snapshot.metrics['x:ridd_design'].views, 11);
assert.equal(multi.snapshot.metrics['x:ridd_design'].detail.likes, 2);
assert.equal(multi.snapshot.metrics['x:ridd_design'].sources.length, 2);
const hist = { slug: show.slug, snapshots: [staged.snapshot] };
for (const bad of [
  { ...args, ytStats: { vd: youtube.vd } },
  { ...args, ytStats: { ...youtube, vt: { ...youtube.vt, channelId: 'wrong' } } },
  { ...args, xStats: { pd: xrow } },
  { ...args, broadcastStats: { bd: { views: 0 } } },
]) {
  const pending = stageShowCapture(show, bad);
  assert.equal(pending.capture.state, 'pending'); assert.equal(pending.snapshot, null);
  assert.deepEqual(promoteShowCapture(hist, pending).snapshots, hist.snapshots);
  assert.equal(stageShowCapture(show, { ...bad, requestFailed: true }).capture.state, 'failed');
}
assert.equal(stageShowCapture({ ...show, date: '2026-09-05' }, args).capture.state, 'future');
const promosOnly = { ...show, targets: show.targets.map(t => t.kind === 'x' ? { ...t, role: 'promo', playsStatus: 'none', broadcastId: null } : t) };
assert.equal(stageShowCapture(promosOnly, args).capture.state, 'pending', 'X teaser posts cannot establish a complete episode broadcast cohort');
assert.equal(promoteShowCapture(hist, staged).snapshots.length, 1, 'replayed reading is idempotent');
assert.equal(youtubeViewsForDisplay({ 'yt:joindiveclub': { views: 50 }, 'yt:designertom': { views: null } }), null);
assert.equal(parseBroadcastStatsLine('was_live|0|0').views, 0);
assert.equal(parseBroadcastStatsLine('was_live|NA|NA'), null);
for (const value of [true, false, 1.5, -1, NaN, Infinity, {}, [], 1n, 'true', '1.5', '-1', '1e3', ' 4', '4 ', '0x10', Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
  assert.throws(() => youtubeStatsOf({ statistics: { viewCount: value } }), /invalid count/, `YouTube must reject ${String(value)}`);
  assert.throws(() => xStatsOf({ public_metrics: { impression_count: value } }), /invalid count/, `X must reject ${String(value)}`);
}
for (const value of [0, '0', 4, '004', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
  assert.equal(youtubeStatsOf({ statistics: { viewCount: value } }).views, Number(value));
  assert.equal(xStatsOf({ public_metrics: { impression_count: value } }).views, Number(value));
}
for (const value of [undefined, null, '']) {
  assert.equal(youtubeStatsOf({ statistics: { viewCount: value } }).views, null);
  assert.equal(xStatsOf({ public_metrics: { impression_count: value } }).views, null);
}
for (const value of ['true', 'false', '1.5', '-1', '1e3', 'Infinity', 'NaN', '0x10', '9007199254740992']) {
  assert.throws(() => parseBroadcastStatsLine(`was_live|${value}|0`), /invalid count/);
  assert.throws(() => parseBroadcastStatsLine(`was_live|10|${value}`), /invalid count/);
}
assert.deepEqual(parseBroadcastStatsLine('was_live|12|NA'), { views: 12, peakConcurrent: null, liveStatus: 'was_live' });
const schema = ['views', 'averageViewPercentage'];
assert.deepEqual(rowsToObjects({ columnHeaders: schema.map(name => ({ name })) }, schema), []);
assert.throws(() => rowsToObjects({}), /schema/);
assert.throws(() => rowsToObjects({ columnHeaders: [{ name: 'views' }], rows: [[3]] }, schema), /schema/);
assert.throws(() => rowsToObjects({ columnHeaders: schema.map(name => ({ name })), rows: [[3]] }), /incomplete/);
const malformedYT = await discoverYouTube({ apiKey: 'fixture', get: async () => ({}) });
assert.ok(malformedYT.accounts.every(a => !a.success));
const malformedX = await discoverX(new Set(), { bearerToken: 'fixture', get: async url => url.includes('/by/username/') ? { data: { id: 'id' } } : {} });
assert.ok(malformedX.accounts.every(a => !a.success));
let pages = 0;
const pagesResult = await collectDiscoveryPages('https://example.test/tweets', { kind: 'x', earliest: 0, get: async () => ++pages === 1 ? { data: [{ id: 'one' }], meta: { next_token: 'next' } } : { data: [{ id: 'two' }] } });
assert.equal(pages, 2); assert.equal(pagesResult.data.length, 2);
await assert.rejects(() => collectDiscoveryPages('https://example.test/tweets', { kind: 'x', get: async () => ({ data: [], meta: { next_token: 'repeat' } }) }), /repeated/);
const dir = mkdtempSync(join(tmpdir(), 'dive-capture-'));
try {
  const path = join(dir, 'history.json'); atomicWriteJson(path, hist); const before = readFileSync(path);
  assert.throws(() => atomicWriteJson(path, {}, { beforeRename() { throw new Error('interrupted'); } }), /interrupted/);
  assert.deepEqual(readFileSync(path), before);
  const channels = Object.fromEntries(['d', 't'].map(key => [`yt:${key}`, { videoId: key, pulledAt: time, totals: { views: 1, averageViewPercentage: 0 } }]));
  const line = historyLine({ slug: show.slug, premiere: show.date, pulledAt: time, endDate: '2026-09-04', channels });
  assert.equal(appendHistoryLine(join(dir,'watch.jsonl'), line, { expectedChannels: ['yt:d','yt:t'], premiere: show.date }), true);
  const bad = structuredClone(line); bad.channels['yt:t'].pulledAt = '2026-09-03T20:00:00Z';
  assert.equal(appendHistoryLine(join(dir,'bad.jsonl'), bad, { expectedChannels: ['yt:d','yt:t'], premiere: show.date }), false);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('source-capture: complete cohorts only, wrong IDs/owner, missing X/live, zeros, future, recovery/idempotence, schemas, pagination and interrupted writes pass');
