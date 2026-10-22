#!/usr/bin/env python3
"""Reproducible synthetic Agent read baseline; never opens a user database.

Use a trusted Python with -I -B. Only the new fixture is written with SQLite;
all measured queries use the selected package's Python and native owners.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import platform
import re
import sqlite3
import stat
import statistics
import sys
import time
import uuid


MAX_FILE = 128 * 1024 * 1024
MAX_PACKAGE = 512 * 1024 * 1024
RUN_BUDGET_SECONDS = 3600
RESERVED = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
SAFE_ERRORS = {"INVALID_ARGUMENT", "UNSAFE_PATH", "OUTPUT_EXISTS", "INVALID_PACKAGE",
               "PACKAGE_CHANGED", "FIXTURE_FAILED", "READ_FAILED", "PAGINATION_FAILED",
               "SOURCE_CHANGED", "BUDGET_EXCEEDED", "INTERRUPTED", "INTERNAL_ERROR"}


class ProbeError(Exception):
    def __init__(self, code: str):
        self.code = code if code in SAFE_ERRORS else "INTERNAL_ERROR"
        super().__init__(self.code)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default includes supplied paths/values in diagnostics.
        raise ProbeError("INVALID_ARGUMENT")


def local_spelling(value: str | Path) -> Path:
    raw = str(value)
    forward = raw.replace("\\", "/")
    tail = re.sub(r"^[A-Za-z]:/", "", forward)
    if (forward.startswith("//") or ":" in tail or any(ord(c) < 32 for c in raw)
            or (os.name == "nt" and not re.match(r"^[A-Za-z]:/", forward))):
        raise ProbeError("UNSAFE_PATH")
    components = tail.lstrip("/").split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " ")) or RESERVED.match(part)
           for part in components if components != [""]):
        raise ProbeError("UNSAFE_PATH")
    path = Path(raw)
    if not path.is_absolute():
        raise ProbeError("UNSAFE_PATH")
    return path


def checked_path(value: str | Path, *, missing_leaf: bool = False) -> Path:
    path = local_spelling(value)  # Reject remote/device/ADS spelling before any I/O.
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if part == path and missing_leaf:
                return path
            raise ProbeError("UNSAFE_PATH") from None
        if (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise ProbeError("UNSAFE_PATH")
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise ProbeError("UNSAFE_PATH")
    if path.resolve(strict=True) != path:
        raise ProbeError("UNSAFE_PATH")
    return path


def relative_name(value: str) -> str:
    if (not isinstance(value, str) or len(value) > 240 or "\\" in value or ":" in value
            or any(ord(c) < 32 for c in value)):
        raise ProbeError("UNSAFE_PATH")
    parts = value.split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " "))
           or RESERVED.match(part) for part in parts):
        raise ProbeError("UNSAFE_PATH")
    return value


def build_child(repo: Path, value: str) -> Path:
    name = relative_name(value)
    parts = name.split("/")
    if len(parts) != 2 or parts[0] != "build" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", parts[1]):
        raise ProbeError("INVALID_ARGUMENT")
    return repo / parts[0] / parts[1]


def read_file(path: Path, limit: int = MAX_FILE) -> bytes:
    path = checked_path(path)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ProbeError("BUDGET_EXCEEDED")
    with path.open("rb") as source:
        opened = os.fstat(source.fileno())
        data = source.read(limit + 1)
        after_handle = os.fstat(source.fileno())
    after = checked_path(path).stat()
    signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if len(data) > limit or not (signature(before) == signature(opened) == signature(after_handle) == signature(after)):
        raise ProbeError("SOURCE_CHANGED")
    return data


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def write_new(path: Path, data: bytes) -> None:
    checked_path(path, missing_leaf=True)
    with path.open("xb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProbeError("INVALID_PACKAGE")
        result[key] = value
    return result


def package_tree(package: Path):
    """Inspect every parent before enumerating descendants, with a node budget."""
    pending = [package]
    visited = 0
    while pending:
        directory = pending.pop()
        checked_path(directory)
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > 4096:
                    raise ProbeError("BUDGET_EXCEEDED")
                path = checked_path(directory / entry.name)
                if path.is_dir():
                    pending.append(path)
                else:
                    yield path


def verify_package(package: Path) -> dict:
    package = checked_path(package)
    if not package.is_dir():
        raise ProbeError("INVALID_PACKAGE")
    raw = read_file(package / "manifest.json", 1024 * 1024)
    manifest = json.loads(raw, object_pairs_hook=strict_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ProbeError("INVALID_PACKAGE")))
    if (not isinstance(manifest, dict) or manifest.get("schema") != "lmti.local-web.package.v1"
            or not isinstance(manifest.get("files"), list) or not 1 <= len(manifest["files"]) <= 1000):
        raise ProbeError("INVALID_PACKAGE")
    hashes = {}
    folded = set()
    total = 0
    for row in manifest["files"]:
        if (not isinstance(row, dict) or set(row) != {"file", "sha256"}
                or not isinstance(row["sha256"], str) or not re.fullmatch(r"[a-fA-F0-9]{64}", row["sha256"])):
            raise ProbeError("INVALID_PACKAGE")
        name = relative_name(row["file"])
        if name.casefold() in folded:
            raise ProbeError("INVALID_PACKAGE")
        folded.add(name.casefold())
        content = read_file(package / name)
        total += len(content)
        if total > MAX_PACKAGE:
            raise ProbeError("BUDGET_EXCEEDED")
        hashes[name] = digest(content)
        if hashes[name] != row["sha256"].lower():
            raise ProbeError("PACKAGE_CHANGED")
    seen = set()
    for path in package_tree(package):
        name = path.relative_to(package).as_posix().casefold()
        if name in seen:
            raise ProbeError("INVALID_PACKAGE")
        seen.add(name)
        inert_cache = re.fullmatch(r"share/lmti/python/src/lmti_[a-z_]+/__pycache__/[a-z0-9_.-]+\.pyc", name)
        if name != "manifest.json" and name not in folded and not inert_cache:
            raise ProbeError("INVALID_PACKAGE")
    required = ("bin/lmti-project.exe", "share/lmti/python/src/lmti_agent/client.py",
                "share/lmti/python/src/lmti_agent/source.py", "share/lmti/python/src/lmti_project/client.py",
                "share/lmti/python/src/lmti_common/process.py")
    if any(name not in hashes for name in required):
        raise ProbeError("INVALID_PACKAGE")
    return {"manifestSha256": digest(raw), "manifestFiles": len(hashes), "manifestBytes": total,
            "nativeSha256": hashes[required[0]], "files": hashes}


def import_owners(package: Path, output: Path, hashes: dict):
    # Never consult old package bytecode. Fresh cache prefix + -B force source
    # loading without mutating an immutable package or writing new cache files.
    sys.dont_write_bytecode = True
    sys.pycache_prefix = str(output / "unused-python-cache")
    if any(name.startswith("lmti_") for name in sys.modules):
        raise ProbeError("INVALID_PACKAGE")
    root = checked_path(package / "share/lmti/python/src")
    folded = {name.casefold(): value for name, value in hashes.items()}
    if len(folded) != len(hashes):
        raise ProbeError("INVALID_PACKAGE")
    # Refuse unlisted module sources and linked directories before importing.
    pending = [root]
    discovered = 0
    while pending:
        directory = pending.pop()
        checked_path(directory)
        for path in sorted(directory.iterdir()):
            checked_path(path)
            discovered += 1
            if discovered > 1000:
                raise ProbeError("BUDGET_EXCEEDED")
            if path.is_dir():
                if path.name != "__pycache__":
                    pending.append(path)
            elif path.suffix.lower() == ".py" and path.relative_to(package).as_posix().casefold() not in folded:
                raise ProbeError("INVALID_PACKAGE")
            elif path.suffix.lower() != ".py":
                raise ProbeError("INVALID_PACKAGE")
    sys.path.insert(0, str(root))
    agent = importlib.import_module("lmti_agent.client")
    source = importlib.import_module("lmti_agent.source")
    project = importlib.import_module("lmti_project")
    process = importlib.import_module("lmti_common.process")
    modules = {}
    for name, module in tuple(sys.modules.items()):
        if name.startswith("lmti_"):
            path = checked_path(Path(module.__file__))
            try:
                relative = path.relative_to(package).as_posix()
            except ValueError:
                raise ProbeError("INVALID_PACKAGE") from None
            actual = digest(read_file(path))
            if folded.get(relative.casefold()) != actual:
                raise ProbeError("PACKAGE_CHANGED")
            modules[name] = {"file": relative, "sha256": actual}
    return agent.Client, source.NativeProjectSource, project.Grant, process.read_owner, modules


def machine_context() -> dict:
    cpu = None
    ram = None
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                value = winreg.QueryValueEx(key, "ProcessorNameString")[0]
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9 ()@+.,_-]{1,160}", value.strip()):
                cpu = value.strip()
        except (OSError, ValueError):
            pass
        try:
            import ctypes
            class MemoryStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                    (name, ctypes.c_ulonglong) for name in ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")]
            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                ram = int(status.total)
        except (AttributeError, OSError, ValueError):
            pass
    elif hasattr(os, "sysconf"):
        try:
            ram = int(os.sysconf("SC_PHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError):
            pass
    return {"python": platform.python_version(), "system": platform.system(), "osRelease": platform.release(), "osVersion": platform.version(),
            "architecture": platform.machine(), "cpuModel": cpu, "logicalCores": os.cpu_count(),
            "physicalMemoryBytes": ram, "isolatedPython": bool(sys.flags.isolated),
            "hostnameCollected": False, "processMemoryMeasured": False}


def protocol(counts: list[int], samples: int, warmups: int, page_size: int) -> dict:
    if (not 1 <= len(counts) <= 8 or len(set(counts)) != len(counts)
            or any(type(count) is not int or not 10 <= count <= 10000 for count in counts)
            or type(samples) is not int or not 2 <= samples <= 100
            or type(warmups) is not int or not 0 <= warmups <= 5
            or type(page_size) is not int or not 1 <= page_size <= 200):
        raise ProbeError("INVALID_ARGUMENT")
    return {"schema": "lmti.agent.scale-protocol.v2", "assetCounts": counts,
            "warmupsPerOperation": warmups, "samplesPerOperation": samples, "pageSize": page_size,
            "operations": ["first_page", "last_asset_lookup", "last_asset_related"],
            "concurrency": 1, "verifyAllPages": True, "percentile": "nearest-rank",
            "scope": "packaged native -> packaged Python scoped reads; two native reads per query",
            "fixture": "native init-demo plus isolated public synthetic assets; no new edges",
            "grant": {"projectId": "factory-monitor", "site": "factory-demo", "target": "external"},
            "fixtureVersion": 1, "nativeReadTimeoutSeconds": 10, "runBudgetSeconds": RUN_BUDGET_SECONDS,
            "maxSnapshotBytes": 4 * 1024 * 1024, "maxAgentResponseBytes": 512 * 1024,
            "excluded": ["browser", "web broker", "code/memory context", "live IoT", "concurrent readers",
                         "representative relation density", "cold-cache guarantees", "process CPU/RAM usage"],
            "acceptanceThresholds": None, "acceptancePassed": False}


def workload(count: int, output: Path, package: Path, plan: dict, owners: tuple, deadline: float) -> dict:
    Client, NativeProjectSource, Grant, read_owner, _ = owners
    database = output / f"synthetic-{count}.sqlite"
    entry = {"assets": count, "operations": {}, "error": None}
    before = None
    def budget():
        if time.monotonic() > deadline:
            raise ProbeError("BUDGET_EXCEEDED")
    try:
        budget()
        checked_path(database, missing_leaf=True)
        if database.exists():
            raise ProbeError("OUTPUT_EXISTS")
        binary = package / "bin/lmti-project.exe"
        environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        environment["PATH"] = str(binary.parent)
        environment["QT_PLUGIN_PATH"] = str(binary.parent)
        read_owner([str(binary), "init-demo", str(database)], environment, str(binary.parent), 8192, timeout=15)
        checked_path(database)
        # This is fixture construction, never a measured/runtime Agent read.
        with closing(sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)) as fixture, fixture:
            existing = fixture.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
            if not 1 <= existing < count:
                raise ProbeError("FIXTURE_FAILED")
            fixture.executemany("INSERT INTO assets(id,label,site,kind,privacy,enabled,poll,observed,observed_at,x,y) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                                ((f"probe-{i:05}", f"Synthetic asset {i}", "factory-demo", "sensor", "public", 1,
                                  1000, "unknown", 0, i, 0) for i in range(count - existing)))
        before = digest(read_file(database, 64 * 1024 * 1024))
        entry.update(databaseBytes=database.stat().st_size, fixtureSha256=before)
        client = Client(NativeProjectSource(binary, database, Grant("factory-monitor", "factory-demo"), include_references=True))
        last = f"probe-{count - existing - 1:05}"
        operations = (("first_page", lambda: client.context(plan["pageSize"])),
                      ("last_asset_lookup", lambda: client.entity("asset", last)),
                      ("last_asset_related", lambda: client.related("asset", last, depth=2)))
        for name, call in operations:
            samples, sizes = [], []
            for index in range(plan["warmupsPerOperation"] + plan["samplesPerOperation"]):
                budget()
                started = time.perf_counter()
                result = call()
                elapsed = (time.perf_counter() - started) * 1000
                if result.get("status") == "error":
                    raise ProbeError("READ_FAILED")
                if index >= plan["warmupsPerOperation"]:
                    samples.append(elapsed)
                    sizes.append(len(json.dumps(result, ensure_ascii=False).encode("utf-8")))
            entry["operations"][name] = {"samples": len(samples), "latencyMs": samples,
                                         "medianMs": round(statistics.median(samples), 2),
                                         "p95Ms": round(sorted(samples)[math.ceil(len(samples) * .95) - 1], 2),
                                         "maxPayloadBytes": max(sizes)}
        seen, cursor, pages = set(), None, 0
        while True:
            budget()
            value = client.context(plan["pageSize"], cursor)
            if value.get("status") == "error":
                raise ProbeError("READ_FAILED")
            for row in value["data"]["entities"]:
                identity = (row["identity"]["kind"], row["identity"]["sourceEntityId"])
                if identity in seen:
                    raise ProbeError("PAGINATION_FAILED")
                seen.add(identity)
            pages += 1
            cursor = value["completeness"]["nextCursor"]
            if cursor is None:
                break
            if pages > math.ceil((count + 100) / plan["pageSize"]):
                raise ProbeError("PAGINATION_FAILED")
        if sum(kind == "asset" for kind, _ in seen) != count:
            raise ProbeError("PAGINATION_FAILED")
        entry.update(verifiedEntities=len(seen), verifiedPages=pages)
    except KeyboardInterrupt:
        entry["error"] = "INTERRUPTED"
    except Exception as error:
        entry["error"] = error.code if isinstance(error, ProbeError) else "READ_FAILED"
    finally:
        if before is not None:
            try:
                after = digest(read_file(database, 64 * 1024 * 1024))
                entry.update(afterReadSha256=after, readOnlyBytesUnchanged=after == before)
                if after != before:
                    entry["error"] = "SOURCE_CHANGED"
            except Exception:
                entry["error"] = "SOURCE_CHANGED"
    return entry


def run_baseline(package: Path, output: Path, plan: dict) -> int:
    """Internal runner also permits a workspace-only harness; CLI scope is below."""
    checked_path(package)
    checked_path(output, missing_leaf=True)
    try:
        output.mkdir()
    except FileExistsError:
        raise ProbeError("OUTPUT_EXISTS") from None
    checked_path(output)
    frozen = encoded(plan)
    write_new(output / "protocol.json", frozen)  # Before construction or timing.
    report = {"schema": "lmti.agent.scale-baseline.v2", "protocolSha256": digest(frozen),
              "protocolLockedBeforeRun": True,
              "packageName": package.name, "startedAt": datetime.now(timezone.utc).isoformat(),
              "workloads": [], "error": None,
              "acceptanceThresholds": None, "acceptancePassed": False}
    deadline = time.monotonic() + RUN_BUDGET_SECONDS
    try:
        report["scriptSha256"] = digest(read_file(Path(__file__).absolute()))
        report["runtime"] = machine_context()
        report["pythonExecutableSha256"] = digest(read_file(Path(sys.executable).absolute()))
        evidence = verify_package(package)
        report["package"] = evidence
        owners = import_owners(package, output, evidence["files"])
        report["loadedModules"] = owners[-1]
        for count in plan["assetCounts"]:
            entry = workload(count, output, package, plan, owners, deadline)
            report["workloads"].append(entry)
            write_new(output / f"workload-{count}.json", encoded(entry))
            print(json.dumps({"assets": count, "completed": entry["error"] is None, "error": entry["error"]}), flush=True)
            if entry["error"]:
                report["error"] = entry["error"]
                break
        current = verify_package(package)
        report["packageUnchangedAfterRun"] = current == evidence
        if current != evidence or digest(read_file(output / "protocol.json")) != report["protocolSha256"]:
            raise ProbeError("PACKAGE_CHANGED")
    except KeyboardInterrupt:
        report["error"] = "INTERRUPTED"
    except Exception as error:
        report["error"] = error.code if isinstance(error, ProbeError) else "INTERNAL_ERROR"
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    report["allMeasurementsCompleted"] = report["error"] is None and len(report["workloads"]) == len(plan["assetCounts"])
    write_new(output / "report.json", encoded(report))
    return 0 if report["allMeasurementsCompleted"] else 1


def main(argv=None) -> int:
    parser = Parser(description=__doc__)
    parser.add_argument("--package", required=True, help="Trusted repo-relative build/<package> directory")
    parser.add_argument("--output", help="New repo-relative build/<run> directory; never reused")
    parser.add_argument("--assets", nargs="+", type=int, default=[1000, 10000], help="1-8 distinct counts, each 10..10000")
    parser.add_argument("--samples", type=int, default=10, help="Measured samples per operation, 2..100")
    parser.add_argument("--warmups", type=int, default=2, help="Untimed warmups per operation, 0..5")
    parser.add_argument("--page-size", type=int, default=50, help="Context page size, 1..200")
    args = parser.parse_args(argv)
    if not sys.flags.isolated:
        raise ProbeError("INVALID_ARGUMENT")
    plan = protocol(args.assets, args.samples, args.warmups, args.page_size)
    repo = checked_path(Path(__file__).absolute()).parent.parent
    package = build_child(repo, args.package)
    output_name = args.output or "build/agent-scale-" + uuid.uuid4().hex
    output = build_child(repo, output_name)
    if package == output:
        raise ProbeError("INVALID_ARGUMENT")
    result = run_baseline(package, output, plan)
    print(json.dumps({"output": output_name, "allMeasurementsCompleted": result == 0, "acceptancePassed": False}), flush=True)
    return result


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"error": "INTERRUPTED", "message": "Baseline interrupted; inspect a newly created report if present."}), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        code = error.code if isinstance(error, ProbeError) else "INTERNAL_ERROR"
        print(json.dumps({"error": code, "message": "Baseline unavailable; inspect a newly created report if present."}), file=sys.stderr)
        raise SystemExit(1)
