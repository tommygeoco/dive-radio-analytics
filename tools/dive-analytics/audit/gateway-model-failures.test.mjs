import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const name of ['model-failures', 'verification-failures', 'recommendation-bindings']) {
 const r=spawnSync(process.execPath,[fileURLToPath(new URL(`./${name}.test.mjs`,import.meta.url))],{encoding:'utf8',timeout:120000,env:{...process.env,DIVE_TEST_GATEWAY:'1'}});
 assert.equal(r.status,0,`${name} gateway path: ${r.stdout} ${r.stderr}`);
}
console.log('gateway-model-failures: native-client fixtures preserve stores, retries, grounding and critic completeness');
