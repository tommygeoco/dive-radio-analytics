import assert from 'node:assert/strict';
import { callClassifications } from '../../../scripts/restream/comments-classify.mjs';
const ids = ['yt:UgwJM-SZIdGK63JhdJR4AaABAg.AadOSAVLodyAaeExtremelyLongSuffix', 'yt:UgzbzoCNlRcq0tHKW3p4AaABAg'];
const comments = ids.map((id,i) => ({id,text:`Full comment ${i}`,original:{confidence:0.9}}));
const label = id => ({id,relevance:'feedback',sentiment:'positive',themes:['value'],confidence:0.9});
// Use a real vocabulary entry while preserving the exact parsing contract.
import { THEME_VOCABULARY } from '../../../scripts/restream/comments-classify.mjs';
const row = id => ({...label(id),themes:[THEME_VOCABULARY[0]]});
const got = await callClassifications('same prompt',{task:'second read',comments},{call:async(prompt,payload)=>{
  assert.equal(prompt,'same prompt');assert.deepEqual(payload.comments,comments.map((c,i)=>({...c,id:`c${i}`})));
  return {text:JSON.stringify({classifications:[row('c1'),row('c0')]})};
}});
assert.deepEqual(got.map(r=>r.id),[ids[1],ids[0]],'reordered replies restore exact native IDs');
for(const rows of [[row('c0'),row('c0')],[row('c0')],[row('c0'),row(ids[1])]]) {
  await assert.rejects(callClassifications('p',{comments},{call:async()=>({text:JSON.stringify({classifications:rows})})}),/duplicate id|returned 1 of 2/);
}
console.log('classifier-id-transport: native IDs preserved; malformed, missing and duplicate aliases rejected');
