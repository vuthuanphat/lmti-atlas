"""New client-smoke assertions must reject a source fallback or altered grant."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cp01_probe", Path(__file__).resolve().parents[1] / "cp01-client-smoke.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GeneratedProfileChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-client-assertions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.package = self.root / "package"
        self.entry = self.package / "share/lmti/scripts/lmti-agent-mcp.py"
        self.binary = self.package / "bin/lmti-project.exe"
        self.database = self.root / "synthetic-project.sqlite"
        self.interpreter = self.root / "python.exe"
        for path in (self.entry, self.binary, self.database, self.interpreter):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic fixture")
        self.patch_interpreter = patch.object(probe.sys, "executable", str(self.interpreter))
        self.patch_interpreter.start()
        self.addCleanup(self.patch_interpreter.stop)
        self.config = {"command": sys.executable, "args": ["-I", str(self.entry), "--binary", str(self.binary),
                       "--database", str(self.database), "--project", "factory-monitor", "--site", "factory-demo",
                       "--target", "external"]}
        self.integration = self.root / "integration.json"
        self.integration.write_text(json.dumps({"synthetic": True}), encoding="utf-8")

    def check(self, config=None, integration=None):
        return probe.verify_generated(config or self.config, self.root, self.package, integration)

    def test_legacy_profile_is_valid_and_unchanged(self):
        before = copy.deepcopy(self.config)
        self.assertTrue(self.check()["exactExportedArguments"])
        self.assertEqual(self.config, before)

    def test_integrated_export_requires_exact_fingerprint(self):
        self.config["args"] += ["--integration-config", str(self.integration), "--integration-sha256", probe.digest(self.integration)]
        self.assertTrue(self.check(integration=self.integration)["integrationPinned"])
        self.integration.write_text('{"synthetic": false}', encoding="utf-8")
        with self.assertRaises(probe.smoke.SmokeError):
            self.check(integration=self.integration)

    @unittest.skipUnless(os.name == "nt", "Windows path spelling compatibility")
    def test_windows_integration_path_spellings_preserve_exported_arguments(self):
        for spelling in (str(self.integration).replace("\\", "/"), str(self.integration).replace("/", "\\")):
            changed = copy.deepcopy(self.config)
            changed["args"] += ["--integration-config", spelling, "--integration-sha256", probe.digest(self.integration)]
            before = copy.deepcopy(changed)
            with self.subTest(spelling="forward" if "/" in spelling else "backslash"):
                self.assertTrue(self.check(changed, integration=self.integration)["integrationPinned"])
                self.assertEqual(changed, before)

    def test_different_integration_path_is_rejected_even_with_matching_bytes(self):
        other = self.root / "other-integration.json"
        other.write_bytes(self.integration.read_bytes())
        self.config["args"] += ["--integration-config", str(other), "--integration-sha256", probe.digest(self.integration)]
        with self.assertRaises(probe.smoke.SmokeError):
            self.check(integration=self.integration)

    def test_source_checkout_wrapper_is_rejected(self):
        other = self.root / "source-wrapper.py"
        other.write_bytes(b"synthetic fixture")
        self.config["args"][1] = str(other)
        with self.assertRaises(probe.smoke.SmokeError):
            self.check()

    def test_generated_database_cannot_be_retargeted(self):
        other = self.root / "other.sqlite"
        other.write_bytes(b"synthetic fixture")
        self.config["args"][5] = str(other)
        with self.assertRaises(probe.smoke.SmokeError):
            self.check()

    def test_tool_scope_and_target_cannot_differ(self):
        for index, value in ((7, "other-project"), (9, "other-site"), (11, "local")):
            changed = copy.deepcopy(self.config)
            changed["args"][index] = value
            with self.subTest(index=index), self.assertRaises(probe.smoke.SmokeError):
                self.check(changed)

    def test_injected_environment_or_extra_argv_is_rejected(self):
        changed = copy.deepcopy(self.config)
        changed["env"] = {"PYTHONPATH": "synthetic-fallback"}
        with self.assertRaises(probe.smoke.SmokeError):
            self.check(changed)
        self.config["args"] += ["--source-root", "synthetic-fallback"]
        with self.assertRaises(probe.smoke.SmokeError):
            self.check()

    def test_nonisolated_or_unsigned_integration_is_rejected(self):
        changed = copy.deepcopy(self.config)
        changed["args"][0] = "-B"
        with self.assertRaises(probe.smoke.SmokeError):
            self.check(changed)
        self.config["args"] += ["--integration-config", str(self.integration)]
        with self.assertRaises(probe.smoke.SmokeError):
            self.check(integration=self.integration)

    def test_revision_and_cross_source_evidence_are_checked(self):
        result = {"schema": "lmti.agent.response.v1", "operation": "project.context", "status": "ok", "error": None,
                  "scope": {"projectId": "factory-monitor", "site": "factory-demo", "modelTarget": "external"},
                  "sources": [{"sourceId": "native", "authority": "declared_structure", "version": {"type": "owner_revision", "value": 1}}],
                  "evidence": [{"sourceId": "native", "sourceRevision": 1}]}
        probe.verify_scope(result, "project.context")
        result["evidence"][0]["sourceRevision"] = 2
        with self.assertRaises(probe.smoke.SmokeError):
            probe.verify_scope(result, "project.context")
        result["evidence"][0] = {"sourceId": "other", "sourceRevision": 1}
        with self.assertRaises(probe.smoke.SmokeError):
            probe.verify_scope(result, "project.context")


if __name__ == "__main__":
    unittest.main()
