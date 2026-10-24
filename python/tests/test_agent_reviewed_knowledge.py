"""Reviewed composition with controlled owners; real package chain is separate."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from lmti_agent.integrated import IntegratedClient
from lmti_agent.integrated_mcp import IntegratedServer
from lmti_agent.integration_config import _load_settings, load_integrated_client, load_integrated_native_client
from lmti_agent.knowledge import KnowledgeRead
from lmti_agent.mappings import MappingFailure, checked_snapshot
from lmti_agent.reviewed_knowledge import ReviewedKnowledge, _ClosedKnowledgeSource
from lmti_agent.source import NativeProjectSource
from lmti_project import Grant
from test_agent_mappings import current, encoded, fixtures, mapping, rehash
from test_agent_structure import Source, graph, snapshot


class Mapping:
    def __init__(self, rows=None, internal=False):
        self.config, self.binding = fixtures(internal=internal)
        self.grant = Grant("project", "factory", "local" if internal else "external")
        self.value = current(self.config, rows)
        self.calls = 0
        self.on_read = None
        self.failed = None
        self.native_failed = False
    def check(self):
        if self.failed: raise MappingFailure(self.failed)
    def check_native(self):
        if self.native_failed: raise MappingFailure("CONFIG_CHANGED")
    def is_idle(self): return True
    def read(self, deadline):
        self.check(); self.calls += 1
        if self.on_read: self.on_read(self.calls)
        return deepcopy(self.value)


class Knowledge:
    calls = []
    selectors = []
    fingerprint = "7" * 64
    on_read = None
    def __init__(self, node, cli, root, grant, source_id, selectors):
        type(self).selectors.append(deepcopy(selectors))
        self.source_id, self._selectors = source_id, selectors
    def read(self, task, references):
        type(self).calls.append(deepcopy(references))
        if type(self).on_read: type(self).on_read(len(type(self).calls))
        items = []
        for index, selector in enumerate(self._selectors):
            part = "memory" if selector["kind"] == "memory" else "compiled"
            items.append({"id": "item-" + str(index), "kind": selector["kind"],
                          "referenceKind": selector["referenceKind"], "referenceId": selector["referenceId"],
                          "referenceFingerprint": selector.get("referenceFingerprint", ""),
                          "title": "Reviewed summary", "summary": "Allowed summary only", "classification": "public",
                          "sourcePart": part, "semantics": "reviewed_memory" if part == "memory" else "compiled",
                          "evidenceId": "owner-proof-" + str(index), "contentFingerprint": "8" * 64})
        parts = sorted({item["sourcePart"] for item in items})
        sources = tuple({"sourceId": part + "-" + self.source_id[:32], "kind": part,
                         "version": {"type": "content_fingerprint", "value": type(self).fingerprint},
                         "checkedAt": "2026-10-20T00:00:00Z", "freshness": {"state": "checked"}} for part in parts)
        return KnowledgeRead(self.source_id, type(self).fingerprint, "2026-10-20T00:00:00Z",
                             sources, tuple(items), ())


def session(rows=None, internal=False, key=b"a" * 32):
    m = Mapping(rows, internal)
    native = snapshot(); native["external"] = not internal
    s = Source(graph(native), "local" if internal else "external")
    review = ReviewedKnowledge(m, "9" * 64)
    return IntegratedClient(s, "native-project", reviewed=review, cursor_key=key), m


class ReviewedCompositionTests(unittest.TestCase):
    def setUp(self):
        Knowledge.calls, Knowledge.selectors, Knowledge.fingerprint, Knowledge.on_read = [], [], "7" * 64, None
        self.owner = patch("lmti_agent.reviewed_knowledge._ClosedKnowledgeSource", Knowledge)
        self.owner.start(); self.addCleanup(self.owner.stop)

    def read(self, client, **kwargs):
        return client.task_context("firmware", "component", "component-a", **kwargs)

    def test_identity_only_returns_review_without_starting_knowledge(self):
        client, m = session()
        result = self.read(client)
        self.assertIsNone(result.get("error"))
        self.assertEqual(len(result["data"]["mappingAssociations"]), 1)
        self.assertEqual(result["data"]["contextItems"], [])
        self.assertIsNone(result["data"]["mappingReview"]["knowledgeFingerprint"])
        self.assertEqual(Knowledge.selectors, []); self.assertEqual(m.calls, 2)
        raw = json.dumps(result)
        for private in ("PRIVATE_LOCATOR", "PRIVATE_SUMMARY", "private-alias", m.config["storeUuid"],
                        m.config["authority"]["nativeStoreUuid"], "source-one"):
            self.assertNotIn(private, raw)

    def test_duplicate_selection_keeps_all_contributors_and_effective_floor(self):
        c, _ = fixtures(internal=True)
        rows = [mapping(c, 1), mapping(c, 2, "code"), mapping(c, 3, "code", internal=True)]
        client, m = session(rows, internal=True)
        self.assertEqual(checked_snapshot(m.value, m.config), m.value)
        result = self.read(client)
        self.assertIsNone(result.get("error"))
        self.assertEqual(len(Knowledge.selectors), 1); self.assertEqual(len(Knowledge.selectors[0]), 1)
        self.assertEqual(len(Knowledge.calls), 2)
        item, = result["data"]["contextItems"]
        self.assertEqual(item["mappingContributors"], [row["mapping"]["mappingId"] for row in rows[1:]])
        self.assertEqual((item["ownerClassification"], item["classification"]), ("public", "internal"))
        self.assertEqual(item["ownerFingerprint"], "7" * 64)
        self.assertEqual(len(item["mappingEvidenceIds"]), 2)
        self.assertEqual(len(result["data"]["mappingAssociations"]), 3)

    def test_combined_paging_rechecks_all_and_is_session_query_fingerprint_bound(self):
        c, _ = fixtures(); rows = [mapping(c, 1), mapping(c, 2, "code"), mapping(c, 3, "code")]
        client, m = session(rows)
        first = self.read(client, limit=1)
        cursor = first["completeness"]["nextCursor"]; self.assertTrue(cursor)
        sequence = [first["data"]["mappingAssociations"][0]["mappingId"]]
        while cursor:
            page = self.read(client, limit=1, cursor=cursor)
            self.assertIsNone(page.get("error"))
            sequence.extend(row["mappingId"] for row in page["data"]["mappingAssociations"])
            sequence.extend(row["id"] for row in page["data"]["contextItems"])
            cursor = page["completeness"]["nextCursor"]
        self.assertEqual(sequence, [row["mapping"]["mappingId"] for row in rows] + ["item-0"])
        self.assertEqual(m.calls, 8); self.assertEqual(len(Knowledge.calls), 8)
        stale = first["completeness"]["nextCursor"]
        other, _ = session(rows, key=b"b" * 32)
        self.assertEqual(self.read(other, limit=1, cursor=stale)["error"]["code"], "STALE_CURSOR")
        self.assertEqual(self.read(client, limit=2, cursor=stale)["error"]["code"], "STALE_CURSOR")
        m.value["graphRevision"] += 1; rehash(m.value)
        self.assertEqual(self.read(client, limit=1, cursor=stale)["error"]["code"], "STALE_CURSOR")

    def test_selection_limit_counts_original_rows_before_dedup_no_partial_associations(self):
        c, _ = fixtures()
        rows = [mapping(c, n + 1, "code") for n in range(101)]
        client, _ = session(rows)
        result = self.read(client, limit=1)
        self.assertEqual(result["status"], "partial")
        self.assertIn("REVIEWED_SELECTION_LIMIT", result["completeness"]["reasons"])
        self.assertEqual(result["data"]["mappingAssociations"], [])
        self.assertIsNone(result["data"]["mappingReview"]); self.assertIsNone(result["completeness"]["nextCursor"])
        self.assertEqual(Knowledge.selectors, [])

    def test_memory_requires_explicit_disclosure_and_at_most_one_original_row(self):
        c, _ = fixtures()
        client, m = session([mapping(c, 1, "memory")])
        self.assertIn("REVIEWED_MEMORY_DENIED", self.read(client)["completeness"]["reasons"])
        self.assertEqual(Knowledge.selectors, [])
        m.binding["memoryDisclosure"] = "owner_safe_summary"
        accepted = self.read(client)
        self.assertEqual(accepted["scope"]["knowledgeDisclosure"], "owner_safe_summary")
        self.assertEqual(accepted["data"]["contextItems"][0]["kind"], "memory")
        client, m = session([mapping(c, 1, "memory"), mapping(c, 2, "memory")])
        m.binding["memoryDisclosure"] = "owner_safe_summary"
        before = len(Knowledge.calls)
        self.assertIn("REVIEWED_SELECTION_LIMIT", self.read(client)["completeness"]["reasons"])
        self.assertEqual(len(Knowledge.calls), before)

    def test_outside_neighborhood_does_not_reach_knowledge(self):
        c, _ = fixtures()
        client, _ = session([mapping(c, 1, "code", target_id="other-repo")])
        result = self.read(client)
        self.assertEqual(result["data"]["mappingAssociations"], [])
        self.assertEqual(Knowledge.selectors, [])
        self.assertIsNotNone(result["data"]["mappingReview"])

    def test_mapping_and_knowledge_drift_return_only_rechecked_native(self):
        c, _ = fixtures()
        for source in ("mapping", "knowledge"):
            client, m = session([mapping(c, 1, "code")])
            if source == "mapping":
                def drift(count):
                    if count == 2: m.value["graphRevision"] += 1; rehash(m.value)
                m.on_read = drift
            else:
                Knowledge.on_read = lambda count: setattr(Knowledge, "fingerprint", str(count % 10) * 64)
            result = self.read(client)
            self.assertEqual(result["status"], "partial")
            self.assertIn("REVIEWED_MAPPING_CHANGED", result["completeness"]["reasons"])
            self.assertEqual(result["data"]["mappingAssociations"], [])
            self.assertEqual(result["data"]["contextItems"], [])
            self.assertIsNone(result["data"]["mappingReview"])
            self.assertEqual(len(result["sources"]), 1)
            Knowledge.on_read = None

    def test_native_changed_or_global_revocation_returns_no_partial_data(self):
        client, m = session()
        original = client._source.value
        def change(count):
            if count == 2: client._source.value = replace(original, revision=2, fingerprint="f" * 64)
        m.on_read = change
        result = self.read(client)
        self.assertEqual(result["error"]["code"], "SOURCE_CHANGED"); self.assertIsNone(result["data"])
        client, m = session(); client._authorize = lambda: False
        result = self.read(client)
        self.assertEqual(result["error"]["code"], "UNAVAILABLE"); self.assertEqual(m.calls, 0)

    def test_mapping_revocation_preserves_native_tools_but_native_byte_revocation_does_not(self):
        client, m = session(); m.failed = "CONFIG_CHANGED"
        self.assertNotEqual(client.context()["status"], "error")
        self.assertNotEqual(client.entity("component", "component-a")["status"], "error")
        self.assertIn("REVIEWED_MAPPING_CHANGED", self.read(client)["completeness"]["reasons"])
        m.native_failed = True
        for result in (client.context(), client.entity("component", "component-a"), self.read(client)):
            self.assertEqual(result["error"]["code"], "UNAVAILABLE")
            self.assertIsNone(result["data"]); self.assertEqual(result["sources"], [])

    def test_opaque_evidence_preserves_original_batch_and_never_exposes_body(self):
        client, m = session()
        first = self.read(client)
        old = first["data"]["mappingAssociations"][0]["evidenceIds"][0]
        m.value["evidenceBindings"][0]["evidenceBatchId"] = "historical-origin"; rehash(m.value)
        second = self.read(client)
        new = second["data"]["mappingAssociations"][0]["evidenceIds"][0]
        self.assertNotEqual(old, new)
        self.assertTrue(new.startswith("map-evidence-"))
        body = json.dumps(second)
        for hidden in ("historical-origin", "PRIVATE_SUMMARY", "PRIVATE_LOCATOR", "evidence-one"):
            self.assertNotIn(hidden, body)

    def test_reviewed_schema_opt_in_does_not_mutate_manual_tools(self):
        client, _ = session()
        old = IntegratedServer(IntegratedClient(Source()))
        before = deepcopy(old.tools)
        reviewed = IntegratedServer(client)
        self.assertEqual(len(reviewed.tools), 5)
        properties = reviewed.tools[-1]["inputSchema"]["properties"]
        self.assertIn("limit", properties); self.assertIn("cursor", properties)
        self.assertEqual(old.tools, before); self.assertNotIn("limit", old.tools[-1]["inputSchema"]["properties"])
        args = {"task": "firmware", "kind": "component", "entityId": "component-a", "limit": 1}
        self.assertEqual(old.call_tool("lmti_task_context", args)["error"]["code"], "INVALID_ARGUMENT")
        self.assertIsNone(reviewed.call_tool("lmti_task_context", args).get("error"))

    def test_response_cap_refuses_reviewed_whole_and_cursor_never_silently_shrinks(self):
        client, _ = session()
        native = client._source.value
        baseline, _ = client.reviewed._native_result(client, native, "component", "component-a", 2)
        client.reviewed._partial(baseline, "REVIEWED_MAPPING_BUDGET")
        cap = len(client._json(baseline)) + 16
        with patch("lmti_agent.reviewed_knowledge.MAX_RESPONSE", cap):
            result = self.read(client)
        self.assertEqual(result["status"], "partial")
        self.assertIn("REVIEWED_MAPPING_BUDGET", result["completeness"]["reasons"])
        self.assertEqual(result["data"]["mappingAssociations"], [])

    def test_composition_timeout_and_normal_eof_keep_admitted_worker_non_daemon_busy(self):
        client, m = session()
        entered, release, ended = threading.Event(), threading.Event(), threading.Event()
        daemon = []
        def held(*args):
            daemon.append(threading.current_thread().daemon); entered.set()
            try: release.wait(); return {}
            finally: ended.set()
        client.reviewed._collect = held
        try:
            with patch("lmti_agent.reviewed_knowledge.TASK_SECONDS", .2):
                result = self.read(client)
            self.assertTrue(entered.wait(1)); self.assertEqual(daemon, [False])
            self.assertEqual(result["error"]["code"], "BUDGET_EXCEEDED")
            self.assertIn("REVIEWED_MAPPING_BUSY", self.read(client)["completeness"]["reasons"])
        finally:
            release.set(); self.assertTrue(ended.wait(2))


class ReviewedConfigurationTests(unittest.TestCase):
    def config(self, schema="lmti.agent.integration.v3"):
        result = {"schema": schema, "projectId": "project", "site": "factory", "target": "external",
                  "knowledge": {"mode": "reviewed"}, "observations": None}
        if schema != "lmti.agent.integration.v1": result["structure"] = True
        if schema != "lmti.agent.integration.v3": result["knowledge"] = None
        return result

    def test_v3_original_identity_hardlink_and_latched_revocation_old_v2_hash_compatibility(self):
        with tempfile.TemporaryDirectory(prefix="reviewed-config-") as directory:
            root = Path(directory)
            for version in ("v2", "v3"):
                path = root / (version + ".json"); raw = encoded(self.config("lmti.agent.integration." + version))
                path.write_bytes(raw)
                _, authorize = _load_settings(path, hashlib.sha256(raw).hexdigest())
                self.assertTrue(authorize())
                old = root / (version + "-original.json"); path.rename(old); path.write_bytes(raw)
                self.assertEqual(authorize(), version == "v2")
                path.unlink(); old.rename(path)
                self.assertEqual(authorize(), version == "v2")
            link = root / "alias.json"; os.link(root / "v3.json", link)
            with self.assertRaises(ValueError):
                _load_settings(root / "v3.json", hashlib.sha256((root / "v3.json").read_bytes()).hexdigest())

    def test_v3_requires_pin_and_strict_native_close_capability(self):
        with tempfile.TemporaryDirectory(prefix="reviewed-config-") as directory:
            path = Path(directory) / "integration.json"; raw = encoded(self.config()); path.write_bytes(raw)
            with self.assertRaises(ValueError): _load_settings(path, None)
            source = NativeProjectSource.__new__(NativeProjectSource)
            source._retain_until_closed = False
            with self.assertRaises(ValueError):
                load_integrated_client(source, "native", path, expected_config_sha256=hashlib.sha256(raw).hexdigest())

    def test_only_v3_constructor_enables_strict_native_close(self):
        grant = Grant("project", "factory", "external")
        for version in ("v1", "v2", "v3"):
            data = self.config("lmti.agent.integration." + version)
            with patch("lmti_agent.integration_config._load_settings", return_value=(data, lambda: True)), \
                 patch("lmti_agent.integration_config._reviewed", return_value=object()), \
                 patch("lmti_agent.integration_config.NativeProjectSource") as source, \
                 patch("lmti_agent.integration_config._assemble", return_value="assembled"):
                self.assertEqual(load_integrated_native_client("fixed", "fixed", grant, "native", "fixed"), "assembled")
            expected = {"include_references": True, "include_structure": version != "v1"}
            if version == "v3":
                expected["retain_until_closed"] = True
            source.assert_called_once_with("fixed", "fixed", grant, **expected)

    def test_knowledge_wait_failure_retains_child_until_close(self):
        owner = _ClosedKnowledgeSource.__new__(_ClosedKnowledgeSource)
        owner._node, owner._cli = Path(tempfile.gettempdir()) / "node.exe", Path(tempfile.gettempdir()) / "index.js"
        release, waiting, ended = threading.Event(), threading.Event(), threading.Event()
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"{}"))
        calls, result = [], []
        def wait():
            calls.append(True)
            if len(calls) == 1: raise OSError("controlled wait failure")
            waiting.set(); release.wait(); return 0
        child.wait.side_effect = wait
        def call():
            try:
                with patch("lmti_agent.reviewed_knowledge.subprocess.Popen", return_value=child):
                    result.append(owner._run_owner(b"{}"))
            finally: ended.set()
        thread = threading.Thread(target=call); thread.start()
        try:
            self.assertTrue(waiting.wait(2)); self.assertFalse(ended.is_set())
        finally:
            release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(result, [b"{}"])


if __name__ == "__main__":
    unittest.main()
