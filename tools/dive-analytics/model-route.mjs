// Every L3 model step — comment classifier, audience feedback, show health,
// recommendations, moment summaries, chapters, critic — calls one model,
// Claude Sonnet 5.5, through the Anthropic Messages API (owner decision
// 2026-09-29). One request shape and one set of stop-reason checks live here so
// no script carries its own model string, fallback provider or response parser.
//
// DIVE_MODEL_TRANSPORT=gateway is the explicit rollback to the Hinterlands
// OpenClaw frontier tier; it is never chosen automatically.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODEL = 'claude-sonnet-5-5';
export const PROVIDER = 'anthropic';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// 429 rate limits and 529 overloads are transient on the API side; one paced
// retry keeps a busy minute from costing the morning's read. Timeouts and 4xx
// are not retried here — each script owns its own content retry.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
// A connection dropped before any reply (seen 2026-09-29 as UND_ERR_SOCKET on
// the owner machine) is retried once too; a timeout is not — the request may
// still be generating, and each script owns its own content retry.
const RESET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN']);
const MAX_RETRY_WAIT_MS = 30_000;
// Replies are streamed (2026-10-16). Node's built-in fetch stops waiting for
// response headers after 300 s whatever signal the caller passes, and an
// unstreamed reply sends none until the model has finished: chapters at xhigh
// over E14 thought past that and failed with UND_ERR_HEADERS_TIMEOUT. A stream
// sends its headers at once and keeps the connection busy, so each step's own
// timeoutMs is the only clock. The events are put back together into the same
// message an unstreamed call returns, and every stop-reason rule reads that.

export function useGateway() {
  const mode = process.env.DIVE_MODEL_TRANSPORT || 'api';
  if (!['api', 'gateway'].includes(mode)) throw new Error('DIVE_MODEL_TRANSPORT must be api or gateway');
  return mode === 'gateway';
}

function apiKey() {
  return process.env.ANTHROPIC_API_KEY?.trim() || '';
}

// True when a model step can run at all. Show health uses this to choose its
// checked deterministic read instead of spending two failing attempts.
export function hasModelCredential() {
  return useGateway() || Boolean(apiKey());
}

// Provider and model a store is stamped with before a call is made (the
// classifier's config hash and golden gate key on this).
export function modelIdentity() {
  return useGateway() ? gatewayConfig() : { provider: PROVIDER, model: MODEL };
}

let client;
async function loadClient() {
  client ||= import(pathToFileURL(process.env.HINTERLANDS_MODEL_CLIENT || join(homedir(), 'Dev/2026/hinterlands/scripts/openclaw/model-completion.mjs')).href);
  return client;
}

// Read the OpenClaw catalog only in gateway mode; API runs and deterministic
// imports need no OpenClaw installation.
export function gatewayConfig() {
  const cfg = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw/openclaw.json'), 'utf8'));
  const targets = Object.entries(cfg.agents?.defaults?.models || {}).filter(([, v]) => v.alias === 'frontier');
  if (targets.length !== 1) throw new Error('OpenClaw frontier tier is unavailable');
  const [provider, ...model] = targets[0][0].split('/');
  return { provider, model: model.join('/') };
}

async function gatewayModel(system, messages, { timeoutMs, maxTokens }) {
  const { completeModel: complete } = await loadClient();
  return complete({ system, messages, tier: 'frontier', timeoutMs, maxTokens });
}

function waitMs(response) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 5_000;
}

async function errorType(response) {
  try { return (await response.json())?.error?.type || null; } catch { return null; }
}

// only a system error code (ECONNRESET, UND_ERR_…) is named — never the error
// text, which can carry request or response content
function errorCode(error) {
  return [error?.cause?.code, error?.code].find((c) => typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(c));
}

function transportError(label, error) {
  const code = errorCode(error);
  return new Error(`${label}: Anthropic request failed or timed out (${error?.name || 'error'}${code ? ` ${code}` : ''})`);
}

const word = (value) => (typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown');

// Server-sent events, each data payload parsed; a payload that is not JSON is
// a malformed reply, never skipped.
async function* sseEvents(body, label) {
  const decoder = new TextDecoder();
  const parse = (raw) => {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null;
    try { return JSON.parse(data); } catch { throw Object.assign(new Error(`${label}: Anthropic returned a malformed stream event`), { reply: true }); }
  };
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
      const event = parse(buffer.slice(0, end));
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      if (event) yield event;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

// The streamed events rebuilt into the message an unstreamed call returns:
// every content block in order (thinking text and signature included, so a
// retry can pass them back unchanged), stop_reason and stop_details from
// message_delta. A stream that ends before message_stop is incomplete.
async function readStream(response, label) {
  const fail = (why) => Object.assign(new Error(`${label}: ${why}`), { reply: true });
  let message = null;
  let stopped = false;
  try {
    for await (const event of sseEvents(response.body, label)) {
      if (event?.type === 'error') throw fail(`Anthropic stream error ${word(event.error?.type)}`);
      if (event?.type === 'ping' || event?.type === 'content_block_stop') continue;
      if (event?.type === 'message_start') { message = { ...event.message, content: [] }; continue; }
      if (!message) throw fail('Anthropic stream did not start with message_start');
      if (event.type === 'content_block_start') message.content[event.index] = { ...event.content_block };
      else if (event.type === 'content_block_delta') {
        const block = message.content[event.index];
        const delta = event.delta || {};
        if (!block) throw fail('Anthropic stream sent a delta for a block it never started');
        if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
        else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else throw fail(`Anthropic stream sent an unexpected ${word(delta.type)}`);
      } else if (event.type === 'message_delta') {
        Object.assign(message, event.delta);
        message.usage = { ...message.usage, ...event.usage };
      } else if (event.type === 'message_stop') stopped = true;
    }
  } catch (error) {
    throw error.reply ? error : transportError(label, error);
  }
  if (!stopped) throw fail('incomplete reply (the stream ended before message_stop)');
  return message;
}

// One completed reply or a thrown reason. Returns the reply text, the full
// content blocks (a retry that continues the conversation passes them back
// unchanged, thinking blocks included), and the model that actually answered.
export async function completeModel(system, messages, {
  maxTokens = 16_000, timeoutMs = 180_000, effort = 'high', label = 'model',
  fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (useGateway()) {
    const reply = await gatewayModel(system, messages, { timeoutMs, maxTokens });
    return { ...reply, content: null };
  }
  const key = apiKey();
  if (!key) throw new Error(`${label}: ANTHROPIC_API_KEY not set`);
  if (!EFFORTS.has(effort)) throw new Error(`${label}: unknown effort ${effort}`);
  const request = {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
    // Adaptive thinking is this model's default; effort is stated so a change
    // in the API default never silently changes how hard a step thinks.
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages, output_config: { effort }, stream: true }),
  };
  let body;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // one signal per attempt bounds the headers and the whole streamed body
    let response;
    try { response = await fetchImpl(API_URL, { ...request, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
      if (attempt === 1 && RESET_CODES.has(errorCode(error))) { await sleep(2_000); continue; }
      throw transportError(label, error);
    }
    if (!response.ok) {
      if (attempt === 1 && RETRYABLE.has(response.status)) { await sleep(waitMs(response)); continue; }
      const type = await errorType(response);
      throw new Error(`${label}: Anthropic HTTP ${response.status}${type ? ` ${type}` : ''} after ${attempt} attempt(s)`);
    }
    // An error event or a dropped connection once the stream has begun is not
    // retried: the request has already spent its time (one more long chapters
    // read could outlast the chain's own limit), and each script owns its retry.
    if (/text\/event-stream/i.test(response.headers?.get?.('content-type') || '')) body = await readStream(response, label);
    else {
      // a reply that is not a stream is one whole message (the unstreamed
      // shape the other scripts' test doubles answer with)
      try { body = await response.json(); }
      catch { throw new Error(`${label}: Anthropic returned malformed JSON`); }
    }
    break;
  }
  const blocks = Array.isArray(body?.content) ? body.content : [];
  if (body?.stop_reason === 'refusal') {
    throw new Error(`${label}: Claude declined the request (${body.stop_details?.category || 'no category'})`);
  }
  if (body?.stop_reason === 'max_tokens') throw new Error(`${label}: reply was cut off at ${maxTokens} tokens`);
  if (body?.stop_reason !== 'end_turn') throw new Error(`${label}: incomplete reply (stop_reason ${body?.stop_reason ?? 'missing'})`);
  const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (!text.trim()) throw new Error(`${label}: empty reply (blocks ${JSON.stringify(blocks.map((b) => b.type))})`);
  return { text, content: blocks, provider: PROVIDER, model: body.model || MODEL, stopReason: body.stop_reason, usage: body.usage || null };
}
