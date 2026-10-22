"""Fixture setup uses SQLite directly; production Agents use only the SDK."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing

from lmti_topology import Client, Grant, TopologyError

@unittest.skipUnless(os.environ.get("LMTI_TOPOLOGY_BINARY"), "Set LMTI_TOPOLOGY_BINARY for native integration tests")
class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "topology.sqlite"
        self.binary = Path(os.environ["LMTI_TOPOLOGY_BINARY"]).resolve(strict=True)
        subprocess.run([str(self.binary), "init-demo", str(self.database)], check=True, capture_output=True)
        self.client = Client(self.binary, self.database, Grant("factory-demo"))

    def test_read_and_propose_without_writing(self):
        context = self.client.context()
        self.assertEqual(len(context["assets"]), 3)
        self.assertEqual(len(context["links"]), 2)
        self.assertTrue(all(a["observed"] == {"status": "unknown", "at": 0} for a in context["assets"]))
        original = self.database.read_bytes()
        proposal = self.client.propose_config("machine-a", 2000, False)
        self.assertEqual(proposal["baseRevision"], 1)
        self.assertEqual(proposal["expected"], {"enabled": True, "pollMs": 1000})
        self.assertEqual(proposal["desired"], {"enabled": False, "pollMs": 2000})
        self.assertEqual(original, self.database.read_bytes())

    def test_privacy_site_and_bounds(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE assets SET privacy='internal' WHERE id='gateway-b'")
            db.execute("UPDATE assets SET site='other-site' WHERE id='broker-c'")
        context = self.client.context()
        self.assertEqual([a["id"] for a in context["assets"]], ["machine-a"])
        self.assertEqual(context["links"], [])
        for asset_id in ("gateway-b", "broker-c", "missing"):
            with self.assertRaises(TopologyError):
                self.client.asset_context(asset_id)
        local = Client(self.binary, self.database, Grant("factory-demo", "local"))
        self.assertEqual(len(local.context()["assets"]), 2)
        self.assertTrue(local.context(1)["truncated"])
        for value in (0, 201, True, "1"):
            with self.assertRaises(TopologyError):
                local.context(value)

    def test_thousand_devices_lookup_and_unicode(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executemany("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)", [(f"device-{i:04d}", "Máy tự động", "factory-demo", "machine", "public", 1, 1000, "unknown", 0, i, 0) for i in range(1000)])
        started = time.monotonic()
        context = self.client.context(100)
        elapsed = time.monotonic() - started
        self.assertTrue(context["truncated"])
        self.assertEqual(len(context["assets"]), 100)
        self.assertEqual(self.client.asset_context("device-0999")["assets"][0]["label"], "Máy tự động")
        self.assertEqual(self.client.propose_config("device-0999", 2000, True)["assetId"], "device-0999")
        self.assertLess(elapsed, 10)

    def test_malformed_storage_and_proposal_input(self):
        for interval in (0, True, 3_600_001, "1000"):
            with self.assertRaises(TopologyError):
                self.client.propose_config("machine-a", interval, True)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE assets SET label=? WHERE id='machine-a'", ("token=" + "fake-value-test-only",))
        with self.assertRaises(TopologyError):
            self.client.context()

    def test_real_mcp_process(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "integration", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "topology_context", "arguments": {"limit": 100}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "topology_propose_config", "arguments": {"assetId": "machine-a", "pollMs": 2000, "enabled": True}}},
        ]
        result = subprocess.run([sys.executable, "-m", "lmti_topology.mcp", "--binary", str(self.binary), "--database", str(self.database), "--site", "factory-demo"], input=b"".join(json.dumps(m).encode() + b"\n" for m in messages), capture_output=True, timeout=15, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(responses), 4)
        self.assertEqual(len(responses[1]["result"]["tools"]), 3)
        self.assertFalse(responses[2]["result"]["isError"])
        proposal = json.loads(responses[3]["result"]["content"][0]["text"])
        self.assertEqual(proposal["schema"], "lmti.topology.proposal.v1")

if __name__ == "__main__":
    unittest.main()
