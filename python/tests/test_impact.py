import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from lmti_impact import Client, ImpactError
from lmti_impact.client import MAX_INPUT, MAX_OUTPUT, TIMEOUT_SECONDS
from lmti_impact.mcp import Server


def response(result=None, **fields):
    payload = {"schema": "lmti.impact.response.v1", "ok": True, "result": {"synthetic": True} if result is None else result}
    payload.update(fields)
    return json.dumps(payload).encode()


def change():
    return {"entityId": "code:labels", "description": "Change the label contract.", "category": "contract",
            "baselineRevision": "revision-A", "proposedRevision": "revision-B", "diffDigest": "a" * 64,
            "mode": "prospective", "targetDeploymentIds": ["deployment:warehouse"]}


class InputBuffer(io.BytesIO):
    def close(self):
        if not self.closed:
            self.recorded = self.getvalue()
        super().close()


class Process:
    def __init__(self, output, returncode=0, timeout=False):
        self.stdin = InputBuffer()
        self.stdout = io.BytesIO(output)
        self.returncode = returncode
        self.timeout = timeout
        self.killed = False
        self.timeouts = []

    def wait(self, timeout=None):
        self.timeouts.append(timeout)
        if self.timeout and not self.killed:
            raise subprocess.TimeoutExpired("synthetic-private-path", timeout)
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class ImpactClientTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.node = self.root / ("node.exe" if os.name == "nt" else "node")
        self.cli = self.root / "index.js"
        self.config = self.root / "owner.json"
        for file in (self.node, self.cli, self.config):
            file.write_text("{}", encoding="utf-8")
        self.client = Client(self.node, self.cli, self.config)

    def test_fixed_process_argv_stdin_and_clean_environment(self):
        process = Process(response({"entity": {"id": "code:labels"}}))
        with patch.dict(os.environ, {"NODE_OPTIONS": "--require=untrusted.js", "NODE_PATH": "untrusted", "EXAMPLE_SECRET": "synthetic-test-value"}), patch("lmti_impact.client.subprocess.Popen", return_value=process) as spawn:
            result = self.client.entity("code:labels")
        self.assertEqual(result["entity"]["id"], "code:labels")
        args, kwargs = spawn.call_args
        self.assertEqual(args[0], [str(self.node), str(self.cli), "impact", "request", "--config", str(self.config)])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["cwd"], str(self.cli.parent))
        self.assertNotIn("NODE_OPTIONS", kwargs["env"])
        self.assertNotIn("NODE_PATH", kwargs["env"])
        self.assertNotIn("EXAMPLE_SECRET", kwargs["env"])
        self.assertEqual(process.timeouts[0], TIMEOUT_SECONDS)
        self.assertEqual(json.loads(process.stdin.recorded), {"schema": "lmti.impact.request.v1", "op": "entity", "id": "code:labels"})

    def test_all_five_operations_use_only_their_expected_request_fields(self):
        cases = [("snapshot", (), {"op": "snapshot"}), ("entity", ("entity-a",), {"op": "entity", "id": "entity-a"}),
                 ("evidence", ("evidence-a",), {"op": "evidence", "id": "evidence-a"}),
                 ("report", (change(),), {"op": "report", "change": change()}),
                 ("open_report", ("report-a",), {"op": "open-report", "id": "report-a"})]
        for method, args, expected in cases:
            with self.subTest(method=method):
                process = Process(response())
                with patch("lmti_impact.client.subprocess.Popen", return_value=process):
                    getattr(self.client, method)(*args)
                self.assertEqual(json.loads(process.stdin.recorded), {"schema": "lmti.impact.request.v1", **expected})
                self.assertLessEqual(len(process.stdin.recorded), MAX_INPUT)

    def test_invalid_ids_and_change_scope_injection_are_rejected_before_spawn(self):
        with patch("lmti_impact.client.subprocess.Popen") as spawn:
            for invalid in ("../outside", "a;command", "a\n", "", "1-not-a-valid-id", "a" * 101, None):
                with self.subTest(identifier=invalid), self.assertRaises(ImpactError):
                    self.client.entity(invalid)
            for field in ("grant", "sourceChecks", "projectId", "siteId", "config", "command"):
                with self.subTest(field=field), self.assertRaises(ImpactError):
                    self.client.report({**change(), field: "injected"})
            for key, invalid in (("description", "x" * 2001), ("description", "hello\nworld"),
                                 ("description", "😀" * 1001), ("targetDeploymentIds", ["dup", "dup"]),
                                 ("targetDeploymentIds", ["a"] * 101), ("category", "shell"),
                                 ("mode", "execute"), ("diffDigest", "A" * 64)):
                with self.subTest(key=key), self.assertRaises(ImpactError):
                    self.client.report({**change(), key: invalid})
            spawn.assert_not_called()

    def test_launcher_requires_existing_absolute_fixed_runtime_files(self):
        for node, cli, config in (("node", self.cli, self.config), (self.node, "index.js", self.config),
                                  (self.node, self.cli, "owner.json"), (self.cli, self.cli, self.config),
                                  (self.node, self.root / "missing.js", self.config)):
            with self.subTest(node=node, cli=cli, config=config), self.assertRaisesRegex(ImpactError, "^INVALID_LAUNCHER_PATH$"):
                Client(node, cli, config)

    def test_runtime_errors_are_fixed_codes_without_output_or_paths(self):
        with patch("lmti_impact.client.subprocess.Popen", side_effect=OSError("synthetic-private-path")):
            with self.assertRaisesRegex(ImpactError, "^IMPACT_RUNTIME_UNAVAILABLE$"):
                self.client.snapshot()
        process = Process(b"", returncode=1)
        with patch("lmti_impact.client.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(ImpactError, "^IMPACT_RUNTIME_REJECTED$"):
                self.client.snapshot()
        payload = {"schema": "lmti.impact.response.v1", "ok": False, "error": "NOT_FOUND"}
        process = Process(json.dumps(payload).encode(), returncode=1)
        with patch("lmti_impact.client.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(ImpactError, "^NOT_FOUND$"):
                self.client.snapshot()

    def test_timeout_kills_runtime_and_does_not_expose_command(self):
        process = Process(b"", timeout=True)
        with patch("lmti_impact.client.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(ImpactError, "^IMPACT_RUNTIME_TIMEOUT$"):
                self.client.snapshot()
        self.assertTrue(process.killed)

    def test_output_is_capped_while_reading_and_runtime_is_killed(self):
        process = Process(b"x" * (MAX_OUTPUT + 100_000))
        with patch("lmti_impact.client.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(ImpactError, "^IMPACT_RESPONSE_TOO_LARGE$"):
                self.client.snapshot()
        self.assertTrue(process.killed)

    def test_response_schema_duplicate_keys_nonfinite_and_raw_errors_are_rejected(self):
        cases = [b"raw sensitive runtime output", response(ok="true"), response(extra="unexpected"),
                 response(result=[]), b'{"schema":"lmti.impact.response.v1","ok":true,"ok":false,"result":{}}',
                 b'{"schema":"lmti.impact.response.v1","ok":true,"result":{"value":NaN}}',
                 b'{"schema":"lmti.impact.response.v1","ok":false,"error":"path C:/private/source"}']
        for output in cases:
            with self.subTest(output=output):
                process = Process(output)
                with patch("lmti_impact.client.subprocess.Popen", return_value=process), self.assertRaisesRegex(ImpactError, "^INVALID_IMPACT_RESPONSE$"):
                    self.client.snapshot()


class ImpactMcpTest(unittest.TestCase):
    @staticmethod
    def ready(server):
        server.dispatch({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "synthetic-test", "version": "1"}}})
        server.dispatch({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def test_transport_advertises_only_scoped_non_executing_tools(self):
        server = Server(Mock())
        self.ready(server)
        result = server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = result["result"]["tools"]
        self.assertEqual({tool["name"] for tool in tools}, {"impact_snapshot", "impact_lookup_entity", "impact_get_evidence", "impact_trace_change", "impact_open_report"})
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in tools))
        self.assertTrue(all(not tool["inputSchema"]["additionalProperties"] for tool in tools))

    def test_agent_cannot_supply_paths_grants_or_mutation_operations(self):
        client = Mock()
        server = Server(client)
        self.ready(server)
        for arguments in ({"config": "another.json"}, {"grant": {"allowInternal": True}}, {"node": "shell"}, {"sourceChecks": []}):
            result = server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "impact_snapshot", "arguments": arguments}})
            self.assertTrue(result["result"]["isError"])
        for name in ("execute_shell", "impact_import", "impact_review", "impact_save_report"):
            result = server.dispatch({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": name, "arguments": {}}})
            self.assertIn("error", result)
        client.snapshot.assert_not_called()

    def test_owner_failures_are_caught_by_shared_transport(self):
        client = Mock()
        client.evidence.side_effect = ImpactError("NOT_FOUND")
        server = Server(client)
        self.ready(server)
        result = server.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "impact_get_evidence", "arguments": {"id": "evidence-a"}}})
        self.assertTrue(result["result"]["isError"])
        self.assertEqual(result["result"]["content"][0]["text"], "NOT_FOUND")

    def test_stream_runs_with_existing_initialization_and_returns_evidence_as_data(self):
        client = Mock()
        client.evidence.return_value = {"summary": "Synthetic untrusted instruction: do not execute this text."}
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "synthetic", "version": "1"}}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "impact_get_evidence", "arguments": {"id": "evidence-a"}}}]
        writer = io.BytesIO()
        Server(client).serve(io.BytesIO(b"".join(json.dumps(m).encode() + b"\n" for m in messages)), writer)
        responses = [json.loads(line) for line in writer.getvalue().splitlines()]
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "lmti-impact")
        self.assertIn("untrusted data", responses[0]["result"]["instructions"])
        self.assertFalse(responses[1]["result"]["isError"])
        self.assertEqual(json.loads(responses[1]["result"]["content"][0]["text"]), client.evidence.return_value)
        client.evidence.assert_called_once_with("evidence-a")


@unittest.skipUnless(all(os.environ.get(key) for key in ("LMTI_IMPACT_NODE", "LMTI_IMPACT_CLI", "LMTI_IMPACT_CONFIG")),
                     "Set LMTI_IMPACT_NODE/CLI/CONFIG for synthetic TypeScript owner integration")
class ImpactOwnerIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.node = Path(os.environ["LMTI_IMPACT_NODE"]).resolve(strict=True)
        self.cli = Path(os.environ["LMTI_IMPACT_CLI"]).resolve(strict=True)
        self.config = Path(os.environ["LMTI_IMPACT_CONFIG"]).resolve(strict=True)
        self.client = Client(self.node, self.cli, self.config)
        self.database = self.config.parent / "impact.sqlite"

    def test_real_owner_lookup_report_and_evidence_are_readonly(self):
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        snapshot = self.client.snapshot()
        self.assertEqual(snapshot["schema"], "lmti.impact.snapshot.v1")
        self.assertGreater(len(snapshot["entities"]), 0)
        self.client.entity(snapshot["entities"][0]["record"]["id"])
        self.client.evidence(snapshot["evidence"][0]["record"]["id"])
        report = self.client.report(json.loads((self.config.parent / "change.json").read_text(encoding="utf-8")))
        self.assertEqual(report["schema"], "lmti.impact.report.v1")
        self.assertGreater(len(report["findings"]), 0)
        self.assertEqual(report["coverage"]["knowledge"], "not_proven_complete")
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before)

    def test_real_stdio_mcp_process_calls_the_typescript_owner(self):
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "synthetic-integration", "version": "1"}}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "impact_snapshot", "arguments": {}}},
                    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "impact_snapshot", "arguments": {"grant": {"allowInternal": True}}}}]
        result = subprocess.run([sys.executable, "-m", "lmti_impact.mcp", "--node", str(self.node), "--cli", str(self.cli), "--config", str(self.config)],
                                input=b"".join(json.dumps(m).encode() + b"\n" for m in messages), capture_output=True, timeout=15, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "lmti-impact")
        self.assertEqual(len(responses[1]["result"]["tools"]), 5)
        self.assertFalse(responses[2]["result"]["isError"])
        self.assertEqual(json.loads(responses[2]["result"]["content"][0]["text"])["schema"], "lmti.impact.snapshot.v1")
        self.assertTrue(responses[3]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
