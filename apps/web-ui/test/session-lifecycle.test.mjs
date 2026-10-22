import assert from 'node:assert/strict';
import test from 'node:test';
import { endLocalSession } from '../src/session-lifecycle.ts';

const visibleState = () => ({ session: 'ready', profile: { revision: 1 }, projects: ['fixture'], events: ['fixture-action'] });
function cleanup(state, calls) {
  return () => {
    calls.push('clear');
    state.session = 'ended'; state.profile = null; state.projects = []; state.events = [];
  };
}
const ended = { session: 'ended', profile: null, projects: [], events: [] };

test('successful server revocation clears the local session exactly once', async () => {
  const state = visibleState(), calls = [];
  await endLocalSession(async () => { calls.push('revoke'); }, cleanup(state, calls));
  assert.deepEqual(calls, ['revoke', 'clear']);
  assert.deepEqual(state, ended);
});

test('network rejection still clears local data and preserves the unconfirmed server outcome', async () => {
  const state = visibleState(), calls = [], unavailable = new Error('fixture transport failure');
  await assert.rejects(endLocalSession(async () => { calls.push('revoke'); throw unavailable; }, cleanup(state, calls)), error => error === unavailable);
  assert.deepEqual(calls, ['revoke', 'clear'], 'No revocation retry or duplicate cleanup');
  assert.deepEqual(state, ended);
});

test('synchronous revocation failure also runs local cleanup once', async () => {
  const state = visibleState(), calls = [], failure = new Error('fixture request setup failure');
  await assert.rejects(endLocalSession(() => { calls.push('revoke'); throw failure; }, cleanup(state, calls)), error => error === failure);
  assert.deepEqual(calls, ['revoke', 'clear']);
  assert.deepEqual(state, ended);
});

test('one in-flight revocation is awaited without retry and cleans up on rejection', async () => {
  const state = visibleState(), calls = [];
  let rejectRevoke;
  const waiting = new Promise((resolve, reject) => { rejectRevoke = reject; });
  const completion = endLocalSession(() => { calls.push('revoke'); return waiting; }, cleanup(state, calls));
  const failure = new Error('fixture interrupted revocation');
  const observed = assert.rejects(completion, error => error === failure);
  assert.deepEqual(calls, ['revoke']);
  rejectRevoke(failure);
  await observed;
  assert.deepEqual(calls, ['revoke', 'clear']);
  assert.deepEqual(state, ended);
});
