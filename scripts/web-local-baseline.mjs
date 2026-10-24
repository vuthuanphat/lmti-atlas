// Locked synthetic read-only baseline. Not an acceptance/performance claim.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { strictJson, trustedPath } from '../apps/web-api/dist/security.js';
import { inspectPackage } from '../apps/web-api/dist/doctor.js';

const repo=fileURLToPath(new URL('../',import.meta.url));
const pkg=resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/studio-web03-projection-20261014'));
const producer=resolve(process.env.LMTI_WEB_BENCH_PRODUCER ?? join(repo,'build/native-mcp-20261013/bin/Release/lmti-web-benchmark-fixture.exe'));
const python=process.env.LMTI_WEB_TEST_PYTHON;
assert.ok(python,'Set trusted test Python.');assert.equal(process.argv.length,2,'No arbitrary workload/command arguments accepted.');
await trustedPath(pkg,'directory');await trustedPath(producer,'file');await trustedPath(python,'file');
const doctorStart=performance.now();const doctor=await inspectPackage(pkg,python);const doctorMs=performance.now()-doctorStart;
const workloadBytes=await readFile(join(repo,'docs/benchmarks/web03-workload.v1.json'));
const workload=strictJson(workloadBytes);
assert.equal(workload.schema,'lmti.web03.workload.v1');assert.equal(workload.registeredProjects,500);assert.equal(workload.denseProjects,50);
assert.deepEqual(JSON.parse(JSON.stringify(workload.denseDocument)),{components:100,releases:100,assets:200,bindings:500,workItems:500});
assert.equal(workload.pageSize,50);assert.equal(workload.warmupsPerOperation,3);assert.equal(workload.samplesPerOperation,30);
assert.equal(workload.operationConcurrency,1);assert.equal(workload.acceptancePassed,false);assert.equal(workload.acceptanceThresholds,null);
const digest=b=>createHash('sha256').update(b).digest('hex');
const reuse=process.env.LMTI_WEB_BENCH_FIXTURE;
const root=reuse?resolve(reuse):await mkdtemp(join(repo,'build/web03-bench-'));
await trustedPath(root,'directory');assert.ok(root.startsWith(resolve(repo,'build')+sep)&&/^web03-bench-[A-Za-z0-9_-]+$/.test(basename(root)));
const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR};
// The hashed protocol is frozen on disk before fixture construction/measurement.
if(!reuse){
await writeFile(join(root,'workload.lock.json'),workloadBytes);
const fixtureRuntime=join(root,'producer-runtime');await mkdir(fixtureRuntime);
await cp(join(pkg,'bin'),join(fixtureRuntime,'bin'),{recursive:true});await cp(join(pkg,'plugins'),join(fixtureRuntime,'plugins'),{recursive:true});
const fixtureExe=join(fixtureRuntime,'bin/lmti-web-benchmark-fixture.exe');await cp(producer,fixtureExe);
const fixture=spawnSync(fixtureExe,[root],{shell:false,windowsHide:true,env,encoding:'utf8',timeout:120000,maxBuffer:16384});
assert.equal(fixture.status,0,'Typed native fixture must succeed; no raw private errors printed.');
} else assert.equal(digest(await readFile(join(root,'workload.lock.json'))),digest(workloadBytes),'Existing synthetic fixture must match the locked protocol.');
const info=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));assert.equal(info.projects,500);assert.equal(info.dense,50);
assert.equal(info.schema,'lmti.web03.fixture.v1');assert.ok(info.ids.every(id=>/^bench-[0-9]{3}$/.test(id)));
assert.equal(info.ids.length,500);assert.equal(new Set(info.ids).size,500);
const library=join(root,'project-library.sqlite'),profiles=join(root,'mcp-profiles.sqlite');
const tracked=[library,profiles,...info.ids.map(id=>join(root,id,'project.sqlite'))];
const before=new Map();for(const file of tracked)before.set(file,digest(await readFile(file)));
const cfg={adminBinary:join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:join(pkg,'bin/lmti-project.exe'),library,profiles,python,
  agentEntry:join(pkg,'share/lmti/scripts/lmti-agent-mcp.py'),configOwner:join(pkg,'share/lmti/scripts/mcp-config-owner.py'),
  allowedProjects:info.ids,port:0,openBrowser:false};
const report={schema:'lmti.web03.baseline.v1',workloadSha256:digest(workloadBytes),workloadLockedBeforeRun:true,
  manifestSha256:digest(await readFile(join(pkg,'manifest.json'))),fixtureProducerSha256:digest(await readFile(producer)),
  runtime:{platform:process.platform,architecture:process.arch,node:process.versions.node,python:doctor.python},
  fixture:{projects:info.projects,dense:info.dense,projectDatabaseBytes:info.projectDatabaseBytes},doctorMs,
  startup:{},operations:{},nodeMemory:[],errors:[],acceptancePassed:false};

// Measure the actual opt-in publisher launcher independently. It grants no nonce
// with -NoBrowser and exits on idle; never feed an anonymous URL into API calls.
const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');await trustedPath(powershell,'file');
const launchAt=performance.now();
const launcher=spawn(powershell,['-NoProfile','-NonInteractive','-File',join(repo,'apps/web-api/test/fixtures/benchmark-launch.ps1'),
  '-DataDirectory',root,'-PackageDirectory',pkg],{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore'],
  env:{...env,PATHEXT:'.COM;.EXE;.BAT;.CMD',PATH:[dirname(process.execPath),dirname(python),join(process.env.SystemRoot,'System32')].join(';')}});
const diagnostic=await new Promise((resolve,reject)=>{
  let bytes='';const timer=setTimeout(()=>{launcher.kill();reject(new Error('Diagnostic launcher ready timeout.'));},30000);
  launcher.stdout.on('data',b=>{bytes+=b;if(bytes.length>16384){clearTimeout(timer);reject(new Error('Diagnostic output overflow.'));return;}
    if(bytes.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(bytes.trim()));}catch{reject(new Error('Diagnostic ready response invalid.'));}}});
  launcher.once('error',()=>{clearTimeout(timer);reject(new Error('Diagnostic launcher unavailable.'));});
  launcher.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(new Error('Diagnostic launcher failed.'));}});
});
assert.equal(diagnostic.kind,'lmti-local-api');
report.startup.launcherNoBrowserReadyMs=performance.now()-launchAt;
// Public static fetch only. No secret capability and no provider network traffic.
const staticPage=await fetch(diagnostic.url);assert.equal(staticPage.status,200);assert.match(await staticPage.text(),/\/assets\/index-/);
report.startup.launcherReactStaticHttp=staticPage.status;
report.diagnosticProcessPid=diagnostic.pid;

const startedAt=performance.now();
const child=spawn(process.execPath,[join(repo,'apps/web-api/test/fixtures/api-process.mjs')],{
  shell:false,windowsHide:true,env,stdio:['pipe','pipe','ignore','ipc']});
let apiExited=false;const apiExit=new Promise(resolve=>child.once('exit',()=>{apiExited=true;resolve();}));
try {
  const started=await new Promise((resolve,reject)=>{
    let bytes='';const timeout=setTimeout(()=>reject(new Error('Benchmark API start timeout.')),10000);
    child.stdout.on('data',b=>{bytes+=b;if(bytes.length>16384){clearTimeout(timeout);reject(new Error('Benchmark start overflow.'));return;}
      if(bytes.includes('\n')){clearTimeout(timeout);try{resolve(JSON.parse(bytes.trim()));}catch{reject(new Error('Benchmark start invalid.'));}}
    });child.once('error',()=>{clearTimeout(timeout);reject(new Error('Benchmark API unavailable.'));});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Benchmark API exited.'));});child.stdin.end(JSON.stringify(cfg));
  });
  report.startup.apiSpawnToReadyMs=performance.now()-startedAt;
  assert.match(started.origin,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const headers={'X-LMTI-UI':'1',Origin:started.origin,'Content-Type':'application/json'};
  const bootAt=performance.now();
  const boot=await fetch(started.origin+'/api/v1/session/bootstrap',{method:'POST',headers,body:JSON.stringify({nonce:started.nonce})}).then(r=>r.json());
  assert.equal(boot.ok,true);headers.Authorization=`Bearer ${boot.data.token}`;
  report.startup.authenticatedBootstrapMs=performance.now()-bootAt;
  async function request(path,method='GET',body) {
    const response=await fetch(started.origin+'/api/v1/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const text=await response.text();const result=JSON.parse(text);
    if(response.status!==200||result.ok!==true){report.errors.push({http:response.status,code:result.error?.code??'UNKNOWN'});throw new Error('Benchmark owner request failed.');}
    return {data:result.data,bytes:Buffer.byteLength(text)};
  }
  async function memory(label) {
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.off('message',onMessage);reject(new Error('Memory sample timeout.'));},3000);
      const onMessage=m=>{if(m?.kind==='memory'){clearTimeout(timer);child.off('message',onMessage);resolve(m.usage);}};
      child.on('message',onMessage);child.send({kind:'memory'});
    });
    report.nodeMemory.push({label,rssBytes:response.rss,heapUsedBytes:response.heapUsed,externalBytes:response.external});
  }
  const firstAt=performance.now();const page=await request('projects?limit=50');report.startup.firstDensePageMs=performance.now()-firstAt;
  assert.equal(page.data.items.length,50);assert.ok(page.data.items.every(v=>Number(v.id.slice(6))<50));
  await memory('after_first_page');
  // Discovery completeness/isolation assertions are outside latency sample sets.
  let next=page.data.nextCursor;const ids=new Set(page.data.items.map(v=>v.id));let pages=1;
  while(next){const result=await request('projects?limit=50&cursor='+next);for(const item of result.data.items){assert.equal(ids.has(item.id),false);ids.add(item.id);}next=result.data.nextCursor;pages++;}
  assert.equal(ids.size,500);assert.equal(pages,10);report.fixture.pagesVerified=pages;
  const nativeArgs=['--library',library,'--profiles',profiles,'--python',python,'--entry',cfg.agentEntry,'--binary',cfg.projectBinary];
  function native(payload){
    const out=spawnSync(cfg.adminBinary,nativeArgs,{shell:false,windowsHide:true,env,input:JSON.stringify(payload),encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
    assert.equal(out.status,0);const value=JSON.parse(out.stdout);assert.equal(value.ok,true);return {bytes:Buffer.byteLength(out.stdout)};
  }
  const project='bench-000',base=`projects/${project}`;
  const operations={
    dense_first_page:()=>request('projects?limit=50'),dense_summary:()=>request(base),dense_profile:()=>request(base+'/mcp-profile'),
    codex_status:()=>request(base+'/clients/codex'),
    codex_export:()=>request(base+'/clients/codex/export','POST',{expectedProfileRevision:1}),
    cursor_export:()=>request(base+'/clients/cursor/export','POST',{expectedProfileRevision:1}),
    native_direct_read:()=>native({action:'read',projectId:project}),
    native_direct_generate:()=>native({action:'generate',projectId:project,client:'codex',expectedRevision:1})
  };
  assert.deepEqual(Object.keys(operations),workload.operations);
  for(const [name,run] of Object.entries(operations)){
    for(let i=0;i<3;i++)await run();
    const samples=[];let maxBytes=0;
    for(let i=0;i<30;i++){const start=performance.now();const result=await run();samples.push(performance.now()-start);maxBytes=Math.max(maxBytes,result.bytes);}
    const sorted=[...samples].sort((a,b)=>a-b),rank=p=>sorted[Math.ceil(p*sorted.length)-1];
    report.operations[name]={samplesMs:samples,p50Ms:rank(.5),p95Ms:rank(.95),maxMs:sorted.at(-1),maxResponseBytes:maxBytes};
    console.log(JSON.stringify({measured:name,p95Ms:rank(.95)}));
  }
  await memory('after_samples');
  report.integrity={nativeFilesChecked:tracked.length,unchanged:true};
  for(const file of tracked)assert.equal(digest(await readFile(file)),before.get(file),'Read benchmark changed a native document/index/profile.');
  assert.equal(digest(await readFile(join(root,'workload.lock.json'))),report.workloadSha256);
  await request('session','DELETE');
  await writeFile(join(root,'baseline.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({root,report:'baseline.json',startup:report.startup,nodeMemory:report.nodeMemory,acceptancePassed:false}));
} catch {await writeFile(join(root,'baseline-incomplete.json'),JSON.stringify({...report,completedOperations:Object.keys(report.operations),incomplete:true},null,2));console.error('Synthetic baseline incomplete; no private request/config dump.');process.exitCode=1;}
finally {
  if(!apiExited&&child.connected)child.send({kind:'close'});
  if(!apiExited)await Promise.race([apiExit,new Promise(resolve=>setTimeout(resolve,3000))]);
  if(!apiExited)child.kill();
}
