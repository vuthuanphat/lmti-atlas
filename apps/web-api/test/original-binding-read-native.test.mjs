import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { ProcessPool } from '../dist/process.js';
import { ApiError } from '../dist/security.js';
import { recoveryValueKey } from '../dist/legacy-recovery-target.js';
import { checkedRecoverySubject, canonicalRecoveryJson } from '../dist/recovery-subject.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';

const required = [
  'LMTI_WEB_TEST_ADMIN','LMTI_WEB_TEST_BINDING_PRODUCER','LMTI_WEB_TEST_PROJECT_BINARY',
  'LMTI_WEB_TEST_PYTHON','LMTI_WEB_TEST_CONFIG_OWNER',
];
// A partially configured run fails in fixture(), rather than silently skipping.
const configured = required.some(key => Boolean(process.env[key]));
const options = {skip:!configured,timeout:120000};
const repo = fileURLToPath(new URL('../../../',import.meta.url));
const scratch = resolve(process.env.LMTI_WEB_TEST_TMP ?? join(repo,'build'));
const projectId = 'factory-monitor';
const matrix = [[1,1],[3,2]];
const sha = value => createHash('sha256').update(value).digest('hex');
const code = value => error => error instanceof ApiError && error.code === value;
const unchanged = () => {};

function fixedEnvironment() {
  const env = {};
  // The fixed fixture producer may use root's pinned build/Qt PATH. Actual
  // Owners/ProcessPool children retain their unchanged sanitized environment.
  for (const key of ['SystemRoot','WINDIR','PATH']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function contained(root,path) {
  assert.ok(isAbsolute(root) && isAbsolute(path));
  const relative = resolve(path).slice(resolve(root).length);
  assert.ok(resolve(path).startsWith(resolve(root)+sep) && relative.length > 1,
    'Fixture operation must remain below its uniquely owned directory.');
}
async function ordinaryDirectory(path) {
  const value = await lstat(path);
  assert.equal(value.isSymbolicLink(),false);
  assert.equal(value.isDirectory(),true);
  assert.equal((await realpath(path)).toLowerCase(),resolve(path).toLowerCase());
}
async function tree(root) {
  await ordinaryDirectory(root);
  const rows = [];
  async function visit(path,relative) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path,name),label = relative ? `${relative}/${name}` : name;
      contained(root,child);
      const info = await lstat(child);
      assert.equal(info.isSymbolicLink(),false,'Controlled fixture contains a redirected entry.');
      if (info.isDirectory()) { rows.push([label,'directory']); await visit(child,label); }
      else {
        assert.equal(info.isFile(),true);
        assert.equal(info.nlink,1,'Controlled fixture contains a file alias.');
        rows.push([label,info.size,sha(await readFile(child))]);
      }
    }
  }
  await visit(root,''); return rows;
}
async function readOnly(f,read) {
  const before = await tree(f.root);
  try { return await read(); }
  finally { assert.deepEqual(await tree(f.root),before,'Read changed fixture entries or bytes.'); }
}
function fixtureCommand(root,...args) {
  const result = spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,args,{
    env:fixedEnvironment(),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384,
  });
  assert.equal(result.error,undefined,'Fixed native fixture producer could not run.');
  assert.equal(result.status,0,'Fixed native fixture producer failed.');
  assert.equal(result.stderr,'');
  assert.ok(isAbsolute(root));
}
async function fixture(t,librarySchema,projectSchema) {
  assert.equal(process.platform,'win32','Configured evidence requires the native Windows namespace boundary.');
  for (const key of required) {
    assert.ok(typeof process.env[key] === 'string' && isAbsolute(process.env[key]),`${key} is required.`);
    assert.equal((await lstat(process.env[key])).isFile(),true);
  }
  await mkdir(scratch,{recursive:true}); await ordinaryDirectory(scratch);
  const owned = await mkdtemp(join(scratch,'original-read-api-'));
  const root = join(owned,'Dự án kiểm chứng');
  contained(scratch,owned); contained(owned,root); await mkdir(root);
  const coordinators = [],leases = [];
  let owners;
  t.after(async () => {
    for (const lease of leases) lease.release('known');
    await Promise.all(coordinators.map(value => value.close()));
    if (owners) await owners.waitForIdle();
    contained(scratch,owned);
    // Validate the complete disposable tree before any recursive cleanup.
    await tree(owned);
    await rm(owned,{recursive:true,force:false});
  });
  fixtureCommand(root,'--fixture',root,String(librarySchema),String(projectSchema));
  const configOwner = process.env.LMTI_WEB_TEST_CONFIG_OWNER;
  const config = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN,projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY,
    python:process.env.LMTI_WEB_TEST_PYTHON,agentEntry:join(dirname(configOwner),'lmti-agent-mcp.py'),configOwner,
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),
    allowedProjects:[projectId],port:0,openBrowser:false,
  };
  const trace = {children:0,calls:[]};
  owners = new Owners(config);
  owners.pool = new ProcessPool(1);
  // Real ProcessPool and real children; this records routing without replacing
  // the native response or the queued guard with a fake.
  const verify = new ProcessPool(1,(...args) => { trace.children++; return spawn(...args); });
  const run = verify.run.bind(verify);
  verify.run = async (binary,args,input,settings) => {
    trace.calls.push({binary,args:[...args],request:JSON.parse(input)});
    return run(binary,args,input,settings);
  };
  owners.verificationPool = verify;
  await owners.validateLaunch();
  return {root,config,owners,verify,trace,librarySchema,projectSchema,coordinators,leases};
}
function request(target,allowMissingProfile = false) {
  return {action:'read-original',allowMissingProfile,expected:{
    version:1,projectId:target.projectId,library:target.library,project:target.project,
    profiles:target.profiles,linkedRoot:target.linkedRoot,
  }};
}
async function direct(f,target,allowMissingProfile = false) {
  return f.verify.run(f.config.adminBinary,[
    '--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles,
  ],JSON.stringify(request(target,allowMissingProfile)),{
    cap:128*1024,newlineTerminated:true,timeoutMs:30000,
  });
}
async function assertBigIntChain(target) {
  assert.equal(target.state,'present');
  const volume = parse(target.path).root;
  const paths = [volume];
  for (const segment of target.path.slice(volume.length).split(/[\\/]/).filter(Boolean))
    paths.push(join(paths.at(-1),segment));
  assert.equal(target.chain.length,paths.length);
  for (let index=0;index<paths.length;index++) {
    const info = await lstat(paths[index],{bigint:true});
    assert.deepEqual(target.chain[index],{
      dev:info.dev.toString(),ino:info.ino.toString(),birthtimeNs:info.birthtimeNs.toString(),
    });
    for (const value of Object.values(target.chain[index])) {
      assert.equal(typeof value,'string');
      assert.equal(BigInt(value).toString(),value);
    }
  }
}
function assertConditionalCalls(f,target) {
  assert.ok(f.trace.calls.length > 0);
  for (const call of f.trace.calls) {
    assert.equal(call.binary,f.config.adminBinary);
    assert.deepEqual(call.args,[
      '--original-binding-read','--library',f.config.library,'--profiles',f.config.profiles,
    ]);
    assert.equal(recoveryValueKey(call.request.expected),recoveryValueKey(request(target).expected));
    assert.equal(call.request.action,'read-original');
  }
}
async function moveFixtureFile(f,source,destination) {
  contained(f.root,source); contained(f.root,destination);
  const before = await lstat(source);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  await assert.rejects(lstat(destination),error => error.code === 'ENOENT');
  await rename(source,destination);
}

test('real original reads preserve Node BigInt pins and Unicode across legacy/durable schema pairs',options,async t => {
  for (const [librarySchema,projectSchema] of matrix) {
    const f = await fixture(t,librarySchema,projectSchema);
    await readOnly(f,async () => {
      const initial = await f.owners.read(projectId);
      assert.equal(initial.binding.libraryIdentity.schema,librarySchema);
      assert.equal(initial.binding.projectIdentity.schema,projectSchema);
      assert.ok(initial.binding.database.includes('Dự án kiểm chứng'));
      const target = await f.owners.captureLegacyTarget(initial,{kind:'profile_save'});
      const retained = canonicalRecoveryJson(target);
      for (const value of [target.library.physical,target.project.physical,target.profiles])
        await assertBigIntChain(value);
      assert.equal(target.library.uuid,librarySchema === 1 ? null : initial.binding.libraryIdentity.uuid);
      assert.equal(target.project.storeUuid,projectSchema === 1 ? null : initial.binding.projectIdentity.storeUuid);
      const current = await f.owners.verifyLegacyTarget(target,{verify:true});
      assert.deepEqual(current,initial);
      const observed = await f.owners.inspectLegacyRecovery(target,{verify:true});
      assert.deepEqual(observed.summary,{
        projectId,projectRevision:initial.binding.projectRevision,profileRevision:initial.profile.revision,clients:[],
      });
      assertConditionalCalls(f,target);
      assert.equal(f.trace.calls[0].request.allowMissingProfile,true);
      assert.equal(f.trace.calls.at(-1).request.allowMissingProfile,false);
      assert.equal(canonicalRecoveryJson(target),retained);
    });
  }
});

test('real absent final profile permits prewrite capture but never proves unknown creation or recaptures appearance',options,async t => {
  for (const [librarySchema,projectSchema] of matrix) {
    const f = await fixture(t,librarySchema,projectSchema);
    const retained = join(f.root,'retained-profiles.sqlite');
    await moveFixtureFile(f,f.config.profiles,retained);
    const target = await readOnly(f,async () => {
      const initial = await f.owners.read(projectId);
      assert.deepEqual(initial.profile,{projectId,revision:0,servers:[]});
      const value = await f.owners.captureLegacyTarget(initial,{kind:'profile_save'});
      assert.equal(value.profiles.state,'missing');
      const fresh = await f.owners.verifyLegacyTarget(value,{verify:true,allowMissing:true});
      assert.deepEqual(fresh.profile,initial.profile);
      const before = f.trace.children;
      await assert.rejects(f.owners.inspectLegacyRecovery(value,{verify:true}),code('RECOVERY_REQUIRED'));
      assert.equal(f.trace.children,before,'Unknown missing-profile recovery spawned a child.');
      const native = await direct(f,value);
      assert.equal(canonicalRecoveryJson(native),canonicalRecoveryJson({ok:false,code:'RECOVERY_REQUIRED'}));
      return value;
    });
    await moveFixtureFile(f,retained,f.config.profiles);
    await readOnly(f,async () => {
      const before = f.trace.children;
      await assert.rejects(f.owners.verifyLegacyTarget(target,{verify:true,allowMissing:true}),code('CONFIG_CHANGED'));
      assert.equal(f.trace.children,before,'Appeared profile was read through a substituted target.');
      const native = await direct(f,target,true);
      assert.equal(canonicalRecoveryJson(native),canonicalRecoveryJson({ok:false,code:'CONFIG_CHANGED'}));
      assert.equal(target.profiles.state,'missing');
    });
  }
});

test('real same-path project/library substitution is refused before TS child dispatch and by the native original mode',options,async t => {
  for (const action of ['replace-project','replace-library']) {
    const f = await fixture(t,3,2);
    const initial = await f.owners.read(projectId);
    const target = await f.owners.captureLegacyTarget(initial,{kind:'profile_save'});
    const source = action === 'replace-project' ? initial.binding.database : f.config.library;
    const original = await readFile(source);
    fixtureCommand(f.root,'--mutate',f.root,action);
    const retained = join(f.root,action === 'replace-project' ? 'retained-project.sqlite' : 'retained-library.sqlite');
    contained(f.root,retained);
    assert.deepEqual(await readFile(retained),original);
    await readOnly(f,async () => {
      const before = f.trace.children;
      await assert.rejects(f.owners.inspectLegacyRecovery(target,{verify:true}),code('CONFIG_CHANGED'));
      assert.equal(f.trace.children,before,'Substituted original target reached a child.');
      assert.equal(canonicalRecoveryJson(await direct(f,target)),canonicalRecoveryJson({ok:false,code:'CONFIG_CHANGED'}));
    });
  }
});

test('actual profile save guard uses conditional verification and retained target allows fresh mutable revision',options,async t => {
  const f = await fixture(t,3,2);
  const initial = await f.owners.read(projectId);
  const target = await f.owners.captureLegacyTarget(initial,{kind:'profile_save'});
  const identity = canonicalRecoveryJson(target);
  const before = [sha(await readFile(f.config.library)),sha(await readFile(initial.binding.database))];
  const servers = initial.profile.servers.map(row => ({...row,label:'Reviewed local context'}));
  const saved = await f.owners.save(projectId,initial.profile.revision,servers,unchanged,target);
  assert.equal(saved.profile.revision,initial.profile.revision+1);
  assert.deepEqual(saved.profile.servers,servers);
  assert.deepEqual([sha(await readFile(f.config.library)),sha(await readFile(initial.binding.database))],before);
  await readOnly(f,async () => {
    const observed = await f.owners.inspectLegacyRecovery(target,{verify:true});
    assert.equal(observed.summary.profileRevision,saved.profile.revision);
    assert.equal(canonicalRecoveryJson(target),identity);
    assertConditionalCalls(f,target);
  });
});

test('same-process complete-union review uses real observations and requires explicit acknowledgment',options,async t => {
  const f = await fixture(t,3,2);
  const initial = await f.owners.read(projectId);
  const target = await f.owners.captureLegacyTarget(initial,{kind:'profile_save'});
  const domain = f.owners.recoveryDomainId();
  const subject = checkedRecoverySubject({
    version:1,kind:'legacy',action:'profile_save',projectId,grantId:domain,target,
  });
  const coordinator = await WriteCoordinator.create(f.config.library,undefined,undefined,{domainId:domain});
  f.coordinators.push(coordinator);
  const lease = coordinator.acquire('shared',projectId,coordinator.snapshot().epoch,subject);
  f.leases.push(lease); await lease.beforeStart();
  // Controlled same-process barrier fixture only. This does not simulate a
  // native commit, lost pipe acknowledgment or broker process restart.
  lease.release('unknown'); await coordinator.waitForIdle();
  assert.equal(coordinator.recovery().coverage,'complete');
  assert.equal(coordinator.recovery().subjects.length,1);
  const token = coordinator.beginReconciliation();
  const inspected = [];
  const collect = {
    guard:unchanged,
    authorize:value => {
      assert.equal(value.kind,'legacy'); assert.equal(value.projectId,projectId);
      assert.equal(value.grantId,domain);
      assert.equal(canonicalRecoveryJson(value.target),canonicalRecoveryJson(target));
    },
    inspect:async value => {
      inspected.push(value);
      const result = await f.owners.inspectLegacyRecovery(value.target,{verify:true});
      return {digest:sha(canonicalRecoveryJson(result.evidence)),summary:result.summary};
    },
  };
  await readOnly(f,async () => {
    const before = f.trace.children;
    await assert.rejects(collectOriginalTargets(coordinator,{...collect,
      authorize:() => { throw new ApiError('SCOPE_DENIED'); },
    }),code('SCOPE_DENIED'));
    assert.equal(f.trace.children,before,'Denied full-set authority launched a child.');
    const first = await collectOriginalTargets(coordinator,collect);
    const second = await collectOriginalTargets(coordinator,collect);
    assert.equal(first.digest,second.digest);
    assert.equal(inspected.length,2);
    assert.equal(coordinator.snapshot().recoveryRequired,true,'Read observations silently acknowledged recovery.');
    assert.equal(coordinator.recovery().subjects.length,1);
    await coordinator.acknowledge(token);
    assert.equal(coordinator.snapshot().recoveryRequired,false);
    assert.equal(coordinator.recovery().subjects.length,0);
  });
});
