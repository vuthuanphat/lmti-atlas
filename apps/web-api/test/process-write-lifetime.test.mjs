import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessPool, WriteOutcomeUnknown } from '../dist/process.js';
import { ApiError } from '../dist/security.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const childSource = String.raw`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [mode,started,release,finished,log] = process.argv.slice(2);
appendFileSync(log,'start\n');
let done=false, poll, deadline;
const finish=() => {
  if(done) return; done=true;
  clearInterval(poll); clearTimeout(deadline);
  appendFileSync(log,'finish\n'); writeFileSync(finished,'finished');
  if(mode !== 'stdout-ended') process.stdout.end(mode === 'environment'
    ? JSON.stringify(Object.keys(process.env)) : '{"ok":true}\n');
};
const begin=() => {
  poll=setInterval(() => { if(existsSync(release)) finish(); },10);
  deadline=setTimeout(() => { process.exitCode=98; finish(); },8000);
  if(mode === 'overflow') process.stdout.write(Buffer.alloc(2*1024*1024,120),() => writeFileSync(started,'overflow-drained'));
  else if(mode === 'stdout-ended') process.stdout.end('{"ok":true}\n',() => writeFileSync(started,'stdout-ended'));
  else writeFileSync(started,'ready');
  if(mode === 'immediate' || mode === 'environment') finish();
};
if(mode === 'input-independent') begin();
else { process.stdin.resume(); process.stdin.once('end',begin); }
`;
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function until(check) {
  for(let i=0;i<250;i++) { if(await check()) return; await delay(10); }
  throw new Error('Controlled process did not reach its expected phase.');
}
async function fixture(t) {
  await mkdir(join(repo,'build'),{recursive:true});
  const root=await mkdtemp(join(repo,'build/process-write-'));
  const script=join(root,'controlled-child.mjs'); await writeFile(script,childSource);
  const jobs=[], releases=[];
  t.after(async () => {
    for(const path of releases) await writeFile(path,'release');
    await Promise.allSettled(jobs);
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));
    await rm(root,{recursive:true,force:true});
  });
  let index=0;
  return {
    root,
    child(mode='hold') {
      const prefix=join(root,String(index++));
      const value={started:prefix+'.started',release:prefix+'.release',finished:prefix+'.finished',log:prefix+'.log'};
      releases.push(value.release);
      return {...value,args:[script,mode,value.started,value.release,value.finished,value.log]};
    },
    track(promise) { jobs.push(promise); return promise; }
  };
}
function observer({errorBeforeSpawn=false,postSpawnError=false}={}) {
  const state={calls:0,kills:0,close:0,stdinErrors:0,events:[],options:[]};
  const launch=(...args) => {
    state.calls++; state.options.push(args[2]);
    const child=spawn(...args);
    const kill=child.kill.bind(child);
    child.kill=(...values) => { state.kills++; return kill(...values); };
    child.once('close',() => { state.close++; });
    child.stdin.on('error',() => { state.stdinErrors++; });
    if(errorBeforeSpawn) {
      const emit=child.emit;
      child.emit=function(name,...values) {
        if(name === 'spawn') {
          state.events.push('error'); emit.call(this,'error',new Error('Controlled early event.'));
          state.events.push('spawn');
        }
        return emit.call(this,name,...values);
      };
    } else if(postSpawnError) {
      child.once('spawn',() => setImmediate(() => child.emit('error',new Error('Controlled late event.'))));
    }
    return child;
  };
  return {state,launch};
}

test('runWrite distinguishes no-start, bad bounds and guard failure without dispatch',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch);
  let notifications=0;
  const absent=await pool.runWrite(join(f.root,'missing-owner.exe'),[],'',{onStarted:() => notifications++});
  assert.deepEqual(absent,{kind:'not_started',code:'OWNER_UNAVAILABLE'});
  assert.equal(notifications,0); assert.equal(seen.state.close,1);
  const child=f.child('immediate');
  assert.deepEqual(await pool.runWrite(process.execPath,child.args,'x'.repeat(128*1024+1)),
    {kind:'not_started',code:'LIMIT_EXCEEDED'});
  for(const cap of [0,-1,1.5,Infinity,4*1024*1024+1])
    assert.deepEqual(await pool.runWrite(process.execPath,child.args,'',{cap}),{kind:'not_started',code:'INVALID_INPUT'});
  assert.deepEqual(await pool.runWrite(process.execPath,child.args,'',{guard:() => { throw new ApiError('SESSION_EXPIRED'); }}),
    {kind:'not_started',code:'SESSION_EXPIRED'});
  assert.deepEqual(await pool.runWrite(process.execPath,['bad\0argument'],''),
    {kind:'not_started',code:'OWNER_UNAVAILABLE'});
  assert.equal(seen.state.calls,2); assert.equal(await exists(child.started),false);
  assert.equal(pool.isIdle(),true); await pool.waitForIdle();
});

test('stdout end does not release a writer, queued guard, or waitForIdle',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), first=f.child('stdout-ended'), second=f.child('immediate');
  let settled=false, idle=false, guardRan=false, notifications=0;
  const writing=f.track(pool.runWrite(process.execPath,first.args,'',{onStarted:() => notifications++}));
  void writing.then(() => { settled=true; });
  await until(() => exists(first.started));
  const next=f.track(pool.runWrite(process.execPath,second.args,'',{guard:() => { guardRan=true; }}));
  const drained=pool.waitForIdle().then(() => { idle=true; });
  await delay(40);
  assert.equal(settled,false); assert.equal(idle,false); assert.equal(guardRan,false); assert.equal(pool.isIdle(),false);
  assert.equal(seen.state.calls,1); assert.equal(notifications,1);
  await writeFile(first.release,'release');
  const result=await writing;
  assert.equal(result.kind,'closed'); assert.equal(result.transportOk,true); assert.equal(result.exitCode,0);
  assert.equal(JSON.parse(result.bytes.toString()).ok,true);
  assert.equal((await next).transportOk,true); await drained;
  assert.equal(guardRan,true); assert.equal(pool.isIdle(),true); assert.equal(seen.state.close,2); assert.equal(seen.state.kills,0);
});

test('overflow drains a real pipe and retains the slot until the writer finishes',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), child=f.child('overflow');
  let settled=false;
  const writing=f.track(pool.runWrite(process.execPath,child.args,'',{cap:32}));
  void writing.then(() => { settled=true; });
  await until(() => exists(child.started)); // Callback proves all 2 MiB crossed the drained pipe.
  assert.equal(settled,false); assert.equal(pool.isIdle(),false); assert.equal(seen.state.kills,0);
  await writeFile(child.release,'release');
  assert.deepEqual(await writing,{kind:'closed',exitCode:0,bytes:null,transportOk:false});
  assert.equal(await exists(child.finished),true);
  assert.equal(await readFile(child.log,'utf8'),'start\nfinish\n');
  assert.equal(seen.state.calls,1); assert.equal(seen.state.close,1); assert.equal(seen.state.kills,0);
});

for(const early of [true,false]) test(`real live writer error ${early?'before spawn event':'after spawn event'} waits for close`,{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer({errorBeforeSpawn:early,postSpawnError:!early});
  const pool=new ProcessPool(1,seen.launch), child=f.child();
  let settled=false, notifications=0;
  const writing=f.track(pool.runWrite(process.execPath,child.args,'',{onStarted:() => notifications++}));
  void writing.then(() => { settled=true; });
  await until(() => exists(child.started)); await delay(30);
  assert.equal(settled,false); assert.equal(pool.isIdle(),false); assert.equal(notifications,1);
  if(early) assert.deepEqual(seen.state.events,['error','spawn']);
  await writeFile(child.release,'release');
  assert.deepEqual(await writing,{kind:'closed',exitCode:0,bytes:null,transportOk:false});
  assert.equal(await exists(child.finished),true); assert.equal(seen.state.kills,0); assert.equal(seen.state.calls,1);
});

test('controlled stdin stream failure retains a real child until close with no retry',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), child=f.child('input-independent');
  const streamFailure=new Error('Controlled stdin stream failure.');
  let observedFailure;
  // OS pipe buffering does not guarantee EPIPE before a live child exits.
  // Destroy the real input Writable with an explicit fixture error after the
  // child is running. This exercises its actual stream-error lifecycle without
  // fabricating a child-process event or claiming an OS EPIPE observation.
  const launch=(...args) => {
    const childProcess=seen.launch(...args);
    childProcess.stdin.once('error',error => { observedFailure=error; });
    childProcess.stdin.end=() => {
      void until(() => exists(child.started)).then(
        () => { childProcess.stdin.destroy(streamFailure); },
        error => { childProcess.stdin.destroy(error); });
      return childProcess.stdin;
    };
    return childProcess;
  };
  const pool=new ProcessPool(1,launch);
  let settled=false;
  const writing=f.track(pool.runWrite(process.execPath,child.args,'x'.repeat(128*1024)));
  void writing.then(() => { settled=true; });
  await until(() => exists(child.started)); await until(() => seen.state.stdinErrors > 0);
  assert.equal(observedFailure,streamFailure);
  assert.equal(settled,false); assert.equal(pool.isIdle(),false);
  await writeFile(child.release,'release');
  assert.deepEqual(await writing,{kind:'closed',exitCode:0,bytes:null,transportOk:false});
  assert.equal(await readFile(child.log,'utf8'),'start\nfinish\n');
  assert.equal(seen.state.calls,1); assert.equal(seen.state.kills,0);
});

test('session-equivalent queued cancellation never starts work and does not cancel live work',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), first=f.child(), second=f.child('immediate');
  let revoked=false;
  const writing=f.track(pool.runWrite(process.execPath,first.args,''));
  await until(() => exists(first.started));
  const queued=f.track(pool.runWrite(process.execPath,second.args,'',{guard:() => {
    if(revoked) throw new ApiError('SESSION_EXPIRED');
  }}));
  revoked=true;
  await delay(30); assert.equal(pool.isIdle(),false); assert.equal(seen.state.calls,1);
  await writeFile(first.release,'release');
  assert.equal((await writing).transportOk,true);
  assert.deepEqual(await queued,{kind:'not_started',code:'SESSION_EXPIRED'});
  await pool.waitForIdle();
  assert.equal(await exists(second.started),false); assert.equal(seen.state.calls,1); assert.equal(seen.state.kills,0);
});

test('bounded queue and drain include all admitted guards without an idle handoff gap',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), first=f.child(), unused=f.child('immediate');
  const writing=f.track(pool.runWrite(process.execPath,first.args,''));
  await until(() => exists(first.started));
  const queued=Array.from({length:16},() => f.track(pool.runWrite(process.execPath,unused.args,'',{
    guard:() => { throw new ApiError('SCOPE_DENIED'); }
  })));
  assert.deepEqual(await pool.runWrite(process.execPath,unused.args,''),{kind:'not_started',code:'BUSY'});
  let idle=false; const drain=pool.waitForIdle().then(() => { idle=true; });
  assert.equal(idle,false);
  await writeFile(first.release,'release'); await writing;
  assert.ok((await Promise.all(queued)).every(r => r.kind === 'not_started' && r.code === 'SCOPE_DENIED'));
  await drain;
  assert.equal(pool.isIdle(),true); assert.equal(seen.state.calls,1);
});

test('onStarted failure is notification failure, never a cancellation',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), child=f.child();
  let calls=0;
  const writing=f.track(pool.runWrite(process.execPath,child.args,'',{onStarted:() => { calls++; throw new Error('Controlled callback failure.'); }}));
  await until(() => exists(child.started)); assert.equal(pool.isIdle(),false);
  await writeFile(child.release,'release');
  assert.deepEqual(await writing,{kind:'closed',exitCode:0,bytes:null,transportOk:false});
  assert.equal(calls,1); assert.equal(await exists(child.finished),true); assert.equal(seen.state.kills,0);
});

test('legacy write decoder retains close-only lifetime, proposal exceptions and no read timeout',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer({postSpawnError:true}), pool=new ProcessPool(1,seen.launch), child=f.child();
  let settled=false;
  const writing=f.track(pool.run(process.execPath,child.args,'',{write:true,timeoutMs:1}));
  void writing.then(() => { settled=true; },() => { settled=true; });
  await until(() => exists(child.started)); await delay(30);
  assert.equal(settled,false); assert.equal(pool.isIdle(),false); assert.equal(seen.state.kills,0);
  await writeFile(child.release,'release');
  await assert.rejects(writing,e => e instanceof WriteOutcomeUnknown && e.code === 'RECOVERY_REQUIRED');
  assert.equal(await exists(child.finished),true);
  const plain=new ProcessPool();
  const refusal={ok:false,error:{code:'REVISION_CONFLICT'}};
  const args=['-e',`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(refusal))});process.exitCode=1;});`];
  assert.equal((await plain.run(process.execPath,args,'',{write:true,projectProposalErrors:true})).error.code,'REVISION_CONFLICT');
  await assert.rejects(plain.run(process.execPath,args,'',{write:true}),
    e => e instanceof WriteOutcomeUnknown && e.code === 'RECOVERY_REQUIRED');
  for (const output of ['{"ok":true,"ok":true}','{"ok":','{"ok":true}\0']) {
    const malformed=['-e',`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}));`];
    await assert.rejects(plain.run(process.execPath,malformed,'',{write:true}),
      e => e instanceof WriteOutcomeUnknown && e.code === 'RECOVERY_REQUIRED');
  }
  await assert.rejects(plain.run(join(f.root,'missing-legacy-owner.exe'),[],'',{write:true}),
    e => e instanceof ApiError && !(e instanceof WriteOutcomeUnknown) && e.code === 'OWNER_UNAVAILABLE');
  await assert.rejects(plain.run(join(f.root,'missing-legacy-owner.exe'),[],'',{write:true,raw:true}),
    e => e instanceof ApiError && !(e instanceof WriteOutcomeUnknown) && e.code === 'INVALID_INPUT');
  assert.equal(await plain.run(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('42'));"],''),42);
});

test('all launches retain shell:false/windowsHide and sanitized environment',{timeout:15000},async (t) => {
  const f=await fixture(t), seen=observer(), pool=new ProcessPool(1,seen.launch), child=f.child('environment');
  const old=process.env.LMTI_SYNTHETIC_SECRET; process.env.LMTI_SYNTHETIC_SECRET='fixture-only';
  t.after(() => { if(old === undefined) delete process.env.LMTI_SYNTHETIC_SECRET; else process.env.LMTI_SYNTHETIC_SECRET=old; });
  const result=await f.track(pool.runWrite(process.execPath,child.args,''));
  assert.equal(result.kind,'closed'); assert.equal(result.transportOk,true);
  assert.equal(JSON.parse(result.bytes.toString()).includes('LMTI_SYNTHETIC_SECRET'),false);
  const options=seen.state.options[0];
  assert.equal(options.shell,false); assert.equal(options.windowsHide,true);
  assert.deepEqual(Object.keys(options.env).sort(),['PYTHONIOENCODING',...['SystemRoot','WINDIR'].filter(k => process.env[k])].sort());
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
});

test('optional read LF framing checks original bytes and preserves strict UTF8',{timeout:15000},async () => {
  const pool=new ProcessPool();
  const args=values=>['-e',`process.stdin.resume();process.stdin.on('end',()=>process.stdout.end(Buffer.from(${JSON.stringify(values)})));`];
  const json=[...Buffer.from('{"ok":true}')];
  assert.equal((await pool.run(process.execPath,args(json),'')).ok,true);
  await assert.rejects(pool.run(process.execPath,args(json),'',{newlineTerminated:true}),{code:'OWNER_UNAVAILABLE'});
  assert.equal((await pool.run(process.execPath,args([...json,10]),'',{newlineTerminated:true})).ok,true);
  // A replacement-decoded string would make this valid JSON; original bytes must fail.
  const malformed=[...Buffer.from('{"value":"'),0xff,...Buffer.from('"}\n')];
  for (const newlineTerminated of [false,true])
    await assert.rejects(pool.run(process.execPath,args(malformed),'',{newlineTerminated}),{code:'OWNER_UNAVAILABLE'});
  await pool.waitForIdle(); assert.equal(pool.isIdle(),true);
});
