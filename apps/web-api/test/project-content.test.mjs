import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createLocalApi} from '../dist/server.js';
import {contentChange,contentQuery,contentResponse} from '../dist/project-content.js';
const project='factory-monitor',P=`/api/v1/projects/${project}/content`;
async function fixture(t,grant=true){
  const root=await mkdtemp(join(tmpdir(),'lmti-content-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  const binary=process.env.LMTI_WEB_TEST_PROJECT_BINARY;
  assert.ok(binary&&process.env.LMTI_WEB_TEST_BINDING_PRODUCER,'Real owner test configuration is required');
  const result=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'1','2'],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0);
  const cfg={adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:binary,library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),
    python:process.env.LMTI_WEB_TEST_PYTHON,agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects:[project],port:0,openBrowser:false,...(grant?{projectContent:{projectIds:[project]}}:{})};
  let now=Date.now();const api=await createLocalApi(cfg,()=>now);t.after(()=>api.close());
  async function session(){
    const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
    async function request(path,method='GET',body){
      const response=await fetch(api.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const value=await response.json();assert.ok(!JSON.stringify(value).includes(root),'No private path leakage');
      return {http:response.status,...value};
    }
    const boot=await request('/api/v1/session/bootstrap','POST',{nonce:new URL(api.issueLaunch()).hash.slice('#bootstrap='.length)});
    assert.equal(boot.http,200);headers.Authorization=`Bearer ${boot.data.token}`;return request;
  }
  function native(mode,body){const r=spawnSync(binary,[`content-${mode}`,join(root,'project.sqlite'),project],{input:JSON.stringify(body),encoding:'utf8',windowsHide:true,timeout:15000});return JSON.parse(r.stdout);}
  return {root,request:await session(),session,native,advance:ms=>{now+=ms;}};
}
const work={id:'new-task',label:'Test work',componentId:'',assetId:'',releaseId:'',milestoneId:'',checklist:'',evidence:'',kind:'task',state:'todo',privacy:'internal'};
async function read(r,collection,offset=0,limit=50){const v=await r(P+'/read','POST',{collection,offset,limit});assert.equal(v.http,200,JSON.stringify(v));return v.data;}
async function commit(r,collection,operation,record){
  const before=await read(r,collection),preview=await r(P+'/previews','POST',{collection,operation,record,expectedRevision:before.revision});
  assert.equal(preview.http,200,JSON.stringify(preview));
  const result=await r(P+'/commit','POST',{previewId:preview.data.id});assert.equal(result.http,200,JSON.stringify(result));
  assert.equal(result.data.outcome,'committed');assert.equal(result.data.projectRevision,before.revision+1);
  assert.equal((await r(P+'/commit','POST',{previewId:preview.data.id})).http,410);
  return preview.data;
}
test('content contract rejects raw paths, SQL, unknown collections, malformed enums and oversized fields',()=>{
  for(const value of [{collection:'work',offset:-1,limit:50},{collection:'sql',offset:0,limit:50},{collection:'work',offset:0,limit:101}])assert.throws(()=>contentQuery(value));
  for(const record of [{...work,path:'untrusted'},{...work,state:'in_progress'},{...work,id:'../x'},{...work,label:'a'.repeat(8193)},{...work,enabled:true}])
    assert.throws(()=>contentChange({collection:'work',operation:'add',expectedRevision:1,record}));
  assert.throws(()=>contentChange({collection:'project',operation:'remove',expectedRevision:1,record:{id:project}}));
  assert.throws(()=>contentResponse({ok:true,schema:'bad'},'read','work'));
  assert.deepEqual(contentQuery({collection:'connections',offset:50000,limit:100}),{collection:'connections',offset:50000,limit:100});
  assert.throws(()=>contentQuery({collection:'connections',offset:50001,limit:100}));
  const page={ok:true,schema:'lmti.project.content.v1',collection:'connections',revision:1,items:[{id:'edge',from:'a',to:'b',protocol:'dependency'}],total:50000,nextOffset:100};
  assert.equal(contentResponse(page,'read','connections').total,50000);
  assert.throws(()=>contentResponse({...page,total:50001},'read','connections'));
});
test('real native owner roundtrips all 13 collections, reviews without writing and preserves unrelated data',{timeout:180000},async t=>{
  const f=await fixture(t),r=f.request;
  const records={
    repositories:{id:'repo-new',label:'Repository',locator:'https://example.com/source',privacy:'internal'},
    components:{id:'component-new',label:'Component',repositoryId:'repo-new',kind:'library',privacy:'internal'},
    targets:{id:'target-new',label:'Target',hardwareRevision:'rev A',architecture:'declared',privacy:'internal'},
    releases:{id:'release-new',label:'0.1',componentId:'component-new',targetId:'target-new',sourceRevision:'reviewed-source',state:'draft',privacy:'internal'},
    assets:{id:'asset-new',label:'Device',site:(await read(r,'assets')).items[0].site,kind:'sensor',privacy:'internal',enabled:false,pollMs:1000},
    bindings:{id:'binding-new',assetId:'asset-new',componentId:'component-new',releaseId:'release-new',targetId:'target-new',privacy:'internal'},
    dependencies:{id:'dependency-new',from:'component-new',to:'sensor-firmware',contract:'declared',privacy:'internal'},
    verification:{id:'verification-new',releaseId:'release-new',assetId:'asset-new',evidence:'Manual synthetic check',source:'operator',at:1700000000,result:'operator-declared',privacy:'internal'},
    milestones:{id:'milestone-new',label:'Milestone',criteria:'Run acceptance',dueDate:'2026-11-01',accepted:false,evidence:'',privacy:'internal'},
    work:{...work,componentId:'component-new',releaseId:'release-new',assetId:'asset-new',milestoneId:'milestone-new'},
    knowledge:{id:'knowledge-new',label:'Reference',componentId:'component-new',reference:'docs/design.md',fingerprint:'declared-v1',privacy:'internal'},
    connections:{id:'connection-new',from:'asset-new',to:'machine-a',protocol:'dependency'},
  };
  const originalProject=(await read(r,'project')).items[0];
  await commit(r,'project','update',{...originalProject,goal:'Updated synthetic goal'});
  for(const [collection,record]of Object.entries(records)){
    const before=await read(r,collection),bytes=await readFile(join(f.root,'project.sqlite'));
    const preview=await r(P+'/previews','POST',{collection,operation:'add',expectedRevision:before.revision,record});
    assert.equal(preview.http,200,JSON.stringify({collection,...preview}));assert.equal(preview.data.before,null);assert.deepEqual(preview.data.after,record);
    assert.deepEqual(await readFile(join(f.root,'project.sqlite')),bytes,'Review never writes');
    await r(P+'/previews/'+preview.data.id,'DELETE');
    await commit(r,collection,'add',record);
    const updated={...record,...('label'in record?{label:'Updated metadata'}:collection==='verification'?{evidence:'Updated evidence'}:collection==='connections'?{protocol:'mqtt'}:collection==='bindings'?{privacy:'public'}:{contract:'Updated contract'})};
    await commit(r,collection,'update',updated);records[collection]=updated;
    assert.deepEqual((await read(r,collection)).items.find(v=>v.id===record.id),updated);
  }
  // Reverse dependency order preserves all existing fixture records.
  for(const collection of ['connections','knowledge','work','milestones','verification','dependencies','bindings','assets','releases','targets','components','repositories']){
    await commit(r,collection,'remove',{id:records[collection].id});
    assert.ok(!(await read(r,collection)).items.some(v=>v.id===records[collection].id));
  }
  assert.equal((await read(r,'project')).items[0].label,originalProject.label);
});
test('preview session binding, expiry, stale revision, rejected changes and grant denial',{timeout:60000},async t=>{
  const f=await fixture(t),r=f.request,other=await f.session(),before=await read(r,'work');
  const make=()=>r(P+'/previews','POST',{collection:'work',operation:'add',expectedRevision:before.revision,record:work});
  const a=await make();assert.equal(a.http,200);
  assert.equal((await other(P+'/commit','POST',{previewId:a.data.id})).http,410);
  await r(P+'/previews/'+a.data.id,'DELETE');assert.equal((await r(P+'/commit','POST',{previewId:a.data.id})).http,410);
  const expired=await make();f.advance(120001);assert.equal((await r(P+'/commit','POST',{previewId:expired.data.id})).http,410);
  const stale=await make();assert.equal(stale.http,200);
  assert.equal(f.native('commit',{collection:'work',operation:'add',expectedRevision:before.revision,record:{...work,id:'external-task'}}).ok,true);
  const rejected=await r(P+'/commit','POST',{previewId:stale.data.id});assert.equal(rejected.error.code,'REVISION_CONFLICT');
  assert.ok(!(await read(r,'work')).items.some(v=>v.id===work.id));
  const denied=await fixture(t,false);assert.equal((await denied.request(P+'/capabilities')).data.enabled,false);
  assert.equal((await denied.request(P+'/read','POST',{collection:'work',offset:0,limit:50})).http,403);
  assert.equal((await r('/api/v1/projects/ungranted/content/capabilities')).http,403);
});
test('native invariants refuse dangling references, invalid completion, approved release edits and raw input',{timeout:60000},async t=>{
  const f=await fixture(t),r=f.request;
  async function refused(collection,operation,record){
    const page=await read(r,collection),bytes=await readFile(join(f.root,'project.sqlite'));
    const result=await r(P+'/previews','POST',{collection,operation,expectedRevision:page.revision,record});
    assert.ok(result.http>=400,JSON.stringify(result));assert.deepEqual(await readFile(join(f.root,'project.sqlite')),bytes);
  }
  await refused('work','add',{...work,componentId:'missing'});
  await refused('work','add',{...work,state:'done'});
  await refused('components','remove',{id:'sensor-firmware'});
  const release=(await read(r,'releases')).items[0];await commit(r,'releases','update',{...release,state:'approved'});
  await refused('releases','update',{...release,state:'approved',label:'Mutated approved'});
  await refused('releases','remove',{id:release.id});
  const before=(await read(r,'work')).revision;
  assert.equal(f.native('review',{collection:'work',operation:'add',expectedRevision:before,record:{...work,sql:'DROP TABLE'}}).ok,false);
  assert.equal(f.native('read',{collection:'work',offset:0,limit:101}).ok,false);
  assert.equal((await read(r,'work')).revision,before);
});
