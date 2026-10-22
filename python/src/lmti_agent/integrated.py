"""Opt-in cross-owner context. Each owner retains its policy, version and storage."""
from __future__ import annotations

from collections import deque
from typing import Any, Callable

from .client import AgentError, Client
from .knowledge import KnowledgeError, KnowledgeSource
from .observations import ObservationError, ObservationSource, read_observations
from .source import GraphRead, Identity
from .structure import task_neighborhood


class IntegratedClient(Client):
    def __init__(self, source, source_id: str = "native-project", *,
                 knowledge: KnowledgeSource | None = None,
                 observations: ObservationSource | None = None,
                 authorize: Callable[[], bool] | None = None, cursor_key: bytes | None = None,
                 reviewed=None):
        super().__init__(source, source_id, cursor_key=cursor_key)
        self.knowledge = knowledge
        self.observation_source = observations
        self._authorize = authorize or (lambda: True)
        self.reviewed = reviewed
        if reviewed is not None:
            if knowledge is not None or not self.include_structure or reviewed.grant != self._grant:
                raise AgentError("INVALID_ARGUMENT")
            # V3 has its own cursor policy; legacy policies remain byte-identical.
            self._policy += "-reviewed-" + reviewed.integration_hash[:16]
        for owner in (knowledge, observations):
            if owner is not None and owner.grant != self._grant:
                raise AgentError("INVALID_ARGUMENT")
        ids = [self.source_id]
        if knowledge is not None:
            ids.extend(part + "-" + knowledge.source_id[:32] for part in ("compiled", "memory"))
        if reviewed is not None:
            ids.extend(part + "-" + reviewed.source_id[:32] for part in ("compiled", "memory"))
            from .mappings import tagged
            config = reviewed.mapping.config
            ids.append("mapping-" + tagged("lmti.agent.mapping-source.v1",
                [config["storeUuid"], config["authority"]["sourceId"]])[:56])
        if observations is not None:
            ids.append(observations.source_id)
        if len(ids) != len(set(ids)):
            raise AgentError("INVALID_ARGUMENT")

    def _permitted(self) -> bool:
        try:
            return self._authorize() is True
        except Exception:
            return False

    def _execute(self, operation, query, validate):
        if not self._permitted():
            return self._error(operation, "UNAVAILABLE")
        if self.reviewed is not None:
            from .mappings import MappingFailure
            try:
                self.reviewed.mapping.check_native()
            except MappingFailure:
                return self._error(operation, "UNAVAILABLE")
        result = super()._execute(operation, query, validate)
        if not self._permitted():
            return self._error(operation, "UNAVAILABLE")
        if self.reviewed is not None:
            try:
                self.reviewed.mapping.check_native()
            except MappingFailure:
                return self._error(operation, "UNAVAILABLE")
        if result.get("status") != "error":
            ids = [source["sourceId"] for source in result["sources"]]
            if len(ids) != len(set(ids)):
                return self._error(operation, "INVALID_SOURCE_RESPONSE")
        return result

    def invalid_request(self, operation: str) -> dict[str, Any]:
        if operation == "project.task_context":
            return self._error(operation, "INVALID_ARGUMENT")
        return super().invalid_request(operation)

    def task_context(self, task: str, kind: str, entity_id: str,
                     depth: int = 2, *, limit: int = 100, cursor: str | None = None) -> dict[str, Any]:
        operation = "project.task_context"
        if self.reviewed is not None:
            return self.reviewed.task_context(self, task, kind, entity_id, depth, limit, cursor)
        if limit != 100 or cursor is not None:
            return self.invalid_request(operation)

        def validate():
            self._identity(kind, entity_id)
            if (not isinstance(task, str) or not task.strip() or len(task.encode("utf-8")) > 1000 or
                    any(ord(c) < 32 for c in task) or
                    type(depth) is not int or not 1 <= depth <= 4):
                raise AgentError("INVALID_ARGUMENT")

        def query(snapshot: GraphRead):
            identity = self._identity(kind, entity_id)
            rows = {row.identity: row for row in snapshot.entities}
            if identity not in rows:
                raise AgentError("UNAVAILABLE")
            if snapshot.structure_declared is not None:
                visited, limited = task_neighborhood(snapshot, identity, depth)
            else:
                adjacent: dict[Identity, list[Identity]] = {}
                for edge in snapshot.relations:
                    adjacent.setdefault(edge.start, []).append(edge.end)
                    adjacent.setdefault(edge.end, []).append(edge.start)
                visited = {identity}
                pending = deque([(identity, 0)])
                limited = False
                while pending:
                    current, level = pending.popleft()
                    if level >= depth:
                        continue
                    for other in sorted(adjacent.get(current, [])):
                        if other in visited:
                            continue
                        if len(visited) >= 200:
                            limited = True
                            continue
                        visited.add(other)
                        pending.append((other, level + 1))
            entities = [rows[key] for key in sorted(visited)]
            edges = [edge for edge in snapshot.relations
                     if edge.start in visited and edge.end in visited]
            if len(edges) > 1000:
                edges = edges[:1000]
                limited = True
            result = self._result(operation, snapshot, entities, edges,
                                  "Task context from an authorized bounded declared neighborhood and configured owners.",
                                  ["NEIGHBORHOOD_BUDGET"] if limited else [], None)
            result["data"]["contextItems"] = []
            if self.knowledge is None:
                result["unknowns"].append({"code": "KNOWLEDGE_SOURCE_NOT_CONFIGURED"})
                result["completeness"]["reasons"].append("KNOWLEDGE_SOURCE_NOT_CONFIGURED")
            else:
                if self.knowledge.grant != self._grant:
                    raise AgentError("UNAVAILABLE")
                allowed = set()
                for entity in entities:
                    reference_kind = entity.identity.kind
                    if reference_kind not in ("component", "repository", "knowledge"):
                        continue
                    field = "locatorFingerprint" if reference_kind == "repository" else "referenceFingerprint"
                    allowed.add((reference_kind, entity.identity.source_entity_id,
                                 entity.attributes.get(field, "")))
                try:
                    projected = self.knowledge.read(task, allowed)
                    checked = self.knowledge.read(task, allowed)
                except KnowledgeError as error:
                    raise AgentError(error.code) from error
                if (not self._permitted() or self.knowledge.grant != self._grant):
                    raise AgentError("UNAVAILABLE")
                if projected.fingerprint != checked.fingerprint:
                    raise AgentError("SOURCE_CHANGED")
                result["sources"].extend(checked.sources)
                result["data"]["contextItems"] = list(projected.items)
                if any(mapping.get("kind") == "memory" and mapping.get("disclosure") == "owner_safe_summary"
                       for mapping in getattr(self.knowledge, "mappings", ())):
                    result["scope"]["knowledgeDisclosure"] = "owner_safe_summary"
                if any(item["classification"] == "internal" for item in projected.items):
                    result["scope"]["classification"] = "internal"
                result["completeness"]["reasons"].extend(projected.reasons)
                for item in projected.items:
                    # The item remains attributed to its owner, separately from native declarations.
                    source = next((source for source in checked.sources
                                   if source["sourceId"].startswith(item["sourcePart"] + "-")), None)
                    if source is None:
                        raise AgentError("INVALID_SOURCE_RESPONSE")
                    result["evidence"].append({
                        "evidenceId": item["evidenceId"], "sourceId": source["sourceId"],
                        "sourceRevision": source["version"]["value"],
                        "reference": {"kind": item["kind"], "sourceEntityId": item["id"]},
                        "basis": item["semantics"],
                    })
                compiled_refs = {(item["referenceKind"], item["referenceId"])
                                 for item in projected.items if item["kind"] in ("code", "document")}
                code_repositories = {item["referenceId"] for item in projected.items if item["kind"] == "code"}
                mapped_components = {edge.start.source_entity_id for edge in edges
                                     if edge.type == "implemented_in" and edge.end.source_entity_id in code_repositories}
                result["unknowns"] = [unknown for unknown in result["unknowns"]
                    if not (unknown["code"] == "REFERENCE_CONTENT_NOT_LOADED" and
                            (unknown["entity"]["kind"], unknown["entity"]["sourceEntityId"]) in compiled_refs)
                    and not (unknown["code"] == "CODE_MAPPING_NOT_INCLUDED" and
                             unknown["entity"]["sourceEntityId"] in mapped_components)]
            if result["completeness"]["reasons"]:
                result["status"] = "partial"
                result["completeness"]["state"] = "partial"
            return result

        return self._execute(operation, query, validate)

    def observations(self, asset_id: str) -> dict[str, Any]:
        if self.observation_source is None:
            return super().observations(asset_id)
        operation = "project.observations"

        def query(snapshot: GraphRead):
            identity = self._identity("asset", asset_id)
            entity = next((row for row in snapshot.entities if row.identity == identity), None)
            if entity is None:
                raise AgentError("UNAVAILABLE")
            try:
                observed = read_observations(self.observation_source, self._grant, asset_id)
            except ObservationError as error:
                raise AgentError(error.code) from error
            result = self._result(operation, snapshot, [entity], [],
                                  "Configured source observations for one authorized asset; desired bindings remain separate.", [], None)
            result["sources"].append(observed["source"])
            result["evidence"].extend(observed["evidence"])
            result["data"]["observations"] = observed["observations"]
            result["unknowns"] = observed["unknowns"]
            result["conflicts"] = observed["conflicts"]
            if observed["unknowns"] or observed["conflicts"]:
                result["status"] = "partial"
                result["completeness"].update(state="partial", reasons=["OBSERVATION_LIMITATIONS"])
            return result

        return self._execute(operation, query, lambda: self._identity("asset", asset_id))
