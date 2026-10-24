import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalApi } from '../dist/server.js';
import { ProcessPool } from '../dist/process.js';

const project='factory-monitor',route='/api/v1/projects/'+project+'/physical-hierarchy';
async function fixture(t,{physical=true,logical=false,operations=false}={}) {
  assert.equal(process.platform,'win32');
  for(const key of ['LMTI_WEB_TEST_BINDING_PRODUCER','LMTI_WEB_TEST_ADMIN','LMTI_WEB_TEST_PROJECT_BINARY',
    'LMTI_WEB_TEST_PYTHON','LMTI_WEB_TEST_CONFIG_OWNER'])
    assert.ok(process.env[key],key+' must select the verified increment23 runtime/input.');
  const base=resolve(process.env.LMTI_WEB_TEST_TMP??tmpdir());
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'physical-http-Đường-')),apis=[];
  t.after(async()=>{
    for(const api of apis)await api.close();
    assert.ok(resolve(root).startsWith(base+sep));await rm(root,{recursive:true,force:true});
  });
  // Only the fixed fixture producer needs PATH for its installed Qt runtime.
  const env={};
  for(const key of ['SystemRoot','WINDIR','PATH'])if(process.env[key])env[key]=process.env[key];
  const generated=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'3','2'],
    {env,encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:8192});
  assert.equal(generated.status,0,'The fixed native fixture producer must succeed.');
  const config={adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY,
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),python:process.env.LMTI_WEB_TEST_PYTHON,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),
    configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,allowedProjects:[project,'other'],port:0,openBrowser:false,
    ...(physical?{physicalHierarchy:{projects:[{projectId:project,allowInternal:true}]}}:{}),
    ...(logical?{logicalHierarchy:{projects:[{projectId:project,allowInternal:true}]}}:{})};
  if(operations) {
    const copyParent=join(root,'http-copies'),backupParent=join(root,'http-backups');
    await mkdir(copyParent);await mkdir(backupParent);
    config.projectOperations={copyParent,backupParent,projectIds:['other'],allowLibraryUpgrade:true};
  }
  async function session(api) {
    const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
    async function request(path,method='GET',body) {
      const response=await fetch(api.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const raw=await response.text(),value=JSON.parse(raw);
      assert.ok(Buffer.byteLength(raw)<=256*1024);
      assert.equal(raw.includes(root),false);assert.equal(raw.includes(root.replaceAll('\\','/')),false);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw),false);
      assert.equal(/"(?:canonicalPath|storeUuid|proposalDigest|diffDigest|contentDigest|registryDigest|physical|chain|reviewToken)"\s*:/.test(raw),false);
      return {http:response.status,...value};
    }
    const nonce=new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
    const bootstrap=await request('/api/v1/session/bootstrap','POST',{nonce});
    assert.equal(bootstrap.http,200);headers.Authorization='Bearer '+bootstrap.data.token;
    return request;
  }
  async function start() {const api=await createLocalApi(config);apis.push(api);return {api,request:await session(api)};}
  return {root,config,start,session,...await start()};
}
async function idle(request,unknown=false) {
  for(let attempt=0;attempt<240;attempt++) {
    const result=await request('/api/v1/write-status');assert.equal(result.http,200);
    assert.deepEqual(Object.keys(result.data).sort(),['activeWrites','admitted','projectOperations','recoveryRequired']);
    assert.equal(result.data.admitted,true);
    if(result.data.activeWrites===0){assert.equal(result.data.recoveryRequired,unknown);return;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('The child and marker cleanup must drain.');
}
async function completed(request,response) {
  assert.ok([200,202].includes(response.http),JSON.stringify(response));
  if(response.data.outcome!=='pending')return response.data;
  for(let attempt=0;attempt<240;attempt++) {
    const job=await request('/api/v1/operations/'+response.data.operationId);assert.equal(job.http,200);
    if(job.data.state!=='pending')return job.data.result;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Controlled physical commit did not finish.');
}
const addSite=(revision,id)=>({proposal:{projectId:project,expectedRevision:revision,
  changes:[{kind:'add_site',desired:{id,label:'Khu vực được duyệt',privacy:'internal'}}]}});

test('native physical HTTP batch rejects/reviews once, preserves unrelated files and invalidates logical review',
  {timeout:90000},async t=>{
    const f=await fixture(t,{logical:true}),r=f.request;
    const beforeLibrary=await readFile(f.config.library),beforeProfile=await readFile(f.config.profiles);
    assert.deepEqual((await r('/api/v1/physical-hierarchy-scopes')).data,{projects:[{projectId:project,allowInternal:true}]});
    assert.equal((await r('/api/v1/projects/other/physical-hierarchy')).http,403);
    const current=await r(route);assert.equal(current.http,200);const state=current.data;
    const asset=state.assets.find(row=>row.value.site==='factory-demo');assert.ok(asset);
    const batch={proposal:{projectId:project,expectedRevision:state.revision,changes:[
      {kind:'add_area',desired:{id:'reviewed-area',label:'Tầng được duyệt',siteId:'factory-demo',parentAreaId:'',privacy:'internal'}},
      {kind:'add_environment',desired:{id:'reviewed-environment',label:'Môi trường được duyệt',privacy:'internal'}},
      {kind:'set_asset_placement',expectedAsset:asset.value,expected:asset.placement,
        desired:{assetId:asset.value.id,areaId:'reviewed-area',parentAssetId:'',environmentId:'reviewed-environment',role:null}}
    ]}};
    const logicalRoute='/api/v1/projects/'+project+'/logical-hierarchy';
    const logical=await r(logicalRoute+'/previews','POST',{proposal:{projectId:project,expectedRevision:state.revision,
      changes:[{kind:'add_subsystem',desired:{id:'old-logical-review',label:'Old logical review',parentSubsystemId:'',privacy:'internal'}}]}});
    assert.equal(logical.http,200);
    const rejected=await r(route+'/previews','POST',batch);assert.equal(rejected.http,200);
    assert.equal((await r(route+'/previews/'+rejected.data.id,'DELETE')).data.rejected,true);
    assert.equal((await r(route+'/commits','POST',{previewId:rejected.data.id})).http,410);
    assert.equal((await r(route)).data.revision,state.revision);
    const preview=await r(route+'/previews','POST',batch);assert.equal(preview.http,200);
    assert.equal(preview.data.diff.areas[0].after.id,'reviewed-area');
    assert.equal(preview.data.diff.placements[0].after.role,null);
    const other=await f.session(f.api);
    assert.equal((await other(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    const outcome=await completed(r,await r(route+'/commits','POST',{previewId:preview.data.id}));
    assert.equal(outcome.outcome,'confirmed');assert.equal(outcome.summary.revision,state.revision+1);await idle(r);
    assert.equal((await r(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    assert.equal((await r(logicalRoute+'/commits','POST',{previewId:logical.data.id})).http,410);
    const after=(await r(route)).data;assert.equal(after.revision,state.revision+1);
    assert.equal(after.assets.find(row=>row.value.id===asset.value.id).placement.areaId,'reviewed-area');
    assert.equal(after.assets.find(row=>row.value.id===asset.value.id).placement.role,null);
    assert.equal(after.environments.find(row=>row.value.id==='reviewed-environment').classification,'internal');
    assert.deepEqual(await readFile(f.config.library),beforeLibrary);
    assert.deepEqual(await readFile(f.config.profiles),beforeProfile);
  });

test('physical-only plus operations uses generic complete recovery after a real commit with corrupted received ACK',
  {timeout:120000},async t=>{
    const f=await fixture(t,{operations:true}),r=f.request,current=await r(route);
    assert.equal(current.http,200);assert.equal((await r('/api/v1/logical-hierarchy-scopes')).http,501);
    const preview=await r(route+'/previews','POST',addSite(current.data.revision,'unknown-physical-site'));
    assert.equal(preview.http,200);
    const write=ProcessPool.prototype.runWrite;let corrupted=0;
    ProcessPool.prototype.runWrite=async function(binary,args,input,options) {
      const result=await write.call(this,binary,args,input,options);
      if(binary===f.config.adminBinary&&args[0]==='--physical-hierarchy-write') {
        assert.equal(result.kind,'closed');assert.equal(result.transportOk,true);
        assert.equal(JSON.parse(result.bytes.toString('utf8')).outcome,'confirmed');
        corrupted++;return {...result,bytes:Buffer.from('{"incomplete":true}\n')};
      }
      return result;
    };
    let outcome;
    try {outcome=await completed(r,await r(route+'/commits','POST',{previewId:preview.data.id}));}
    finally {ProcessPool.prototype.runWrite=write;}
    assert.equal(corrupted,1);assert.equal(outcome.outcome,'unknown');await idle(r,true);
    assert.equal((await r('/api/v1/operations/'+outcome.operationId)).data.state,'unknown');
    assert.equal((await r(route+'/previews','POST',addSite(current.data.revision+1,'blocked'))).error.code,'RECOVERY_REQUIRED');
    assert.ok((await r(route)).data.sites.some(row=>row.value.id==='unknown-physical-site'));
    // Recreate the API in this process after close. This is not a process kill
    // or an orphan-writer claim; the real fixed marker participates normally.
    await f.api.close();const next=await f.start(),fresh=next.request;
    await idle(fresh,true);
    assert.equal((await fresh('/api/v1/projects/'+project+'/project-operations')).http,403);
    const review=await fresh('/api/v1/recovery-previews','POST',{});assert.equal(review.http,200);
    assert.deepEqual(Object.keys(review.data).sort(),['coverage','expiresAt','hierarchyItems','id','items','physicalHierarchyItems','priorOutcome']);
    assert.deepEqual(review.data.items,[]);assert.deepEqual(review.data.hierarchyItems,[]);
    assert.deepEqual(review.data.physicalHierarchyItems,[{projectId:project,projectRevision:current.data.revision+1}]);
    assert.deepEqual(review.data.coverage,{retainedSubjects:1,affectedScopes:[{
      kind:'physical_hierarchy',action:'physical-hierarchy-commit',projectId:project,subjects:1}],librarySchema:3});
    assert.equal((await fresh('/api/v1/write-status')).data.recoveryRequired,true);
    const acknowledged=await fresh('/api/v1/recoveries','POST',{previewId:review.data.id});
    assert.equal(acknowledged.http,200);
    assert.deepEqual(acknowledged.data,{reviewed:true,priorOutcome:'unknown',freshReviewRequired:true});
    await idle(fresh);
    assert.equal((await fresh(route+'/commits','POST',{previewId:preview.data.id})).http,410);
  });

test('logical and operation grants do not create physical routes or capability', {timeout:60000},async t=>{
  const f=await fixture(t,{physical:false,logical:true,operations:true});
  assert.equal((await f.request('/api/v1/physical-hierarchy-scopes')).http,501);
  assert.equal((await f.request(route)).http,501);
  assert.equal((await f.request('/api/v1/logical-hierarchy-scopes')).http,200);
  const summary=await f.request('/api/v1/projects/'+project);assert.equal(summary.http,200);
  assert.equal(summary.data.capabilities.includes('physical.hierarchy'),false);
  assert.equal(summary.data.capabilities.includes('logical.hierarchy'),true);
  await idle(f.request);
});

// This deliberately changes the selected native file inside the actual final
// ProcessPool guard. It is a pre-dispatch guard case, not queue-occupancy proof.
test('native physical HTTP pre-dispatch guard refuses same-path original-project replacement without a writer',
  {timeout:90000},async t=>{
    const f=await fixture(t),r=f.request,current=await r(route);
    assert.equal(current.http,200);
    const projectFile=join(f.root,'project.sqlite'),replacementFile=join(f.root,'replacement-project.sqlite');
    const beforeProject=await readFile(projectFile),beforeReplacement=await readFile(replacementFile);
    const beforeLibrary=await readFile(f.config.library),beforeProfile=await readFile(f.config.profiles);
    const preview=await r(route+'/previews','POST',addSite(current.data.revision,'must-not-be-written'));
    assert.equal(preview.http,200);
    const write=ProcessPool.prototype.runWrite;
    let requests=0,guardCalls=0,started=0,transportKind=null;
    ProcessPool.prototype.runWrite=async function(binary,args,input,options) {
      if(binary!==f.config.adminBinary||args[0]!=='--physical-hierarchy-write')
        return write.call(this,binary,args,input,options);
      requests++;assert.equal(typeof options.guard,'function');
      const result=await write.call(this,binary,args,input,{...options,guard:async()=>{
        guardCalls++;assert.equal(guardCalls,1);
        const env={};
        for(const key of ['SystemRoot','WINDIR','PATH'])if(process.env[key])env[key]=process.env[key];
        const mutation=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,
          ['--mutate',f.root,'replace-project'],
          {env,encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:8192});
        assert.equal(mutation.status,0,'The fixed disposable fixture replacement must succeed.');
        await options.guard();
      },onStarted:()=>{started++;options.onStarted?.();}});
      transportKind=result.kind;return result;
    };
    let outcome;
    try {outcome=await completed(r,await r(route+'/commits','POST',{previewId:preview.data.id}));}
    finally {ProcessPool.prototype.runWrite=write;}
    assert.equal(requests,1);assert.equal(guardCalls,1);assert.equal(started,0);
    assert.equal(transportKind,'not_started');
    assert.equal(outcome.outcome,'refused');assert.equal(outcome.code,'CONFIG_CHANGED');
    assert.equal(outcome.summary,null);await idle(r);
    const job=await r('/api/v1/operations/'+outcome.operationId);
    assert.equal(job.http,200);assert.equal(job.data.state,'failed');assert.equal(job.data.errorCode,'CONFIG_CHANGED');
    assert.equal((await r(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    // Only the fixed producer's rename pair is expected. Both native project
    // byte images and the unrelated library/profile bytes remain unchanged.
    assert.deepEqual(await readFile(join(f.root,'retained-project.sqlite')),beforeProject);
    assert.deepEqual(await readFile(projectFile),beforeReplacement);
    assert.deepEqual(await readFile(f.config.library),beforeLibrary);
    assert.deepEqual(await readFile(f.config.profiles),beforeProfile);
  });
