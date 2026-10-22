"""Native owner adapter. DTOs are transient boundary views, never a domain/store."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Protocol

from lmti_project import Client as ProjectClient, Grant


@dataclass(frozen=True, order=True)
class Identity:
    kind: str
    source_entity_id: str

    def json(self, source_id: str) -> dict[str, str]:
        return {"sourceId": source_id, "kind": self.kind,
                "sourceEntityId": self.source_entity_id}


@dataclass(frozen=True)
class Entity:
    identity: Identity
    label: str
    classification: str
    attributes: dict[str, Any]
    evidence_kind: str


@dataclass(frozen=True)
class Relation:
    identity: Identity
    type: str
    start: Identity
    end: Identity
    classification: str
    semantics: str
    attributes: dict[str, Any]
    evidence_kind: str


@dataclass(frozen=True)
class GraphRead:
    revision: int
    fingerprint: str
    checked_at: str
    entities: tuple[Entity, ...]
    relations: tuple[Relation, ...]
    structure_declared: bool | None = None


class ProjectSource(Protocol):
    grant: Grant
    kind: str

    def read(self) -> GraphRead: ...


class NativeProjectSource:
    """Reads only through the trusted native CLI; no DB connection or cached grant."""
    kind = "native_project"

    def __init__(self, binary: str | Path, database: str | Path, grant: Grant,
                 include_references: bool = False, include_structure: bool = False, *,
                 retain_until_closed: bool = False):
        if (type(include_references) is not bool or type(include_structure) is not bool
                or type(retain_until_closed) is not bool):
            raise ValueError("Invalid reference capability.")
        self.grant = grant
        self._include_references = include_references or include_structure
        self._include_structure = include_structure
        self._retain_until_closed = retain_until_closed
        self._owner = ProjectClient(binary, database, grant,
                                    **({"retain_until_closed": True} if retain_until_closed else {}))

    @property
    def include_structure(self) -> bool:
        """Trusted constructor capability; request arguments cannot change it."""
        return self._include_structure

    @property
    def retain_until_closed(self) -> bool:
        """Trusted constructor lifetime; tool arguments cannot enable/disable it."""
        return self._retain_until_closed

    def read(self) -> GraphRead:
        snapshot = (self._owner.snapshot(self._include_references, include_structure=True)
                    if self._include_structure else self._owner.snapshot(self._include_references))
        checked = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False,
                                         separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        entities: list[Entity] = []
        relations: list[Relation] = []
        for group, kind, evidence_kind in (("components", "component", "component"),
                                           ("assets", "asset", "asset"),
                                           ("releases", "release", "release")):
            for row in snapshot[group]:
                attributes: dict[str, Any]
                if kind == "component":
                    attributes = {"componentType": row["kind"]}
                elif kind == "asset":
                    attributes = {"assetType": row["kind"], "site": row["site"],
                                  "observedVersion": "unknown"}
                else:
                    attributes = {"state": row["state"]}
                entities.append(Entity(Identity(kind, row["id"]), row["label"],
                                       row["privacy"], attributes, evidence_kind))
        for row in snapshot["dependencies"]:
            relations.append(Relation(Identity("dependency", row["id"]), "declared_dependency",
                                      Identity("component", row["from"]), Identity("component", row["to"]),
                                      row["privacy"], "declared", {"contract": row["contract"]}, "dependency"))
        for row in snapshot["bindings"]:
            relations.append(Relation(Identity("binding", row["id"]), "deployed_to_desired",
                                      Identity("release", row["desiredReleaseId"]), Identity("asset", row["assetId"]),
                                      row["privacy"], "desired", {}, "binding"))
        for row in snapshot["releases"]:
            relations.append(Relation(Identity("release_membership", row["id"]), "has_release",
                                      Identity("component", row["componentId"]), Identity("release", row["id"]),
                                      row["privacy"], "declared", {}, "release"))
        for row in snapshot["connections"]:
            relations.append(Relation(Identity("connection", row["id"]), "declared_connection",
                                      Identity("asset", row["from"]), Identity("asset", row["to"]),
                                      row["privacy"], "declared", {"protocol": row["protocol"]}, "connection"))
        if self._include_references:
            for group, kind, field in (("repositories", "repository", "locatorFingerprint"),
                                       ("knowledge", "knowledge", "referenceFingerprint")):
                for row in snapshot[group]:
                    entities.append(Entity(Identity(kind, row["id"]), row["label"], row["privacy"],
                                           {"contentState": "not_loaded", field: row[field]}, kind))
            rows_by_id = {row.identity: row for row in entities}

            def linked(kind: str, entity_id: str, relation_type: str,
                       start: Identity, end: Identity) -> None:
                privacy = "public" if all(rows_by_id[key].classification == "public"
                                           for key in (start, end)) else "internal"
                relations.append(Relation(Identity(kind, entity_id), relation_type, start, end,
                                          privacy, "declared", {}, kind))

            for row in snapshot["components"]:
                if row["repositoryId"]:
                    linked("repository_membership", row["id"], "implemented_in",
                           Identity("component", row["id"]), Identity("repository", row["repositoryId"]))
            for row in snapshot["knowledge"]:
                if row["componentId"]:
                    linked("knowledge_membership", row["id"], "documented_by",
                           Identity("component", row["componentId"]), Identity("knowledge", row["id"]))
        if self._include_structure:
            from .structure import append_structure
            append_structure({group: {row["id"]: row for row in snapshot[group]}
                              for group in ("components", "assets", "subsystems", "sites", "areas", "environments")}, entities, relations)
        return GraphRead(snapshot["revision"], digest, checked,
                         tuple(sorted(entities, key=lambda item: item.identity)),
                         tuple(sorted(relations, key=lambda item: item.identity)),
                         snapshot["structureDeclared"] if self._include_structure else None)

