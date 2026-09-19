import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function installGatewayFixture(temp) {
  if (process.env.DIVE_TEST_GATEWAY !== '1') return;
  process.env.DIVE_MODEL_TRANSPORT = 'gateway';
  process.env.OPENCLAW_CONFIG_PATH = join(temp, 'gateway-config.json');
  process.env.HINTERLANDS_MODEL_CLIENT = join(temp, 'gateway-client.mjs');
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ agents: { defaults: { models: { 'openai/fixture-model': { alias: 'frontier' } } } } }));
  writeFileSync(process.env.HINTERLANDS_MODEL_CLIENT, `
export async function completeModel({system,messages,maxTokens,timeoutMs}) {
 if(process.env.DIVE_FIXTURE_MODE==='missing-key') throw new Error('fixture gateway auth unavailable');
 let body;
 try {
  const response=await fetch('https://fixture.invalid/model', {method:'POST',body:JSON.stringify({system,messages,max_tokens:maxTokens}),signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok) throw new Error('http');
  body=await response.json();
 } catch { throw new Error('fixture gateway request failed'); }
 if(body.stop_reason && body.stop_reason!=='end_turn') throw new Error('incomplete response');
 return {text:(body.content||[]).map(b=>b.text||'').join('\\n'),provider:'openai',model:'fixture-model',stopReason:'end_turn'};
}
`);
}
