import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { ApiError } from '../dist/security.js';
import { ProcessPool, WriteOutcomeUnknown } from '../dist/process.js';
import { recoveryValueKey } from '../dist/legacy-recovery-target.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const scratch = resolve(process.env.LMTI_WEB_TEST_TMP ?? join(repo,'build'));
const projectId = 'project', uuid = '11111111-2222-4333-8444-555555555555';
const otherUuid = '22222222-2222-4333-8444-555555555555';
const schema = 'lmti.mcp.original-read.v1', clone = v => structuredClone(v);
const frame = v => Buffer.from(JSON.stringify(v)+'\n');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject) => {
    timer = setTimeout(() => reject(new Error('Controlled queue did not complete.')),5000);
  })]); } finally { clearTimeout(timer); }
}
async function fixture(t,{librarySchema = 3,projectSchema = 2,profiles = true,effect = {kind:'profile_save'}} = {}) {
  await mkdir(scratch,{recursive:true});
  const root = await mkdtemp(join(scratch,'original-api-'));
  const finalizers = [];
  t.after(async () => {
    for (const finish of finalizers) await finish();
    assert.ok(resolve(root).startsWith(scratch+sep));
    await rm(root,{recursive:true,force:true});
  });
  const scripts = join(root,'scripts'), data = join(root,'data'), linked = join(root,'linked');
  for (const path of [scripts,data,linked]) await mkdir(path);
  const config = {adminBinary:join(scripts,'lmti-mcp-admin.exe'),projectBinary:join(scripts,'lmti-project.exe'),
    python:join(scripts,'python.exe'),agentEntry:join(scripts,'lmti-agent-mcp.py'),
    configOwner:join(scripts,'mcp-config-owner.py'),library:join(data,'library.sqlite'),
    profiles:join(data,'profiles.sqlite'),allowedProjects:[projectId],port:0,openBrowser:false};
  for (const path of [config.adminBinary,config.projectBinary,config.python,config.agentEntry,config.configOwner,
    join(scripts,'web-broker-guard.py'),config.library,join(data,'project.sqlite'),...(profiles ? [config.profiles] : [])])
    await writeFile(path,'Inert controlled fixture; never executed.');
  const read = {binding:{id:projectId,name:'Synthetic project',database:join(data,'project.sqlite'),root:linked,projectRevision:1,
    libraryIdentity:{schema:librarySchema,canonicalPath:config.library.replaceAll('\\','/'),
      uuid:librarySchema === 1 ? null : uuid,generation:librarySchema === 1 ? null : 1,digest:'a'.repeat(64)},
    projectIdentity:{schema:projectSchema,storeUuid:projectSchema === 1 ? null : uuid,revision:1}},
    profile:{projectId,revision:profiles ? 1 : 0,servers:[]}};
  const owners = new Owners(config); await owners.validateLaunch();
  const f = {root,data,linked,config,read,owners,finalizers,calls:[],reply:null,target:null};
  f.reply = () => ({ok:true,schema,action:'read-original',...clone(read)});
  owners.pool.run = async () => { assert.fail('Conditional reads must not use the main pool or ordinary native route.'); };
  owners.verificationPool.run = async (binary,args,input,options = {}) => {
    await options.guard?.();
    f.calls.push({binary,args,input,options,request:JSON.parse(input)});
    return typeof f.reply === 'function' ? f.reply() : clone(f.reply);
  };
  f.target = await owners.captureLegacyTarget(read,effect);
  f.calls.length = 0;
  return f;
}
const verify = (f,extra = {}) => f.owners.verifyLegacyTarget(f.target,{verify:true,...extra});
function assertTransport(f,call,allowMissing = false) {
  assert.equal(call.binary,f.config.adminBinary);
  assert.deepEqual(call.args,['--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles]);
  assert.deepEqual(call.request,{action:'read-original',allowMissingProfile:allowMissing,expected:{
    version:1,projectId,library:f.target.library,project:f.target.project,profiles:f.target.profiles,linkedRoot:f.target.linkedRoot}});
  assert.equal(call.options.cap,128*1024); assert.equal(call.options.timeoutMs,30000);
  assert.equal(call.options.newlineTerminated,true); assert.equal(typeof call.options.guard,'function');
  assert.equal(call.options.raw,undefined); assert.equal(call.options.write,undefined);
  assert.equal(call.options.jsonArrayLimit,undefined); assert.ok(Buffer.byteLength(call.input) <= 64*1024);
}
function unavailable(error) {
  return error instanceof ApiError && !(error instanceof WriteOutcomeUnknown) &&
    error.code === 'OWNER_UNAVAILABLE' && !error.message.includes('sqlite') && !error.message.includes(uuid);
}

test('conditional read projects frozen original pins through only the dedicated fixed transport',async t => {
  const f = await fixture(t,{effect:{kind:'client_restore',client:'cursor'}});
  const before = recoveryValueKey(f.target), result = await verify(f);
  assert.deepEqual(result,f.read); assert.equal(f.calls.length,1); assertTransport(f,f.calls[0]);
  assert.equal(recoveryValueKey(f.target),before);
  for (const physical of [f.calls[0].request.expected.library.physical,f.calls[0].request.expected.project.physical,
    f.calls[0].request.expected.profiles])
    for (const row of physical.chain) for (const key of ['dev','ino','birthtimeNs']) {
      assert.equal(typeof row[key],'string'); assert.match(row[key],/^(0|[1-9][0-9]*)$/);
    }
  const serialized = f.calls[0].request.expected;
  for (const privateField of ['domainId','action','client','profile','content']) assert.equal(Object.hasOwn(serialized,privateField),false);
});

test('native read has no Python, Agent-entry, project-executable or config-owner dependency after launch',async t => {
  const f = await fixture(t);
  for (const [index,path] of [f.config.python,f.config.agentEntry,f.config.projectBinary,f.config.configOwner].entries())
    await rename(path,join(f.root,`retained-dependency-${index}`));
  assert.deepEqual(await verify(f),f.read); assert.equal(f.calls.length,1); assertTransport(f,f.calls[0]);
  await rename(f.config.adminBinary,join(f.root,'retained-admin'));
  f.calls.length = 0;
  await assert.rejects(verify(f),unavailable); assert.deepEqual(f.calls,[]);
});

test('native canonical library identity remains an opaque key and never replaces the fixed I/O path',async t => {
  const f = await fixture(t), expected = clone(f.target);
  expected.library.canonicalPath = join(f.root,'native-strasse-key-測試.sqlite').replaceAll('\\','/');
  f.read.binding.libraryIdentity.canonicalPath = expected.library.canonicalPath;
  const result = await f.owners.verifyLegacyTarget(expected,{verify:true});
  assert.equal(result.binding.libraryIdentity.canonicalPath,expected.library.canonicalPath);
  assert.equal(f.calls[0].request.expected.library.canonicalPath,expected.library.canonicalPath);
  assert.equal(f.calls[0].request.expected.library.physical.path,f.config.library);
  assert.deepEqual(f.calls[0].args,['--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles]);
});

test('schema1 null identities, schema2/3 generations and largest valid mutable revisions remain exact',async t => {
  for (const librarySchema of [1,2,3]) for (const projectSchema of [1,2]) {
    const f = await fixture(t,{librarySchema,projectSchema});
    f.read.binding.projectRevision = f.read.binding.projectIdentity.revision = Number.MAX_SAFE_INTEGER-1;
    f.read.profile.revision = Number.MAX_SAFE_INTEGER;
    if (librarySchema !== 1) f.read.binding.libraryIdentity.generation = Number.MAX_SAFE_INTEGER;
    f.read.binding.libraryIdentity.digest = 'b'.repeat(64);
    const result = await verify(f);
    assert.deepEqual(result,f.read); assertTransport(f,f.calls[0]);
    assert.equal(result.binding.projectIdentity.storeUuid,projectSchema === 1 ? null : uuid);
    assert.equal(result.binding.libraryIdentity.uuid,librarySchema === 1 ? null : uuid);
  }
});

test('seven strictly typed native refusal codes propagate without ordinary-read fallback or retry',async t => {
  const f = await fixture(t);
  for (const code of ['INVALID_INPUT','SCOPE_DENIED','CONFIG_CHANGED','OWNER_UNAVAILABLE','NOT_SUPPORTED','LIMIT_EXCEEDED','RECOVERY_REQUIRED']) {
    f.reply = {ok:false,code}; f.calls.length = 0;
    await assert.rejects(verify(f),e => e instanceof ApiError && !(e instanceof WriteOutcomeUnknown) && e.code === code);
    assert.equal(f.calls.length,1); assertTransport(f,f.calls[0]);
  }
});

test('strict envelopes reject coercion, extra fields and cross-protocol errors as unavailable reads',async t => {
  const f = await fixture(t), valid = f.reply();
  for (const value of [null,[],true,{...valid,ok:1},{...valid,extra:uuid},
    {...valid,schema:'lmti.agent.response.v1'},{...valid,action:'read'}, {...valid,content:'private'},
    {ok:true,binding:valid.binding,profile:valid.profile},
    {ok:false,code:['CONFIG_CHANGED']},{ok:false,code:null},{ok:false,code:'REVISION_CONFLICT'},
    {ok:false,code:'CONFIG_CHANGED',detail:f.config.library},{ok:false,error:{code:'CONFIG_CHANGED'}}]) {
    f.reply = value; f.calls.length = 0;
    await assert.rejects(verify(f),unavailable); assert.equal(f.calls.length,1);
  }
  let attempts = 0;
  f.owners.verificationPool.run = async () => { attempts++; throw new Error(`Untrusted diagnostic ${f.config.library}`); };
  await assert.rejects(verify(f),unavailable); assert.equal(attempts,1);
});

test('nested binding/profile decoders enforce safe identity, revision, null and complete server shapes',async t => {
  const f = await fixture(t), valid = f.reply();
  const changes = [
    v => { v.binding.id = 'other'; },v => { v.profile.projectId = 'other'; },
    v => { v.binding.projectRevision = v.binding.projectIdentity.revision = Number.MAX_SAFE_INTEGER; },
    v => { v.binding.projectRevision = v.binding.projectIdentity.revision = 0; },
    v => { v.binding.projectIdentity.revision = 2; },v => { v.profile.revision = -1; },
    v => { v.profile.revision = Number.MAX_SAFE_INTEGER+1; },v => { v.binding.libraryIdentity.generation = 0; },
    v => { v.binding.libraryIdentity.generation = '1'; },v => { v.binding.libraryIdentity.uuid = null; },
    v => { v.binding.projectIdentity.storeUuid = null; },v => { v.binding.projectIdentity.storeUuid = '00000000-0000-0000-0000-000000000000'; },
    v => { v.binding.libraryIdentity.digest = 'a'.repeat(63); },v => { v.binding.libraryIdentity.extra = true; },
    v => { v.binding.database = '\\\\untrusted\\share\\project.sqlite'; },v => { v.binding.root = f.linked+':stream'; },
    v => { v.profile.servers = Array(33).fill({}); },v => { v.profile.extra = 'private'; },
    v => { v.profile.servers = [{id:'tool',label:'Tool',enabled:true,transport:'lmti_local',auth:'none',site:'site',endpoint:'extra'}]; },
    v => { v.profile.servers = [{id:'tool',label:'Tool',enabled:'true',transport:'lmti_local',auth:'none',site:'site'}]; },
    v => { v.profile.servers = Array(2).fill({id:'tool',label:'Tool',enabled:true,transport:'lmti_local',auth:'none',site:'site'}); }
  ];
  for (const change of changes) {
    f.reply = clone(valid); change(f.reply);
    await assert.rejects(verify(f),unavailable);
  }
  const legacy = await fixture(t,{librarySchema:1,projectSchema:1}), legacyValid = legacy.reply();
  for (const change of [v => { v.binding.libraryIdentity.uuid = uuid; },
    v => { v.binding.libraryIdentity.generation = 1; },v => { v.binding.projectIdentity.storeUuid = uuid; }]) {
    legacy.reply = clone(legacyValid); change(legacy.reply); await assert.rejects(verify(legacy),unavailable);
  }
});

test('valid but different immutable identities refuse before any client configuration inspection',async t => {
  const f = await fixture(t,{effect:{kind:'client_apply',client:'codex'}}), valid = f.reply();
  for (const change of [
    v => { v.binding.database = join(f.root,'never-opened.sqlite'); },
    v => { v.binding.root = join(f.root,'never-opened-root'); },
    v => { v.binding.projectIdentity.storeUuid = otherUuid; },
    v => { v.binding.libraryIdentity.uuid = otherUuid; },
    v => { v.binding.libraryIdentity.canonicalPath = join(f.root,'different-key.sqlite'); },
    v => { v.binding.projectIdentity.schema = 1; v.binding.projectIdentity.storeUuid = null; },
    v => { v.binding.libraryIdentity.schema = 2; }
  ]) {
    f.reply = clone(valid); change(f.reply); f.calls.length = 0;
    await assert.rejects(f.owners.inspectLegacyRecovery(f.target,{verify:true}),{code:'CONFIG_CHANGED'});
    assert.equal(f.calls.length,1); assertTransport(f,f.calls[0]);
  }
});

test('same-store content revisions are evidence while physical replacement and stale capture are refused',async t => {
  const f = await fixture(t), run = f.owners.verificationPool.run;
  const oldRead = clone(f.read); f.read.profile.revision++;
  await assert.rejects(f.owners.captureLegacyTarget(oldRead,{kind:'profile_save'}),{code:'REVISION_CONFLICT'});
  f.owners.verificationPool.run = async (...args) => {
    const result = await run(...args);
    await rename(f.read.binding.database,join(f.data,'retained-project.sqlite'));
    await writeFile(f.read.binding.database,'replacement same path');
    return result;
  };
  await assert.rejects(verify(f),{code:'CONFIG_CHANGED'});
  assert.equal(f.calls.some(c => c.binary === f.config.python),false);
});

test('missing profile is permitted only for explicit prewrite verification and never rebound to appeared file',async t => {
  const f = await fixture(t,{profiles:false});
  assert.equal(f.target.profiles.state,'missing'); assert.equal(f.read.profile.revision,0);
  assert.deepEqual(await verify(f,{allowMissing:true}),f.read); assertTransport(f,f.calls[0],true);
  f.calls.length = 0;
  await assert.rejects(f.owners.inspectLegacyRecovery(f.target,{verify:true}),{code:'RECOVERY_REQUIRED'});
  assert.deepEqual(f.calls,[]);
  await writeFile(f.config.profiles,'new file cannot acquire original provenance');
  await assert.rejects(verify(f,{allowMissing:true}),{code:'CONFIG_CHANGED'}); assert.deepEqual(f.calls,[]);
});

test('oversized target and denied original domain are refused before queueing',async t => {
  const f = await fixture(t);
  const target = clone(f.target), volume = parse(f.root).root;
  // Three independently well-shaped 64-element chains exceed the public
  // subject's existing 30 KiB bound. No such target reaches the defensive
  // native request's larger 64 KiB limit.
  const physical = () => ({version:1,kind:'file',state:'present',
    path:join(volume,...Array.from({length:63},(_,i) => `p${i}`)),
    chain:Array.from({length:64},() => ({dev:'9'.repeat(40),ino:'8'.repeat(40),birthtimeNs:'7'.repeat(40)}))});
  target.library.physical = physical(); target.project.physical = physical(); target.profiles = physical();
  await assert.rejects(f.owners.verifyLegacyTarget(target,{verify:true}),{code:'LIMIT_EXCEEDED'});
  await assert.rejects(f.owners.verifyLegacyTarget({...f.target,domainId:'b'.repeat(64)},{verify:true}),{code:'SCOPE_DENIED'});
  assert.deepEqual(f.calls,[]);
});

// These children emit controlled bytes through the real ProcessPool; the
// injected spawn executable is Node, not the inert fixture admin path.
// Native SQLite/lease correctness is covered by the separate native suite.
const emitScript = "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(fs.readFileSync(process.argv[1]));process.exitCode=Number(process.argv[2]);});";
async function bytePool(f) {
  const output = join(f.root,'controlled-response.bin'); await writeFile(output,frame(f.reply()));
  const state = {exit:0,starts:0,calls:[]};
  const pool = new ProcessPool(1,(binary,args,options) => {
    state.starts++;
    assert.equal(binary,f.config.adminBinary);
    assert.deepEqual(args,['--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles]);
    assert.equal(options.shell,false); assert.equal(options.windowsHide,true);
    return spawn(process.execPath,['-e',emitScript,output,String(state.exit)],options);
  });
  const run = pool.run.bind(pool);
  pool.run = (binary,args,input,options) => {
    state.calls.push({binary,args,input,options,request:JSON.parse(input)});
    return run(binary,args,input,options);
  };
  f.owners.verificationPool = pool;
  f.finalizers.push(() => pool.waitForIdle());
  return {pool,output,state};
}

test('real byte transport refuses duplicates, invalid UTF8, missing LF, trailing data, overflow and nonzero exit', {timeout:20000},async t => {
  const f = await fixture(t), valid = frame(f.reply()), b = await bytePool(f);
  assert.deepEqual(await verify(f),f.read); assertTransport(f,b.state.calls[0]);
  const label = Buffer.from('Synthetic project'), labelAt = valid.indexOf(label); assert.ok(labelAt >= 0);
  for (const bytes of [
    Buffer.from(valid.toString().replace('"ok":true','"ok":true,"ok":true')),
    Buffer.concat([valid.subarray(0,labelAt),Buffer.from([0xff]),valid.subarray(labelAt+label.length)]),
    valid.subarray(0,valid.length-1),Buffer.concat([valid,Buffer.from('{}\n')]),
    Buffer.concat([valid,Buffer.from([0])]),Buffer.from('null\n'),Buffer.alloc(128*1024+1,32)
  ]) {
    await writeFile(b.output,bytes); const before = b.state.starts;
    await assert.rejects(verify(f),unavailable); assert.equal(b.state.starts,before+1);
  }
  await writeFile(b.output,valid); b.state.exit = 1;
  await assert.rejects(verify(f),unavailable);
  b.state.exit = 0;
  await writeFile(b.output,Buffer.concat([valid.subarray(0,valid.length-1),Buffer.alloc(128*1024-valid.length,32),Buffer.from('\n')]));
  assert.deepEqual(await verify(f),f.read);
  assert.ok(b.pool.isIdle()); assert.equal(b.state.starts,10);
});

test('queued verification rechecks async authority and original physical targets before spawning', {timeout:20000},async t => {
  for (const change of ['authority','profiles']) {
    const f = await fixture(t), b = await bytePool(f);
    const acquired = deferred(), release = deferred(), enqueued = deferred();
    const blocker = b.pool.run(f.config.adminBinary,
      ['--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles],
      JSON.stringify({action:'controlled-blocker'}),{newlineTerminated:true,guard:async () => {
        acquired.resolve(); await release.promise;
      }});
    await bounded(acquired.promise);
    let allowed = true;
    const originalRun = b.pool.run.bind(b.pool);
    b.pool.run = (...args) => { enqueued.resolve(); return originalRun(...args); };
    const reading = verify(f,{guard:async () => {
      await new Promise(r => setImmediate(r)); if (!allowed) throw new ApiError('SESSION_EXPIRED');
    }});
    const refusal = assert.rejects(reading,{code:change === 'authority' ? 'SESSION_EXPIRED' : 'CONFIG_CHANGED'});
    try {
      await bounded(enqueued.promise);
      if (change === 'authority') allowed = false;
      else {
        await rename(f.config.profiles,join(f.data,'retained-profiles'));
        await writeFile(f.config.profiles,'replacement');
      }
    } finally { release.resolve(); }
    await bounded(Promise.all([blocker,refusal]));
    assert.equal(b.state.starts,1,'Only the already admitted blocker may start.');
    assert.ok(b.pool.isIdle());
  }
});

test('authority revoked after native reply discards evidence without client inspection or retry',async t => {
  const f = await fixture(t,{effect:{kind:'client_apply',client:'codex'}}), run = f.owners.verificationPool.run;
  let allowed = true;
  f.owners.verificationPool.run = async (...args) => { const result = await run(...args); allowed = false; return result; };
  await assert.rejects(f.owners.inspectLegacyRecovery(f.target,{verify:true,guard:async () => {
    await new Promise(r => setImmediate(r)); if (!allowed) throw new ApiError('SESSION_EXPIRED');
  }}),{code:'SESSION_EXPIRED'});
  assert.equal(f.calls.length,1); assertTransport(f,f.calls[0]);
});

test('a sole main write slot can verify via the independent pool and preserves known save without a postwrite read', {timeout:15000},async t => {
  const f = await fixture(t), verified = await bytePool(f), saveOutput = join(f.root,'save-response.bin');
  const saved = {ok:true,...clone(f.read)}; saved.profile.revision = 2;
  await writeFile(saveOutput,frame(saved));
  let saveStarts = 0, guardCalls = 0, verifyStartsAtSave = 0;
  const main = new ProcessPool(1,(binary,args,options) => {
    saveStarts++; verifyStartsAtSave = verified.state.starts;
    assert.equal(binary,f.config.adminBinary); assert.equal(options.shell,false);
    return spawn(process.execPath,['-e',emitScript,saveOutput,'0'],options);
  });
  const mainRun = main.run.bind(main);
  // If a regression queues a verification behind its own main write slot,
  // reject the read wait in bounded time so the writer guard can release the
  // slot and the fixture can drain. Correct code never takes this read branch.
  main.run = (...args) => args[3]?.write ? mainRun(...args) : bounded(mainRun(...args));
  f.owners.pool = main; f.finalizers.push(() => main.waitForIdle());
  const result = await bounded(f.owners.save(projectId,1,[],async () => {
    guardCalls++; assert.equal(main.isIdle(),false); await new Promise(r => setImmediate(r));
  },f.target));
  assert.equal(result.profile.revision,2); assert.equal(saveStarts,1);
  assert.equal(verifyStartsAtSave,1); assert.equal(verified.state.starts,1);
  assert.equal(guardCalls,2); assert.ok(main.isIdle() && verified.pool.isIdle());
});
