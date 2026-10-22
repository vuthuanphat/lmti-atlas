"""Scoped Agent query boundary; source adapters own validation and data access."""
from __future__ import annotations

import base64
from collections import Counter, defaultdict, deque
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import re
import secrets
import time
from typing import Any, Callable

from lmti_common.boundary import identifier, reject_nonfinite, strict_object
from lmti_common.metadata import metadata
from lmti_project import Grant, ProjectError
from lmti_topology.client import TopologyError
from .source import Entity, GraphRead, Identity, ProjectSource, Relation
from .structure import (ASSET_FIELDS, CATALOG_ATTRIBUTES, ENTITY_LIMITS, RELATION_LIMITS,
                        CONTAINMENT, CONTAINER_KINDS, STRUCTURE_TYPES, validate_graph_structure)

MAX_RESPONSE = 512 * 1024
MAX_WALK_EDGES = 20000
MAX_WALK_NODES = 2000
CURSOR_TTL = 300
KINDS = ("component", "asset", "release", "repository", "knowledge")
ALL_KINDS = tuple(ENTITY_LIMITS)
RELATION_TYPES = ("declared_dependency", "deployed_to_desired", "has_release", "declared_connection",
                  "implemented_in", "documented_by")
ALL_RELATION_TYPES = (*RELATION_TYPES, *STRUCTURE_TYPES)
ERROR_MESSAGES = {
    "INVALID_ARGUMENT": "Request arguments are invalid.",
    "UNAVAILABLE": "Requested data is unavailable in this scope.",
    "NOT_SUPPORTED": "Observation source is not configured for this scope.",
    "STALE_CURSOR": "Cursor is invalid, expired or bound to a different query/source.",
    "SOURCE_CHANGED": "Source changed during the read; request again.",
    "BUDGET_EXCEEDED": "Request exceeded its result budget.",
    "INVALID_SOURCE_RESPONSE": "Source response is invalid.",
}


class AgentError(TopologyError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


def checked_id(value: Any) -> str:
    try:
        return identifier(value)
    except ValueError as error:
        raise AgentError("INVALID_ARGUMENT") from error


class Client:
    def __init__(self, source: ProjectSource, source_id: str = "native-project", *, cursor_key: bytes | None = None):
        self._source = source
        self._grant = source.grant
        self._include_structure = getattr(source, "include_structure", False)
        if type(self._include_structure) is not bool:
            raise AgentError("INVALID_ARGUMENT")
        if not isinstance(self._grant, Grant):
            raise AgentError("INVALID_ARGUMENT")
        self.source_id = checked_id(source_id)
        metadata(self.source_id, 64, required=True)
        metadata(checked_id(source.kind), 64, required=True)
        self._source_kind = source.kind
        checked_id(self._grant.project_id)
        checked_id(self._grant.site)
        metadata(self._grant.project_id, 64, required=True)
        metadata(self._grant.site, 64, required=True)
        if self._grant.target not in ("external", "local"):
            raise AgentError("INVALID_ARGUMENT")
        # Trusted broker may retain a per-session key across fixed one-shot owner calls.
        if cursor_key is not None and (type(cursor_key) is not bytes or len(cursor_key) != 32):
            raise AgentError("INVALID_ARGUMENT")
        self._cursor_key = secrets.token_bytes(32) if cursor_key is None else cursor_key
        policy = {"project": self._grant.project_id, "site": self._grant.site,
                  "target": self._grant.target, "source": self.source_id}
        if self._include_structure:
            policy["structure"] = True
        self._policy = "launcher-" + hashlib.sha256(self._json(policy)).hexdigest()[:24]

    @property
    def include_structure(self) -> bool:
        return self._include_structure

    @staticmethod
    def _json(value: Any) -> bytes:
        return json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")

    def _scope(self) -> dict[str, Any]:
        return {"projectId": self._grant.project_id, "site": self._grant.site,
                "modelTarget": self._grant.target,
                "classification": "public" if self._grant.target == "external" else "internal",
                "policyRevision": self._policy}

    def _error(self, operation: str, code: str) -> dict[str, Any]:
        return {"schema": "lmti.agent.response.v1", "operation": operation, "status": "error",
                "scope": None, "sources": [], "evidence": [],
                "completeness": {"state": "partial", "coverage": "No result returned.",
                                 "reasons": [code], "nextCursor": None},
                "data": None, "unknowns": [], "conflicts": [],
                "error": {"code": code, "message": ERROR_MESSAGES[code],
                          "retryable": code == "SOURCE_CHANGED"}}

    def _execute(self, operation: str, query: Callable[[GraphRead], dict[str, Any]],
                 validate: Callable[[], Any]) -> dict[str, Any]:
        try:
            validate()
            if (self._source.grant != self._grant or
                    getattr(self._source, "include_structure", False) is not self._include_structure):
                raise AgentError("UNAVAILABLE")
            snapshot = self._source.read()
            self._validate_graph(snapshot)
            result = query(snapshot)
            # No cache, filesystem hash or Agent-provided check substitutes for an owner read.
            current = self._source.read()
            if (self._source.grant != self._grant or
                    getattr(self._source, "include_structure", False) is not self._include_structure):
                raise AgentError("UNAVAILABLE")
            self._validate_graph(current)
            if (current.revision != snapshot.revision or current.fingerprint != snapshot.fingerprint or
                    current.structure_declared != snapshot.structure_declared):
                raise AgentError("SOURCE_CHANGED")
            result["sources"][0]["checkedAt"] = current.checked_at
            if len(self._json(result)) > MAX_RESPONSE:
                raise AgentError("BUDGET_EXCEEDED")
            return result
        except AgentError as error:
            return self._error(operation, error.code)
        except ProjectError:
            return self._error(operation, "UNAVAILABLE")
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            return self._error(operation, "INVALID_SOURCE_RESPONSE")

    def _validate_graph(self, snapshot: GraphRead) -> None:
        if (not isinstance(snapshot, GraphRead) or type(snapshot.revision) is not int or
                not 1 <= snapshot.revision <= 9007199254740991 or
                not isinstance(snapshot.fingerprint, str) or
                not re.fullmatch(r"[a-f0-9]{64}", snapshot.fingerprint) or
                not isinstance(snapshot.entities, tuple) or len(snapshot.entities) > sum(ENTITY_LIMITS.values()) or
                not isinstance(snapshot.relations, tuple) or len(snapshot.relations) > sum(RELATION_LIMITS.values()) or
                (snapshot.structure_declared is not None and type(snapshot.structure_declared) is not bool)):
            raise ValueError("Invalid graph response.")
        metadata(snapshot.checked_at, 64, required=True)
        if not snapshot.checked_at.endswith("Z") or datetime.fromisoformat(snapshot.checked_at.replace("Z", "+00:00")).utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError("Invalid source check timestamp.")
        entities: dict[Identity, Entity] = {}
        entity_counts = Counter()
        structured = snapshot.structure_declared is not None
        if structured != self._include_structure:
            raise ValueError("Source structure capability does not match its projection.")
        for row in snapshot.entities:
            if not isinstance(row, Entity) or not isinstance(row.identity, Identity) or row.identity.kind not in ALL_KINDS:
                raise ValueError("Invalid entity response.")
            identifier(row.identity.source_entity_id)
            metadata(row.identity.source_entity_id, 64, required=True)
            metadata(row.label, 120, required=True)
            if (row.identity in entities or row.classification not in ("public", "internal") or
                    (self._grant.target == "external" and row.classification != "public") or
                    row.evidence_kind != row.identity.kind or not isinstance(row.attributes, dict)):
                raise ValueError("Invalid entity policy or reference.")
            attrs = row.attributes
            if row.identity.kind == "component":
                if set(attrs) != ({"componentType", "subsystemId"} if structured else {"componentType"}) or attrs["componentType"] not in (
                        "firmware", "gateway", "backend", "desktop", "driver", "library"):
                    raise ValueError("Invalid component attributes.")
            elif row.identity.kind == "asset":
                if (set(attrs) != ({"assetType", "site", "observedVersion"} | (ASSET_FIELDS if structured else set())) or attrs["site"] != self._grant.site or
                        attrs["assetType"] not in ("machine", "gateway", "broker", "service", "sensor") or
                        attrs["observedVersion"] != "unknown"):
                    raise ValueError("Invalid declared asset attributes.")
            elif row.identity.kind == "release":
                if set(attrs) != {"state"} or attrs["state"] not in ("draft", "candidate", "approved", "archived"):
                    raise ValueError("Invalid release attributes.")
            elif row.identity.kind in CATALOG_ATTRIBUTES:
                if not structured or set(attrs) != CATALOG_ATTRIBUTES[row.identity.kind]:
                    raise ValueError("Invalid structure catalog attributes.")
            else:
                field = "locatorFingerprint" if row.identity.kind == "repository" else "referenceFingerprint"
                if (set(attrs) != {"contentState", field} or attrs["contentState"] != "not_loaded" or
                        not isinstance(attrs[field], str) or not re.fullmatch(r"[a-f0-9]{64}", attrs[field])):
                    raise ValueError("Invalid unloaded reference attributes.")
            entities[row.identity] = row
            entity_counts[row.identity.kind] += 1
            if entity_counts[row.identity.kind] > ENTITY_LIMITS[row.identity.kind]:
                raise ValueError("Entity kind budget exceeded.")
        relations: set[Identity] = set()
        relation_counts = Counter()
        kinds = {"declared_dependency": ("dependency", "component", "component", "declared", {"contract"}, "dependency"),
                 "deployed_to_desired": ("binding", "release", "asset", "desired", set(), "binding"),
                 "has_release": ("release_membership", "component", "release", "declared", set(), "release"),
                 "declared_connection": ("connection", "asset", "asset", "declared", {"protocol"}, "connection"),
                 "implemented_in": ("repository_membership", "component", "repository", "declared", set(), "repository_membership"),
                 "documented_by": ("knowledge_membership", "component", "knowledge", "declared", set(), "knowledge_membership"),
                 "contains_subsystem": ("subsystem_containment", "subsystem", "subsystem", "declared", set(), "subsystem_containment"),
                 "contains_component": ("component_containment", "subsystem", "component", "declared", set(), "component_containment"),
                 "contains_area": ("area_containment", ("site", "area"), "area", "declared", set(), "area_containment"),
                 "contains_asset": ("asset_containment", ("site", "area", "asset"), "asset", "declared", set(), "asset_containment"),
                 "in_environment": ("environment_membership", "asset", "environment", "declared", set(), "environment_membership")}
        for row in snapshot.relations:
            if (not isinstance(row, Relation) or not isinstance(row.identity, Identity) or
                    not isinstance(row.type, str) or row.type not in kinds or
                    row.identity in relations or row.start not in entities or row.end not in entities):
                raise ValueError("Invalid relationship response.")
            identifier(row.identity.source_entity_id)
            metadata(row.identity.source_entity_id, 64, required=True)
            kind, start, end, semantics, fields, evidence_kind = kinds[row.type]
            if (row.identity.kind != kind or row.start.kind not in ((start,) if isinstance(start, str) else start) or row.end.kind != end or
                    row.semantics != semantics or row.evidence_kind != evidence_kind or
                    row.classification not in ("public", "internal") or
                    (self._grant.target == "external" and row.classification != "public") or
                    (any(entities[key].classification == "internal" for key in (row.start, row.end)) and
                     row.classification != "internal") or
                    not isinstance(row.attributes, dict) or set(row.attributes) != fields):
                raise ValueError("Invalid relationship policy or semantics.")
            if row.type == "declared_dependency":
                metadata(row.attributes["contract"], 128)
            if row.type == "declared_connection" and row.attributes["protocol"] not in (
                    "dependency", "mqtt", "opcua", "modbus-tcp"):
                raise ValueError("Invalid declared connection.")
            relations.add(row.identity)
            relation_counts[row.identity.kind] += 1
            if relation_counts[row.identity.kind] > RELATION_LIMITS[row.identity.kind]:
                raise ValueError("Relationship kind budget exceeded.")
        validate_graph_structure(snapshot, self._grant.site)

    @staticmethod
    def _limit(limit: Any) -> int:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise AgentError("INVALID_ARGUMENT")
        return limit

    @staticmethod
    def _cursor_shape(cursor: Any) -> None:
        if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 1024):
            raise AgentError("INVALID_ARGUMENT")

    def invalid_request(self, operation: str) -> dict[str, Any]:
        if operation not in ("project.context", "project.entity", "project.related", "project.observations"):
            raise AgentError("INVALID_ARGUMENT")
        return self._error(operation, "INVALID_ARGUMENT")

    def _identity(self, kind: Any, entity_id: Any) -> Identity:
        permitted_kinds = ALL_KINDS if self.include_structure else KINDS
        if not isinstance(kind, str) or kind not in permitted_kinds:
            raise AgentError("INVALID_ARGUMENT")
        return Identity(kind, checked_id(entity_id))

    def _evidence_id(self, kind: str, entity_id: str) -> str:
        return "ref-" + hashlib.sha256(self._json([self.source_id, kind, entity_id])).hexdigest()[:32]

    def _result(self, operation: str, snapshot: GraphRead, entities: list[Entity],
                relations: list[Relation], coverage: str, reasons: list[str],
                cursor: str | None) -> dict[str, Any]:
        evidence: dict[str, dict[str, Any]] = {}

        def proof(kind: str, entity_id: str, basis: str) -> str:
            evidence_id = self._evidence_id(kind, entity_id)
            evidence[evidence_id] = {"evidenceId": evidence_id, "sourceId": self.source_id,
                                    "sourceRevision": snapshot.revision,
                                    "reference": {"kind": kind, "sourceEntityId": entity_id},
                                    "basis": basis}
            return evidence_id

        rows = [{"identity": row.identity.json(self.source_id), "label": row.label,
                 "classification": row.classification, "semantics": "declared",
                 "attributes": deepcopy(row.attributes),
                 "evidenceIds": [proof(row.evidence_kind, row.identity.source_entity_id, "owner_declaration")]}
                for row in entities]
        edges = [{"identity": row.identity.json(self.source_id), "type": row.type,
                  "from": row.start.json(self.source_id), "to": row.end.json(self.source_id),
                  "classification": row.classification, "semantics": row.semantics,
                  "direction": "stored_from_to", "attributes": deepcopy(row.attributes),
                  "evidenceIds": [proof(row.evidence_kind, row.identity.source_entity_id,
                                        "desired_declaration" if row.semantics == "desired" else "owner_declaration")]}
                 for row in relations]
        unknowns = [{"code": "OBSERVATION_SOURCE_NOT_CONFIGURED", "field": "observedVersion",
                     "entity": row.identity.json(self.source_id)}
                    for row in entities if row.identity.kind == "asset"]
        unknowns += [{"code": "CODE_MAPPING_NOT_INCLUDED", "entity": row.identity.json(self.source_id)}
                     for row in entities if row.identity.kind == "component"]
        unknowns += [{"code": "REFERENCE_CONTENT_NOT_LOADED", "entity": row.identity.json(self.source_id)}
                     for row in entities if row.identity.kind in ("repository", "knowledge")]
        partial = bool(reasons or cursor)
        return {"schema": "lmti.agent.response.v1", "operation": operation,
                "status": "partial" if partial else "ok", "scope": self._scope(),
                "sources": [{"sourceId": self.source_id, "kind": self._source_kind,
                             "version": {"type": "owner_revision", "value": snapshot.revision},
                             "checkedAt": snapshot.checked_at, "authority": "declared_structure",
                             "freshness": {"state": "checked", "basis": "saved_owner_projection",
                                           "sampleAt": None, "ttlSeconds": None}}],
                "evidence": list(evidence.values()),
                "completeness": {"state": "partial" if partial else "complete", "coverage": coverage,
                                 "reasons": reasons, "nextCursor": cursor},
                "data": {"entities": rows, "relations": edges, "observations": []},
                "unknowns": unknowns, "conflicts": [], "error": None}

    def _offset(self, cursor: Any, query: dict[str, Any], snapshot: GraphRead, *, fingerprint: str | None = None) -> int:
        if cursor is None:
            return 0
        if not isinstance(cursor, str) or len(cursor) > 1024:
            raise AgentError("STALE_CURSOR")
        try:
            encoded, signature = cursor.split(".")
            expected = hmac.new(self._cursor_key, encoded.encode("ascii"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                raise ValueError()
            raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
            token = json.loads(raw, parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
            if (not isinstance(token, dict) or set(token) != {"v", "q", "f", "o", "e", "p"} or
                    token["v"] != 1 or token["q"] != hashlib.sha256(self._json(query)).hexdigest() or
                    token["p"] != self._policy or
                    token["f"] != (fingerprint if fingerprint is not None else self._cursor_fingerprint(snapshot)) or type(token["o"]) is not int or token["o"] < 1 or
                    type(token["e"]) is not int or token["e"] < time.time()):
                raise ValueError()
            return token["o"]
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            raise AgentError("STALE_CURSOR") from error

    def _cursor_fingerprint(self, snapshot: GraphRead) -> str:
        return (snapshot.fingerprint if snapshot.structure_declared is None else
                hashlib.sha256(self._json([snapshot.fingerprint, snapshot.structure_declared])).hexdigest())

    def _cursor(self, offset: int, query: dict[str, Any], snapshot: GraphRead, *, fingerprint: str | None = None) -> str:
        token = {"v": 1, "p": self._policy, "q": hashlib.sha256(self._json(query)).hexdigest(),
                 "f": fingerprint if fingerprint is not None else self._cursor_fingerprint(snapshot),
                 "o": offset, "e": int(time.time()) + CURSOR_TTL}
        encoded = base64.urlsafe_b64encode(self._json(token)).decode("ascii").rstrip("=")
        return encoded + "." + hmac.new(self._cursor_key, encoded.encode(), hashlib.sha256).hexdigest()

    def context(self, limit: int = 100, cursor: str | None = None) -> dict[str, Any]:
        operation = "project.context"

        def query(snapshot: GraphRead) -> dict[str, Any]:
            size = self._limit(limit)
            request = {"operation": operation, "limit": size}
            offset = self._offset(cursor, request, snapshot)
            if offset > len(snapshot.entities):
                raise AgentError("STALE_CURSOR")
            selected = list(snapshot.entities[offset:offset + size])
            more = offset + len(selected) < len(snapshot.entities)
            next_cursor = self._cursor(offset + size, request, snapshot) if more else None
            return self._result(operation, snapshot, selected, [], "Authorized entity inventory only; use related for edges.",
                                ["RESULT_PAGE_LIMIT"] if more else [], next_cursor)

        def validate() -> None:
            self._limit(limit)
            self._cursor_shape(cursor)

        return self._execute(operation, query, validate)

    def entity(self, kind: str, entity_id: str) -> dict[str, Any]:
        operation = "project.entity"

        def query(snapshot: GraphRead) -> dict[str, Any]:
            identity = self._identity(kind, entity_id)
            row = next((row for row in snapshot.entities if row.identity == identity), None)
            if row is None:
                raise AgentError("UNAVAILABLE")
            return self._result(operation, snapshot, [row], [], "Authorized identity lookup.", [], None)

        return self._execute(operation, query, lambda: self._identity(kind, entity_id))

    def related(self, kind: str, entity_id: str, depth: int = 2, limit: int = 100,
                direction: str = "both", relation_types: list[str] | None = None,
                cursor: str | None = None) -> dict[str, Any]:
        operation = "project.related"

        def query(snapshot: GraphRead) -> dict[str, Any]:
            identity = self._identity(kind, entity_id)
            size = self._limit(limit)
            if type(depth) is not int or not 1 <= depth <= 8 or direction not in ("both", "outbound", "inbound"):
                raise AgentError("INVALID_ARGUMENT")
            permitted_types = ALL_RELATION_TYPES if snapshot.structure_declared is not None else RELATION_TYPES
            types = list(permitted_types) if relation_types is None else relation_types
            if (not isinstance(types, list) or not 1 <= len(types) <= len(permitted_types) or
                    any(not isinstance(value, str) or value not in permitted_types for value in types) or
                    len(set(types)) != len(types)):
                raise AgentError("INVALID_ARGUMENT")
            request = {"operation": operation, "kind": kind, "entityId": entity_id,
                       "depth": depth, "limit": size, "direction": direction, "relationTypes": sorted(types)}
            offset = self._offset(cursor, request, snapshot)
            entity_map = {row.identity: row for row in snapshot.entities}
            if identity not in entity_map:
                raise AgentError("UNAVAILABLE")
            adjacent: dict[Identity, list[tuple[Relation, Identity]]] = defaultdict(list)
            for edge in snapshot.relations:
                if edge.type not in types:
                    continue
                if direction in ("both", "outbound"):
                    adjacent[edge.start].append((edge, edge.end))
                if direction in ("both", "inbound"):
                    adjacent[edge.end].append((edge, edge.start))
            reached = {identity}
            pending = deque([(identity, 0, "normal")])
            reached_states = {(identity, "normal")}
            found: dict[Identity, Relation] = {}
            examined = 0
            exhausted = False
            while pending and not exhausted:
                node, level, mode = pending.popleft()
                if level == depth:
                    continue
                for edge, other in adjacent[node]:
                    next_mode = mode
                    if edge.type in CONTAINMENT:
                        descending = edge.start == node
                        explicit_container = (identity.kind in CONTAINER_KINDS or
                                              (identity.kind == "asset" and relation_types is not None))
                        if descending and not (mode == "down" or (node == identity and explicit_container)):
                            continue
                        next_mode = "down" if descending else "up"
                    elif edge.type == "in_environment":
                        if edge.start == node:
                            next_mode = "up"
                        elif node == identity and identity.kind == "environment":
                            next_mode = "down"
                        else:
                            continue
                    elif mode == "up":
                        continue
                    examined += 1
                    if examined > MAX_WALK_EDGES or (other not in reached and len(reached) >= MAX_WALK_NODES):
                        exhausted = True
                        break
                    found[edge.identity] = edge
                    reached.add(other)
                    if (other, next_mode) not in reached_states:
                        reached_states.add((other, next_mode))
                        pending.append((other, level + 1, next_mode))
            rows = sorted(found.values(), key=lambda edge: edge.identity)
            if offset > len(rows):
                raise AgentError("STALE_CURSOR")
            selected = rows[offset:offset + size]
            endpoints = {identity}
            for edge in selected:
                endpoints.update((edge.start, edge.end))
            more = offset + len(selected) < len(rows)
            next_cursor = self._cursor(offset + size, request, snapshot) if more and not exhausted else None
            reasons = (["TRAVERSAL_BUDGET"] if exhausted else []) + (["RESULT_PAGE_LIMIT"] if more else [])
            return self._result(operation, snapshot, [entity_map[key] for key in sorted(endpoints)],
                                selected, "Declared relations within requested depth/direction/type; no causal-impact claim.",
                                reasons, next_cursor)

        def validate() -> None:
            self._identity(kind, entity_id)
            self._limit(limit)
            self._cursor_shape(cursor)
            if (type(depth) is not int or not 1 <= depth <= 8 or not isinstance(direction, str) or
                    direction not in ("both", "outbound", "inbound")):
                raise AgentError("INVALID_ARGUMENT")
            permitted_types = ALL_RELATION_TYPES if self.include_structure else RELATION_TYPES
            if relation_types is not None and (not isinstance(relation_types, list) or
                    not 1 <= len(relation_types) <= len(permitted_types) or
                    any(not isinstance(item, str) or item not in permitted_types for item in relation_types) or
                    len(set(relation_types)) != len(relation_types)):
                raise AgentError("INVALID_ARGUMENT")

        return self._execute(operation, query, validate)

    def observations(self, asset_id: str) -> dict[str, Any]:
        operation = "project.observations"

        def query(snapshot: GraphRead) -> dict[str, Any]:
            identity = self._identity("asset", asset_id)
            if not any(row.identity == identity for row in snapshot.entities):
                raise AgentError("UNAVAILABLE")
            raise AgentError("NOT_SUPPORTED")

        return self._execute(operation, query, lambda: self._identity("asset", asset_id))

