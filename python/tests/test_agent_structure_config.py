"""Trusted v2 capability, pinned bytes, session isolation and transport defaults."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from lmti_agent.client import KINDS, ALL_KINDS, RELATION_TYPES, ALL_RELATION_TYPES
from lmti_agent.integration_config import load_integrated_client, load_integrated_native_client
from lmti_agent.integrated import IntegratedClient
from lmti_agent.integrated_mcp import IntegratedServer
from lmti_agent.mcp import Server
from lmti_agent.operator_read import execute
from lmti_project import Grant
from test_agent_structure import Source as StructuredSource
from test_agent_layer import Source as LegacySource


class StructureConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lmti-structure-config-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'integration.json'
        self.source = StructuredSource()
        self.data = {'schema': 'lmti.agent.integration.v2', 'structure': True,
                     'projectId': 'project', 'site': 'factory', 'target': 'external',
                     'knowledge': None, 'observations': None}
        self.write()

    def write(self, value=None):
        self.path.write_text(json.dumps(self.data if value is None else value), encoding='utf-8')

    def factory(self, **kwargs):
        return load_integrated_native_client('unused-binary', 'unused-database', self.source.grant,
                                             'native-project', self.path, **kwargs)

    def test_v2_constructs_native_capability_once_after_pin_and_scope(self):
        pin = hashlib.sha256(self.path.read_bytes()).hexdigest()
        from lmti_agent.integration_config import _raw
        with patch('lmti_agent.integration_config.NativeProjectSource', return_value=self.source) as owner, \
                patch('lmti_agent.integration_config._raw', wraps=_raw) as reads:
            client = self.factory(expected_config_sha256=pin)
            self.assertEqual(reads.call_count, 1)
            owner.assert_called_once_with('unused-binary', 'unused-database', self.source.grant,
                                          include_references=True, include_structure=True)
        self.assertTrue(client.include_structure)
        self.assertEqual(client.entity('site', 'factory')['status'], 'ok')

    def test_v1_factory_keeps_legacy_capability(self):
        source = LegacySource()
        self.data.update(schema='lmti.agent.integration.v1', projectId=source.grant.project_id, site=source.grant.site)
        del self.data['structure']
        self.write()
        with patch('lmti_agent.integration_config.NativeProjectSource', return_value=source) as owner:
            client = load_integrated_native_client('binary', 'database', source.grant, 'native-project', self.path)
        self.assertIs(client.include_structure, False)
        self.assertIs(owner.call_args.kwargs['include_structure'], False)
        self.assertEqual(client.entity('site', 'factory')['error']['code'], 'INVALID_ARGUMENT')

    def test_invalid_capabilities_fail_before_native_construction(self):
        values = []
        for invalid in (False, None, 0, 1, 'true'):
            values.append({**self.data, 'structure': invalid})
        values += [{k: v for k, v in self.data.items() if k != 'structure'},
                   {**self.data, 'schema': 'lmti.agent.integration.v1'},
                   {**self.data, 'schema': 'lmti.agent.integration.v3'},
                   {**self.data, 'extra': True}]
        for value in values:
            with self.subTest(value=value):
                self.write(value)
                with patch('lmti_agent.integration_config.NativeProjectSource') as owner:
                    with self.assertRaises(ValueError): self.factory()
                    owner.assert_not_called()

    def test_changed_pin_and_scope_fail_before_native_construction(self):
        with patch('lmti_agent.integration_config.NativeProjectSource') as owner:
            with self.assertRaises(ValueError): self.factory(expected_config_sha256='0' * 64)
            self.write({**self.data, 'site': 'elsewhere'})
            with self.assertRaises(ValueError): self.factory()
            owner.assert_not_called()

    def test_prebuilt_source_requires_exact_matching_boolean_capability(self):
        for capability in (False, 1, None):
            self.source.include_structure = capability
            with self.assertRaises(ValueError):
                load_integrated_client(self.source, 'native-project', self.path)
        self.source.include_structure = True
        self.data['schema'] = 'lmti.agent.integration.v1'
        del self.data['structure']
        self.write()
        with self.assertRaises(ValueError): load_integrated_client(self.source, 'native-project', self.path)

    def test_detected_capability_change_permanently_revokes_existing_session(self):
        original = self.path.read_bytes()
        client = load_integrated_client(self.source, 'native-project', self.path)
        self.assertEqual(client.context()['status'], 'ok')
        legacy = {k: v for k, v in self.data.items() if k != 'structure'}
        legacy['schema'] = 'lmti.agent.integration.v1'
        self.write(legacy)
        self.assertEqual(client.context()['error']['code'], 'UNAVAILABLE')
        self.path.write_bytes(original)
        self.assertEqual(client.context()['error']['code'], 'UNAVAILABLE')
        fresh = load_integrated_client(self.source, 'native-project', self.path)
        self.assertEqual(fresh.context()['status'], 'ok')

    def test_mcp_schema_expansion_is_per_session_and_preserves_five_tools(self):
        original = deepcopy(IntegratedServer.tools)
        expanded = IntegratedServer(IntegratedClient(self.source))
        legacy = IntegratedServer(IntegratedClient(LegacySource()))
        self.assertEqual(IntegratedServer.tools, original)
        self.assertEqual(legacy.tools, original)
        self.assertEqual(len(expanded.tools), 5)
        self.assertEqual(len(Server.tools), 4)
        for definition in expanded.tools:
            props = definition['inputSchema']['properties']
            if 'kind' in props: self.assertEqual(props['kind']['enum'], list(ALL_KINDS))
            if 'relationTypes' in props:
                self.assertEqual(props['relationTypes']['items']['enum'], list(ALL_RELATION_TYPES))
                self.assertEqual(props['relationTypes']['maxItems'], len(ALL_RELATION_TYPES))
        for definition in legacy.tools:
            props = definition['inputSchema']['properties']
            if 'kind' in props: self.assertEqual(props['kind']['enum'], list(KINDS))
            if 'relationTypes' in props: self.assertEqual(props['relationTypes']['items']['enum'], list(RELATION_TYPES))
        self.assertEqual(expanded.call_tool('lmti_entity', {'kind': 'site', 'entityId': 'factory'})['status'], 'ok')
        self.assertEqual(legacy.call_tool('lmti_entity', {'kind': 'site', 'entityId': 'factory'})['error']['code'], 'INVALID_ARGUMENT')

    def test_request_cannot_set_capability_or_select_another_scope(self):
        server = IntegratedServer(IntegratedClient(self.source))
        for field, value in (('structure', True), ('site', 'elsewhere'), ('target', 'local')):
            result = server.call_tool('lmti_entity', {'kind': 'site', 'entityId': 'factory', field: value})
            self.assertEqual(result['error']['code'], 'INVALID_ARGUMENT')

    def test_operator_uses_same_config_factory_without_browser_capability_argument(self):
        client = IntegratedClient(self.source)
        base = str(self.path.parent)
        request = {'binary': str(Path(base) / 'lmti-project.exe'), 'database': str(Path(base) / 'project.sqlite'),
                   'projectId': 'project', 'site': 'factory', 'target': 'external', 'integrationConfig': str(self.path),
                   'integrationSha256': hashlib.sha256(self.path.read_bytes()).hexdigest(),
                   'operation': 'entity', 'arguments': {'kind': 'site', 'entityId': 'factory'}, 'cursorKey': 'a' * 64}
        with patch('lmti_agent.operator_read.load_integrated_native_client', return_value=client) as factory:
            self.assertEqual(execute(request)['response']['status'], 'ok')
            self.assertEqual(factory.call_args.args[2], self.source.grant)
            self.assertEqual(factory.call_args.args[4], str(self.path))
            self.assertEqual(factory.call_args.kwargs['expected_config_sha256'], request['integrationSha256'])
        request['structure'] = True
        with self.assertRaises(ValueError): execute(request)

    def test_operator_rejects_missing_malformed_or_unpaired_pin_before_owner_construction(self):
        base = self.path.parent
        request = {'binary': str(base / 'lmti-project.exe'), 'database': str(base / 'project.sqlite'),
                   'projectId': 'project', 'site': 'factory', 'target': 'external', 'integrationConfig': str(self.path),
                   'integrationSha256': None, 'operation': 'context', 'arguments': {}, 'cursorKey': 'a' * 64}
        changes = [{'integrationSha256': pin} for pin in (None, '', 1, 'A' * 64, 'g' * 64)]
        changes.append({'integrationConfig': None, 'integrationSha256': 'a' * 64})
        with patch('lmti_agent.operator_read.load_integrated_native_client') as factory:
            for change in changes:
                with self.subTest(change=change), self.assertRaises(ValueError):
                    execute({**request, **change})
            missing = dict(request); del missing['integrationSha256']
            with self.assertRaises(ValueError): execute(missing)
            factory.assert_not_called()

    def test_broker_pin_blocks_changed_child_config_even_before_parent_recheck(self):
        # Parent reviewed A; child sees B. A later restoration cannot make this
        # child's initial read valid, regardless of the parent's final check.
        original = self.path.read_bytes()
        expected = hashlib.sha256(original).hexdigest()
        self.write({**self.data, 'knowledge': {'unexpected': 'changed'}})
        base = self.path.parent
        request = {'binary': str(base / 'lmti-project.exe'), 'database': str(base / 'project.sqlite'),
                   'projectId': 'project', 'site': 'factory', 'target': 'external', 'integrationConfig': str(self.path),
                   'integrationSha256': expected, 'operation': 'context', 'arguments': {}, 'cursorKey': 'a' * 64}
        with patch('lmti_agent.integration_config.NativeProjectSource') as owner:
            with self.assertRaises(ValueError): execute(request)
            owner.assert_not_called()
        self.path.write_bytes(original)


if __name__ == '__main__':
    unittest.main()
