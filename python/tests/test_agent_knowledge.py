"""Owner process/policy tests; all stores and source snippets are synthetic."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from lmti_agent.knowledge import KnowledgeError, KnowledgeSource
from lmti_project import Grant


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="lmti-knowledge-owner-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        runtime = shutil.which("node")
        if runtime is None:
            self.skipTest("Node owner runtime is unavailable.")
        self.node = Path(runtime).resolve()
        self.cli = self.root / "index.js"
        self.cli.write_text("", encoding="utf-8")
        self.mappings = [
            {"kind": "code", "referenceKind": "repository", "referenceId": "repo", "referenceFingerprint": "a" * 64, "path": "src/service.ts"},
            {"kind": "document", "referenceKind": "knowledge", "referenceId": "design", "referenceFingerprint": "b" * 64, "path": "docs/design.md"},
            {"kind": "memory", "referenceKind": "component", "referenceId": "service", "disclosure": "owner_safe_summary"},
        ]
        self.allowed = {("repository", "repo", "a" * 64), ("knowledge", "design", "b" * 64), ("component", "service", "")}
        self.source = KnowledgeSource(self.node, self.cli, self.root, Grant("demo", "site"), "c" * 64, self.mappings)

    def payload(self):
        items = [{"id": "item-" + value["kind"], "kind": value["kind"], "referenceKind": value["referenceKind"],
                  "referenceId": value["referenceId"], "referenceFingerprint": value.get("referenceFingerprint", ""),
                  "title": "Permitted knowledge", "summary": "Bounded owner understanding.",
                  "classification": "internal" if value["kind"] == "memory" else "public",
                  "disclosure": "owner_safe_summary" if value["kind"] == "memory" else "public_compiled_summary",
                  "evidenceId": "evidence-" + value["kind"], "contentFingerprint": "d" * 64,
                  "sourcePart": "memory" if value["kind"] == "memory" else "compiled",
                  "semantics": "reviewed_memory" if value["kind"] == "memory" else "compiled"} for value in self.mappings]
        sources = [{"part": "compiled", "version": "e" * 64, "compiledAt": "2026-10-19T00:00:00Z",
                    "freshness": "checked", "basis": "mapped_source_content_matches_compiled_hash"},
                   {"part": "memory", "version": "f" * 64, "compiledAt": None,
                    "freshness": "checked", "basis": "read_only_memory_owner_projection"}]
        result = {"schema": "lmti.agent.knowledge.v1", "projectId": "demo", "sourceId": "c" * 64,
                  "target": "external", "classification": "internal", "checkedAt": "2026-10-19T00:00:01Z",
                  "sources": sources, "items": items, "completeness": {"state": "complete", "reasons": [], "nextCursor": None}}
        stable = {"sourceId": result["sourceId"], "sources": sources, "items": items, "reasons": []}
        result["fingerprint"] = hashlib.sha256(json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        return result

    def test_public_compiled_documents_and_reviewed_memory_keep_source_versions(self):
        with patch.object(self.source, "_run_owner", return_value=json.dumps(self.payload()).encode()) as read:
            result = self.source.read("architecture", self.allowed)
        self.assertEqual({row["kind"] for row in result.items}, {"code", "document", "memory"})
        self.assertEqual(len(result.sources), 2)
        request = json.loads(read.call_args.args[0])
        self.assertEqual(request["mappings"], self.mappings)
        self.assertEqual(request["sourceId"], "c" * 64)
        self.assertNotIn(str(self.root), json.dumps(result.items))
        memory = next(row for row in result.items if row["kind"] == "memory")
        self.assertEqual(memory["classification"], "internal")
        self.assertEqual(memory["disclosure"], "owner_safe_summary")
        mutated = self.source.mappings[0]
        mutated["referenceId"] = "other"
        self.assertEqual(self.source.mappings[0]["referenceId"], "repo")
        with self.assertRaises(AttributeError):
            self.source.source_id = "e" * 64

    def test_denied_and_rebound_references_never_call_owner(self):
        with patch.object(self.source, "_run_owner") as read:
            with self.assertRaises(KnowledgeError):
                self.source.read("architecture", set())
            with self.assertRaises(KnowledgeError):
                self.source.read("architecture", {("repository", "repo", "0" * 64)})
            read.assert_not_called()

    def test_rejects_invalid_identity_scope_policy_and_unbound_items(self):
        changes = [lambda p: p.update(projectId="other"), lambda p: p.update(sourceId="0" * 64),
                   lambda p: p["items"][0].update(referenceId="hidden"),
                   lambda p: p["items"][0].update(classification="internal"),
                   lambda p: p["items"][2].update(classification="private"),
                   lambda p: p["items"][2].update(disclosure="raw"),
                   lambda p: p.update(classification="public"),
                   lambda p: p["items"][0].update(summary="token=" + "ghp_" + "a" * 36),
                   lambda p: p["items"][0].update(semantics="verified"),
                   lambda p: p["items"][0].update(summary="Changed without version update"),
                   lambda p: p["sources"][0].update(freshness="fresh"),
                   lambda p: p.update(checkedAt="2026-10-19"),
                   lambda p: p.update(secretPath="must not be accepted")]
        for change in changes:
            value = self.payload()
            change(value)
            with patch.object(self.source, "_run_owner", return_value=json.dumps(value).encode()):
                with self.assertRaises(KnowledgeError) as error:
                    self.source.read("architecture", self.allowed)
                self.assertEqual(error.exception.code, "INVALID_SOURCE_RESPONSE")

    def test_rejects_duplicate_keys_and_nonfinite_owner_json(self):
        for raw in [b'{"schema":"a","schema":"b"}', b'{"value":NaN}']:
            with patch.object(self.source, "_run_owner", return_value=raw):
                with self.assertRaises(KnowledgeError):
                    self.source.read("architecture", self.allowed)

    def test_fixed_process_contract_and_sanitized_environment(self):
        result = self.payload()
        # Child sends only a known fixture if its fixed command and environment match.
        program = """let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const r=JSON.parse(input);
 if(process.argv[2]!=='agent-context'||process.env.NODE_OPTIONS||process.env.NODE_PATH||
    process.env.LMTI_STUDIO_ALLOW_LESSON_REVIEW||r.operation!=='context')process.exit(7);
 process.stdout.write(RESPONSE);});""".replace("RESPONSE", json.dumps(json.dumps(result)))
        self.cli.write_text(program, encoding="utf-8")
        with patch.dict(os.environ, {"NODE_OPTIONS": "--invalid-runtime-option", "NODE_PATH": "untrusted", "LMTI_STUDIO_ALLOW_LESSON_REVIEW": "1"}):
            output = self.source.read("architecture", self.allowed)
        self.assertEqual(len(output.items), 3)

    def test_owner_output_is_bounded(self):
        self.cli.write_text("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(600000)));", encoding="utf-8")
        with self.assertRaises(KnowledgeError) as error:
            self.source.read("architecture", self.allowed)
        self.assertEqual(error.exception.code, "BUDGET_EXCEEDED")

    def test_memory_disclosure_requires_explicit_trusted_mapping(self):
        for mapping in [{"kind": "memory", "referenceKind": "component", "referenceId": "service"},
                        {"kind": "memory", "referenceKind": "component", "referenceId": "service", "disclosure": "raw"}]:
            with self.assertRaises(KnowledgeError):
                KnowledgeSource(self.node, self.cli, self.root, self.source.grant, self.source.source_id, [mapping])


class KnowledgePathTests(unittest.TestCase):
    def test_network_device_and_ads_paths_are_rejected_before_filesystem_access(self):
        for node in [r"\\untrusted.invalid\share\node.exe", "//untrusted.invalid/share/node", r"\\?\C:\node.exe", r"C:\node.exe:stream", r"C:\NUL\node.exe"]:
            with patch.object(Path, "lstat", side_effect=AssertionError("Filesystem access is forbidden")) as access:
                with self.assertRaises(KnowledgeError):
                    KnowledgeSource(node, "C:/trusted/index.js", "C:/trusted/project", Grant("demo", "site"),
                                    "c" * 64, [{"kind": "memory", "referenceKind": "component", "referenceId": "service", "disclosure": "owner_safe_summary"}])
                access.assert_not_called()


if __name__ == "__main__":
    unittest.main()
