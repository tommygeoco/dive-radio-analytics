import { linkedinIdentity } from './linkedin.mjs';
import { createHash } from 'node:crypto';
import { THEME_VOCABULARY, CLASSIFIER_VERSION, PROMPT_VERSION } from '../../scripts/restream/comments-classify.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const fields = new Set(['id', 'source', 'author', 'text', 'platform', 'channel', 'at', 'url', 'likes', 'capturedAt', 'contentHash', 'label']);
const labelFields = new Set(['state', 'relevance', 'sentiment', 'themes', 'confidence', 'configHash', 'classifiedAt']);
const sentiments = new Set(['positive', 'negative', 'mixed']);
export function validateAudienceStore(store, { promptHash } = {}) {
  const errors = [];
  if (store?.version !== 1 || !Number.isFinite(Date.parse(store.updatedAt)) || !store.episodes || !store.configurations) return ['audience store header is invalid'];
  for (const [key, config] of Object.entries(store.configurations)) {
    const expected = sha(JSON.stringify({ version: config.classifierVersion, promptVersion: config.promptVersion, promptHash: config.promptHash, model: config.model, provider: config.provider, vocabulary: THEME_VOCABULARY }));
    if (key !== expected || config.configHash !== key || config.classifierVersion !== CLASSIFIER_VERSION || config.promptVersion !== PROMPT_VERSION || (promptHash && promptHash !== config.promptHash)
      || !config.golden?.passed || config.golden.configHash !== key || config.golden.relevance?.pct !== 100 || !(config.golden.sentiment?.pct >= 95)) errors.push('audience classifier configuration lacks its passing golden gate');
  }
  for (const [slug, episode] of Object.entries(store.episodes)) {
    if (!Array.isArray(episode.list) || !episode.sources) { errors.push(`${slug}: audience source rows are invalid`); continue; }
    if (!Number.isInteger(episode.processing?.pending) || episode.processing.pending < 0 || !Number.isInteger(episode.processing?.review) || episode.processing.review < 0) errors.push(`${slug}: audience processing state is invalid`);
    for (const reading of Object.values(episode.sources)) if (!['ready', 'failed', 'pending', 'missing'].includes(reading.state) || !Number.isFinite(Date.parse(reading.checkedAt))) errors.push(`${slug}: audience source check is invalid`);
    const seen = new Set();
    for (const row of episode.list) {
      const label = row.label;
      if (!row.id || seen.has(row.id)) errors.push(`${slug}: duplicate or missing audience id`); seen.add(row.id);
      if (Object.keys(row).some(key => !fields.has(key))) errors.push(`${slug}: private or unknown audience field`);
      if (!['x', 'live-chat'].includes(row.source) || !row.author || typeof row.text !== 'string' || !row.text.trim() || sha(row.text) !== row.contentHash) errors.push(`${slug}: audience text provenance is invalid`);
      if (!Number.isFinite(Date.parse(row.at)) || !Number.isFinite(Date.parse(row.capturedAt))) errors.push(`${slug}: audience timestamps are invalid`);
      if (row.likes !== null && (!Number.isInteger(row.likes) || row.likes < 0)) errors.push(`${slug}: audience likes are invalid`);
      if (row.source === 'x' && (row.url !== `https://x.com/i/status/${row.id.slice(2)}` || !/^x:\d+$/.test(row.id) || /^(designertom|ridd_design)$/i.test(row.author.replace(/^@/, '')))) errors.push(`${slug}: X source or author is invalid`);
      if (row.source === 'live-chat' && (!/^chat:[a-f0-9]{64}:\d+$/.test(row.id) || (row.url && !(row.platform === 'LinkedIn' && linkedinIdentity(row.url)) && !/^https:\/\/(?:x\.com|www\.youtube\.com|youtu\.be)\//.test(row.url)))) errors.push(`${slug}: live-chat provenance is invalid`);
      if (!label || Object.keys(label).some(key => !labelFields.has(key)) || label.state !== 'ready' || label.relevance !== 'feedback' || !sentiments.has(label.sentiment) || !(label.confidence >= 0.8 && label.confidence <= 1) || !store.configurations[label.configHash]
        || !Number.isFinite(Date.parse(label.classifiedAt)) || !Array.isArray(label.themes) || label.themes.length < 1 || label.themes.length > 2 || label.themes.some(theme => !THEME_VOCABULARY.includes(theme))) errors.push(`${slug}: uncertain or invalid audience label reached the public store`);
    }
  }
  return errors;
}
