"""Reviewed-only composition; manual knowledge protocol and tools stay unchanged."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path
import subprocess
import threading
import time

from lmti_project import ProjectError
from .client import AgentError, MAX_RESPONSE
from .knowledge import KnowledgeSource, KnowledgeError, MAX_OUTPUT
from .mappings import MappingFailure, MappingSource, canonical, tagged, wait_closed
from .source import Identity
from .structure import task_neighborhood

TASK_SECONDS = 240
FINAL_NATIVE_RESERVE = 12


class _ClosedKnowledgeSource(KnowledgeSource):
    """Same request/reply, but a timeout cannot release a still-live child."""
    def _run_owner(self, request: bytes) -> bytes:
        environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        environment["PATH"] = str(self._node.parent)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(Path(environment.get("SystemRoot", r"C:\Windows")) / "System32")
        child = subprocess.Popen([str(self._node), str(self._cli), "agent-context"], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False,
                                 cwd=str(self._cli.parent), env=environment,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        output, failed = bytearray(), threading.Event()

        def terminate():
            failed.set()
            if child.poll() is None:
                try: child.kill()
                except OSError: pass

        def drain():
            try:
                while True:
                    chunk = child.stdout.read(65536)
                    if not chunk: break
                    if len(output) + len(chunk) > MAX_OUTPUT:
                        terminate()
                    elif not failed.is_set():
                        output.extend(chunk)
            except OSError: failed.set()

        def send():
            try:
                child.stdin.write(request); child.stdin.close()
            except (OSError, ValueError): failed.set()

        timer, started, closed = None, [], False
        try:
            timer = threading.Timer(10, terminate)
            timer.daemon = True
            workers = [threading.Thread(target=drain, daemon=True), threading.Thread(target=send, daemon=True)]
            try:
                timer.start()
                for worker in workers:
                    worker.start()
                    started.append(worker)
            except Exception as error:
                terminate()
                try: child.stdin.close()
                except (OSError, ValueError): pass
                if workers[0] not in started: drain()
                wait_closed(child); closed = True
                for worker in started: worker.join()
                raise KnowledgeError() from error
            code = wait_closed(child); closed = True  # Caller may fail earlier; session remains BUSY.
            for worker in started: worker.join()
            if code != 0 or failed.is_set():
                raise KnowledgeError()
            return bytes(output)
        finally:
            if not closed:
                terminate()
                try: child.stdin.close()
                except (OSError, ValueError): pass
                wait_closed(child)
            for worker in started: worker.join()
            if timer is not None: timer.cancel()
            for stream in (child.stdin, child.stdout):
                if stream is not None: stream.close()


def _reason(error):
    if isinstance(error, KnowledgeError):
        return "REVIEWED_KNOWLEDGE_UNAVAILABLE"
    code = error.code if isinstance(error, MappingFailure) else "OWNER_UNAVAILABLE"
    if code == "BUSY": return "REVIEWED_MAPPING_BUSY"
    if code == "BUDGET_EXCEEDED": return "REVIEWED_MAPPING_BUDGET"
    if code in {"SOURCE_CHANGED", "NATIVE_CHANGED", "CONFIG_CHANGED"}: return "REVIEWED_MAPPING_CHANGED"
    return "REVIEWED_MAPPING_UNAVAILABLE"


class _Refused(Exception):
    def __init__(self, reason):
        self.reason = reason


class ReviewedKnowledge:
    def __init__(self, mapping: MappingSource, integration_hash: str):
        self.mapping = mapping
        self.integration_hash = integration_hash
        self.grant = mapping.grant
        self.source_id = mapping.binding["sourceId"]
        self._lock, self._busy = threading.Lock(), False

    def _check(self, client, deadline, abandoned):
        if time.monotonic() >= deadline or abandoned.is_set():
            raise AgentError("BUDGET_EXCEEDED")
        if not client._permitted():
            raise AgentError("UNAVAILABLE")
        if (client._source.grant != client._grant or not client.include_structure
                or getattr(client._source, "include_structure", False) is not True
                or self.grant != client._grant):
            raise AgentError("UNAVAILABLE")

    def _native_result(self, client, snapshot, kind, entity_id, depth):
        identity = Identity(kind, entity_id)
        rows = {row.identity: row for row in snapshot.entities}
        if identity not in rows:
            raise AgentError("UNAVAILABLE")
        visited, limited = task_neighborhood(snapshot, identity, depth)
        entities = [rows[key] for key in sorted(visited)]
        all_edges = [edge for edge in snapshot.relations if edge.start in visited and edge.end in visited]
        edges = all_edges[:1000]
        limited = limited or len(all_edges) > 1000
        result = client._result("project.task_context", snapshot, entities, edges,
                                "Current authorized native neighborhood and reviewed owner associations.",
                                ["NEIGHBORHOOD_BUDGET"] if limited else [], None)
        result["data"].update(contextItems=[], mappingAssociations=[], mappingReview=None)
        return result, entities

    def _partial(self, result, reason):
        result["data"].update(contextItems=[], mappingAssociations=[], mappingReview=None)
        result["status"] = "partial"
        result["completeness"].update(state="partial", nextCursor=None)
        if reason not in result["completeness"]["reasons"]:
            result["completeness"]["reasons"].append(reason)
        result["unknowns"].append({"code": reason})
        return result

    def task_context(self, client, task, kind, entity_id, depth=2, limit=100, cursor=None):
        operation = "project.task_context"
        try:
            client._identity(kind, entity_id)
            if (not isinstance(task, str) or not task.strip() or len(task.encode("utf-8")) > 1000
                    or any(ord(c) < 32 for c in task) or type(depth) is not int or not 1 <= depth <= 4):
                raise AgentError("INVALID_ARGUMENT")
            client._limit(limit); client._cursor_shape(cursor)
        except (AgentError, UnicodeError) as error:
            return client._error(operation, error.code if isinstance(error, AgentError) else "INVALID_ARGUMENT")
        with self._lock:
            if self._busy or not self.mapping.is_idle():
                result = client._error(operation, "UNAVAILABLE")
                result["completeness"]["reasons"] = ["REVIEWED_MAPPING_BUSY"]
                return result
            self._busy = True
        deadline, abandoned, done, result = time.monotonic() + TASK_SECONDS, threading.Event(), threading.Event(), {}

        def work():
            try:
                result["value"] = self._collect(client, task, kind, entity_id, depth, limit, cursor, deadline, abandoned)
            except AgentError as error:
                result["value"] = client._error(operation, error.code)
            except ProjectError:
                result["value"] = client._error(operation, "UNAVAILABLE")
            except Exception:
                result["value"] = client._error(operation, "INVALID_SOURCE_RESPONSE")
            finally:
                with self._lock: self._busy = False
                done.set()

        try:
            # Normal MCP EOF holds the session until all admitted owners close.
            threading.Thread(target=work, daemon=False).start()
        except Exception:
            with self._lock: self._busy = False
            return client._error(operation, "UNAVAILABLE")
        if not done.wait(max(0, deadline - time.monotonic())):
            abandoned.set()
            return client._error(operation, "BUDGET_EXCEEDED")
        return result["value"]

    def _collect(self, client, task, kind, entity_id, depth, limit, cursor, deadline, abandoned):
        self._check(client, deadline, abandoned)
        try:
            self.mapping.check_native()
        except MappingFailure as error:
            raise AgentError("UNAVAILABLE") from error
        snapshot = client._source.read()
        client._validate_graph(snapshot)
        self._check(client, deadline, abandoned)
        result, entities = self._native_result(client, snapshot, kind, entity_id, depth)
        failure, projected = None, None
        try:
            self.mapping.check()
            self._check(client, deadline, abandoned)
            if deadline - time.monotonic() <= FINAL_NATIVE_RESERVE:
                raise MappingFailure("BUDGET_EXCEEDED")
            first = self.mapping.read(deadline - FINAL_NATIVE_RESERVE)
            if first["nativeObservation"]["revision"] != snapshot.revision:
                raise MappingFailure("NATIVE_CHANGED")
            allowed_entities = {(row.identity.kind, row.identity.source_entity_id): row for row in entities}
            eligible = [current for current in first["mappings"]
                        if (current["mapping"]["target"]["kind"], current["mapping"]["target"]["id"]) in allowed_entities]
            allowed_refs = {(row.identity.kind, row.identity.source_entity_id,
                             row.attributes.get("locatorFingerprint" if row.identity.kind == "repository" else "referenceFingerprint", ""))
                            for row in entities if row.identity.kind in {"repository", "knowledge", "component"}}
            for current in eligible:
                m = current["mapping"]
                native = allowed_entities[(m["target"]["kind"], m["target"]["id"])]
                if native.classification == "internal" and current["effectiveClassification"] != "internal":
                    raise MappingFailure("NATIVE_CHANGED")
                if m["kind"] in {"code", "document"} and (
                        m["target"]["kind"], m["target"]["id"], m["referenceFingerprint"]) not in allowed_refs:
                    raise MappingFailure("NATIVE_CHANGED")
            content = [row for row in eligible if row["mapping"]["kind"] != "identity"]
            memory = [row for row in content if row["mapping"]["kind"] == "memory"]
            if len(content) > 100 or len(memory) > 1:
                raise _Refused("REVIEWED_SELECTION_LIMIT")
            if memory and self.mapping.binding["memoryDisclosure"] != "owner_safe_summary":
                raise _Refused("REVIEWED_MEMORY_DENIED")
            selectors = {}
            for current in content:
                m = current["mapping"]
                selector = {"kind": m["kind"], "referenceKind": m["target"]["kind"], "referenceId": m["target"]["id"]}
                if m["kind"] == "memory":
                    selector["disclosure"] = "owner_safe_summary"
                else:
                    selector.update(referenceFingerprint=m["referenceFingerprint"], path=m["selection"].replace("\\", "/"))
                selectors[canonical(selector)] = selector
            knowledge = None
            if selectors:
                b = self.mapping.binding
                self._check(client, deadline, abandoned)
                if deadline - time.monotonic() <= FINAL_NATIVE_RESERVE + 12:
                    raise MappingFailure("BUDGET_EXCEEDED")
                owner = _ClosedKnowledgeSource(b["node"], b["cli"], b["root"], client._grant,
                                               b["sourceId"], [selectors[key] for key in sorted(selectors)])
                self.mapping.check()
                knowledge = owner.read(task, allowed_refs)
                self._check(client, deadline, abandoned); self.mapping.check()
                if deadline - time.monotonic() <= FINAL_NATIVE_RESERVE + 12:
                    raise MappingFailure("BUDGET_EXCEEDED")
                checked = owner.read(task, allowed_refs)
                self._check(client, deadline, abandoned); self.mapping.check()
                if knowledge.fingerprint != checked.fingerprint:
                    raise MappingFailure("SOURCE_CHANGED")
            self._check(client, deadline, abandoned)
            if deadline - time.monotonic() <= FINAL_NATIVE_RESERVE:
                raise MappingFailure("BUDGET_EXCEEDED")
            second = self.mapping.read(deadline - FINAL_NATIVE_RESERVE)
            if first["fingerprint"] != second["fingerprint"] or second["nativeObservation"]["revision"] != snapshot.revision:
                raise MappingFailure("SOURCE_CHANGED")
            self.mapping.check()
            projected = self._project(client, second, eligible, knowledge, task, kind, entity_id, depth, limit, cursor, snapshot)
        except _Refused as error:
            failure = error.reason
        except (MappingFailure, KnowledgeError) as error:
            failure = _reason(error)
        self._check(client, deadline, abandoned)
        # Final native proof is mandatory even for a native-only partial.
        try:
            self.mapping.check_native()
        except MappingFailure as error:
            raise AgentError("UNAVAILABLE") from error
        current = client._source.read()
        client._validate_graph(current)
        self._check(client, deadline, abandoned)
        if (current.revision != snapshot.revision or current.fingerprint != snapshot.fingerprint
                or current.structure_declared != snapshot.structure_declared):
            raise AgentError("SOURCE_CHANGED")
        try:
            self.mapping.check_native()
        except MappingFailure as error:
            raise AgentError("UNAVAILABLE") from error
        result["sources"][0]["checkedAt"] = current.checked_at
        if failure:
            if cursor is not None:
                raise AgentError("STALE_CURSOR")
            self._partial(result, failure)
        else:
            try:
                self.mapping.check()
            except MappingFailure:
                if cursor is not None: raise AgentError("STALE_CURSOR")
                self._partial(result, "REVIEWED_MAPPING_CHANGED")
            else:
                result["data"].update(projected["data"])
                result["sources"].extend(projected["sources"])
                result["evidence"].extend(projected["evidence"])
                result["completeness"]["reasons"].extend(projected["reasons"])
                result["completeness"]["nextCursor"] = projected["cursor"]
                if any(row["classification"] == "internal" for row in
                       result["data"]["contextItems"] + result["data"]["mappingAssociations"]):
                    result["scope"]["classification"] = "internal"
                if projected["memory"]:
                    result["scope"]["knowledgeDisclosure"] = "owner_safe_summary"
                if result["completeness"]["reasons"]:
                    result["status"] = "partial"
                    result["completeness"]["state"] = "partial"
        if len({row["sourceId"] for row in result["sources"]}) != len(result["sources"]):
            raise AgentError("INVALID_SOURCE_RESPONSE")
        if len(client._json(result)) > MAX_RESPONSE:
            if cursor is not None: raise AgentError("BUDGET_EXCEEDED")
            result, _ = self._native_result(client, current, kind, entity_id, depth)
            self._partial(result, "REVIEWED_MAPPING_BUDGET")
            if len(client._json(result)) > MAX_RESPONSE: raise AgentError("BUDGET_EXCEEDED")
        self._check(client, deadline, abandoned)
        return result

    def _project(self, client, value, eligible, knowledge, task, kind, entity_id, depth, limit, cursor, snapshot):
        source_id = "mapping-" + tagged("lmti.agent.mapping-source.v1", [value["storeUuid"], value["sourceId"]])[:56]
        bindings = {(b["mappingId"], b["evidenceId"]): b for b in value["evidenceBindings"]}
        proof, mapping_proofs, seen_proofs = {}, {}, set()
        for current in eligible:
            m = current["mapping"]; ids = []
            for eid in m["evidenceIds"]:
                origin = bindings[(m["mappingId"], eid)]
                opaque = "map-evidence-" + tagged("lmti.agent.mapping-evidence.v1",
                    [value["storeUuid"], value["sourceId"], m["mappingId"], origin["evidenceBatchId"], eid])[:40]
                if opaque in seen_proofs: raise AgentError("INVALID_SOURCE_RESPONSE")
                seen_proofs.add(opaque); ids.append(opaque)
                proof[opaque] = {"evidenceId": opaque, "sourceId": source_id,
                                "sourceRevision": value["accepted"]["mappingVersion"],
                                "reference": {"kind": "reviewed_mapping", "sourceEntityId": "mapping-" + m["mappingId"]},
                                "basis": "accepted_mapping_evidence"}
            mapping_proofs[m["mappingId"]] = sorted(ids)
        associations = [{"mappingId": row["mapping"]["mappingId"], "kind": row["mapping"]["kind"],
                         "target": {"sourceId": client.source_id, "kind": row["mapping"]["target"]["kind"],
                                    "sourceEntityId": row["mapping"]["target"]["id"]},
                         "classification": row["effectiveClassification"],
                         "evidenceIds": mapping_proofs[row["mapping"]["mappingId"]], "semantics": "reviewed_association"}
                        for row in eligible]
        associations.sort(key=lambda row: row["mappingId"])
        items = []
        if knowledge:
            for item in knowledge.items:
                matches = [row for row in eligible if row["mapping"]["kind"] == item["kind"]
                           and row["mapping"]["target"]["kind"] == item["referenceKind"]
                           and row["mapping"]["target"]["id"] == item["referenceId"]
                           and row["mapping"].get("referenceFingerprint", "") == item["referenceFingerprint"]]
                if not matches: raise AgentError("INVALID_SOURCE_RESPONSE")
                ids = sorted(row["mapping"]["mappingId"] for row in matches)
                items.append({**deepcopy(item), "ownerClassification": item["classification"],
                              "ownerFingerprint": knowledge.fingerprint, "mappingContributors": ids,
                              "mappingEvidenceIds": sorted({eid for mid in ids for eid in mapping_proofs[mid]}),
                              "classification": "internal" if item["classification"] == "internal" or any(
                                  row["effectiveClassification"] == "internal" for row in matches) else "public"})
        items.sort(key=lambda row: (row["id"], row["kind"], row["referenceKind"], row["referenceId"]))
        b = self.mapping.binding
        fingerprint = tagged("lmti.agent.reviewed-context.v1", {
            "nativeFingerprint": snapshot.fingerprint, "nativeRevision": snapshot.revision,
            "mappingFingerprint": value["fingerprint"], "knowledgeFingerprint": knowledge.fingerprint if knowledge else None,
            "integrationHash": self.integration_hash, "mappingConfigHash": b["mappingOwner"]["configSha256"],
            "nodeHash": b["nodeSha256"], "knowledgeHash": b["cliSha256"], "mappingHash": b["mappingOwner"]["cliSha256"]})
        query = {"operation": "project.task_context.reviewed.v1", "task": task, "kind": kind,
                 "entityId": entity_id, "depth": depth, "limit": limit}
        offset = client._offset(cursor, query, snapshot, fingerprint=fingerprint)
        sequence = [("association", row) for row in associations] + [("context", row) for row in items]
        if offset > len(sequence): raise AgentError("STALE_CURSOR")
        page = sequence[offset:offset + limit]
        more = offset + len(page) < len(sequence)
        next_cursor = client._cursor(offset + len(page), query, snapshot, fingerprint=fingerprint) if more else None
        selected_associations = [row for tag, row in page if tag == "association"]
        selected_items = [row for tag, row in page if tag == "context"]
        selected_proofs = {eid for row in selected_associations for eid in row["evidenceIds"]}
        selected_proofs.update(eid for row in selected_items for eid in row["mappingEvidenceIds"])
        sources = [{"sourceId": source_id, "kind": "reviewed_mapping",
                    "version": {"type": "mapping_current_fingerprint", "value": value["fingerprint"]},
                    "checkedAt": value["checkedAt"], "authority": "accepted_current_mapping",
                    "freshness": {"state": "checked", "basis": "source_and_native_rechecked", "sampleAt": None, "ttlSeconds": None}}]
        evidence = [proof[key] for key in sorted(selected_proofs)]
        if knowledge:
            sources.extend(deepcopy(knowledge.sources))
            for item in selected_items:
                source = next((s for s in knowledge.sources if s["sourceId"].startswith(item["sourcePart"] + "-")), None)
                if source is None: raise AgentError("INVALID_SOURCE_RESPONSE")
                evidence.append({"evidenceId": item["evidenceId"], "sourceId": source["sourceId"],
                                 "sourceRevision": source["version"]["value"],
                                 "reference": {"kind": item["kind"], "sourceEntityId": item["id"]}, "basis": item["semantics"]})
        if len({row["evidenceId"] for row in evidence}) != len(evidence):
            raise AgentError("INVALID_SOURCE_RESPONSE")
        review = {"sourceId": source_id, "accepted": deepcopy(value["accepted"]), "impactGraphRevision": value["graphRevision"],
                  "sourceVersion": {"revision": value["source"]["revision"], "digest": value["source"]["digest"]},
                  "sourceObservationFingerprint": value["sourceObservation"]["fingerprint"],
                  "sourceContentFingerprint": value["sourceContentFingerprint"],
                  "native": {"sourceId": client.source_id, "revision": value["nativeObservation"]["revision"],
                             "fingerprint": value["nativeObservation"]["fingerprint"]},
                  "mappingFingerprint": value["fingerprint"], "knowledgeFingerprint": knowledge.fingerprint if knowledge else None,
                  "checkedAt": value["checkedAt"]}
        return {"data": {"contextItems": selected_items, "mappingAssociations": selected_associations, "mappingReview": review},
                "sources": sources, "evidence": evidence, "cursor": next_cursor,
                "reasons": list(knowledge.reasons if knowledge else ()) + (["RESULT_PAGE_LIMIT"] if more else []),
                "memory": any(row["mapping"]["kind"] == "memory" for row in eligible)}
