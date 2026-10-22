import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createLocalApi } from '../dist/server.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const pkg=process.env.LMTI_WEB_TEST_PACKAGE;
const project='factory-monitor', P='/api/v1/projects/'+project+'/project-operations',L='/api/v1/library/project-operations';
const available=process.platform==='win32'&&process.env.LMTI_WEB_TEST_BINDING_PRODUCER&&process.env.LMTI_WEB_TEST_ADMIN&&process.env.LMTI_WEB_TEST_PYTHON&&process.env.LMTI_WEB_TEST_CONFIG_OWNER;
async function fixture(t,schema=2,maintenance=true){
  assert.ok(available,'Real native/Python fixture configuration is required.');
  const root=await mkdtemp(join(tmpdir(),'lmti-operations-http-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  const generated=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'1',String(schema)],{encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8192});
  assert.equal(generated.status,0,'Native fixture producer must succeed');
  const copyParent=join(root,'http-copies'),backupParent=join(root,'http-backups');await mkdir(copyParent);await mkdir(backupParent);
  const cfg={adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY,
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),python:process.env.LMTI_WEB_TEST_PYTHON,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects:[project,'removed-project'],port:0,openBrowser:false,
    projectOperations:{copyParent,backupParent,projectIds:[project,'removed-project'],allowLibraryUpgrade:maintenance}};
  const api=await createLocalApi(cfg);t.after(()=>api.close());
  async function session(){
    const nonce=new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
    const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
    async function request(path,method='GET',body){
      const response=await fetch(api.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const value=await response.json();
      const text=JSON.stringify(value);
      assert.equal(text.includes(root),false,'Public response must not contain trusted local paths');
      assert.equal(text.includes(root.replaceAll('\\','/')),false);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text),false,'Native UUID stays private');
      return {http:response.status,...value};
    }
    const boot=await request('/api/v1/session/bootstrap','POST',{nonce});assert.equal(boot.http,200);
    headers.Authorization=`Bearer ${boot.data.token}`;return request;
  }
  return {root,cfg,api,request:await session(),session};
}
async function confirmed(request,route,preview){
  assert.equal(preview.http,200);
  let result=await request(route+'/commits','POST',{previewId:preview.data.id});
  assert.equal(result.http,200);
  assert.equal(result.data.outcome,'confirmed',JSON.stringify(result));
  assert.match(result.data.operationId,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await request(route+'/commits','POST',{previewId:preview.data.id})).http,410);
  const job=await request('/api/v1/operations/'+result.data.operationId);
  assert.equal(job.data.state,'succeeded');
  return result.data;
}
test('HTTP native flow upgrades, copies, prepares, abandons and activates schema 1/2 without public path authority',{timeout:120000},async t=>{
  for(const schema of [1,2]){
    const f=await fixture(t,schema),r=f.request,original=await readFile(join(f.root,'project.sqlite'));
    const scope=await r('/api/v1/project-operation-scopes');assert.deepEqual(scope.data.projectIds,[project,'removed-project']);
    assert.equal((await r('/api/v1/write-status')).data.admitted,true);
    for(const fromSchema of [1,2]){
      const result=await confirmed(r,L,await r(L+'/previews','POST',{fromSchema}));
      assert.equal(result.summary.toSchema,fromSchema+1);
    }
    const status=await r(P);assert.equal(status.data.projectSchema,schema);
    const copy=await confirmed(r,P,await r(P+'/copy-previews','POST',{mode:schema===1?'migrate_v1':'clone_v2'}));
    assert.ok(copy.recoveryHandle);
    const recovered=await r(P+'/recovery/'+copy.recoveryHandle);assert.equal(recovered.data.kind,'copy');assert.equal(recovered.data.canPrepare,true);
    const page=await r(P+'/copies','POST',{limit:50,cursor:null});assert.equal(page.data.items.length,1);
    const prepareA=await confirmed(r,P,await r(P+'/activation-previews','POST',{copyHandle:copy.recoveryHandle}));
    assert.equal(prepareA.summary.state,'prepared');
    const abandoned=await confirmed(r,P,await r(P+'/decision-previews','POST',{activationHandle:prepareA.recoveryHandle,decision:'abandon'}));
    assert.equal(abandoned.summary.state,'abandoned');
    const prepareB=await confirmed(r,P,await r(P+'/activation-previews','POST',{copyHandle:copy.recoveryHandle}));
    const activated=await confirmed(r,P,await r(P+'/decision-previews','POST',{activationHandle:prepareB.recoveryHandle,decision:'activate'}));
    assert.equal(activated.summary.state,'activated');
    const history=await r(P+'/activations','POST',{limit:50,cursor:null});
    assert.equal(history.data.items.length,2);assert.deepEqual(history.data.items.map(i=>i.state).sort(),['abandoned','activated']);
    assert.deepEqual(await readFile(join(f.root,'project.sqlite')),original);
  }
});
test('HTTP exact shape, session binding, expiry, rejected previews and explicit grant denial',{timeout:60000},async t=>{
  const f=await fixture(t,2,false),r=f.request;
  assert.equal((await r(L)).http,403);
  assert.equal((await r('/api/v1/projects/not-granted/project-operations')).http,403);
  assert.equal((await r(P+'/copy-previews','POST',{mode:'clone_v2',source:'untrusted'})).http,400);
  const preview=await r(P+'/copy-previews','POST',{mode:'clone_v2'});assert.equal(preview.http,200);
  const other=await f.session();
  assert.equal((await other(P+'/commits','POST',{previewId:preview.data.id})).http,410);
  assert.equal((await r(P+'/previews/'+preview.data.id,'DELETE')).data.rejected,true);
  assert.equal((await r(P+'/commits','POST',{previewId:preview.data.id})).http,410);
  const fresh=await r(P+'/copy-previews','POST',{mode:'clone_v2'});
  await r('/api/v1/session','DELETE');
  assert.equal((await other(P+'/commits','POST',{previewId:fresh.data.id})).http,410);
});
