"""Pure fixed-marker codec compatibility; no process claims or marker writes."""
from __future__ import annotations

import copy
import importlib.util
import os
from pathlib import Path
import unittest

SCRIPT = Path(os.environ.get("LMTI_WEB_TEST_BROKER_GUARD",
                             Path(__file__).resolve().parents[1] / "scripts/web-broker-guard.py"))
spec = importlib.util.spec_from_file_location("physical_guard_codec", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def subject(kind="physical_hierarchy", action="physical-hierarchy-commit", project="project"):
    return {"version": 1, "kind": kind, "action": action, "projectId": project,
            "grantId": "a" * 64, "target": {"version": 1, "original": "inert-private-target"}}


def entry(index, value):
    return {"id": f"00000000-0000-4000-8000-{index:012d}", "subject": value}


class PhysicalMarkerCodecTests(unittest.TestCase):
    def test_new_finite_family_preserves_all_legacy_family_bytes(self):
        values = [subject(),
                  *[subject("legacy", action) for action in
                    ("profile_save", "desired_proposal", "client_apply", "client_restore")],
                  subject("logical_hierarchy", "logical-hierarchy-commit"),
                  *[subject("project_operations", action) for action in
                    ("copy-prepare", "activation-prepare", "activation-activate", "activation-abandon")],
                  subject("project_operations", "library-upgrade-v1", None),
                  subject("project_operations", "library-upgrade-v2", None)]
        for value in values:
            with self.subTest(kind=value["kind"], action=value["action"]):
                before = guard.canonical(value)
                self.assertEqual(guard.subject(value), value)
                self.assertEqual(guard.canonical(value), before)
        self.assertEqual(guard.MARKER_SCHEMA, "lmti.web.broker.marker.v2")

    def test_physical_action_project_and_types_are_exact(self):
        for key, value in [("kind", "physical"), ("kind", ["physical_hierarchy"]),
                           ("action", "logical-hierarchy-commit"), ("action", "copy-prepare"),
                           ("action", ["physical-hierarchy-commit"]), ("projectId", None),
                           ("version", True), ("grantId", "a" * 64 + "\n")]:
            with self.subTest(key=key, value=value):
                changed = subject()
                changed[key] = value
                with self.assertRaises(guard.Unavailable):
                    guard.subject(changed)
        changed = subject()
        changed["extra"] = 1
        with self.assertRaises(guard.Unavailable):
            guard.subject(changed)

    def test_mixed_union_keeps_distinct_originals_with_duplicate_project_ids(self):
        a = subject()
        b = copy.deepcopy(a)
        b["target"]["original"] = "different-private-target"
        values = [entry(1, subject("legacy", "profile_save")),
                  entry(2, subject("logical_hierarchy", "logical-hierarchy-commit")),
                  entry(3, a), entry(4, b),
                  entry(5, subject("project_operations", "activation-abandon"))]
        self.assertEqual(guard.entries(values), values)
        self.assertEqual(len(values), 5)
        self.assertNotEqual(guard.canonical(values[2]["subject"]), guard.canonical(values[3]["subject"]))
        with self.assertRaises(guard.Unavailable):
            guard.entries(list(reversed(values)))
        with self.assertRaises(guard.Unavailable):
            guard.entries(values + [copy.deepcopy(values[-1])])

    def test_existing_subject_and_union_caps_are_not_expanded(self):
        self.assertEqual(guard.SUBJECT_CAP, 32 * 1024)
        self.assertEqual(guard.ENTRIES_CAP, 240 * 1024)
        values = [entry(index + 1, subject()) for index in range(32)]
        self.assertEqual(len(guard.entries(values)), 32)
        with self.assertRaises(guard.Unavailable):
            guard.entries(values + [entry(33, subject())])
        value = subject()
        value["target"] = {"rows": [0] * 257}
        with self.assertRaises(guard.Unavailable):
            guard.subject(value)


if __name__ == "__main__":
    unittest.main(verbosity=2)
