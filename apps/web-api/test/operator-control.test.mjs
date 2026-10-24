import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:net';
import {OperatorInputError,operatorFrames,runOperatorSession,startupCode} from '../dist/operator-control.js';
import {ApiError} from '../dist/security.js';

const input=(...parts)=>(async function*(){for(const part of parts)yield Buffer.from(part);})();
function fixture({openBrowser=true,close=async()=>{}}={}) {
  const reports=[],opened=[];let starts=0,closes=0,issued=0;
  return {reports,opened,get starts(){return starts;},get closes(){return closes;},deps:{
    start:async config=>{starts++;assert.equal(config.openBrowser,openBrowser);return {origin:'http://127.0.0.1:12345',isIdle:()=>true,issueLaunch:()=>`http://127.0.0.1:12345/#bootstrap=synthetic-${++issued}`,close:async()=>{closes++;await close();}};},
    open:async url=>{opened.push(url);},report:value=>reports.push(value)
  }};
}
test('fragmented Unicode config and framed operator commands never appear in reports',async()=>{
  const f=fixture(),bytes=Buffer.from('{"openBrowser":true,"label":"Thư mục dự án"}\n{"action":"open"}\n{"action":"stop"}\n');
  await runOperatorSession((async function*(){for(const b of bytes)yield Buffer.from([b]);})(),f.deps);
  assert.equal(f.starts,1);assert.equal(f.closes,1);assert.equal(f.opened.length,2);
  assert.notEqual(f.opened[0],f.opened[1]);
  assert.deepEqual(f.reports.map(r=>r.kind),['lmti-local-api','lmti-operator-control','lmti-operator-control']);
  assert.equal(JSON.stringify(f.reports).includes('bootstrap'),false);
  assert.equal(JSON.stringify(f.reports).includes('Thư'),false);
});
for(const bad of ['', '\n','{"a":1}', '{"a":1}\r\n','x'.repeat(16384)+'\n'])test('invalid initial operator framing is refused before API startup '+JSON.stringify(bad.slice(0,12)),async()=>{
  const f=fixture();await assert.rejects(runOperatorSession(input(bad),f.deps),OperatorInputError);assert.equal(f.starts,0);assert.equal(f.opened.length,0);
});
test('duplicate or invalid UTF-8 configuration cannot start the owner',async()=>{
  for(const bytes of [Buffer.from('{"openBrowser":true,"openBrowser":false}\n'),Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125,10])]){
    const f=fixture();await assert.rejects(runOperatorSession(input(bytes),f.deps),OperatorInputError);assert.equal(f.starts,0);
  }
});
for(const command of ['{"action":"shell"}\n','{"action":"open","url":"https://example.invalid"}\n','{"action":"open","action":"stop"}\n','{"action":"open"}', 'x'.repeat(256)+'\n','\n'])test('invalid control drains and closes without running an action '+JSON.stringify(command.slice(0,35)),async()=>{
  const f=fixture();await assert.rejects(runOperatorSession(input('{"openBrowser":true}\n',command),f.deps),OperatorInputError);assert.equal(f.closes,1);assert.equal(f.opened.length,1);
});
test('EOF and stop both await already accepted work before acknowledging closure',async()=>{
  for(const command of ['', '{"action":"stop"}\n']){
    let finish,closing;const drained=new Promise(resolve=>{finish=resolve;}),entered=new Promise(resolve=>{closing=resolve;});
    const f=fixture({close:async()=>{closing();await drained;}});let done=false;
    const run=runOperatorSession(input('{"openBrowser":true}\n',command),f.deps).then(()=>{done=true;});
    await entered;assert.equal(done,false);assert.equal(f.closes,1);assert.equal(f.reports.some(r=>r.action==='stop'),false);
    finish();await run;assert.equal(done,true);assert.equal(f.closes,1);
    assert.equal(f.reports.some(r=>r.action==='stop'),command!=='');
  }
});
test('operator EOF releases a real listening socket',async()=>{
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await runOperatorSession(input('{"openBrowser":false}\n'),{
    start:async()=>({origin:`http://127.0.0.1:${port}`,isIdle:()=>true,issueLaunch:()=>{throw Error('No browser launch expected');},close:()=>new Promise(resolve=>socket.close(resolve))}),
    open:async()=>{throw Error('No browser launch expected');},report:()=>{}
  });
  assert.equal(socket.listening,false);
});
test('an attached operator keeps the service available without extending session authentication',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const pipe=new PassThrough();const f=fixture();const run=runOperatorSession(pipe,f.deps);
  pipe.write('{"openBrowser":true}\n');
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(1200000);assert.equal(f.closes,0);assert.equal(f.opened.length,1);
  pipe.end();await run;assert.equal(f.closes,1);
});
test('a failed browser reopen is bounded and the console can still stop safely',async()=>{
  const f=fixture();let attempts=0;f.deps.open=async()=>{if(++attempts>1)throw Object.assign(Error('private failure never exposed'),{code:'BROWSER_UNAVAILABLE'});};
  await runOperatorSession(input('{"openBrowser":true}\n{"action":"open"}\n{"action":"stop"}\n'),f.deps);
  assert.deepEqual(f.reports[1],{kind:'lmti-operator-control',version:1,action:'open',ok:false,code:'BROWSER_UNAVAILABLE'});assert.equal(f.closes,1);assert.equal(JSON.stringify(f.reports).includes('private failure'),false);
});
test('startup diagnostics expose only finite codes',()=>{
  assert.equal(startupCode(Object.assign(Error('private path'),{code:'EADDRINUSE'})),'PORT_IN_USE');
  assert.equal(startupCode(new ApiError('OWNER_UNAVAILABLE')),'OWNER_UNAVAILABLE');
  assert.equal(startupCode(Error('private raw detail')),'STARTUP_FAILED');
});
test('operator frame bounds reset after each command',async()=>{
  const frames=[];for await(const frame of operatorFrames(input('{"openBrowser":false}\n','{"action":"open"}\n{"action":"stop"}\n')))frames.push(JSON.parse(frame));
  assert.equal(frames.length,3);
});

test('operator never reports a running listener after a startup signal',async()=>{
  let opening,finishOpen;
  const entered=new Promise(resolve=>{opening=resolve;}),pending=new Promise(resolve=>{finishOpen=resolve;});
  const pipe=new PassThrough(),f=fixture();
  f.deps.open=async()=>{opening();await pending;};
  const rejected=assert.rejects(runOperatorSession(pipe,f.deps),/startup was interrupted/);
  pipe.write('{"openBrowser":true}\n');await entered;
  process.emit('SIGTERM');finishOpen();await rejected;
  assert.equal(f.closes,1);assert.equal(f.reports.length,0);assert.equal(pipe.destroyed,true);
});

test('startup errors release the inherited input without waiting for parent EOF',async()=>{
  for(const value of ['{"openBrowser":false,"openBrowser":true}\n','{"openBrowser":false}\n']){
    const pipe=new PassThrough(),f=fixture({openBrowser:false});
    f.deps.start=async()=>{throw new ApiError('OWNER_UNAVAILABLE');};
    const rejected=assert.rejects(runOperatorSession(pipe,f.deps));
    pipe.write(value);await rejected;assert.equal(pipe.destroyed,true);assert.equal(f.closes,0);
  }
});
