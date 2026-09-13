// LinkedIn source identity and projection. Restream supplies chat, never viewers.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const LINKEDIN_KEY = 'linkedin:michaelriddering';
export const LINKEDIN_CHANNEL = '17403676';
export const METRICS = ['plays', 'uniqueViewers', 'watchTimeMinutes', 'impressions', 'reactions', 'comments', 'reposts'];
export const METRIC_LABELS = { plays: 'Video plays', uniqueViewers: 'Unique video viewers', watchTimeMinutes: 'Minutes watched', impressions: 'Post impressions', reactions: 'Reactions', comments: 'Post comments', reposts: 'Reposts' };
export function linkedinIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    const m = decodeURIComponent(url.pathname).match(/^\/feed\/update\/urn:li:(ugcPost|share):(\d+)\/?$/);
    return m ? { urn: `urn:li:${m[1]}:${m[2]}`, url: `https://www.linkedin.com/feed/update/urn:li:${m[1]}:${m[2]}/` } : null;
  } catch { return null; }
}
function broadcastIdentity(value) {
  try {
    const u = new URL(value);
    if (['youtube.com', 'www.youtube.com'].includes(u.hostname)) { const id = u.searchParams.get('v') || u.pathname.match(/^\/live\/([^/]+)/)?.[1]; return id ? `youtube:${id}` : null; }
    if (u.hostname === 'youtu.be') return `youtube:${u.pathname.slice(1)}`;
    if (['x.com', 'twitter.com'].includes(u.hostname)) { const id = u.pathname.match(/^\/i\/broadcasts\/([^/]+)/)?.[1]; return id ? `x:${id}` : null; }
  } catch { /* no identity */ }
  return null;
}
export function discoverLinkedin(shows, events) {
  const found = {};
  for (const raw of events) {
    const ids = new Set((raw.event?.destinations || []).map(d => broadcastIdentity(d.externalUrl)).filter(Boolean));
    const matches = shows.filter(s => (s.targets || []).some(t => ids.has(t.kind === 'youtube' ? `youtube:${t.videoId}` : t.kind === 'x' && t.broadcastId ? `x:${t.broadcastId}` : null)));
    const destinations = (raw.event?.destinations || []).filter(d => String(d.channelId) === LINKEDIN_CHANNEL && linkedinIdentity(d.externalUrl));
    if (!destinations.length || !matches.length) continue;
    if (matches.length !== 1 || destinations.length !== 1) throw new Error('LinkedIn broadcast has ambiguous episode identity');
    const show = matches[0], destination = destinations[0], identity = linkedinIdentity(destination.externalUrl);
    const previous = found[show.slug];
    if (previous && (previous.urn !== identity.urn || previous.eventId !== raw.event.id)) throw new Error(`Conflicting LinkedIn broadcasts for ${show.slug}`);
    found[show.slug] = { ...identity, account: 'michaelriddering', channelId: LINKEDIN_CHANNEL, eventId: raw.event.id, source: 'restream', discoveredAt: raw.fetchedAt };
  }
  return found;
}
export function readLinkedinSources(root, shows) {
  const directory = join(root, 'data/restream/events');
  const events = existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(directory, f), 'utf8'))) : [];
  return { events, discovered: discoverLinkedin(shows, events) };
}
export function validateMetricImport(input, source, now = Date.now()) {
  if (!source || !input || input.version !== 1 || typeof input.slug !== 'string' || linkedinIdentity(input.url)?.urn !== source.urn) throw new Error('Import must identify one registered LinkedIn broadcast');
  if (!['linkedin-native-export', 'linkedin-owner-reading'].includes(input.source)) throw new Error('Import must name its owner-provided LinkedIn source');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input.observedAt || '') || !Number.isFinite(Date.parse(input.observedAt)) || Date.parse(input.observedAt) > now) throw new Error('Import observedAt must be a real past observation time');
  if (!input.metrics || Array.isArray(input.metrics) || !Object.keys(input.metrics).length || Object.keys(input.metrics).some(k => !METRICS.includes(k))) throw new Error('Import has unsupported or missing metrics');
  for (const [key, value] of Object.entries(input.metrics)) if (!Number.isFinite(value) || value < 0 || (key !== 'watchTimeMinutes' && !Number.isSafeInteger(value))) throw new Error(`Invalid LinkedIn ${key}`);
  return { observedAt: new Date(input.observedAt).toISOString(), source: input.source, metrics: Object.fromEntries(METRICS.filter(k => Object.hasOwn(input.metrics, k)).map(k => [k, input.metrics[k]])) };
}
export function projectLinkedin(source, raw, readings = [], now = Date.now()) {
  if (!source) return null;
  const metrics = Object.fromEntries(METRICS.map(k => [k, null]));
  const latest = readings.filter(r => Date.parse(r.observedAt) <= now).at(-1) || null;
  if (latest) Object.assign(metrics, latest.metrics);
  const messages = raw?.messages?.byChannel?.[source.channelId];
  const number = v => Number.isFinite(v) && v >= 0 ? v : null;
  const stale = latest ? now - Date.parse(latest.observedAt) > 26 * 3600000 : false;
  return { url: source.url, urn: source.urn, state: latest ? stale ? 'stale' : 'ready' : 'awaiting-access', observedAt: latest?.observedAt || null, source: latest?.source || null,
    metrics, liveChat: { messages: number(messages?.messagesTotal), chatters: number(messages?.chattersTotal), observedAt: raw?.fetchedAt || null },
    history: readings.map(r => ({ observedAt: r.observedAt, source: r.source, metrics: { ...r.metrics } })),
    reason: latest ? stale ? 'The saved LinkedIn analytics reading is over a day old.' : null : 'LinkedIn analytics access is not connected. Live chat is captured through Restream.',
    note: 'LinkedIn video plays use its own counting rules. Post impressions are exposure. Live chat is a separate count from post comments and may overlap; never add them. Saved observations do not reconstruct earlier days. LinkedIn viewing metrics are shown separately from the existing YouTube and X view totals and historical scores.' };
}

export function validateLinkedinStore(store, discovered, now = Date.now()) {
  if (store?.version !== 1 || !store.episodes || Array.isArray(store.episodes)) throw new Error('Invalid LinkedIn metric store');
  for (const [slug, entry] of Object.entries(store.episodes)) {
    const source = discovered[slug];
    if (!source || source.urn !== entry.urn || !Array.isArray(entry.readings)) throw new Error('LinkedIn metric store has an unregistered broadcast');
    let prior = '';
    for (const reading of entry.readings) {
      const canonical = validateMetricImport({ version: 1, slug, url: source.url, ...reading }, source, now);
      if (canonical.observedAt !== reading.observedAt || reading.observedAt <= prior) throw new Error('LinkedIn observations must have unique ordered times');
      if (!/^[a-f0-9]{64}$/.test(reading.evidenceSha256 || '') || !Number.isFinite(Date.parse(reading.importedAt)) || Date.parse(reading.importedAt) < Date.parse(reading.observedAt) || Date.parse(reading.importedAt) > now) throw new Error('LinkedIn observation lacks valid import provenance');
      prior = reading.observedAt;
    }
  }
}
