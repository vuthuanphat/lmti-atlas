import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createLocalApi} from '../dist/server.js';
import {Owners} from '../dist/owners.js';
import {libraryPublic} from '../dist/library-management.js';
const P='/api/v1/library/manage';
async function fixture(t,{grant=true,fresh=false}={}){
  const root=await mkdtemp(join(tmpdir(),'lmti-library-web-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  const binary=process.env.LMTI_WEB_TEST_PROJECT_BINARY;assert.ok(binary&&process.env.LMTI_WEB_TEST_BINDING_PRODUCER);
  const result=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'2','2'],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0);
  const parent=join(root,'project-data'),folder=join(root,'source-folder'),other=join(root,'other-folder');for(const path of [parent,folder,other])await mkdir(path);
  const candidate=join(root,'candidate.sqlite');assert.equal(spawnSync(binary,['init-project',candidate,'candidate-project','Existing candidate'],{encoding:'utf8',windowsHide:true,timeout:15000}).status,0);
  const cfg={adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:binary,library:join(root,fresh?'fresh.sqlite':'library.sqlite'),profiles:join(root,'profiles.sqlite'),
    python:process.env.LMTI_WEB_TEST_PYTHON,agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects:['factory-monitor'],port:0,openBrowser:false,
    ...(grant?{libraryManagement:{parent,folders:[{key:'source',label:'Approved source folder',path:folder},{key:'other',label:'Other approved folder',path:other}],candidates:[{key:'candidate',label:'Approved existing project',id:'candidate-project',database:candidate,folderKey:'source'}]}}:{})};
  let now=Date.now();const api=await createLocalApi(cfg,()=>now);t.after(()=>api.close());
  async function session(){const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
    async function request(path,method='GET',body){const response=await fetch(api.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),v=await response.json();assert.ok(!JSON.stringify(v).includes(root),'Paths stay private');return {http:response.status,...v};}
    const boot=await request('/api/v1/session/bootstrap','POST',{nonce:new URL(api.issueLaunch()).hash.slice('#bootstrap='.length)});assert.equal(boot.http,200);headers.Authorization=`Bearer ${boot.data.token}`;return request;
  }
  return {root,cfg,parent,candidate,folder,other,request:await session(),session,advance:ms=>{now+=ms;}};
}
async function commit(r,body){const p=await r(P+'/previews','POST',body);assert.equal(p.http,200,JSON.stringify(p));const c=await r(P+'/commit','POST',{previewId:p.data.id});assert.equal(c.http,200,JSON.stringify(c));assert.equal(c.data.outcome,'committed');assert.equal((await r(P+'/commit','POST',{previewId:p.data.id})).http,410);return c.data;}
test('real owner web creates, registers, links, pins and forgets references without deleting source or expanding project access',{timeout:120000},async t=>{
  const f=await fixture(t),r=f.request,source=await readFile(join(f.root,'project.sqlite'));
  const state=await r(P+'/state');assert.equal(state.data.enabled,true);assert.equal(state.data.format,2);assert.ok(!('signature'in state.data));assert.ok(!('uuid'in state.data));
  const created=await commit(r,{action:'create',id:'new-project',label:'Created project',folderKey:'source'});assert.equal(created.requiresRelaunch,true);
  const bytes=await readFile(join(f.parent,'new-project.sqlite'));assert.ok(bytes.length>0);
  assert.equal((await r('/api/v1/projects/new-project/content/capabilities')).http,403,'Library membership is not a content grant');
  assert.equal((await r('/api/v1/projects?limit=50')).data.items.some(v=>v.id==='new-project'),false,'Frozen UI scope remains unchanged');
  await commit(r,{action:'pin',id:'new-project',pinned:true});assert.equal((await r(P+'/state')).data.entries.find(e=>e.id==='new-project').pinned,true);
  await commit(r,{action:'link',id:'new-project',folderKey:'other'});
  await commit(r,{action:'register',candidateKey:'candidate'});
  const candidate=await readFile(f.candidate);await commit(r,{action:'forget',id:'candidate-project'});assert.deepEqual(await readFile(f.candidate),candidate);
  await commit(r,{action:'forget',id:'new-project'});assert.deepEqual(await readFile(join(f.parent,'new-project.sqlite')),bytes);
  assert.deepEqual(await readFile(join(f.root,'project.sqlite')),source);
});
test('library previews reject foreign sessions, expiry, replay, arbitrary paths and conflicting index changes',{timeout:90000},async t=>{
  const f=await fixture(t),r=f.request,other=await f.session();
  const p=await r(P+'/previews','POST',{action:'pin',id:'factory-monitor',pinned:true});assert.equal(p.http,200);
  assert.equal((await other(P+'/commit','POST',{previewId:p.data.id})).http,410);
  await r(P+'/previews/'+p.data.id,'DELETE');assert.equal((await r(P+'/commit','POST',{previewId:p.data.id})).http,410);
  const exp=await r(P+'/previews','POST',{action:'pin',id:'factory-monitor',pinned:true});f.advance(120001);assert.equal((await r(P+'/commit','POST',{previewId:exp.data.id})).http,410);
  const stale=await r(P+'/previews','POST',{action:'pin',id:'factory-monitor',pinned:true});await commit(r,{action:'register',candidateKey:'candidate'});
  assert.equal((await r(P+'/commit','POST',{previewId:stale.data.id})).http,410);
  for(const body of [{action:'create',id:'../escape',label:'Bad',folderKey:'source'},{action:'link',id:'factory-monitor',folderKey:'ungranted'},
    {action:'register',candidateKey:'candidate',database:'untrusted'},{action:'forget',id:'factory-monitor',sql:'DROP TABLE'},
    {action:'create',id:'CON',label:'Reserved device name',folderKey:'source'}])assert.ok((await r(P+'/previews','POST',body)).http>=400);
  const denied=await fixture(t,{grant:false});assert.deepEqual((await denied.request(P+'/state')).data,{enabled:false});assert.equal((await denied.request(P+'/previews','POST',{action:'forget',id:'factory-monitor'})).http,403);
});
test('fresh-library bootstrap is exclusive and keeps v1 upgrade explicit before further registration',{timeout:60000},async t=>{
  const f=await fixture(t,{fresh:true}),r=f.request;assert.equal((await r(P+'/state')).data.format,0);
  await commit(r,{action:'create',id:'first-project',label:'First project',folderKey:'source'});assert.equal((await r(P+'/state')).data.format,1);
  const before=await readFile(f.cfg.library);const refused=await r(P+'/previews','POST',{action:'register',candidateKey:'candidate'});assert.equal(refused.error.code,'NOT_SUPPORTED');
  assert.deepEqual(await readFile(f.cfg.library),before);assert.ok((await r(P+'/previews','POST',{action:'create',id:'first-project',label:'Replacement',folderKey:'source'})).http>=400);
});
test('library recovery reads retained original targets after creation/removal and refuses forged paths',{timeout:60000},async t=>{
  const f=await fixture(t),owners=new Owners(f.cfg);await owners.validateLaunch();t.after(()=>owners.waitForIdle());const m=owners.libraryManager;
  const state=await m.state(),q=m.change({action:'create',id:'recovery-project',label:'Recovery project',folderKey:'source'},state),subject=await m.capture(q,state);
  await m.verify(subject);await m.native('commit',q);const observed=await m.inspect(subject,()=>{});assert.match(observed.digest,/^[0-9a-f]{64}$/);
  assert.ok(libraryPublic(await m.state()).entries.some(v=>v.id==='recovery-project'));
  await assert.rejects(m.verify(subject),{code:'CONFIG_CHANGED'});
  const bad=structuredClone(subject);bad.target.physical[0].path=join(f.root,'different.sqlite');await assert.rejects(m.inspect(bad,()=>{}));
  const renamed=structuredClone(subject);renamed.target.request.parent=f.other;await assert.rejects(m.inspect(renamed,()=>{}));
  const removeState=await m.state(),remove=m.change({action:'forget',id:'recovery-project'},removeState),retained=await m.capture(remove,removeState);
  await m.native('commit',remove);assert.match((await m.inspect(retained,()=>{})).digest,/^[0-9a-f]{64}$/);
});
