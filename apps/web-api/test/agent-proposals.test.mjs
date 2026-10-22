import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApi } from '../dist/server.js';
import { Owners } from '../dist/owners.js';
import { ProcessPool } from '../dist/process.js';
import { ApiError } from '../dist/security.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const pkg = resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/studio-web01-20261013'));
const producer = resolve(process.env.LMTI_WEB_TEST_PRODUCER ?? join(repo,'build/native-web01-20261013/bin/Release/lmti-mcp-profile-tests.exe'));
const python = process.env.LMTI_WEB_TEST_PYTHON;
const agentOwner = process.env.LMTI_WEB_TEST_AGENT_OWNER ?? join(repo,'scripts/agent-read-owner.py');
const route = '/api/v1/projects/factory-monitor';
const proposalRoute = route+'/proposals';

async function fixture(t, options = {}) {
  assert.ok(python,'Set LMTI_WEB_TEST_PYTHON to the trusted Python executable.');
  const root = await mkdtemp(join(repo,'build/web-agent-test-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep)); await rm(root,{recursive:true,force:true}); });
  const cfg = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN ?? join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY ?? join(pkg,'bin/lmti-project.exe'),
    library:join(root,'project-library.sqlite'),profiles:join(root,'mcp-profiles.sqlite'),python,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects:['factory-monitor','edge-gateway'],port:0,openBrowser:false
  };
  const produced = spawnSync(producer,[root],{encoding:'utf8',windowsHide:true,env:{...process.env,LMTI_PYTHON_BINARY:python,LMTI_AGENT_ENTRY:cfg.agentEntry,LMTI_PROJECT_BINARY:cfg.projectBinary}});
  assert.equal(produced.status,0,'The real native fixture producer must succeed.');
  if (!options.legacy) cfg.agentRead = {entry:agentOwner,projects:[{projectId:'factory-monitor',site:'factory-demo',target:'external',integrationConfig:null}]};
  if (options.integration) {
    const integration = join(root,'integration.json');
    await writeFile(integration,JSON.stringify({schema:'lmti.agent.integration.v1',projectId:'factory-monitor',site:'factory-demo',target:'external',knowledge:null,observations:null}));
    cfg.agentRead.projects[0].integrationConfig = integration;
  }
  if (options.delayedRead) {
    cfg.agentRead.entry = join(root,'agent-read-owner.py');
    await writeFile(cfg.agentRead.entry,`import io,pathlib,runpy,sys,time
payload=sys.stdin.buffer.read()
directory=pathlib.Path(__file__).parent
(directory/'agent-started').write_text('started')
deadline=time.monotonic()+12
while not (directory/'agent-release').exists():
    if time.monotonic()>deadline: sys.exit(1)
    time.sleep(0.025)
sys.stdin=io.TextIOWrapper(io.BytesIO(payload),encoding='utf-8')
runpy.run_path(${JSON.stringify(agentOwner)},run_name='__main__')
`);
  }
  let now = Date.now();
  const api = await createLocalApi(cfg,() => now);
  t.after(() => api.close());
  async function send(path, {method='GET',body,token,raw} = {}) {
    const headers = {'X-LMTI-UI':'1',Origin:api.origin};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const result = await fetch(api.origin+path,{method,headers,body:raw ?? (body === undefined ? undefined : JSON.stringify(body))});
    return {http:result.status,...await result.json()};
  }
  async function session() {
    const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
    const result = await send('/api/v1/session/bootstrap',{method:'POST',body:{nonce}});
    assert.equal(result.http,200); return result.data.token;
  }
  const token = await session();
  const auth = (path, options = {}) => send(path,{token,...options});
  const database = join(root,'synthetic-project.sqlite');
  return {root,cfg,api,send,session,token,auth,database,advance(ms) { now += ms; }};
}
async function inspect(f) {
  const result = await f.auth(proposalRoute+'/inspect',{method:'POST',body:{assetId:'machine-a'}});
  assert.equal(result.http,200); return result.data;
}
function proposal(state, pollMs = 2500) {
  return {expectedProjectRevision:state.projectRevision,proposal:{schema:'lmti.topology.proposal.v1',baseRevision:state.topologyRevision,
    assetId:state.asset.id,site:state.asset.site,expected:state.asset.desired,desired:{enabled:false,pollMs}}};
}
async function preview(f, request) {
  const result = await f.auth(proposalRoute+'/previews',{method:'POST',body:request});
  assert.equal(result.http,200); return result.data;
}
async function waitForFile(path) {
  for (let i=0;i<150;i++) {
    try { if (await readFile(path,'utf8')) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve,25));
  }
  assert.fail('The controlled real owner did not reach the expected phase.');
}

test('launcher navigation can load the public shell while cross-site APIs and embedded loads remain denied',async (t) => {
  const f = await fixture(t);
  async function navigation(path = '/', overrides = {}, method = 'GET', body) {
    const headers = {'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document',
      'X-LMTI-UI':'1',Authorization:`Bearer ${f.token}`,...overrides};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Promise((resolve,reject) => {
      const request = httpRequest(f.api.origin+path,{method,headers},response => {
        const chunks = [];
        response.on('data',chunk => chunks.push(chunk));
        response.on('end',() => resolve({status:response.statusCode,type:response.headers['content-type'],
          body:Buffer.concat(chunks).toString('utf8')}));
      });
      request.on('error',reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const shell = await navigation();
  assert.equal(shell.status,200); assert.match(shell.type,/^text\/html/);
  assert.equal(shell.body.includes(f.token),false);
  for (const [path,headers,method] of [
    ['/',{'Sec-Fetch-Mode':'cors'},'GET'],
    ['/',{'Sec-Fetch-Dest':'iframe'},'GET'],
    ['/',{Origin:'https://attacker.invalid'},'GET'],
    ['/',{Host:'attacker.invalid'},'GET'],
    ['/',{},'HEAD'],
    ['/index.html',{},'GET'],
    [route,{},'GET'],
  ]) assert.equal((await navigation(path,headers,method)).status,403);
  const nonce = new URL(f.api.issueLaunch()).hash.slice('#bootstrap='.length);
  const rejected = await navigation('/api/v1/session/bootstrap',{Origin:f.api.origin},'POST',{nonce});
  assert.equal(rejected.status,403);
  assert.equal((await f.send('/api/v1/session/bootstrap',{method:'POST',body:{nonce}})).http,200);
});

test('legacy launch remains compatible; agent configuration is an exact trusted opt-in',async (t) => {
  const f = await fixture(t,{legacy:true});
  assert.equal((await f.auth(route)).data.capabilities.includes('agent.read'),false);
  assert.equal((await f.auth(route+'/agent/read',{method:'POST',body:{operation:'context',arguments:{}}})).error.code,'NOT_SUPPORTED');
  for (const agentRead of [null,{entry:agentOwner,projects:[],extra:true},
    {entry:agentOwner,projects:[{projectId:'ungranted-project',site:'factory-demo',target:'external',integrationConfig:null}]},
    {entry:agentOwner,projects:[{projectId:'factory-monitor',site:'factory-demo',target:'external',integrationConfig:null,root:f.root}]}]) {
    await assert.rejects(new Owners({...f.cfg,agentRead}).validateLaunch(),ApiError);
  }
});

test('real Agent owner pagination is stable within one session and rejects browser grant/path overrides',async (t) => {
  const f = await fixture(t), before = await readFile(f.database);
  assert.ok((await f.auth(route)).data.capabilities.includes('agent.read'));
  const request = (argumentsValue) => f.auth(route+'/agent/read',{method:'POST',body:{operation:'context',arguments:argumentsValue}});
  const first = await request({limit:1});
  assert.equal(first.http,200); assert.equal(first.data.schema,'lmti.agent.response.v1');
  assert.equal(first.data.scope.projectId,'factory-monitor'); assert.equal(first.data.scope.modelTarget,'external');
  assert.ok(first.data.completeness.nextCursor);
  const cursor = first.data.completeness.nextCursor;
  const next = await request({limit:1,cursor});
  assert.equal(next.http,200); assert.notEqual(next.data.status,'error');
  assert.notDeepEqual(next.data.data.entities,first.data.data.entities);
  const otherToken = await f.session();
  const other = await f.send(route+'/agent/read',{method:'POST',token:otherToken,body:{operation:'context',arguments:{limit:1,cursor}}});
  assert.equal(other.http,200); assert.equal(other.data.error.code,'STALE_CURSOR');
  for (const body of [
    {operation:'context',arguments:{},site:'other-site'},
    {operation:'context',arguments:{target:'local'}},
    {operation:'context',arguments:{database:f.database}},
    {operation:'context',arguments:{cursorKey:'0'.repeat(64)}},
    {operation:'entity',arguments:{kind:'asset',entityId:'machine-a',command:'not-allowed'}},
    {operation:'unknown',arguments:{}}, {operation:'context',arguments:{limit:true}}
  ]) assert.equal((await f.auth(route+'/agent/read',{method:'POST',body})).error.code,'INVALID_INPUT');
  assert.equal((await f.auth('/api/v1/projects/edge-gateway/agent/read',{method:'POST',body:{operation:'context',arguments:{}}})).error.code,'SCOPE_DENIED');
  const observations = await f.auth(route+'/agent/read',{method:'POST',body:{operation:'observations',arguments:{assetId:'machine-a'}}});
  assert.equal(observations.http,200); assert.equal(observations.data.status,'error');
  assert.equal(observations.data.error.code,'NOT_SUPPORTED');
  const encoded = JSON.stringify(first);
  assert.equal(encoded.includes(f.root),false); assert.equal(encoded.includes('cursorKey'),false);
  assert.deepEqual(await readFile(f.database),before);
});

test('review/reject do not write; explicit native commit changes only desired configuration and cannot replay',async (t) => {
  const f = await fixture(t), before = await readFile(f.database), state = await inspect(f);
  assert.equal(state.asset.desired.pollMs,1000);
  const request = proposal(state), rejected = await preview(f,request);
  assert.deepEqual(rejected.diff,{expected:{enabled:true,pollMs:1000},desired:{enabled:false,pollMs:2500}});
  assert.equal(rejected.expectedProjectRevision,1); assert.equal(rejected.deviceActions,false);
  assert.ok(Date.parse(rejected.expiresAt));
  assert.deepEqual(await readFile(f.database),before);
  const deniedToken = await f.session();
  assert.equal((await f.send(proposalRoute+'/commit',{method:'POST',token:deniedToken,body:{previewId:rejected.id}})).error.code,'PREVIEW_EXPIRED');
  assert.equal((await f.auth(proposalRoute+'/previews/'+rejected.id,{method:'DELETE'})).data.rejected,true);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:rejected.id}})).error.code,'PREVIEW_EXPIRED');
  assert.deepEqual(await readFile(f.database),before);
  const accepted = await preview(f,request);
  const result = await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:accepted.id}});
  assert.equal(result.http,200); assert.equal(result.data.outcome,'committed');
  assert.equal(result.data.projectRevision,2); assert.equal(result.data.topologyRevision,2); assert.equal(result.data.deviceActions,false);
  const job = await f.auth('/api/v1/operations/'+result.data.operationId);
  assert.equal(job.data.state,'succeeded'); assert.deepEqual(job.data.result,result.data);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:accepted.id}})).error.code,'PREVIEW_EXPIRED');
  const saved = await inspect(f); assert.deepEqual(saved.asset.desired,{enabled:false,pollMs:2500});
  assert.equal(saved.projectRevision,2); assert.equal(saved.asset.observed.status,'unknown');
  assert.equal((await f.auth(route+'/mcp-profile')).data.revision,1);
});

test('native conflict JSON remains typed; stale, expired, modified and revoked reviews cannot write',async (t) => {
  const f = await fixture(t,{integration:true}), state = await inspect(f), request = proposal(state), before = await readFile(f.database);
  const old = structuredClone(request); old.proposal.expected.pollMs = 2000;
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:old})).error.code,'CONFIG_CHANGED');
  const bad = structuredClone(request); bad.proposal.desired.command = 'not-permitted';
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:bad})).error.code,'INVALID_INPUT');
  const site = structuredClone(request); site.proposal.site = 'other-site';
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:site})).error.code,'SCOPE_DENIED');
  assert.deepEqual(await readFile(f.database),before);
  const expired = await preview(f,request); f.advance(120001);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:expired.id}})).error.code,'PREVIEW_EXPIRED');
  const stale = await preview(f,request);
  const native = spawnSync(f.cfg.projectBinary,['commit-proposal',f.database,'factory-monitor','factory-demo','external'],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true});
  assert.equal(native.status,0); const newer = await readFile(f.database);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:stale.id}})).error.code,'REVISION_CONFLICT');
  assert.deepEqual(await readFile(f.database),newer);
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:request})).error.code,'REVISION_CONFLICT');
  const current = await inspect(f), revoked = await preview(f,proposal(current,3000));
  const integration = f.cfg.agentRead.projects[0].integrationConfig, original = await readFile(integration);
  await writeFile(integration,Buffer.concat([original,Buffer.from('\n')]));
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:revoked.id}})).error.code,'CONFIG_CHANGED');
  await writeFile(integration,original);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:revoked.id}})).error.code,'PREVIEW_EXPIRED');
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:proposal(current,3000)})).error.code,'SCOPE_DENIED');
  assert.deepEqual(await readFile(f.database),newer,'Revocation and restoring source bytes cannot authorize another write.');
});

test('session revocation during a real owner read discards the payload before it reaches the browser',{timeout:25000},async (t) => {
  const f = await fixture(t,{delayedRead:true}), before = await readFile(f.database);
  const pending = f.auth(route+'/agent/read',{method:'POST',body:{operation:'context',arguments:{limit:1}}});
  await waitForFile(join(f.root,'agent-started'));
  assert.equal((await f.auth('/api/v1/session',{method:'DELETE'})).data.revoked,true);
  await writeFile(join(f.root,'agent-release'),'release');
  const result = await pending;
  assert.equal(result.http,401); assert.equal(result.error.code,'SESSION_EXPIRED');
  assert.equal(Object.hasOwn(result,'data'),false);
  assert.deepEqual(await readFile(f.database),before);
});

test('a real native write with a lost acknowledgement consumes its preview without retrying',async (t) => {
  const f = await fixture(t), state = await inspect(f), p = await preview(f,proposal(state));
  const original = ProcessPool.prototype.run; let writes = 0;
  ProcessPool.prototype.run = async function(binary,args,input,options) {
    const result = await original.call(this,binary,args,input,options);
    if (binary === f.cfg.projectBinary && args[0] === 'commit-proposal') { writes++; return {ok:true}; }
    return result;
  };
  t.after(() => { ProcessPool.prototype.run = original; });
  const result = await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:p.id}});
  assert.equal(result.http,200); assert.equal(result.data.outcome,'unknown');
  const job = await f.auth('/api/v1/operations/'+result.data.operationId);
  assert.equal(job.data.state,'unknown'); assert.equal(job.data.result.outcome,'unknown');
  assert.equal((await f.auth('/api/v1/write-status')).data.recoveryRequired,true);
  assert.equal((await f.auth(proposalRoute+'/commit',{method:'POST',body:{previewId:p.id}})).error.code,'PREVIEW_EXPIRED');
  assert.equal(writes,1);
  const saved = await inspect(f); assert.equal(saved.projectRevision,2); assert.equal(saved.asset.desired.pollMs,2500);
  assert.equal((await f.auth(proposalRoute+'/previews',{method:'POST',body:proposal(saved,3000)})).error.code,'RECOVERY_REQUIRED');
});

test('integration configuration is pinned across one-shot reads and remains revoked after a detected change',async (t) => {
  const f = await fixture(t,{integration:true}), file = f.cfg.agentRead.projects[0].integrationConfig;
  const original = await readFile(file), before = await readFile(f.database);
  const query = () => f.auth(route+'/agent/read',{method:'POST',body:{operation:'context',arguments:{limit:1}}});
  assert.equal((await query()).http,200);
  await writeFile(file,Buffer.concat([original,Buffer.from('\n')]));
  const changed = await query();
  assert.equal(changed.error.code,'CONFIG_CHANGED'); assert.equal(Object.hasOwn(changed,'data'),false);
  await writeFile(file,original);
  assert.equal((await query()).error.code,'SCOPE_DENIED','Restoring bytes must not revive a detected revoked authority.');
  assert.equal((await f.auth(proposalRoute+'/inspect',{method:'POST',body:{assetId:'machine-a'}})).error.code,'SCOPE_DENIED');
  assert.deepEqual(await readFile(f.database),before);
});

test('integration config changes during a real owner read discard output before browser disclosure',{timeout:25000},async (t) => {
  const f = await fixture(t,{integration:true,delayedRead:true});
  const pending = f.auth(route+'/agent/read',{method:'POST',body:{operation:'context',arguments:{limit:1}}});
  await waitForFile(join(f.root,'agent-started'));
  const file = f.cfg.agentRead.projects[0].integrationConfig;
  await writeFile(file,(await readFile(file,'utf8'))+'\n');
  await writeFile(join(f.root,'agent-release'),'release');
  const result = await pending;
  assert.equal(result.error.code,'CONFIG_CHANGED'); assert.equal(Object.hasOwn(result,'data'),false);
});

test('queued native commits recheck the library binding before spawning without a process-pool deadlock',{timeout:25000},async (t) => {
  const f = await fixture(t), state = await inspect(f), request = proposal(state), before = await readFile(f.database);
  const owners = new Owners(f.cfg); await owners.validateLaunch();
  const read = await owners.read('factory-monitor'), grant = owners.agentGrant('factory-monitor');
  const holder = join(f.root,'hold-slot.mjs'), release = join(f.root,'release-slots');
  await writeFile(holder,`import fs from 'node:fs';
fs.writeFileSync(process.argv[2]+'.started','started');
const timer=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(timer);process.stdout.write('{}');}},10);
setTimeout(()=>{clearInterval(timer);process.exit(1);},12000).unref();
`);
  const held = [0,1].map((index) => owners.pool.run(process.execPath,[holder,join(f.root,'slot-'+index),release],'',{write:true}));
  await Promise.all([0,1].map((index) => waitForFile(join(f.root,'slot-'+index+'.started'))));
  const pending = owners.proposal(read,grant,'commit-proposal',request).then(() => ({committed:true}),error => ({error}));
  await new Promise((resolve) => setTimeout(resolve,100));
  const rebound = join(f.root,'rebound-project.sqlite'); await copyFile(f.database,rebound);
  // Adversarial fixture setup only: production paths still resolve through the
  // native library owner, never browser-supplied file locations.
  const changed = spawnSync(python,['-I','-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE library SET path=? WHERE id=?",(sys.argv[2],"factory-monitor")); c.commit(); c.close()',f.cfg.library,rebound],{encoding:'utf8',windowsHide:true});
  assert.equal(changed.status,0);
  await writeFile(release,'release'); await Promise.all(held);
  const result = await pending; assert.equal(result.error?.code,'CONFIG_CHANGED');
  assert.deepEqual(await readFile(f.database),before); assert.deepEqual(await readFile(rebound),before);
});

test('native error allowance rejects all other exit failures and unexpected envelope fields',async () => {
  const pool = new ProcessPool();
  const args = (value,code=1) => ['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(value))});process.exit(${code})`];
  const safe = {ok:false,error:{code:'REVISION_CONFLICT'}};
  await assert.rejects(pool.run(process.execPath,args(safe),''),{code:'OWNER_UNAVAILABLE'});
  assert.deepEqual(JSON.parse(JSON.stringify(await pool.run(process.execPath,args(safe),'',{projectProposalErrors:true}))),safe);
  for (const value of [{...safe,path:'private-path'},{ok:false,error:{code:'unexpected',message:'private-data'}},{ok:true}])
    await assert.rejects(pool.run(process.execPath,args(value),'',{projectProposalErrors:true}),{code:'OWNER_UNAVAILABLE'});
  await assert.rejects(pool.run(process.execPath,args(safe,2),'',{projectProposalErrors:true}),{code:'OWNER_UNAVAILABLE'});
});

test('normal client exports and Check launch the opt-in integrated MCP with a reviewed configuration pin',async (t) => {
  const f = await fixture(t,{integration:true});
  const owners = new Owners(f.cfg); await owners.validateLaunch();
  const initial = await owners.read('factory-monitor');
  const local = initial.profile.servers.find(s => s.enabled && s.transport === 'lmti_local');
  assert.ok(local,'A real native local MCP definition is required.');
  for (const client of ['codex','cursor']) {
    const response = await f.auth(route+`/clients/${client}/export`,{method:'POST',body:{expectedProfileRevision:initial.profile.revision}});
    assert.equal(response.http,200);
    assert.match(response.data.content,/--integration-config/);
    assert.match(response.data.content,/--integration-sha256/);
    const generated = await owners.generate('factory-monitor',client,initial.profile.revision);
    const args = generated.servers[local.id].args;
    assert.equal(resolve(args[args.indexOf('--integration-config')+1]),resolve(f.cfg.agentRead.projects[0].integrationConfig));
    assert.match(args[args.indexOf('--integration-sha256')+1],/^[0-9a-f]{64}$/);
  }
  const check = await f.auth(route+`/connections/${local.id}/check`,{method:'POST',body:{}});
  assert.equal(check.http,200);
  assert.deepEqual(new Set(check.data.toolNames),new Set(['lmti_context','lmti_entity','lmti_related','lmti_observations','lmti_task_context']));
  const injected = await f.auth(route+'/clients/codex/export',{method:'POST',body:{expectedProfileRevision:initial.profile.revision,integration:{configPath:'C:/forbidden'}}});
  assert.equal(injected.http,400);
  const original = await readFile(f.cfg.agentRead.projects[0].integrationConfig);
  const clientDirectory = join(initial.binding.root,'.codex'); await mkdir(clientDirectory);
  const clientFile = join(clientDirectory,'config.toml');
  const existing = '[mcp_servers.keep]\nurl = "https://example.invalid/mcp"\n';
  await writeFile(clientFile,existing);
  const review = await f.auth(route+'/clients/codex/previews',{method:'POST',body:{expectedProfileRevision:initial.profile.revision,operation:'apply'}});
  assert.equal(review.http,200);
  await writeFile(f.cfg.agentRead.projects[0].integrationConfig,Buffer.concat([original,Buffer.from(' ')]));
  const commit = await f.auth(route+'/clients/codex/commit',{method:'POST',body:{previewId:review.data.id}});
  assert.notEqual(commit.http,200);
  assert.equal(await readFile(clientFile,'utf8'),existing,'Revoked config must not alter the client file.');
  await writeFile(f.cfg.agentRead.projects[0].integrationConfig,original);
  const revoked = await f.auth(route+'/clients/codex/export',{method:'POST',body:{expectedProfileRevision:initial.profile.revision}});
  assert.notEqual(revoked.http,200,'Restoring config bytes must not revive an API-detected revocation.');
});

test('local-only integration grants cannot be exported to external client configurations',async (t) => {
  const f = await fixture(t,{integration:true});
  const cfg = structuredClone(f.cfg); cfg.agentRead.projects[0].target = 'local';
  const owners = new Owners(cfg); await owners.validateLaunch();
  await assert.rejects(owners.generate('factory-monitor','codex',1),error => error instanceof ApiError && error.code === 'SCOPE_DENIED');
});
