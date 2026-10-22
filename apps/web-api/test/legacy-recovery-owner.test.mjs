import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, link, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { ApiError } from '../dist/security.js';
import { capturePhysicalTarget, checkedPhysicalTarget, verifyPhysicalTarget, checkedLegacyTarget,
  checkedLegacyEffect, recoveryValueKey } from '../dist/legacy-recovery-target.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const scratch = resolve(process.env.LMTI_WEB_TEST_TMP ?? join(repo,'build'));
const id = 'project', uuid = '11111111-2222-4333-8444-555555555555';
const changed = e => e instanceof ApiError && ['CONFIG_CHANGED','OWNER_UNAVAILABLE','RECOVERY_REQUIRED'].includes(e.code);
async function temp(t) {
  await mkdir(scratch,{recursive:true});
  const root = await mkdtemp(join(scratch,'legacy-provenance-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(scratch+sep));
    await rm(root,{recursive:true,force:true});
  });
  return root;
}
async function fixture(t,{schema = 2,profiles = true} = {}) {
  const root = await temp(t), scripts = join(root,'scripts'), data = join(root,'data'), linked = join(root,'linked');
  for (const dir of [scripts,data,linked]) await mkdir(dir);
  const config = {adminBinary:join(scripts,'lmti-mcp-admin.exe'),projectBinary:join(scripts,'lmti-project.exe'),
    python:join(scripts,'python.exe'),agentEntry:join(scripts,'lmti-agent-mcp.py'),configOwner:join(scripts,'mcp-config-owner.py'),
    library:join(data,'library.sqlite'),profiles:join(data,'profiles.sqlite'),allowedProjects:[id,'other'],port:0,openBrowser:false,
    agentRead:{entry:join(scripts,'agent-read-owner.py'),projects:[{projectId:id,site:'site',target:'external',integrationConfig:null}]}};
  for (const path of [config.adminBinary,config.projectBinary,config.python,config.agentEntry,config.configOwner,
    config.agentRead.entry,join(scripts,'web-broker-guard.py'),config.library,join(data,'project.sqlite'),
    ...(profiles ? [config.profiles] : [])]) await writeFile(path,'synthetic owner-owned fixture');
  const read = {binding:{id,name:'Synthetic',database:join(data,'project.sqlite'),root:linked,projectRevision:1,
    libraryIdentity:{schema:schema === 1 ? 1 : 3,canonicalPath:config.library.replaceAll('\\','/'),
      uuid:schema === 1 ? null : uuid,generation:schema === 1 ? null : 1,digest:'a'.repeat(64)},
    projectIdentity:{schema,storeUuid:schema === 1 ? null : uuid,revision:1}},
    profile:{projectId:id,revision:profiles ? 1 : 0,servers:[]}};
  const owners = new Owners(config); await owners.validateLaunch();
  const calls = [];
  // Real filesystem provenance; exact synthetic native DTOs isolate routing and
  // validation. These cases do not claim native transaction/SQLite atomicity.
  const run = async (binary,args,input,options = {}) => {
    await options.guard?.();
    const request = JSON.parse(input); calls.push({binary,args,request,options});
    if (binary === config.python) return {ok:true,state:'not_applied',appliedRevision:null,canRestore:false,verified:false};
    if (request.action === 'read-original') {
      assert.deepEqual(args,['--original-binding-read','--library',config.library,'--profiles',config.profiles]);
      assert.equal(options.cap,128*1024); assert.equal(options.timeoutMs,30000);
      assert.equal(options.newlineTerminated,true); assert.equal(options.raw,undefined);
      assert.equal(options.write,undefined); assert.equal(options.jsonArrayLimit,undefined);
      return {ok:true,schema:'lmti.mcp.original-read.v1',action:'read-original',...structuredClone(read)};
    }
    if (request.action === 'save') return {ok:true,binding:read.binding,profile:{...read.profile,revision:request.expectedRevision+1}};
    throw new Error('Unexpected fixture request');
  };
  owners.pool.run = run; owners.verificationPool.run = run;
  return {root,data,linked,config,read,owners,calls};
}

test('physical evidence is lossless bigint identity, survives content changes, and detects file replacement',async t => {
  const root = await temp(t), path = join(root,'store.sqlite'); await writeFile(path,'first');
  const target = await capturePhysicalTarget(path,'file');
  assert.equal(target.state,'present'); assert.ok(Object.isFrozen(target.chain));
  for (const row of target.chain) for (const field of ['dev','ino','birthtimeNs']) assert.match(row[field],/^[0-9]+$/);
  await writeFile(path,'different length and content'); await verifyPhysicalTarget(target);
  await rename(path,join(root,'retained-original.sqlite')); await writeFile(path,'first');
  await assert.rejects(verifyPhysicalTarget(target),changed);
});

test('physical parent identity refuses same spelling after a directory replacement',async t => {
  const root = await temp(t), parent = join(root,'parent'); await mkdir(parent);
  const path = join(parent,'store.sqlite'); await writeFile(path,'test');
  const target = await capturePhysicalTarget(path,'file');
  await rename(parent,join(root,'retained-parent')); await mkdir(parent); await writeFile(path,'test');
  await assert.rejects(verifyPhysicalTarget(target),changed);
});

test('missing and unsupported physical evidence never establishes unknown recovery',async t => {
  const root = await temp(t), path = join(root,'missing','profiles.sqlite');
  const missing = await capturePhysicalTarget(path,'file',true);
  assert.equal(missing.state,'missing');
  await verifyPhysicalTarget(missing,{allowMissing:true});
  await assert.rejects(verifyPhysicalTarget(missing),{code:'RECOVERY_REQUIRED'});
  await mkdir(dirname(path)); await writeFile(path,'created');
  await assert.rejects(verifyPhysicalTarget(missing,{allowMissing:true}),changed);
  const present = await capturePhysicalTarget(path,'file'), unsupported = structuredClone(present);
  unsupported.state = 'unsupported'; unsupported.chain[0] = null;
  await assert.rejects(verifyPhysicalTarget(checkedPhysicalTarget(unsupported),{allowMissing:true}),{code:'RECOVERY_REQUIRED'});
});

test('strict physical codec rejects unsafe spellings, unsupported fields and imprecise identity values before I/O',async t => {
  const root = await temp(t), path = join(root,'ordinary'); await writeFile(path,'test');
  const target = await capturePhysicalTarget(path,'file');
  for (const unsafe of ['\\\\server\\share\\a','//server/share/a','\\\\?\\C:\\a','C:relative',path+':stream',
    join(root,'CON'),root+sep+'..'+sep+'a',path+'.',path+' ',path+'\0',path+'?']) {
    await assert.rejects(capturePhysicalTarget(unsafe,'file'),e => e.code === 'INVALID_INPUT');
  }
  const variants = [
    {...target,extra:true},{...target,version:2},{...target,state:'unknown'},{...target,state:['present']},{...target,chain:[]},
    {...target,chain:target.chain.map((r,i) => i ? r : {...r,ino:9007199254740992})},
    {...target,chain:target.chain.map((r,i) => i ? r : {...r,ino:'01'})},
    {...target,chain:target.chain.map((r,i) => i ? r : {...r,birthtimeNs:'0'})}
  ];
  for (const value of variants) assert.throws(() => checkedPhysicalTarget(value),{code:'INVALID_INPUT'});
});

test('local file hardlinks and directory junctions are refused without following the alias',async t => {
  const root = await temp(t), path = join(root,'store.sqlite'); await writeFile(path,'test');
  await link(path,join(root,'hardlink.sqlite'));
  await assert.rejects(capturePhysicalTarget(path,'file'),{code:'OWNER_UNAVAILABLE'});
  const actual = join(root,'actual'); await mkdir(actual); await writeFile(join(actual,'child'),'test');
  await symlink(actual,join(root,'alias'),process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(capturePhysicalTarget(join(root,'alias','child'),'file'),{code:'OWNER_UNAVAILABLE'});
});

test('legacy target is exact, frozen, canonical across null-prototype input and contains no replayable profile',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'client_apply',client:'codex'});
  assert.ok(Object.isFrozen(target) && Object.isFrozen(target.client));
  const nullObjects = value => Array.isArray(value) ? value.map(nullObjects) : value && typeof value === 'object' ?
    Object.assign(Object.create(null),Object.fromEntries(Object.entries(value).map(([k,v]) => [k,nullObjects(v)]))) : value;
  assert.deepEqual(checkedLegacyTarget(nullObjects(target)),target);
  assert.equal(target.client.config,'.codex/config.toml'); assert.equal(target.client.recovery,'.lmti-client/codex.recovery.dpapi');
  assert.equal(Object.hasOwn(target,'profile'),false); assert.equal(Object.hasOwn(target,'content'),false);
  for (const bad of [{...target,revision:1},{...target,domainId:'bad'},{...target,action:['client_apply']},
    {...target,client:{...target.client,config:'.cursor/mcp.json'}},
    {...target,client:{...target.client,root:{...target.client.root,path:f.data}}},
    {...target,library:{...target.library,schema:'3'}},{...target,project:{...target.project,storeUuid:null}}])
    assert.throws(() => checkedLegacyTarget(bad),e => e instanceof ApiError);
  assert.throws(() => checkedLegacyEffect({kind:'client_apply',client:'cursor',root:f.linked}),{code:'INVALID_INPUT'});
});

for (const field of ['database','root']) test(`changed ${field} returned by conditional read is refused before config inspection without ordinary-read fallback`,async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'client_restore',client:'cursor'});
  f.read.binding[field] = join(f.root,'never-probed-substitution');
  f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.deepEqual(f.calls.map(c => c.request.action),['read-original']);
});

for (const schema of [1,2]) test(`schema ${schema} same-path project replacement is detected before selected read`,async t => {
  const f = await fixture(t,{schema}), target = await f.owners.captureLegacyTarget(f.read,{kind:'profile_save'});
  await rename(f.read.binding.database,join(f.data,'retained.sqlite')); await writeFile(f.read.binding.database,'synthetic owner-owned fixture');
  f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.deepEqual(f.calls,[]);
});

test('library or profiles physical replacement refuses before any native/config read',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'profile_save'});
  await rename(f.config.profiles,join(f.data,'retained-profiles')); await writeFile(f.config.profiles,'replacement');
  f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.deepEqual(f.calls,[]);
  await rename(f.config.library,join(f.data,'retained-library')); await writeFile(f.config.library,'replacement');
  f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed); assert.deepEqual(f.calls,[]);
});

test('unchanged immutable target permits fresh project/profile revisions without mistaking them for original outcome',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'desired_proposal'});
  f.read.binding.projectRevision++; f.read.binding.projectIdentity.revision++;
  f.read.profile.revision++; f.read.binding.libraryIdentity.generation++;
  f.read.binding.libraryIdentity.digest = 'b'.repeat(64);
  const current = await f.owners.inspectLegacyRecovery(target,{verify:true});
  assert.deepEqual(current.summary,{projectId:id,projectRevision:2,profileRevision:2,clients:[]});
  assert.equal(Object.hasOwn(current.summary,'outcome'),false);
  assert.equal(Object.hasOwn(current.summary,'database'),false);
  f.read.binding.projectIdentity.storeUuid = '22222222-2222-4333-8444-555555555555';
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
});

test('missing initial profiles allow a no-start check but cannot clear an unknown recovery barrier',async t => {
  const f = await fixture(t,{profiles:false}), target = await f.owners.captureLegacyTarget(f.read,{kind:'profile_save'});
  assert.equal(target.profiles.state,'missing');
  await f.owners.verifyLegacyTarget(target,{verify:true,allowMissing:true});
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),{code:'RECOVERY_REQUIRED'});
});

test('client recovery uses only retained root and fixed inspect action, rechecks identity, and has no write payload',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'client_apply',client:'codex'});
  f.calls.length = 0;
  const result = await f.owners.inspectLegacyRecovery(target,{verify:true});
  const client = f.calls.filter(c => c.binary === f.config.python);
  assert.deepEqual(client.map(c => c.request),[{action:'inspect',root:f.linked,project:id,client:'codex'}]);
  assert.deepEqual(result.summary.clients,[{client:'codex',state:'not_applied'}]);
  assert.deepEqual(f.calls.map(c => c.request.action),['read-original','inspect','read-original']);
  await rename(f.linked,join(f.root,'retained-linked')); await mkdir(f.linked); f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.equal(f.calls.some(c => c.binary === f.config.python),false);
});

test('client recovery rejects a coerced native state before returning evidence',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'client_apply',client:'codex'});
  const run = f.owners.verificationPool.run;
  f.owners.verificationPool.run = async (binary,...rest) => binary === f.config.python ?
    {ok:true,state:['configured'],appliedRevision:1,canRestore:true,verified:false} : run(binary,...rest);
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),{code:'OWNER_UNAVAILABLE'});
});

test('post-observation binding drift discards evidence and never switches the client inspection root',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'client_restore',client:'cursor'});
  const run = f.owners.verificationPool.run; f.calls.length = 0;
  f.owners.verificationPool.run = async (binary,...rest) => {
    const value = await run(binary,...rest);
    if (binary === f.config.python) f.read.binding.root = join(f.root,'never-probed-root');
    return value;
  };
  await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.deepEqual(f.calls.filter(c => c.binary === f.config.python).map(c => c.request.root),[f.linked]);
  assert.equal(f.calls.at(-1).request.action,'read-original');
  assert.equal(f.calls.some(c => ['library','read'].includes(c.request.action)),false);
});

test('recovery scope rejects foreign decoded paths/domain before any native call',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'profile_save'});
  f.calls.length = 0;
  for (const bad of [{...target,domainId:'b'.repeat(64)},{...target,projectId:'denied'},
    {...target,library:{...target.library,physical:{...target.library.physical,path:join(f.data,'foreign.sqlite')}}},
    {...target,profiles:{...target.profiles,path:join(f.data,'foreign.sqlite')}}])
    await assert.rejects(f.owners.inspectLegacyRecovery(bad,{verify:true}),e => e.code === 'SCOPE_DENIED');
  assert.deepEqual(f.calls,[]);
});

test('domain includes all trusted grants and pins, ignores ordering/port, and legacy launch publishes guard only after validation',async t => {
  const f = await fixture(t), domain = f.owners.recoveryDomainId();
  assert.equal(f.owners.brokerGuardConfig.domainId,domain);
  const make = async extra => { const o = new Owners({...f.config,...extra}); await o.validateLaunch(); return o; };
  assert.equal((await make({allowedProjects:['other',id],port:1234,openBrowser:true})).recoveryDomainId(),domain);
  assert.notEqual((await make({allowedProjects:[id]})).recoveryDomainId(),domain);
  assert.notEqual((await make({agentRead:{...f.config.agentRead,projects:[{...f.config.agentRead.projects[0],site:'different'}]}})).recoveryDomainId(),domain);
  const cfg = join(f.root,'integration.json'); await writeFile(cfg,'first controlled integration bytes');
  const grant = {agentRead:{...f.config.agentRead,projects:[{...f.config.agentRead.projects[0],integrationConfig:cfg}]}};
  const pinned = await make(grant), before = pinned.recoveryDomainId(); await writeFile(cfg,'second controlled integration bytes');
  assert.notEqual((await make(grant)).recoveryDomainId(),before);
  await assert.rejects(pinned.validateLaunch(),{code:'CONFIG_CHANGED'});
  assert.equal(pinned.recoveryDomainId(),before);
  const unopened = new Owners(f.config);
  assert.throws(() => unopened.recoveryDomainId(),{code:'NOT_SUPPORTED'}); assert.equal(unopened.brokerGuardConfig,null);
});

test('legacy-only launch also requires the fixed trusted guard helper before publishing admission configuration',async t => {
  const f = await fixture(t);
  await rename(join(dirname(f.config.configOwner),'web-broker-guard.py'),join(f.root,'retained-helper.py'));
  const o = new Owners(f.config);
  await assert.rejects(o.validateLaunch(),{code:'OWNER_UNAVAILABLE'});
  assert.equal(o.brokerGuardConfig,null);
  assert.throws(() => o.recoveryDomainId(),{code:'NOT_SUPPORTED'});
});

test('profile queued guard awaits persistence and refuses changed expected revision before native save',async t => {
  const f = await fixture(t), target = await f.owners.captureLegacyTarget(f.read,{kind:'profile_save'});
  let release, entered = false; const held = new Promise(r => { release = r; });
  f.calls.length = 0;
  const saving = f.owners.save(id,1,[],async () => { entered = true; await held; },target);
  while (!entered) await new Promise(r => setImmediate(r));
  assert.equal(f.calls.some(c => c.request.action === 'save'),false);
  f.read.profile.revision = 2; release();
  await assert.rejects(saving,{code:'REVISION_CONFLICT'});
  assert.equal(f.calls.some(c => c.request.action === 'save'),false);
});

test('all legacy write guards await async refusal and never dispatch after rejected persistence',async t => {
  const f = await fixture(t), guard = async () => { await new Promise(r => setImmediate(r)); throw new ApiError('RECOVERY_REQUIRED'); };
  const grant = f.config.agentRead.projects[0], proposal = {expectedProjectRevision:1,proposal:{
    schema:'lmti.topology.proposal.v1',baseRevision:1,assetId:'asset',site:'site',
    expected:{enabled:true,pollMs:1000},desired:{enabled:true,pollMs:2000}}};
  const generated = {...f.read,content:'',servers:{}};
  for (const call of [() => f.owners.save(id,1,[],guard),
    () => f.owners.proposal(f.read,grant,'commit-proposal',proposal,guard),
    () => f.owners.client('apply',generated,'codex','a'.repeat(64),guard),
    () => f.owners.client('restore_commit',f.read,'codex','a'.repeat(64),guard)]) {
    f.calls.length = 0; await assert.rejects(call(),{code:'RECOVERY_REQUIRED'}); assert.deepEqual(f.calls,[]);
  }
});

const realEnabled = ['LMTI_WEB_TEST_ADMIN','LMTI_WEB_TEST_PROJECT_BINARY','LMTI_WEB_TEST_BINDING_PRODUCER',
  'LMTI_WEB_TEST_PYTHON','LMTI_WEB_TEST_CONFIG_OWNER'].every(k => process.env[k]);
for (const schema of [1,2]) test(`real native schema ${schema} recovery captures original lineage and rejects retained same-path replacement`,{skip:!realEnabled},async t => {
  const root = await temp(t), producer = process.env.LMTI_WEB_TEST_BINDING_PRODUCER;
  const make = spawnSync(producer,['--fixture',root,schema === 1 ? '1' : '3',String(schema)],
    {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
  assert.equal(make.status,0,'Test-only native fixture producer must succeed.');
  const configOwner = process.env.LMTI_WEB_TEST_CONFIG_OWNER, cfg = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY,
    python:process.env.LMTI_WEB_TEST_PYTHON,agentEntry:join(dirname(configOwner),'lmti-agent-mcp.py'),configOwner,
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),
    allowedProjects:['factory-monitor'],port:0,openBrowser:false
  };
  const owners = new Owners(cfg); await owners.validateLaunch();
  const before = await owners.read('factory-monitor'), original = await readFile(before.binding.database);
  const target = await owners.captureLegacyTarget(before,{kind:'client_restore',client:'codex'});
  const inspected = await owners.inspectLegacyRecovery(target,{verify:true});
  assert.deepEqual(inspected.summary.clients,[{client:'codex',state:'not_applied'}]);
  assert.equal(target.project.storeUuid,schema === 1 ? null : before.binding.projectIdentity.storeUuid);
  const actions = [], run = owners.verificationPool.run.bind(owners.verificationPool);
  owners.verificationPool.run = async (binary,args,input,options) => {
    actions.push(JSON.parse(input).action); return run(binary,args,input,options);
  };
  await rename(before.binding.database,join(root,'retained-project.sqlite'));
  await writeFile(before.binding.database,original);
  await assert.rejects(owners.inspectLegacyRecovery(target,{verify:true}),changed);
  assert.deepEqual(actions,[]);
  assert.deepEqual(await readFile(join(root,'retained-project.sqlite')),original);
  assert.deepEqual(await readFile(before.binding.database),original);
  await owners.waitForIdle();
});
