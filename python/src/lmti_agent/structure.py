"""Directed hierarchy projection and checks, separate from generic relationships."""
from __future__ import annotations

from collections import defaultdict, deque

from lmti_project.structure import ASSET_FIELDS, CATALOG_FIELDS, validate_structure
from .source import Entity, Identity, Relation

GROUP_KINDS = {"subsystems": "subsystem", "sites": "site", "areas": "area", "environments": "environment"}
CONTAINMENT = ("contains_subsystem", "contains_component", "contains_area", "contains_asset")
STRUCTURE_TYPES = (*CONTAINMENT, "in_environment")
CONTAINER_KINDS = ("subsystem", "site", "area", "environment")
ENTITY_LIMITS = {"component": 2000, "asset": 10000, "release": 2000, "repository": 2000,
                 "knowledge": 2000, **{kind: 2000 for kind in GROUP_KINDS.values()}}
RELATION_LIMITS = {"dependency": 2000, "binding": 2000, "release_membership": 2000, "connection": 50000,
                   "repository_membership": 2000, "knowledge_membership": 2000,
                   "subsystem_containment": 2000, "component_containment": 2000,
                   "area_containment": 2000, "asset_containment": 10000, "environment_membership": 10000}
CATALOG_ATTRIBUTES = {kind: CATALOG_FIELDS[group] - {"id", "label", "privacy"} for group, kind in GROUP_KINDS.items()}


def declarations(rows):
    for row in rows["subsystems"].values():
        if row["parentSubsystemId"]:
            yield "subsystem_containment", row["id"], "contains_subsystem", Identity("subsystem", row["parentSubsystemId"]), Identity("subsystem", row["id"])
    for row in rows["components"].values():
        if row["subsystemId"]:
            yield "component_containment", row["id"], "contains_component", Identity("subsystem", row["subsystemId"]), Identity("component", row["id"])
    for row in rows["areas"].values():
        parent = Identity("area", row["parentAreaId"]) if row["parentAreaId"] else Identity("site", row["siteId"])
        yield "area_containment", row["id"], "contains_area", parent, Identity("area", row["id"])
    for row in rows["assets"].values():
        if row["placementDeclared"]:
            parent = (Identity("asset", row["parentAssetId"]) if row["parentAssetId"] else
                      Identity("area", row["areaId"]) if row["areaId"] else Identity("site", row["site"]))
            yield "asset_containment", row["id"], "contains_asset", parent, Identity("asset", row["id"])
        if row["environmentId"]:
            yield "environment_membership", row["id"], "in_environment", Identity("asset", row["id"]), Identity("environment", row["environmentId"])


def append_structure(snapshot, entities, relations):
    for index, entity in enumerate(entities):
        if entity.identity.kind == "component":
            fields = {"subsystemId"}
            group = "components"
        elif entity.identity.kind == "asset":
            fields = ASSET_FIELDS
            group = "assets"
        else:
            continue
        # Snapshot groups are bounded and indexed once below, never ancestry-expanded.
        # The caller supplies the map to avoid a scan for every asset.
        row = snapshot[group][entity.identity.source_entity_id]
        entities[index] = Entity(entity.identity, entity.label, entity.classification,
                                 {**entity.attributes, **{key: row[key] for key in fields}}, entity.evidence_kind)
    for group, kind in GROUP_KINDS.items():
        for row in snapshot[group].values():
            entities.append(Entity(Identity(kind, row["id"]), row["label"], row["privacy"],
                                   {key: row[key] for key in CATALOG_ATTRIBUTES[kind]}, kind))
    by_id = {row.identity: row for row in entities}
    for kind, key, relation_type, start, end in declarations(snapshot):
        privacy = "internal" if any(by_id[node].classification == "internal" for node in (start, end)) else "public"
        relations.append(Relation(Identity(kind, key), relation_type, start, end, privacy, "declared", {}, kind))


def validate_graph_structure(snapshot, site):
    enabled = snapshot.structure_declared is not None
    if not enabled:
        if any(row.identity.kind in GROUP_KINDS.values() for row in snapshot.entities) or any(row.type in STRUCTURE_TYPES for row in snapshot.relations):
            raise ValueError("Structure capability is absent.")
        return
    rows = {group: {} for group in (*GROUP_KINDS, "components", "assets")}
    kind_groups = {kind: group for group, kind in GROUP_KINDS.items()}
    kind_groups.update(component="components", asset="assets")
    for row in snapshot.entities:
        if row.identity.kind not in kind_groups:
            continue
        attrs = row.attributes
        if row.identity.kind == "component":
            attrs = {"subsystemId": attrs["subsystemId"]}
        elif row.identity.kind == "asset":
            attrs = {key: attrs[key] for key in ASSET_FIELDS | {"site"}}
        rows[kind_groups[row.identity.kind]][row.identity.source_entity_id] = {
            "id": row.identity.source_entity_id, "privacy": row.classification, **attrs}
    validate_structure(rows, snapshot.structure_declared, site)
    expected = {Identity(kind, key): (relation_type, start, end)
                for kind, key, relation_type, start, end in declarations(rows)}
    actual = {row.identity: row for row in snapshot.relations if row.type in STRUCTURE_TYPES}
    if set(actual) != set(expected):
        raise ValueError("Missing or unexpected structure relationship.")
    entities = {row.identity: row for row in snapshot.entities}
    for identity, (relation_type, start, end) in expected.items():
        row = actual[identity]
        privacy = "internal" if any(entities[key].classification == "internal" for key in (start, end)) else "public"
        if (row.type, row.start, row.end, row.classification, row.semantics, row.attributes, row.evidence_kind) != (
                relation_type, start, end, privacy, "declared", {}, identity.kind):
            raise ValueError("Structure relationship does not match its declaration.")


def task_neighborhood(snapshot, identity, depth):
    """Useful edges first, then ancestors; never re-expand an added ancestor."""
    ordinary, children, parents, environment = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    for edge in snapshot.relations:
        if edge.type in CONTAINMENT:
            children[edge.start].append(edge.end)
            parents[edge.end].append(edge.start)
        elif edge.type == "in_environment":
            environment[edge.start].append(edge.end)
            if identity.kind == "environment":
                children[edge.end].append(edge.start)
        else:
            ordinary[edge.start].append(edge.end)
            ordinary[edge.end].append(edge.start)
    visited, limited, examined = {identity}, False, 0

    def add(other):
        nonlocal limited
        if other in visited:
            return False
        if len(visited) >= 200:
            limited = True
            return False
        visited.add(other)
        return True

    adjacent = children if identity.kind in CONTAINER_KINDS else ordinary
    pending = deque([(identity, 0)])
    while pending:
        current, level = pending.popleft()
        if level >= depth:
            continue
        for other in sorted(adjacent[current]):
            examined += 1
            if examined > 20000:
                limited = True
                pending.clear()
                break
            if add(other):
                pending.append((other, level + 1))
    # This queue follows parents only. A shared site/subsystem/environment never
    # opens a second path to siblings, including siblings with shared labels.
    pending = deque(sorted(visited))
    while pending:
        current = pending.popleft()
        for other in sorted(parents[current]):
            if add(other):
                pending.append(other)
        for other in sorted(environment[current]):
            add(other)  # Membership is contextual metadata, not containment.
    return visited, limited
