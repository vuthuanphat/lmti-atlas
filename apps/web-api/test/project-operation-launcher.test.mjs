import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { WriteOutcomeUnknown } from '../dist/process.js';
import { ApiError } from '../dist/security.js';

const scratch = resolve(process.env.LMTI_WEB_TEST_TMP ?? fileURLToPath(new URL('../../../build',import.meta.url)));
async function fixture(t, capability = true) {
  await mkdir(scratch,{recursive:true});
  const root = await mkdtemp(join(scratch,'operation-launch-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(scratch+sep)); await rm(root,{recursive:true,force:true}); });
  const pkg = join(root,'package'), data = join(root,'data'), copies = join(root,'copies'), backups = join(root,'backups');
  const scripts = join(pkg,'share/lmti/scripts');
  for (const path of [join(pkg,'bin'),data,copies,backups,scripts]) await mkdir(path,{recursive:true});
  const config = {adminBinary:join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:join(pkg,'bin/lmti-project.exe'),
    python:join(root,'python.exe'),agentEntry:join(scripts,'lmti-agent-mcp.py'),configOwner:join(scripts,'mcp-config-owner.py'),
    library:join(data,'project-library.sqlite'),profiles:join(data,'profiles.sqlite'),allowedProjects:['project','other'],port:0,openBrowser:false};
  for (const path of [config.adminBinary,config.projectBinary,config.python,config.agentEntry,config.configOwner,
    join(scripts,'web-broker-guard.py'),join(data,'project.sqlite')]) await writeFile(path,'inert test-owned file');
  if (capability) config.projectOperations = {copyParent:copies,backupParent:backups,projectIds:['project'],allowLibraryUpgrade:false};
  const read = {binding:{id:'project',name:'Synthetic',database:join(data,'project.sqlite'),root:data,projectRevision:1,
    libraryIdentity:{schema:1,canonicalPath:config.library.replaceAll('\\','/'),uuid:null,generation:null,digest:'a'.repeat(64)},
    projectIdentity:{schema:1,storeUuid:null,revision:1}},profile:{projectId:'project',revision:1,servers:[]},content:'',servers:{}};
  return {root,pkg,data,copies,backups,config,read};
}
const unavailable = (error) => error instanceof ApiError;
const unknown = (error) => error instanceof WriteOutcomeUnknown && error.code === 'RECOVERY_REQUIRED';

test('operation capability is explicit, frozen independently, and published only after validation',async t => {
  const f = await fixture(t), owners = new Owners(f.config);
  assert.equal(owners.projectOperationOwner,null); assert.equal(owners.brokerGuardConfig,null);
  assert.equal(owners.hasProjectOperations('project'),false);
  assert.throws(() => owners.operationGrantId(),{code:'NOT_SUPPORTED'});
  f.config.projectOperations.projectIds.push('other'); f.config.projectOperations.allowLibraryUpgrade = true;
  f.config.allowedProjects.push('injected'); f.config.projectOperations.copyParent = f.backups;
  await owners.validateLaunch();
  assert.ok(owners.projectOperationOwner); assert.equal(owners.hasProjectOperations('project'),true);
  assert.equal(owners.hasProjectOperations('other'),false); assert.equal(owners.hasProjectOperations('injected'),false);
  assert.equal(owners.config.projectOperations.allowLibraryUpgrade,false);
  assert.equal(owners.config.projectOperations.copyParent,f.copies);
  assert.throws(() => owners.config.projectOperations.projectIds.push('other'),TypeError);
  assert.throws(() => { owners.config.library = f.read.binding.database; },TypeError);
  assert.deepEqual(owners.brokerGuardConfig,{python:f.config.python,helper:join(dirname(f.config.configOwner),'web-broker-guard.py'),library:f.config.library,domainId:owners.recoveryDomainId()});
  assert.ok(Object.isFrozen(owners.brokerGuardConfig)); assert.match(owners.operationGrantId(),/^[0-9a-f]{64}$/);
});

test('legacy absence and maintenance-only capability do not infer per-project grants',async t => {
  const f = await fixture(t,false), legacy = new Owners(f.config); await legacy.validateLaunch();
  assert.equal(legacy.projectOperationOwner,null); assert.equal(legacy.brokerGuardConfig.domainId,legacy.recoveryDomainId());
  assert.equal(legacy.hasProjectOperations('project'),false);
  f.config.projectOperations = {copyParent:f.copies,backupParent:f.backups,projectIds:[],allowLibraryUpgrade:true};
  const maintenance = new Owners(f.config); await maintenance.validateLaunch();
  assert.ok(maintenance.projectOperationOwner); assert.equal(maintenance.hasProjectOperations('project'),false);
  assert.equal(maintenance.config.projectOperations.allowLibraryUpgrade,true);
});

test('exact operation grants reject extras, coercion, duplicates, over-budget and UI scope expansion',async t => {
  const f = await fixture(t), original = f.config.projectOperations;
  for (const change of [{unexpected:true},{projectIds:['denied']},{projectIds:['project','project']},
    {projectIds:[]},{projectIds:['bad id']},{projectIds:Array(501).fill('project')},
    {projectIds:'project'},{allowLibraryUpgrade:1},{allowLibraryUpgrade:'false'},{copyParent:undefined}]) {
    const owners = new Owners({...f.config,projectOperations:{...original,...change}});
    await assert.rejects(owners.validateLaunch(),unavailable);
    assert.equal(owners.projectOperationOwner,null); assert.equal(owners.brokerGuardConfig,null);
  }
});

test('operation grant fingerprint includes all authority fields and ignores project ID order',async t => {
  const f = await fixture(t), make = async changes => {
    const o = new Owners({...f.config,projectOperations:{...f.config.projectOperations,...changes}}); await o.validateLaunch(); return o.operationGrantId();
  };
  const base = await make({}); assert.notEqual(base,await make({allowLibraryUpgrade:true}));
  assert.notEqual(base,await make({projectIds:['other']}));
  assert.notEqual(base,await make({copyParent:f.backups,backupParent:f.copies}));
  assert.equal(await make({projectIds:['other','project']}),await make({projectIds:['project','other']}));
});

test('participating paths refuse raw network/device/ADS and unsupported components',async t => {
  const f = await fixture(t);
  for (const path of ['\\\\server\\share\\copies','//server/share/copies','\\\\?\\C:\\copies','C:relative',
    f.copies+':stream',f.copies+'\\..\\copies',f.copies+'\\.\\child',f.copies+'\\NUL',
    f.copies+'\\bad.',f.copies+'\\bad ',f.copies+'\\a?b',f.copies+'\\a*b',f.copies+'\\a|b',f.copies+'\x7f']) {
    const o = new Owners({...f.config,projectOperations:{...f.config.projectOperations,copyParent:path}});
    await assert.rejects(o.validateLaunch(),unavailable); assert.equal(o.projectOperationOwner,null);
  }
});

test('operation parents are existing distinct directories outside package and .lmti',async t => {
  const f = await fixture(t); const hidden = join(f.root,'.lmti','copies'); await mkdir(hidden,{recursive:true});
  for (const path of [f.pkg,join(f.pkg,'bin'),hidden,f.backups,join(f.root,'missing'),f.config.python]) {
    const o = new Owners({...f.config,projectOperations:{...f.config.projectOperations,copyParent:path}});
    await assert.rejects(o.validateLaunch(),unavailable);
  }
  const o = new Owners({...f.config,library:join(f.pkg,'library.sqlite')});
  await assert.rejects(o.validateLaunch(),{code:'SCOPE_DENIED'});
});

test('participating paths reject a local parent junction and aliased library hardlink',async t => {
  const f = await fixture(t), alias = join(f.root,'copy-link');
  await symlink(f.copies,alias,process.platform === 'win32' ? 'junction' : 'dir');
  const linked = new Owners({...f.config,projectOperations:{...f.config.projectOperations,copyParent:alias}});
  await assert.rejects(linked.validateLaunch(),unavailable);
  await writeFile(f.config.library,'synthetic library'); await link(f.config.library,join(f.data,'alias.sqlite'));
  await assert.rejects(new Owners(f.config).validateLaunch(),unavailable);
});

test('operation owner shares main pool and dedicated verifier; draining includes both',async t => {
  const f = await fixture(t), owners = new Owners(f.config); await owners.validateLaunch();
  const calls = [], response = {ok:true,schema:'lmti.project.operations.v1',action:'library-format-status',
    libraryIdentity:f.read.binding.libraryIdentity,upgradeOperationId:null,legacyDigest:null,
    activationFormatOperationId:null,activationFormatBackupDigest:null};
  owners.pool.run = async (...args) => { calls.push(['main',args]); return response; };
  owners.verificationPool.run = async (...args) => { calls.push(['verify',args]); return response; };
  await owners.projectOperationOwner.read({action:'library-format-status'});
  await owners.projectOperationOwner.read({action:'library-format-status'},{verify:true});
  assert.deepEqual(calls.map(c => c[0]),['main','verify']);
  assert.equal(calls[0][1][0],f.config.adminBinary); assert.ok(calls[0][1][1].includes(f.copies));
  let releaseMain, releaseVerify, mainDone = false, verifyDone = false;
  const main = new Promise(r => { releaseMain = r; }), verify = new Promise(r => { releaseVerify = r; });
  owners.pool.waitForIdle = async () => { await main; mainDone = true; };
  owners.verificationPool.waitForIdle = async () => { await verify; verifyDone = true; };
  owners.pool.isIdle = () => mainDone; owners.verificationPool.isIdle = () => verifyDone;
  let drained = false; const draining = owners.waitForIdle().then(() => { drained = true; });
  releaseMain(); await new Promise(r => setImmediate(r)); assert.equal(drained,false); assert.equal(owners.isIdle(),false);
  releaseVerify(); await draining; assert.equal(owners.isIdle(),true);
});

test('profile save distinguishes known refusal, no-start, malformed completed ACK and valid commit',async t => {
  const f = await fixture(t), owners = new Owners(f.config); await owners.validateLaunch();
  for (const value of [null,{}, {ok:true}, {ok:false}, {ok:false,code:'invented'},
    {ok:false,code:'OWNER_UNAVAILABLE'}, {ok:true,binding:f.read.binding,profile:f.read.profile}]) {
    owners.pool.run = async () => value;
    await assert.rejects(owners.save('project',1,[]),unknown);
  }
  owners.pool.run = async () => ({ok:false,code:'REVISION_CONFLICT'});
  await assert.rejects(owners.save('project',1,[]),e => e.code === 'REVISION_CONFLICT' && !(e instanceof WriteOutcomeUnknown));
  owners.pool.run = async () => { throw new ApiError('SCOPE_DENIED'); };
  await assert.rejects(owners.save('project',1,[]),e => e.code === 'SCOPE_DENIED' && !(e instanceof WriteOutcomeUnknown));
  owners.pool.run = async () => ({ok:true,binding:f.read.binding,profile:{...f.read.profile,revision:2}});
  assert.equal((await owners.save('project',1,[])).profile.revision,2);
});

test('client writes require exact frozen target and action-specific successful acknowledgment',async t => {
  const f = await fixture(t), owners = new Owners(f.config); await owners.validateLaunch();
  const expected = 'c'.repeat(64), valid = {ok:true,state:'applied',target:join(f.data,'.codex/config.toml'),
    expected,changes:{added:[],updated:[],removed:[]},revision:1,verified:false};
  for (const value of [{ok:true},{...valid,target:join(f.copies,'.codex/config.toml')},
    {...valid,revision:2},{...valid,expected:'d'.repeat(64)},{...valid,verified:true},{...valid,extra:true},
    {...valid,changes:{added:['bad.id'],updated:[],removed:[]}}, {ok:false,code:'OWNER_UNAVAILABLE',error:'Unavailable.'}]) {
    owners.pool.run = async () => value;
    await assert.rejects(owners.client('apply',f.read,'codex',expected),unknown);
  }
  owners.pool.run = async () => ({ok:false,code:'CONFIG_CHANGED',error:'Changed.'});
  await assert.rejects(owners.client('apply',f.read,'codex',expected),e => e.code === 'CONFIG_CHANGED' && !(e instanceof WriteOutcomeUnknown));
  owners.pool.run = async () => valid;
  assert.equal((await owners.client('apply',f.read,'codex',expected)).state,'applied');
  owners.pool.run = async () => ({ok:true,state:'restored',target:join(f.data,'.codex/config.toml')});
  assert.equal((await owners.client('restore_commit',f.read,'codex',expected)).state,'restored');
  owners.pool.run = async () => ({ok:true,state:'applied',target:join(f.data,'.codex/config.toml')});
  await assert.rejects(owners.client('restore_commit',f.read,'codex',expected),unknown);
});

test('proposal commit never exposes malformed started success as a retryable failure',async t => {
  const f = await fixture(t), owners = new Owners(f.config); await owners.validateLaunch();
  const grant = {projectId:'project',site:'site',target:'external',integrationConfig:null};
  const proposal = {schema:'lmti.topology.proposal.v1',baseRevision:1,assetId:'asset',site:'site',expected:{enabled:true,pollMs:1000},desired:{enabled:true,pollMs:2000}};
  const request = {expectedProjectRevision:1,proposal};
  for (const value of [null,{ok:true},{ok:false,error:{code:['REVISION_CONFLICT']}},{ok:false,error:{}},{ok:false,error:{code:'OWNER_UNAVAILABLE'}}]) {
    owners.pool.run = async () => value;
    await assert.rejects(owners.proposal(f.read,grant,'commit-proposal',request),unknown);
  }
  owners.pool.run = async () => ({ok:false,error:{code:'REVISION_CONFLICT'}});
  await assert.rejects(owners.proposal(f.read,grant,'commit-proposal',request),e => e.code === 'REVISION_CONFLICT' && !(e instanceof WriteOutcomeUnknown));
  owners.pool.run = async () => ({ok:true,projectId:'project',projectRevision:2,topologyRevision:2,proposal,
    diff:{expected:proposal.expected,desired:proposal.desired},status:'committed',deviceActions:false});
  assert.equal((await owners.proposal(f.read,grant,'commit-proposal',request)).projectRevision,2);
});
