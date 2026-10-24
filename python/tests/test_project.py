import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing

from lmti_project import Client, Grant, ProjectError
from lmti_project.mcp import Server

class ProjectBoundaryTest(unittest.TestCase):
    def test_grants_and_fixed_tool_arguments(self):
        for project, site, target in (("../bad", "site", "external"), ("good", "bad site", "external"), ("good", "site", "cloud")):
            with self.assertRaises(ProjectError):
                Grant(project, site, target)
        server = Server(None)
        for name, arguments in (("project_context", {"projectId": "other"}), ("project_impact", {"componentId": "a", "site": "other"}), ("project_propose_work", {"workId": "a", "desiredState": "review", "database": "other"})):
            with self.assertRaises(ProjectError):
                server.call_tool(name, arguments)

@unittest.skipUnless(os.environ.get("LMTI_PROJECT_BINARY"), "Set LMTI_PROJECT_BINARY for project integration")
class ProjectIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(os.environ["LMTI_PROJECT_BINARY"]).resolve(strict=True)
        self.database = Path(self.temp.name) / "project.sqlite"
        subprocess.run([str(self.binary), "init-demo", str(self.database)], capture_output=True, check=True)
        self.client = Client(self.binary, self.database, Grant("factory-monitor", "factory-demo"))

    def test_context_impact_and_proposal_do_not_write(self):
        original = self.database.read_bytes()
        context = self.client.context()
        self.assertEqual(len(context["components"]), 3)
        self.assertEqual(context["bindings"][0]["observedVersion"], "unknown")
        self.assertNotIn("locator", json.dumps(context))
        impact = self.client.impact("sensor-firmware")
        self.assertEqual(set(impact["affectedComponentIds"]), {"sensor-firmware", "gateway-agent", "monitor-backend"})
        proposal = self.client.propose_work("validate-sampling", "review")
        self.assertEqual(proposal["revision"], 1)
        self.assertEqual(proposal["expectedState"], "todo")
        self.assertEqual(self.database.read_bytes(), original)
        with self.assertRaises(ProjectError):
            self.client.propose_work("validate-sampling", "done")

    def test_scope_parent_privacy_bounds_and_invalid_storage(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE repositories SET privacy='internal' WHERE id='repo-sensor'")
            db.execute("UPDATE assets SET site='other-site' WHERE id='gateway-b'")
        context = self.client.context()
        self.assertEqual(context["bindings"], [])
        self.assertEqual(context["work"], [])
        with self.assertRaises(ProjectError):
            self.client.impact("sensor-firmware")
        wrong = Client(self.binary, self.database, Grant("other-project", "factory-demo"))
        with self.assertRaises(ProjectError):
            wrong.context()
        local = Client(self.binary, self.database, Grant("factory-monitor", "factory-demo", "local"))
        self.assertTrue(local.context(1)["truncated"])
        for limit in (0, 201, True, "1"):
            with self.assertRaises(ProjectError):
                self.client.context(limit)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE project SET goal=?", ("password=" + "fake-test-only-value",))
        with self.assertRaises(ProjectError):
            self.client.context()

    def test_real_project_mcp_process(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "integration", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "project_context", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "project_propose_work", "arguments": {"workId": "validate-sampling", "desiredState": "review"}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "project_context", "arguments": {"projectId": "other"}}},
        ]
        original = self.database.read_bytes()
        result = subprocess.run([sys.executable, "-m", "lmti_project.mcp", "--binary", str(self.binary), "--database", str(self.database), "--project", "factory-monitor", "--site", "factory-demo"], input=b"".join(json.dumps(m).encode() + b"\n" for m in messages), capture_output=True, timeout=15, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "lmti-project")
        self.assertEqual(len(responses[1]["result"]["tools"]), 3)
        self.assertFalse(responses[2]["result"]["isError"])
        self.assertFalse(responses[3]["result"]["isError"])
        self.assertTrue(responses[4]["result"]["isError"])
        self.assertEqual(original, self.database.read_bytes())
