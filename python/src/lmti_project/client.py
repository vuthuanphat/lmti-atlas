from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any

from lmti_common.boundary import identifier as validate_identifier, reject_nonfinite, strict_object
from lmti_common.process import ProcessError, read_owner
from lmti_topology.client import TopologyError
from .snapshot import validate_snapshot

class ProjectError(TopologyError):
    """A bounded failure without raw storage contents or locations."""

def identifier(value: Any) -> str:
    try:
        return validate_identifier(value)
    except ValueError as error:
        raise ProjectError("Invalid project object identifier.") from error

@dataclass(frozen=True)
class Grant:
    project_id: str
    site: str
    target: str = "external"

    def __post_init__(self) -> None:
        identifier(self.project_id)
        identifier(self.site)
        if self.target not in ("external", "local"):
            raise ProjectError("Invalid model target.")

class Client:
    _retain_until_closed = False

    def __init__(self, binary: str | Path, database: str | Path, grant: Grant, *,
                 retain_until_closed: bool = False):
        if type(retain_until_closed) is not bool:
            raise ProjectError("Invalid native reader lifetime capability.")
        binary_path, database_path = Path(binary), Path(database)
        if not isinstance(grant, Grant) or any(not p.is_absolute() or p.is_symlink() for p in (binary_path, database_path)):
            raise ProjectError("Trusted absolute runtime/database paths and a fixed grant are required.")
        try:
            self._binary = binary_path.resolve(strict=True)
            self._database = database_path.resolve(strict=True)
            if self._binary.name not in ("lmti-project", "lmti-project.exe") or not self._binary.is_file() or not self._database.is_file() or self._database.stat().st_size > 64 * 1024 * 1024:
                raise ProjectError("Invalid project runtime or database.")
        except OSError as error:
            raise ProjectError("Project runtime or database is unavailable.") from error
        self._grant = grant
        self._retain_until_closed = retain_until_closed

    def _read(self, command: str, argument: str, limit: int) -> dict[str, Any]:
        environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG") if key in os.environ}
        environment["PATH"] = str(self._binary.parent)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        environment["QT_PLUGIN_PATH"] = str(self._binary.parent)
        try:
            output = read_owner(
                [str(self._binary), command, str(self._database), self._grant.project_id,
                 self._grant.site, self._grant.target, argument],
                environment, str(self._binary.parent), 2 * 1024 * 1024,
                **({"retain_until_closed": True} if self._retain_until_closed else {}),
            )
            payload = json.loads(output.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
            self._validate(payload, limit)
            return payload
        except (ProcessError, OSError, UnicodeError, TypeError, KeyError, ValueError, RecursionError) as error:
            raise ProjectError("Project context is unavailable or invalid within the trusted scope.") from error

    def _validate(self, payload: Any, limit: int) -> None:
        if not isinstance(payload, dict) or payload.get("schema") != "lmti.project.context.v1" or payload.get("projectId") != self._grant.project_id or payload.get("site") != self._grant.site or type(payload.get("revision")) is not int or not 1 <= payload["revision"] <= 9_007_199_254_740_991 or type(payload.get("truncated")) is not bool:
            raise ProjectError("Invalid project envelope.")
        ids: dict[str, set[str]] = {}
        for group in ("repositories", "components", "targets", "releases", "assets", "bindings", "dependencies", "milestones", "work", "verification", "knowledge"):
            records = payload[group]
            if not isinstance(records, list) or len(records) > limit:
                raise ProjectError("Project record budget exceeded.")
            ids[group] = set()
            for record in records:
                if not isinstance(record, dict):
                    raise ProjectError("Invalid project record.")
                record_id = identifier(record.get("id"))
                if record_id in ids[group]:
                    raise ProjectError("Duplicate project identity.")
                ids[group].add(record_id)
                if "locator" in record or "reference" in record:
                    raise ProjectError("Local source locators cannot be exported.")
        def check(record: dict[str, Any], field: str, group: str, required: bool = False) -> None:
            value = record.get(field)
            if not isinstance(value, str) or (required and not value) or (value and value not in ids[group]):
                raise ProjectError("Dangling or unauthorized context reference.")
        for asset in payload["assets"]:
            if asset.get("site") != self._grant.site or (self._grant.target == "external" and asset.get("privacy") != "public"):
                raise ProjectError("Asset violates the launcher scope.")
        for component in payload["components"]:
            check(component, "repositoryId", "repositories")
        for release in payload["releases"]:
            check(release, "componentId", "components", True)
            check(release, "targetId", "targets")
        for binding in payload["bindings"]:
            check(binding, "assetId", "assets", True)
            check(binding, "componentId", "components", True)
            check(binding, "desiredReleaseId", "releases", True)
            check(binding, "targetId", "targets")
            if binding.get("observedVersion") != "unknown":
                raise ProjectError("A desired binding cannot prove an observed version.")
        for dependency in payload["dependencies"]:
            check(dependency, "from", "components", True)
            check(dependency, "to", "components", True)
        for work in payload["work"]:
            for field, group in (("componentId", "components"), ("assetId", "assets"), ("releaseId", "releases"), ("milestoneId", "milestones")):
                check(work, field, group)
            if work.get("state") not in ("todo", "in-progress", "review", "done", "blocked"):
                raise ProjectError("Invalid work state.")
        for evidence in payload["verification"]:
            check(evidence, "releaseId", "releases", True)
            check(evidence, "assetId", "assets")
        for knowledge in payload["knowledge"]:
            check(knowledge, "componentId", "components")
        if "affectedComponentIds" in payload:
            affected = payload["affectedComponentIds"]
            if not isinstance(affected, list) or len(affected) > limit or any(c not in ids["components"] for c in affected):
                raise ProjectError("Impact analysis exceeded authorized components.")

    def context(self, limit: int = 100) -> dict[str, Any]:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ProjectError("Context limit must be 1-200.")
        return self._read("context", str(limit), limit)

    def snapshot(self, include_references: bool = False, include_structure: bool = False) -> dict[str, Any]:
        """Complete permitted declared projection through the native owner, capped at 4 MiB."""
        try:
            if type(include_references) is not bool or type(include_structure) is not bool:
                raise ProjectError("Invalid snapshot capability.")
            for path in (self._binary, self._database):
                if path.is_symlink() or path.resolve(strict=True) != path or not path.is_file():
                    raise ProjectError("Project source is unavailable.")
            if self._database.stat().st_size > 64 * 1024 * 1024:
                raise ProjectError("Project source is unavailable.")
            environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG")
                           if key in os.environ}
            environment["PATH"] = str(self._binary.parent)
            if os.name == "nt":
                environment["PATH"] += os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
            environment["QT_PLUGIN_PATH"] = str(self._binary.parent)
            output = read_owner([str(self._binary), "structure-snapshot" if include_structure else "agent-snapshot" if include_references else "snapshot", str(self._database),
                                 self._grant.project_id, self._grant.site, self._grant.target],
                                environment, str(self._binary.parent), 4 * 1024 * 1024,
                                **({"retain_until_closed": True} if self._retain_until_closed else {}))
            payload = json.loads(output.decode("utf-8"), parse_constant=reject_nonfinite,
                                 object_pairs_hook=strict_object)
            validate_snapshot(payload, self._grant.project_id, self._grant.site,
                              self._grant.target == "external", include_references, include_structure)
            return payload
        except (ProcessError, OSError, TypeError, ValueError, KeyError, UnicodeError, RecursionError) as error:
            raise ProjectError("Project source is unavailable or invalid within the trusted scope.") from error

    def impact(self, component_id: str) -> dict[str, Any]:
        return self._read("impact", identifier(component_id), 200)

    def propose_work(self, work_id: str, desired_state: str) -> dict[str, Any]:
        work_id = identifier(work_id)
        if desired_state not in ("review", "blocked"):
            raise ProjectError("Agent proposals may request review or flag a blocker, never claim completion.")
        context = self.context(200)
        work = next((w for w in context["work"] if w["id"] == work_id), None)
        if work is None:
            raise ProjectError("Work item is unavailable in the bounded authorized scope.")
        return {"schema": "lmti.project.work-proposal.v1", "projectId": self._grant.project_id,
                "revision": context["revision"], "workId": work_id,
                "expectedState": work["state"], "desiredState": desired_state}
