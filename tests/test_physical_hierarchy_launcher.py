"""Actual launcher serialization using the existing inert disposable harness."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import unittest

import test_project_operation_launcher as harness


class PhysicalLauncherTests(unittest.TestCase):
    # Reuse fixture construction without inheriting/rerunning its older cases.
    run_launcher = harness.LauncherTests.run_launcher
    assert_refused = harness.LauncherTests.assert_refused
    operations = harness.LauncherTests.operations

    def setUp(self):
        self.assertEqual(os.name, "nt", "Configured launcher evidence requires Windows")
        self.assertTrue(harness.PS and shutil.which("node") and shutil.which("python"))
        harness.LauncherTests.setUp(self)

    def physical(self, ids=("project",), internal=()):
        return ["-PhysicalHierarchy", "-PhysicalHierarchyProjectId @("
                + ",".join(harness.literal(value) for value in ids) + ")",
                "-PhysicalHierarchyInternalProjectId @("
                + ",".join(harness.literal(value) for value in internal) + ")"]

    def config(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        raw = self.capture.read_bytes()
        self.assertLessEqual(len(raw), 16384)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertFalse(raw.endswith(b"\r\n"))
        return json.loads(raw)

    def test_physical_only_exact_public_and_internal_grants(self):
        value = self.config(self.run_launcher(*self.physical(("project", "other"), ("other",)),
                                             projects=("project", "other")))
        self.assertEqual(value["physicalHierarchy"], {"projects": [
            {"projectId": "project", "allowInternal": False},
            {"projectId": "other", "allowInternal": True}]})
        self.assertNotIn("logicalHierarchy", value)
        self.assertNotIn("projectOperations", value)
        self.assertNotIn("agentRead", value)

    def test_physical_and_operations_are_independent_explicit_capabilities(self):
        value = self.config(self.run_launcher(*self.physical(), *self.operations(ids=("other",)),
                                             projects=("project", "other")))
        self.assertEqual(value["physicalHierarchy"], {"projects": [{"projectId": "project", "allowInternal": False}]})
        self.assertEqual(value["projectOperations"]["projectIds"], ["other"])
        self.assertNotIn("logicalHierarchy", value)

    def test_absence_preserves_legacy_configuration_shape(self):
        value = self.config(self.run_launcher())
        self.assertNotIn("physicalHierarchy", value)
        self.assertNotIn("logicalHierarchy", value)
        self.assertNotIn("projectOperations", value)

    def test_missing_widened_duplicate_and_unenabled_grants_refuse_before_broker(self):
        for extra in [
            ["-PhysicalHierarchy"],
            ["-PhysicalHierarchyProjectId @('project')"],
            ["-PhysicalHierarchyInternalProjectId @('project')"],
            self.physical(("denied",)),
            self.physical(("project", "project")),
            self.physical(("project",), ("other",)),
            self.physical(("invalid project",)),
        ]:
            with self.subTest(extra=extra):
                self.assert_refused(self.run_launcher(*extra))

    def test_physical_only_reuses_package_and_lmti_data_boundary(self):
        hidden = self.root / ".lmti" / "data"
        hidden.mkdir(parents=True)
        for data in [self.pkg, self.pkg / "bin", hidden]:
            with self.subTest(data=data):
                self.assert_refused(self.run_launcher(*self.physical(), data=data))

    def test_physical_startup_budget_stays_16kib(self):
        ids = tuple("project" + str(index).zfill(3) + "x" * 54 for index in range(200))
        self.assert_refused(self.run_launcher(*self.physical(ids), projects=ids))


if __name__ == "__main__":
    unittest.main(verbosity=2)
