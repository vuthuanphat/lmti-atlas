"""Legacy readers share the bounded pipe reader, including on hostile output."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from lmti_project import Client as ProjectClient, Grant as ProjectGrant, ProjectError
from lmti_topology import Client as TopologyClient, Grant as TopologyGrant, TopologyError


class OutputStream:
    def __init__(self, child, payload=None):
        self.child = child
        self.payload = payload
        self.bytes_read = 0
        self.closed = False

    def read(self, size):
        if self.payload is None:  # Unbounded hostile producer, allocated one requested chunk at a time.
            self.bytes_read += size
            return b'x' * size
        data = self.payload[self.bytes_read:self.bytes_read + size]
        self.bytes_read += len(data)
        if not data:
            self.child.returncode = 0
            self.child.finished.set()
        return data

    def close(self):
        self.closed = True


class Owner:
    def __init__(self, payload=None):
        self.returncode = None
        self.finished = threading.Event()
        self.stdout = OutputStream(self, payload)
        self.kills = 0

    def wait(self, timeout=None):
        if not self.finished.wait(timeout):
            raise subprocess.TimeoutExpired('controlled-owner', timeout)
        return self.returncode

    def kill(self):
        self.kills += 1
        self.returncode = -9
        self.finished.set()

    def poll(self):
        return self.returncode


class LegacyProcessBoundsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / 'fixture.db'
        self.database.write_bytes(b'fixture-only')

    def client(self, kind):
        binary = self.root / ('lmti-' + kind + ('.exe' if os.name == 'nt' else ''))
        binary.write_bytes(b'never executed')
        return (ProjectClient(binary, self.database, ProjectGrant('fixture', 'site')) if kind == 'project'
                else TopologyClient(binary, self.database, TopologyGrant('site')))

    def payload(self, kind):
        if kind == 'topology':
            return {'schema': 'lmti.topology.context.v1', 'revision': 1, 'truncated': False,
                    'assets': [], 'links': []}
        return {'schema': 'lmti.project.context.v1', 'projectId': 'fixture', 'site': 'site',
                'revision': 1, 'truncated': False,
                **{key: [] for key in ('repositories', 'components', 'targets', 'releases', 'assets',
                                       'bindings', 'dependencies', 'milestones', 'work', 'verification', 'knowledge')}}

    def test_overflow_stops_reading_at_budget_and_reaps_child(self):
        for kind, error in (('project', ProjectError), ('topology', TopologyError)):
            with self.subTest(kind=kind):
                client, child = self.client(kind), Owner()
                with patch('lmti_common.process.subprocess.Popen', return_value=child), self.assertRaises(error) as caught:
                    client.context()
                self.assertEqual(child.stdout.bytes_read, 2 * 1024 * 1024 + 1)
                self.assertEqual(child.kills, 1)
                self.assertIsNotNone(child.poll())
                self.assertTrue(child.stdout.closed)
                self.assertNotIn(str(self.root), str(caught.exception))

    def test_valid_payload_and_sanitized_child_environment(self):
        for kind in ('project', 'topology'):
            with self.subTest(kind=kind):
                client, payload = self.client(kind), self.payload(kind)
                child = Owner(json.dumps(payload).encode())
                with patch.dict(os.environ, {'EXAMPLE_SECRET': 'fixture-only', 'PYTHONPATH': 'untrusted'}), \
                        patch('lmti_common.process.subprocess.Popen', return_value=child) as spawn:
                    self.assertEqual(client.context(), payload)
                options = spawn.call_args.kwargs
                self.assertFalse(options['shell'])
                self.assertEqual(options['stdin'], subprocess.DEVNULL)
                self.assertEqual(options['stderr'], subprocess.DEVNULL)
                self.assertEqual(options['cwd'], str(self.root))
                self.assertNotIn('EXAMPLE_SECRET', options['env'])
                self.assertNotIn('PYTHONPATH', options['env'])
                self.assertEqual(child.kills, 0)

    def test_project_retains_accepted_owner_lifetime_capability(self):
        client = self.client('project')
        client._retain_until_closed = True
        payload = self.payload('project')
        with patch('lmti_project.client.read_owner', return_value=json.dumps(payload).encode()) as read:
            self.assertEqual(client.context(), payload)
        self.assertTrue(read.call_args.kwargs['retain_until_closed'])
