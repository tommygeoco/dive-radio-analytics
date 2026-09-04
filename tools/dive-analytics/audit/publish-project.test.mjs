import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertProductionProject, PRODUCTION_PROJECT} from '../publish-flow.mjs';
const root=mkdtempSync(join(tmpdir(),'dive-project-fixture-'));
try {
  assert.throws(()=>assertProductionProject(root,{}),/missing or unreadable/);
  mkdirSync(join(root,'.vercel'));
  const path=join(root,'.vercel/project.json');
  writeFileSync(path,'not JSON');
  assert.throws(()=>assertProductionProject(root,{}),/missing or unreadable/);
  for(const field of ['projectId','orgId']) {
    writeFileSync(path,JSON.stringify({...PRODUCTION_PROJECT,[field]:'different'}));
    assert.throws(()=>assertProductionProject(root,{}),/differs/);
  }
  writeFileSync(path,JSON.stringify(PRODUCTION_PROJECT));
  assert.deepEqual(assertProductionProject(root,{}),PRODUCTION_PROJECT);
  for(const variable of ['VERCEL_PROJECT_ID','VERCEL_ORG_ID']) assert.throws(()=>assertProductionProject(root,{[variable]:'different'}),/differs/);
  assert.deepEqual(assertProductionProject(root,{VERCEL_PROJECT_ID:PRODUCTION_PROJECT.projectId,VERCEL_ORG_ID:PRODUCTION_PROJECT.orgId}),PRODUCTION_PROJECT);
} finally { rmSync(root,{recursive:true,force:true}); }
console.log('publish-project: missing, malformed, wrong project/org and environment overrides rejected; verified identity accepted');
