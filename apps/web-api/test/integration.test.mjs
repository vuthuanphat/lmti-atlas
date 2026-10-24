import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApi } from '../dist/server.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const pkg = resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? resolve(repo,'build/studio-web01-20261013'));
const producer = resolve(process.env.LMTI_WEB_TEST_PRODUCER ?? resolve(repo,'build/native-web01-20261013/bin/Release/lmti-mcp-profile-tests.exe'));
const python = process.env.LMTI_WEB_TEST_PYTHON;
async function fixture(t, allowedProjects = ['factory-monitor','edge-gateway'], options = {}) {
  assert.ok(python,'Set LMTI_WEB_TEST_PYTHON to the trusted Python executable.');
  const root = await mkdtemp(join(repo,'build/web01-test-'));
  if (!options.retainRoot) t.after(() => { assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep)); return rm(root,{recursive:true,force:true}); });
  const cfg = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN ?? join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY ?? join(pkg,'bin/lmti-project.exe'),
    library:join(root,'project-library.sqlite'),profiles:join(root,'mcp-profiles.sqlite'),python,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects,port:0,openBrowser:false
  };
  assert.ok(cfg.configOwner&&process.env.LMTI_WEB_TEST_BROKER_GUARD,'Current config owner and v2 guard fixtures are required.');
  const generated = spawnSync(producer,[root],{encoding:'utf8',windowsHide:true,env:{...process.env,LMTI_PYTHON_BINARY:python,LMTI_AGENT_ENTRY:cfg.agentEntry,LMTI_PROJECT_BINARY:cfg.projectBinary}});
  assert.equal(generated.status,0,'Native fixture producer must succeed.');
  if (options.slowWrites || options.interruptWrite || options.pauseAfterReplace || options.projectOperations) {
    await copyFile(process.env.LMTI_WEB_TEST_BROKER_GUARD,join(root,'web-broker-guard.py'));
    const originalOwner = cfg.configOwner;
    cfg.configOwner = join(root,'mcp-config-owner.py');
    // Test-only deterministic process pause. It runs the unchanged real DPAPI
    // owner after release; no API response rewriting or production delay switch.
    await writeFile(cfg.configOwner,`import io,json,os,pathlib,runpy,sys,time
payload=sys.stdin.read()
if ${options.slowWrites ? 'True' : 'False'} and json.loads(payload).get('action')=='apply':
    directory=pathlib.Path(__file__).parent
    (directory/'write-started').write_text('started')
    deadline=time.monotonic()+30
    while not (directory/'write-release').exists():
        if time.monotonic()>deadline: sys.exit(1)
        time.sleep(0.05)
if ${options.interruptWrite || options.pauseAfterReplace ? 'True' : 'False'} and json.loads(payload).get('action')=='apply':
    destination=pathlib.Path(json.loads(payload)['root'])/'.cursor'/'mcp.json'
    original_replace=os.replace
    def interrupted_replace(source,target):
        original_replace(source,target)
        if pathlib.Path(target)==destination:
            (pathlib.Path(__file__).parent/'write-interrupted').write_text('config_replaced')
            if ${options.interruptWrite ? 'True' : 'False'}: os._exit(86)
            directory=pathlib.Path(__file__).parent
            deadline=time.monotonic()+30
            while not (directory/'write-release').exists():
                if time.monotonic()>deadline: os._exit(87)
                time.sleep(0.05)
    os.replace=interrupted_replace
sys.stdin=io.TextIOWrapper(io.BytesIO(payload.encode('utf-8')),encoding='utf-8')
runpy.run_path(${JSON.stringify(originalOwner)},run_name='__main__')
`);
  }
  if (options.projectOperations) {
    assert.ok(process.env.LMTI_WEB_TEST_BROKER_GUARD,'Set LMTI_WEB_TEST_BROKER_GUARD to the trusted fixed broker helper.');
    const copyParent=join(root,'operation-copies'),backupParent=join(root,'operation-backups');
    await mkdir(copyParent);await mkdir(backupParent);
    await copyFile(process.env.LMTI_WEB_TEST_BROKER_GUARD,join(root,'web-broker-guard.py'));
    cfg.projectOperations={copyParent,backupParent,projectIds:['factory-monitor'],allowLibraryUpgrade:false};
  }
  if(options.prepareOnly)return {root,cfg};
  let now = Date.now(); const api = await createLocalApi(cfg,() => now); t.after(() => api.close());
  const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
  async function request(path, {method='GET',body,token,headers={},raw} = {}) {
    const h = {'X-LMTI-UI':'1',Origin:api.origin,...headers};
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    return new Promise((resolve,reject) => {
      const request = httpRequest(api.origin+path,{method,headers:h},(response) => {
        const chunks = []; response.on('data',(chunk) => chunks.push(chunk));
        response.on('end',() => { try { resolve({http:response.statusCode,...JSON.parse(Buffer.concat(chunks).toString('utf8'))}); } catch (e) { reject(e); } });
      }); request.on('error',reject); request.end(payload);
    });
  }
  const boot = await request('/api/v1/session/bootstrap',{method:'POST',body:{nonce}});
  assert.equal(boot.http,200); const token = boot.data.token;
  const auth = (path,options={}) => request(path,{token,...options});
  return {root,cfg,api,nonce,token,request,auth,advance:(ms) => { now += ms; }};
}
// A definitive domain ACK precedes durable marker cleanup. Wait through the
// read-only status route before testing the next write; never replay an unknown.
async function waitForWriteIdle(f) {
  for (let attempt=0;attempt<200;attempt++) {
    const status=await f.auth('/api/v1/write-status');
    assert.equal(status.http,200);
    assert.equal(status.data.admitted,true);
    assert.equal(status.data.recoveryRequired,false);
    if(status.data.activeWrites===0)return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('The known write must finish durable marker cleanup.');
}
const profileRoute = '/api/v1/projects/factory-monitor/mcp-profile';
const client = (name,action='') => `/api/v1/projects/factory-monitor/clients/${name}${action ? '/'+action : ''}`;

test('built presentation uses the protected origin without exposing publisher files or source maps',async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.api.origin+'/'); assert.equal(response.status,200);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
  assert.equal(csp.includes('unsafe-inline'),false); assert.equal(csp.includes('unsafe-eval'),false);
  const html = await response.text(); const script = /src="(\/assets\/[A-Za-z0-9_-]+\.js)"/.exec(html);
  assert.ok(script); const bundle = await fetch(f.api.origin+script[1]); assert.equal(bundle.status,200);
  assert.equal(bundle.headers.get('x-content-type-options'),'nosniff');
  const source = await bundle.text(); assert.equal(source.includes('sourceMappingURL='),false);
  for (const path of ['/package.json','/.vite/manifest.json','/src/main.tsx',script[1]+'.map','/apps/web-api/src/server.ts']) {
    const refused = await fetch(f.api.origin+path); assert.notEqual(refused.status,200);
  }
  const unauthenticated = await fetch(f.api.origin+'/api/v1/projects'); assert.equal(unauthenticated.status,401);
});

test('interrupted real owner leaves protected recovery, refuses apply previews and restores original bytes',async(t)=>{
  const f=await fixture(t,['factory-monitor'],{interruptWrite:true});
  const dest=join(f.root,'.cursor/mcp.json');await mkdir(resolve(dest,'..'),{recursive:true});
  const original='{"private_setting":"synthetic-only","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}';
  await writeFile(dest,original);
  const before=await readFile(join(f.root,'synthetic-project.sqlite'));
  const preview=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(preview.http,200);
  const commit=await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:preview.data.id}});
  // A started writer can already have replaced the file. Its lost reply is
  // recovery-required, never a retryable generic availability failure.
  assert.equal(commit.http,200);assert.equal(commit.data.outcome,'unknown');
  const job = await f.auth('/api/v1/operations/'+commit.data.operationId);
  assert.equal(job.data.state,'unknown');assert.equal(job.data.errorCode,'RECOVERY_REQUIRED');
  assert.equal(JSON.stringify(commit).includes('synthetic-only'),false);
  assert.equal(await readFile(join(f.root,'write-interrupted'),'utf8'),'config_replaced');
  assert.notEqual(await readFile(dest,'utf8'),original);
  const status=await f.auth(client('cursor'));assert.equal(status.data.configuration,'recovery_required');assert.equal(status.data.canRestore,true);
  const refused=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(refused.http,409);assert.equal(refused.error.code,'RECOVERY_REQUIRED');
  // Even protected restore needs a deliberate fresh review after the
  // broker observed an unknown writer; inspection alone cannot clear it.
  const fenced=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'restore'}});
  assert.equal(fenced.error.code,'RECOVERY_REQUIRED');
  const recovery=await f.auth('/api/v1/recovery-previews',{method:'POST',body:{}});
  assert.equal(recovery.http,200);assert.equal(recovery.data.priorOutcome,'unknown');
  assert.equal(recovery.data.items[0].clients[0].state,'recovery_required');
  const ack=await f.auth('/api/v1/recoveries',{method:'POST',body:{previewId:recovery.data.id}});
  assert.equal(ack.http,200);assert.equal(ack.data.freshReviewRequired,true);
  assert.equal((await f.auth('/api/v1/operations/'+commit.data.operationId)).data.state,'unknown');
  const restore=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'restore'}});
  assert.equal(restore.http,200);assert.equal(restore.data.protectedRecovery,true);assert.equal(restore.data.generatedConfig,null);
  assert.equal(JSON.stringify(restore).includes('synthetic-only'),false);
  const done=await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:restore.data.id}});
  assert.equal(done.data.outcome,'restored');assert.equal(await readFile(dest,'utf8'),original);
  assert.equal((await f.auth(client('cursor'))).data.configuration,'not_applied');
  assert.equal((await f.auth(profileRoute)).data.revision,1);
  assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),before);
});

test('actual API process loss does not replay a received write; fresh authority inspects and restores real owner state', {timeout:45000},async(t)=>{
  // Prepare files without a parent-process broker claim. Each real child then
  // owns the same immutable launch domain; no scope mutation bypasses takeover.
  const f=await fixture(t,['factory-monitor'],{pauseAfterReplace:true,retainRoot:true,projectOperations:true,prepareOnly:true});
  const dest=join(f.root,'.cursor/mcp.json');await mkdir(resolve(dest,'..'),{recursive:true});
  const original='{"private_setting":"synthetic-only","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}';
  await writeFile(dest,original);const before=await readFile(join(f.root,'synthetic-project.sqlite'));
  const children=[];
  t.after(async()=>{await writeFile(join(f.root,'write-release'),'release');for(const child of children)if(child.exitCode===null)child.kill();});
  async function launch() {
    const child=spawn(process.execPath,[join(repo,'apps/web-api/test/fixtures/api-process.mjs')],{
      shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}
    });children.push(child);
    const started=await new Promise((resolve,reject)=>{
      let bytes='';const timeout=setTimeout(()=>reject(new Error('Synthetic API start timeout.')),10000);
      child.stdout.on('data',b=>{bytes+=b;if(bytes.length>16384){clearTimeout(timeout);reject(new Error('Synthetic API start overflow.'));return;}
        if(bytes.includes('\n')){clearTimeout(timeout);try{resolve(JSON.parse(bytes.trim()));}catch{reject(new Error('Synthetic API start invalid.'));}}
      });child.once('error',()=>{clearTimeout(timeout);reject(new Error('Synthetic API unavailable.'));});
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Synthetic API exited.'));});
      child.stdin.end(JSON.stringify(f.cfg));
    });
    assert.match(started.origin,/^http:\/\/127\.0\.0\.1:[0-9]+$/);assert.equal(typeof started.nonce,'string');
    const headers={'X-LMTI-UI':'1',Origin:started.origin,'Content-Type':'application/json'};
    async function send(path,method='GET',body){
      const response=await fetch(started.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      return {http:response.status,...await response.json()};
    }
    const boot=await send('/api/v1/session/bootstrap','POST',{nonce:started.nonce});assert.equal(boot.http,200);
    headers.Authorization=`Bearer ${boot.data.token}`;return {child,send,origin:started.origin,privateToken:boot.data.token};
  }
  const first=await launch();
  const preview=await first.send(client('cursor','previews'),'POST',{expectedProfileRevision:1,operation:'apply'});assert.equal(preview.http,200);
  const accepted=first.send(client('cursor','commit'),'POST',{previewId:preview.data.id}).then(result=>result,()=>({transport:'lost'}));
  let replaced=false;
  for(let i=0;i<100;i++){try{replaced=(await readFile(join(f.root,'write-interrupted'),'utf8'))==='config_replaced';}catch{}
    if(replaced)break;await new Promise(r=>setTimeout(r,50));}
  assert.ok(replaced,'Real owner must have replaced config before API loss.');
  const exited=new Promise(resolve=>first.child.once('exit',resolve));
  assert.equal(first.child.kill(),true);await exited;assert.equal((await accepted).transport,'lost');
  await writeFile(join(f.root,'write-release'),'release');
  const fresh=await launch();let state;
  const replay=await fetch(fresh.origin+profileRoute,{headers:{'X-LMTI-UI':'1',Origin:fresh.origin,Authorization:`Bearer ${first.privateToken}`}});
  assert.equal(replay.status,401);
  for(let i=0;i<100;i++){
    const status=await fresh.send(client('cursor'));
    if(status.http===200 && ['applied','recovery_required'].includes(status.data.configuration)){state=status.data;break;}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(state,'Fresh authenticated API must inspect completed or interrupted real owner state.');
  // Forced host termination may also end a descendant owner on Windows. The
  // contract permits either completed apply or an explicit protected recovery;
  // neither permits replaying the unknown write. Do not escape host process limits.
  assert.equal(state.appliedRevision,state.configuration==='applied'?1:null);assert.equal(state.clientUse,'not_verified');
  assert.equal(state.canRestore,true);
  const oldPreview=await fresh.send(client('cursor','commit'),'POST',{previewId:preview.data.id});assert.equal(oldPreview.http,410);
  if(state.configuration==='recovery_required') {
    const retry=await fresh.send(client('cursor','previews'),'POST',{expectedProfileRevision:1,operation:'apply'});
    assert.equal(retry.error.code,'RECOVERY_REQUIRED');
  }
  const config=JSON.parse(await readFile(dest,'utf8'));assert.equal(config.private_setting,'synthetic-only');assert.ok(config.mcpServers.other && config.mcpServers.lmti_m1);
  assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),before);
  // Startup quiescence and native reconciliation are separate. Each explicit
  // test claim checks the live process state; no production automatic retry.
  let admitted=false;
  for(let i=0;i<100;i++){
    const claim=await fresh.send('/api/v1/write-claim','POST',{});
    if(claim.data?.outcome==='claimed'){admitted=true;break;}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(admitted,'The old broker and its writer must be quiescent before admission.');
  const fence=await fresh.send('/api/v1/write-status');assert.equal(fence.data.recoveryRequired,true);
  const operationRoot='/api/v1/projects/factory-monitor/project-operations';
  const reconciliation=await fresh.send(operationRoot+'/recovery-previews','POST',{activationHandle:null});
  assert.equal(reconciliation.http,200);assert.equal(reconciliation.data.priorOutcome,'unknown');
  const acknowledged=await fresh.send(operationRoot+'/recoveries','POST',{previewId:reconciliation.data.id});
  assert.equal(acknowledged.http,200);assert.equal(acknowledged.data.freshReviewRequired,true);
  const restore=await fresh.send(client('cursor','previews'),'POST',{expectedProfileRevision:1,operation:'restore'});assert.equal(restore.http,200);
  const result=await fresh.send(client('cursor','commit'),'POST',{previewId:restore.data.id});assert.equal(result.data.outcome,'restored');
  assert.equal(await readFile(dest,'utf8'),original);
  await writeFile(join(f.root,'process-loss-evidence.json'),JSON.stringify({schema:'lmti.web03.process-loss.v1',
    receivedWriteBeforeApiLoss:true,transportLost:true,ownerStateInspectedWithoutReplay:true,stateAfterApiLoss:state.configuration,
    oldPreviewRejected:true,oldSessionRejected:true,freshSessionInspected:true,participatingBrokerQuiescence:true,explicitReconciliation:true,
    originalRestored:true,projectBytesUnchanged:true},null,2));
});

test('authenticated loopback rejects replay/origin/paths/duplicate input; scopes and paginates projects',async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/v1/projects')).http,401);
  assert.equal((await f.request('/api/v1/session/bootstrap',{method:'POST',body:{nonce:f.nonce}})).http,401);
  assert.equal((await f.auth('/api/v1/projects',{headers:{Origin:'https://evil.example'}})).http,403);
  assert.equal((await f.auth('/api/v1/projects',{headers:{Host:'evil.example'}})).http,403);
  assert.equal((await f.auth('/api/v1/projects',{headers:{'Sec-Fetch-Site':'cross-site'}})).http,403);
  assert.equal((await f.auth('/api/v1/projects',{method:'OPTIONS'})).http,400);
  const list = await f.auth('/api/v1/projects?limit=1'); assert.equal(list.http,200); assert.equal(list.data.items.length,1);
  const summary = await f.auth('/api/v1/projects/factory-monitor'); assert.equal(summary.http,200); assert.equal(summary.data.id,'factory-monitor');
  assert.equal((await f.auth('/api/v1/projects/hidden')).http,403);
  assert.deepEqual(Object.keys(summary.data).sort(),['id','name','projectRevision','profileRevision','linkedRoot','capabilities'].sort());
  assert.ok(list.data.nextCursor); assert.equal(JSON.stringify(list.data).includes(f.root.replaceAll('\\','/')),false);
  for (const item of list.data.items) assert.deepEqual(Object.keys(item).sort(),['id','name','projectRevision','profileRevision','linkedRoot','capabilities'].sort());
  const page2 = await f.auth(`/api/v1/projects?limit=1&cursor=${list.data.nextCursor}`); assert.equal(page2.http,200); assert.notEqual(page2.data.items[0].id,list.data.items[0].id);
  assert.equal((await f.auth(`/api/v1/projects?limit=1&cursor=${list.data.nextCursor}`)).http,410);
  assert.equal((await f.auth('/api/v1/projects?limit=1&limit=2')).http,400);
  assert.equal((await f.auth(profileRoute,{method:'PUT',raw:'x'.repeat(128*1024+1)})).http,413);
  assert.equal((await f.auth('/api/v1/projects/hidden/mcp-profile')).http,403);
  assert.equal((await f.auth('/api/v1/shell',{method:'POST',body:{command:'anything'}})).http,403);
  assert.equal((await f.auth(profileRoute,{method:'PUT',raw:'{"expectedRevision":1,"expectedRevision":2,"servers":[]}'})).http,400);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:[],root:'unexpected'}})).http,400);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:[{id:'arbitrary',label:'Arbitrary',transport:'command',enabled:true,command:'powershell'}]}})).http,400);
  const another = new URL(f.api.issueLaunch()).hash.slice('#bootstrap='.length);
  const boot2 = await f.request('/api/v1/session/bootstrap',{method:'POST',body:{nonce:another}});
  const preview = await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal((await f.request(client('cursor','commit'),{method:'POST',token:boot2.data.token,body:{previewId:preview.data.id}})).http,410);
  assert.equal((await f.auth('/api/v1/session',{method:'DELETE'})).http,200);
  assert.equal((await f.auth(profileRoute)).http,401);
});

test('launch nonce, previews and idle sessions expire without allowing writes',async (t) => {
  const f = await fixture(t);
  const oldLaunch = new URL(f.api.issueLaunch()).hash.slice('#bootstrap='.length); f.advance(30001);
  assert.equal((await f.request('/api/v1/session/bootstrap',{method:'POST',body:{nonce:oldLaunch}})).http,401);
  const p = await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}}); assert.equal(p.http,200);
  f.advance(120001);
  assert.equal((await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:p.data.id}})).http,410);
  f.advance(20*60*1000+1);
  assert.equal((await f.auth(profileRoute)).http,401);
  assert.equal(f.api.isIdle(),true);
});

test('real C++ profile/native generation and Python DPAPI roundtrip for both clients preserve unmanaged settings',async (t) => {
  const f = await fixture(t); const projectBytes = await readFile(join(f.root,'synthetic-project.sqlite'));
  const profile = await f.auth(profileRoute); assert.equal(profile.http,200); assert.equal(profile.data.revision,1);
  const exported = await f.auth(client('codex','export'),{method:'POST',body:{expectedProfileRevision:1}});
  assert.equal(exported.http,200); assert.ok(exported.data.content.includes('[mcp_servers.'));
  assert.equal((await f.auth(client('codex','export'),{method:'POST',body:{expectedProfileRevision:0}})).http,409);
  assert.equal((await f.auth('/api/v1/projects/edge-gateway/mcp-profile')).data.revision,0);
  const updated = await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:[...profile.data.servers,{id:'project_docs',label:'Project docs',enabled:true,transport:'remote_https',auth:'client_oauth',endpoint:'https://example.com/mcp',privateEndpoint:false}]}});
  assert.equal(updated.http,200); assert.equal(updated.data.revision,2);
  await waitForWriteIdle(f);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:[]}})).error.code,'REVISION_CONFLICT');
  assert.equal((await f.auth('/api/v1/projects/factory-monitor/connections/project_docs/check',{method:'POST',body:{}})).http,501);
  const check = await f.auth('/api/v1/projects/factory-monitor/connections/lmti_m1/check',{method:'POST',body:{}});
  assert.equal(check.http,200); assert.equal(check.data.toolNames.length,4);
  for (const name of ['codex','cursor']) {
    const dest = join(f.root,name === 'codex' ? '.codex/config.toml' : '.cursor/mcp.json'); await mkdir(resolve(dest,'..'),{recursive:true});
    const original = name === 'codex' ? 'private_setting="synthetic-sensitive-value"\n[mcp_servers.other]\nurl="https://other.example.com/mcp"\n' : '{"private_setting":"synthetic-sensitive-value","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}';
    await writeFile(dest,original);
    const p = await f.auth(client(name,'previews'),{method:'POST',body:{expectedProfileRevision:2,operation:'apply'}});
    assert.equal(p.http,200); assert.equal(JSON.stringify(p).includes('synthetic-sensitive-value'),false);
    assert.deepEqual(p.data.changes.added,['lmti_m1','project_docs']);
    assert.equal(await readFile(dest,'utf8'),original);
    const result = await f.auth(client(name,'commit'),{method:'POST',body:{previewId:p.data.id}});
    assert.equal(result.http,200); assert.equal(result.data.outcome,'applied'); assert.equal(result.data.status.clientUse,'not_verified');
    assert.equal((await f.auth(client(name,'commit'),{method:'POST',body:{previewId:p.data.id}})).http,410);
    const configuration = await readFile(dest,'utf8'); assert.ok(configuration.includes('other')); assert.ok(configuration.includes('synthetic-sensitive-value'));
    const r = await f.auth(client(name,'previews'),{method:'POST',body:{expectedProfileRevision:2,operation:'restore'}});
    assert.equal(r.http,200); assert.equal(r.data.generatedConfig,null); assert.equal(JSON.stringify(r).includes('synthetic-sensitive-value'),false);
    assert.equal(await readFile(dest,'utf8'),configuration);
    assert.equal((await f.auth(client(name,'commit'),{method:'POST',body:{previewId:r.data.id}})).data.outcome,'restored');
    assert.equal(await readFile(dest,'utf8'),original);
  }
  assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),projectBytes);
  assert.equal((await f.auth('/api/v1/projects/edge-gateway/mcp-profile')).data.revision,0);
});

test('preview refuses external edits and native revision changes without modifying configurations',async (t) => {
  const f = await fixture(t,['factory-monitor']);
  assert.equal((await f.auth('/api/v1/projects')).data.items.length,1);
  assert.equal((await f.auth('/api/v1/projects/edge-gateway/mcp-profile')).http,403);
  const first = await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(first.http,200); const dest = join(f.root,'.cursor/mcp.json'); await mkdir(resolve(dest,'..'),{recursive:true}); await writeFile(dest,'{"external_edit":true}');
  assert.equal((await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:first.data.id}})).error.code,'CONFIG_CHANGED');
  assert.equal(await readFile(dest,'utf8'),'{"external_edit":true}');
  const second = await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  const profile = await f.auth(profileRoute);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:profile.data.servers.map((s) => ({...s,enabled:false}))}})).http,200);
  await waitForWriteIdle(f);
  assert.equal((await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:second.data.id}})).error.code,'REVISION_CONFLICT');
  assert.equal(await readFile(dest,'utf8'),'{"external_edit":true}');
});

test('a real delayed owner returns 202, retains the write lock and finishes after session revocation', {timeout:45000}, async (t) => {
  const f = await fixture(t,['factory-monitor','edge-gateway'],{slowWrites:true});
  const dest = join(f.root,'.cursor/mcp.json'); await mkdir(resolve(dest,'..'),{recursive:true});
  const original='{"private_setting":"synthetic-only","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}';
  await writeFile(dest,original);
  const projectBytes=await readFile(join(f.root,'synthetic-project.sqlite'));
  const p=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(p.http,200);
  const result=await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:p.data.id}});
  assert.equal(result.http,202); assert.equal(result.data.outcome,'pending');
  assert.equal(await readFile(join(f.root,'write-started'),'utf8'),'started');
  assert.equal(await readFile(dest,'utf8'),original);
  const operation='/api/v1/operations/'+result.data.operationId;
  assert.equal((await f.auth(operation)).data.state,'pending');
  const profile=await f.auth(profileRoute);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:profile.data.servers}})).error.code,'BUSY');
  assert.equal((await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:p.data.id}})).http,410);
  const nonce=new URL(f.api.issueLaunch()).hash.slice('#bootstrap='.length);
  const boot=await f.request('/api/v1/session/bootstrap',{method:'POST',body:{nonce}});
  assert.equal((await f.request(operation,{token:boot.data.token})).http,403);
  assert.equal((await f.auth('/api/v1/session',{method:'DELETE'})).http,200);
  assert.equal((await f.auth(operation)).http,401);
  // No active session/nonce remains, but an accepted write must keep the service alive.
  assert.equal((await f.request('/api/v1/session',{method:'DELETE',token:boot.data.token})).http,200);
  assert.equal(f.api.isIdle(),false);
  await writeFile(join(f.root,'write-release'),'release');
  // Verify terminal owner state through a newly authorized session, not the revoked job.
  const fresh=new URL(f.api.issueLaunch()).hash.slice('#bootstrap='.length);
  const newBoot=await f.request('/api/v1/session/bootstrap',{method:'POST',body:{nonce:fresh}});
  let state;
  for (let i=0;i<100;i++) {
    const status=await f.request(client('cursor'),{token:newBoot.data.token});
    if (status.http===200 && status.data.configuration==='applied') { state=status.data; break; }
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(state,'Real owner must complete after revocation');
  assert.equal(state.appliedRevision,1); assert.equal(state.clientUse,'not_verified');
  const final=JSON.parse(await readFile(dest,'utf8')); assert.equal(final.private_setting,'synthetic-only');
  assert.ok(final.mcpServers.other && final.mcpServers.lmti_m1);
  assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),projectBytes);
  assert.equal((await f.request('/api/v1/projects/edge-gateway/mcp-profile',{token:newBoot.data.token})).data.revision,0);
  // Restore through the same owner; confirm protected recovery roundtrip.
  const restore=await f.request(client('cursor','previews'),{token:newBoot.data.token,method:'POST',body:{expectedProfileRevision:1,operation:'restore'}});
  assert.equal(restore.http,200);
  const restored=await f.request(client('cursor','commit'),{token:newBoot.data.token,method:'POST',body:{previewId:restore.data.id}});
  assert.equal(restored.data.outcome,'restored'); assert.equal(await readFile(dest,'utf8'),original);
});

test('disconnecting an accepted commit does not kill its real owner or release the lock early', {timeout:30000}, async(t)=>{
  const f=await fixture(t,['factory-monitor'],{slowWrites:true});
  const p=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(p.http,200);
  const payload=JSON.stringify({previewId:p.data.id});
  const request=httpRequest(f.api.origin+client('cursor','commit'),{method:'POST',headers:{
    'X-LMTI-UI':'1',Origin:f.api.origin,Authorization:`Bearer ${f.token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)
  }});
  const disconnected=new Promise(resolve=>request.on('error',()=>resolve()));
  request.end(payload);
  let started=false;
  for(let i=0;i<100;i++) {
    try { started=(await readFile(join(f.root,'write-started'),'utf8'))==='started'; } catch {}
    if(started) break; await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(started,'Owner must have started before disconnect');
  request.destroy(); await disconnected;
  const profile=await f.auth(profileRoute);
  assert.equal((await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:profile.data.servers}})).error.code,'BUSY');
  assert.equal((await f.auth(client('cursor','commit'),{method:'POST',body:{previewId:p.data.id}})).http,410);
  await writeFile(join(f.root,'write-release'),'release');
  let completed=false;
  for(let i=0;i<100;i++) {
    const status=await f.auth(client('cursor'));
    if(status.http===200 && status.data.configuration==='applied') { completed=true; break; }
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(completed,'Accepted real write survives request disconnection');
  // Inspection can see the file before the job finishes its final status read.
  // Only a definitive BUSY refusal is retried in this test; no unknown write retry.
  let unlocked;
  for(let i=0;i<100;i++) {
    unlocked=await f.auth(profileRoute,{method:'PUT',body:{expectedRevision:1,servers:profile.data.servers}});
    if(unlocked.http===200) break;
    assert.equal(unlocked.error.code,'BUSY'); await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(unlocked.http,200);
  const final=JSON.parse(await readFile(join(f.root,'.cursor/mcp.json'),'utf8'));
  assert.ok(final.mcpServers.lmti_m1);
});

test('graceful close fences launches and drains a real started writer after HTTP detaches', {timeout:45000},async t=>{
  const f=await fixture(t,['factory-monitor'],{slowWrites:true});
  const preview=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(preview.http,200);
  const request=f.auth(client('cursor','commit'),{method:'POST',body:{previewId:preview.data.id}});
  let started=false;
  for(let i=0;i<100;i++){try{started=(await readFile(join(f.root,'write-started'),'utf8'))==='started';}catch{}
    if(started)break;await new Promise(r=>setTimeout(r,50));}
  assert.ok(started);
  let closed=false;const closing=f.api.close().then(()=>{closed=true;});
  assert.throws(()=>f.api.issueLaunch(),{code:'SESSION_EXPIRED'});
  await new Promise(r=>setTimeout(r,150));assert.equal(closed,false);assert.equal(f.api.isIdle(),false);
  await writeFile(join(f.root,'write-release'),'release');
  const result=await request;assert.equal(result.data.outcome,'applied');
  await closing;assert.equal(closed,true);await f.api.close();
});
test('two API instances cannot independently coordinate the same library scope',async t=>{
  const f=await fixture(t);
  await assert.rejects(createLocalApi(f.cfg),{code:'BUSY'});
  assert.equal((await f.auth(profileRoute)).http,200);
});

test('a real client writer holds the shared lease; BUSY leaves the native copy review reusable', {timeout:45000},async t=>{
  const f=await fixture(t,['factory-monitor'],{slowWrites:true,projectOperations:true});
  const operationRoot='/api/v1/projects/factory-monitor/project-operations';
  const destination=join(f.root,'.cursor/mcp.json');await mkdir(resolve(destination,'..'),{recursive:true});
  const original='{"private_setting":"synthetic-only","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}';
  await writeFile(destination,original);
  const beforeProject=await readFile(join(f.root,'synthetic-project.sqlite'));
  const beforeLibrary=await readFile(f.cfg.library);
  const status=await f.auth(operationRoot);assert.equal(status.http,200);
  const mode=status.data.projectSchema===1?'migrate_v1':'clone_v2';
  const copy=await f.auth(operationRoot+'/copy-previews',{method:'POST',body:{mode}});
  assert.equal(copy.http,200);
  const clientPreview=await f.auth(client('cursor','previews'),{method:'POST',body:{expectedProfileRevision:1,operation:'apply'}});
  assert.equal(clientPreview.http,200);
  let applying;
  try {
    applying=f.auth(client('cursor','commit'),{method:'POST',body:{previewId:clientPreview.data.id}});
    void applying.catch(()=>{}); // Observed below; avoid an unhandled rejection during the bounded marker wait.
    let started=false;
    for(let i=0;i<100;i++) {
      try {started=(await readFile(join(f.root,'write-started'),'utf8'))==='started';}catch {}
      if(started)break;await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(started,'The actual Python owner must reach its fixture hold before the competing copy request.');
    const held=await f.auth('/api/v1/write-status');
    assert.equal(held.data.projectOperations,true);assert.equal(held.data.activeWrites,1);
    assert.equal(await readFile(destination,'utf8'),original);
    const refused=await f.auth(operationRoot+'/commits',{method:'POST',body:{previewId:copy.data.id}});
    assert.equal(refused.http,429);assert.equal(refused.error.code,'BUSY');
    assert.deepEqual(await readdir(f.cfg.projectOperations.copyParent),[],'No native copy reservation is created while the legacy writer holds a shared lease.');
    assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),beforeProject);
    await writeFile(join(f.root,'write-release'),'release');
    let applied=await applying;
    if(applied.http===202) {
      for(let i=0;i<100;i++) {
        const job=await f.auth('/api/v1/operations/'+applied.data.operationId);
        if(job.data.state!=='pending') {assert.equal(job.data.state,'succeeded');applied={http:200,data:job.data.result};break;}
        await new Promise(r=>setTimeout(r,50));
      }
    }
    assert.equal(applied.http,200);assert.equal(applied.data.outcome,'applied');
    await waitForWriteIdle(f);
    assert.equal((await f.auth('/api/v1/write-status')).data.activeWrites,0);
    const configuration=JSON.parse(await readFile(destination,'utf8'));
    assert.equal(configuration.private_setting,'synthetic-only');assert.ok(configuration.mcpServers.other&&configuration.mcpServers.lmti_m1);
    // This repeats only the definitive BUSY refusal. The preview was never
    // consumed and no started/unknown native write is retried.
    let copied=await f.auth(operationRoot+'/commits',{method:'POST',body:{previewId:copy.data.id}});
    if(copied.http===202) {
      for(let i=0;i<100;i++) {
        const job=await f.auth('/api/v1/operations/'+copied.data.operationId);
        if(job.data.state!=='pending') {assert.equal(job.data.state,'succeeded');copied={http:200,data:job.data.result};break;}
        await new Promise(r=>setTimeout(r,50));
      }
    }
    assert.equal(copied.http,200);assert.equal(copied.data.outcome,'confirmed');
    assert.equal(copied.data.summary.kind,'copy');assert.equal(copied.data.summary.state,'prepared');
    assert.equal(copied.data.summary.sourceRevision,status.data.projectRevision);
    assert.equal(copied.data.summary.targetRevision,status.data.projectRevision+1);
    assert.doesNotMatch(JSON.stringify(copied),/canonicalPath|storeUuid|contentDigest|receiptDigest|copyParent|backupPath/);
    const recovery=await f.auth(operationRoot+'/recovery/'+copied.data.recoveryHandle);
    assert.equal(recovery.http,200);assert.equal(recovery.data.state,'prepared');assert.equal(recovery.data.canPrepare,true);
    assert.equal((await readdir(f.cfg.projectOperations.copyParent)).length,1);
    assert.deepEqual(await readFile(join(f.root,'synthetic-project.sqlite')),beforeProject);
    assert.deepEqual(await readFile(f.cfg.library),beforeLibrary);
    const consumed=await f.auth(operationRoot+'/commits',{method:'POST',body:{previewId:copy.data.id}});
    assert.equal(consumed.http,410);
  } finally {
    // Failure cleanup also releases the synthetic hold before the API drains.
    await writeFile(join(f.root,'write-release'),'release');
    if(applying)await applying.catch(()=>{});
  }
});
