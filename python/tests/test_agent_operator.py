"""Fixed operator process: retained cursor key, bounded errors and authority separation."""
from __future__ import annotations

from contextlib import closing
from copy import deepcopy
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from lmti_agent.client import AgentError, Client
from lmti_agent.source import Entity, GraphRead, Identity
from lmti_project import Grant


class FixedSource:
    kind = "native_project"

    def __init__(self, target="external"):
        self.grant = Grant("demo", "site", target)

    def read(self):
        return GraphRead(1, "a" * 64, "2026-10-19T00:00:00Z", (
            Entity(Identity("component", "first"), "First", "public", {"componentType": "firmware"}, "component"),
            Entity(Identity("component", "second"), "Second", "public", {"componentType": "firmware"}, "component")), ())


class OperatorCursorTests(unittest.TestCase):
    def test_constructor_requires_exact_32_byte_cursor_key(self):
        for value in (b"", b"a" * 31, b"a" * 33, "a" * 32, bytearray(32), True):
            with self.assertRaises(AgentError) as error:
                Client(FixedSource(), cursor_key=value)
            self.assertEqual(error.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(Client(FixedSource(), cursor_key=secrets.token_bytes(32)).context()["status"], "ok")

    def test_same_key_retains_pagination_but_other_key_rejects_cursor(self):
        key = secrets.token_bytes(32)
        first = Client(FixedSource(), cursor_key=key).context(1)
        cursor = first["completeness"]["nextCursor"]
        following = Client(FixedSource(), cursor_key=key).context(1, cursor)
        self.assertEqual(following["status"], "ok")
        self.assertEqual(following["data"]["entities"][0]["identity"]["sourceEntityId"], "second")
        rejected = Client(FixedSource(), cursor_key=secrets.token_bytes(32)).context(1, cursor)
        self.assertEqual(rejected["error"]["code"], "STALE_CURSOR")

    def test_retained_key_does_not_allow_cursor_to_cross_source_or_model_scope(self):
        key = secrets.token_bytes(32)
        cursor = Client(FixedSource(), "first-source", cursor_key=key).context(1)["completeness"]["nextCursor"]
        for source, source_id in ((FixedSource(), "second-source"), (FixedSource("local"), "first-source")):
            result = Client(source, source_id, cursor_key=key).context(1, cursor)
            self.assertEqual(result["error"]["code"], "STALE_CURSOR")
            self.assertIsNone(result["data"])


@unittest.skipUnless(os.environ.get("LMTI_PROJECT_BINARY"), "Set LMTI_PROJECT_BINARY for real operator integration")
class OperatorProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-operator-process-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = Path(os.environ.get("LMTI_AGENT_REPO", Path(__file__).resolve().parents[2])).resolve(strict=True)
        self.script = Path(os.environ.get("LMTI_AGENT_OPERATOR_SCRIPT", self.repo / "scripts/agent-read-owner.py"))
        self.binary = Path(os.environ["LMTI_PROJECT_BINARY"]).resolve(strict=True)
        self.database = self.root / "project.sqlite"
        subprocess.run([str(self.binary), "init-demo", str(self.database)], capture_output=True, check=True, timeout=10)
        self.request = {"binary": str(self.binary), "database": str(self.database), "projectId": "factory-monitor",
                        "site": "factory-demo", "target": "external", "integrationConfig": None, "integrationSha256": None,
                        "operation": "context", "arguments": {"limit": 1}, "cursorKey": secrets.token_hex(32)}

    def run_owner(self, request=None, raw=None):
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PYTHONPATH"] = str(self.repo / "python/src")
        process = subprocess.run([sys.executable, "-B", str(self.script)],
                                 input=raw if raw is not None else json.dumps(request or self.request).encode(),
                                 capture_output=True, check=True, timeout=15, env=environment)
        self.assertEqual(process.stderr, b"")
        self.assertLessEqual(len(process.stdout), 520 * 1024)
        self.assertNotIn(str(self.database).encode(), process.stdout)
        self.assertNotIn(str(self.binary).encode(), process.stdout)
        return json.loads(process.stdout)

    def test_actual_process_page_continuation_uses_retained_key_and_no_database_writes(self):
        before = self.database.read_bytes()
        first = self.run_owner()["response"]
        cursor = first["completeness"]["nextCursor"]
        self.assertIsInstance(cursor, str)
        request = deepcopy(self.request)
        request["arguments"]["cursor"] = cursor
        following = self.run_owner(request)["response"]
        self.assertNotEqual(first["data"]["entities"][0]["identity"], following["data"]["entities"][0]["identity"])
        request["cursorKey"] = secrets.token_hex(32)
        rejected = self.run_owner(request)["response"]
        self.assertEqual(rejected["error"]["code"], "STALE_CURSOR")
        self.assertIsNone(rejected["data"])
        self.assertEqual(self.database.read_bytes(), before)

    def test_authority_fields_inside_arguments_cannot_override_trusted_launcher(self):
        before = self.database.read_bytes()
        for override in ({"projectId": "other"}, {"site": "other"}, {"target": "local"},
                         {"database": str(self.database)}, {"binary": str(self.binary)},
                         {"integrationConfig": str(self.root / "private.json")}, {"cursorKey": secrets.token_hex(32)}, {"integrationSha256": "a" * 64}):
            request = deepcopy(self.request)
            request["arguments"].update(override)
            result = self.run_owner(request)
            self.assertTrue(result["ok"])
            self.assertEqual(result["response"]["error"]["code"], "INVALID_ARGUMENT")
            self.assertIsNone(result["response"]["data"])
        self.assertEqual(self.database.read_bytes(), before)

    def test_malformed_requests_are_bounded_fixed_errors_without_paths(self):
        malformed = [b"{", b"[]", b'{"binary":"first","binary":"second"}', b'{"value":NaN}', b" " * (128 * 1024 + 1)]
        for raw in malformed:
            self.assertEqual(self.run_owner(raw=raw), {"ok": False, "code": "OWNER_UNAVAILABLE"})
        for changes in ({"extra": "not allowed"}, {"cursorKey": "bad"}, {"operation": "shell"},
                        {"arguments": []}, {"target": "owner"}, {"binary": "//untrusted.invalid/share/owner"},
                        {"database": str(self.root / "missing-private-database.sqlite")}):
            request = {**self.request, **changes}
            self.assertEqual(self.run_owner(request), {"ok": False, "code": "OWNER_UNAVAILABLE"})

    def test_source_change_invalidates_cursor_and_permission_revocation_has_empty_data(self):
        cursor = self.run_owner()["response"]["completeness"]["nextCursor"]
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("INSERT INTO knowledge(id,label,component_id,reference,fingerprint,privacy) VALUES(?,?,?,?,?,?)",
                             ("operator-ref", "Operator reference", "sensor-firmware", "fixture-location", "fixture-version", "public"))
        request = deepcopy(self.request)
        request["arguments"]["cursor"] = cursor
        self.assertEqual(self.run_owner(request)["response"]["error"]["code"], "STALE_CURSOR")
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("UPDATE project SET privacy='internal'")
        result = self.run_owner()["response"]
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        self.assertIsNone(result["data"])
        self.assertEqual(result["sources"], [])

    def test_task_context_without_opt_in_configuration_is_explicitly_unsupported(self):
        request = {**self.request, "operation": "task_context", "arguments": {"task": "firmware", "kind": "component", "entityId": "sensor-firmware"}}
        result = self.run_owner(request)
        self.assertTrue(result["ok"])
        self.assertEqual(result["response"]["error"]["code"], "NOT_SUPPORTED")
        self.assertIsNone(result["response"]["data"])


if __name__ == "__main__":
    unittest.main()
