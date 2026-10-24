"""Create explicitly synthetic integrated sources for the packaged client smoke.

Only a newly produced fixture beneath build/ is accepted. This is test setup,
not an import path for user databases. Runtime reads use the selected package.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def write_json(path: Path, value) -> None:
    with path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    args = parser.parse_args()
    directory, package, node = (value.resolve(strict=True) for value in
                                (args.directory, args.package, args.node))
    if (not directory.is_relative_to(ROOT / "build") or not directory.name.startswith("web02-client-")
            or not node.is_file()):
        raise ValueError("Choose the new synthetic client fixture and trusted Node runtime.")
    database = directory / "synthetic-project.sqlite"
    if not database.is_file() or (directory / "integration.json").exists():
        raise ValueError("Fixture must be initialized exactly once.")
    source_root = directory / "source"
    source_root.mkdir()  # Refuse reuse instead of changing an existing source.
    binary = (package / "bin/lmti-project.exe").resolve(strict=True)
    cli = (package / "share/lmti/knowledge-owner/index.js").resolve(strict=True)
    python_source = (package / "share/lmti/python/src").resolve(strict=True)
    sys.path.insert(0, str(python_source))
    from lmti_agent.source import NativeProjectSource
    from lmti_project import Grant

    # Fixture construction only; the client never receives a database handle.
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("INSERT INTO knowledge(id,label,component_id,reference,fingerprint,privacy) VALUES(?,?,?,?,?,?)",
                           ("firmware-design", "Firmware design", "sensor-firmware",
                            "fixture-design-reference", "fixture-v1", "public"))
    test_tree = ast.parse((ROOT / "python/tests/test_agent_integrated_process.py").read_text(encoding="utf-8"))
    fixture = next(ast.literal_eval(item.value) for item in test_tree.body
                   if isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and
                                                           target.id == "FIXTURE" for target in item.targets))
    environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
    created = subprocess.run([str(node), "--input-type=module", "-", str(source_root), str(ROOT)],
                             input=fixture.encode("utf-8"), capture_output=True, check=True, timeout=30,
                             env=environment, shell=False,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    source_id = json.loads(created.stdout)["sourceId"]
    grant = Grant("factory-monitor", "factory-demo", "external")
    graph = NativeProjectSource(binary, database, grant, include_references=True).read()
    repository = next(row for row in graph.entities if row.identity.kind == "repository" and
                      row.identity.source_entity_id == "repo-sensor")
    document = next(row for row in graph.entities if row.identity.kind == "knowledge" and
                    row.identity.source_entity_id == "firmware-design")
    now = datetime.now(timezone.utc)
    def timestamp(seconds: int) -> str:
        return (now + timedelta(seconds=seconds)).isoformat(timespec="seconds").replace("+00:00", "Z")
    samples = []
    for index, (metric, unit, value, age, ttl) in enumerate([
        ("temperature", "C", 24.5, -5, 3600),
        ("firmware_version", "", "0.2.0", -5, 3600),
        ("pressure", "bar", 2.1, -120, 30),
    ]):
        samples.append({"sampleId": f"client-sample-{index}", "assetId": "machine-a", "deviceId": "sensor-a",
                        "metric": metric, "unit": unit, "value": value, "sampleAt": timestamp(age),
                        "receivedAt": timestamp(age + 1), "ttlSeconds": ttl, "quality": "good", "sequence": 1,
                        "connectionId": "client-replay-session", "classification": "public"})
    replay = directory / "observations.json"
    write_json(replay, {"schema": "lmti.observations.replay.v1", "sourceId": "controlled-observations",
                        "projectId": grant.project_id, "site": grant.site, "revision": 1,
                        "state": "available", "samples": samples})
    integration = {
        "schema": "lmti.agent.integration.v1", "projectId": grant.project_id, "site": grant.site,
        "target": grant.target,
        "knowledge": {"node": str(node), "cli": str(cli), "root": str(source_root), "sourceId": source_id,
                      "mappings": [
                          {"kind": "code", "referenceKind": "repository", "referenceId": "repo-sensor",
                           "referenceFingerprint": repository.attributes["locatorFingerprint"], "path": "src/firmware.ts"},
                          {"kind": "document", "referenceKind": "knowledge", "referenceId": "firmware-design",
                           "referenceFingerprint": document.attributes["referenceFingerprint"], "path": "docs/firmware.md"},
                          {"kind": "memory", "referenceKind": "component", "referenceId": "sensor-firmware",
                           "disclosure": "owner_safe_summary"}]},
        "observations": {"path": str(replay), "sourceId": "controlled-observations"}}
    config_file = directory / "integration.json"
    write_json(config_file, integration)
    write_json(directory / "integration-fixture.json", {
        "schema": "lmti.client.integration-fixture.v1", "synthetic": True,
        "projectId": grant.project_id, "site": grant.site, "target": grant.target,
        "contextEntity": {"kind": "component", "entityId": "sensor-firmware"}, "assetId": "machine-a",
        "integrationSha256": hashlib.sha256(config_file.read_bytes()).hexdigest(),
        "knowledgeOwner": "packaged", "observations": "controlled_replay", "liveProvider": False})
    print('{"synthetic":true,"integrationFixture":"created","liveProvider":false}')


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"integrationFixture":"failed","reason":"Synthetic source setup failed."}')
        sys.exit(1)
