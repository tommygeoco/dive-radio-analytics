import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readingEnvelope } from '../source-io.mjs';
import { monotonicDrops, verifiedYoutubeRevision, sourceStoreIntegrityErrors } from '../source-integrity.mjs';
import { compactSnap } from '../build-data.mjs';

const show = { slug: 'test-dive-radio', date: '2026-09-17', targets: [{ kind: 'youtube', account: 'designertom', videoId: 'same-upload' }] };
const key = 'yt:designertom';
const times = ['2026-09-20T19:15:32.002Z', '2026-09-21T14:00:57.211Z'];
const now = Date.parse('2026-09-22T16:00:00.000Z');
const raw = [2613, 2556].map((views, i) => {
  const ts = times[i];
  const reading = source => readingEnvelope({ source, episode: show.slug, objectId: source === 'postlive' ? show.slug : 'same-upload', pulledAt: ts });
  return { ts, reading: reading('postlive'), metrics: { [key]: { views, detail: { views }, reading: reading('youtube-data'), sources: [{ objectId: 'same-upload', views, detail: { views }, reading: reading('youtube-data') }] } } };
});
const drop = monotonicDrops(raw.map(compactSnap))[0];
const original = JSON.stringify(raw);
assert.equal(verifiedYoutubeRevision(show, raw, drop, now), true);
assert.equal(JSON.stringify(raw), original, 'source revisions never rewrite history');
assert.equal(compactSnap(raw[1]).byDest[key].views, 2556, 'serve the observed lower value, not a high-water clamp');
const root = mkdtempSync(join(tmpdir(), 'dive-counter-revision-'));
try {
  mkdirSync(join(root, 'data/restream/postlive'), { recursive: true });
  writeFileSync(join(root, 'data/restream/postlive-registry.json'), JSON.stringify({ shows: [show] }));
  const save = snapshots => writeFileSync(join(root, `data/restream/postlive/${show.slug}.json`), JSON.stringify({ snapshots }));
  save(raw);
  assert.deepEqual(sourceStoreIntegrityErrors(root, now), []);
  // Both endpoints need provenance. Broken source identity, state, time or
  // object counts cannot turn a material decrease into an accepted revision.
  for (const endpoint of [0, 1]) for (const mutate of [
    s => delete s.reading,
    s => s.reading.state = 'pending',
    s => s.reading.episode = 'wrong',
    s => s.metrics[key].reading.objectId = 'wrong',
    s => s.metrics[key].reading.source = 'x-post',
    s => s.metrics[key].reading.pulledAt = times[1 - endpoint],
    s => s.metrics[key].sources[0].objectId = 'wrong',
    s => s.metrics[key].sources[0].reading.state = 'failed',
    s => s.metrics[key].sources[0].views += 1,
    s => s.metrics[key].views = -1,
    s => s.metrics[key].views = null,
    s => s.metrics[key].views = '2556',
    s => s.metrics[key].views = 1.5,
    s => s.metrics[key].sources = [],
  ]) {
    const changed = structuredClone(raw); mutate(changed[endpoint]);
    assert.equal(verifiedYoutubeRevision(show, changed, drop, now), false);
    save(changed);
    assert.ok(sourceStoreIntegrityErrors(root, now).length, 'malformed/ID-mismatched source must still fail integrity');
  }
  for (const mutate of [
    s => s.metrics[key].detail.views += 1,
    s => s.metrics[key].sources[0].detail.views += 1,
  ]) {
    const changed = structuredClone(raw); mutate(changed[1]);
    assert.equal(verifiedYoutubeRevision(show, changed, drop, now), false);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
const missingObject = structuredClone(raw); missingObject[1].metrics[key].sources = [null];
assert.equal(verifiedYoutubeRevision(show, missingObject, drop, now), false);
assert.equal(verifiedYoutubeRevision(show, raw, drop, NaN), false);
assert.equal(verifiedYoutubeRevision(show, raw, { ...drop, before: 9999 }, now), false);
assert.equal(verifiedYoutubeRevision(show, raw, { ...drop, key: 'x:designertom' }, now), false);
assert.equal(verifiedYoutubeRevision(show, raw, drop, Date.parse(times[0])), false);
assert.equal(verifiedYoutubeRevision({ ...show, targets: [{ ...show.targets[0], videoId: 'replacement' }] }, raw, drop, now), false);
const validator = readFileSync(new URL('./validate.mjs', import.meta.url), 'utf8');
assert.match(validator, /verifiedYoutubeRevision\(show, raw, drop, Date\.parse\(data\.generatedAt\)\)/);
assert.match(validator, /else if \(drop\.before - drop\.after > Math\.max\(50, drop\.before \* 0\.02\)\) \{ bad\+\+; fail/);
console.log('youtube-counter-revision: same-upload source correction accepted; malformed, wrong-ID, mixed-time, missing and X observations still rejected; raw history unchanged');
