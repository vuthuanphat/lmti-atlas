"""Verify native-generated configs on synthetic data; no global client edits/model turn."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("m1_smoke", ROOT / "scripts/m1-agent-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
LEGACY_TOOLS = ["lmti_context", "lmti_entity", "lmti_observations", "lmti_related"]
PHASE = "configuration"


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            result.update(block)
    return result.hexdigest()


def verify_generated(config, directory: Path, package: Path | None, integration: Path | None) -> dict:
    """Check the exact exported argv without editing it before client startup."""
    smoke.require(isinstance(config, dict) and set(config) == {"command", "args"}, "Unexpected client configuration.")
    argv = config["args"]
    smoke.require(isinstance(argv, list) and all(isinstance(value, str) for value in argv), "Invalid exported arguments.")
    smoke.require(Path(config["command"]).resolve(strict=True) == Path(sys.executable).resolve(strict=True),
                  "Exported interpreter differs from the trusted runtime.")
    smoke.require(len(argv) >= 12 and argv[0] == "-I", "The generated launcher must use isolated Python.")
    entry = Path(argv[1]).resolve(strict=True)
    binary = Path(argv[3]).resolve(strict=True)
    if package is not None:
        smoke.require(entry == (package / "share/lmti/scripts/lmti-agent-mcp.py").resolve(strict=True) and
                      binary == (package / "bin/lmti-project.exe").resolve(strict=True),
                      "Generated runtime does not belong to the selected package.")
    expected = ["-I", argv[1], "--binary", argv[3], "--database", argv[5], "--project", "factory-monitor",
                "--site", "factory-demo", "--target", "external"]
    smoke.require(Path(argv[5]).resolve(strict=True) == directory / "synthetic-project.sqlite",
                  "Exported database differs from the disposable fixture.")
    if integration is not None:
        smoke.require(package is not None and integration == directory / "integration.json",
                      "Integrated smoke requires its packaged disposable fixture.")
        smoke.require(len(argv) == 16 and Path(argv[13]).resolve(strict=True) == integration,
                      "Exported integration path differs from the disposable fixture.")
        # Native Qt emits forward slashes on Windows. Compare canonical identity
        # while preserving the verified exported spelling passed to the client.
        expected += ["--integration-config", argv[13], "--integration-sha256", digest(integration)]
    smoke.require(argv == expected, "Exported arguments or integration fingerprint differ.")
    return {"isolatedPython": True, "exactExportedArguments": True, "packagedWrapper": package is not None,
            "wrapperSha256": digest(entry), "integrationPinned": integration is not None}


def verify_scope(result, operation: str) -> None:
    smoke.require(result.get("schema") == "lmti.agent.response.v1" and result.get("operation") == operation and
                  result.get("status") in ("ok", "partial") and result.get("error") is None,
                  "Unexpected Agent response.")
    scope = result["scope"]
    smoke.require(scope.get("projectId") == "factory-monitor" and scope.get("site") == "factory-demo" and
                  scope.get("modelTarget") == "external", "Client scope differs from the generated profile.")
    sources = {row["sourceId"]: row for row in result["sources"]}
    smoke.require(len(sources) == len(result["sources"]) and bool(sources), "Invalid source evidence.")
    for row in result["evidence"]:
        source = sources.get(row["sourceId"])
        smoke.require(source is not None and row["sourceRevision"] == source["version"]["value"],
                      "Evidence is not bound to the returned source revision.")
    native = [row for row in sources.values() if row["version"]["type"] == "owner_revision" and
              row["authority"] == "declared_structure"]
    smoke.require(len(native) == 1 and native[0]["version"]["value"] == 1, "Unexpected fixture native revision.")


def verify_integrated(context, observations, directory: Path) -> dict:
    verify_scope(context, "project.task_context")
    verify_scope(observations, "project.observations")
    items = context["data"]["contextItems"]
    smoke.require(context["status"] == "ok" and {row["kind"] for row in items} == {"code", "document", "memory"},
                  "Integrated context is incomplete.")
    reviewed = [row for row in items if row["semantics"] == "reviewed_memory"]
    smoke.require(bool(reviewed) and all(row["classification"] == "internal" and
                  row["disclosure"] == "owner_safe_summary" for row in reviewed), "Reviewed memory disclosure differs.")
    smoke.require(context["scope"].get("knowledgeDisclosure") == "owner_safe_summary" and
                  context["scope"]["classification"] == "internal", "Original memory classification was lost.")
    evidence = {row["evidenceId"]: row for row in context["evidence"]}
    for row in items:
        smoke.require(row["evidenceId"] in evidence and evidence[row["evidenceId"]]["sourceId"].startswith(row["sourcePart"] + "-"),
                      "Context item lacks matching owner evidence.")
    encoded = json.dumps([context, observations], ensure_ascii=False).replace("\\\\", "\\").lower()
    for forbidden in (str(directory), str(directory).replace("\\", "/"), "PrivateOnlyMarker", "ForbiddenOnlyMarker",
                      "PendingOnlyMarker", "return 1000"):
        smoke.require(forbidden.lower() not in encoded, "Response included a prohibited fixture field.")
    rows = observations["data"]["observations"]
    smoke.require(len(rows) == 3 and {row["metric"] for row in rows} == {"temperature", "firmware_version", "pressure"},
                  "Unexpected observation sample set.")
    expected = {"temperature": (24.5, "C", "fresh"), "firmware_version": ("0.2.0", "", "fresh"),
                "pressure": (2.1, "bar", "stale")}
    proof = {row["evidenceId"]: row for row in observations["evidence"]}
    for row in rows:
        smoke.require((row["value"], row["unit"], row["freshness"]["state"]) == expected[row["metric"]] and
                      (row["projectId"], row["site"], row["assetId"], row["deviceId"]) ==
                      ("factory-monitor", "factory-demo", "machine-a", "sensor-a"), "Observation identity or freshness differs.")
        smoke.require(bool(row["sampleAt"]) and bool(row["receivedAt"]) and len(row["evidenceIds"]) == 1 and
                      proof[row["evidenceIds"][0]]["basis"] == "controlled_replay", "Missing replay time or evidence.")
    replay = [source for source in observations["sources"] if source["kind"] == "controlled_replay"]
    smoke.require(len(replay) == 1 and replay[0]["version"]["type"] == "replay_revision" and
                  replay[0]["freshness"]["state"] == "stale" and observations["status"] == "partial" and
                  "OBSERVATION_LIMITATIONS" in observations["completeness"]["reasons"], "Replay limitations were not disclosed.")
    return {"contextKinds": sorted({row["kind"] for row in items}), "reviewedMemory": True,
            "originalClassificationPreserved": True, "ownerEvidence": True,
            "observations": {"sourceKind": "controlled_replay", "sampleCount": 3,
                             "freshness": ["fresh", "stale"], "status": "partial"}, "liveProvider": False}


def main():
    global PHASE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--package", type=Path)
    parser.add_argument("--integration-config", type=Path)
    args = parser.parse_args()
    directory = args.evidence.resolve(strict=True)
    smoke.require(directory.is_relative_to(ROOT / "build"), "Evidence must stay inside build/.")
    package = args.package.resolve(strict=True) if args.package else None
    integration = args.integration_config.resolve(strict=True) if args.integration_config else None
    generated = tomllib.loads((directory / "codex.toml").read_text(encoding="utf-8"))["mcp_servers"]
    cursor = json.loads((directory / "cursor.json").read_text(encoding="utf-8"))["mcpServers"]
    smoke.require(generated == cursor and set(generated) == {"lmti_m1"}, "Native client formats differ.")
    config = generated["lmti_m1"]
    launcher = verify_generated(config, directory, package, integration)
    stores = {"native": directory / "synthetic-project.sqlite"}
    if integration:
        fixture = json.loads((directory / "integration-fixture.json").read_text(encoding="utf-8"))
        smoke.require(fixture.get("schema") == "lmti.client.integration-fixture.v1" and fixture.get("synthetic") is True and
                      fixture.get("integrationSha256") == digest(integration), "Invalid synthetic integration fixture.")
        stores.update(memory=directory / "source/.lmti/memory/project-memory.sqlite",
                      compiled=directory / "source/.lmti/project.amf.json", integration=integration,
                      observations=directory / "observations.json")
    before = {key: digest(path) for key, path in stores.items()}
    # A fresh home refuses accidental reuse of client credentials/configuration.
    client_home = directory / "isolated-codex-home"
    client_home.mkdir()
    original_environment = smoke.clean_environment
    def isolated_environment():
        env = original_environment()
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        env["CODEX_HOME"] = str(client_home)
        return env
    smoke.clean_environment = isolated_environment
    inline = "{ " + ", ".join(key + " = " + json.dumps(value) for key, value in config.items()) + " }"
    override = "mcp_servers = { lmti_m1 = " + inline + " }"
    rpc = smoke.Rpc([str(args.codex.resolve(strict=True)), "app-server", "--stdio", "-c", override,
                     "-c", "analytics.enabled=false"], directory)
    integrated_evidence = None
    try:
        PHASE = "initialize"
        rpc.request(1, "initialize", {"clientInfo":{"name":"lmti_cp01_probe", "version":"2"},
                    "capabilities":{"experimentalApi":True}}, jsonrpc=False)
        rpc.send("initialized", {}, jsonrpc=False)
        PHASE = "discovery"
        value = rpc.request(2, "mcpServerStatus/list", {"serverName":"lmti_m1", "detail":"toolsAndAuthOnly", "limit":1}, jsonrpc=False)
        servers = value.get("data", [])
        smoke.require(len(servers) == 1 and servers[0].get("name") == "lmti_m1", "Codex discovery failed.")
        tools = sorted(tool.get("name", key) for key, tool in servers[0].get("tools", {}).items())
        smoke.require(tools == sorted(LEGACY_TOOLS + (["lmti_task_context"] if integration else [])), "Unexpected tool surface.")
        thread = rpc.request(3, "thread/start", {"cwd":str(directory), "ephemeral":True, "sandbox":"read-only", "approvalPolicy":"never"}, jsonrpc=False)
        def call(request_id, tool, arguments):
            return smoke.payload(rpc.request(request_id, "mcpServer/tool/call", {"threadId":thread["thread"]["id"],
                                 "server":"lmti_m1", "tool":tool, "arguments":arguments}, jsonrpc=False))
        PHASE = "context"
        verify_scope(call(4, "lmti_context", {"limit":100}), "project.context")
        if integration:
            PHASE = "task_context"
            context = call(5, "lmti_task_context", {"task":"code document memory", "kind":"component", "entityId":"sensor-firmware"})
            PHASE = "observations"
            observations = call(6, "lmti_observations", {"assetId":"machine-a"})
            PHASE = "integrated_evidence"
            integrated_evidence = verify_integrated(context, observations, directory)
    finally:
        rpc.close()
        smoke.clean_environment = original_environment
    PHASE = "read_only"
    smoke.require(before == {key: digest(path) for key, path in stores.items()}, "Client changed source bytes.")
    report = {"schema":"lmti.cp01.smoke.v1", "nativeConfigParsers":"passed", "sameProfile":True,
              "profile":"integrated" if integration else "legacy", "launcher":launcher,
              "codex":{"status":"passed", "tools":tools, "scopedRead":True, "isolatedHome":True, "modelTurn":False},
              "cursor":{"configuration":"parsed", "actualClient":"not_verified"},
              "liveCloudflareTailscale":False, "sourceBytesUnchanged":True,
              "verifiedStores":sorted(stores), "integrated":integrated_evidence}
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"schema":"lmti.cp01.smoke.v1", "status":"failed", "phase":PHASE,
                          "reason":"Client probe failed; no personal settings were modified."}))
        sys.exit(1)
