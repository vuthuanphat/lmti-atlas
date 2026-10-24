import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const pkg=process.env.LMTI_WEB_TEST_PACKAGE??join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64');
const python=process.env.LMTI_WEB_TEST_PYTHON;
const project='operator-fixture';

async function within(promise,label,ms=15000) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);timer.unref();})]);}
  finally{clearTimeout(timer);}
}

/** The actual packaged main process receives only a private inherited pipe. */
function childProcess() {
  const env={};for(const name of ['SystemRoot','WINDIR'])if(process.env[name])env[name]=process.env[name];
  const child=spawn(process.execPath,[join(pkg,'apps/web-api/dist/main.js'),'--operator-control'],
    {cwd:repo,shell:false,windowsHide:true,env,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});
  let buffer='',stderr='',closed=false,outputBytes=0,errorBytes=0;
  const lines=[],waiters=[];
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    outputBytes+=Buffer.byteLength(chunk);buffer+=chunk;
    let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(waiters.length)waiters.shift()(line);else lines.push(line);}
  });
  child.stderr.on('data',chunk=>{errorBytes+=Buffer.byteLength(chunk);if(errorBytes<=16384)stderr+=chunk;});
  const finished=new Promise((accept,reject)=>{
    child.once('error',reject);
    child.once('close',(status,signal)=>{closed=true;for(const waiter of waiters.splice(0))waiter(null);accept({status,signal});});
  });
  return {
    child,finished,
    send(value){child.stdin.write(JSON.stringify(value)+'\n','utf8');},
    sendBytes(value){child.stdin.write(value);},
    eof(){if(!child.stdin.destroyed)child.stdin.end();},
    line(){return within(lines.length?Promise.resolve(lines.shift()):closed?Promise.resolve(null):new Promise(accept=>waiters.push(accept)),'The operator response did not arrive.');},
    evidence(){assert.ok(outputBytes<=16384&&errorBytes<=16384,'Operator diagnostics must stay bounded.');return {stderr,remaining:buffer,lines:[...lines]};},
    async close(){if(!closed){this.eof();await within(finished,'The operator process did not drain on EOF.',30000);}}
  };
}

async function fixture(t) {
  assert.equal(process.platform,'win32');assert.ok(python,'A trusted Python runtime is required.');
  const root=await mkdtemp(join(repo,'build/operator-main-')),children=[];
  t.after(async()=>{
    for(const child of children)await child.close();
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));await rm(root,{recursive:true,force:true});
  });
  const data=join(root,'dữ-liệu'),source=join(root,'source');await mkdir(data);await mkdir(source);
  const binary=join(pkg,'bin/lmti-project.exe'),database=join(data,'project.sqlite');
  for(const args of [['init-project',database,project,'Operator fixture'],['library-register',join(data,'project-library.sqlite'),database,source]]) {
    const result=spawnSync(binary,args,{shell:false,windowsHide:true,input:'',encoding:'utf8',timeout:15000,maxBuffer:8192});
    assert.equal(result.status,0,'Native setup must create fresh isolated operator fixtures.');
  }
  const config={adminBinary:join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:binary,library:join(data,'project-library.sqlite'),
    profiles:join(data,'mcp-profiles.sqlite'),python,agentEntry:join(pkg,'share/lmti/scripts/lmti-agent-mcp.py'),
    configOwner:join(pkg,'share/lmti/scripts/mcp-config-owner.py'),allowedProjects:[project],port:0,openBrowser:false};
  return {root,config,launch(){const child=childProcess();children.push(child);return child;}};
}

async function ready(child,config) {
  const bytes=Buffer.from(JSON.stringify(config)+'\n');
  // Split a multibyte path across pipe chunks: no console encoding or line
  // reader is allowed to replace the original UTF-8 bytes.
  const unicode=bytes.indexOf(Buffer.from('ữ'));
  assert.ok(unicode>=0,'The real startup fixture must contain a multibyte path.');
  child.sendBytes(bytes.subarray(0,unicode+1));child.sendBytes(bytes.subarray(unicode+1));
  const raw=await child.line();assert.ok(raw);const value=JSON.parse(raw);
  assert.deepEqual(Object.keys(value).sort(),['kind','pid','url','version']);
  assert.equal(value.kind,'lmti-local-api');assert.equal(value.version,1);assert.ok(Number.isInteger(value.pid));
  const url=new URL(value.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.hash,'');assert.equal(url.search,'');
  assert.doesNotMatch(raw,/bootstrap|Bearer|token|project\.sqlite/);
  return url.origin;
}

async function socketReleased(origin) {
  const server=createServer();
  try{await within(new Promise((accept,reject)=>server.once('error',reject).listen(Number(new URL(origin).port),'127.0.0.1',accept)),
    'Graceful shutdown did not release the listening socket.');}
  finally{if(server.listening)await new Promise(accept=>server.close(accept));}
}

test('packaged operator main preserves scoped startup, denies anonymous access and stops without browser execution',{timeout:45000},async t=>{
  const f=await fixture(t),child=f.launch(),origin=await ready(child,f.config);
  const response=await fetch(origin+'/api/v1/projects',{headers:{'X-LMTI-UI':'1'},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,401);const body=await response.json();assert.equal(body.error.code,'UNAUTHENTICATED');
  child.send({action:'open'});assert.deepEqual(JSON.parse(await child.line()),{kind:'lmti-operator-control',version:1,action:'open',ok:false,code:'BROWSER_DISABLED'});
  child.send({action:'stop'});assert.deepEqual(JSON.parse(await child.line()),{kind:'lmti-operator-control',version:1,action:'stop',ok:true});
  assert.deepEqual(await within(child.finished,'Stop did not drain the operator process.'),{status:0,signal:null});
  assert.equal(child.evidence().stderr,'');await socketReleased(origin);
});

test('packaged operator EOF drains the server and releases its socket',{timeout:45000},async t=>{
  const f=await fixture(t),child=f.launch(),origin=await ready(child,f.config);
  child.eof();assert.deepEqual(await within(child.finished,'EOF did not drain the operator process.'),{status:0,signal:null});
  assert.equal(child.evidence().stderr,'');await socketReleased(origin);
});

test('malformed initial operator input exits with a finite diagnostic while its input pipe remains open',{timeout:20000},async t=>{
  const child=childProcess();t.after(()=>child.close());
  child.sendBytes(Buffer.from('{"action":"first","action":"duplicate"}\n'));
  const result=await within(child.finished,'Invalid startup waited for operator EOF.');
  assert.deepEqual(result,{status:1,signal:null});const evidence=child.evidence();
  assert.deepEqual(evidence.lines,[]);assert.equal(evidence.remaining,'');
  assert.equal(evidence.stderr,'LMTI_STARTUP INVALID_OPERATOR_INPUT. Check the trusted local launcher and workspace.\n');
  assert.doesNotMatch(evidence.stderr,/first|duplicate|bootstrap|Bearer/);
});

test('packaged operator reports a port collision promptly without waiting for pipe EOF',{timeout:45000},async t=>{
  const f=await fixture(t),occupied=createServer();
  await new Promise(accept=>occupied.listen(0,'127.0.0.1',accept));
  t.after(()=>new Promise(accept=>occupied.close(accept)));
  const child=f.launch();child.send({...f.config,port:occupied.address().port});
  assert.deepEqual(await within(child.finished,'A port collision waited for operator EOF.'),{status:1,signal:null});
  const evidence=child.evidence();assert.deepEqual(evidence.lines,[]);assert.equal(evidence.remaining,'');
  assert.equal(evidence.stderr,'LMTI_STARTUP PORT_IN_USE. Check the trusted local launcher and workspace.\n');
  assert.doesNotMatch(evidence.stderr,/dữ-liệu|project\.sqlite|bootstrap|Bearer/);
});
