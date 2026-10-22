"""Actual packaged generated -I -> Python -> mapping/knowledge/native owner proof.

The four LMTI_MAPPING_COMPOSITION_* runtime variables are mandatory when this
suite is selected. Fixture construction uses real compiled repository owner
APIs; every Agent read uses the newly built package. No native SQL is opened.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ordinary(value: str | Path, directory=False) -> Path:
    selected = Path(value)
    if not selected.is_absolute() or ".." in selected.parts:
        raise AssertionError("Absolute fixed test path required")
    for entry in (*reversed(selected.parents), selected):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise AssertionError("Redirected test path refused")
    if selected.is_dir() is not directory or (not directory and not selected.is_file()):
        raise AssertionError("Incorrect test path type")
    return selected.resolve(strict=True)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AssertionError("Duplicate response key")
        result[key] = value
    return result


def decode(data: bytes):
    return json.loads(data.decode("utf-8", errors="strict"), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(AssertionError("Nonfinite response")))


def tree(root: Path) -> dict[str, str]:
    result = {}
    for parent, dirs, names in os.walk(root, followlinks=False):
        for name in dirs:
            ordinary(Path(parent) / name, True)
        for name in names:
            file = ordinary(Path(parent) / name)
            result[file.relative_to(root).as_posix()] = digest(file)
    return result


class Child:
    """Bounded drains; a timeout never pretends a descendant has closed."""
    def __init__(self, argv, env, cwd, frames=False):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, cwd=cwd, shell=False,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.frames = frames
        self.stdout, self.stderr = bytearray(), bytearray()
        self.lines = queue.Queue(maxsize=128)
        self.failed = threading.Event()
        self.threads = [
            threading.Thread(target=self._read, args=(self.process.stdout, self.stdout, 8 * 1024 * 1024, frames),
                             daemon=True),
            threading.Thread(target=self._read, args=(self.process.stderr, self.stderr, 65536, False), daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def _read(self, source, collected, cap, frames):
        pending = bytearray()
        try:
            while chunk := source.read1(65536):
                if len(collected) + len(chunk) <= cap:
                    collected.extend(chunk)
                else:
                    self.failed.set()
                if frames:
                    pending.extend(chunk)
                    while b"\n" in pending:
                        line, _, remainder = pending.partition(b"\n")
                        pending = bytearray(remainder)
                        if not line or len(line) > 1100 * 1024:
                            self.failed.set()
                        else:
                            try:
                                self.lines.put_nowait(bytes(line))
                            except queue.Full:
                                self.failed.set()
                    if len(pending) > 1100 * 1024:
                        self.failed.set()
                        pending.clear()
            if frames and pending:
                self.failed.set()
        except (OSError, ValueError):
            self.failed.set()
        finally:
            source.close()

    def send(self, value):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode() + b"\n"
        if len(raw) > 16384:
            raise AssertionError("Test request cap exceeded")
        self.process.stdin.write(raw)
        self.process.stdin.flush()

    def reply(self, request_id, seconds=270):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.failed.is_set():
                raise AssertionError("Child frame/drain failure")
            try:
                raw = self.lines.get(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                if self.process.poll() is not None:
                    raise AssertionError("Child closed before reply")
                continue
            value = decode(raw)
            if value.get("id") != request_id:
                raise AssertionError("Unexpected response correlation")
            return value
        raise AssertionError(f"Live child deadline; retained PID {self.process.pid}")

    def finish(self, seconds=270):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            # The generated Python process can have a Node/native descendant.
            # Do not kill just Python and then erase its still-used fixture.
            raise AssertionError(f"Live child retained after deadline; PID {self.process.pid}") from None
        for thread in self.threads:
            thread.join(timeout=3)
        if self.failed.is_set() or any(thread.is_alive() for thread in self.threads):
            raise AssertionError("Child drains did not finish")
        return self.process.returncode, bytes(self.stdout), bytes(self.stderr)

    def closed(self):
        return self.process.poll() is not None and all(not thread.is_alive() for thread in self.threads)


class AgentMappingProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = {suffix: os.environ.get("LMTI_MAPPING_COMPOSITION_" + suffix)
                    for suffix in ("PACKAGE", "NATIVE_FIXTURE", "NODE", "PYTHON")}
        if any(not value for value in required.values()):
            raise AssertionError("All four reviewed composition runtime variables are required")
        cls.package = ordinary(required["PACKAGE"], True)
        cls.producer = ordinary(required["NATIVE_FIXTURE"])
        cls.node = ordinary(required["NODE"])
        cls.python = ordinary(required["PYTHON"])
        cls.repo = ordinary(Path(__file__).resolve().parents[2], True)
        cls.helper = ordinary(Path(__file__).parent / "fixtures/agent_mapping_fixture.mjs")
        cls.binary = ordinary(cls.package / "bin/lmti-project.exe")
        cls.admin = ordinary(cls.package / "bin/lmti-mcp-admin.exe")
        cls.entry = ordinary(cls.package / "share/lmti/scripts/lmti-agent-mcp.py")
        cls.knowledge = ordinary(cls.package / "share/lmti/knowledge-owner/index.js")
        cls.mapping = ordinary(cls.package / "share/lmti/mapping-owner/index.js")
        manifest = decode(ordinary(cls.package / "manifest.json").read_bytes())
        rows = {row["file"].replace("\\", "/"): row for row in manifest["files"]}
        for file in (cls.binary, cls.admin, cls.entry, cls.knowledge, cls.mapping):
            relative = file.relative_to(cls.package).as_posix()
            if rows[relative]["sha256"].lower() != digest(file):
                raise AssertionError("Package manifest mismatch")

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="lmti-reviewed-mapping-process-")).resolve(strict=True)
        self.children = []
        self.addCleanup(self.cleanup_fixture)
        self.env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        self.env["PATH"] = str(self.node.parent) + os.pathsep + str(self.package / "bin")
        if os.name == "nt":
            self.env["PATH"] += os.pathsep + r"C:\Windows\System32"
        self.env["QT_PLUGIN_PATH"] = str(self.package / "plugins")
        self.fixture("setup")
        self.control = decode((self.root / "fixture-control.json").read_bytes())
        self.active = set(row["mappingId"] for row in self.control["mappings"])
        self.code_ids = sorted(row["mappingId"] for row in self.control["mappings"] if row["kind"] == "code")

    def cleanup_fixture(self):
        live = []
        for child in self.children:
            if not child.closed():
                try:
                    child.finish()
                except AssertionError:
                    live.append(child.process.pid)
        if live:
            raise AssertionError(f"Fixture retained for live child PIDs {live}")
        root = ordinary(self.root, True)
        if root.parent != Path(tempfile.gettempdir()).resolve(strict=True) or not root.name.startswith("lmti-reviewed-mapping-process-"):
            raise AssertionError("Unsafe cleanup root")
        tree(root)  # Refuse every redirected descendant before recursive cleanup.
        shutil.rmtree(root)

    def child(self, argv, frames=False):
        value = Child([str(arg) for arg in argv], self.env, str(self.root), frames)
        self.children.append(value)
        return value

    def command(self, argv, value=None):
        child = self.child(argv)
        if value is not None:
            child.send(value)
        code, out, err = child.finish()
        self.assertEqual(code, 0, err.decode("utf-8", errors="replace")[:1000])
        self.assertLessEqual(len(out), 4 * 1024 * 1024)
        return out

    def fixture(self, action):
        reply = self.command([self.node, self.helper, action, self.root, self.repo, self.package, self.producer])
        result = decode(reply)
        self.assertTrue(result["changed"] if action == "dirty" else result["ready"])
        return result

    def generated(self, config=None, client="codex", native_root=None):
        if config is None:
            config = Path(self.control["integration"])
        if native_root is None:
            native_root = self.root / "native"
        request = {"action": "generate", "projectId": "factory-monitor", "client": client, "expectedRevision": 1}
        if config is not False:
            request["integration"] = {"configPath": str(config), "projectId": "factory-monitor",
                                      "site": "factory-demo", "target": "external", "sha256": digest(config)}
        before = tree(self.root)
        value = decode(self.command([self.admin, "--library", native_root / "library.sqlite",
                                     "--profiles", native_root / "profiles.sqlite", "--python", self.python,
                                     "--entry", self.entry, "--binary", self.binary], request))
        self.assertTrue(value["ok"], value)
        self.assertEqual(tree(self.root), before)
        server = value["servers"]["lmti_context"]
        self.assertEqual(Path(server["command"]), self.python)
        argv = server["args"]
        self.assertEqual(argv[0], "-I")
        self.assertEqual(Path(argv[1]), self.entry)
        self.assertEqual(len(argv), 12 if config is False else 16)
        if config is not False:
            self.assertEqual(argv[-4], "--integration-config")
            self.assertEqual(argv[-2:], ["--integration-sha256", digest(config)])
            expected_config, generated_config = ordinary(config), ordinary(argv[-3])
            self.assertEqual(generated_config, expected_config)
            self.assertTrue(os.path.samefile(generated_config, expected_config))
        return [server["command"], *argv]

    def session(self, argv=None):
        child = self.child(argv or self.generated(), frames=True)
        child.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "reviewed-composition-fixture", "version": "one"}}})
        self.assertIn("result", child.reply(1))
        child.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        child.next_id = 2
        return child

    def request(self, child, method, params=None):
        number = child.next_id
        child.next_id += 1
        message = {"jsonrpc": "2.0", "id": number, "method": method}
        if params is not None:
            message["params"] = params
        child.send(message)
        return child.reply(number)

    def tools(self, child):
        result = self.request(child, "tools/list")["result"]["tools"]
        return {row["name"]: row for row in result}

    def context(self, child, **extra):
        args = {"task": "code reviewed", "kind": "component", "entityId": "sensor-firmware", "depth": 2}
        args.update(extra)
        reply = self.request(child, "tools/call", {"name": "lmti_task_context", "arguments": args})
        result = reply["result"]["structuredContent"]
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()), 524288)
        return result

    def no_private_fields(self, result):
        text = json.dumps(result, ensure_ascii=False)
        for forbidden in (str(self.root), str(self.package), str(self.node), "src/firmware.ts",
                          "PRIVATE_LOCATOR_MARKER", "PRIVATE_EVIDENCE_BODY_MARKER", "PRIVATE_EXTERNAL_",
                          "PRIVATE_ALIAS_", "return 7;", self.control["native"]["storeUuid"],
                          self.control["rejectedId"], self.control["pendingId"]):
            for spelling in {forbidden, forbidden.replace("\\", "/")}:
                self.assertNotIn(json.dumps(spelling, ensure_ascii=False)[1:-1], text)

    def test_generated_reviewed_session_uses_actual_packaged_owners_and_excludes_pending_rejected(self):
        codex, cursor = self.generated(), self.generated(client="cursor")
        self.assertEqual(codex, cursor)
        child = self.session(codex)
        tools = self.tools(child)
        self.assertEqual(len(tools), 5)
        properties = tools["lmti_task_context"]["inputSchema"]["properties"]
        self.assertIn("limit", properties)
        self.assertIn("cursor", properties)
        before = tree(self.root)
        result = self.context(child)
        self.assertNotEqual(result["status"], "error", result.get("error"))
        data = result["data"]
        self.assertEqual({row["mappingId"] for row in data["mappingAssociations"]}, self.active)
        self.assertEqual(data["mappingReview"]["accepted"]["mappingVersion"], "accepted-one")
        self.assertEqual(len(data["contextItems"]), 1)
        item = data["contextItems"][0]
        self.assertEqual(item["kind"], "code")
        self.assertEqual(item["classification"], "public")
        self.assertEqual(item["ownerClassification"], "public")
        self.assertEqual(item["mappingContributors"], self.code_ids)
        self.assertEqual(item["ownerFingerprint"], data["mappingReview"]["knowledgeFingerprint"])
        self.assertEqual({s["kind"] for s in result["sources"]},
                         {"native_project", "compiled_knowledge", "reviewed_mapping"})
        self.no_private_fields(result)
        self.assertEqual(tree(self.root), before)
        self.assertEqual(child.finish()[0], 0)

    def test_same_generated_session_withholds_dirty_manifest_then_accepts_deliberate_refresh(self):
        child = self.session()
        initial = self.context(child)
        self.assertIsNotNone(initial["data"]["mappingReview"])
        config_before = (self.root / "integration.json").read_bytes()
        mapping_config_before = (self.root / "mapping-owner.json").read_bytes()
        self.fixture("dirty")
        before = tree(self.root)
        denied = self.context(child)
        self.assertEqual(denied["status"], "partial")
        self.assertEqual(denied["data"]["mappingAssociations"], [])
        self.assertEqual(denied["data"]["contextItems"], [])
        self.assertIsNone(denied["data"]["mappingReview"])
        self.assertIn("REVIEWED_MAPPING_CHANGED", denied["completeness"]["reasons"])
        self.no_private_fields(denied)
        self.assertEqual(tree(self.root), before)
        self.fixture("accept")
        before = tree(self.root)
        current = self.context(child)
        self.assertEqual(current["data"]["mappingReview"]["accepted"]["mappingVersion"], "accepted-two")
        self.assertNotEqual(current["data"]["mappingReview"]["mappingFingerprint"],
                            initial["data"]["mappingReview"]["mappingFingerprint"])
        self.assertEqual({row["mappingId"] for row in current["data"]["mappingAssociations"]}, self.active)
        self.assertEqual((self.root / "integration.json").read_bytes(), config_before)
        self.assertEqual((self.root / "mapping-owner.json").read_bytes(), mapping_config_before)
        self.assertEqual(tree(self.root), before)
        self.no_private_fields(current)
        self.assertEqual(child.finish()[0], 0)

    def test_real_pages_recheck_complete_source_and_reject_foreign_or_changed_cursor(self):
        child = self.session()
        first = self.context(child, limit=1)
        token = first["completeness"]["nextCursor"]
        self.assertIsInstance(token, str)
        received = []
        page = first
        for _ in range(6):
            rows = page["data"]["mappingAssociations"] + page["data"]["contextItems"]
            self.assertEqual(len(rows), 1)
            received.extend(("mapping", row["mappingId"]) for row in page["data"]["mappingAssociations"])
            received.extend(("context", row["id"]) for row in page["data"]["contextItems"])
            continuation = page["completeness"]["nextCursor"]
            if continuation is None:
                break
            page = self.context(child, limit=1, cursor=continuation)
        else:
            self.fail("Unexpected continuation beyond complete four-row fixture")
        self.assertEqual(len(received), 4)
        self.assertEqual(len(set(received)), 4)
        self.assertEqual({value for kind, value in received if kind == "mapping"}, self.active)
        other = self.session()
        self.assertEqual(self.context(other, limit=1, cursor=token)["error"]["code"], "STALE_CURSOR")
        self.assertEqual(other.finish()[0], 0)
        self.fixture("dirty")
        self.fixture("accept")
        self.assertEqual(self.context(child, limit=1, cursor=token)["error"]["code"], "STALE_CURSOR")
        fresh = self.context(child, limit=1)
        self.assertEqual(fresh["data"]["mappingReview"]["accepted"]["mappingVersion"], "accepted-two")
        self.assertEqual(child.finish()[0], 0)

    def test_config_revocation_latches_and_default_manual_v1_v2_remain_unchanged(self):
        child = self.session()
        self.assertIsNotNone(self.context(child)["data"]["mappingReview"])
        config = self.root / "integration.json"
        original = config.read_bytes()
        config.write_bytes(original + b" ")
        refused = self.context(child)
        self.assertEqual(refused["error"]["code"], "UNAVAILABLE")
        self.assertIsNone(refused["data"])
        config.write_bytes(original)
        self.assertEqual(self.context(child)["error"]["code"], "UNAVAILABLE")
        self.assertEqual(child.finish()[0], 0)
        reconnected = self.session()
        self.assertIsNotNone(self.context(reconnected)["data"]["mappingReview"])
        self.assertEqual(reconnected.finish()[0], 0)
        default = self.session(self.generated(False))
        self.assertEqual(len(self.tools(default)), 4)
        self.assertEqual(default.finish()[0], 0)
        # The old agent-snapshot boundary intentionally refuses schema2 declared
        # structure. Give v1 its own real schema1 owner, reusing the same compiled
        # source and known demo repository; v2 uses the main schema2 fixture.
        legacy_root = self.root / "native-legacy"
        legacy_root.mkdir()
        self.command([self.producer, "--fixture", legacy_root, "3", "1"])
        legacy_snapshot = decode(self.command([self.binary, "agent-snapshot", legacy_root / "project.sqlite",
                                               "factory-monitor", "factory-demo", "external"]))
        legacy_reference = next(row["locatorFingerprint"] for row in legacy_snapshot["repositories"]
                                if row["id"] == "repo-sensor")
        current_reference = next(row["referenceFingerprint"] for row in self.control["mappings"]
                                 if row["kind"] == "code")
        for version, native_root, reference in ((1, legacy_root, legacy_reference),
                                                (2, self.root / "native", current_reference)):
            with self.subTest(manual_version=version):
                legacy_config = self.root / f"integration-v{version}.json"
                settings = {"schema": f"lmti.agent.integration.v{version}", "projectId": "factory-monitor",
                            "site": "factory-demo", "target": "external", "observations": None,
                            "knowledge": {"node": str(self.node), "cli": str(self.knowledge),
                                          "root": self.control["source"]["root"],
                                          "sourceId": self.control["knowledgeSourceId"],
                                          "mappings": [{"kind": "code", "referenceKind": "repository",
                                                        "referenceId": "repo-sensor", "referenceFingerprint": reference,
                                                        "path": "src/firmware.ts"}]}}
                if version == 2:
                    settings["structure"] = True
                legacy_config.write_text(json.dumps(settings), encoding="utf-8")
                old = self.session(self.generated(legacy_config, native_root=native_root))
                old_tools = self.tools(old)
                self.assertEqual(len(old_tools), 5)
                props = old_tools["lmti_task_context"]["inputSchema"]["properties"]
                self.assertNotIn("cursor", props)
                self.assertNotIn("limit", props)
                before = tree(self.root)
                old_result = self.context(old)
                self.assertNotEqual(old_result["status"], "error", old_result.get("error"))
                self.assertEqual(len(old_result["data"]["contextItems"]), 1)
                item = old_result["data"]["contextItems"][0]
                self.assertEqual((item["kind"], item["referenceKind"], item["referenceId"]),
                                 ("code", "repository", "repo-sensor"))
                self.assertNotIn("mappingContributors", item)
                self.assertNotIn("mappingAssociations", old_result["data"])
                self.assertNotIn("mappingReview", old_result["data"])
                self.no_private_fields(old_result)
                self.assertEqual(tree(self.root), before)
                self.assertEqual(self.context(old, limit=1)["error"]["code"], "INVALID_ARGUMENT")
                self.assertEqual(old.finish()[0], 0)


    def schema3_fixture(self, action):
        helper = ordinary(self.repo / "python/tests/fixtures/agent_schema3_mapping_fixture.mjs")
        result = decode(self.command([self.node, helper, action, self.root, self.repo, self.package, self.producer]))
        self.assertEqual(set(result), {"ready", "schema", "revision", "assetId", "enabled", "pollMs",
                                      "acceptedVersion", "activeIds", "oldRegistrationError", "oldReadError"})
        self.assertTrue(result["ready"])
        self.assertEqual(result["schema"], 3)
        self.assertEqual(result["oldRegistrationError"], "VERSION_CONFLICT")
        self.assertEqual(result["oldReadError"], "UNSUPPORTED_MAPPING")
        self.control = decode((self.root / "fixture-control.json").read_bytes())
        self.active = {row["mappingId"] for row in self.control["mappings"]}
        self.code_ids = sorted(row["mappingId"] for row in self.control["mappings"] if row["kind"] == "code")
        self.assertEqual(set(result["activeIds"]), self.active)
        self.assertEqual(result["revision"], self.control["schema3"]["latestRevision"])
        self.assertEqual(self.control["native"]["schema"], "lmti.impact.mapping-native.v2")
        self.assertEqual(self.control["source"]["sourceId"], "composition-source-schema3")
        self.assertEqual(result["acceptedVersion"], "accepted-schema3-one")
        return result

    def schema3_tool(self, child, name, arguments):
        reply = self.request(child, "tools/call", {"name": name, "arguments": arguments})
        result = reply["result"]["structuredContent"]
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()), 524288)
        self.schema3_no_private(reply)
        return result

    def schema3_no_private(self, result):
        # Include full public envelopes, evidence and decoded cursor payloads.
        import base64
        old = decode(Path(self.control["schema3"]["originalControlPath"]).read_bytes())
        strings = [str(self.root), str(self.package), str(self.node), "src/firmware.ts",
                   "PRIVATE_LOCATOR_MARKER", "PRIVATE_EVIDENCE_BODY_MARKER", "PRIVATE_EXTERNAL_",
                   "PRIVATE_ALIAS_", "PRIVATE_SCHEMA3_EXTERNAL_", "PRIVATE_SCHEMA3_ALIAS_",
                   "return 7;", self.control["native"]["storeUuid"], old["rejectedId"], old["pendingId"]]
        private = self.control["schema3"]
        strings += [private["format"][key] for key in (
            "upgradeOperationId", "sourceContentDigest", "sourceRegistryDigest", "backupSha256", "formatDigest")]
        for operation in private["desiredOperations"]:
            strings += [operation["receipt"][key] for key in (
                "operationId", "requestDigest", "handoffDigest", "principalId", "grantFingerprint",
                "originalTargetDigest", "beforeContentDigest", "afterContentDigest", "registryDigest",
                "targetAncestryDigest", "receiptDigest")]
        forbidden_keys = {"proposal_format", "desired_asset_receipts", "receipt", "receiptDigest",
                          "operationId", "requestDigest", "handoffDigest", "principalId",
                          "grantFingerprint", "backupParent", "backupSha256", "formatDigest",
                          "originalTargetDigest", "reviewDigest"}
        def inspect(value):
            if isinstance(value, dict):
                self.assertFalse(forbidden_keys.intersection(value), "Private native receipt field in public response")
                for key, child in value.items():
                    inspect(child)
                    if key == "nextCursor" and child is not None:
                        encoded = child.split(".")[0]
                        inspect(decode(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))))
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
            elif isinstance(value, str):
                for secret in strings:
                    if isinstance(secret, str) and secret:
                        for spelling in {secret, secret.replace("\\", "/")}:
                            self.assertNotIn(spelling, value)
        inspect(result)
        text = json.dumps(result, ensure_ascii=False)
        for secret in strings:
            if isinstance(secret, str) and secret:
                for spelling in {secret, secret.replace("\\", "/")}:
                    self.assertNotIn(json.dumps(spelling, ensure_ascii=False)[1:-1], text)

    def schema3_native_revision(self, result):
        return next(row["version"]["value"] for row in result["sources"] if row["kind"] == "native_project")

    def test_schema3_five_public_tools_fresh_enrollment_and_private_edit(self):
        initial = self.schema3_fixture("upgrade")
        old = decode(Path(self.control["schema3"]["originalControlPath"]).read_bytes())
        self.assertTrue(self.active.isdisjoint({row["mappingId"] for row in old["mappings"]}))
        self.assertEqual(len(self.active), 4)
        first_receipt = self.control["schema3"]["desiredOperations"][0]["receipt"]
        self.assertEqual(first_receipt["committedRevision"], initial["revision"])
        self.assertEqual((first_receipt["desiredEnabled"], first_receipt["desiredPollMs"]),
                         (initial["enabled"], initial["pollMs"]))
        child = self.session()
        tools = self.tools(child)
        self.assertEqual(set(tools), {"lmti_context", "lmti_entity", "lmti_related",
                                     "lmti_observations", "lmti_task_context"})
        before = tree(self.root)
        page = self.schema3_tool(child, "lmti_context", {"limit": 1})
        token = page["completeness"]["nextCursor"]
        self.assertIsInstance(token, str)
        entity = self.schema3_tool(child, "lmti_entity", {"kind": "asset", "entityId": initial["assetId"]})
        related = self.schema3_tool(child, "lmti_related", {"kind": "asset", "entityId": initial["assetId"],
                                                          "depth": 2, "limit": 100})
        observations = self.schema3_tool(child, "lmti_observations", {"assetId": initial["assetId"]})
        self.assertEqual(observations["error"]["code"], "NOT_SUPPORTED")
        self.assertEqual(observations["data"], None)
        self.assertEqual(entity["data"]["entities"][0]["identity"]["sourceEntityId"], initial["assetId"])
        # Existing public entity DTO has no enabled/pollMs fields. Verify desired
        # values using the private native receipt; public tools prove revision
        # and reviewed-association coherence without widening their schemas.
        self.assertEqual(entity["data"]["entities"][0]["attributes"]["observedVersion"], "unknown")
        self.assertNotIn("enabled", entity["data"]["entities"][0]["attributes"])
        self.assertNotIn("pollMs", entity["data"]["entities"][0]["attributes"])
        for result in (page, entity, related):
            self.assertNotEqual(result["status"], "error")
            self.assertEqual(self.schema3_native_revision(result), initial["revision"])
        reviewed = self.context(child)
        self.schema3_no_private(reviewed)
        self.assertEqual({row["mappingId"] for row in reviewed["data"]["mappingAssociations"]}, self.active)
        self.assertEqual(reviewed["data"]["mappingReview"]["native"]["revision"], initial["revision"])
        self.assertEqual(reviewed["data"]["mappingReview"]["accepted"]["mappingVersion"], "accepted-schema3-one")
        self.assertEqual(len(reviewed["data"]["contextItems"]), 1)
        partial = self.context(child, limit=1)
        reviewed_token = partial["completeness"]["nextCursor"]
        self.assertIsInstance(reviewed_token, str)
        self.schema3_no_private(partial)
        self.assertEqual(tree(self.root), before)
        changed = self.schema3_fixture("edit")
        self.assertEqual(changed["revision"], initial["revision"] + 1)
        self.assertNotEqual(changed["enabled"], initial["enabled"])
        receipts = self.control["schema3"]["desiredOperations"]
        self.assertEqual(len(receipts), 2)
        self.assertEqual(receipts[0]["receipt"], first_receipt)
        self.assertNotEqual(receipts[0]["receipt"]["operationId"], receipts[1]["receipt"]["operationId"])
        before = tree(self.root)
        stale = self.schema3_tool(child, "lmti_context", {"limit": 1, "cursor": token})
        self.assertEqual(stale["error"]["code"], "STALE_CURSOR")
        stale_reviewed = self.context(child, limit=1, cursor=reviewed_token)
        self.schema3_no_private(stale_reviewed)
        self.assertEqual(stale_reviewed["error"]["code"], "STALE_CURSOR")
        fresh = self.context(child)
        self.schema3_no_private(fresh)
        self.assertEqual(fresh["data"]["mappingReview"]["native"]["revision"], changed["revision"])
        self.assertEqual(self.schema3_native_revision(fresh), changed["revision"])
        self.assertEqual({row["mappingId"] for row in fresh["data"]["mappingAssociations"]}, self.active)
        self.assertNotEqual(fresh["data"]["mappingReview"]["mappingFingerprint"],
                            reviewed["data"]["mappingReview"]["mappingFingerprint"])
        self.assertEqual(tree(self.root), before)
        self.assertEqual(child.finish()[0], 0)
        self.assertEqual(tree(self.root), before)

    def schema3_privacy_case(self, mutation):
        initial = self.schema3_fixture("upgrade")
        child = self.session()
        initial_reviewed = self.context(child)
        self.assertIsNotNone(initial_reviewed["data"]["mappingReview"])
        self.schema3_no_private(initial_reviewed)
        if mutation == "source":
            source_path = ordinary(Path(self.control["source"]["root"]) / self.control["source"]["descriptorFile"])
            source = decode(source_path.read_bytes())
            source["source"]["privacy"] = "internal"
            source_path.write_text(json.dumps(source) + "\n", encoding="utf-8")
        else:
            self.schema3_fixture("privacy-" + mutation)
        before = tree(self.root)
        denied = self.context(child)
        self.schema3_no_private(denied)
        self.assertEqual(denied["status"], "partial")
        self.assertEqual(denied["data"]["mappingAssociations"], [])
        self.assertEqual(denied["data"]["contextItems"], [])
        self.assertIsNone(denied["data"]["mappingReview"])
        self.assertTrue(any(reason.startswith("REVIEWED_MAPPING_") for reason in denied["completeness"]["reasons"]))
        asset = self.schema3_tool(child, "lmti_entity", {"kind": "asset", "entityId": initial["assetId"]})
        if mutation == "source":
            self.assertNotEqual(asset["status"], "error")
        else:
            self.assertEqual(asset["error"]["code"], "UNAVAILABLE")
            missing = self.schema3_tool(child, "lmti_entity", {"kind": "asset", "entityId": "missing-schema3-asset"})
            self.assertEqual(asset["error"], missing["error"])
        self.assertEqual(tree(self.root), before)
        self.assertEqual(child.finish()[0], 0)
        self.assertEqual(tree(self.root), before)

    def test_schema3_current_asset_privacy_withholds_reviewed_content(self):
        self.schema3_privacy_case("asset")

    def test_schema3_current_site_privacy_withholds_reviewed_content(self):
        self.schema3_privacy_case("site")

    def test_schema3_current_source_privacy_withholds_reviewed_content(self):
        self.schema3_privacy_case("source")



if __name__ == "__main__":
    unittest.main()
