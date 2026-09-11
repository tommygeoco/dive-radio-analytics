// Pure display projection. Expanded chat/thread feedback never changes scored cohorts.
import { hasNegativeSignal } from '../../scripts/restream/comments-sentiment.mjs';
const directional = new Set(['positive', 'negative', 'mixed']);
const compare = (a, b) => (b.likes ?? 0) - (a.likes ?? 0) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id);
export function audienceView(comments, archive, { now, commentState } = {}) {
  if (!archive) return null;
  const rows = new Map((comments?.list || []).map(row => [row.id, { ...row, platform: row.source === 'yt' ? 'YouTube' : 'X', channel: null, url: row.source === 'x' ? `https://x.com/i/status/${row.id.slice(2)}` : null }]));
  for (const row of archive.list || []) {
    if (row.label?.state !== 'ready' || row.label.relevance !== 'feedback' || row.label.confidence < 0.8 || !directional.has(row.label.sentiment)) continue;
    rows.set(row.id, { id: row.id, source: row.source, author: row.author, text: row.text, platform: row.platform, channel: row.channel, at: row.at, url: row.url, likes: row.likes, sentiment: row.label.sentiment, themes: row.label.themes });
  }
  const list = [...rows.values()].sort(compare);
  const notices = [];
  const names = { x: 'X threads', 'live-chat': 'Live chat' };
  for (const [source, reading] of Object.entries(archive.sources || {})) {
    const stale = now && new Date(now).getTime() - Date.parse(reading.checkedAt) > 26 * 3600000;
    if (reading.state !== 'ready' || stale) notices.push(`${names[source] || source}: ${stale ? 'the last capture is over a day old' : 'the latest capture is incomplete'}. Showing saved feedback.`);
  }
  if (commentState && commentState.state !== 'ready') notices.push('YouTube comments and direct replies: the latest capture is incomplete. Showing saved feedback.');
  if (archive.processing?.pending > 0) notices.push('More captured comments are still being processed.');
  if (archive.processing?.review > 0) notices.push('Some comments are awaiting review.');
  return {
    count: list.length,
    positiveCount: list.filter(r => r.sentiment === 'positive' || r.sentiment === 'mixed').length,
    negativeCount: list.filter(r => r.sentiment === 'negative' || r.sentiment === 'mixed').length,
    featured: list.filter(r => r.sentiment === 'positive' && r.text.length >= 8 && !hasNegativeSignal(r.text)).slice(0, 3),
    list,
    sources: archive.sources,
    notices,
    note: 'Comments from YouTube, X threads and live chat. Counts are messages, not distinct people. Live-chat names are supplied by Restream.',
  };
}
