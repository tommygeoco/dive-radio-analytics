// Shared read-side integrity checks. No network and no canonical writes.
import { validateReadingEnvelope } from './source-io.mjs';
import { completeYoutubeWatchCohort } from './youtube-readiness.mjs';

export const FROZEN_BASELINE = '94d65170dc92245f86544066a99635bb68d7f95a';
export const FRESH_MS = 26 * 3600000;

export function checkedTime(value, { now = Date.now(), label = 'timestamp', maxAge = null } = {}) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error(`${label} is missing or invalid`);
  if (time > now + 60_000) throw new Error(`${label} is in the future`);
  if (maxAge != null && now - time > maxAge) throw new Error(`${label} is stale`);
  return time;
}

export function youtubeTargetsForEpisode(episode) {
  return Object.entries(episode.links || {}).filter(([key]) => key.startsWith('yt:'))
    .map(([key, url]) => ({ key, videoId: new URL(url).searchParams.get('v') }));
}

export function currentAnalyticsCohort(episode, store, now = Date.now()) {
  if (!store || (store.watchReport && store.watchReport.state !== 'ready')) return [];
  try { checkedTime(store.updatedAt, { now, label: 'analytics updatedAt', maxAge: FRESH_MS }); }
  catch { return []; }
  return completeYoutubeWatchCohort(youtubeTargetsForEpisode(episode), store);
}

// Retain the exact object substring, including key order and whitespace. JSON
// object comparison alone cannot establish the owner's byte-immutable rule.
export function frozenRatingBytes(text) {
  const store = JSON.parse(text);
  if (!store || !Array.isArray(store.scores)) throw new Error('ratings store has no scores array');
  const key = /"scores"\s*:\s*\[/.exec(text);
  if (!key) throw new Error('ratings scores array is missing');
  const result = new Map(), seen = new Set();
  let at = key.index + key[0].length;
  while (at < text.length) {
    while (/[\s,]/.test(text[at])) at++;
    if (text[at] === ']') break;
    const start = at;
    let depth = 0, quoted = false, escape = false;
    for (; at < text.length; at++) {
      const char = text[at];
      if (quoted) {
        if (escape) escape = false;
        else if (char === '\\') escape = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { depth--; if (!depth) { at++; break; } }
    }
    const raw = text.slice(start, at);
    const entry = JSON.parse(raw);
    if (typeof entry.slug !== 'string' || !entry.slug) throw new Error('ratings entry has no slug');
    if (seen.has(entry.slug)) throw new Error(`ratings repeats ${entry.slug}`);
    seen.add(entry.slug);
    if (entry.frozenAt) result.set(entry.slug, raw);
  }
  return result;
}

export function assertFrozenRatingsUnchanged(previousText, currentText) {
  const previous = frozenRatingBytes(previousText);
  const current = frozenRatingBytes(currentText);
  for (const [slug, bytes] of previous) {
    if (current.get(slug) !== bytes) throw new Error(`frozen rating bytes changed or vanished: ${slug}`);
  }
  return previous.size;
}

export function monotonicDrops(snapshots, { keys = null } = {}) {
  const prior = new Map(), drops = [];
  for (const snapshot of snapshots || []) {
    for (const [key, value] of Object.entries(snapshot.byDest || {})) {
      if (keys && !keys.includes(key)) continue;
      if (!Number.isFinite(value.views)) continue;
      if (prior.has(key) && value.views < prior.get(key)) drops.push({ key, before: prior.get(key), after: value.views, ts: snapshot.ts });
      prior.set(key, value.views);
    }
  }
  return drops;
}

// Every unstamped historical row must be an unchanged member of the audited
// baseline. New data never inherits provenance merely by resembling old data.
export function validateHistoryRows(rows, { baselineRows = [], episode, premiere = null, expectedTargets = [], now = Date.now() } = {}) {
  const errors = [], seenDates = new Set();
  const legacy = new Set(baselineRows.map((row) => JSON.stringify(row)));
  let previousDate = '';
  for (const row of rows || []) {
    const label = `${episode} history ${row.date || '?'}`;
    try { checkedTime(row.pulledAt, { now, label }); } catch (error) { errors.push(error.message); }
    const date = Number.isFinite(Date.parse(row.pulledAt)) ? new Date(Date.parse(row.pulledAt) - 7 * 3600000).toISOString().slice(0, 10) : null;
    if (seenDates.has(row.date) || (previousDate && row.date < previousDate)) errors.push(`${label} is duplicate or out of order`);
    seenDates.add(row.date); previousDate = row.date;
    if (!row.reading) {
      if (!legacy.has(JSON.stringify(row))) errors.push(`${label} has no validated source provenance`);
      continue;
    }
    errors.push(...validateReadingEnvelope(row.reading, { source: 'youtube-analytics', episode, objectId: episode, now }).map((error) => `${label}: ${error}`));
    if (row.reading.state !== 'ready' || row.reading.pulledAt !== row.pulledAt || row.date !== date || row.endDate !== row.date) errors.push(`${label} has inconsistent time or completeness`);
    if (premiere) {
      const age = Math.round((Date.parse(row.pulledAt) - Date.parse(`${premiere}T19:00:00.000Z`)) / 86400000 * 10) / 10;
      if (row.date <= premiere || row.ageDays !== age) errors.push(`${label} entered history before air day ended or has the wrong age`);
    }
    const keys = Object.keys(row.channels || {});
    if (keys.length !== expectedTargets.length || expectedTargets.some(({ key }) => !keys.includes(key))) errors.push(`${label} does not contain every registered channel`);
    for (const { key, videoId } of expectedTargets) {
      const channel = row.channels?.[key];
      errors.push(...validateReadingEnvelope(channel?.reading, { source: 'youtube-analytics', episode, objectId: videoId, now }).map((error) => `${label} ${key}: ${error}`));
      if (channel?.videoId !== videoId || channel?.pulledAt !== row.pulledAt || channel?.reading?.pulledAt !== row.pulledAt || channel?.reading?.state !== 'ready'
        || !Number.isFinite(channel?.views) || channel.views <= 0 || !Number.isFinite(channel.averageViewPercentage)) errors.push(`${label} ${key} is not a complete current-video reading`);
    }
  }
  return errors;
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function sourceStoreIntegrityErrors(root, now = Date.now()) {
  const errors = [];
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const baseline = (path, json = true) => {
    try {
      const text = execFileSync('git', ['show', `${FROZEN_BASELINE}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
      return json ? JSON.parse(text) : text;
    } catch { return null; }
  };
  const check = (reading, expected, label, time = null) => {
    errors.push(...validateReadingEnvelope(reading, { ...expected, now }).map((error) => `${label}: ${error}`));
    if (time != null && reading?.pulledAt !== time) errors.push(`${label}: mixed pull timestamps`);
  };
  const registry = read('data/restream/postlive-registry.json');
  for (const show of registry.shows || []) {
    if (!/dive.?radio/i.test(show.title || '') && !/dive-radio/.test(show.slug || '')) continue;
    const targets = (show.targets || []).filter((target) => target.kind === 'youtube' && target.videoId).map((target) => ({key:`yt:${target.account}`,videoId:target.videoId}));
    const postPath = `data/restream/postlive/${show.slug}.json`;
    if (existsSync(join(root, postPath))) {
      const stored = read(postPath), original = baseline(postPath);
      const legacy = new Set((original?.snapshots || []).map((row) => JSON.stringify(row)));
      if (stored.capture) {
        check(stored.capture.reading, {source:'postlive',episode:show.slug,objectId:show.slug}, `${show.slug} source check`, stored.capture.checkedAt);
        if (stored.capture.state !== stored.capture.reading?.state) errors.push(`${show.slug} source-check states disagree`);
      }
      for (const snapshot of stored.snapshots || []) {
        const label = `${show.slug} ${snapshot.ts}`;
        try { checkedTime(snapshot.ts,{now,label}); } catch(error){errors.push(error.message);}
        if (!snapshot.reading) { if (!legacy.has(JSON.stringify(snapshot))) errors.push(`${label}: new snapshot has no source provenance`); continue; }
        check(snapshot.reading,{source:'postlive',episode:show.slug,objectId:show.slug},label,snapshot.ts);
        if (Number.isFinite(Date.parse(snapshot.ts)) && new Date(Date.parse(snapshot.ts)-7*3600000).toISOString().slice(0,10)<show.date) errors.push(`${label}: future episode was queried`);
        if (snapshot.reading.state !== 'ready') errors.push(`${label}: incomplete snapshot entered history`);
        const expectedKeys = [...new Set((show.targets || []).filter(t => ['youtube','x'].includes(t.kind)).map(t => `${t.kind==='youtube'?'yt':'x'}:${t.account}`))];
        if (expectedKeys.some(key => !snapshot.metrics?.[key])) errors.push(`${label}: partial destination cohort`);
        for (const [key, metric] of Object.entries(snapshot.metrics || {})) {
          const group=(show.targets || []).filter(t => `${t.kind==='youtube'?'yt':t.kind}:${t.account}`===key);
          const ids=group.map(t=>t.videoId || t.postId).filter(Boolean).sort();
          const source=key.startsWith('yt:')?'youtube-data':'x-post';
          check(metric.reading,{source,episode:show.slug,objectId:ids.join(',')},`${label} ${key}`,snapshot.ts);
          if(metric.reading?.state!=='ready' || !Number.isFinite(metric.views) || metric.views<0) errors.push(`${label} ${key}: incomplete count`);
          if (!Array.isArray(metric.sources) || metric.sources.length!==ids.length || ids.some(id=>!metric.sources.some(item=>item.objectId===id))) errors.push(`${label} ${key}: source object list is incomplete`);
          for(const item of metric.sources || []) {
            check(item.reading,{source,episode:show.slug,objectId:item.objectId},`${label} ${key} object`,snapshot.ts);
            if(item.reading?.state!=='ready' || !Number.isFinite(item.views) || item.views<0) errors.push(`${label} ${key}: incomplete source object`);
          }
          if((metric.sources || []).reduce((sum,item)=>sum+item.views,0)!==metric.views) errors.push(`${label} ${key}: count differs from source rows`);
          if(metric.plays != null){
            const broadcasts=[...new Set(group.filter(t=>t.role!=='promo' && t.broadcastId).map(t=>t.broadcastId))].sort();
            if(!Array.isArray(metric.broadcasts) || metric.broadcasts.length!==broadcasts.length || broadcasts.some(id=>!metric.broadcasts.some(item=>item.objectId===id))) errors.push(`${label} ${key}: broadcast source objects differ from registry`);
            check(metric.playsReading,{source:'x-broadcast',episode:show.slug,objectId:broadcasts.join(',')},`${label} ${key} plays`,snapshot.ts);
            if(metric.playsReading?.state!=='ready' || !Number.isFinite(metric.plays) || metric.plays<0 || (metric.broadcasts || []).reduce((sum,item)=>sum+item.views,0)!==metric.plays) errors.push(`${label} ${key}: broadcast count differs from complete source rows`);
          }
        }
      }
    }
    const analyticsPath=`data/restream/yt-analytics/${show.slug}.json`;
    if(existsSync(join(root,analyticsPath))){
      const store=read(analyticsPath), original=baseline(analyticsPath);
      const entries=Object.entries(store.channels || {});
      if(entries.length){try{checkedTime(store.updatedAt,{now,label:`${show.slug} analytics updatedAt`});}catch(error){errors.push(error.message);}}
      if(entries.length && !completeYoutubeWatchCohort(targets,store).length) errors.push(`${show.slug}: analytics is not a complete current-video cohort`);
      if(store.reading) { check(store.reading,{source:'youtube-analytics',episode:show.slug,objectId:show.slug},`${show.slug} analytics`,store.updatedAt);if(store.reading.state!=='ready') errors.push(`${show.slug}: analytics numeric store is not ready`); }
      for(const [key,channel] of entries){
        if(!channel.reading){if(JSON.stringify(channel)!==JSON.stringify(original?.channels?.[key])) errors.push(`${show.slug} ${key}: new analytics has no source provenance`);continue;}
        const target=targets.find(t=>t.key===key);
        check(channel.reading,{source:'youtube-analytics',episode:show.slug,objectId:target?.videoId},`${show.slug} ${key}`,store.updatedAt);
        if(channel.reading.state!=='ready') errors.push(`${show.slug} ${key}: incomplete analytics entered numeric store`);
      }
    }
    const historyPath=`data/restream/yt-analytics-history/${show.slug}.jsonl`;
    if(existsSync(join(root,historyPath))){
      const parse=text=>(text || '').split('\n').filter(Boolean).map(line=>JSON.parse(line));
      const lines=parse(readFileSync(join(root,historyPath),'utf8'));
      errors.push(...validateHistoryRows(lines,{baselineRows:parse(baseline(historyPath,false)),episode:show.slug,premiere:show.date,expectedTargets:targets,now}));
    }
    const commentsPath=`data/restream/comments/${show.slug}.json`;
    if(existsSync(join(root,commentsPath))){
      const store=read(commentsPath),original=baseline(commentsPath);
      const legacy=new Map((original?.comments || []).map(c=>[c.id,c]));
      if(store.comments?.length){try{checkedTime(store.updatedAt,{now,label:`${show.slug} comments updatedAt`});}catch(error){errors.push(error.message);}}
      for(const comment of store.comments || []){
        const source=comment.source==='yt'?'youtube-comments':'x-replies';
        const objectId=comment.id?.replace(/^(yt|x):/,'');
        if(comment.likesReading) check(comment.likesReading,{source,episode:show.slug,objectId},`${show.slug} comment likes ${comment.id}`);
        if(!comment.reading){
          const originalComment=legacy.get(comment.id);
          const unchanged={...comment};delete unchanged.likesReading;
          if(comment.likesReading && originalComment) unchanged.likes=originalComment.likes;
          if(!originalComment || JSON.stringify(unchanged)!==JSON.stringify(originalComment)) errors.push(`${show.slug}: new comment has no source provenance`);continue;
        }
        check(comment.reading,{source,episode:show.slug,objectId},`${show.slug} comment ${comment.id}`);
        const group=(show.targets || []).filter(t=>comment.source==='yt'?t.kind==='youtube':t.kind==='x');
        if(!group.some(t=>(t.videoId || t.postId)===comment.sourceObjectId)) errors.push(`${show.slug} comment ${comment.id}: unregistered parent object`);
        if(comment.reading.state!=='ready') errors.push(`${show.slug} comment ${comment.id}: incomplete capture`);
      }
      if(store.capture){
        try{checkedTime(store.capture.checkedAt,{now,label:`${show.slug} comments check`});}catch(error){errors.push(error.message);}
        for(const source of store.capture.sources || []) check(source.reading || source,{episode:show.slug},`${show.slug} comments source`);
        if(store.capture.state==='ready' && (!store.capture.sources?.length || store.capture.sources.some(s=>(s.reading || s).state!=='ready'))) errors.push(`${show.slug}: comment capture claims ready without complete sources`);
      }
    }
  }
  const eventsDir=join(root,'data/restream/events');
  if(existsSync(eventsDir))for(const name of readdirSync(eventsDir).filter(n=>n.endsWith('.json'))){
    const path=`data/restream/events/${name}`,store=read(path);
    if(!store.reading){if(JSON.stringify(store)!==JSON.stringify(baseline(path))) errors.push(`${name}: new live event has no source provenance`);continue;}
    check(store.reading,{source:'restream',objectId:store.event?.id},name,store.fetchedAt);
    if(store.reading.state!=='ready') errors.push(`${name}: incomplete live event entered numeric archive`);
  }
  const channelPath='data/restream/channel-stats.json';
  if(existsSync(join(root,channelPath))){
    const store=read(channelPath), original=baseline(channelPath);
    const allowed={'yt:joindiveclub':'youtube-channel','yt:designertom':'youtube-channel','x:ridd_design':'x-account','x:designertom':'x-account'};
    for(const [key,points] of Object.entries(store.series || {})){
      const legacy=new Set((original?.series?.[key] || []).map(p=>JSON.stringify(p)));
      let previous='';
      for(const point of points){
        if(previous && point.date<=previous) errors.push(`channel ${key}: duplicate or out-of-order date`);previous=point.date;
        if(!point.reading){if(!legacy.has(JSON.stringify(point))) errors.push(`channel ${key}: new point has no source provenance`);continue;}
        check(point.reading,{source:allowed[key],episode:null},`channel ${key}`);
        const date=Number.isFinite(Date.parse(point.reading.pulledAt))?new Date(Date.parse(point.reading.pulledAt)-7*3600000).toISOString().slice(0,10):null;
        if(!allowed[key] || point.reading.state!=='ready' || point.date!==date) errors.push(`channel ${key}: invalid date or source state`);
        const fields=key.startsWith('yt:')?['subscribers','totalViews','videos']:['followers','tweets'];
        if(fields.some(f=>!Number.isSafeInteger(point[f]) || point[f]<0)) errors.push(`channel ${key}: partial numeric point`);
      }
    }
    for(const [key,point] of Object.entries(store.current || {})) check(point.reading,{source:allowed[key],episode:null},`current channel ${key}`,store.updatedAt);
    if(store.capture){try{checkedTime(store.capture.checkedAt,{now,label:'channel check'});}catch(error){errors.push(error.message);}}
  }
  const promotionPath='data/restream/beehiiv-promotions.json';
  if(existsSync(join(root,promotionPath))){
    const store=read(promotionPath),original=baseline(promotionPath);
    if(store.capture){try{checkedTime(store.capture.checkedAt,{now,label:'newsletter check'});}catch(error){errors.push(error.message);}}
    for(const [slug,entry] of Object.entries(store.episodes || {})){
      if(entry.capture){check(entry.capture.reading,{source:'beehiiv',episode:slug,objectId:store.publication?.id},`${slug} newsletter check`,entry.capture.checkedAt);if(entry.capture.state!==entry.capture.reading?.state) errors.push(`${slug}: newsletter check states disagree`);}
      for(const [field,id] of [['newsletters','postId'],['snapshots',null]]){
        const legacy=new Set((original?.episodes?.[slug]?.[field] || []).map(row=>JSON.stringify(row)));
        for(const row of entry[field] || []){
          if(!row.reading){if(!legacy.has(JSON.stringify(row))) errors.push(`${slug}: new newsletter ${field} row has no source provenance`);continue;}
          check(row.reading,{source:'beehiiv',episode:slug,objectId:id?row[id]:store.publication?.id},`${slug} newsletter ${field}`,id ? entry.capture?.state==='ready' ? entry.capture.checkedAt : null : row.pulledAt);
          if(!id && (!Number.isSafeInteger(row.emailClicks) || !Number.isSafeInteger(row.verifiedEmailClicks) || row.emailClicks<0 || row.verifiedEmailClicks<0)) errors.push(`${slug}: incomplete newsletter history`);
          if(row.reading.state!=='ready' && !(field==='newsletters' && row.reading.state==='pending' && entry.capture?.state==='pending')) errors.push(`${slug}: incomplete newsletter facts entered numeric store`);
        }
      }
    }
  }
  const transcriptPath='data/restream/transcript-state.json';
  if(existsSync(join(root,transcriptPath))){
    const state=read(transcriptPath);
    for(const [slug,entry] of Object.entries(state.entries || {})){
      check(entry.reading,{source:'transcript',episode:slug},`${slug} transcript`);
      try{checkedTime(entry.checkedAt,{now,label:`${slug} transcript check`});}catch(error){errors.push(error.message);}
      if(entry.reading?.state==='ready'){
        if(entry.file!==`transcripts/${slug}.txt` || !existsSync(join(root,entry.file))) errors.push(`${slug}: ready transcript is missing`);
        else if(createHash('sha256').update(readFileSync(join(root,entry.file))).digest('hex')!==entry.sha256) errors.push(`${slug}: transcript bytes differ from source receipt`);
      }
    }
  }
  return errors;
}

export function assertSourceStoreIntegrity(root, now = Date.now()) {
  const errors = sourceStoreIntegrityErrors(root, now);
  if(errors.length) throw new Error(`source store integrity failed: ${errors.slice(0,8).join('; ')}`);
}
