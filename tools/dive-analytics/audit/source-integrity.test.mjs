import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frozenRatingBytes, assertFrozenRatingsUnchanged, checkedTime, currentAnalyticsCohort, monotonicDrops, validateHistoryRows, sourceStoreIntegrityErrors } from '../source-integrity.mjs';
import { readingEnvelope } from '../source-io.mjs';
import { hasYtReading, ytViewsOf, ytEngagementOf, engagementPer1kOf, xImpressionsOf } from '../baselines.mjs';
import { projectLiveSession } from '../build-data.mjs';
const time='2026-09-04T16:00:00.000Z', now=Date.parse(time);
const episode={slug:'test',links:{'yt:joindiveclub':'https://youtube.com/watch?v=one','yt:designertom':'https://youtube.com/watch?v=two'}};
const snapshot={ts:time,byDest:{'yt:joindiveclub':{views:100,likes:null,comments:1},'yt:designertom':{views:null,likes:1,comments:1}}};
assert.equal(hasYtReading(snapshot),false);assert.equal(ytViewsOf(snapshot),null);
snapshot.byDest['yt:designertom'].views=0;
assert.equal(ytViewsOf(snapshot),100);assert.equal(ytEngagementOf(snapshot),null);assert.equal(engagementPer1kOf(snapshot),null);assert.equal(xImpressionsOf(snapshot),null);
snapshot.byDest['yt:joindiveclub'].likes=0;assert.equal(ytEngagementOf(snapshot),3);
assert.deepEqual(monotonicDrops([{byDest:{yt:{views:100}}},{byDest:{yt:{views:null}}},{byDest:{yt:{views:120}}}]),[]);
assert.equal(monotonicDrops([{byDest:{yt:{views:100}}},{byDest:{yt:{views:null}}},{byDest:{yt:{views:90}}}]).length,1);
assert.throws(()=>checkedTime(time,{now:NaN}),/validation clock/);
assert.equal(checkedTime(time,{now}),now);
for(const value of [null,'invalid','2026-09-04T16:00:00.001Z','2026-09-05T16:00:00Z']) assert.throws(()=>checkedTime(value,{now}));
assert.throws(()=>checkedTime('2026-09-02T16:00:00Z',{now,maxAge:26*3600000}),/stale/);
const zero={ts:time,reading:{state:'ready'},byDest:{'yt:joindiveclub':{views:0},'yt:designertom':{views:0}}};assert.equal(ytViewsOf(zero),0);assert.equal(ytViewsOf({...zero,reading:null}),null);
const channels=Object.fromEntries([['yt:joindiveclub','one'],['yt:designertom','two']].map(([key,videoId])=>[key,{videoId,pulledAt:time,totals:{views:100,averageViewPercentage:20}}]));
const store={updatedAt:time,channels};assert.equal(currentAnalyticsCohort(episode,store,now).length,2);
for(const broken of [ {...store,watchReport:{state:'pending'}}, {...store,updatedAt:'2026-09-02T16:00:00Z'}, {...store,channels:{...channels,'yt:designertom':{...channels['yt:designertom'],videoId:'wrong'}}} ]) assert.equal(currentAnalyticsCohort(episode,broken,now).length,0);
const rating=JSON.stringify({scores:[{slug:'one',frozenAt:time,score:5}]},null,2)+'\n';
assert.equal(frozenRatingBytes(rating).size,1);assert.equal(assertFrozenRatingsUnchanged(rating,rating),1);
for(const broken of [rating.replace('"score": 5','"score": 6'),rating.replace('"score": 5','"score":  5'),'{"scores":[]}']) assert.throws(()=>assertFrozenRatingsUnchanged(rating,broken),/frozen rating/);
assert.throws(()=>frozenRatingBytes('{invalid'));
const targets=[{key:'yt:joindiveclub',videoId:'one'},{key:'yt:designertom',videoId:'two'}];
const line={date:'2026-09-04',endDate:'2026-09-04',pulledAt:time,ageDays:2,reading:readingEnvelope({source:'youtube-analytics',episode:'test',objectId:'test',pulledAt:time}),channels:Object.fromEntries(targets.map(({key,videoId})=>[key,{videoId,pulledAt:time,views:10,averageViewPercentage:20,reading:readingEnvelope({source:'youtube-analytics',episode:'test',objectId:videoId,pulledAt:time})}]))};
assert.deepEqual(validateHistoryRows([line],{episode:'test',expectedTargets:targets,now}),[]);
for(const mutate of [l=>delete l.channels['yt:designertom'],l=>l.channels['yt:designertom'].videoId='wrong',l=>l.channels['yt:designertom'].pulledAt='2026-09-04T15:00:00Z',l=>l.reading.episode='other',l=>l.date='2026-09-03']) {const changed=structuredClone(line);mutate(changed);assert.ok(validateHistoryRows([changed],{episode:'test',expectedTargets:targets,now}).length);}
const legacy={date:line.date,pulledAt:time,ageDays:2,channels:{}};assert.ok(validateHistoryRows([legacy],{episode:'test',expectedTargets:targets,now}).length);assert.deepEqual(validateHistoryRows([legacy],{baselineRows:[legacy],episode:'test',expectedTargets:targets,now}),[]);
const raw={event:{startedAt:1800000000},viewers:{total:{viewersPerMinute:[{timestamp:1800000000000,viewers:1},{timestamp:1800000060000,viewers:2},{timestamp:1800000120000,viewers:3}]}},messages:{total:{messagesPerMinute:[{timestamp:1800000000000,messages:0},{timestamp:1800000120000,messages:5}]}}};
assert.deepEqual(projectLiveSession(raw,{shows:[]}).series.map(({c,ct})=>({c,ct})),[{c:0,ct:0},{c:null,ct:null},{c:5,ct:null}]);
// The complete verifier runs against disposable source stores, then rejects
// independently corrupted lineage, values, timestamps and metadata.
const root = mkdtempSync(join(tmpdir(), 'dive-source-integrity-'));
try {
  mkdirSync(join(root, 'data/restream/postlive'), { recursive: true });
  const show = { slug: 'test-dive-radio', title: 'Dive Radio test', date: '2026-09-03', targets: targets.map(({key,videoId}) => ({kind:'youtube',account:key.slice(3),videoId})) };
  const save = (path,value) => writeFileSync(join(root,path),JSON.stringify(value));
  save('data/restream/postlive-registry.json',{shows:[show]});
  const envelope = (source,objectId) => readingEnvelope({source,episode:show.slug,objectId,pulledAt:time});
  const candidate = { snapshots:[{ts:time,reading:envelope('postlive',show.slug),metrics:Object.fromEntries(targets.map(({key,videoId}) => [key,{views:10,reading:envelope('youtube-data',videoId),sources:[{objectId:videoId,views:10,reading:envelope('youtube-data',videoId)}]}]))}] };
  const path = `data/restream/postlive/${show.slug}.json`;
  save(path,candidate);
  assert.deepEqual(sourceStoreIntegrityErrors(root,now),[]);
  for (const mutate of [
    s => delete s.snapshots[0].reading,
    s => s.snapshots[0].ts='2026-09-05T16:00:00Z',
    s => s.snapshots[0].metrics['yt:joindiveclub'].reading.objectId='wrong',
    s => s.snapshots[0].metrics['yt:joindiveclub'].sources[0].views=11,
    s => delete s.snapshots[0].metrics['yt:designertom'],
    s => s.snapshots.push(structuredClone(s.snapshots[0])),
    s => { s.capture={state:'ready',checkedAt:'2026-09-04T15:00:00.000Z',reading:envelope('postlive',show.slug)}; },
    s => { s.snapshots[0].metrics['yt:joindiveclub'].views=1.5;s.snapshots[0].metrics['yt:joindiveclub'].sources[0].views=1.5; },
  ]) {
    const changed=structuredClone(candidate);mutate(changed);save(path,changed);
    assert.ok(sourceStoreIntegrityErrors(root,now).length,'source corruption must stop promotion');
  }
} finally { rmSync(root,{recursive:true,force:true}); }
console.log('source-integrity.test: complete cohorts, null/zero, time, frozen bytes, lineage and sparse chat pass');
