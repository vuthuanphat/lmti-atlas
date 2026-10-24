import assert from 'node:assert/strict';
import test from 'node:test';
import { checkServiceConnection, endLocalSession, sessionFailureReason } from '../src/session-lifecycle.ts';

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

test('startup transport failure, refused startup and authentication endings stay distinct', () => {
  assert.equal(sessionFailureReason('NETWORK', true), 'startup_network');
  assert.equal(sessionFailureReason('BUSY', true), 'startup_refused');
  assert.equal(sessionFailureReason('SESSION_EXPIRED', true), 'expired');
  assert.equal(sessionFailureReason('UNAUTHENTICATED', true), 'unauthenticated');
  for (const code of ['NETWORK', 'OWNER_UNAVAILABLE', 'RECOVERY_REQUIRED', 'BUSY'])
    assert.equal(sessionFailureReason(code), null, `${code} cannot end an active private session`);
});

test('manual connection check makes one fixed GET and does not settle caller write or recovery state', async () => {
  for (const failure of [null, new Error('Synthetic connection failure')]) {
    const calls = [], state = { bearerRetained: true, needsReload: true, unknown: true, locked: true, recoveryRequired: true };
    const before = structuredClone(state);
    const read = async (...args) => { calls.push(args); if (failure) throw failure; return { admitted: true, recoveryRequired: false }; };
    if (failure) await assert.rejects(checkServiceConnection(read), error => error === failure);
    else await checkServiceConnection(read);
    assert.deepEqual(calls, [['/api/v1/write-status', 'GET']]);
    assert.deepEqual(state, before);
  }
});
