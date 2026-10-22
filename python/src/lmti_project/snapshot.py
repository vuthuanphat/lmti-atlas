"""Strict validation of the native owner's declared projection, not its SQL model."""
from __future__ import annotations

from typing import Any
import re

from lmti_common.boundary import identifier
from lmti_common.metadata import metadata
from .structure import ASSET_FIELDS, CATALOG_FIELDS, validate_structure

TOP_FIELDS = {"schema", "projectId", "revision", "site", "external", "complete",
              "semantics", "components", "assets", "releases", "bindings",
              "dependencies", "connections"}
FIELDS = {
    "components": {"id", "label", "kind", "privacy"},
    "assets": {"id", "label", "kind", "site", "privacy"},
    "releases": {"id", "label", "componentId", "state", "privacy"},
    "bindings": {"id", "assetId", "componentId", "desiredReleaseId", "privacy"},
    "dependencies": {"id", "from", "to", "contract", "privacy"},
    "connections": {"id", "from", "to", "protocol", "privacy"},
}
LIMITS = {"components": 2000, "assets": 10000, "releases": 2000,
          "bindings": 2000, "dependencies": 2000, "connections": 50000}

def validate_snapshot(value: Any, project_id: str, site: str, external: bool,
                      include_references: bool = False, include_structure: bool = False) -> None:
    if type(include_references) is not bool or type(include_structure) is not bool:
        raise ValueError("Invalid snapshot capability.")
    include_references = include_references or include_structure
    top_fields = TOP_FIELDS | {"repositories", "knowledge"} if include_references else TOP_FIELDS
    fields_by_group = dict(FIELDS)
    limits = dict(LIMITS)
    if include_references:
        fields_by_group["components"] = FIELDS["components"] | {"repositoryId"}
        fields_by_group["repositories"] = {"id", "label", "privacy", "locatorFingerprint"}
        fields_by_group["knowledge"] = {"id", "label", "privacy", "componentId", "referenceFingerprint"}
        limits.update(repositories=2000, knowledge=2000)
    if include_structure:
        top_fields |= {"structureDeclared", *CATALOG_FIELDS}
        fields_by_group["components"] |= {"subsystemId"}
        fields_by_group["assets"] = FIELDS["assets"] | ASSET_FIELDS
        fields_by_group.update(CATALOG_FIELDS)
        limits.update({group: 2000 for group in CATALOG_FIELDS})
    if (not isinstance(value, dict) or set(value) != top_fields or
            value["schema"] != ("lmti.project.snapshot.v3" if include_structure else "lmti.project.snapshot.v2" if include_references else "lmti.project.snapshot.v1") or
            value["projectId"] != project_id or value["site"] != site or
            type(value["external"]) is not bool or value["external"] != external or
            value["complete"] is not True or value["semantics"] != "declared" or
            type(value["revision"]) is not int or not 1 <= value["revision"] <= 9007199254740991):
        raise ValueError("Invalid snapshot envelope.")
    ids: dict[str, set[str]] = {}
    rows: dict[str, dict[str, Any]] = {}
    for group, fields in fields_by_group.items():
        records = value[group]
        if not isinstance(records, list) or len(records) > limits[group]:
            raise ValueError("Snapshot record budget exceeded.")
        ids[group] = set()
        rows[group] = {}
        for record in records:
            if not isinstance(record, dict) or set(record) != fields:
                raise ValueError("Invalid snapshot record.")
            record_id = identifier(record["id"])
            metadata(record_id, 64, required=True)
            if record_id in ids[group] or record["privacy"] not in ("public", "internal"):
                raise ValueError("Duplicate identity or invalid classification.")
            if external and record["privacy"] != "public":
                raise ValueError("Snapshot exceeds external classification.")
            ids[group].add(record_id)
            rows[group][record_id] = record
            if "label" in record:
                metadata(record["label"], 120, required=True)
        if include_structure and [row["id"] for row in records] != sorted(ids[group]):
            raise ValueError("Structure snapshot ordering is invalid.")
    for row in value["components"]:
        if row["kind"] not in ("firmware", "gateway", "backend", "desktop", "driver", "library"):
            raise ValueError("Invalid component type.")
        if include_references and not isinstance(row["repositoryId"], str):
            raise ValueError("Invalid repository reference.")
    for row in value["assets"]:
        if row["site"] != site or row["kind"] not in ("machine", "gateway", "broker", "service", "sensor"):
            raise ValueError("Invalid asset scope or type.")

    def reference(record: dict[str, Any], field: str, group: str) -> None:
        if identifier(record[field]) not in ids[group]:
            raise ValueError("Dangling or unauthorized snapshot reference.")
        if rows[group][record[field]]["privacy"] == "internal" and record["privacy"] != "internal":
            raise ValueError("Invalid inherited classification.")

    if include_references:
        for row in value["components"]:
            if row["repositoryId"]:
                reference(row, "repositoryId", "repositories")
        for group, field in (("repositories", "locatorFingerprint"), ("knowledge", "referenceFingerprint")):
            for row in value[group]:
                if not isinstance(row[field], str) or not re.fullmatch(r"[a-f0-9]{64}", row[field]):
                    raise ValueError("Invalid reference fingerprint.")
        for row in value["knowledge"]:
            if not isinstance(row["componentId"], str):
                raise ValueError("Invalid knowledge reference.")
            if row["componentId"]:
                reference(row, "componentId", "components")

    for row in value["releases"]:
        reference(row, "componentId", "components")
        if row["state"] not in ("draft", "candidate", "approved", "archived"):
            raise ValueError("Invalid release state.")
    for row in value["bindings"]:
        reference(row, "assetId", "assets")
        reference(row, "componentId", "components")
        reference(row, "desiredReleaseId", "releases")
        if rows["releases"][row["desiredReleaseId"]]["componentId"] != row["componentId"]:
            raise ValueError("Binding release does not belong to component.")
    for row in value["dependencies"]:
        reference(row, "from", "components")
        reference(row, "to", "components")
        metadata(row["contract"], 128)
    for row in value["connections"]:
        reference(row, "from", "assets")
        reference(row, "to", "assets")
        if row["protocol"] not in ("dependency", "mqtt", "opcua", "modbus-tcp"):
            raise ValueError("Invalid declared protocol.")
    if include_structure:
        validate_structure(rows, value["structureDeclared"], site)

