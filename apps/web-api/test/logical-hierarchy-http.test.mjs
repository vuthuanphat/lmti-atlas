import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalApi } from '../dist/server.js';
import { ProcessPool } from '../dist/process.js';
import { Owners } from '../dist/owners.js';

const project='factory-monitor',route='/api/v1/projects/'+project+'/logical-hierarchy';
async function fixture(t,{hierarchy=true,internal=true,operations=false}={}) {
  assert.equal(process.platform,'win32','This integration suite requires the controlled Windows runtime.');
  for(const name of ['LMTI_WEB_TEST_BINDING_PRODUCER','LMTI_WEB_TEST_ADMIN',
    'LMTI_WEB_TEST_PROJECT_BINARY','LMTI_WEB_TEST_PYTHON','LMTI_WEB_TEST_CONFIG_OWNER'])
    assert.ok(process.env[name],name+' must select a verified local test input.');
  const root=await mkdtemp(join(tmpdir(),'lmti-hierarchy-http-Đường-'));
  const apis=[];
  t.after(async()=>{
    for(const api of apis)await api.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,force:true});
  });
  const generated=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'3','2'],
    {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8192});
  assert.equal(generated.status,0,'Controlled native fixture producer must succeed.');
  const config={
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY,
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),
    python:process.env.LMTI_WEB_TEST_PYTHON,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),
    configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,allowedProjects:[project,'other'],port:0,openBrowser:false,
    ...(hierarchy?{logicalHierarchy:{projects:[{projectId:project,allowInternal:internal}]}}:{})
  };
  if(operations) {
    const copyParent=join(root,'http-copies'),backupParent=join(root,'http-backups');
    await mkdir(copyParent);await mkdir(backupParent);
    config.projectOperations={copyParent,backupParent,projectIds:['other'],allowLibraryUpgrade:true};
  }
  async function session(api) {
    const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
    async function request(path,method='GET',body) {
      const response=await fetch(api.origin+path,{method,headers,
        body:body===undefined?undefined:JSON.stringify(body)});
      const raw=await response.text(),value=JSON.parse(raw);
      assert.ok(Buffer.byteLength(raw)<=256*1024,'Complete HTTP envelope is bounded.');
      assert.equal(raw.includes(root),false);
      assert.equal(raw.includes(root.replaceAll('\\','/')),false);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw),false,
        'Native storage UUIDs remain private.');
      assert.equal(/"(?:canonicalPath|storeUuid|proposalDigest|diffDigest|contentDigest|registryDigest|physical|chain|expected)"\s*:/.test(raw),false,
        'Owner identity and review authority remain private.');
      return {http:response.status,...value};
    }
    const nonce=new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
    const bootstrap=await request('/api/v1/session/bootstrap','POST',{nonce});
    assert.equal(bootstrap.http,200);
    headers.Authorization='Bearer '+bootstrap.data.token;
    return request;
  }
  async function start() {
    const api=await createLocalApi(config);apis.push(api);
    return {api,request:await session(api)};
  }
  return {root,config,session,start,...await start()};
}
const addition=(revision,id='reviewed-subsystem')=>({proposal:{
  projectId:project,expectedRevision:revision,
  changes:[{kind:'add_subsystem',desired:{id,label:'Phân hệ được duyệt',parentSubsystemId:'',privacy:'internal'}}]
}});
async function idle(request,unknown=false) {
  for(let attempt=0;attempt<200;attempt++) {
    const status=await request('/api/v1/write-status');
    assert.equal(status.http,200);assert.equal(status.data.admitted,true);
    if(status.data.activeWrites===0) {
      assert.equal(status.data.recoveryRequired,unknown);return;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Known child close and marker cleanup must release the write lease.');
}
async function completed(request,response) {
  assert.ok([200,202].includes(response.http),JSON.stringify(response));
  if(response.data.outcome!=='pending')return response.data;
  for(let attempt=0;attempt<200;attempt++) {
    const job=await request('/api/v1/operations/'+response.data.operationId);
    assert.equal(job.http,200);
    if(job.data.state!=='pending')return job.data.result;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Controlled native hierarchy write did not finish.');
}

test('HTTP hierarchy explicit grant supports reviewed native commit, opaque one-use review and persisted readback',
  {timeout:60000},async t=>{
    const f=await fixture(t),r=f.request;
    const libraryBefore=await readFile(f.config.library),profileBefore=await readFile(f.config.profiles);
    const scopes=await r('/api/v1/logical-hierarchy-scopes');
    assert.deepEqual(scopes.data,{projects:[{projectId:project,allowInternal:true}]});
    const state=await r(route);assert.equal(state.http,200);assert.equal(state.data.projectId,project);
    assert.equal((await r('/api/v1/projects/other/logical-hierarchy')).http,403);
    assert.equal((await r(route+'/previews','POST',{...addition(state.data.revision),path:f.root})).http,400);
    const preview=await r(route+'/previews','POST',addition(state.data.revision));assert.equal(preview.http,200);
    assert.match(preview.data.id,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(preview.data.diff.subsystems[0].after.id,'reviewed-subsystem');
    const other=await f.session(f.api);
    assert.equal((await other(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    const result=await completed(r,await r(route+'/commits','POST',{previewId:preview.data.id}));
    assert.equal(result.outcome,'confirmed');assert.equal(result.summary.revision,state.data.revision+1);
    await idle(r);
    assert.equal((await r(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    const after=await r(route);
    assert.equal(after.data.revision,state.data.revision+1);
    assert.ok(after.data.subsystems.some(row=>row.value.id==='reviewed-subsystem'));
    assert.equal((await r('/api/v1/operations/'+result.operationId)).data.state,'succeeded');
    assert.deepEqual(await readFile(f.config.library),libraryBefore);
    assert.deepEqual(await readFile(f.config.profiles),profileBefore);
    const rejected=await r(route+'/previews','POST',addition(after.data.revision,'reject-subsystem'));
    assert.equal((await r(route+'/previews/'+rejected.data.id,'DELETE')).data.rejected,true);
    assert.equal((await r(route+'/commits','POST',{previewId:rejected.data.id})).http,410);
  });

test('HTTP hierarchy absence and public-only grants do not inherit editing authority',
  {timeout:60000},async t=>{
    const absent=await fixture(t,{hierarchy:false,operations:true});
    assert.equal((await absent.request('/api/v1/logical-hierarchy-scopes')).http,501);
    assert.equal((await absent.request(route)).http,501);
    const publicOnly=await fixture(t,{internal:false});
    const scope=await publicOnly.request('/api/v1/logical-hierarchy-scopes');
    assert.equal(scope.data.projects[0].allowInternal,false);
    const state=await publicOnly.request(route);assert.equal(state.http,200);
    assert.ok(state.data.subsystems.every(row=>row.classification==='public'));
    assert.ok(state.data.components.every(row=>row.classification==='public'));
    const refused=await publicOnly.request(route+'/previews','POST',addition(state.data.revision));
    assert.equal(refused.http,403);
  });

test('HTTP real commit with deliberately corrupted received ACK keeps unknown across broker recreation and requires original-target review plus explicit acknowledgment',
  {timeout:90000},async t=>{
    const f=await fixture(t,{operations:true}),r=f.request,state=await r(route);
    const preview=await r(route+'/previews','POST',addition(state.data.revision,'unknown-subsystem'));
    assert.equal(preview.http,200);
    const original=ProcessPool.prototype.runWrite;let corrupted=0;
    ProcessPool.prototype.runWrite=async function(binary,args,input,options) {
      const result=await original.call(this,binary,args,input,options);
      if(binary===f.config.adminBinary&&args[0]==='--logical-hierarchy-write') {
        assert.equal(result.kind,'closed');assert.equal(result.transportOk,true);
        assert.equal(JSON.parse(result.bytes.toString('utf8')).outcome,'confirmed');
        corrupted++;
        // Controlled broker transport simulation after actual child close.
        // This is not a killed writer or an OS process restart.
        return {...result,bytes:Buffer.from('{"incomplete":true}\n')};
      }
      return result;
    };
    let result;
    try {result=await completed(r,await r(route+'/commits','POST',{previewId:preview.data.id}));}
    finally {ProcessPool.prototype.runWrite=original;}
    assert.equal(corrupted,1);assert.equal(result.outcome,'unknown');
    await idle(r,true);
    assert.equal((await r(route+'/previews','POST',addition(state.data.revision,'blocked'))).error.code,'RECOVERY_REQUIRED');
    assert.equal((await r('/api/v1/operations/'+result.operationId)).data.state,'unknown');
    const observed=await r(route);assert.equal(observed.data.revision,state.data.revision+1);
    assert.ok(observed.data.subsystems.some(row=>row.value.id==='unknown-subsystem'));
    await f.api.close();
    const restarted=await f.start(),fresh=restarted.request;
    assert.equal((await fresh('/api/v1/write-status')).data.recoveryRequired,true);
    // Project operations are configured without a grant for this hierarchy
    // project. The common recovery route still requires the actual subject grant.
    assert.equal((await fresh('/api/v1/projects/'+project+'/project-operations')).http,403);
    const recovery=await fresh('/api/v1/recovery-previews','POST',{});
    assert.equal(recovery.http,200);assert.equal(recovery.data.priorOutcome,'unknown');
    assert.deepEqual(recovery.data.items,[]);
    assert.deepEqual(recovery.data.hierarchyItems,[{projectId:project,projectRevision:state.data.revision+1}]);
    assert.deepEqual(Object.keys(recovery.data).sort(),['coverage','expiresAt','hierarchyItems','id','items','priorOutcome']);
    assert.deepEqual(recovery.data.coverage,{retainedSubjects:1,
      affectedScopes:[{kind:'logical_hierarchy',action:'logical-hierarchy-commit',projectId:project,subjects:1}],
      librarySchema:3});
    assert.equal((await fresh('/api/v1/write-status')).data.recoveryRequired,true);
    const acknowledgment=await fresh('/api/v1/recoveries','POST',{previewId:recovery.data.id});
    assert.equal(acknowledgment.http,200);assert.equal(acknowledgment.data.freshReviewRequired,true);
    assert.equal(acknowledgment.data.priorOutcome,'unknown');
    assert.equal((await fresh('/api/v1/write-status')).data.recoveryRequired,false);
    assert.equal((await fresh(route+'/commits','POST',{previewId:preview.data.id})).http,410);
    const newReview=await fresh(route+'/previews','POST',addition(state.data.revision+1,'fresh-subsystem'));
    assert.equal(newReview.http,200);
    assert.equal((await fresh(route+'/previews/'+newReview.data.id,'DELETE')).data.rejected,true);
  });

test('HTTP legacy-only recovery preserves its exact wire shape and refuses oversized success envelopes before retaining reviews',
  {timeout:90000},async t=>{
    const f=await fixture(t,{hierarchy:false}),r=f.request,profileRoute='/api/v1/projects/'+project+'/mcp-profile';
    const profile=await r(profileRoute);assert.equal(profile.http,200);
    const originalWrite=ProcessPool.prototype.runWrite;let corrupted=0;
    ProcessPool.prototype.runWrite=async function(binary,args,input,options) {
      const result=await originalWrite.call(this,binary,args,input,options);
      if(binary===f.config.adminBinary&&JSON.parse(input).action==='save') {
        assert.equal(result.kind,'closed');assert.equal(result.transportOk,true);
        assert.equal(JSON.parse(result.bytes.toString('utf8')).ok,true);
        corrupted++;return {...result,bytes:Buffer.from('{"incomplete":true}\n')};
      }
      return result;
    };
    let saved;
    try {saved=await r(profileRoute,'PUT',{expectedRevision:profile.data.revision,servers:profile.data.servers});}
    finally {ProcessPool.prototype.runWrite=originalWrite;}
    assert.equal(corrupted,1);assert.equal(saved.error.code,'RECOVERY_REQUIRED');await idle(r,true);
    const current=await r(profileRoute);
    assert.equal(current.data.revision,profile.data.revision+1);
    const writeStatus=await r('/api/v1/write-status');
    assert.deepEqual(Object.keys(writeStatus.data).sort(),['activeWrites','admitted','projectOperations','recoveryRequired']);

    // An abnormal trusted-owner observation exercises the defensive whole-frame
    // gate. This is not a valid native summary or a native output-budget claim.
    const originalInspect=Owners.prototype.inspectLegacyRecovery;let inspections=0;
    Owners.prototype.inspectLegacyRecovery=async function(target,options) {
      await options.guard?.();inspections++;
      return {evidence:{controlled:'oversized-public-summary'},summary:{
        projectId:project,projectRevision:1,profileRevision:current.data.revision,
        clients:Array.from({length:7000},()=>({client:'codex',state:'configured'}))}};
    };
    try {
      // Were refused frames retained, the 65th request would return BUSY.
      for(let attempt=0;attempt<65;attempt++) {
        const refused=await r('/api/v1/recovery-previews','POST',{});
        assert.equal(refused.error.code,'LIMIT_EXCEEDED');
        assert.equal(Object.hasOwn(refused,'data'),false);
      }
    } finally {Owners.prototype.inspectLegacyRecovery=originalInspect;}
    assert.equal(inspections,65);assert.equal((await r('/api/v1/write-status')).data.recoveryRequired,true);
    const recovery=await r('/api/v1/recovery-previews','POST',{});
    assert.equal(recovery.http,200);
    assert.deepEqual(Object.keys(recovery.data).sort(),['expiresAt','id','items','priorOutcome']);
    assert.equal(recovery.data.items.length,1);assert.equal(recovery.data.items[0].projectId,project);
    assert.equal(recovery.data.items[0].profileRevision,current.data.revision);
    assert.deepEqual(recovery.data.items[0].clients,[]);
    const acknowledgment=await r('/api/v1/recoveries','POST',{previewId:recovery.data.id});
    assert.deepEqual(acknowledgment.data,{reviewed:true,priorOutcome:'unknown',freshReviewRequired:true});
    await idle(r);
  });
