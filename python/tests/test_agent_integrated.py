"""Cross-owner orchestration: authorization, provenance, source changes and opt-in MCP."""
from dataclasses import replace
from copy import deepcopy
from unittest.mock import patch
import unittest

from lmti_agent.client import AgentError
from lmti_agent.integrated import IntegratedClient
from lmti_agent.integrated_mcp import IntegratedServer
from lmti_agent.knowledge import KnowledgeError, KnowledgeRead
from lmti_agent.source import Entity, Identity, Relation
from lmti_project import Grant
from test_agent_layer import Source, graph


def with_references():
    original = graph(2)
    repo = Entity(Identity("repository", "repo-demo"), "Demo repository", "public",
                  {"contentState": "not_loaded", "locatorFingerprint": "b" * 64}, "repository")
    doc = Entity(Identity("knowledge", "doc-demo"), "Demo design", "public",
                 {"contentState": "not_loaded", "referenceFingerprint": "c" * 64}, "knowledge")
    edges = (
        Relation(Identity("repository_membership", "component-0000"), "implemented_in",
                 original.entities[0].identity, repo.identity, "public", "declared", {}, "repository_membership"),
        Relation(Identity("knowledge_membership", "doc-demo"), "documented_by",
                 original.entities[0].identity, doc.identity, "public", "declared", {}, "knowledge_membership"),
    )
    return replace(original, entities=original.entities + (repo, doc), relations=original.relations + edges)


class Knowledge:
    grant = Source.grant
    source_id = "d" * 64

    def __init__(self):
        self.calls = []
        self.changed = False
        self.on_read = None

    def read(self, task, references):
        self.calls.append(deepcopy(references))
        if self.on_read:
            self.on_read()
        items = []
        for kind, reference, fingerprint in (("repository", "repo-demo", "b" * 64),
                                              ("knowledge", "doc-demo", "c" * 64),
                                              ("component", "component-0000", "")):
            if (kind, reference, fingerprint) not in references:
                continue
            item_kind = {"repository": "code", "knowledge": "document", "component": "memory"}[kind]
            items.append({"id": "item-" + reference, "kind": item_kind,
                          "referenceKind": kind, "referenceId": reference, "referenceFingerprint": fingerprint,
                          "title": "Allowed summary", "summary": "Firmware sample contract", "classification": "public",
                          "sourcePart": "memory" if kind == "component" else "compiled",
                          "semantics": "reviewed_memory" if kind == "component" else "compiled",
                          "evidenceId": "proof-" + reference, "contentFingerprint": "d" * 64})
        sources = tuple({"sourceId": part + "-demo", "kind": part, "version": {"type": "content_fingerprint", "value": "d" * 64},
                         "checkedAt": "2026-10-19T00:00:00Z", "freshness": {"state": "checked"}}
                        for part in ("compiled", "memory"))
        return KnowledgeRead("d" * 64, ("e" if self.changed and len(self.calls) > 1 else "d") * 64,
                             "2026-10-19T00:00:00Z", sources, tuple(items), ())


class IntegratedTest(unittest.TestCase):
    def setUp(self):
        self.source = Source(with_references())
        self.knowledge = Knowledge()
        self.client = IntegratedClient(self.source, knowledge=self.knowledge)

    def test_combines_compiled_documents_and_memory_with_separate_provenance(self):
        result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["status"], "ok")
        self.assertEqual({item["kind"] for item in result["data"]["contextItems"]}, {"code", "document", "memory"})
        self.assertEqual(len(result["sources"]), 3)
        self.assertEqual(len(self.knowledge.calls), 2)
        self.assertIn(("repository", "repo-demo", "b" * 64), self.knowledge.calls[0])
        proof = {item["evidenceId"]: item for item in result["evidence"]}
        for item in result["data"]["contextItems"]:
            self.assertEqual(proof[item["evidenceId"]]["sourceId"], item["sourcePart"] + "-demo")
        unknowns = [row for row in result["unknowns"] if row["code"] == "CODE_MAPPING_NOT_INCLUDED"]
        self.assertEqual([row["entity"]["sourceEntityId"] for row in unknowns], ["component-0001"])

    def test_hidden_entity_never_reaches_other_owner_and_has_empty_error(self):
        result = self.client.task_context("firmware", "component", "missing")
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        self.assertEqual(self.knowledge.calls, [])
        self.assertIsNone(result["data"])
        self.assertEqual(result["sources"], [])

    def test_owner_revision_change_discards_context(self):
        self.knowledge.changed = True
        result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["error"]["code"], "SOURCE_CHANGED")
        self.assertIsNone(result["data"])

    def test_native_change_during_owner_read_discards_context(self):
        self.knowledge.on_read = lambda: setattr(self.source, "value", replace(self.source.value, revision=2))
        result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["error"]["code"], "SOURCE_CHANGED")

    def test_trusted_config_revoke_blocks_initial_and_inflight_read(self):
        allowed = [True]
        self.client = IntegratedClient(self.source, knowledge=self.knowledge, authorize=lambda: allowed[0])
        self.knowledge.on_read = lambda: allowed.__setitem__(0, False)
        result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        calls = self.source.calls
        self.assertEqual(self.client.context()["error"]["code"], "UNAVAILABLE")
        self.assertEqual(self.source.calls, calls)

    def test_malformed_requests_fail_before_owner_reads(self):
        for task, depth in (("", 2), ("x" * 1001, 2), ("a\0b", 2), ("firmware", True), ("firmware", 5)):
            result = self.client.task_context(task, "component", "component-0000", depth)
            self.assertEqual(result["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(self.source.calls, 0)
        self.assertEqual(self.knowledge.calls, [])

    def test_no_knowledge_returns_explicit_partial_native_context(self):
        result = IntegratedClient(self.source).task_context("firmware", "component", "component-0000")
        self.assertEqual(result["status"], "partial")
        self.assertIn("KNOWLEDGE_SOURCE_NOT_CONFIGURED", result["completeness"]["reasons"])

    def test_owner_failure_does_not_return_exception_or_paths(self):
        with patch.object(self.knowledge, "read", side_effect=KnowledgeError("UNAVAILABLE")):
            result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        self.assertEqual(result["evidence"], [])

    def test_mcp_is_additive_and_rejects_scope_override(self):
        server = IntegratedServer(self.client)
        self.assertEqual(len(server.tools), 5)
        invalid = server.call_tool("lmti_task_context", {"task": "firmware", "kind": "component", "entityId": "component-0000", "sourceRoot": "elsewhere"})
        self.assertEqual(invalid["error"]["code"], "INVALID_ARGUMENT")
        response = server.call_tool("lmti_task_context", {"task": "firmware", "kind": "component", "entityId": "component-0000"})
        self.assertEqual(response["status"], "ok")

    def test_mismatched_knowledge_grant_rejected_at_construction(self):
        self.knowledge.grant = Grant("other-project", "factory-demo")
        with self.assertRaises(AgentError):
            IntegratedClient(self.source, knowledge=self.knowledge)

    def test_permission_callback_failure_is_a_generic_denial(self):
        def failed():
            raise RuntimeError("private configuration detail")
        client = IntegratedClient(self.source, authorize=failed)
        self.assertEqual(client.context()["error"]["code"], "UNAVAILABLE")
        self.assertEqual(self.source.calls, 0)

    def test_duplicate_source_identity_cannot_confuse_evidence(self):
        class Observations:
            grant = Source.grant
            source_id = "native-project"
        with self.assertRaises(AgentError):
            IntegratedClient(self.source, observations=Observations())
        self.client.source_id = "compiled-demo"
        result = self.client.task_context("firmware", "component", "component-0000")
        self.assertEqual(result["error"]["code"], "INVALID_SOURCE_RESPONSE")


if __name__ == "__main__":
    unittest.main()
