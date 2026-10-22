import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// Resolve only the existing UI toolchain. The override supports staged source
// checks against an installed workspace; this test never installs a dependency.
const uiRoot = process.env.LMTI_WORKSPACE_TEST_UI_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const app = createRequire(join(uiRoot, 'package.json'));
const { build } = createRequire(app.resolve('vite'))('esbuild');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/WorkspaceOverview.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'empty', '.png': 'dataurl' }, external: ['react', 'react/*'],
});
const module = { exports: {} };
// Evaluate compiled local application source, never data from a project owner.
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(app, module, module.exports);
const { WorkspaceOverview } = module.exports;
const React = app('react'), { renderToStaticMarkup } = app('react-dom/server');

const project = {
  id: 'project-current', name: 'Current workspace', projectRevision: 42,
  profileRevision: 23, linkedRoot: true, capabilities: ['profile.read'],
};
const server = id => ({ id, label: id, enabled: true, transport: 'lmti_local', auth: 'none', site: 'site-fixture' });
const profile = { projectId: project.id, revision: 23, servers: [server('local-fixture')] };
const status = (client, changes = {}) => ({
  client, configuration: 'applied', appliedRevision: 23, checkedAt: '2026-10-21T00:00:00Z',
  clientUse: 'not_verified', evidenceId: null, canRestore: false, capabilities: [], ...changes,
});
const props = changes => ({
  project, profile, statuses: { codex: status('codex'), cursor: status('cursor') },
  loading: false, disabled: false, language: 'en',
  onNavigate: () => assert.fail('Rendering must not trigger navigation'), ...changes,
});
const render = changes => renderToStaticMarkup(React.createElement(WorkspaceOverview, props(changes)));
const metrics = html => [...html.matchAll(/<dd>(.*?)<\/dd>/gs)].map(match => match[1]);

function elements(node, predicate, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, predicate, result);
  } else if (React.isValidElement(node)) {
    if (predicate(node)) result.push(node);
    elements(node.props.children, predicate, result);
  }
  return result;
}

test('switching project hides counts from a profile belonging to the previous project', () => {
  const previousProfile = {
    projectId: 'project-previous', revision: 17,
    servers: [server('previous-one'), server('previous-two'), server('previous-three')],
  };
  const html = render({ profile: previousProfile });
  assert.deepEqual(metrics(html), ['42', '—', '—']);
  assert.match(html, /Current workspace/);
  assert.match(html, /Profile not loaded/);
  assert.doesNotMatch(html, /3 enabled in profile/);
  assert.deepEqual(metrics(render({ profile: null })), ['42', '—', '—']);
});

test('applied configuration is distinct from retained evidence of client use', () => {
  const html = render({ statuses: {
    codex: status('codex', { clientUse: 'verified', evidenceId: 'fixture-evidence' }),
    cursor: status('cursor'),
  } });
  assert.deepEqual(metrics(html), ['42', '1', '2 / 2']);
  assert.equal((html.match(/Current profile applied/g) ?? []).length, 2);
  assert.equal((html.match(/Client use verified/g) ?? []).length, 1);
  assert.equal((html.match(/Client use not verified/g) ?? []).length, 1);
  assert.doesNotMatch(html, /\b(online|healthy|connected|live)\b/i);

  const oldClientRevision = render({ statuses: {
    codex: status('codex'), cursor: status('cursor', { appliedRevision: 22 }),
  } });
  assert.deepEqual(metrics(oldClientRevision), ['42', '1', '1 / 2']);
  assert.match(oldClientRevision, /Configured · check revision/);
  assert.deepEqual(metrics(render({ statuses: { codex: status('codex') } })), ['42', '1', '—']);
});

test('the shared lock disables the next action and every workspace destination in EN and VI', () => {
  for (const language of ['en', 'vi']) {
    const html = render({ disabled: true, language });
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
    assert.equal(buttons.length, 5);
    assert.ok(buttons.every(button => /\bdisabled=""/.test(button)));
    assert.doesNotMatch(html, /<a\b|<form\b/);
    assert.match(html, language === 'en' ? /Overview/ : /Tổng quan/);
  }
});

test('recovery changes the primary action to Work; review-only configuration stays in Agent', () => {
  for (const [configuration, destination, label] of [
    ['recovery_required', 'work', 'Open work & review'],
    ['review_required', 'agent', 'Review Agent setup'],
  ]) {
    const navigations = [];
    const input = props({
      statuses: { codex: status('codex', { configuration }), cursor: status('cursor') },
      onNavigate: value => navigations.push(value),
    });
    const tree = WorkspaceOverview(input);
    const primary = elements(tree, node => node.type === 'button' && node.props.className === 'workspace-overview__primary');
    assert.equal(primary.length, 1);
    assert.equal(primary[0].props.disabled, false);
    assert.ok(primary[0].props.children.includes(label));
    assert.deepEqual(navigations, []);
    primary[0].props.onClick();
    assert.deepEqual(navigations, [destination]);
    const html = renderToStaticMarkup(tree);
    assert.match(html, configuration === 'recovery_required' ? /Review the pending recovery/ : /Review your client setup/);
  }
});

test('untrusted project labels remain escaped and loading suppresses setup claims', () => {
  const html = render({
    project: { ...project, name: '<img src=x onerror=alert(1)>', id: '<script>fixture</script>' },
    loading: true,
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b[^>]*src="?x\b|<script\b|Current profile applied|Client use verified/);
  assert.match(html, /aria-busy="true"/);
  assert.deepEqual(metrics(html), ['42', '—', '—']);
  assert.match(html, /class="workspace-overview__primary" disabled=""/);
});

test('connection table shows scoped profile metadata without exposing endpoints or inventing handshake state', () => {
  const remote = { id: 'remote-fixture', label: '<script>remote</script>', enabled: false,
    transport: 'remote_https', auth: 'client_oauth', endpoint: 'https://private.example.test/mcp', privateEndpoint: true };
  const html = render({ profile: { ...profile, servers: [server('local-fixture'), remote] } });
  assert.match(html, /&lt;script&gt;remote&lt;\/script&gt;/);
  assert.match(html, /Local LMTI/);
  assert.match(html, /HTTPS/);
  assert.match(html, />Disabled</);
  assert.doesNotMatch(html, /private\.example\.test|<script\b|Handshake successful/);
  assert.doesNotMatch(render({ loading: true }), /local-fixture/);
  assert.doesNotMatch(render({ profile: { ...profile, projectId: 'other-project' } }), /local-fixture/);
});
