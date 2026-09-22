import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotShows } from '../../../scripts/restream/postlive-track.mjs';
import { activeSnapshotFreshnessErrors } from '../source-integrity.mjs';

const now = Date.parse('2026-09-22T16:00:00.000Z');
const shows = [
  { slug: 'old-dive-radio', date: '2026-07-16', active: true },
  { slug: 'recent-dive-radio', date: '2026-09-17' },
  { slug: 'today-dive-radio', date: '2026-09-22' },
  { slug: 'future-dive-radio', date: '2026-09-23' },
  { slug: 'inactive-dive-radio', date: '2026-07-16', active: false },
];
const chain = JSON.parse(readFileSync(new URL('../chain.json', import.meta.url)));
const step = chain.steps.find(s => s.step === 'snapshot');
assert.equal(step.script, 'scripts/restream/postlive-track.mjs snapshot --all');
assert.equal(step.scope, 'active-episodes');
assert.equal(step.required, true);
assert.deepEqual(snapshotShows(shows, { now }).map(s => s.slug), ['recent-dive-radio', 'today-dive-radio']);
assert.deepEqual(snapshotShows(shows, { now, includeAll: true }).map(s => s.slug), shows.slice(0, 3).map(s => s.slug));
assert.deepEqual(snapshotShows([{ slug: 'bad', date: 'invalid' }], { now, includeAll: true }), []);
const fresh = { snapshots: [{ ts: new Date(now).toISOString() }] };
const stale = { snapshots: [{ ts: '2026-09-14T14:00:00.000Z' }] };
const errors = activeSnapshotFreshnessErrors(shows, slug => slug === shows[0].slug ? stale : fresh, now);
assert.deepEqual(errors, ['old-dive-radio snapshot check is stale']);
assert.deepEqual(activeSnapshotFreshnessErrors(shows, () => fresh, now), []);
assert.deepEqual(activeSnapshotFreshnessErrors(shows, slug => slug === shows[0].slug ? null : fresh, now), ['old-dive-radio snapshot check is missing or invalid']);
for (const state of ['pending', 'failed']) {
  const attempted = { ...stale, capture: { state, checkedAt: new Date(now).toISOString() } };
  assert.deepEqual(activeSnapshotFreshnessErrors(shows, () => attempted, now), []);
  assert.equal(attempted.snapshots[0].ts, stale.snapshots[0].ts, 'fresh attempts must not invent snapshot dates');
}
const checked = [];
activeSnapshotFreshnessErrors(shows, slug => { checked.push(slug); return fresh; }, now);
assert.deepEqual(checked, shows.slice(0, 3).map(s => s.slug), 'future and inactive shows are not freshness obligations');
const validator = readFileSync(new URL('./validate.mjs', import.meta.url), 'utf8');
assert.match(validator, /activeSnapshotFreshnessErrors\(registry\.shows/);
assert.match(validator, /bad\+\+; fail\(`chain: \$\{error\}`\)/);
console.log('long-tail-capture: all aired active episodes, no future/inactive requests, stale/missing old history fails, honest pending attempts pass');
