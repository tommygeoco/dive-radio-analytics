#!/usr/bin/env node
// Owner archive: complete source text and provenance, separate from scored feedback.
import { readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicWriteJson, atomicWriteText, readJsonFile, withSourceLock, fetchJson, phoenixDateKey } from '../../tools/dive-analytics/source-io.mjs';
import { getAccessToken } from './restream-token.mjs';
import { xPublicGet } from './x-public-get.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ARCHIVE = join(homedir(), 'Library/Application Support/Dive Radio Analytics/audience-archive');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = 'public_metrics,author_id,created_at,conversation_id,referenced_tweets,note_tweet';
function validList(data) {
  if (data.errors?.length || (!Array.isArray(data.data) && !(data.meta?.result_count === 0 && data.data === undefined))) throw new Error('X archive response is incomplete');
  return data.data || [];
}
export async function captureX(targets, { get = xPublicGet, saveRaw = () => {} } = {}) {
  if (!targets.length) return [];
  const queue = []; const queued = new Set(); const records = new Map();
  const enqueue = id => { if (typeof id !== 'string' || !id) throw new Error('Missing X conversation id'); if (!queued.has(id)) { queued.add(id); queue.push(id); } };
  const retain = data => {
    const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u.username]));
    for (const post of validList(data)) {
      if (!post.id || !post.author_id || !post.conversation_id || !Number.isFinite(Date.parse(post.created_at)) || typeof post.text !== 'string') throw new Error('Malformed X archive post');
      records.set(`x:${post.id}`, { id: `x:${post.id}`, source: 'x', author: users[post.author_id] ? `@${users[post.author_id]}` : null, authorId: post.author_id, text: post.note_tweet?.text || post.text, publishedAt: post.created_at, url: `https://x.com/i/status/${post.id}`, conversationId: post.conversation_id, references: post.referenced_tweets || [], metrics: post.public_metrics || null });
      if (post.referenced_tweets?.some(r => r.type === 'quoted')) enqueue(post.conversation_id);
    }
  };
  const ids = [...new Set(targets.map(t => t.postId))];
  const q = new URLSearchParams({ ids: ids.join(','), 'tweet.fields': fields, expansions: 'author_id', 'user.fields': 'username' });
  const roots = await get(`https://api.x.com/2/tweets?${q}`); await saveRaw('x-anchors', roots);
  retain(roots);
  if (validList(roots).length !== ids.length) throw new Error('X archive did not resolve every registered anchor');
  for (const post of roots.data) { enqueue(post.conversation_id); enqueue(post.id); }
  for (let index = 0; index < queue.length; index++) {
    if (index >= 100) throw new Error('X archive conversation limit reached; raw pages retained');
    const root = queue[index]; let token; const tokens = new Set();
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ query: `(conversation_id:${root} OR quotes_of_tweet_id:${root}) -is:retweet`, 'tweet.fields': fields, expansions: 'author_id', 'user.fields': 'username', max_results: '100' });
      if (token) params.set('next_token', token);
      const data = await get(`https://api.x.com/2/tweets/search/recent?${params}`); await saveRaw(`x-${root}-${page}`, data); retain(data);
      const next = data.meta?.next_token;
      if (!next) break;
      if (typeof next !== 'string' || tokens.has(next)) throw new Error('X archive pagination repeated');
      if (page === 19) throw new Error('X archive page limit reached; raw pages retained');
      tokens.add(next); token = next;
    }
  }
  return [...records.values()];
}
export async function captureChat(eventId, { get, saveRaw = () => {} }) {
  const out = []; const tokens = new Set(); const occurrences = new Map(); let token;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ pageSize: '1000' }); if (token) q.set('pageToken', token);
    const data = await get(`https://api.restream.io/v2/user/events/${encodeURIComponent(eventId)}/chat/history?${q}`);
    await saveRaw(`chat-${eventId}-${page}`, data);
    if (!Array.isArray(data.messages)) throw new Error('Restream chat response is incomplete');
    for (const message of data.messages) {
      if ((message.text !== null && typeof message.text !== 'string') || !Number.isFinite(Date.parse(message.timestamp))) throw new Error('Malformed Restream chat message');
      const identity = [eventId, message.timestamp, message.platform, message.channelName, message.author, message.text];
      const key = hash(identity); const occurrence = (occurrences.get(key) || 0) + 1; occurrences.set(key, occurrence);
      out.push({ id: `chat:${key}:${occurrence}`, source: 'live-chat', eventId, platform: message.platform, channel: message.channelName, author: message.author, text: message.text, publishedAt: message.timestamp, identityMethod: 'content-sha256-and-occurrence', raw: message });
    }
    const next = data.nextPageToken;
    if (!next) return out;
    if (typeof next !== 'string' || tokens.has(next)) throw new Error('Restream chat pagination repeated');
    tokens.add(next); token = next;
  }
  throw new Error('Restream chat page limit reached; raw pages retained');
}
export function archiveMarkdown(store) {
  const escape = value => String(value ?? '(unavailable)').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]#])/g, '\\$1');
  const rows = [...store.records].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return `# Audience archive: ${escape(store.slug)}\n\n${rows.length} retained source records. Includes hosts, ordinary discussion, praise and criticism; this is not a scored feedback count. X coverage is limited to registered anchors, their parent conversations, and quotes of those roots within the recent-search window. Quotes of other individual replies are not searched. Chat author labels are exactly as supplied by Restream.\n\n` + rows.map(r => `## ${escape(r.author)} · ${escape(r.source === 'x' ? 'X' : `${r.platform} / ${r.channel}`)}\n\n${escape(r.publishedAt)}${r.url ? ` · [Original post](${r.url})` : ` · Event ${escape(r.eventId)}`}\n\n${escape(r.text).split('\n').map(line => `> ${line}`).join('\n')}\n\n`).join('');
}

export async function runArchive({ root = ROOT, archive = ARCHIVE, now = new Date().toISOString(), xGet = xPublicGet, chatGet, log = console.log } = {}) {
  mkdirSync(archive, { recursive: true, mode: 0o700 }); chmodSync(archive, 0o700);
  const registry = readJsonFile(join(root, 'data/restream/postlive-registry.json'));
  const eventsDir = join(root, 'data/restream/events');
  const events = readdirSync(eventsDir).filter(f => f.endsWith('.json')).map(f => readJsonFile(join(eventsDir, f)).event).filter(Boolean);
  const shows = registry.shows.filter(s => s.active !== false && /dive-radio/.test(s.slug) && s.date <= phoenixDateKey(now) && Date.parse(now) - Date.parse(`${s.date}T00:00:00-07:00`) <= 8 * 86400000);
  let bearer; const failures = []; let added = 0;
  for (const show of shows) {
    const path = join(archive, `${show.slug}.json`);
    await withSourceLock(path, async () => {
      const store = readJsonFile(path, { fallback: { schemaVersion: 1, slug: show.slug, records: [], captures: [] } });
      if (store.slug !== show.slug || !Array.isArray(store.records) || !Array.isArray(store.captures)) throw new Error('Archive identity is invalid');
      const rawDir = join(archive, 'raw', show.slug, now.replace(/[:.]/g, '-'));
      mkdirSync(rawDir, { recursive: true, mode: 0o700 });
      const saveRaw = (key, response) => atomicWriteJson(join(rawDir, `${key}.json`), { pulledAt: now, response }, { mode: 0o600 });
      const targetUrls = new Set(show.targets.flatMap(t => [t.url, t.videoId && `https://www.youtube.com/watch?v=${t.videoId}`, t.broadcastId && `https://x.com/i/broadcasts/${t.broadcastId}`]).filter(Boolean));
      const matched = events.filter(e => e.status === 'finished' && e.destinations?.some(d => targetUrls.has(d.externalUrl)));
      const sources = [{ name: 'x', collect: () => captureX(show.targets.filter(t => t.kind === 'x'), { get: xGet, saveRaw }) }, ...matched.map(e => ({ name: `chat:${e.id}`, collect: async () => {
        if (!chatGet && !bearer) bearer = await getAccessToken();
        return captureChat(e.id, { saveRaw, get: chatGet || (url => fetchJson(url, { label: 'Restream chat archive', headers: { Authorization: `Bearer ${bearer}` } })) });
      } }))];
      if (!matched.length) sources.push({ name: 'live-chat', collect: () => { throw new Error('No finished Restream event matches registered source URLs'); } });
      for (const source of sources) {
        try {
          const rows = await source.collect(); const seen = new Set(store.records.map(r => r.id));
          for (const row of rows) if (!seen.has(row.id)) { store.records.push({ ...row, firstSeenAt: now, evidenceDirectory: rawDir }); seen.add(row.id); added++; }
          store.captures.push({ source: source.name, pulledAt: now, state: 'ready', count: rows.length, evidenceDirectory: rawDir, scope: source.name === 'x' ? 'registered anchors, parent conversations and quotes of those roots in X recent-search window; quotes of non-anchor replies are not searched' : 'Restream event chat history; source-provided author labels' });
        } catch {
          store.captures.push({ source: source.name, pulledAt: now, state: 'failed', evidenceDirectory: rawDir }); failures.push(`${show.slug}/${source.name}`);
        }
        atomicWriteJson(path, store, { mode: 0o600 });
        atomicWriteText(path.replace(/\.json$/, '.md'), archiveMarkdown(store), { mode: 0o600 });
      }
    });
  }
  log(`audience archive: ${added} new records, ${failures.length} failed sources; ${archive}`);
  if (failures.length) throw new Error(`Audience archive incomplete: ${failures.join(', ')}`);
  return { added, shows: shows.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runArchive().catch(error => { console.error(error.message); process.exitCode = 1; });
