// OAuth/API selection is owned by Hinterlands' gateway. Explicit direct-api mode
// retains the old per-script API implementations for rollback and offline fixtures.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function useGateway() {
  const mode = process.env.DIVE_MODEL_TRANSPORT || 'gateway';
  if (!['gateway', 'direct-api'].includes(mode)) throw new Error('DIVE_MODEL_TRANSPORT must be gateway or direct-api');
  return mode === 'gateway';
}
let client;
async function loadClient() {
  client ||= import(pathToFileURL(process.env.HINTERLANDS_MODEL_CLIENT || join(homedir(), 'Dev/2026/hinterlands/scripts/openclaw/model-completion.mjs')).href);
  return client;
}
// Read the native catalog only when model metadata is requested; API fixtures
// and deterministic imports do not need an OpenClaw installation.
import { readFileSync } from 'node:fs';
export function gatewayConfig() {
  const cfg = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw/openclaw.json'), 'utf8'));
  const targets = Object.entries(cfg.agents?.defaults?.models || {}).filter(([,v]) => v.alias === 'frontier');
  if (targets.length !== 1) throw new Error('OpenClaw frontier tier is unavailable');
  const [provider, ...model] = targets[0][0].split('/');
  return { provider, model: model.join('/') };
}
export async function gatewayModel(system, messages, { timeoutMs = 180000, maxTokens = 16000 } = {}) {
  const { completeModel } = await loadClient();
  return completeModel({ system, messages, tier: 'frontier', timeoutMs, maxTokens });
}
