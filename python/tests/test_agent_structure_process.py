"""Read-only v3 SDK/MCP proof using native typed fixture exports.

Set LMTI_PROJECT_BINARY, LMTI_STRUCTURE_FIXTURE_DIR and
LMTI_STRUCTURE_INTEGRATION_CONFIG to explicit local test inputs. Produce the
three SQLite fixtures with lmti-project-structure-snapshot-tests --emit-fixtures;
this test never opens SQLite or writes domain data. The integration config is a
v2 structure:true file with the fixture scope and null knowledge/observations.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest

import lmti_agent
from lmti_agent import Client, Grant, NativeProjectSource
from lmti_agent.integrated import IntegratedClient
from lmti_agent.knowledge import _local_path
from lmti_project import Client as ProjectClient, ProjectError


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identities(response):
    return {(row['identity']['kind'], row['identity']['sourceEntityId'])
            for row in response['data']['entities']}


def read_process(argv, messages, environment):
    """Bounded read-only subprocess: fixed input, capped drains, deadline/reap."""
    request = b''.join(json.dumps(item).encode() + b'\n' for item in messages)
    if len(request) > 2048:
        raise AssertionError('Test request budget exceeded')
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment, shell=False,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()

    def collect(index, stream, limit):
        try:
            while chunk := stream.read1(65536):
                if len(outputs[index]) + len(chunk) > limit:
                    overflow.set()
                    process.kill()
                    return
                outputs[index].extend(chunk)
        finally:
            stream.close()

    readers = [threading.Thread(target=collect, args=(0, process.stdout, 2 * 1024 * 1024), daemon=True),
               threading.Thread(target=collect, args=(1, process.stderr, 65536), daemon=True)]
    for reader in readers:
        reader.start()
    try:
        try:
            process.stdin.write(request)
            process.stdin.close()
        except BrokenPipeError:
            pass
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()  # These commands can only read existing native fixtures.
        process.wait(timeout=2)
        raise AssertionError('Read-only process exceeded deadline') from None
    finally:
        if not process.stdin.closed:
            process.stdin.close()
        for reader in readers:
            reader.join(timeout=2)
    if overflow.is_set() or any(reader.is_alive() for reader in readers):
        raise AssertionError('Read-only process exceeded output budget')
    return process.returncode, bytes(outputs[0]), bytes(outputs[1])


@unittest.skipUnless(all(os.environ.get(key) for key in
    ('LMTI_PROJECT_BINARY', 'LMTI_STRUCTURE_FIXTURE_DIR', 'LMTI_STRUCTURE_INTEGRATION_CONFIG')),
    'Explicit native v3 runtime, typed fixtures and trusted v2 config are required')
class NativeStructureProcessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = _local_path(os.environ['LMTI_PROJECT_BINARY'])
        cls.fixture_root = _local_path(os.environ['LMTI_STRUCTURE_FIXTURE_DIR'])
        cls.config = _local_path(os.environ['LMTI_STRUCTURE_INTEGRATION_CONFIG'])
        cls.databases = {name: _local_path(cls.fixture_root / (name + '.sqlite'))
                         for name in ('structure', 'internal', 'flat')}
        if (not cls.binary.is_file() or not cls.config.is_file() or
                any(path.stat().st_size > 64 * 1024 * 1024 for path in cls.databases.values()) or
                cls.config.stat().st_size > 65536):
            raise AssertionError('Invalid bounded test inputs')
        settings = json.loads(cls.config.read_bytes())
        if settings != {'schema': 'lmti.agent.integration.v2', 'projectId': 'factory-monitor',
                        'site': 'factory-demo', 'target': 'external', 'knowledge': None,
                        'observations': None, 'structure': True}:
            raise AssertionError('Unexpected synthetic test capability')
        cls.module_root = _local_path(Path(lmti_agent.__file__).parent.parent)
        cls.protected = [cls.binary, cls.config, *cls.databases.values()]
        cls.initial = {path: digest(path) for path in cls.protected}
        cls.members = sorted(path.name for path in cls.fixture_root.iterdir())

    def tearDown(self):
        self.assertEqual({path: digest(path) for path in self.protected}, self.initial,
                         'A read modified a protected test input')
        self.assertEqual(sorted(path.name for path in self.fixture_root.iterdir()), self.members,
                         'A read created a fixture sidecar')

    def source(self, database='structure', site='factory-demo', target='external', structure=True):
        return NativeProjectSource(self.binary, self.databases[database],
                                   Grant('factory-monitor', site, target), include_structure=structure)

    def project(self, database='structure', site='factory-demo', target='external'):
        return ProjectClient(self.binary, self.databases[database], Grant('factory-monitor', site, target))

    def assert_safe(self, value):
        encoded = json.dumps(value)
        for forbidden in ('private-repository-location', 'private-document-location',
                          'private-overview-location', 'declared-revision', 'storage_lineage',
                          'store_uuid', 'identity_registry', str(self.fixture_root), str(self.binary)):
            self.assertNotIn(forbidden, encoded)

    def test_native_v3_roundtrip_and_stable_graph_evidence(self):
        snapshot = self.project().snapshot(include_structure=True)
        self.assertEqual(snapshot['schema'], 'lmti.project.snapshot.v3')
        self.assertIs(snapshot['structureDeclared'], True)
        self.assertEqual(len(snapshot['assets']), 5)
        self.assertEqual(len(snapshot['components']), 3)
        self.assertEqual([row['id'] for row in snapshot['environments']], ['test'])
        self.assert_safe(snapshot)
        source = self.source()
        first, second = source.read(), source.read()
        self.assertEqual(first.fingerprint, second.fingerprint)
        self.assertIs(first.structure_declared, True)
        result = Client(source).context(limit=200)
        self.assertEqual(result['status'], 'ok')
        self.assertTrue({('subsystem', 'sensors'), ('site', 'factory-demo'), ('area', 'cell'),
                         ('environment', 'test'), ('knowledge', 'design')} <= identities(result))
        evidence = {row['evidenceId'] for row in result['evidence']}
        self.assertTrue(all(set(row['evidenceIds']) <= evidence for row in result['data']['entities']))
        self.assert_safe(result)

    def test_inherited_privacy_is_filtered_or_preserved_by_target(self):
        external = Client(self.source('internal')).context(limit=200)
        local = Client(self.source('internal', target='local')).context(limit=200)
        self.assertEqual(external['status'], 'ok')
        self.assertEqual(local['status'], 'ok')
        for kind, key in (('subsystem', 'control'), ('subsystem', 'sensors'),
                          ('component', 'sensor-firmware'), ('knowledge', 'design'), ('release', 'sensor-v020')):
            self.assertNotIn((kind, key), identities(external))
            rows = [row for row in local['data']['entities'] if
                    (row['identity']['kind'], row['identity']['sourceEntityId']) == (kind, key)]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['classification'], 'internal')
        self.assertIn(('component', 'gateway-agent'), identities(external))
        self.assert_safe(external)
        self.assert_safe(local)

    def test_unknown_and_denied_sites_are_symmetric_and_wrong_project_denied(self):
        unknown = self.project(site='unknown-site').snapshot(include_structure=True)
        denied = self.project(site='denied-site').snapshot(include_structure=True)
        unknown.pop('site'); denied.pop('site')
        self.assertEqual(unknown, denied)
        for group in ('sites', 'areas', 'environments', 'assets', 'bindings', 'connections'):
            self.assertEqual(unknown[group], [])
        self.assertTrue(unknown['components'])
        result = Client(self.source(site='denied-site')).entity('site', 'denied-site')
        self.assertEqual(result['error']['code'], 'UNAVAILABLE')
        wrong = ProjectClient(self.binary, self.databases['structure'], Grant('other-project', 'factory-demo'))
        with self.assertRaises(ProjectError):
            wrong.snapshot(include_structure=True)

    def test_flat_opt_in_and_legacy_defaults_are_distinct(self):
        value = self.project('flat').snapshot(include_structure=True)
        self.assertIs(value['structureDeclared'], False)
        for group in ('subsystems', 'sites', 'areas', 'environments'):
            self.assertEqual(value[group], [])
        source = self.source('flat')
        self.assertIs(source.read().structure_declared, False)
        self.assertEqual(Client(source).entity('site', 'factory-demo')['error']['code'], 'UNAVAILABLE')
        legacy = self.source('flat', structure=False)
        self.assertIsNone(legacy.read().structure_declared)
        self.assertEqual(Client(legacy).context()['status'], 'ok')
        self.assertEqual(Client(legacy).entity('site', 'factory-demo')['error']['code'], 'INVALID_ARGUMENT')
        self.assertEqual(self.project('flat').snapshot()['schema'], 'lmti.project.snapshot.v1')
        self.assertEqual(self.project('flat').snapshot(True)['schema'], 'lmti.project.snapshot.v2')
        for references in (False, True):
            with self.assertRaises(ProjectError):
                self.project().snapshot(references)

    def test_task_context_adds_ancestors_without_unrelated_site_assets(self):
        client = IntegratedClient(self.source())
        result = client.task_context('declared device context', 'asset', 'machine-a', 1)
        self.assertEqual(result['status'], 'partial')  # No content owner configured.
        self.assertIn('KNOWLEDGE_SOURCE_NOT_CONFIGURED', result['completeness']['reasons'])
        self.assertTrue({('asset', 'gateway-b'), ('asset', 'broker-c'), ('area', 'cell'),
                         ('area', 'floor'), ('site', 'factory-demo'), ('environment', 'test')} <= identities(result))
        self.assertNotIn(('asset', 'root-device'), identities(result))
        self.assertNotIn(('asset', 'unknown-device'), identities(result))
        direct = client.task_context('explicit site children', 'site', 'factory-demo', 1)
        self.assertIn(('asset', 'root-device'), identities(direct))
        self.assertNotIn(('asset', 'machine-a'), identities(direct))
        self.assertNotIn(('asset', 'unknown-device'), identities(direct))
        environment = client.task_context('environment membership', 'environment', 'test', 1)
        self.assertIn(('asset', 'machine-a'), identities(environment))
        self.assertNotIn(('asset', 'root-device'), identities(environment))
        self.assert_safe(result)

    def test_cursors_are_stable_and_bound_to_capability_and_target(self):
        key = bytes(range(32))
        client = Client(self.source(), cursor_key=key)
        first = client.context(limit=3)
        token = first['completeness']['nextCursor']
        resumed = Client(self.source(), cursor_key=key).context(limit=3, cursor=token)
        self.assertNotEqual(resumed['status'], 'error')
        self.assertFalse(identities(first) & identities(resumed))
        denied = Client(self.source(target='local'), cursor_key=key).context(limit=3, cursor=token)
        self.assertEqual(denied['error']['code'], 'STALE_CURSOR')
        flat = Client(self.source('flat'), cursor_key=key).context(limit=3)
        legacy = Client(self.source('flat', structure=False), cursor_key=key)
        self.assertEqual(legacy.context(limit=3, cursor=flat['completeness']['nextCursor'])['error']['code'], 'STALE_CURSOR')

    def test_mcp_pinned_v2_adds_structure_and_keeps_legacy_discovery(self):
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18',
             'capabilities': {}, 'clientInfo': {'name': 'typed-structure-proof', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'lmti_task_context',
             'arguments': {'task': 'declared structure', 'kind': 'area', 'entityId': 'cell', 'depth': 3}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'lmti_task_context',
             'arguments': {'task': 'declared structure', 'kind': 'area', 'entityId': 'cell', 'sourceRoot': 'denied'}}},
        ]
        argv = [sys.executable, '-B', '-m', 'lmti_agent.mcp', '--binary', str(self.binary),
                '--database', str(self.databases['structure']), '--project', 'factory-monitor', '--site', 'factory-demo']
        environment = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'TMP', 'TEMP') if key in os.environ}
        environment.update(PYTHONPATH=str(self.module_root), PYTHONDONTWRITEBYTECODE='1')
        extra = ['--integration-config', str(self.config), '--integration-sha256', digest(self.config)]
        code, output, errors = read_process(argv + extra, messages, environment)
        self.assertEqual(code, 0, 'Configured MCP process failed')
        self.assertEqual(errors, b'')
        result = {row['id']: row for row in map(json.loads, output.splitlines())}
        tools = result[2]['result']['tools']
        self.assertEqual(len(tools), 5)
        entity = next(tool for tool in tools if tool['name'] == 'lmti_entity')
        self.assertIn('area', entity['inputSchema']['properties']['kind']['enum'])
        context = result[3]['result']['structuredContent']
        self.assertFalse(result[3]['result']['isError'])
        self.assertIn(('asset', 'machine-a'), identities(context))
        self.assertEqual(result[4]['result']['structuredContent']['error']['code'], 'INVALID_ARGUMENT')
        self.assert_safe(result)
        code, output, errors = read_process(argv, messages[:3], environment)
        self.assertEqual(code, 0)
        self.assertEqual(errors, b'')
        legacy = json.loads(output.splitlines()[-1])['result']['tools']
        self.assertEqual(len(legacy), 4)
        entity = next(tool for tool in legacy if tool['name'] == 'lmti_entity')
        self.assertNotIn('area', entity['inputSchema']['properties']['kind']['enum'])
        code, output, errors = read_process(argv + extra[:-1] + ['0' * 64], [], environment)
        self.assertEqual(code, 1)
        self.assertEqual(output, b'')
        self.assertLess(len(errors), 256)
        self.assertNotIn(str(self.config).encode(), errors)


if __name__ == '__main__':
    unittest.main()
