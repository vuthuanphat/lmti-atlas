import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const app = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(app.resolve('vite'))('esbuild');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node' });

// Each case runs the actual API module with an isolated fake transport. No
// network, native owner, real credential, browser storage or bootstrap URL.
function harness() {
  let transport = async () => ({ json: async () => ({ apiVersion: 1, ok: true, data: {} }) });
  const calls = [];
  const fetch = async (path, options) => { calls.push({ path, options }); return transport(path, options); };
  const module = { exports: {} };
  const location = { hash: `#bootstrap=${'f'.repeat(43)}`, pathname: '/' };
  const history = { replaceState: () => { location.hash = ''; } };
  new Function('require', 'module', 'exports', 'fetch', 'location', 'history', bundle.outputFiles[0].text)(app, module, module.exports, fetch, location, history);
  return { ...module.exports, calls, transport: handler => { transport = handler; },
    result: data => { transport = async () => ({ json: async () => data }); } };
}
const denied = code => ({ apiVersion: 1, ok: false, error: { code, message: 'Synthetic session response.' } });

test('both authentication errors notify cleanup before the child request rejection is observed', async () => {
  for (const code of ['SESSION_EXPIRED', 'UNAUTHENTICATED']) {
    const api = harness(), order = [];
    const view = { session: 'ready', profile: { revision: 1 }, projects: ['fixture'] };
    api.subscribeSessionInvalidated(() => {
      order.push('clear'); view.session = 'ended'; view.profile = null; view.projects = [];
    });
    api.result(denied(code));
    await api.request('/api/v1/physical-hierarchy-scopes').catch(error => {
      order.push('child catch');
      assert.ok(error instanceof api.RequestError);
      assert.equal(error.code, code);
      assert.deepEqual(view, { session: 'ended', profile: null, projects: [] });
    });
    assert.deepEqual(order, ['clear', 'child catch']);
    assert.equal(api.calls.length, 1, 'Session invalidation must not issue a retry');
  }
});

test('the bearer is cleared before invalidation subscribers run', async () => {
  const api = harness();
  api.result({ apiVersion: 1, ok: true, data: { token: 'synthetic-unit-test-capability' } });
  await api.bootstrap();
  let readAfterCleanup;
  api.subscribeSessionInvalidated(() => {
    api.result({ apiVersion: 1, ok: true, data: {} });
    readAfterCleanup = api.request('/api/v1/write-status');
  });
  api.result(denied('SESSION_EXPIRED'));
  await assert.rejects(api.request('/api/v1/projects'), error => error.code === 'SESSION_EXPIRED');
  await readAfterCleanup;
  assert.equal('Authorization' in api.calls[1].options.headers, true);
  assert.equal('Authorization' in api.calls[2].options.headers, false);
});

test('transport, unreadable responses and unrelated API refusals do not end the session', async () => {
  const api = harness();
  let cleared = 0;
  api.subscribeSessionInvalidated(() => { cleared++; });
  api.transport(async () => { throw new Error('Synthetic transport failure'); });
  await assert.rejects(api.request('/api/v1/projects'), error => error.code === 'NETWORK');
  api.transport(async () => ({ json: async () => { throw new Error('Synthetic malformed response'); } }));
  await assert.rejects(api.request('/api/v1/projects'), error => error.code === 'NETWORK');
  api.result({ apiVersion: 2, ok: true, data: {} });
  await assert.rejects(api.request('/api/v1/projects'), error => error.code === 'NETWORK');
  for (const code of ['SCOPE_DENIED', 'OWNER_UNAVAILABLE', 'RECOVERY_REQUIRED']) {
    api.result(denied(code));
    await assert.rejects(api.request('/api/v1/projects'), error => error.code === code);
  }
  assert.equal(cleared, 0);
});

test('unsubscribe removes only its own observer and is safe to repeat', async () => {
  const api = harness();
  let removed = 0, retained = 0;
  const unsubscribe = api.subscribeSessionInvalidated(() => { removed++; });
  api.subscribeSessionInvalidated(() => { retained++; });
  unsubscribe(); unsubscribe();
  api.result(denied('UNAUTHENTICATED'));
  await assert.rejects(api.request('/api/v1/projects'), error => error.code === 'UNAUTHENTICATED');
  assert.equal(removed, 0);
  assert.equal(retained, 1);
});

test('a throwing observer cannot suppress other cleanup or replace the authentication error', async () => {
  const api = harness();
  let cleared = false;
  api.subscribeSessionInvalidated(() => { throw new Error('Synthetic observer failure'); });
  api.subscribeSessionInvalidated(() => { cleared = true; });
  api.result(denied('SESSION_EXPIRED'));
  await assert.rejects(api.request('/api/v1/projects'), error => error instanceof api.RequestError && error.code === 'SESSION_EXPIRED');
  assert.equal(cleared, true);
});

test('expiry in operation status or commit sends no retry, revoke or compensating request', async () => {
  for (const [path, method, body] of [
    ['/api/v1/operations/fixture-operation', 'GET', undefined],
    ['/api/v1/projects/fixture/physical-hierarchy/commits', 'POST', { previewId: 'synthetic-preview' }],
  ]) {
    const api = harness();
    let localSession = 'ready';
    api.subscribeSessionInvalidated(() => { localSession = 'ended'; });
    api.result(denied('SESSION_EXPIRED'));
    await assert.rejects(api.request(path, method, body), error => error.code === 'SESSION_EXPIRED');
    assert.equal(localSession, 'ended');
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].path, path);
    assert.equal(api.calls[0].options.method, method);
  }
});
