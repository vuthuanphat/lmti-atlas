"""Real native -> Python -> TS owner -> MCP evidence on disposable synthetic data.

Set LMTI_PROJECT_BINARY to a built native owner. LMTI_AGENT_REPO and
LMTI_NODE_BINARY optionally select the checkout and canonical trusted Node.
LMTI_KNOWLEDGE_CLI can select the packaged narrow owner index.js.
No existing user databases, credentials, registration or network are used.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from lmti_agent.integration_config import load_integrated_client
from lmti_agent.source import NativeProjectSource
from lmti_project import Grant


FIXTURE = r"""
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [root, repo] = process.argv.slice(2);
const {compileProject} = await import(pathToFileURL(path.join(repo,'packages/compiler/dist/index.js')).href);
const {initProjectMemoryStorage,addProjectMemory,proposeLessonCandidate,readProjectMemorySnapshot,reviewDesktopLesson}
  = await import(pathToFileURL(path.join(repo,'packages/memory/dist/index.js')).href);
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.mkdir(path.join(root,'docs'),{recursive:true});
await fs.mkdir(path.join(root,'.lmti'),{recursive:true});
await fs.writeFile(path.join(root,'src/firmware.ts'),'export function sampleInterval() { return 1000; }\n');
await fs.writeFile(path.join(root,'docs/firmware.md'),'# Firmware design\nPublic sample timing design and architecture boundary.\n');
const amf=await compileProject(root);
// This synthetic fixture explicitly publishes its two nonsecret sample files.
// Production compiler defaults are kept internal; the adapter never promotes them.
for(const file of amf.files) file.privacy='public';
await fs.writeFile(path.join(root,'.lmti/project.amf.json'),JSON.stringify(amf));
await initProjectMemoryStorage(root);
await addProjectMemory({title:'Firmware memory',content:'Preserve reviewed timing bounds.',privacyLevel:'public',zone:'architecture'},{cwd:root});
await addProjectMemory({title:'PrivateOnlyMarker',content:'Confidential fixture planning note.',privacyLevel:'private'},{cwd:root});
await addProjectMemory({title:'ForbiddenOnlyMarker',content:'Synthetic do not prompt note.',privacyLevel:'do_not_prompt'},{cwd:root});
const observation={taskId:'fixture-task',taskTitle:'Firmware timing evidence',taskSummary:'Validate bounded timing.',
 filesTouched:[{path:'src/firmware.ts',changeType:'modified',changeSummary:'Validated timing.'}],
 commandsRun:[{command:'fixture-test',exitCode:0,status:'pass',outputRedacted:true}],
 tests:[{name:'timing bound',status:'pass'}],decisions:[],outcome:'pass'};
await proposeLessonCandidate({observation:{...observation,taskId:'pending-fixture'},agentProposedLesson:'PendingOnlyMarker never becomes usable memory before review.'},{cwd:root});
const approved=await proposeLessonCandidate({observation,agentProposedLesson:'Keep firmware timing changes backed by reviewed verification.'},{cwd:root});
const candidate=(await readProjectMemorySnapshot(root)).lessons.find(row=>row.id===approved.candidate.id);
await reviewDesktopLesson(root,candidate.id,candidate.fingerprint,'approve');
const canonical=process.platform==='win32'?root.toLowerCase():root;
process.stdout.write(JSON.stringify({sourceId:createHash('sha256').update(canonical+'\0'+amf.project.name).digest('hex')}));
"""


@unittest.skipUnless(os.environ.get("LMTI_PROJECT_BINARY"), "Set LMTI_PROJECT_BINARY for real cross-owner integration")
class IntegratedProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-cross-owner-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.repo = Path(os.environ.get("LMTI_AGENT_REPO", Path(__file__).resolve().parents[2])).resolve(strict=True)
        self.binary = Path(os.environ["LMTI_PROJECT_BINARY"]).resolve(strict=True)
        runtime = os.environ.get("LMTI_NODE_BINARY") or shutil.which("node")
        if runtime is None:
            self.skipTest("Node owner runtime is unavailable.")
        self.node = Path(runtime).resolve(strict=True)
        self.cli = Path(os.environ.get("LMTI_KNOWLEDGE_CLI", self.repo / "packages/cli/dist/index.js")).resolve(strict=True)
        self.database = self.directory / "project.sqlite"
        self.root = self.directory / "source"
        self.root.mkdir()
        subprocess.run([str(self.binary), "init-demo", str(self.database)], check=True, capture_output=True, timeout=10)
        # Only test setup edits its disposable native SQLite fixture; production
        # Agent/SDK code reads strictly through the native owner process.
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("INSERT INTO knowledge(id,label,component_id,reference,fingerprint,privacy) VALUES(?,?,?,?,?,?)",
                             ("firmware-design", "Firmware design", "sensor-firmware", "fixture-design-reference", "fixture-v1", "public"))
        self.grant = Grant("factory-monitor", "factory-demo")
        self.native = NativeProjectSource(self.binary, self.database, self.grant, include_references=True)
        graph = self.native.read()
        repository = next(row for row in graph.entities if row.identity.kind == "repository" and row.identity.source_entity_id == "repo-sensor")
        design = next(row for row in graph.entities if row.identity.kind == "knowledge" and row.identity.source_entity_id == "firmware-design")
        run = subprocess.run([str(self.node), "--input-type=module", "-", str(self.root), str(self.repo)],
                             input=FIXTURE.encode(), capture_output=True, timeout=20, check=True)
        source_id = json.loads(run.stdout)["sourceId"]
        self.config = {"schema": "lmti.agent.integration.v1", "projectId": self.grant.project_id,
                       "site": self.grant.site, "target": self.grant.target, "observations": None,
                       "knowledge": {"node": str(self.node), "cli": str(self.cli), "root": str(self.root), "sourceId": source_id,
                                     "mappings": [
                                         {"kind": "code", "referenceKind": "repository", "referenceId": "repo-sensor",
                                          "referenceFingerprint": repository.attributes["locatorFingerprint"], "path": "src/firmware.ts"},
                                         {"kind": "document", "referenceKind": "knowledge", "referenceId": "firmware-design",
                                          "referenceFingerprint": design.attributes["referenceFingerprint"], "path": "docs/firmware.md"},
                                         {"kind": "memory", "referenceKind": "component", "referenceId": "sensor-firmware", "disclosure": "owner_safe_summary"}]}}
        self.config_file = self.directory / "integration.json"
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.client = load_integrated_client(self.native, "native-project", self.config_file)

    def context(self):
        return self.client.task_context("code document memory", "component", "sensor-firmware")

    def test_real_owners_return_code_documents_reviewed_memory_with_separate_evidence(self):
        memory_file = self.root / ".lmti/memory/project-memory.sqlite"
        native_before, memory_before = self.database.read_bytes(), memory_file.read_bytes()
        result = self.context()
        self.assertEqual(result["status"], "ok", result.get("error"))
        items = result["data"]["contextItems"]
        self.assertEqual({item["kind"] for item in items}, {"code", "document", "memory"})
        self.assertTrue(any(item["semantics"] == "reviewed_memory" for item in items))
        reviewed = next(item for item in items if item["semantics"] == "reviewed_memory")
        self.assertEqual(reviewed["classification"], "internal")
        self.assertEqual(reviewed["disclosure"], "owner_safe_summary")
        self.assertEqual(result["scope"]["classification"], "internal")
        self.assertEqual(result["scope"]["knowledgeDisclosure"], "owner_safe_summary")
        self.assertEqual(len(result["sources"]), 3)
        self.assertEqual({source["version"]["type"] for source in result["sources"]}, {"owner_revision", "content_fingerprint"})
        proof = {row["evidenceId"]: row for row in result["evidence"]}
        for item in items:
            self.assertTrue(proof[item["evidenceId"]]["sourceId"].startswith(item["sourcePart"] + "-"))
        encoded = json.dumps(result)
        for forbidden in (str(self.root), str(self.database), "return 1000", "PrivateOnlyMarker", "ForbiddenOnlyMarker", "PendingOnlyMarker"):
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(self.database.read_bytes(), native_before)
        self.assertEqual(memory_file.read_bytes(), memory_before)

    def test_changed_mapped_file_is_stale_and_does_not_return_old_summary(self):
        (self.root / "src/firmware.ts").write_text("export function changedInterval() { return 2000; }\n", encoding="utf-8")
        result = self.context()
        self.assertEqual(result["status"], "partial")
        self.assertIn("COMPILED_CONTENT_STALE", result["completeness"]["reasons"])
        self.assertFalse(any(item["kind"] == "code" for item in result["data"]["contextItems"]))
        self.assertTrue(any(item["kind"] == "document" for item in result["data"]["contextItems"]))

    def test_native_reference_rebind_withholds_previously_mapped_document(self):
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("UPDATE knowledge SET reference=? WHERE id=?", ("changed-fixture-reference", "firmware-design"))
        result = self.context()
        self.assertNotEqual(result["status"], "error", result.get("error"))
        self.assertFalse(any(item["kind"] == "document" for item in result["data"]["contextItems"]))
        self.assertTrue(any(row["code"] == "REFERENCE_CONTENT_NOT_LOADED" for row in result["unknowns"]))

    def test_native_permission_revocation_discards_all_context(self):
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("UPDATE repositories SET privacy='internal' WHERE id='repo-sensor'")
        result = self.context()
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        self.assertIsNone(result["data"])
        self.assertEqual(result["sources"], [])

    def test_changed_integration_configuration_revokes_loaded_client(self):
        original = self.config_file.read_bytes()
        self.config_file.write_text(json.dumps(self.config, indent=2), encoding="utf-8")
        result = self.context()
        self.assertEqual(result["error"]["code"], "UNAVAILABLE")
        self.assertEqual(self.client.context()["error"]["code"], "UNAVAILABLE")
        self.assertIsNone(result["data"])
        self.config_file.write_bytes(original)
        self.assertEqual(self.client.context()["error"]["code"], "UNAVAILABLE")
        reconnected = load_integrated_client(self.native, "native-project", self.config_file)
        self.assertNotEqual(reconnected.context()["status"], "error")

    def test_exported_fingerprint_pins_configuration_until_explicit_reconnect(self):
        expected = hashlib.sha256(self.config_file.read_bytes()).hexdigest()
        pinned = load_integrated_client(self.native, "native-project", self.config_file, expected_config_sha256=expected)
        self.assertNotEqual(pinned.context()["status"], "error")
        with self.assertRaises(ValueError):
            load_integrated_client(self.native, "native-project", self.config_file, expected_config_sha256="0" * 64)
        self.config_file.write_text(json.dumps(self.config, indent=2), encoding="utf-8")
        with self.assertRaises(ValueError):
            load_integrated_client(self.native, "native-project", self.config_file, expected_config_sha256=expected)
        current = hashlib.sha256(self.config_file.read_bytes()).hexdigest()
        reconnected = load_integrated_client(self.native, "native-project", self.config_file, expected_config_sha256=current)
        self.assertNotEqual(reconnected.context()["status"], "error")

    def test_real_mcp_additive_tool_and_unchanged_default_discovery(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "cross-owner-fixture", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "lmti_task_context", "arguments": {"task": "code document memory", "kind": "component", "entityId": "sensor-firmware"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "lmti_task_context", "arguments": {"task": "code", "kind": "component", "entityId": "sensor-firmware", "sourceRoot": "forbidden"}}},
        ]
        argv = [sys.executable, "-B", "-m", "lmti_agent.mcp", "--binary", str(self.binary), "--database", str(self.database),
                "--project", self.grant.project_id, "--site", self.grant.site]
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(self.repo / "python/src")
        expected = hashlib.sha256(self.config_file.read_bytes()).hexdigest()
        process = subprocess.run(argv + ["--integration-config", str(self.config_file), "--integration-sha256", expected],
                                 input=b"".join(json.dumps(row).encode() + b"\n" for row in messages), capture_output=True,
                                 timeout=30, check=True, env=environment)
        response = {row["id"]: row for row in map(json.loads, process.stdout.splitlines())}
        self.assertEqual(len(response[2]["result"]["tools"]), 5)
        self.assertFalse(response[3]["result"]["isError"])
        context = response[3]["result"]["structuredContent"]
        self.assertEqual({item["kind"] for item in context["data"]["contextItems"]}, {"code", "document", "memory"})
        self.assertEqual(response[4]["result"]["structuredContent"]["error"]["code"], "INVALID_ARGUMENT")
        default = subprocess.run(argv, input=b"".join(json.dumps(row).encode() + b"\n" for row in messages[:3]),
                                 capture_output=True, timeout=15, check=True, env=environment)
        discovery = json.loads(default.stdout.splitlines()[-1])
        self.assertEqual(len(discovery["result"]["tools"]), 4)
        for extra in (["--integration-config", str(self.config_file), "--integration-sha256", "0" * 64],
                      ["--integration-sha256", expected]):
            refused = subprocess.run(argv + extra, input=b"", capture_output=True, timeout=15, env=environment)
            self.assertEqual(refused.returncode, 1)
            self.assertEqual(refused.stdout, b"")
            self.assertNotIn(str(self.config_file).encode(), refused.stderr)


if __name__ == "__main__":
    unittest.main()
