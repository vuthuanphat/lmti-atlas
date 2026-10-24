import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, rename, link, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { ApiError, hash } from '../dist/security.js';
import { recoveryValueKey } from '../dist/legacy-recovery-target.js';

const scratch=resolve(process.env.LMTI_WEB_TEST_TMP??fileURLToPath(new URL('../../../build',import.meta.url)));
const clone=v=>structuredClone(v);
const libraryUuid='11111111-1111-4111-8111-111111111111',storeUuid='22222222-2222-4222-8222-222222222222';
const d='a'.repeat(64),r='b'.repeat(64);
async function fixture(t,enabled=true){
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(join(scratch,'hierarchy-recovery-'));
  const pkg=join(root,'package'),data=join(root,'data'),scripts=join(pkg,'share','lmti','scripts');
  for(const p of [join(pkg,'bin'),data,scripts])await mkdir(p,{recursive:true});
  const config={adminBinary:join(pkg,'bin','lmti-mcp-admin.exe'),projectBinary:join(pkg,'bin','lmti-project.exe'),
    python:join(root,'python.exe'),agentEntry:join(scripts,'lmti-agent-mcp.py'),configOwner:join(scripts,'mcp-config-owner.py'),
    library:join(data,'library.sqlite'),profiles:join(data,'profiles.sqlite'),allowedProjects:['project','other'],port:0,openBrowser:false};
  const database=join(data,'Prøject-Σ.sqlite');
  for(const p of [config.adminBinary,config.projectBinary,config.python,config.agentEntry,config.configOwner,
    join(scripts,'web-broker-guard.py'),config.library,database])await writeFile(p,'inert fixture owner file');
  if(enabled)config.logicalHierarchy={projects:[{projectId:'project',allowInternal:true}]};
  const owners=new Owners(config);
  t.after(async()=>{await owners.waitForIdle();assert.ok(resolve(root).startsWith(scratch+sep));await rm(root,{recursive:true,force:true});});
  const library={schema:3,canonicalPath:config.library.replaceAll('\\','/'),uuid:libraryUuid,generation:4,digest:d};
  const identity={schemaVersion:2,projectId:'project',canonicalPath:database.replaceAll('\\','/'),storeUuid,revision:7,contentDigest:d,registryDigest:r};
  const old={id:'sub',label:'Before',parentSubsystemId:'',privacy:'internal'};
  const proposal={projectId:'project',expectedRevision:7,changes:[{kind:'rename_subsystem',expected:old,desiredLabel:'After'}]};
  const scope={projectId:'project',allowLogicalWrite:true,allowInternal:true};
  const proposalDigest=createHash('sha256').update(JSON.stringify(['lmti.logical-hierarchy.review.v1','project',true,true,
    'project','7',[['rename',[old.id,old.label,'','internal'],'After']]])).digest('hex');
  const expected={libraryIdentity:library,reviewToken:{...identity,schema:'lmti.logical-hierarchy.review.v1',scope,proposal,proposalDigest,diffDigest:d}};
  const state={ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:'logical-hierarchy-original-state',
    libraryIdentity:library,projectIdentity:identity,projection:{projectId:'project',revision:7,
      subsystems:[{value:old,ancestors:[],classification:'internal'}],components:[]}};
  const locator={ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:'logical-hierarchy-locator',
    libraryIdentity:library,projectId:'project',database,linkedRoot:join(root,'offline-linked-root')};
  const calls=[]; let respond=request=>request.action==='logical-hierarchy-locator'?clone(locator):clone(state);
  owners.verificationPool.run=async(binary,args,input,options)=>{
    calls.push({binary,args,input,options});await options.guard?.();return respond(JSON.parse(input));
  };
  owners.pool.run=async()=>{assert.fail('unexpected main-pool or legacy/profile read');};
  return {root,pkg,data,database,config,owners,library,identity,expected,state,locator,calls,setResponse:fn=>{respond=fn;}};
}
async function capture(f,options){return f.owners.hierarchyRecovery.captureSubject('project',f.expected,options);}

test('hierarchy grant is explicit, frozen, shares pools, and absent domain is byte-compatible',async t=>{
  const f=await fixture(t,false);await f.owners.validateLaunch();
  assert.equal(f.owners.logicalHierarchyOwner,null);assert.equal(f.owners.hierarchyRecovery,null);
  assert.equal(f.owners.hasLogicalHierarchy('project'),false);assert.deepEqual(f.owners.hierarchyGrants(),[]);
  const c=f.config,helper=join(dirname(c.configOwner),'web-broker-guard.py');
  const legacy=hash(recoveryValueKey({adminBinary:c.adminBinary,projectBinary:c.projectBinary,python:c.python,
    agentEntry:c.agentEntry,configOwner:c.configOwner,helper,library:c.library,profiles:c.profiles,
    allowedProjects:['other','project'],agentRead:null,projectOperations:null}));
  assert.equal(f.owners.recoveryDomainId(),legacy);
  c.logicalHierarchy={projects:[{projectId:'project',allowInternal:true}]};
  const next=new Owners(c);c.logicalHierarchy.projects[0].allowInternal=false;c.logicalHierarchy.projects.push({projectId:'other',allowInternal:true});
  await next.validateLaunch();
  assert.ok(next.logicalHierarchyOwner);assert.ok(next.hierarchyRecovery);
  assert.equal(next.hasLogicalHierarchy('project'),true);assert.equal(next.hasLogicalHierarchy('other'),false);
  assert.deepEqual(next.hierarchyGrants(),[{projectId:'project',allowInternal:true}]);
  assert.notEqual(next.recoveryDomainId(),legacy);
  assert.equal(next.logicalHierarchyOwner.pool,next.pool);assert.equal(next.logicalHierarchyOwner.verifyPool,next.verificationPool);
  assert.throws(()=>{next.hierarchyGrants()[0].allowInternal=false;},TypeError);
  assert.throws(()=>next.hierarchyGrantId('other'),{code:'SCOPE_DENIED'});
});

test('exact grants reject absent inference, duplicates, extras, coercion and oversized lists before publication',async t=>{
  const f=await fixture(t);
  for(const h of [null,{}, {projects:[]}, {projects:[{projectId:'denied',allowInternal:false}]},
    {projects:[{projectId:'project',allowInternal:true},{projectId:'project',allowInternal:false}]},
    {projects:[{projectId:'project',allowInternal:'true'}]}, {projects:[{projectId:'project',allowInternal:true,extra:1}]},
    {projects:[{projectId:'project'}]}, {projects:Array(501).fill({projectId:'project',allowInternal:true})},
    {projects:[{projectId:'project',allowInternal:false}],extra:true}]){
    const o=new Owners({...f.config,logicalHierarchy:h});
    await assert.rejects(o.validateLaunch(),e=>e instanceof ApiError);
    assert.equal(o.logicalHierarchyOwner,null);assert.equal(o.hierarchyRecovery,null);assert.equal(o.brokerGuardConfig,null);
  }
});

test('hierarchy domain is order-stable and changes with exact public/internal and allowed-project grants',async t=>{
  const f=await fixture(t);
  const make=async(projects,allowedProjects=f.config.allowedProjects)=>{
    const o=new Owners({...f.config,allowedProjects,logicalHierarchy:{projects}});await o.validateLaunch();return o;
  };
  const a=await make([{projectId:'project',allowInternal:true},{projectId:'other',allowInternal:false}]);
  const b=await make([{projectId:'other',allowInternal:false},{projectId:'project',allowInternal:true}]);
  assert.equal(a.recoveryDomainId(),b.recoveryDomainId());assert.equal(a.hierarchyGrantId('project'),b.hierarchyGrantId('project'));
  const c=await make([{projectId:'project',allowInternal:false},{projectId:'other',allowInternal:false}]);
  assert.notEqual(a.recoveryDomainId(),c.recoveryDomainId());assert.notEqual(a.hierarchyGrantId('project'),c.hierarchyGrantId('project'));
});

test('hierarchy-only paths reject unsafe spellings, package data, .lmti, junction and main hardlink',async t=>{
  const f=await fixture(t);
  for(const library of [join(f.pkg,'library.sqlite'),join(f.pkg,'library.sqlite').replaceAll('\\','/'),join(f.root,'.lmti','library.sqlite'),
    f.config.library+':stream',`${f.data}${sep}..${sep}library.sqlite`,`${f.data}${sep}NUL`,`${f.data}${sep}bad.`]){
    await assert.rejects(new Owners({...f.config,library}).validateLaunch(),e=>e instanceof ApiError);
  }
  const alias=join(f.root,'data-link');await symlink(f.data,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(new Owners({...f.config,library:join(alias,'library.sqlite')}).validateLaunch(),{code:'OWNER_UNAVAILABLE'});
  await link(f.config.library,join(f.data,'library-alias.sqlite'));
  await assert.rejects(f.owners.validateLaunch(),{code:'OWNER_UNAVAILABLE'});
});

test('capture uses only fixed locator then original-state, raw spelling and exact verifier budgets without profiles',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();
  const subject=await capture(f);
  assert.deepEqual(f.calls.map(c=>JSON.parse(c.input).action),['logical-hierarchy-locator','logical-hierarchy-original-state']);
  for(const c of f.calls){
    assert.equal(c.binary,f.config.adminBinary);
    assert.deepEqual(c.args,['--logical-hierarchy-read','--library',f.config.library,'--project','project','--visibility','internal']);
    assert.equal(c.options.cap,512*1024);assert.equal(c.options.newlineTerminated,true);assert.equal(c.options.timeoutMs,30000);
    assert.ok(Buffer.byteLength(c.input)<=64*1024);assert.equal(c.args.includes('--profiles'),false);
  }
  const request=JSON.parse(f.calls[1].input);
  assert.deepEqual(Object.keys(request).sort(),['action','expected']);
  assert.deepEqual(Object.keys(request.expected).sort(),['library','linkedRoot','project','projectId','version']);
  assert.equal(request.expected.project.physical.path,f.database);assert.equal(request.expected.linkedRoot,f.locator.linkedRoot);
  assert.equal(request.expected.project.physical.state,'present');assert.equal(f.calls[1].options.jsonArrayLimit,4000);
  assert.equal(subject.grantId,f.owners.hierarchyGrantId('project'));
  assert.equal(subject.target.pins.projectIdentity.canonicalPath,f.identity.canonicalPath);
  assert.equal(Object.hasOwn(subject.target.pins,'proposal'),false);assert.equal(Object.hasOwn(subject.target.pins,'diff'),false);
  assert.ok(Object.isFrozen(subject));assert.ok(Buffer.byteLength(JSON.stringify(subject))<=32*1024);
});

test('capture refuses changed catalog token before following a substituted project path',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();
  f.setResponse(()=>({...f.locator,libraryIdentity:{...f.library,generation:5},database:join(f.root,'missing','do-not-probe.sqlite')}));
  await assert.rejects(capture(f),{code:'CONFIG_CHANGED'});
  assert.equal(f.calls.length,1);
});

test('revocation after library capture/check prevents the next project metadata probe',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();
  f.setResponse(()=>({...f.locator,database:join(f.root,'missing','not-probed.sqlite')}));
  let guards=0;
  await assert.rejects(capture(f,{guard:()=>{if(++guards===4)throw new ApiError('SESSION_EXPIRED');}}),
    {code:'SESSION_EXPIRED'});
  assert.equal(guards,4);assert.equal(f.calls.length,1);
  f.setResponse(q=>q.action==='logical-hierarchy-locator'?clone(f.locator):clone(f.state));
  const subject=await capture(f);
  const retained=join(f.data,'retained-for-guard.sqlite');
  assert.ok(resolve(retained).startsWith(resolve(f.root)+sep));await rename(f.database,retained);
  guards=0;
  await assert.rejects(f.owners.hierarchyRecovery.verifySubject(subject,{guard:()=>{
    if(++guards===2)throw new ApiError('SESSION_EXPIRED');
  }}),{code:'SESSION_EXPIRED'});
  assert.equal(guards,2);
});

test('capture refuses changed complete snapshot; recovery permits same original target at N+1',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();
  const next={...clone(f.state),projectIdentity:{...f.identity,revision:8,contentDigest:r},
    projection:{...clone(f.state.projection),revision:8}};
  f.setResponse(q=>q.action==='logical-hierarchy-locator'?clone(f.locator):next);
  await assert.rejects(capture(f),{code:'CONFIG_CHANGED'});
  f.setResponse(q=>q.action==='logical-hierarchy-locator'?clone(f.locator):clone(f.state));
  const subject=await capture(f), before=await f.owners.hierarchyRecovery.inspect(subject);
  f.setResponse(()=>next);const after=await f.owners.hierarchyRecovery.inspect(subject);
  assert.deepEqual(after.hierarchySummary,{projectId:'project',projectRevision:8});
  assert.notEqual(before.digest,after.digest);assert.deepEqual(Object.keys(after).sort(),['digest','hierarchySummary']);
  assert.equal(subject.target.pins.projectIdentity.revision,7);
});

test('retained grant, project and exact target metadata are re-authorized before any owner dispatch',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);f.calls.length=0;
  for(const mutate of [s=>s.grantId=d,s=>s.projectId='other',s=>s.action='profile_save',
    s=>s.target.original.library.physical.path=f.database,s=>s.target.extra='untrusted']){
    const altered=clone(subject);mutate(altered);
    await assert.rejects(f.owners.hierarchyRecovery.conditionalState(altered),e=>e instanceof ApiError);
  }
  assert.equal(f.calls.length,0);
});

test('same-path physical replacement blocks original state before dispatch without refreshing provenance',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);f.calls.length=0;
  const retained=join(f.data,'retained.sqlite');assert.ok(resolve(retained).startsWith(resolve(f.root)+sep));
  await rename(f.database,retained);await writeFile(f.database,'independent replacement');
  await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject),{code:'CONFIG_CHANGED'});
  assert.equal(f.calls.length,0);
});

test('native original binding denial and malformed action never fall back to ordinary state or profile read',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);
  for(const reply of [{ok:false,code:'CONFIG_CHANGED'},{...f.state,action:'logical-hierarchy-state'},
    {...f.state,extra:true},{...f.state,projectIdentity:{...f.identity,storeUuid:libraryUuid}},
    {ok:false,code:'NONE'},{ok:false,code:['CONFIG_CHANGED']}]){
    f.calls.length=0;f.setResponse(()=>reply);
    await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject),e=>e instanceof ApiError);
    assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].input).action,'logical-hierarchy-original-state');
  }
});

test('all fixed native read codes map exactly and malformed errors remain owner unavailable',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);
  for(const [native,api] of [['INVALID_INPUT','INVALID_INPUT'],['SCOPE_DENIED','SCOPE_DENIED'],
    ['UNSUPPORTED_SCHEMA','NOT_SUPPORTED'],['UNSUPPORTED_FORMAT','NOT_SUPPORTED'],['CONFIG_CHANGED','CONFIG_CHANGED'],
    ['BUDGET_EXCEEDED','LIMIT_EXCEEDED'],['OWNER_UNAVAILABLE','OWNER_UNAVAILABLE'],['RECOVERY_REQUIRED','RECOVERY_REQUIRED']]){
    f.setResponse(()=>({ok:false,code:native}));
    await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject),{code:api});
  }
});

test('queue and post-result guard revocation prevent publishing state while immutable physical pins remain unchanged',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);
  let allowed=true;
  const guard=()=>{if(!allowed)throw new ApiError('SESSION_EXPIRED');};
  f.owners.verificationPool.run=async(binary,args,input,options)=>{allowed=false;await options.guard();assert.fail('guard must refuse');};
  await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject,{guard}),{code:'SESSION_EXPIRED'});
  allowed=true;
  f.owners.verificationPool.run=async(binary,args,input,options)=>{await options.guard();allowed=false;return clone(f.state);};
  await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject,{guard}),{code:'SESSION_EXPIRED'});
});

test('public grant rejects hidden complete projection and unsupported physical provenance before dispatch',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();const subject=await capture(f);
  const publicOwners=new Owners({...f.config,logicalHierarchy:{projects:[{projectId:'project',allowInternal:false}]}});
  await publicOwners.validateLaunch();let calls=0;
  publicOwners.verificationPool.run=async()=>{calls++;return clone(f.state);};
  const publicSubject=clone(subject);publicSubject.grantId=publicOwners.hierarchyGrantId('project');
  await assert.rejects(publicOwners.hierarchyRecovery.conditionalState(publicSubject),{code:'OWNER_UNAVAILABLE'});
  assert.equal(calls,1);
  const missing=clone(subject);missing.target.original.project.physical.state='missing';missing.target.original.project.physical.chain.pop();
  f.calls.length=0;
  await assert.rejects(f.owners.hierarchyRecovery.conditionalState(missing),{code:'RECOVERY_REQUIRED'});
  assert.equal(f.calls.length,0);
});

test('locator exact keys and original state full identity coherence reject malformed private DTOs',async t=>{
  const f=await fixture(t);await f.owners.validateLaunch();
  for(const locator of [{...f.locator,extra:1},{...f.locator,projectId:'other'},
    {...f.locator,database:'relative.sqlite'},{...f.locator,linkedRoot:null},{...f.locator,libraryIdentity:null}]){
    f.setResponse(()=>locator);await assert.rejects(capture(f),{code:'OWNER_UNAVAILABLE'});
  }
  f.setResponse(q=>q.action==='logical-hierarchy-locator'?clone(f.locator):clone(f.state));
  const subject=await capture(f);
  for(const state of [{...f.state,projection:{...f.state.projection,revision:8}},
    {...f.state,projectIdentity:{...f.identity,canonicalPath:f.config.library.replaceAll('\\','/')}}, 
    {...f.state,libraryIdentity:{...f.library,canonicalPath:f.database.replaceAll('\\','/')}}]){
    f.setResponse(()=>state);await assert.rejects(f.owners.hierarchyRecovery.conditionalState(subject),e=>e instanceof ApiError);
  }
});
