import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// Uses the existing workspace toolchain, with no dependency installation. The
// override only permits checking staged files against an installed UI workspace.
const uiRoot = process.env.LMTI_STRUCTURE_TEST_UI_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const app = createRequire(join(uiRoot, 'package.json'));
const { build } = createRequire(app.resolve('vite'))('esbuild');
async function load(name) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/${name}.tsx`, import.meta.url))], bundle: true,
    write: false, format: 'cjs', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl' }, external: ['react', 'react/*'] });
  const module = { exports: {} };
  // This is compiled local application source, not an owner-supplied expression.
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(app, module, module.exports);
  return module.exports;
}
const { checkedStructureResponse, visibleObservationState, StructureView, prepareTaskText, EvidenceInspector } = await load('StructureView');
const { checkedProposalInspection, checkedProposalPreview, proposalFailureMode } = await load('ProposalReview');
const React = app('react'), { renderToStaticMarkup } = app('react-dom/server');
const clone = value => structuredClone(value);
const envelope = {
  schema: 'lmti.agent.response.v1', operation: 'project.context', status: 'ok',
  scope: { projectId: 'project-a', site: 'site-a', modelTarget: 'external' },
  sources: [{ sourceId: 'native-project', kind: 'native_project', version: { type: 'owner_revision', value: 1 }, checkedAt: '2026-10-19T00:00:00Z', freshness: { state: 'checked' } }],
  evidence: [], completeness: { state: 'complete', reasons: [], nextCursor: null },
  data: { entities: [], relations: [], observations: [] }, unknowns: [], conflicts: [], error: null,
};
const inspection = { projectId: 'project-a', projectRevision: 4, topologyRevision: 4,
  asset: { id: 'machine-a', label: 'Machine A', site: 'site-a', kind: 'machine', privacy: 'public', desired: { enabled: true, pollMs: 1000 }, observed: { status: 'unknown', at: null } } };
const proposal = { schema: 'lmti.topology.proposal.v1', baseRevision: 4, assetId: 'machine-a', site: 'site-a', expected: { enabled: true, pollMs: 1000 }, desired: { enabled: false, pollMs: 2000 } };
const preview = { id: 'preview-fixture-a', projectId: 'project-a', expectedProjectRevision: 4, topologyRevision: 4, proposal, diff: { expected: proposal.expected, desired: proposal.desired }, expiresAt: '2026-10-19T00:02:00Z', deviceActions: false };

test('accepts bounded native read and rejects a response for a different operation', () => {
  assert.equal(checkedStructureResponse(envelope, 'context').sources[0].version.value, 1);
  assert.throws(() => checkedStructureResponse(envelope, 'observations'), { code: 'INVALID_SOURCE_RESPONSE' });
});
test('typed owner errors discard source message and preserve safe code', () => {
  assert.throws(() => checkedStructureResponse({ ...envelope, status: 'error', error: { code: 'UNAVAILABLE', message: 'private path' } }, 'context'), error => error.code === 'UNAVAILABLE' && !error.message.includes('private'));
});
test('malformed source metadata and missing scope fail before rendering', () => {
  for (const bad of [{ ...envelope, scope: null }, { ...envelope, sources: [{ ...envelope.sources[0], freshness: { state: 'pretend_live' } }] }, { ...envelope, data: { ...envelope.data, entities: [{ label: 'broken' }] } }])
    assert.throws(() => checkedStructureResponse(bad, 'context'), { code: 'INVALID_SOURCE_RESPONSE' });
});
test('inactive observation source permits no accessible version and explicit partial', () => {
  const read = clone(envelope); read.operation = 'project.observations'; read.status = 'partial'; read.sources = [{ ...read.sources[0], sourceId: 'replay-a', kind: 'controlled_replay', version: null, freshness: { state: 'revoked' } }]; read.unknowns = [{ code: 'OBSERVATION_SOURCE_REVOKED' }];
  assert.equal(checkedStructureResponse(read, 'observations').sources[0].freshness.state, 'revoked');
});
test('memory retains original internal classification and owner-safe disclosure', () => {
  const read = clone(envelope); read.operation = 'project.task_context';
  read.data.contextItems = [{ id: 'memory-a', kind: 'memory', title: 'Safe lesson', summary: 'A scoped summary.', semantics: 'reviewed_memory', classification: 'internal', disclosure: 'owner_safe_summary', evidenceId: 'proof-a', referenceId: 'component-a' }];
  assert.equal(checkedStructureResponse(read, 'task_context').data.contextItems[0].classification, 'internal');
  delete read.data.contextItems[0].disclosure;
  assert.throws(() => checkedStructureResponse(read, 'task_context'), { code: 'INVALID_SOURCE_RESPONSE' });
});
test('invalid measurement objects cannot become React children', () => {
  const read = clone(envelope); read.operation = 'project.observations'; read.data.observations = [{ value: { raw: 'unexpected' } }];
  assert.throws(() => checkedStructureResponse(read, 'observations'), { code: 'INVALID_SOURCE_RESPONSE' });
});
test('fresh measurements expire while a view stays open', () => {
  const row = { freshness: { state: 'fresh', ageSeconds: 20 }, ttlSeconds: 30 };
  assert.equal(visibleObservationState(row, 10), 'fresh');
  assert.equal(visibleObservationState(row, 10.1), 'stale');
  assert.equal(visibleObservationState(row, -5), 'fresh');
});
test('invalid and revoked samples never improve as time elapses', () => {
  for (const state of ['invalid', 'revoked', 'unavailable', 'stale']) assert.equal(visibleObservationState({ freshness: { state, ageSeconds: 0 }, ttlSeconds: 1 }, 100), state);
});
test('unknown quality becomes stale after its freshness window', () => {
  assert.equal(visibleObservationState({ freshness: { state: 'unknown', ageSeconds: 1 }, ttlSeconds: 10 }, 0), 'unknown');
  assert.equal(visibleObservationState({ freshness: { state: 'unknown', ageSeconds: 1 }, ttlSeconds: 10 }, 10), 'stale');
});
test('initial structure view has accessible inventory and translated selection hint', () => {
  const request = async () => { throw new Error('SSR must not call owners'); };
  const en = renderToStaticMarkup(React.createElement(StructureView, { project: 'project-a', language: 'en', request }));
  const vi = renderToStaticMarkup(React.createElement(StructureView, { project: 'project-a', language: 'vi', request }));
  assert.match(en, /Select an entity/); assert.match(en, /Filter this page/); assert.match(vi, /Chọn một đối tượng/); assert.match(vi, /Lọc trang hiện tại/);
});
test('proposal inspection is bound to selected project, asset and valid poll bounds', () => {
  assert.equal(checkedProposalInspection(inspection, 'machine-a', 'project-a').asset.desired.pollMs, 1000);
  assert.throws(() => checkedProposalInspection(inspection, 'machine-b', 'project-a'));
  assert.throws(() => checkedProposalInspection(inspection, 'machine-a', 'project-b'));
  const bad = clone(inspection); bad.asset.desired.pollMs = 99;
  assert.throws(() => checkedProposalInspection(bad, 'machine-a', 'project-a'));
});

test('pending failed owner acknowledgement stays unknown and requires recovery', () => {
  for (const code of ['OWNER_UNAVAILABLE', 'NETWORK', 'INTERNAL', 'INVALID_SOURCE_RESPONSE', ''])
    assert.equal(proposalFailureMode(code), 'unknown');
  for (const code of ['REVISION_CONFLICT', 'CONFIG_CHANGED', 'PREVIEW_EXPIRED', 'SCOPE_DENIED', 'INVALID_INPUT'])
    assert.equal(proposalFailureMode(code), 'conflict');
});
test('review binds both revisions, project, site and exact expected/desired values', () => {
  assert.equal(checkedProposalPreview(preview, inspection, proposal).id, preview.id);
  for (const mutate of [p => p.projectId = 'other-project', p => p.expectedProjectRevision = 5, p => p.topologyRevision = 5, p => p.proposal.site = 'other-site', p => p.proposal.assetId = 'machine-b', p => p.proposal.expected.pollMs = 500, p => p.proposal.desired.enabled = true, p => p.diff.desired.pollMs = 3000]) {
    const bad = clone(preview); mutate(bad); assert.throws(() => checkedProposalPreview(bad, inspection, proposal));
  }
});
test('proposal response claiming device action is refused', () => {
  assert.throws(() => checkedProposalPreview({ ...preview, deviceActions: true }, inspection, proposal));
});

test('knowledge workspace has translated read workflow without a configuration action', () => {
  const request = async () => { throw new Error('SSR must not call owners'); };
  const en = renderToStaticMarkup(React.createElement(StructureView, { project: 'project-a', language: 'en', request, mode: 'knowledge' }));
  const vi = renderToStaticMarkup(React.createElement(StructureView, { project: 'project-a', language: 'vi', request, mode: 'knowledge' }));
  assert.match(en, /Explore by entity/); assert.match(en, /Describe your task/); assert.match(en, /Check the evidence/);
  assert.match(en, /A reference alone does not mean its content is connected/);
  assert.match(vi, /Tra cứu theo đối tượng/); assert.match(vi, /Đối chiếu bằng chứng/);
  assert.doesNotMatch(en, /Desired settings|Read observations|proposals\/previews/);
  assert.doesNotMatch(en, /<a[^>]*href=/);
});

test('knowledge without a project requests project selection and performs no owner read', () => {
  const request = async () => { throw new Error('SSR must not call owners'); };
  for (const language of ['en', 'vi']) {
    const markup = renderToStaticMarkup(React.createElement(StructureView, { project: '', language, request, mode: 'knowledge' }));
    assert.match(markup, language === 'en' ? /Choose a project to browse its knowledge/ : /Chọn dự án để xem tri thức/);
    assert.doesNotMatch(markup, /<form|<input|<button/);
  }
});

test('task input enforces UTF-8 bytes and preserves explicit one-line normalization', () => {
  assert.deepEqual(prepareTaskText('  đọc\r\nngữ cảnh\nnguồn  '), { task: 'đọc ngữ cảnh nguồn', bytes: new TextEncoder().encode('đọc ngữ cảnh nguồn').length, valid: true });
  assert.equal(prepareTaskText('a'.repeat(1000)).valid, true);
  assert.equal(prepareTaskText('a'.repeat(1001)).valid, false);
  assert.equal(prepareTaskText('ấ'.repeat(333)).bytes, 999);
  assert.equal(prepareTaskText('ấ'.repeat(333)).valid, true);
  assert.equal(prepareTaskText('ấ'.repeat(334)).bytes, 1002);
  assert.equal(prepareTaskText('ấ'.repeat(334)).valid, false);
  for (const input of ['', ' \n\r\n ', '\ttask', 'task\t', 'a\u0000b', 'a\u007fb']) assert.equal(prepareTaskText(input).valid, false, JSON.stringify(input));
});

test('evidence inspector keeps disclosure, revisions and partial limits without rendering unvalidated source metadata', () => {
  const read = clone(envelope);
  read.status = 'partial';
  read.completeness.reasons = ['MEMORY_SOURCE_NOT_CONNECTED'];
  read.sources[0].authority = { privateLocator: 'private-path-must-not-render' };
  read.evidence = [{ evidenceId: 'proof-a', sourceId: 'native-project', sourceRevision: 7, reference: { kind: 'component', sourceEntityId: '<img src=x onerror=alert(1)>' }, basis: 'owner_safe_summary' }];
  read.data.contextItems = [{ id: 'summary-a', kind: 'memory', title: 'Safe title', summary: 'Scoped summary', classification: 'internal', disclosure: 'owner_safe_summary', evidenceId: 'proof-a', referenceId: 'component-a', semantics: 'reviewed_memory' }];
  const html = renderToStaticMarkup(React.createElement(EvidenceInspector, { result: read, evidenceId: 'proof-a', t: en => en, formatDate: value => value, sourceState: () => 'stale', onClose() {} }));
  for (const label of ['Evidence &amp; source', 'Referenced revision', 'Internal', 'Owner-approved safe summary', 'Stale', 'MEMORY_SOURCE_NOT_CONNECTED']) assert.ok(html.includes(label), label);
  assert.match(html, /<dialog[^>]*aria-labelledby=/);
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /private-path-must-not-render|<img src=x|<a href/);
});
