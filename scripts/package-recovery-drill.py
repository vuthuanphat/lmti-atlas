#!/usr/bin/env python3
"""Synthetic, same-user/same-schema package recovery drill. Never user-data backup.

Requires two immutable local packages and the existing native fixture producer.
Only a fresh build child is writable; an interrupted directory cutover may be
completed forward with --resume. An unknown owner write is never replayed.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import closing
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid


# Reuse the shipped local-path/bounded-file guards; package integrity stays with
# the existing Node doctor, rather than introducing another package verifier.
_spec = importlib.util.spec_from_file_location("lmti_scale_guards", Path(__file__).with_name("agent-scale-baseline.py"))
guards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guards)
checked_path, read_file = guards.checked_path, guards.read_file
digest, encoded, write_new = guards.digest, guards.encoded, guards.write_new
PROJECT, SITE = "factory-monitor", "factory-demo"
DATABASES = ("project-library.sqlite", "mcp-profiles.sqlite", "synthetic-project.sqlite",
             "edge-project/project.sqlite", "source/.lmti/memory/project-memory.sqlite")
FILES = ("codex.toml", "cursor.json", "integration.json", "observations.json",
         "source/src/firmware.ts", "source/docs/firmware.md", "source/.lmti/project.amf.json",
         ".codex/config.toml", ".cursor/mcp.json",
         ".lmti-client/codex.state.json", ".lmti-client/cursor.state.json",
         ".lmti-client/codex.backup.dpapi", ".lmti-client/cursor.backup.dpapi")
MEMBERS = frozenset(DATABASES + FILES)
SCHEMA = "lmti.package-recovery.drill.v1"
ERRORS = {"INVALID_ARGUMENT", "UNSAFE_PATH", "OUTPUT_EXISTS", "SOURCE_CHANGED", "BUDGET_EXCEEDED",
          "PACKAGE_FAILED", "FIXTURE_FAILED", "OWNER_FAILED", "WRITE_OUTCOME_UNKNOWN", "STATE_CHANGED",
          "BACKUP_FAILED", "RESTORE_CONFLICT", "INVALID_JOURNAL", "INTERNAL_ERROR"}
ACTIVE_OUTPUT = None
UNKNOWN_OWNER_PID = None
UNKNOWN_OWNER_HANDLES = []
LAST_OWNER_RECEIPT = None


class DrillError(Exception):
    def __init__(self, code):
        self.code = code if code in ERRORS else "INTERNAL_ERROR"
        super().__init__(self.code)


def need(value, code="STATE_CHANGED"):
    if not value:
        raise DrillError(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise DrillError("INVALID_ARGUMENT")


def json_read(path):
    return json.loads(read_file(path, 1024 * 1024), object_pairs_hook=guards.strict_object)


def new_directory(path):
    checked_path(path.parent)
    checked_path(path, missing_leaf=True)
    try:
        path.mkdir()
    except FileExistsError:
        raise DrillError("OUTPUT_EXISTS") from None


def parents_for(path, root):
    need(path.is_relative_to(root), "UNSAFE_PATH")
    for parent in reversed(path.parents):
        if parent == root or parent.is_relative_to(root):
            checked_path(parent, missing_leaf=True)
            if not parent.exists():
                parent.mkdir()
            checked_path(parent)


def event_log(output):
    folder = checked_path(output / "events")
    names = sorted(p.name for p in folder.iterdir())
    need(len(names) <= 32 and names == [f"{i:04d}.json" for i in range(1, len(names) + 1)], "INVALID_JOURNAL")
    previous, rows = None, []
    for name in names:
        raw = read_file(folder / name, 65536)
        row = json.loads(raw, object_pairs_hook=guards.strict_object)
        need(set(row) == {"schema", "phase", "previous", "data"} and row["schema"] == SCHEMA
             and row["previous"] == previous and isinstance(row["data"], dict), "INVALID_JOURNAL")
        previous = digest(raw)
        rows.append(row)
    return rows, previous


def event(output, phase, data=None):
    rows, previous = event_log(output)
    need(len(rows) < 32, "INVALID_JOURNAL")
    write_new(output / "events" / f"{len(rows)+1:04d}.json",
              encoded({"schema": SCHEMA, "phase": phase, "previous": previous, "data": data or {}}))


def run(argv, *, payload=b"", write=False, timeout=30, cap=4 * 1024 * 1024, extra_env=None, operation="owner"):
    global UNKNOWN_OWNER_PID, LAST_OWNER_RECEIPT
    need(isinstance(payload, bytes) and len(payload) <= 4 * 1024 * 1024
         and type(cap) is int and 1 <= cap <= 4 * 1024 * 1024
         and 0 < timeout <= 120 and re.fullmatch(r"[a-z_]{1,32}", operation) is not None, "INVALID_ARGUMENT")
    checked_path(argv[0])
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    env.update({"PYTHONIOENCODING": "utf-8"})
    env.update(extra_env or {})
    LAST_OWNER_RECEIPT = {"operation": operation, "exitCode": None}
    process = subprocess.Popen([str(value) for value in argv], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                               env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    deadline = time.monotonic() + timeout
    overflow, failed = threading.Event(), threading.Event()
    output = [bytearray(), bytearray()]
    finished = [threading.Event() for _ in range(3)]

    def drain(stream, index):
        try:
            while True:
                # read1 performs at most one bounded pipe read. Keep draining
                # after a cap violation without retaining further bytes, so a
                # possibly committing writer is not blocked by a full pipe.
                block = stream.read1(65536)
                if not block:
                    break
                remaining = cap - len(output[index])
                output[index].extend(block[:remaining])
                if len(block) > remaining:
                    overflow.set()
        except (OSError, ValueError):
            failed.set()
        finally:
            try:
                stream.close()
            except (OSError, ValueError):
                failed.set()
            finally:
                finished[index].set()

    def send():
        try:
            process.stdin.write(payload)
            process.stdin.flush()
        except (OSError, ValueError):
            failed.set()
        finally:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                failed.set()
            finally:
                finished[2].set()

    workers = [threading.Thread(target=drain, args=(process.stdout, 0), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, 1), daemon=True),
               threading.Thread(target=send, daemon=True)]
    for worker in workers:
        worker.start()

    def receipt(code):
        return {"operation": operation, "exitCode": code,
                "stdoutBytesCaptured": len(output[0]), "stderrBytesCaptured": len(output[1]),
                "stdoutSha256": digest(bytes(output[0])), "stderrSha256": digest(bytes(output[1])),
                "outputLimitExceeded": overflow.is_set(), "pipeFailure": failed.is_set()}

    while True:
        code = process.poll()
        violation = "BUDGET_EXCEEDED" if overflow.is_set() else "OWNER_FAILED" if failed.is_set() else None
        if violation is None and code is not None and all(item.is_set() for item in finished):
            LAST_OWNER_RECEIPT = receipt(code)
            need(code == 0, "OWNER_FAILED")
            return bytes(output[0])
        remaining = deadline - time.monotonic()
        if violation is None and remaining > 0:
            time.sleep(min(0.01, remaining))
            continue
        LAST_OWNER_RECEIPT = dict(receipt(code), timedOut=remaining <= 0)
        if write:
            # Do not terminate or replay a possibly committing owner. The drill
            # stops before backup/cutover. Retain the process and bounded pipe
            # drainers while this harness is alive; never infer rollback from a
            # missing reply, overflow, pipe failure or timeout.
            UNKNOWN_OWNER_PID = process.pid
            UNKNOWN_OWNER_HANDLES.append((process, workers))
            raise DrillError("WRITE_OUTCOME_UNKNOWN") from None
        if code is None:
            process.kill()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass  # Read-only child was terminated; never wait without a bound.
        raise DrillError(violation or "OWNER_FAILED") from None


def owner_json(argv, request=None, *, write=False, operation="owner"):
    raw = run(argv, payload=b"" if request is None else encoded(request), write=write, operation=operation)
    result = json.loads(raw, object_pairs_hook=guards.strict_object)
    need(isinstance(result, dict) and result.get("ok", True) is True, "OWNER_FAILED")
    return result


DOCTOR = """import{pathToFileURL}from'node:url';let s='';for await(const b of process.stdin){s+=b;if(s.length>4096)throw Error()}
const c=JSON.parse(s);const{inspectPackage}=await import(pathToFileURL(c.doctor));
process.stdout.write(JSON.stringify(await inspectPackage(c.package,c.python)));"""


def doctor(repo, package, node):
    module = checked_path(repo / "apps/web-api/dist/doctor.js")
    result = owner_json([node, "--input-type=module", "-e", DOCTOR],
                        {"doctor": str(module), "package": str(package), "python": sys.executable}, operation="package_doctor")
    need(result.get("ok") is True, "PACKAGE_FAILED")
    return {"manifestSha256": digest(read_file(package / "manifest.json", 2 * 1024 * 1024)),
            "files": result["integrity"]["files"], "bytes": result["integrity"]["bytes"]}


def sql_connection(path, readonly=True):
    checked_path(path)
    connection = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, timeout=2)
    connection.execute("PRAGMA trusted_schema=OFF")
    if readonly:
        connection.execute("PRAGMA query_only=ON")
    return connection


def database_state(path):
    need(len(read_file(path, 64 * 1024 * 1024)) > 0, "BACKUP_FAILED")
    with closing(sql_connection(path)) as connection:
        need(connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "BACKUP_FAILED")
        application = connection.execute("PRAGMA application_id").fetchone()[0]
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        schema = connection.execute("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        memory = path.name == "project-memory.sqlite"
        memory_triggers = {"memory_items_ai", "memory_items_ad", "memory_items_au",
                           "short_memory_notes_ai", "short_memory_notes_ad", "short_memory_notes_au"}
        need(len(schema) <= 128 and not any(row[0] == "view" or
             (row[0] == "trigger" and (not memory or row[1] not in memory_triggers)) for row in schema), "BACKUP_FAILED")
        memory_version = connection.execute("SELECT MAX(version) FROM memory_migrations").fetchone()[0] if memory else None
        tables, total = {}, 0
        for kind, name, _ in schema:
            if kind != "table":
                continue
            rows = connection.execute('SELECT * FROM "' + name.replace('"', '""') + '" LIMIT 10001').fetchall()
            total += len(rows)
            need(total <= 10000, "BUDGET_EXCEEDED")
            normalized = [[{"blob": value.hex()} if isinstance(value, bytes) else value for value in row] for row in rows]
            tables[name] = sorted(normalized, key=lambda row: encoded(row))
        return {"applicationId": application, "schemaVersion": version, "memoryMigrationVersion": memory_version,
                "schemaSha256": digest(encoded(schema)), "rows": total,
                "logicalSha256": digest(encoded({"applicationId": application, "version": version,
                                                  "schema": schema, "tables": tables}))}


def sqlite_backup(source, target, *, timeout=30):
    need(0 < timeout <= 120, "INVALID_ARGUMENT")
    before = database_state(source)
    write_new(target, b"")
    deadline = time.monotonic() + timeout

    def progress(status, remaining, total):
        # SQLite calls progress even while SQLITE_BUSY/LOCKED is retried.
        # Raising aborts this new backup only; original/partial files remain.
        need(time.monotonic() < deadline, "BUDGET_EXCEEDED")

    with closing(sql_connection(source)) as src, closing(sql_connection(target, False)) as dst:
        # Bound each lock wait as well as the overall retry loop. Progress runs
        # after BUSY/LOCKED, so deadline overshoot is at most this lock interval
        # plus one backup step and scheduling; this is not a hard real-time SLA.
        src.execute("PRAGMA busy_timeout=250")
        dst.execute("PRAGMA busy_timeout=250")
        src.backup(dst, pages=128, sleep=0.01, progress=progress)
        # Independent backup includes committed WAL, then gets its own portable
        # DELETE-journal header. Main-file hashes need not match the original.
        dst.execute("PRAGMA journal_mode=DELETE")
    need(database_state(source) == before == database_state(target), "BACKUP_FAILED")
    return before


def inventory(state):
    seen = set()
    sidecars = {}
    for path in guards.package_tree(state):
        name = path.relative_to(state).as_posix()
        if name in MEMBERS:
            seen.add(name)
        elif any(name == db + suffix for db in DATABASES for suffix in ("-wal", "-shm", "-journal")):
            sidecars[name] = digest(read_file(path, 64 * 1024 * 1024))
        else:
            raise DrillError("STATE_CHANGED")
    need(seen == MEMBERS, "STATE_CHANGED")
    return sidecars


def snapshot(state, destination):
    sidecars = inventory(state)
    new_directory(destination)
    files = {}
    for name in sorted(MEMBERS):
        source, target = state / name, destination / name
        parents_for(target, destination)
        row = {"kind": "sqlite" if name in DATABASES else "file"}
        if name in DATABASES:
            row["database"] = sqlite_backup(source, target)
        else:
            write_new(target, read_file(source))
        row["sha256"] = digest(read_file(target))
        files[name] = row
    manifest = {"schema": SCHEMA, "files": files, "observedSidecars": sidecars}
    write_new(destination / "snapshot.json", encoded(manifest))
    return manifest


def verify_snapshot(folder):
    manifest = json_read(folder / "snapshot.json")
    need(set(manifest) == {"schema", "files", "observedSidecars"} and manifest["schema"] == SCHEMA
         and set(manifest["files"]) == MEMBERS, "BACKUP_FAILED")
    for name, row in manifest["files"].items():
        path = folder / name
        need(digest(read_file(path)) == row["sha256"], "BACKUP_FAILED")
        if name in DATABASES:
            need(database_state(path) == row["database"], "BACKUP_FAILED")
    return manifest


def state_matches(state, manifest):
    inventory(state)
    for name, row in manifest["files"].items():
        need(database_state(state / name) == row["database"] if name in DATABASES
             else digest(read_file(state / name)) == row["sha256"], "RESTORE_CONFLICT")


def retained_rename(source, target, output):
    need(source.parent == output and target.parent == output and source.name in ("state", "restore-ready")
         and target.name in ("retained-post-update", "state"), "UNSAFE_PATH")
    checked_path(source)
    checked_path(target, missing_leaf=True)
    need(not target.exists(), "RESTORE_CONFLICT")
    # Same-volume directory rename only. No recursive delete and no overwrite.
    os.rename(source, target)


def prepare_restore(output):
    baseline = verify_snapshot(output / "baseline")
    updated = verify_snapshot(output / "post-update")
    state_matches(output / "state", updated)
    ready = output / "restore-ready"
    new_directory(ready)
    for name in sorted(MEMBERS):
        target = ready / name
        parents_for(target, ready)
        write_new(target, read_file(output / "baseline" / name))
    state_matches(ready, baseline)
    event(output, "restore_prepared")


def finish_restore(output, interrupt=False):
    baseline = verify_snapshot(output / "baseline")
    updated = verify_snapshot(output / "post-update")
    rows, _ = event_log(output)
    need(rows[-1]["phase"] in ("restore_prepared", "original_retained"), "INVALID_JOURNAL")
    state, ready, retained = output / "state", output / "restore-ready", output / "retained-post-update"
    for path in (state, ready, retained):
        checked_path(path, missing_leaf=True)
    # A crash may occur after rename but before its event is fsynced. Infer only
    # these two exact, fully verified states; any extra/missing/conflicting tree
    # is a manual-review stop. Never replay an owner command.
    if state.exists() and ready.exists() and not retained.exists():
        state_matches(state, updated); state_matches(ready, baseline)
        retained_rename(state, retained, output)
    need(retained.exists(), "RESTORE_CONFLICT")
    state_matches(retained, updated)
    if rows[-1]["phase"] == "restore_prepared":
        event(output, "original_retained")
    if interrupt:
        need(not state.exists() and ready.exists(), "RESTORE_CONFLICT")
        return False
    if not state.exists() and ready.exists():
        state_matches(ready, baseline)
        retained_rename(ready, state, output)
    need(state.exists() and not ready.exists(), "RESTORE_CONFLICT")
    state_matches(state, baseline)
    event(output, "baseline_restored")
    return True


def python_args(output, command=None):
    executable = sys.executable if command is None else command
    need(checked_path(executable) == checked_path(sys.executable), "OWNER_FAILED")
    # Validate canonical identity, but retain the native-exported spelling.
    return [executable, "-I", "-B", "-X", "pycache_prefix=" + str(output / "unused-python-cache")]


def admin(package, state, request):
    return owner_json([package / "bin/lmti-mcp-admin.exe", "--library", state / "project-library.sqlite",
                       "--profiles", state / "mcp-profiles.sqlite", "--python", sys.executable,
                       "--entry", package / "share/lmti/scripts/lmti-agent-mcp.py",
                       "--binary", package / "bin/lmti-project.exe"], request, write=request["action"] == "save")


def generated(package, state, client):
    read = admin(package, state, {"action": "read", "projectId": PROJECT})
    return admin(package, state, {"action": "generate", "projectId": PROJECT, "client": client,
                                 "expectedRevision": read["profile"]["revision"], "integration": {
                                     "configPath": str(state / "integration.json"), "projectId": PROJECT,
                                     "site": SITE, "target": "external", "sha256": digest(read_file(state / "integration.json"))}})


def config_owner(package, output, request):
    return owner_json(python_args(output) + [package / "share/lmti/scripts/mcp-config-owner.py"], request,
                      write=request["action"] in ("apply", "restore_commit"))


def apply_clients(package, output):
    state = output / "state"
    for client in ("codex", "cursor"):
        value = generated(package, state, client)
        request = {"action": "preview", "project": PROJECT, "root": str(state), "client": client,
                   "revision": value["profile"]["revision"], "content": value["content"], "servers": value["servers"]}
        preview = config_owner(package, output, request)
        result = config_owner(package, output, dict(request, action="apply", expected=preview["expected"]))
        need(result["state"] == "applied", "OWNER_FAILED")


def replay_state(envelope, *, value, revision):
    """Validate the controlled sample, retaining only time-stable evidence."""
    need(envelope.get("status") == "ok" and envelope.get("unknowns") == []
         and envelope.get("conflicts") == [], "OWNER_FAILED")
    rows = envelope.get("data", {}).get("observations")
    sources = [row for row in envelope.get("sources", []) if row.get("sourceId") == "recovery-observations"]
    need(isinstance(rows, list) and len(rows) == 1 and len(sources) == 1, "OWNER_FAILED")
    row, source = rows[0], sources[0]
    identity = {"sourceId": "recovery-observations", "kind": "observation", "sourceEntityId": "recovery-temperature"}
    expected = {"identity": identity, "projectId": PROJECT, "site": SITE, "assetId": "machine-a",
                "deviceId": "sensor-a", "metric": "temperature", "unit": "C", "value": value,
                "ttlSeconds": 3600, "quality": "good", "classification": "public"}
    need(all(row.get(key) == item for key, item in expected.items())
         and row.get("freshness", {}).get("state") == "fresh"
         and row["freshness"].get("reasons") == [], "OWNER_FAILED")
    version = source.get("version", {})
    need(source.get("kind") == "controlled_replay" and source.get("authority") == "controlled_observation"
         and source.get("freshness", {}).get("state") == "fresh"
         and source["freshness"].get("basis") == "controlled_replay"
         and version.get("type") == "replay_revision" and type(version.get("value")) is int
         and version["value"] == revision
         and re.fullmatch(r"[0-9a-f]{64}", str(version.get("fingerprint", ""))) is not None, "OWNER_FAILED")
    evidence_ids = row.get("evidenceIds")
    need(isinstance(evidence_ids, list) and len(evidence_ids) == 1, "OWNER_FAILED")
    evidence = [item for item in envelope.get("evidence", []) if item.get("evidenceId") == evidence_ids[0]]
    need(len(evidence) == 1 and evidence[0].get("sourceId") == "recovery-observations"
         and evidence[0].get("sourceRevision") == revision
         and evidence[0].get("reference") == {"kind": "observation", "sourceEntityId": "recovery-temperature"}
         and evidence[0].get("basis") == "controlled_replay", "OWNER_FAILED")
    # checkedAt and age change between baseline and restore. Their freshness
    # must pass above; only stable source/revision/sample facts are compared.
    return {"status": "ok", "freshness": "fresh", "sample": expected,
            "source": {"sourceId": source["sourceId"], "kind": source["kind"], "version": version},
            "sampleAt": row["sampleAt"], "receivedAt": row["receivedAt"], "evidence": evidence}


def mcp_state(package, output, *, value, revision):
    state = output / "state"
    definition = generated(package, state, "cursor")["servers"]["lmti_m1"]
    need(len(definition["args"]) == 16, "OWNER_FAILED")
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "recovery-drill", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "lmti_task_context", "arguments": {"task": "code document memory", "kind": "component", "entityId": "sensor-firmware"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "lmti_observations", "arguments": {"assetId": "machine-a"}}},
    ]
    # Only interpreter cache controls are added; the native-generated owner,
    # project/site/target/config/pin arguments remain byte-for-byte unchanged.
    raw = run(python_args(output, definition["command"]) + definition["args"],
              payload=b"".join(json.dumps(row).encode() + b"\n" for row in messages), operation="mcp_read")
    responses = {row["id"]: row for row in map(json.loads, raw.splitlines())}
    names = sorted(row["name"] for row in responses[2]["result"]["tools"])
    need(names == sorted(["lmti_context", "lmti_entity", "lmti_related", "lmti_observations", "lmti_task_context"]), "OWNER_FAILED")
    context = responses[3]["result"]["structuredContent"]
    observations = responses[4]["result"]["structuredContent"]
    need(context["status"] == "ok", "OWNER_FAILED")
    replay = replay_state(observations, value=value, revision=revision)
    items = context["data"]["contextItems"]
    need({row["kind"] for row in items} == {"code", "document", "memory"}, "OWNER_FAILED")
    need(context["scope"]["classification"] == "internal" and context["scope"]["knowledgeDisclosure"] == "owner_safe_summary", "OWNER_FAILED")
    serialized = json.dumps(context)
    need(not any(text in serialized for text in (str(state), "PrivateOnlyMarker", "ForbiddenOnlyMarker", "PendingOnlyMarker", "return 1000")), "OWNER_FAILED")
    return {"tools": names, "itemsSha256": digest(encoded(items)), "scope": context["scope"], "replay": replay}


def read_state(package, output, *, value, revision):
    state = output / "state"
    asset = owner_json([package / "bin/lmti-project.exe", "proposal-asset", state / "synthetic-project.sqlite", PROJECT, SITE, "external", "machine-a"])
    profile = admin(package, state, {"action": "read", "projectId": PROJECT})["profile"]
    library = admin(package, state, {"action": "library"})["items"]
    return {"asset": asset, "profile": profile, "librarySha256": digest(encoded(library)),
            "mcp": mcp_state(package, output, value=value, revision=revision)}


def producer_environment(runtime, package):
    temporary = runtime / "temp"
    # QTemporaryDir runs the producer's own checks before fixture construction.
    # Never inherit a user temp path or allow Qt to fall back to a system path.
    new_directory(temporary)
    checked_path(temporary)
    return {"TMP": str(temporary), "TEMP": str(temporary), "LMTI_PYTHON_BINARY": sys.executable,
            "LMTI_AGENT_ENTRY": str(package / "share/lmti/scripts/lmti-agent-mcp.py"),
            "LMTI_PROJECT_BINARY": str(package / "bin/lmti-project.exe")}


def fixture(repo, package, producer, node, output):
    state, runtime = output / "state", output / "fixture-runtime"
    new_directory(state); new_directory(runtime)
    for folder in ("bin", "plugins"):
        new_directory(runtime / folder)
        for source in guards.package_tree(package / folder):
            target = runtime / folder / source.relative_to(package / folder)
            parents_for(target, runtime)
            write_new(target, read_file(source))
    copied_producer = runtime / "bin/lmti-mcp-profile-tests.exe"
    write_new(copied_producer, read_file(producer))
    run([copied_producer, state], write=True, extra_env=producer_environment(runtime, package), operation="fixture_producer")
    # Explicit synthetic setup only. All subsequent project/profile changes use owners.
    with closing(sql_connection(state / "synthetic-project.sqlite", False)) as connection, connection:
        connection.execute("INSERT INTO knowledge(id,label,component_id,reference,fingerprint,privacy) VALUES(?,?,?,?,?,?)",
                           ("firmware-design", "Firmware design", "sensor-firmware", "fixture-design-reference", "fixture-v1", "public"))
    source = state / "source"; new_directory(source)
    test = ast.parse(read_file(repo / "python/tests/test_agent_integrated_process.py", 128 * 1024).decode("utf-8-sig"))
    scripts = [ast.literal_eval(row.value) for row in test.body if isinstance(row, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == "FIXTURE" for target in row.targets)]
    need(len(scripts) == 1 and isinstance(scripts[0], str), "FIXTURE_FAILED")
    compiled = json.loads(run([node, "--input-type=module", "-", source, repo], payload=scripts[0].encode(), write=True, operation="source_fixture"))
    graph_code = """import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from lmti_agent.source import NativeProjectSource
from lmti_project import Grant
rows=NativeProjectSource(sys.argv[2],sys.argv[3],Grant('factory-monitor','factory-demo'),include_references=True).read().entities
print(json.dumps({r.identity.source_entity_id:r.attributes for r in rows if r.identity.source_entity_id in ('repo-sensor','firmware-design')}))"""
    refs = json.loads(run(python_args(output) + ["-c", graph_code, package / "share/lmti/python/src", package / "bin/lmti-project.exe", state / "synthetic-project.sqlite"], operation="native_references"))
    timestamp = (datetime.now(timezone.utc) - timedelta(seconds=3)).isoformat().replace("+00:00", "Z")
    replay = {"schema": "lmti.observations.replay.v1", "sourceId": "recovery-observations", "projectId": PROJECT,
              "site": SITE, "revision": 1, "state": "available", "samples": [{"sampleId": "recovery-temperature", "assetId": "machine-a",
              "deviceId": "sensor-a", "metric": "temperature", "unit": "C", "value": 24.5, "sampleAt": timestamp,
              "receivedAt": timestamp, "ttlSeconds": 3600, "quality": "good", "sequence": 1, "connectionId": "recovery-replay", "classification": "public"}]}
    integration = {"schema": "lmti.agent.integration.v1", "projectId": PROJECT, "site": SITE, "target": "external",
                   "knowledge": {"node": str(node), "cli": str(package / "share/lmti/knowledge-owner/index.js"), "root": str(source),
                                 "sourceId": compiled["sourceId"], "mappings": [
                       {"kind": "code", "referenceKind": "repository", "referenceId": "repo-sensor", "referenceFingerprint": refs["repo-sensor"]["locatorFingerprint"], "path": "src/firmware.ts"},
                       {"kind": "document", "referenceKind": "knowledge", "referenceId": "firmware-design", "referenceFingerprint": refs["firmware-design"]["referenceFingerprint"], "path": "docs/firmware.md"},
                       {"kind": "memory", "referenceKind": "component", "referenceId": "sensor-firmware", "disclosure": "owner_safe_summary"}]},
                   "observations": {"path": str(state / "observations.json"), "sourceId": "recovery-observations"}}
    write_new(state / "integration.json", encoded(integration)); write_new(state / "observations.json", encoded(replay))
    for name, content in ((".codex/config.toml", b'[mcp_servers.unmanaged]\nurl = "https://example.invalid/mcp"\n'),
                          (".cursor/mcp.json", b'{"private_setting":"synthetic-only","mcpServers":{"unmanaged":{"url":"https://example.invalid/mcp"}}}\n')):
        parents_for(state / name, state); write_new(state / name, content)
    apply_clients(package, output)


def replace_fixture_file(state, name, value):
    need(name in ("integration.json", "observations.json"), "UNSAFE_PATH")
    path = checked_path(state / name)
    old = read_file(path)
    temporary = state / (name + ".next")
    write_new(temporary, encoded(value))
    need(read_file(path) == old, "STATE_CHANGED")
    checked_path(temporary); checked_path(path)
    os.replace(temporary, path)


def update(package, output):
    state = output / "state"
    old = owner_json([package / "bin/lmti-project.exe", "proposal-asset", state / "synthetic-project.sqlite", PROJECT, SITE, "external", "machine-a"])
    proposal = {"schema": "lmti.topology.proposal.v1", "baseRevision": old["topologyRevision"], "assetId": "machine-a", "site": SITE,
                "expected": old["asset"]["desired"], "desired": {"enabled": True, "pollMs": 2000}}
    request = {"expectedProjectRevision": old["projectRevision"], "proposal": proposal}
    command = [package / "bin/lmti-project.exe", "review-proposal", state / "synthetic-project.sqlite", PROJECT, SITE, "external"]
    owner_json(command, request); command[1] = "commit-proposal"; owner_json(command, request, write=True)
    profile = admin(package, state, {"action": "read", "projectId": PROJECT})["profile"]
    profile["servers"][0]["label"] = "Recovery update context"
    admin(package, state, {"action": "save", "projectId": PROJECT, "expectedRevision": profile["revision"], "servers": profile["servers"]})
    # The fixture source/launcher owns these synthetic JSON files, outside the
    # domain stores. No provider credentials, external source or network is used.
    config = json_read(state / "integration.json")
    config["knowledge"]["cli"] = str(package / "share/lmti/knowledge-owner/index.js")
    replace_fixture_file(state, "integration.json", config)
    replay = json_read(state / "observations.json")
    replay["revision"] = 2; replay["samples"][0]["value"] = 25.5
    replace_fixture_file(state, "observations.json", replay)
    apply_clients(package, output)


def final_check(repo, before, after, node, output, protocol):
    expected = json_read(output / "baseline-state.json")
    restored_state = read_state(before, output, value=24.5, revision=1)
    need(restored_state == expected, "RESTORE_CONFLICT")
    state_matches(output / "state", verify_snapshot(output / "baseline"))
    # Decrypt/restore through the real owner at the original root to verify DPAPI
    # continuity. This is a second explicit operation after baseline comparison.
    for client, name, original in (("codex", ".codex/config.toml", b'[mcp_servers.unmanaged]\nurl = "https://example.invalid/mcp"\n'),
                                    ("cursor", ".cursor/mcp.json", b'{"private_setting":"synthetic-only","mcpServers":{"unmanaged":{"url":"https://example.invalid/mcp"}}}\n')):
        request = {"action": "restore_preview", "root": str(output / "state"), "project": PROJECT, "client": client}
        preview = config_owner(before, output, request)
        restored = config_owner(before, output, dict(request, action="restore_commit", expected=preview["expected"]))
        need(restored["state"] == "restored" and read_file(output / "state" / name) == original, "RESTORE_CONFLICT")
    package_results = {"before": doctor(repo, before, node), "after": doctor(repo, after, node)}
    need(package_results == protocol["packages"], "PACKAGE_FAILED")
    need({name: digest(read_file(repo / name)) for name in protocol["sources"]} == protocol["sources"], "SOURCE_CHANGED")
    state_matches(output / "retained-post-update", verify_snapshot(output / "post-update"))
    event(output, "complete", {"sameRootDpapiRestore": True, "packagesUnchanged": True})
    write_new(output / "report.json", encoded({"schema": SCHEMA, "status": "passed", "protocolSha256": digest(read_file(output / "protocol.json")),
        "packages": package_results, "snapshots": {name: {"manifestSha256": digest(read_file(output / name / "snapshot.json")),
            "databases": {key: row["database"] for key, row in verify_snapshot(output / name)["files"].items() if key in DATABASES}}
            for name in ("baseline", "post-update")},
        "sameSchema": True, "sameUserSameMachine": True, "baselineLogicalStateRestored": True,
        "controlledReplay": {"sourceId": "recovery-observations", "assetId": "machine-a", "metric": "temperature", "unit": "C",
            "baseline": {"value": 24.5, "revision": 1, "status": "ok", "freshness": "fresh"},
            "updated": {"value": 25.5, "revision": 2, "status": "ok", "freshness": "fresh"},
            "restored": {"value": 24.5, "revision": 1, "status": "ok", "freshness": "fresh"}},
        "fullPostUpdateStateRetained": True, "dpapiBothClientsRestoredOriginalBytes": True,
        "interruptionExercised": protocol["interruptAfterRetain"], "deviceActions": False,
        "limits": ["Synthetic same-schema fixture only; not a production backup tool or schema migration.",
                   "No clean-Windows, cross-user/machine DPAPI, custom DACL or live provider acceptance.",
                   "MCP invoked by harness with only Python cache-control flags added; not actual product-client proof."]}))


def main(argv=None):
    global ACTIVE_OUTPUT
    parser = Parser(description=__doc__)
    parser.add_argument("--package-before", required=True)
    parser.add_argument("--package-after", required=True)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--interrupt-after-retain", action="store_true")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(argv)
    repo = checked_path(Path(__file__).absolute().parent.parent)
    before = checked_path(guards.build_child(repo, args.package_before))
    after = checked_path(guards.build_child(repo, args.package_after))
    output = guards.build_child(repo, args.output)
    producer_name = guards.relative_name(args.producer)
    need(producer_name.startswith("build/") and Path(producer_name).name == "lmti-mcp-profile-tests.exe", "INVALID_ARGUMENT")
    producer = checked_path(repo / producer_name)
    node = checked_path(args.node)
    need(before != after and node.name.casefold() == "node.exe" and os.name == "nt", "INVALID_ARGUMENT")
    checked_path(sys.executable)
    inputs = {"packageBefore": args.package_before, "packageAfter": args.package_after, "producer": producer_name,
              "nodeSha256": digest(read_file(node)), "pythonSha256": digest(read_file(Path(sys.executable))),
              "producerSha256": digest(read_file(producer)), "output": args.output}
    sources = {name: digest(read_file(repo / name)) for name in ("scripts/package-recovery-drill.py", "scripts/agent-scale-baseline.py",
        "apps/web-api/dist/doctor.js", "apps/web-api/dist/security.js", "python/tests/test_agent_integrated_process.py",
        "packages/compiler/dist/index.js", "packages/memory/dist/index.js", "pnpm-lock.yaml")}
    packages = {"before": doctor(repo, before, node), "after": doctor(repo, after, node)}
    need(packages["before"]["manifestSha256"] != packages["after"]["manifestSha256"], "INVALID_ARGUMENT")
    if args.resume:
        checked_path(output)
        protocol = json_read(output / "protocol.json")
        need(protocol["inputs"] == inputs and protocol["sources"] == sources and protocol["packages"] == packages, "STATE_CHANGED")
        rows, _ = event_log(output)
        need(rows and rows[0]["phase"] == "frozen" and rows[0]["data"]["protocolSha256"] == digest(read_file(output / "protocol.json")), "INVALID_JOURNAL")
        ACTIVE_OUTPUT = output
        need(finish_restore(output), "RESTORE_CONFLICT")
    else:
        new_directory(output); new_directory(output / "events")
        protocol = {"schema": SCHEMA, "inputs": inputs, "sources": sources, "packages": packages,
                    "interruptAfterRetain": args.interrupt_after_retain,
                    "budgets": {"ownerSeconds": 30, "ownerInputBytes": 4194304, "ownerBytesPerOutputPipe": 4194304,
                                "readChildReapSeconds": 1, "sqliteBackupSeconds": 30, "sqliteBackupBusyMilliseconds": 250,
                                "replayTtlSeconds": 3600},
                    "scope": "Synthetic two-package, same-user, same-root, same-schema recovery; no acceptance thresholds or release claim."}
        write_new(output / "protocol.json", encoded(protocol))
        event(output, "frozen", {"protocolSha256": digest(read_file(output / "protocol.json"))})
        ACTIVE_OUTPUT = output
        fixture(repo, before, producer, node, output)
        baseline_state = read_state(before, output, value=24.5, revision=1)
        write_new(output / "baseline-state.json", encoded(baseline_state))
        snapshot(output / "state", output / "baseline"); event(output, "baseline_saved")
        event(output, "update_started")
        update(after, output)
        updated_state = read_state(after, output, value=25.5, revision=2)
        need(updated_state["asset"]["projectRevision"] == baseline_state["asset"]["projectRevision"] + 1
             and updated_state["profile"]["revision"] == baseline_state["profile"]["revision"] + 1
             and updated_state["asset"]["asset"]["desired"]["pollMs"] == 2000, "STATE_CHANGED")
        write_new(output / "post-update-state.json", encoded(updated_state))
        updated_snapshot = snapshot(output / "state", output / "post-update")
        baseline_snapshot = verify_snapshot(output / "baseline")
        for name in DATABASES:
            for field in ("applicationId", "schemaVersion", "memoryMigrationVersion", "schemaSha256"):
                need(updated_snapshot["files"][name]["database"][field] == baseline_snapshot["files"][name]["database"][field], "STATE_CHANGED")
        event(output, "post_update_saved")
        prepare_restore(output)
        if not finish_restore(output, args.interrupt_after_retain):
            print(json.dumps({"status": "interrupted_at_safe_cutover", "output": args.output, "resumeRequired": True}))
            return 0
    final_check(repo, before, after, node, output, protocol)
    print(json.dumps({"status": "passed", "output": args.output, "releaseAcceptance": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        code = getattr(error, "code", "INTERNAL_ERROR")
        failure = {"status": "failed", "error": code if code in ERRORS else "INTERNAL_ERROR",
                   "retryWrite": False, "preserveFixture": True}
        if ACTIVE_OUTPUT is not None:
            try:
                if LAST_OWNER_RECEIPT is not None:
                    failure["lastOwner"] = LAST_OWNER_RECEIPT
                if UNKNOWN_OWNER_PID is not None:
                    # Private local evidence only; do not terminate this process
                    # or retry its write based solely on its missing reply.
                    failure["ownerPidForInspection"] = UNKNOWN_OWNER_PID
                    event(ACTIVE_OUTPUT, "write_outcome_unknown", {"ownerPid": UNKNOWN_OWNER_PID})
                write_new(ACTIVE_OUTPUT / ("failure-" + uuid.uuid4().hex + ".json"), encoded(failure))
            except Exception:
                pass  # Never replace the original failure or overwrite evidence.
        print(json.dumps({key: value for key, value in failure.items() if key not in ("ownerPidForInspection", "lastOwner")}))
        raise SystemExit(1)
