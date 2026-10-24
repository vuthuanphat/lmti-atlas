"""Trusted TS owner adapter. No direct AMF/SQLite access by Python or Agent tools."""
from __future__ import annotations

from contextlib import suppress
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
from typing import Any

from lmti_common.boundary import identifier, reject_nonfinite, strict_object
from lmti_common.metadata import metadata
from lmti_project import Grant

MAX_OUTPUT = 512 * 1024
HEX = re.compile(r"[a-f0-9]{64}\Z", re.ASCII)
RESERVED = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)


class KnowledgeError(Exception):
    def __init__(self, code: str = "UNAVAILABLE"):
        self.code = code
        super().__init__("Knowledge owner is unavailable within the trusted scope.")


@dataclass(frozen=True)
class KnowledgeRead:
    source_id: str
    fingerprint: str
    checked_at: str
    sources: tuple[dict[str, Any], ...]
    items: tuple[dict[str, Any], ...]
    reasons: tuple[str, ...]


def _hex(value: Any) -> str:
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError("Invalid fingerprint.")
    return value


def _exact(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("Invalid owner record.")
    return value


def _local_path(value: str | Path) -> Path:
    raw = str(value)
    remainder = re.sub(r"^[A-Za-z]:[\\/]", "", raw)
    if raw.startswith(("\\\\", "//")) or ":" in remainder or any(ord(char) < 32 for char in raw):
        raise ValueError("Local paths are required.")
    selected = Path(value)
    parts = selected.parts[1:]
    if not selected.is_absolute() or any(part in (".", "..") or part.endswith((".", " ")) or RESERVED.match(part) for part in parts):
        raise ValueError("Invalid local path.")
    # Windows junctions are reparse points even when is_symlink is false.
    for candidate in (*reversed(selected.parents), selected):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("Indirect launcher paths are not allowed.")
    if selected.resolve(strict=True) != selected:
        raise ValueError("Indirect launcher paths are not allowed.")
    return selected


def _mapping(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("Invalid mapping.")
    if value.get("kind") == "memory":
        _exact(value, {"kind", "referenceKind", "referenceId", "disclosure"})
        if value["referenceKind"] != "component" or value["disclosure"] != "owner_safe_summary":
            raise ValueError("Invalid memory mapping.")
    else:
        _exact(value, {"kind", "referenceKind", "referenceId", "referenceFingerprint", "path"})
        if value["kind"] not in ("code", "document") or value["referenceKind"] != (
                "repository" if value["kind"] == "code" else "knowledge"):
            raise ValueError("Invalid compiled mapping.")
        _hex(value["referenceFingerprint"])
        metadata(value["path"], 512, required=True)
        parts = value["path"].replace("\\", "/").split("/")
        if ":" in value["path"] or any(not part or part in (".", "..") or part.endswith((".", " ")) or RESERVED.match(part) or
                part.lower() in (".git", ".lmti", ".ssh", ".aws", ".azure", "node_modules") or
                part.lower() == ".env" or part.lower().startswith(".env.") for part in parts):
            raise ValueError("Invalid mapped path.")
        value = {**value, "path": "/".join(parts)}
    identifier(value["referenceId"])
    return dict(value)


class KnowledgeSource:
    """Fixed executable/root/source identity/mappings selected by a trusted launcher.

    The caller must obtain allowed_references from a current native owner read,
    and recheck that read plus this owner immediately before returning context.
    Memory mappings explicitly grant the owner's safe-summary disclosure mode;
    original public/internal classifications remain visible in returned items.
    """

    def __init__(self, node: str | Path, cli: str | Path, root: str | Path,
                 grant: Grant, source_id: str, mappings: list[dict[str, Any]]):
        try:
            if not isinstance(grant, Grant) or not isinstance(mappings, list) or not 1 <= len(mappings) <= 100:
                raise ValueError("Invalid source configuration.")
            self._node, self._cli, self._root = (_local_path(value) for value in (node, cli, root))
            if self._node.name not in ("node", "node.exe") or self._cli.name != "index.js" or not self._root.is_dir():
                raise ValueError("Invalid owner launcher.")
            if not self._node.is_file() or not self._cli.is_file():
                raise ValueError("Invalid owner files.")
            self._grant = grant
            self._source_id = _hex(source_id)
            validated = [_mapping(row) for row in mappings]
            if len({json.dumps(row, sort_keys=True) for row in validated}) != len(validated) or sum(
                    row["kind"] == "memory" for row in validated) > 1:
                raise ValueError("Duplicate mapping.")
            self._mappings_json = json.dumps(validated, sort_keys=True)
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise KnowledgeError("INVALID_ARGUMENT") from error

    @property
    def grant(self) -> Grant:
        return self._grant

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def mappings(self) -> tuple[dict[str, str], ...]:
        # Fresh copies prevent a caller mutating the launcher's retained capability.
        return tuple(json.loads(self._mappings_json))

    def _run_owner(self, request: bytes) -> bytes:
        for value in (self._node, self._cli, self._root):
            if _local_path(value) != value:
                raise KnowledgeError()
        if not self._node.is_file() or not self._cli.is_file() or not self._root.is_dir():
            raise KnowledgeError()
        environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG") if key in os.environ}
        environment["PATH"] = str(self._node.parent)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        output = bytearray()
        overflow, failed = threading.Event(), threading.Event()
        child: subprocess.Popen[bytes] | None = None
        reader: threading.Thread | None = None
        writer: threading.Thread | None = None
        try:
            child = subprocess.Popen([str(self._node), str(self._cli), "agent-context"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=environment, cwd=str(self._cli.parent), shell=False,
                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            assert child.stdin is not None and child.stdout is not None

            def collect() -> None:
                try:
                    while True:
                        data = child.stdout.read(min(65536, MAX_OUTPUT + 1 - len(output)))
                        if not data:
                            break
                        output.extend(data)
                        if len(output) > MAX_OUTPUT:
                            overflow.set()
                            child.kill()
                            break
                except (OSError, ValueError):
                    failed.set()
                finally:
                    with suppress(OSError, ValueError):
                        child.stdout.close()

            def write() -> None:
                try:
                    child.stdin.write(request)
                    child.stdin.close()
                except (OSError, ValueError):
                    failed.set()

            reader = threading.Thread(target=collect, daemon=True)
            writer = threading.Thread(target=write, daemon=True)
            reader.start()
            writer.start()
            child.wait(timeout=10)
            reader.join(timeout=2)
            writer.join(timeout=2)
            if overflow.is_set():
                raise KnowledgeError("BUDGET_EXCEEDED")
            if child.returncode or failed.is_set() or reader.is_alive() or writer.is_alive():
                raise KnowledgeError()
            return bytes(output)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise KnowledgeError() from error
        finally:
            if child is not None:
                with suppress(OSError, subprocess.SubprocessError):
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=2)
                if reader is not None:
                    reader.join(timeout=2)
                if writer is not None:
                    writer.join(timeout=2)
                for stream in (child.stdin, child.stdout):
                    if stream is not None:
                        with suppress(OSError, ValueError):
                            stream.close()

    def read(self, task: str, allowed_references: set[tuple[str, str, str]]) -> KnowledgeRead:
        try:
            metadata(task, 1000, required=True)
            if not isinstance(allowed_references, set):
                raise ValueError("Invalid owner scope.")
            for row in allowed_references:
                if not isinstance(row, tuple) or len(row) != 3 or row[0] not in ("repository", "knowledge", "component"):
                    raise ValueError("Invalid owner scope.")
                identifier(row[1])
                if row[0] == "component":
                    if row[2] != "":
                        raise ValueError("Invalid component fingerprint.")
                else:
                    _hex(row[2])
            mappings = [row for row in self.mappings if (
                row["referenceKind"], row["referenceId"], row.get("referenceFingerprint", "")) in allowed_references]
            if not mappings:
                raise KnowledgeError()
            request = {"schema": "lmti.agent.knowledge.request.v1", "operation": "context",
                       "projectId": self._grant.project_id, "sourceRoot": str(self._root),
                       "sourceId": self.source_id, "target": self._grant.target,
                       "task": task, "limit": 200, "mappings": mappings}
            encoded = json.dumps(request, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(encoded) > 64 * 1024:
                raise KnowledgeError("BUDGET_EXCEEDED")
            raw = self._run_owner(encoded)
            payload = json.loads(raw.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
            return self._validate(payload, mappings)
        except KnowledgeError:
            raise
        except (OSError, UnicodeError, TypeError, ValueError, KeyError, RecursionError) as error:
            raise KnowledgeError("INVALID_SOURCE_RESPONSE") from error

    def _validate(self, payload: Any, mappings: list[dict[str, str]]) -> KnowledgeRead:
        row = _exact(payload, {"schema", "projectId", "sourceId", "target", "classification", "checkedAt",
                               "sources", "items", "completeness", "fingerprint"})
        if (row["schema"] != "lmti.agent.knowledge.v1" or row["projectId"] != self._grant.project_id or
                row["sourceId"] != self.source_id or row["target"] != self._grant.target or row["classification"] not in ("public", "internal")):
            raise ValueError("Invalid source identity.")
        metadata(row["checkedAt"], 64, required=True)
        if not row["checkedAt"].endswith("Z") or datetime.fromisoformat(row["checkedAt"].replace("Z", "+00:00")).utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError("Invalid check time.")
        _hex(row["fingerprint"])
        completeness = _exact(row["completeness"], {"state", "reasons", "nextCursor"})
        reasons = completeness["reasons"]
        allowed_reasons = {"MAPPED_CONTENT_UNAVAILABLE", "COMPILED_CONTENT_STALE", "MEMORY_SOURCE_NOT_CONNECTED", "OWNER_WINDOW_LIMIT", "RESULT_LIMIT"}
        if (not isinstance(reasons, list) or any(not isinstance(value, str) or value not in allowed_reasons for value in reasons) or
                len(set(reasons)) != len(reasons) or completeness["nextCursor"] is not None or
                completeness["state"] != ("partial" if reasons else "complete")):
            raise ValueError("Invalid completeness.")
        if not isinstance(row["sources"], list) or not 1 <= len(row["sources"]) <= 2:
            raise ValueError("Invalid source vector.")
        sources = []
        parts = set()
        for source in row["sources"]:
            _exact(source, {"part", "version", "compiledAt", "freshness", "basis"})
            part = source["part"]
            if part not in ("compiled", "memory") or part in parts or source["freshness"] not in ("checked", "unavailable"):
                raise ValueError("Invalid source part.")
            parts.add(part)
            _hex(source["version"])
            basis = "mapped_source_content_matches_compiled_hash" if part == "compiled" else "read_only_memory_owner_projection"
            if source["basis"] != basis or (part == "compiled" and source["freshness"] != "checked"):
                raise ValueError("Invalid source basis.")
            if part == "compiled":
                metadata(source["compiledAt"], 64, required=True)
                if not source["compiledAt"].endswith("Z"):
                    raise ValueError("Invalid compile time.")
                datetime.fromisoformat(source["compiledAt"].replace("Z", "+00:00"))
            elif source["compiledAt"] is not None:
                raise ValueError("Invalid memory time.")
            sources.append({"sourceId": f"{part}-{self.source_id[:32]}", "kind": "compiled_knowledge" if part == "compiled" else "project_memory",
                            "version": {"type": "content_fingerprint", "value": source["version"]},
                            "checkedAt": row["checkedAt"], "authority": "compiled_project" if part == "compiled" else "memory_owner",
                            "freshness": {"state": source["freshness"], "basis": basis, "sampleAt": None, "ttlSeconds": None}})
        if parts != ({"compiled", "memory"} if any(value["kind"] == "memory" for value in mappings) else {"compiled"}):
            raise ValueError("Invalid requested source parts.")
        if not isinstance(row["items"], list) or len(row["items"]) > 200:
            raise ValueError("Invalid item budget.")
        identities, evidence_ids = set(), set()
        allowed = {(value["kind"], value["referenceKind"], value["referenceId"], value.get("referenceFingerprint", "")) for value in mappings}
        for item in row["items"]:
            _exact(item, {"id", "kind", "referenceKind", "referenceId", "referenceFingerprint", "title", "summary",
                          "classification", "disclosure", "evidenceId", "contentFingerprint", "sourcePart", "semantics"})
            identifier(item["id"])
            identifier(item["evidenceId"])
            if item["id"] in identities or item["evidenceId"] in evidence_ids or (item["kind"], item["referenceKind"], item["referenceId"], item["referenceFingerprint"]) not in allowed:
                raise ValueError("Invalid mapped identity.")
            identities.add(item["id"])
            evidence_ids.add(item["evidenceId"])
            metadata(item["title"], 1000, required=True)
            metadata(item["summary"], 8000, required=True)
            _hex(item["contentFingerprint"])
            expected_part = "memory" if item["kind"] == "memory" else "compiled"
            semantics = ("reviewed_memory", "deliberate_memory") if expected_part == "memory" else ("compiled",)
            classification_allowed = item["classification"] in ("public", "internal") if expected_part == "memory" else item["classification"] == "public"
            expected_disclosure = "owner_safe_summary" if expected_part == "memory" else "public_compiled_summary"
            if not classification_allowed or item["disclosure"] != expected_disclosure or item["sourcePart"] != expected_part or item["semantics"] not in semantics:
                raise ValueError("Invalid knowledge policy.")
        if row["classification"] != ("internal" if any(value["classification"] == "internal" for value in row["items"]) else "public"):
            raise ValueError("Invalid knowledge classification.")
        stable = {"sourceId": row["sourceId"], "sources": row["sources"], "items": row["items"], "reasons": reasons}
        calculated = hashlib.sha256(json.dumps(stable, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
        if calculated != row["fingerprint"]:
            raise ValueError("Invalid knowledge version.")
        return KnowledgeRead(self.source_id, row["fingerprint"], row["checkedAt"],
                             tuple(sources), tuple(deepcopy(row["items"])), tuple(reasons))
