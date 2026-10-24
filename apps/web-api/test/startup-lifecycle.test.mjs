import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startApiLifecycle } from '../dist/lifecycle.js';

const handlers = () => ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));

test('startup failure releases a listening socket and its signal handlers', async () => {
  const before = handlers();
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let closes = 0;
  const api = {isIdle: () => false, close: () => {
    closes++;
    return new Promise(resolve => server.close(resolve));
  }};
  await assert.rejects(startApiLifecycle(api, async () => {
    throw new Error('controlled browser launch failure');
  }), /controlled browser launch failure/);
  assert.equal(closes, 1);
  assert.equal(server.listening, false);
  assert.deepEqual(handlers(), before);
  const replacement = createServer();
  await new Promise((resolve, reject) => replacement.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => replacement.close(resolve));
});

test('signal and explicit shutdown share the pending close without releasing an active write', async () => {
  const before = handlers();
  let finish, closes = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const stop = await startApiLifecycle({isIdle: () => false, close: () => { closes++; return pending; }}, async () => {});
  process.emit('SIGTERM');
  const one = stop(), two = stop();
  assert.equal(one, two);
  let complete = false;
  one.then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(closes, 1);
  assert.equal(complete, false);
  assert.deepEqual(handlers(), before.map(count => count + 1));
  process.emit('SIGTERM'); process.emit('SIGINT');
  assert.equal(closes, 1);
  finish(); await one;
  assert.equal(complete, true);
  assert.deepEqual(handlers(), before);
});

test('idle shutdown clears its interval and closes once', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let closes = 0, checks = 0;
  const stop = await startApiLifecycle({
    isIdle: () => { checks++; return true; },
    close: async () => { closes++; },
  }, async () => {});
  t.mock.timers.tick(30000);
  await stop();
  t.mock.timers.tick(60000);
  assert.equal(closes, 1);
  assert.equal(checks, 1);
});

test('a signal during startup drains accepted work and refuses readiness', async () => {
  const before=handlers();
  let finishOpen,finishClose,enteredOpen,enteredClose,closes=0;
  const opening=new Promise(resolve=>{finishOpen=resolve;});
  const closing=new Promise(resolve=>{finishClose=resolve;});
  const openEntered=new Promise(resolve=>{enteredOpen=resolve;});
  const closeEntered=new Promise(resolve=>{enteredClose=resolve;});
  let completed=false;
  const result=startApiLifecycle({isIdle:()=>false,close:async()=>{closes++;enteredClose();await closing;}},
    async()=>{enteredOpen();await opening;},{operatorControlled:true});
  const rejected=assert.rejects(result,/startup was interrupted/).then(()=>{completed=true;});
  await openEntered;process.emit('SIGTERM');await closeEntered;
  finishOpen();await Promise.resolve();assert.equal(completed,false);
  assert.equal(closes,1);assert.deepEqual(handlers(),before.map(count=>count+1));
  finishClose();await rejected;
  assert.equal(closes,1);assert.deepEqual(handlers(),before);
});
