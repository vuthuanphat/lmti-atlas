"""PowerShell launcher boundary tests; only disposable inert package fixtures run."""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = Path(os.environ.get("LMTI_TEST_WEB_LAUNCHER", ROOT / "scripts/start-local-web.ps1"))
PS = shutil.which("pwsh") or shutil.which("powershell")


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == "nt" and PS and shutil.which("node") and shutil.which("python"), "Windows launcher runtimes required")
class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-launch-", dir=os.environ.get("LMTI_WEB_TEST_TMP"))
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.pkg = self.root / "package"
        self.data = self.root / "data"
        self.copies = self.root / "copies"
        self.backups = self.root / "backups"
        self.scripts = self.root / "launcher"
        for folder in [self.pkg / "bin", self.pkg / "apps/web-api/dist", self.pkg / "share/lmti/scripts",
                       self.data, self.copies, self.backups, self.scripts]:
            folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(LAUNCHER, self.scripts / "start-local-web.ps1")
        # The test checks launch policy/serialization, not package doctor's separate
        # integrity suite. This fixed local stub never runs a domain owner.
        (self.scripts / "test-local-web-package.ps1").write_text("param([string]$PackageDirectory)\n", encoding="utf-8")
        for leaf in ["bin/lmti-mcp-admin.exe", "bin/lmti-project.exe", "share/lmti/scripts/lmti-agent-mcp.py",
                     "share/lmti/scripts/mcp-config-owner.py", "share/lmti/scripts/web-broker-guard.py"]:
            (self.pkg / leaf).write_text("inert fixture", encoding="utf-8")
        (self.pkg / "package.json").write_text('{"type":"commonjs"}', encoding="utf-8")
        self.capture = self.pkg / "apps/web-api/dist/captured.json"
        (self.pkg / "apps/web-api/dist/main.js").write_text(
            "const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');"
            "process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{"
            "fs.writeFileSync(__dirname+'/captured.json',input,{flag:'wx'});"
            "process.stdout.write(JSON.stringify({kind:'lmti-local-api',version:1,url:'http://127.0.0.1:1/',pid:process.pid})+'\\n');});",
            encoding="utf-8")

    def run_launcher(self, *extra, projects=("project",), data=None):
        script = self.root / "invoke.ps1"
        invoke = ("$ErrorActionPreference='Stop'\n& " + literal(self.scripts / "start-local-web.ps1")
                  + " -DataDirectory " + literal(self.data if data is None else data)
                  + " -PackageDirectory " + literal(self.pkg) + " -NoBrowser -ProjectId @("
                  + ",".join(literal(item) for item in projects) + ") " + " ".join(extra)
                  + " | ConvertTo-Json -Compress\n")
        script.write_text(invoke, encoding="utf-8")
        return subprocess.run([PS, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(script)],
                              cwd=self.root, capture_output=True, timeout=20, check=False)

    def operations(self, ids=("project",), copies=None, backups=None, maintenance=False):
        args = ["-ProjectOperations", "-CopyParent " + literal(self.copies if copies is None else copies),
                "-BackupParent " + literal(self.backups if backups is None else backups),
                "-OperationProjectId @(" + ",".join(literal(item) for item in ids) + ")"]
        if maintenance:
            args.append("-AllowLibraryUpgrade")
        return args

    def assert_refused(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.capture.exists(), "Broker bootstrap must not run after launch refusal")

    def test_optional_capability_serializes_exact_explicit_grant(self):
        result = self.run_launcher(*self.operations())
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        config = json.loads(self.capture.read_bytes())
        self.assertEqual(config["projectOperations"], {"copyParent": str(self.copies), "backupParent": str(self.backups),
                                                        "projectIds": ["project"], "allowLibraryUpgrade": False})
        self.assertNotIn("agentRead", config)
        self.assertLessEqual(len(self.capture.read_bytes()), 16384)
        self.assertTrue(self.capture.read_bytes().endswith(b"\n"))
        self.assertFalse(self.capture.read_bytes().endswith(b"\r\n"))

    def test_legacy_launch_does_not_add_implicit_capability(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertNotIn("projectOperations", json.loads(self.capture.read_bytes()))

    def test_maintenance_only_requires_explicit_flag_and_grants_no_project(self):
        result = self.run_launcher(*self.operations(ids=(), maintenance=True))
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        config = json.loads(self.capture.read_bytes())["projectOperations"]
        self.assertEqual(config["projectIds"], [])
        self.assertIs(config["allowLibraryUpgrade"], True)

    def test_scope_expansion_and_unenabled_options_refused(self):
        for extra in [self.operations(ids=("denied",)), self.operations(ids=()),
                      ["-CopyParent " + literal(self.copies)], ["-AllowLibraryUpgrade"],
                      self.operations(ids=("project", "project"))]:
            with self.subTest(extra=extra):
                self.assert_refused(self.run_launcher(*extra))

    def test_unsafe_and_noncanonical_parent_spellings_refused(self):
        for path in [r"\\server\share\copies", r"\\?\C:\copies", "C:relative", str(self.copies) + ":ads",
                     str(self.copies) + r"\..\copies", str(self.copies) + r"\NUL", str(self.copies) + r"\a?b"]:
            with self.subTest(path=path):
                self.assert_refused(self.run_launcher(*self.operations(copies=path)))

    def test_package_lmti_same_and_missing_parents_refused(self):
        hidden = self.root / ".lmti/copies"
        hidden.mkdir(parents=True)
        for path in [self.pkg, self.pkg / "bin", hidden, self.backups, self.root / "missing"]:
            with self.subTest(path=path):
                self.assert_refused(self.run_launcher(*self.operations(copies=path)))

    def test_linked_ancestor_is_refused_before_child_access(self):
        nested = self.copies / "nested"
        nested.mkdir()
        marker = nested / "retained.txt"
        marker.write_bytes(b"fixture unchanged")
        alias = self.root / "alias"
        command = "$null=New-Item -ItemType Junction -Path " + literal(alias) + " -Target " + literal(self.copies)
        created = subprocess.run([PS, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                                 capture_output=True, timeout=10, check=False)
        self.assertEqual(created.returncode, 0, created.stderr.decode(errors="replace"))
        self.assert_refused(self.run_launcher(*self.operations(copies=alias / "nested")))
        self.assertEqual(marker.read_bytes(), b"fixture unchanged")

    def test_16kib_budget_refuses_before_broker_spawn(self):
        ids = tuple("project" + str(index).zfill(3) + "x" * 54 for index in range(200))
        self.assert_refused(self.run_launcher(*self.operations(ids=ids), projects=ids))


if __name__ == "__main__":
    unittest.main(verbosity=2)
