// Coordinated real Widgets / packaged HTTP API trial on synthetic files only.
// No installed operator library, personal config, provider calls or model turn.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { trustedPath } from '../apps/web-api/dist/security.js';
import { inspectPackage } from '../apps/web-api/dist/doctor.js';

const repo=fileURLToPath(new URL('../',import.meta.url));
const pkg=resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/studio-web03-20261014'));
const probeBinary=resolve(process.env.LMTI_WEB_TEST_QT_PROBE ?? join(repo,'build/native-mcp-20261013/bin/Release/lmti-qt-web-probe.exe'));
const producerBinary=resolve(process.env.LMTI_WEB_TEST_PRODUCER ?? join(repo,'build/native-web01-20261013/bin/Release/lmti-mcp-profile-tests.exe'));
const python=process.env.LMTI_WEB_TEST_PYTHON;
assert.ok(python,'Set the trusted test Python executable.');
assert.ok(process.argv.length<=3 && process.argv.slice(2).every(v=>['--browser','--ipc-lock'].includes(v)),'Use only a supported synthetic test option.');
await trustedPath(pkg,'directory');
for(const file of [probeBinary,producerBinary,python]) await trustedPath(file,'file');
await inspectPackage(pkg,python);
const offscreen=resolve(process.env.LMTI_WEB_TEST_OFFSCREEN ?? join(repo,'.tools/qt/6.12.0/msvc2022_64/plugins/platforms/qoffscreen.dll'));
await trustedPath(offscreen,'file');
const root=await mkdtemp(join(repo,'build/web03-qt-'));
const runtime=join(root,'probe-runtime'); await mkdir(runtime);
await cp(join(pkg,'bin'),join(runtime,'bin'),{recursive:true});
await cp(join(pkg,'plugins'),join(runtime,'plugins'),{recursive:true});
await cp(probeBinary,join(runtime,'bin/lmti-qt-web-probe.exe'));
await cp(offscreen,join(runtime,'plugins/platforms/qoffscreen.dll'));
await writeFile(join(root,'web03-qt-fixture'),'lmti.web03.synthetic.v1');
const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR};
const cfg={adminBinary:join(runtime,'bin/lmti-mcp-admin.exe'),projectBinary:join(runtime,'bin/lmti-project.exe'),
  library:join(root,'project-library.sqlite'),profiles:join(root,'mcp-profiles.sqlite'),python,
  agentEntry:join(pkg,'share/lmti/scripts/lmti-agent-mcp.py'),configOwner:join(pkg,'share/lmti/scripts/mcp-config-owner.py'),
  allowedProjects:['factory-monitor','edge-gateway'],port:0,openBrowser:false};
const generated=spawnSync(producerBinary,[root],{
  encoding:'utf8',windowsHide:true,env:{...env,LMTI_PYTHON_BINARY:python,LMTI_AGENT_ENTRY:cfg.agentEntry,LMTI_PROJECT_BINARY:cfg.projectBinary}
});
assert.equal(generated.status,0,'Native synthetic fixture must succeed.');
const originals={codex:'private_setting="synthetic-only"\n[mcp_servers.other]\nurl="https://other.example.com/mcp"\n',
  cursor:'{"private_setting":"synthetic-only","mcpServers":{"other":{"url":"https://other.example.com/mcp"}}}'};
const dest=client=>join(root,client==='codex'?'.codex/config.toml':'.cursor/mcp.json');
for(const client of ['codex','cursor']) {await mkdir(resolve(dest(client),'..'),{recursive:true});await writeFile(dest(client),originals[client]);}
const before=await readFile(join(root,'synthetic-project.sqlite'));
const {createLocalApi}=await import(pathToFileURL(join(pkg,'apps/web-api/dist/server.js')));
const api=await createLocalApi(cfg);
const nonce=new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
const headers={'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
const bootstrap=await fetch(api.origin+'/api/v1/session/bootstrap',{method:'POST',headers,body:JSON.stringify({nonce})}).then(r=>r.json());
assert.ok(bootstrap.ok);headers.Authorization=`Bearer ${bootstrap.data.token}`;
async function request(path,method='GET',body) {
  const r=await fetch(api.origin+'/api/v1/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {http:r.status,...await r.json()};
}
const profilePath='projects/factory-monitor/mcp-profile';
const clientPath=(client,action='')=>`projects/factory-monitor/clients/${client}${action?'/'+action:''}`;
const qt=spawn(join(runtime,'bin/lmti-qt-web-probe.exe'),[root],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore'],env:{...env,
  QT_QPA_PLATFORM:'offscreen',QT_QPA_FONTDIR:join(process.env.SystemRoot,'Fonts'),
  LMTI_STUDIO_PYTHON_BINARY:python,LMTI_STUDIO_AGENT_ENTRY:cfg.agentEntry,LMTI_STUDIO_MCP_CONFIG_OWNER:cfg.configOwner}});
const listeners=new Map();let outputBytes=0,sequence=0,lastQtFailure=null,lastProtocolFailure=null,lastQtPhase=null,lastAction=null,publicationWaits=0;
const lines=createInterface({input:qt.stdout});
const wait=seq=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{listeners.delete(seq);reject(new Error('Synthetic Qt command timed out.'));},15000);
  listeners.set(seq,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
});
const ready=wait(0);
lines.on('line',line=>{
  outputBytes+=Buffer.byteLength(line);if(outputBytes>1024*1024){qt.kill();return;}
  try {const result=JSON.parse(line);
    if(result.kind==='phase' && Number.isInteger(result.sequence) && /^[a-z_]{1,32}$/.test(result.phase)){lastQtPhase={sequence:result.sequence,phase:result.phase};return;}
    if(result.ok===false && /^[a-z_]{1,32}$/.test(result.phase)) lastQtFailure={sequence:result.sequence,phase:result.phase};
    assert.equal(result.ok,true);const pending=listeners.get(result.sequence);
    if(!pending)lastProtocolFailure={kind:'unexpected_sequence',received:result.sequence,issued:sequence,pending:[...listeners.keys()]};
    assert.ok(pending);listeners.delete(result.sequence);pending.resolve(result.data);}
  catch {lastProtocolFailure??={kind:'invalid_response',lineBytes:Buffer.byteLength(line)};
    for(const pending of listeners.values())pending.reject(new Error('Invalid synthetic Qt response.'));listeners.clear();}
});
qt.on('error',()=>{for(const pending of listeners.values())pending.reject(new Error('Qt probe unavailable.'));listeners.clear();});
qt.on('exit',(code,signal)=>{
  void writeFile(join(root,'qt-exit.json'),JSON.stringify({code,signal,sequence},null,2));
  for(const pending of listeners.values())pending.reject(new Error('Qt probe exited.'));listeners.clear();
});
async function command(action) {
  assert.equal(qt.exitCode,null,'Qt probe already exited.');
  assert.equal(qt.signalCode,null,'Qt probe already stopped.');
  const result=wait(++sequence);result.catch(()=>{}); // Handle an early response error during asynchronous file publication.
  lastAction={sequence,action};
  await writeFile(join(root,'qt-command.tmp'),JSON.stringify({sequence,action}));
  await publishCommand();return result;
}
async function publishCommand() {
  // A sharing violation during Windows MoveFileEx has not delivered a command.
  // Retry only publication of the same bytes/sequence; the Qt receiver deduplicates
  // that sequence. This is not a retry of apply/restore or an unknown owner result.
  for(let attempt=0;;attempt++){
    try {await rename(join(root,'qt-command.tmp'),join(root,'qt-command.json'));return;}
    catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=49)throw error;
      publicationWaits++;
      await new Promise(resolve=>setTimeout(resolve,20));}
  }
}
const evidence={schema:'lmti.web03.qt-api-evidence.v1',checks:{},actualCursor:false,secondHumanOperator:false};
let bridge;
let stage='qt_ready';
async function finish() {try{await command('quit');}catch{qt.kill();}bridge?.close();await api.close();}
try {
  const initial=await ready;assert.equal(initial.revision,1);assert.equal(initial.projectId,'factory-monitor');
  stage='qt_profile_changes';
  const toggled=await command('toggle_local');assert.equal(toggled.revision,2);
  if(process.argv.includes('--ipc-lock')) {
    // Fixed Windows sharing-violation fault on this marked synthetic IPC file.
    // No owner DB/config/device access and no untrusted executable or shell.
    const code=`import ctypes,sys,time
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
k.CreateFileW.restype=ctypes.c_void_p
k.CloseHandle.argtypes=[ctypes.c_void_p]
deadline=time.monotonic()+1
while True:
    h=k.CreateFileW(sys.argv[1],0x80000000,0,None,3,0x80,None)
    if h!=ctypes.c_void_p(-1).value: break
    if time.monotonic()>deadline: sys.exit(2)
    time.sleep(0.01)
print('locked',flush=True)
time.sleep(0.5)
k.CloseHandle(h)
`;
    const lock=spawn(python,['-I','-S','-c',code,join(root,'qt-command.json')],{shell:false,windowsHide:true,env,stdio:['ignore','pipe','ignore']});
    const locked=new Promise((resolve,reject)=>{
      let confirmed=false;
      const timer=setTimeout(()=>{lock.kill();reject(new Error('Synthetic lock start timeout.'));},3000);
      lock.stdout.once('data',b=>{clearTimeout(timer);confirmed=b.toString().trim()==='locked';confirmed?resolve():reject(new Error('Synthetic lock unavailable.'));});
      lock.once('error',()=>{clearTimeout(timer);reject(new Error('Synthetic lock unavailable.'));});
      lock.once('exit',()=>{clearTimeout(timer);if(!confirmed)reject(new Error('Synthetic lock exited before acquiring.'));});
    });
    const released=new Promise(resolve=>lock.once('exit',status=>resolve(status)));
    await locked;
    const duringLock=command('reload_factory');duringLock.catch(()=>{});
    assert.equal(await released,0);
    assert.equal((await duringLock).revision,2);assert.equal(qt.exitCode,null,'Probe must survive temporary IPC sharing violation.');
    assert.ok(publicationWaits>0,'Exclusive target lock must exercise bounded publication wait.');
    evidence.checks.transientIpcReadUnavailableHandled=true;
    evidence.checks.sameSequencePublicationWaitVerified=true;
  }
  const read=await request(profilePath);assert.equal(read.data.revision,2);assert.equal(read.data.servers[0].enabled,false);
  const stale=await request(profilePath,'PUT',{expectedRevision:1,servers:read.data.servers});assert.equal(stale.error.code,'REVISION_CONFLICT');
  const added=await command('add_docs');assert.equal(added.revision,3);assert.equal(added.servers.length,2);
  evidence.checks.qtProfileChangesVisibleInApi=true;
  stage='generated_configs';
  for(const client of ['codex','cursor']) {
    const preview=await command('preview_'+client);assert.equal(preview.revision,3);assert.equal(preview.canApply,true);
    const exported=await request(clientPath(client,'export'),'POST',{expectedProfileRevision:3});
    assert.equal(exported.http,200);assert.equal(preview.content,exported.data.content);
    await command('close_preview');
  }
  evidence.checks.identicalOwnerGeneratedConfigsBothClients=true;
  stage='qt_apply_web_restore_codex';
  await command('preview_codex');const applied=await command('apply_preview');assert.equal(applied.canApply,false);await command('close_preview');
  const codex=await request(clientPath('codex'));assert.equal(codex.data.configuration,'applied');assert.equal(codex.data.clientUse,'not_verified');
  const restore=await request(clientPath('codex','previews'),'POST',{expectedProfileRevision:3,operation:'restore'});
  const restored=await request(clientPath('codex','commit'),'POST',{previewId:restore.data.id});assert.equal(restored.data.outcome,'restored');
  assert.equal(await readFile(dest('codex'),'utf8'),originals.codex);evidence.checks.qtApplyWebRestoreCodex=true;
  stage='web_apply_qt_restore_cursor';
  const cursor=await request(clientPath('cursor','previews'),'POST',{expectedProfileRevision:3,operation:'apply'});
  const cursorApply=await request(clientPath('cursor','commit'),'POST',{previewId:cursor.data.id});assert.equal(cursorApply.data.outcome,'applied');
  await command('preview_cursor');const qtRestore=await command('restore_preview');assert.match(qtRestore.status,/Restored/);await command('close_preview');
  assert.equal(await readFile(dest('cursor'),'utf8'),originals.cursor);evidence.checks.webApplyQtRestoreCursor=true;
  stage='web_preview_qt_conflict';
  const webPreview=await request(clientPath('cursor','previews'),'POST',{expectedProfileRevision:3,operation:'apply'});
  assert.equal((await command('toggle_local')).revision,4);
  const conflict=await request(clientPath('cursor','commit'),'POST',{previewId:webPreview.data.id});assert.equal(conflict.error.code,'REVISION_CONFLICT');
  assert.equal(await readFile(dest('cursor'),'utf8'),originals.cursor);evidence.checks.webPreviewRejectsQtChange=true;
  stage='qt_preview_web_conflict';
  await command('preview_codex');
  const current=(await request(profilePath)).data;
  const updated=await request(profilePath,'PUT',{expectedRevision:4,servers:current.servers.map(s=>({...s,label:s.id==='project_docs'?'Docs from web':s.label}))});
  assert.equal(updated.data.revision,5);
  const qtConflict=await command('apply_preview');assert.match(qtConflict.status,/(?:Profile changed|Project binding changed)/);await command('close_preview');
  assert.equal(await readFile(dest('codex'),'utf8'),originals.codex);evidence.checks.qtPreviewRejectsWebChange=true;
  stage='qt_stale_edit_reload';
  const staleQt=await command('toggle_local');assert.equal(staleQt.revision,4);
  assert.equal((await request(profilePath)).data.revision,5);evidence.checks.qtStaleEditCannotOverwriteWeb=true;
  const fresh=await command('reload_factory');assert.equal(fresh.revision,5);assert.equal(fresh.servers.find(s=>s.id==='project_docs').label,'Docs from web');
  const edge=await command('reload_edge');assert.equal(edge.projectId,'edge-gateway');assert.equal(edge.revision,0);assert.deepEqual(edge.servers,[]);
  await command('reload_factory');evidence.checks.qtReloadAndProjectIsolation=true;
  assert.deepEqual(await readFile(join(root,'synthetic-project.sqlite')),before);evidence.checks.nativeProjectBytesPreserved=true;
  evidence.finalProfileRevision=5;
  evidence.ipcPublicationWaits=publicationWaits;
  evidence.nativeProjectSha256=createHash('sha256').update(before).digest('hex');
  evidence.qtProbeSha256=createHash('sha256').update(await readFile(join(runtime,'bin/lmti-qt-web-probe.exe'))).digest('hex');
  if(process.argv.includes('--ipc-lock')) {
    // After the successful workflow, malformed bytes must still terminate the
    // bounded test controller rather than being hidden by the transient-open wait.
    const exited=new Promise(resolve=>qt.once('exit',status=>resolve(status)));
    await writeFile(join(root,'qt-command.tmp'),'{invalid synthetic command');
    await publishCommand();
    assert.equal(await exited,2);assert.equal(lastQtFailure?.phase,'command_decode');
    evidence.checks.malformedIpcRejected=true;
  }
  await writeFile(join(root,'qt-api-report.json'),JSON.stringify(evidence,null,2));
  if(process.argv.includes('--browser')) {
    stage='browser_coordination';
    // Development-only one-use nonce handoff, same synthetic scope. Never shipped.
    bridge=createServer((req,res)=>{
      if(req.method!=='GET'||req.url!=='/'||req.headers.host!==`127.0.0.1:${bridge.address().port}`||req.headers.origin){res.writeHead(403);res.end();return;}
      res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(api.issueLaunch());bridge.close();
    });
    await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
    const info={root,origin:api.origin,handoff:`http://127.0.0.1:${bridge.address().port}/`,pid:process.pid};
    await writeFile(join(repo,'build/web03-qt-browser-info.json'),JSON.stringify(info,null,2));console.log(JSON.stringify({kind:'ready',...info,checks:evidence.checks}));
    let queue=Promise.resolve();process.stdin.setEncoding('utf8');
    process.stdin.on('data',line=>{queue=queue.then(async()=>{
      const action={'qt-toggle':'toggle_local','qt-reload':'reload_factory'}[line.trim()];
      if(line.trim()==='finish'){await finish();process.stdin.pause();return;}
      assert.ok(action,'Use only fixed synthetic Qt commands.');const result=await command(action);
      console.log(JSON.stringify({kind:'qt',revision:result.revision,servers:result.servers}));
    }).catch(async()=>{console.error('Synthetic browser coordination failed.');await finish();process.stdin.pause();process.exitCode=1;});});
  } else {await finish();console.log(JSON.stringify({root,...evidence}));}
} catch(error) {
  await writeFile(join(root,'qt-api-failure.json'),JSON.stringify({stage,errorType:error.name,
    qtFailure:lastQtFailure,
    protocolFailure:lastProtocolFailure,
    lastQtPhase,lastAction,
    reason:['Synthetic Qt command timed out.','Invalid synthetic Qt response.'].includes(error.message)?error.message:(['EPERM','ENOENT','EACCES'].includes(error.code)?error.code:'other'),
    ...(typeof error.actual==='number'?{actual:error.actual}:{}),...(typeof error.expected==='number'?{expected:error.expected}:{})},null,2));
  await finish();console.error(JSON.stringify({failed:true,stage,root}));process.exitCode=1;
}
