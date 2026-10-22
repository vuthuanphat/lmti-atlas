import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConnectionDraft } from '../src/connection-editor.ts';
import { translate } from '../src/i18n.ts';

// Pure UI checks: no native process, owner store, network or dependency install.
const local = { kind: 'local', label: 'Fixture connection', key: 'fixture_key-1', site: 'site-fixture', endpoint: '', enabled: true };
const remote = { ...local, kind: 'remote', endpoint: 'https://example.com/mcp' };
const result = (changes = {}, draft = local) => validateConnectionDraft({ ...draft, ...changes });
const invalid = (changes, field, draft = local) => {
  const answer = result(changes, draft);
  assert.equal(answer.ok, false);
  assert.equal(answer.field, field);
  assert.equal('server' in answer, false, 'Invalid input must not produce a submission DTO');
  return answer;
};

test('connection labels accept the full 120-byte owner boundary in ASCII, Vietnamese and astral Unicode', () => {
  for (const label of ['a'.repeat(120), 'ấ'.repeat(40), '😀'.repeat(30)]) {
    const answer = result({ label });
    assert.equal(answer.ok, true);
    assert.equal(answer.server.label, label, 'Accepted labels must never be truncated');
  }
  for (const label of ['a'.repeat(121), 'ấ'.repeat(41), '😀'.repeat(30) + 'a']) invalid({ label }, 'label');
});

test('local site byte validation rejects over-boundary multibyte input without checking project authority', () => {
  for (const site of ['s'.repeat(64), 'ấ'.repeat(21) + 'a']) assert.equal(result({ site }).ok, true);
  for (const site of ['s'.repeat(65), 'ấ'.repeat(22), '']) invalid({ site }, 'site');
});

test('remote endpoint byte limit is 512, not 2048 UTF-16 code units', () => {
  const prefix = 'https://example.com/';
  const endpoint = prefix + 'a'.repeat(512 - prefix.length);
  assert.equal(result({ endpoint }, remote).ok, true);
  invalid({ endpoint: endpoint + 'a' }, 'endpoint', remote);
  const vietnameseEndpoint = prefix + 'ấ'.repeat(164);
  assert.equal(new TextEncoder().encode(vietnameseEndpoint).length, 512);
  assert.equal(result({ endpoint: vietnameseEndpoint }, remote).ok, true);
  invalid({ endpoint: vietnameseEndpoint + 'a' }, 'endpoint', remote);
});

test('control characters are refused before trim and malformed Unicode is never replaced silently', () => {
  for (const control of ['\u0000', '\t', '\n', '\r', '\u007f', '\u0085']) {
    invalid({ label: control + 'Name' }, 'label');
    invalid({ key: 'fixture' + control }, 'key');
    invalid({ site: control + 'site' }, 'site');
    invalid({ endpoint: remote.endpoint + control }, 'endpoint', remote);
  }
  invalid({ label: 'Name\ud800' }, 'label');
  invalid({ site: 'site\udfff' }, 'site');
  invalid({ endpoint: remote.endpoint + '\ud800' }, 'endpoint', remote);
});

test('ordinary outer spaces keep existing trim behavior; empty labels and sites stay invalid', () => {
  const answer = result({ label: '  Connection  ', key: ' fixture_key-1 ', site: ' site-fixture ' });
  assert.deepEqual(answer, { ok: true, server: { id: local.key, label: 'Connection', enabled: true, transport: 'lmti_local', auth: 'none', site: local.site } });
  invalid({ label: '   ' }, 'label');
  invalid({ site: '   ' }, 'site');
  assert.equal(result({ endpoint: '  https://example.com/mcp  ' }, remote).server.endpoint, remote.endpoint);
});

test('stable server keys keep their existing allowed alphabet and length', () => {
  for (const key of ['a', 'fixture_key-1', 'a'.repeat(48)]) assert.equal(result({ key }).ok, true);
  for (const key of ['1fixture', 'Fixture', 'fixture.key', 'tên', 'a'.repeat(49), '']) invalid({ key }, 'key');
});

test('HTTPS policy continues rejecting credentials, query, fragment and forbidden raw URL characters', () => {
  for (const endpoint of ['http://example.com/mcp', 'https://user@example.com/mcp', 'https://user:fake@example.com/mcp', 'https://example.com/mcp?q=1', 'https://example.com/mcp#part', 'https://example.com/mcp?', 'https://example.com/mcp#', 'https://example.com/a b', 'https://example.com/a\\b', 'https://example.com/<mcp>']) invalid({ endpoint }, 'endpoint', remote);
  for (const kind of ['remote', 'cloudflare', 'private']) {
    const answer = result({ kind }, remote);
    assert.equal(answer.ok, true);
    assert.equal(answer.server.privateEndpoint, kind === 'private');
    assert.equal(answer.server.auth, 'client_oauth');
    assert.equal('site' in answer.server, false);
  }
});

test('field-specific errors and byte-limit hints have English and Vietnamese text', () => {
  const messages = [invalid({ label: '' }, 'label').message, invalid({ key: '' }, 'key').message,
    invalid({ site: '' }, 'site').message, invalid({ endpoint: '' }, 'endpoint', remote).message,
    invalid({ endpoint: 'http://example.com' }, 'endpoint', remote).message,
    'Maximum 120 UTF-8 bytes. Vietnamese characters may use more than one byte.',
    'Maximum 64 UTF-8 bytes. The site must already exist in the project topology.',
    'Maximum 512 UTF-8 bytes. Use HTTPS without credentials, query parameters or fragments.'];
  for (const message of messages) {
    assert.equal(translate('en', message), message);
    assert.notEqual(translate('vi', message), message);
  }
});
