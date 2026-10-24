import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessPool } from '../dist/process.js';

const childSource = String.raw`
const fs=require('node:fs');
const [started,release,effect]=process.argv.slice(1);
process.stdin.resume();process.stdin.once('end',()=>{
  fs.writeFileSync(started,'started');
  const timer=setInterval(()=>{if(fs.existsSync(release)){
    clearInterval(timer);clearTimeout(deadline);
    fs.writeFileSync(effect,'completed');process.stdout.end('{"ok":true}');
  }},5);
  const deadline=setTimeout(()=>{clearInterval(timer);process.exitCode=98;},8000);
});`;
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function until(check) {
  for(let i=0;i<300;i++) { if(await check()) return; await delay(10); }
  throw new Error('Controlled child did not reach the expected phase.');
}
async function fixture(t) {
  const root=await mkdtemp(fileURLToPath(new URL('../../../build/process-admission-',import.meta.url)));
  const releases=[],jobs=[]; let index=0,calls=0,kills=0;
  t.after(async()=>{
    for(const path of releases) await writeFile(path,'release');
    await Promise.allSettled(jobs); await rm(root,{recursive:true,force:true});
  });
  const pool=new ProcessPool(1,(...args)=>{
    calls++;const child=spawn(...args),kill=child.kill.bind(child);
    child.kill=(...values)=>{kills++;return kill(...values);};return child;
  });
  return {pool,counts:()=>({calls,kills}),track(task){jobs.push(task);return task;},child(){
    const prefix=join(root,String(index++));
    const value={started:prefix+'.started',release:prefix+'.release',effect:prefix+'.effect'};
    releases.push(value.release);
    return {...value,args:['-e',childSource,value.started,value.release,value.effect]};
  }};
}

test('expired queued write never dispatches, frees queue capacity and preserves drain',{timeout:15000},async t=>{
  const f=await fixture(t),first=f.child(),expired=f.child(),next=f.child();let guardCalls=0,started=0,idle=false;
  const writing=f.track(f.pool.runWrite(process.execPath,first.args,''));
  await until(()=>exists(first.started));
  const queued=f.track(f.pool.runWrite(process.execPath,expired.args,'',{queueTimeoutMs:40,
    guard:()=>{guardCalls++;},onStarted:()=>{started++;}}));
  const drain=f.pool.waitForIdle().then(()=>{idle=true;});
  assert.deepEqual(await queued,{kind:'not_started',code:'BUSY'});
  assert.equal(idle,false);assert.equal(guardCalls,0);assert.equal(started,0);
  assert.equal(await exists(expired.started),false);assert.equal(await exists(expired.effect),false);
  const recovery=f.track(f.pool.runWrite(process.execPath,next.args,'',{queueTimeoutMs:5000}));
  await writeFile(next.release,'release');await writeFile(first.release,'release');
  assert.equal((await writing).transportOk,true);assert.equal((await recovery).transportOk,true);
  await drain;assert.equal(f.pool.isIdle(),true);assert.deepEqual(f.counts(),{calls:2,kills:0});
  assert.equal(await readFile(next.effect,'utf8'),'completed');
});

test('abort removes a queued read before its guard or child can start',{timeout:15000},async t=>{
  const f=await fixture(t),first=f.child(),unused=f.child(),controller=new AbortController();let guards=0;
  const writing=f.track(f.pool.runWrite(process.execPath,first.args,''));
  await until(()=>exists(first.started));
  const queued=f.track(f.pool.run(process.execPath,unused.args,'',{signal:controller.signal,
    guard:()=>{guards++;}}));
  const refused=assert.rejects(queued,{code:'SESSION_EXPIRED'});controller.abort();await refused;
  assert.equal(guards,0);assert.equal(await exists(unused.started),false);
  assert.equal(f.pool.isIdle(),false);await writeFile(first.release,'release');await writing;
  await f.pool.waitForIdle();assert.equal(f.pool.isIdle(),true);assert.deepEqual(f.counts(),{calls:1,kills:0});
});

test('abort during an asynchronous guard refuses a write before dispatch',{timeout:15000},async t=>{
  const f=await fixture(t),unused=f.child(),controller=new AbortController();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{entered=resolve;});
  const writing=f.track(f.pool.runWrite(process.execPath,unused.args,'',{signal:controller.signal,
    guard:async()=>{entered();await gate;}}));
  await begun;controller.abort();release();
  assert.deepEqual(await writing,{kind:'not_started',code:'SESSION_EXPIRED'});
  assert.equal(await exists(unused.started),false);await f.pool.waitForIdle();
  assert.equal(f.pool.isIdle(),true);assert.deepEqual(f.counts(),{calls:0,kills:0});
});

test('abort and admission deadline never terminate a dispatched writer',{timeout:15000},async t=>{
  const f=await fixture(t),child=f.child(),controller=new AbortController();let finished=false,idle=false;
  const writing=f.track(f.pool.runWrite(process.execPath,child.args,'',{
    signal:controller.signal,queueTimeoutMs:1}));
  void writing.then(()=>{finished=true;});await until(()=>exists(child.started));controller.abort();
  const drain=f.pool.waitForIdle().then(()=>{idle=true;});await delay(40);
  assert.equal(finished,false);assert.equal(idle,false);assert.deepEqual(f.counts(),{calls:1,kills:0});
  await writeFile(child.release,'release');assert.equal((await writing).transportOk,true);await drain;
  assert.equal(await readFile(child.effect,'utf8'),'completed');assert.equal(f.pool.isIdle(),true);
});

test('pre-aborted and invalid admission options refuse before dispatch',async t=>{
  const f=await fixture(t),unused=f.child(),controller=new AbortController();controller.abort();
  assert.deepEqual(await f.pool.runWrite(process.execPath,unused.args,'',{signal:controller.signal}),
    {kind:'not_started',code:'SESSION_EXPIRED'});
  for(const queueTimeoutMs of [0,-1,1.5,Infinity,120001])
    assert.deepEqual(await f.pool.runWrite(process.execPath,unused.args,'',{queueTimeoutMs}),
      {kind:'not_started',code:'INVALID_INPUT'});
  await assert.rejects(f.pool.run(process.execPath,unused.args,'',{queueTimeoutMs:0}),{code:'INVALID_INPUT'});
  assert.equal(f.pool.isIdle(),true);assert.deepEqual(f.counts(),{calls:0,kills:0});
});
