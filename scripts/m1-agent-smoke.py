"""M1 client/transport smoke on a NEW synthetic project; never uses user stores.

No model turn, remote IoT access, global Codex config edit or additional package.
All artifacts stay in an exclusive run directory under this repository's build/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE = 2 * 1024 * 1024
TOOLS = ["project_context", "project_impact"]
CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class SmokeError(Exception):
    """Only fixed, non-sensitive diagnostics cross this boundary."""


def clean_environment() -> dict[str, str]:
    result = {key: os.environ[key] for key in
              ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "PATH")
              if key in os.environ}
    result["PYTHONPATH"] = str(ROOT / "python" / "src")
    result["PYTHONNOUSERSITE"] = "1"
    return result


class Rpc:
    def __init__(self, argv: list[str], cwd: Path):
        self.messages: queue.Queue[Any] = queue.Queue(maxsize=128)
        self.process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=cwd, env=clean_environment(),
            shell=False, creationflags=CREATION_FLAGS,
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        try:
            assert self.process.stdout is not None
            while True:
                line = self.process.stdout.readline(MAX_RESPONSE + 1)
                if not line:
                    self.messages.put_nowait(SmokeError("RPC process closed."))
                    return
                if len(line) > MAX_RESPONSE:
                    raise SmokeError("RPC response exceeded the byte budget.")
                message = json.loads(line.decode("utf-8"))
                if not isinstance(message, dict):
                    raise SmokeError("Invalid RPC response.")
                self.messages.put_nowait(message)
        except (ValueError, UnicodeError, RecursionError, queue.Full, OSError, SmokeError):
            try:
                self.messages.put_nowait(SmokeError("RPC transport failed."))
            except queue.Full:
                pass

    def send(self, method: str, params: dict[str, Any],
             request_id: int | None = None, jsonrpc: bool = True) -> None:
        message: dict[str, Any] = {"method": method, "params": params}
        if jsonrpc:
            message["jsonrpc"] = "2.0"
        if request_id is not None:
            message["id"] = request_id
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message, allow_nan=False).encode() + b"\n")
        self.process.stdin.flush()

    def request(self, request_id: int, method: str,
                params: dict[str, Any], jsonrpc: bool = True) -> dict[str, Any]:
        self.send(method, params, request_id, jsonrpc)
        deadline = time.monotonic() + 30
        for _ in range(128):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SmokeError("RPC request timed out.")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise SmokeError("RPC request timed out.") from error
            if isinstance(message, Exception):
                raise message
            if "method" in message and "id" in message:
                # Reject all server-initiated approval/elicitation requests.
                assert self.process.stdin is not None
                response = {"jsonrpc": "2.0", "id": message["id"],
                            "error": {"code": -32601, "message": "Unsupported in read-only smoke."}}
                self.process.stdin.write(json.dumps(response).encode() + b"\n")
                self.process.stdin.flush()
            if message.get("id") == request_id and "method" not in message:
                if "error" in message or not isinstance(message.get("result"), dict):
                    raise SmokeError("RPC request was rejected.")
                return message["result"]
        raise SmokeError("RPC notification budget exceeded.")

    def close(self) -> None:
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if self.process.stdout:
            self.process.stdout.close()


def require(condition: bool, diagnostic: str) -> None:
    if not condition:
        raise SmokeError(diagnostic)


def payload(result: dict[str, Any]) -> dict[str, Any]:
    require(result.get("isError") is False, "Tool read failed.")
    blocks = result.get("content")
    require(isinstance(blocks, list) and len(blocks) == 1 and
            isinstance(blocks[0], dict) and blocks[0].get("type") == "text" and
            isinstance(blocks[0].get("text"), str), "Unexpected tool content.")
    value = json.loads(blocks[0]["text"])
    require(isinstance(value, dict), "Invalid tool payload.")
    return value


def run_native(binary: Path, run_dir: Path) -> tuple[list[str], dict[str, Any]]:
    database = run_dir / "synthetic-project.sqlite"
    result = subprocess.run([str(binary), "init-demo", str(database)],
                            capture_output=True, timeout=15, shell=False,
                            env=clean_environment(), creationflags=CREATION_FLAGS)
    require(result.returncode == 0, "Synthetic project could not be initialized.")
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    argv = [sys.executable, "-m", "lmti_project.mcp", "--binary", str(binary),
            "--database", str(database), "--project", "factory-monitor",
            "--site", "factory-demo", "--target", "external"]
    rpc = Rpc(argv, run_dir)
    checks: dict[str, bool] = {}
    try:
        initialized = rpc.request(1, "initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "lmti-m1-smoke", "version": "1"}})
        require(initialized.get("serverInfo", {}).get("name") == "lmti-project",
                "Unexpected MCP server identity.")
        rpc.send("notifications/initialized", {})
        listing = rpc.request(2, "tools/list", {})
        require(isinstance(listing.get("tools"), list) and all(
            isinstance(tool, dict) and isinstance(tool.get("name"), str)
            for tool in listing["tools"]), "Invalid MCP tool list.")
        names = sorted(tool["name"] for tool in listing["tools"])
        require(names == sorted(TOOLS + ["project_propose_work"]),
                "Unexpected MCP tool surface.")
        context = payload(rpc.request(3, "tools/call",
                                     {"name": "project_context", "arguments": {"limit": 100}}))
        require(context.get("schema") == "lmti.project.context.v1" and
                context.get("projectId") == "factory-monitor" and
                context.get("site") == "factory-demo" and context.get("revision") == 1,
                "Project scope or saved revision differs.")
        require(len(context["components"]) == 3 and
                {record["id"] for record in context["components"]} ==
                {"sensor-firmware", "gateway-agent", "monitor-backend"},
                "Unexpected fixture components.")
        require(bool(context["bindings"]) and all(
            record.get("observedVersion") == "unknown" for record in context["bindings"]),
            "Desired metadata was presented as observation.")
        checks["scoped_saved_read"] = True
        checks["observed_version_unknown"] = True
        impact = payload(rpc.request(4, "tools/call", {
            "name": "project_impact", "arguments": {"componentId": "sensor-firmware"}}))
        require(set(impact["affectedComponentIds"]) ==
                {"sensor-firmware", "gateway-agent", "monitor-backend"},
                "Declared dependency neighborhood differs.")
        checks["declared_neighborhood"] = True
        denied = rpc.request(5, "tools/call", {"name": "project_context",
                            "arguments": {"projectId": "other-project"}})
        require(denied.get("isError") is True, "Agent widened launcher scope.")
        checks["scope_override_denied"] = True
        missing = rpc.request(6, "tools/call", {"name": "project_impact",
                             "arguments": {"componentId": "not-visible"}})
        require(missing.get("isError") is True, "Missing identity did not fail closed.")
        checks["unavailable_identity_denied"] = True
        narrow = payload(rpc.request(7, "tools/call",
                         {"name": "project_context", "arguments": {"limit": 1}}))
        require(narrow.get("truncated") is True, "Partial context was marked complete.")
        checks["partial_context_explicit"] = True
        text = json.dumps(context)
        require(all(term not in text for term in ("locator", '"reference"', str(database))),
                "A private source locator crossed the boundary.")
        checks["private_locators_absent"] = True
        require(hashlib.sha256(database.read_bytes()).hexdigest() == before,
                "Read-only smoke mutated the project.")
        checks["project_bytes_unchanged"] = True
    finally:
        rpc.close()
    return argv, {"schema": "lmti.m1.smoke.v1", "evidence": "synthetic_transport",
                  "nativeChecks": checks, "liveIoT": False, "modelTurn": False,
                  "clientDiscovery": "not_run", "businessValue": "unmeasured"}


def run_agent_layer(argv: list[str], run_dir: Path) -> tuple[list[str], dict[str, bool]]:
    argv = list(argv)
    argv[argv.index("lmti_project.mcp")] = "lmti_agent.mcp"
    rpc = Rpc(argv, run_dir)
    checks: dict[str, bool] = {}
    try:
        initialized = rpc.request(1, "initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "lmti-m2-smoke", "version": "1"}})
        require(initialized.get("serverInfo", {}).get("name") == "lmti-agent",
                "Unexpected Agent-layer server.")
        rpc.send("notifications/initialized", {})
        names = sorted(item["name"] for item in rpc.request(2, "tools/list", {})["tools"])
        require(names == sorted(["lmti_context", "lmti_entity", "lmti_related", "lmti_observations"]),
                "Unexpected Agent tool surface.")
        seen: set[str] = set()
        cursor = None
        request_id = 3
        for _ in range(5):
            arguments: dict[str, Any] = {"limit": 2}
            if cursor is not None:
                arguments["cursor"] = cursor
            response = payload(rpc.request(request_id, "tools/call", {
                "name": "lmti_context", "arguments": arguments}))
            request_id += 1
            require(response.get("schema") == "lmti.agent.response.v1" and
                    response["scope"]["projectId"] == "factory-monitor" and
                    response["scope"]["site"] == "factory-demo" and
                    response["sources"][0]["version"]["value"] == 1,
                    "Agent envelope scope differs.")
            for row in response["data"]["entities"]:
                key = json.dumps(row["identity"], sort_keys=True)
                require(key not in seen, "Agent cursor repeated an identity.")
                seen.add(key)
            cursor = response["completeness"]["nextCursor"]
            if cursor is None:
                break
        require(cursor is None and len(seen) == 7, "Agent inventory paging incomplete.")
        checks["common_envelope_and_paging"] = True
        require(bool(response["evidence"]), "Agent provenance is absent.")
        checks["source_and_evidence"] = True
        related = payload(rpc.request(request_id, "tools/call", {
            "name": "lmti_related", "arguments": {
                "kind": "component", "entityId": "sensor-firmware", "depth": 2}}))
        request_id += 1
        require({"declared_dependency", "has_release", "deployed_to_desired"} <=
                {row["type"] for row in related["data"]["relations"]},
                "Agent relationships are incomplete.")
        require(all(row["semantics"] in ("declared", "desired") for row in related["data"]["relations"]),
                "Agent invented observed facts.")
        checks["declared_and_desired_relations"] = True
        for tool_name, arguments, error_code in (
            ("lmti_context", {"projectId": "other-project"}, "INVALID_ARGUMENT"),
            ("lmti_entity", {"kind": "component", "entityId": "not-visible"}, "UNAVAILABLE"),
            ("lmti_observations", {"assetId": "machine-a"}, "NOT_SUPPORTED"),
        ):
            result = rpc.request(request_id, "tools/call", {"name": tool_name, "arguments": arguments})
            request_id += 1
            require(result.get("isError") is True and
                    json.loads(result["content"][0]["text"])["error"]["code"] == error_code,
                    "Agent typed failure differs.")
        checks["typed_denied_and_unsupported_errors"] = True
        context = payload(rpc.request(request_id, "tools/call", {
            "name": "lmti_context", "arguments": {"limit": 100}}))
        (run_dir / "agent-context.json").write_text(json.dumps(context, indent=2) + "\n", encoding="utf-8")
        (run_dir / "agent-relations.json").write_text(json.dumps(related, indent=2) + "\n", encoding="utf-8")
    finally:
        rpc.close()
    return argv, checks

def codex_config(argv: list[str], run_dir: Path, tools: list[str] | None = None) -> tuple[str, str]:
    values = {"command": argv[0], "args": argv[1:], "cwd": str(run_dir),
              "env": {"PYTHONPATH": str(ROOT / "python" / "src"),
                      "PYTHONNOUSERSITE": "1"},
              "enabled_tools": TOOLS if tools is None else tools, "startup_timeout_sec": 15,
              "tool_timeout_sec": 15, "enabled": True}
    # JSON strings/arrays are valid TOML basic strings/arrays here. No shell interpolation.
    inline = "{ " + ", ".join(
        key + " = " + ("{ " + ", ".join(
            k + " = " + json.dumps(v) for k, v in value.items()) + " }"
            if isinstance(value, dict) else json.dumps(value))
        for key, value in values.items()) + " }"
    sample = "[mcp_servers.lmti_m1]\n" + "\n".join(
        key + " = " + ("{ " + ", ".join(
            k + " = " + json.dumps(v) for k, v in value.items()) + " }"
            if isinstance(value, dict) else json.dumps(value))
        for key, value in values.items()) + "\n"
    return "mcp_servers = { lmti_m1 = " + inline + " }", sample


def discover_codex(codex: Path, override: str, run_dir: Path, agent_layer: bool = False) -> dict[str, Any]:
    require(codex.is_absolute() and codex.is_file() and
            codex.name.lower() in ("codex.exe", "codex"), "Invalid Codex executable.")
    rpc = Rpc([str(codex), "app-server", "--stdio", "-c", override,
               "-c", "analytics.enabled=false"], run_dir)
    try:
        rpc.request(1, "initialize", {"clientInfo": {
            "name": "lmti_m1_client_probe", "version": "1"},
            "capabilities": {"experimentalApi": True}}, jsonrpc=False)
        rpc.send("initialized", {}, jsonrpc=False)
        result = rpc.request(2, "mcpServerStatus/list", {
            "serverName": "lmti_m1", "detail": "toolsAndAuthOnly", "limit": 1},
            jsonrpc=False)
        # Inspect only our known server; never persist other config/auth/tool contents.
        entries = result.get("data", [])
        require(isinstance(entries, list) and len(entries) == 1 and
                entries[0].get("name") == "lmti_m1", "Codex did not discover the configured server.")
        tools = entries[0].get("tools", {})
        require(isinstance(tools, dict) and all(isinstance(tool, dict)
                for tool in tools.values()), "Invalid Codex MCP tool list.")
        names = sorted(tool.get("name", key) for key, tool in tools.items())
        expected = ["lmti_context", "lmti_entity", "lmti_related"] if agent_layer else TOOLS
        require(names == sorted(expected), "Codex read-tool allowlist differs.")
        thread = rpc.request(3, "thread/start", {
            "cwd": str(run_dir), "ephemeral": True,
            "sandbox": "read-only", "approvalPolicy": "never"}, jsonrpc=False)
        thread_id = thread.get("thread", {}).get("id")
        require(isinstance(thread_id, str), "Codex did not initialize a client thread.")
        value = payload(rpc.request(4, "mcpServer/tool/call", {
            "threadId": thread_id, "server": "lmti_m1", "tool": "lmti_context" if agent_layer else "project_context",
            "arguments": {"limit": 100}}, jsonrpc=False))
        scope = value["scope"] if agent_layer else value
        revision = value["sources"][0]["version"]["value"] if agent_layer else value.get("revision")
        unknown = value["data"]["observations"] == [] if agent_layer else all(
            row.get("observedVersion") == "unknown" for row in value["bindings"])
        require(scope.get("projectId") == "factory-monitor" and
                scope.get("site") == "factory-demo" and revision == 1 and unknown,
                "Codex read returned unexpected source scope or semantics.")
        return {"status": "passed", "tools": names, "evidence": "codex_mcp_tool_read",
                "scopedSavedRead": True, "modelTurn": False}
    finally:
        rpc.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--codex", type=Path)
    parser.add_argument("--agent-layer", action="store_true", help="Also test the additive M2 Agent boundary")
    args = parser.parse_args()
    run_dir: Path | None = None
    try:
        binary = args.binary
        require(binary.is_absolute() and binary.is_file() and not binary.is_symlink() and
                binary.name.lower() in ("lmti-project.exe", "lmti-project"),
                "Trusted absolute project runtime is required.")
        build = (ROOT / "build").resolve()
        require(build.is_relative_to(ROOT) and not build.is_symlink(),
                "Evidence directory must remain in the workspace.")
        build.mkdir(exist_ok=True)
        run_dir = Path(tempfile.mkdtemp(prefix="m1-smoke-", dir=build))
        argv, report = run_native(binary.resolve(strict=True), run_dir)
        if args.agent_layer:
            argv, report["agentLayerChecks"] = run_agent_layer(argv, run_dir)
            report["schema"] = "lmti.m2.smoke.v1"
        tools = ["lmti_context", "lmti_entity", "lmti_related"] if args.agent_layer else None
        override, sample = codex_config(argv, run_dir, tools)
        (run_dir / "codex-mcp.example.toml").write_text(sample, encoding="utf-8")
        source_digest = hashlib.sha256((run_dir / "synthetic-project.sqlite").read_bytes()).hexdigest()
        if args.codex:
            try:
                report["clientDiscovery"] = discover_codex(
                    args.codex.resolve(strict=True), override, run_dir, args.agent_layer)
            except (SmokeError, OSError, ValueError, KeyError, TypeError, RecursionError,
                    subprocess.SubprocessError):
                report["clientDiscovery"] = {"status": "failed",
                    "reason": "Codex MCP discovery unavailable; no policy changes attempted."}
        require(hashlib.sha256((run_dir / "synthetic-project.sqlite").read_bytes()).hexdigest()
                == source_digest, "Client smoke mutated the project.")
        report["sourceBytesUnchangedAfterClient"] = True
        report["artifactDirectory"] = run_dir.name
        (run_dir / "report.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 1 if isinstance(report["clientDiscovery"], dict) and report["clientDiscovery"]["status"] == "failed" else 0
    except (SmokeError, OSError, ValueError, KeyError, TypeError, RecursionError,
            subprocess.SubprocessError):
        print(json.dumps({"schema": "lmti.m2.smoke.v1" if args.agent_layer else "lmti.m1.smoke.v1", "status": "failed",
                          "reason": "M1 smoke failed; inspect trusted paths and boundary.",
                          "artifactDirectory": run_dir.name if run_dir else None}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

