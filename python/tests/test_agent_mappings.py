"""Private DTO/lifetime and read-only file pins; no SQL or owner process."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from lmti_agent.mappings import (CONFIG, FRAME, FilePin, MappingFailure, MappingSource,
                                 byte_text, canonical, checked_config, checked_snapshot, strict_json)
from lmti_agent import mappings as mapping_module
from lmti_project import Grant


def encoded(value):
    # Fixture dictionaries use ASCII keys; independent standard JSON framing.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(domain, value):
    return hashlib.sha256(domain.encode() + b"\n" + encoded(value)).hexdigest()


def fixtures(root=None, internal=False, kind="manifest"):
    root = Path(root or tempfile.gettempdir()).absolute() / "mapping-fixture"
    native = {"schema": "lmti.impact.mapping-native.v1", "executable": str(root / "lmti-project.exe"),
              "executableDigest": "a" * 64, "database": str(root / "project.sqlite"),
              "projectId": "project", "storeUuid": "11111111-1111-1111-1111-111111111111",
              "siteId": "factory", "environmentId": "test", "visibility": "local" if internal else "external"}
    source = {"schema": "lmti.impact.mapping-source.v1", "sourceId": "source-one", "projectId": "project",
              "siteId": "factory", "environmentId": "test", "root": str(root),
              "descriptorFile": "manifest.json", "parserVersion": "fixture-1", "policyVersion": "source-policy",
              "kind": kind, "minimumClassification": "public", "allowInternal": False}
    if kind == "code":
        source.update(parserVersion="mapped-named-function-1", allowedInputs=["a.ts", "b.ts"])
    authority = {"sourceId": "source-one", "projectId": "project", "siteId": "factory", "environmentId": "test",
                 "kind": kind, "minimumClassification": "public",
                 "sourceAuthorityFingerprint": digest("lmti.impact.mapping.source-authority.v1", source),
                 "nativeProjectId": "project", "nativeStoreUuid": native["storeUuid"],
                 "nativeAuthorityFingerprint": digest("lmti.impact.mapping.native-authority.v1", native),
                 "policyVersion": "source-policy"}
    config = {"schema": "lmti.agent.mapping-owner.v1", "storePath": str(root / "impact.sqlite"),
              "storeUuid": "22222222-2222-2222-2222-222222222222", "sourceIdentityDigest": "b" * 64,
              "grant": {"principalId": "reader", "projectId": "project", "siteIds": ["factory"],
                        "environmentIds": ["test"], "allowInternal": internal, "policyVersion": "reader-policy"},
              "authority": authority, "native": native, "source": source}
    binding = {"mode": "reviewed", "node": str(root / "node.exe"), "nodeSha256": "c" * 64,
               "cli": str(root / "knowledge" / "index.js"), "cliSha256": "d" * 64,
               "root": str(root), "sourceId": "e" * 64, "memoryDisclosure": "none",
               "mappingOwner": {"cli": str(root / "mapping" / "index.js"), "cliSha256": "f" * 64,
                                "config": str(root / "mapping.json"), "configSha256": "1" * 64,
                                "sourceId": "source-one"}}
    return config, binding


def current(config, rows=None, native_schema=2):
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    a, g = config["authority"], config["grant"]
    source = {"id": a["sourceId"], "projectId": a["projectId"], "siteId": a["siteId"],
              "environmentId": a["environmentId"], "privacy": "public", "kind": a["kind"],
              "revision": "source-r1", "digest": "3" * 64, "capturedAt": now,
              "parserVersion": config["source"]["parserVersion"], "complete": True}
    observation = {"sourceId": a["sourceId"], "authorityFingerprint": a["sourceAuthorityFingerprint"],
                   "revision": source["revision"], "digest": source["digest"], "classification": "public",
                   "checkedAt": now}
    payload = "4" * 64
    accepted = {"batchId": "mapping-" + hashlib.sha256(("lmti.impact.mapping.batch.v1\n" + payload).encode()).hexdigest(),
                "mappingVersion": "accepted-one", "payloadDigest": payload, "reviewedAt": now}
    if rows is None:
        rows = [mapping(config, 1)]
    targets = {}
    evidence = []
    for item in rows:
        m = item["mapping"]
        target = m["target"]
        key = tuple(target[k] for k in ("projectId", "storeUuid", "kind", "id"))
        # Native classification is independent of an association's own floor.
        targets[key] = {"target": target, "effectiveClassification": "public",
                        "ancestryFingerprint": "5" * 64,
                        "referenceFingerprint": m.get("referenceFingerprint"),
                        "identityState": "present_reference" if target["kind"] in {"repository", "knowledge"} else "active"}
        for eid in m["evidenceIds"]:
            evidence.append({"mappingId": m["mappingId"], "evidenceId": eid, "evidenceBatchId": accepted["batchId"],
                             "evidence": {"id": eid, "locator": "PRIVATE_LOCATOR", "summary": "PRIVATE_SUMMARY",
                                          "capturedAt": now, "privacy": "public"}})
    native = {"schema": native_schema, "projectId": a["nativeProjectId"], "storeUuid": a["nativeStoreUuid"],
              "revision": 1, "authorityFingerprint": a["nativeAuthorityFingerprint"], "checkedAt": now,
              "targets": [targets[key] for key in sorted(targets)]}
    result = {"schema": "lmti.impact.mapping-current.v1", "storeUuid": config["storeUuid"],
              "graphRevision": 4, "sourceId": a["sourceId"], "grantFingerprint": hashlib.sha256(encoded(g)).hexdigest(),
              "authorityFingerprint": digest("lmti.impact.mapping.read-authority.v1", a), "accepted": accepted,
              "source": source, "sourceObservation": observation, "sourceContentFingerprint": "6" * 64,
              "nativeObservation": native, "mappings": sorted(rows, key=lambda r: r["mapping"]["mappingId"]),
              "evidenceBindings": sorted(evidence, key=lambda r: (r["mappingId"], r["evidenceId"])),
              "complete": True, "checkedAt": now}
    return rehash(result)


def mapping(config, number, kind="identity", target_id=None, internal=False):
    target_kind = {"identity": "component", "code": "repository", "document": "knowledge", "memory": "component"}[kind]
    target_id = target_id or {"identity": "component-a", "code": "repo-a", "document": "doc-a", "memory": "component-a"}[kind]
    row = {"mappingId": "00000000-0000-0000-0000-" + str(number).zfill(12), "externalKey": "private-" + str(number),
           "generation": "first", "aliases": ["private-alias-" + str(number)], "classification": "internal" if internal else "public",
           "evidenceIds": ["evidence-one"], "state": "active", "impactEntityId": None, "replacesMappingId": None,
           "kind": kind, "target": {"projectId": "project", "storeUuid": config["authority"]["nativeStoreUuid"],
                                   "kind": target_kind, "id": target_id}}
    if kind in {"code", "document"}:
        row.update(selection="src/firmware.ts" if kind == "code" else "docs/design.md",
                   referenceFingerprint=("a" if kind == "code" else "b") * 64)
    elif kind == "memory":
        row["disclosure"] = "owner_safe_summary"
    return {"mapping": row, "effectiveClassification": row["classification"]}


def rehash(value):
    for name, domain in (("sourceObservation", "source-observation"), ("nativeObservation", "native-observation")):
        row = value[name]
        row["fingerprint"] = digest("lmti.impact.mapping." + domain + ".v1",
                                    {k: v for k, v in row.items() if k not in {"checkedAt", "fingerprint"}})
    body = deepcopy(value)
    body.pop("fingerprint", None); body.pop("checkedAt")
    body["sourceObservation"].pop("checkedAt"); body["nativeObservation"].pop("checkedAt")
    value["fingerprint"] = digest("lmti.impact.mapping.current.v1", body)
    return value


class MappingDecoderTests(unittest.TestCase):
    def test_fixed_native_versions_accept_only_their_actual_storage_schema(self):
        for version, storage in ((1, 2), (2, 3)):
            with self.subTest(version=version):
                c, b = fixtures()
                old_authority = c["authority"]["nativeAuthorityFingerprint"]
                c["native"]["schema"] = f"lmti.impact.mapping-native.v{version}"
                c["authority"]["nativeAuthorityFingerprint"] = digest(
                    "lmti.impact.mapping.native-authority.v1", c["native"])
                checked = checked_config(c, b, Grant("project", "factory", "external"),
                                         c["native"]["executable"], c["native"]["database"])
                self.assertEqual(checked, c)
                self.assertEqual(old_authority == c["authority"]["nativeAuthorityFingerprint"], version == 1)
                value = current(c, [mapping(c, 1), mapping(c, 2, "code")], native_schema=storage)
                raw = encoded(value) + b"\n"
                decoded = checked_snapshot(strict_json(raw, FRAME, True), checked)
                self.assertEqual(decoded, value)
                self.assertIs(type(decoded["nativeObservation"]["schema"]), int)
                self.assertEqual(decoded["nativeObservation"]["schema"], storage)
                self.assertNotIn("storageSchema", decoded["nativeObservation"])

    def test_self_consistent_crossed_versions_and_noninteger_storage_are_refused(self):
        for version, correct in ((1, 2), (2, 3)):
            c, b = fixtures()
            c["native"]["schema"] = f"lmti.impact.mapping-native.v{version}"
            c["authority"]["nativeAuthorityFingerprint"] = digest(
                "lmti.impact.mapping.native-authority.v1", c["native"])
            checked_config(c, b, Grant("project", "factory", "external"),
                           c["native"]["executable"], c["native"]["database"])
            self.assertEqual(checked_snapshot(current(c, native_schema=correct), c)["nativeObservation"]["schema"],
                             correct)
            for invalid in (5 - correct, 0, 1, 4, "2", "3", 2.0, 3.0, True, False, None,
                            "lmti.project.mapping-observation.v2"):
                # Every malformed/crossed observation has recomputed aggregate
                # and current hashes; refusal cannot rely on a stale fingerprint.
                value = current(c, native_schema=invalid)
                with self.subTest(version=version, storage=invalid), self.assertRaises(ValueError):
                    checked_snapshot(value, c)
            for location in ("nativeObservation", None):
                value = current(c, native_schema=correct)
                (value if location is None else value[location])["storageSchema"] = correct
                rehash(value)
                with self.subTest(version=version, extra=location), self.assertRaises(ValueError):
                    checked_snapshot(value, c)

    def test_native_config_opt_in_cannot_reuse_old_authority_or_negotiate(self):
        c, b = fixtures()
        binary, database = c["native"]["executable"], c["native"]["database"]
        v2 = deepcopy(c)
        v2["native"]["schema"] = "lmti.impact.mapping-native.v2"
        with self.assertRaises(ValueError):
            checked_config(v2, b, Grant("project", "factory", "external"), binary, database)
        v2["authority"]["nativeAuthorityFingerprint"] = digest(
            "lmti.impact.mapping.native-authority.v1", v2["native"])
        self.assertEqual(checked_config(v2, b, Grant("project", "factory", "external"), binary, database), v2)
        for invalid in (None, True, 2, 3, "", "lmti.impact.mapping-native.v3",
                        "lmti.project.mapping-observation.v2", "lmti.impact.mapping-native.v2\n", []):
            changed = deepcopy(v2)
            changed["native"]["schema"] = invalid
            changed["authority"]["nativeAuthorityFingerprint"] = digest(
                "lmti.impact.mapping.native-authority.v1", changed["native"])
            with self.subTest(tag=invalid), self.assertRaises(ValueError):
                checked_config(changed, b, Grant("project", "factory", "external"), binary, database)
            # Direct current decoding also refuses an invalid configured tag.
            with self.subTest(current_tag=invalid), self.assertRaises(ValueError):
                checked_snapshot(current(changed, native_schema=3), changed)
        for field, added in (("storageSchema", 3), ("command", "mapping-observation-v2")):
            changed = deepcopy(v2)
            changed["native"][field] = added
            changed["authority"]["nativeAuthorityFingerprint"] = digest(
                "lmti.impact.mapping.native-authority.v1", changed["native"])
            with self.subTest(extra=field), self.assertRaises(ValueError):
                checked_config(changed, b, Grant("project", "factory", "external"), binary, database)

    def test_schema3_still_enforces_privacy_and_excludes_receipt_material(self):
        c, b = fixtures()
        c["native"]["schema"] = "lmti.impact.mapping-native.v2"
        c["authority"]["nativeAuthorityFingerprint"] = digest(
            "lmti.impact.mapping.native-authority.v1", c["native"])
        checked_config(c, b, Grant("project", "factory", "external"),
                       c["native"]["executable"], c["native"]["database"])
        baseline = current(c, [mapping(c, 1), mapping(c, 2, "document")], native_schema=3)
        self.assertEqual(checked_snapshot(baseline, c), baseline)
        mutations = [
            lambda v: v["nativeObservation"]["targets"][0].update(effectiveClassification="internal"),
            lambda v: v["sourceObservation"].update(classification="internal"),
            lambda v: v["evidenceBindings"][0]["evidence"].update(privacy="internal"),
            lambda v: v["nativeObservation"].update(receipts=[]),
            lambda v: v["nativeObservation"].update(proposalFormat={"schema": 3}),
            lambda v: v["nativeObservation"]["targets"][0].update(operationId="private-operation"),
            lambda v: v.update(receipt={"requestDigest": "a" * 64}),
            lambda v: v.update(backupPath="PRIVATE_BACKUP"),
        ]
        for change in mutations:
            value = deepcopy(baseline)
            change(value)
            rehash(value)
            with self.subTest(change=change), self.assertRaises(ValueError):
                checked_snapshot(value, c)

    def test_cross_language_schema2_schema3_literal_canonical_vectors(self):
        # Shared literal fixture with TS32. Expected hashes were independently
        # calculated from the specified canonical bytes, not by either owner.
        store = "11111111-2222-4333-8444-555555555555"
        targets = []
        for kind, label, ancestry, reference in (
                ("component", "component-one", "b", None),
                ("repository", "repository-one", "d", "c" * 64)):
            targets.append({"target": {"projectId": "project-one", "storeUuid": store,
                                       "kind": kind, "id": label},
                            "effectiveClassification": "public", "ancestryFingerprint": ancestry * 64,
                            "referenceFingerprint": reference,
                            "identityState": "active" if reference is None else "present_reference"})
        observation = {"schema": 2, "projectId": "project-one", "storeUuid": store,
                       "revision": 7, "authorityFingerprint": "a" * 64, "targets": targets}
        native = {"schema": "lmti.impact.mapping-native.v1", "executable": "C:/lmti-fixture/lmti-project.exe",
                  "executableDigest": "e" * 64, "database": "C:/lmti-fixture/project.sqlite",
                  "projectId": "project-one", "storeUuid": store, "siteId": "site-one",
                  "environmentId": "test", "visibility": "external"}
        vectors = [
            ("lmti.impact.mapping.native-observation.v1", observation,
             "724204f06d0784ff8a784bedf33e5f2a836a03686727354d3a28b4c065e3a667"),
            ("lmti.impact.mapping.native-observation.v1", dict(observation, schema=3),
             "162d6abb9fbc9d1e234e29ac31e8db556efd88057d086ce8bb8e228e350ccff9"),
            ("lmti.impact.mapping.native-authority.v1", native,
             "4bb2e4dd8743cfe03984397beeb73113edcd395292f6712c2d15fee61a77a9f3"),
            ("lmti.impact.mapping.native-authority.v1", dict(native, schema="lmti.impact.mapping-native.v2"),
             "dc9a81fabc430810a79ee51897a49677b757b731caf688350eeabff760884d40"),
        ]
        for domain, value, expected in vectors:
            with self.subTest(domain=domain, schema=value["schema"]):
                self.assertEqual(digest(domain, value), expected)
                self.assertEqual(canonical(value), encoded(value))
                self.assertEqual(mapping_module.tagged(domain, value), expected)

    def test_independent_unicode_domains_and_complete_baseline(self):
        c, b = fixtures()
        checked = checked_config(c, b, Grant("project", "factory", "external"), c["native"]["executable"], c["native"]["database"])
        self.assertEqual(checked["grant"]["policyVersion"], "reader-policy")
        self.assertNotEqual(checked["grant"]["policyVersion"], checked["authority"]["policyVersion"])
        value = current(c)
        value["evidenceBindings"][0]["evidence"]["summary"] = "Tiếng Việt 漢字 😀"
        rehash(value)
        self.assertEqual(checked_snapshot(value, c), value)
        self.assertEqual(canonical({"z": 1, "x": "😀", "a": None}), encoded({"z": 1, "x": "😀", "a": None}))

    def test_strict_json_scalars_duplicates_frames_and_lf_cap(self):
        good = b'{"a":"\\ud83d\\ude00","b":"\\\\ud800"}\n'
        self.assertEqual(strict_json(good, len(good), True), {"a": "😀", "b": "\\ud800"})
        for raw in (b'{"a":"\\ud800"}\n', b'{"a":"\\udc00"}\n', b'{"a":"\\udc00\\ud800"}\n',
                    b'{"a":1,"\\u0061":2}\n', b'{"a":1.25}\n', b'{"a":NaN}\n', good + b"\n",
                    b"\xef\xbb\xbf" + good):
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                strict_json(raw, FRAME, True)
        with self.assertRaises(ValueError): strict_json(good, len(good) - 1, True)

    def test_mapping_byte_limits_differ_from_legacy_evidence_units(self):
        c, _ = fixtures()
        for field in ("externalKey", "aliases", "selection"):
            row = mapping(c, 1, "code")
            limit = 512 if field == "selection" else 240
            value = "é" * (limit // 2 + 1)
            row["mapping"][field] = [value] if field == "aliases" else value
            with self.subTest(field=field), self.assertRaises(ValueError):
                checked_snapshot(current(c, [row]), c)
        byte_text("é" * 120, 240)
        v = current(c); v["evidenceBindings"][0]["evidence"]["summary"] = "é" * 2000
        self.assertEqual(checked_snapshot(rehash(v), c), v)

    def test_config_cross_pins_code_parser_and_sorted_inventory(self):
        c, b = fixtures(kind="code")
        c["source"]["allowedInputs"].reverse()
        result = checked_config(c, b, Grant("project", "factory", "external"), c["native"]["executable"], c["native"]["database"])
        self.assertEqual(result["source"]["allowedInputs"], ["a.ts", "b.ts"])
        mutations = [lambda v: v["source"].update(parserVersion="unsupported"),
                     lambda v: v["native"].update(database=v["native"]["database"] + ".other"),
                     lambda v: v["source"].update(allowInternal=True),
                     lambda v: v["grant"].update(siteIds=["factory", "other"]),
                     lambda v: v["authority"].update(sourceId="e" * 64)]
        for change in mutations:
            v = deepcopy(c); change(v)
            with self.subTest(change=change), self.assertRaises(ValueError):
                checked_config(v, b, Grant("project", "factory", "external"), c["native"]["executable"], c["native"]["database"])

    def test_self_consistent_malformed_rows_and_correlations_refused(self):
        c, _ = fixtures()
        base = current(c, [mapping(c, 1), mapping(c, 2, "code")])
        self.assertEqual(checked_snapshot(base, c), base)
        changes = [lambda v: v.update(complete=1), lambda v: v["accepted"].update(batchId="unrelated"),
                   lambda v: v["nativeObservation"].update(schema=True),
                   lambda v: v["nativeObservation"]["targets"][0].update(identityState="retired"),
                   lambda v: v["mappings"][0]["mapping"].update(state="retired"),
                   lambda v: v["mappings"][0]["mapping"].update(mappingId=v["mappings"][0]["mapping"]["mappingId"] + "\n"),
                   lambda v: v["mappings"][1]["mapping"].update(referenceFingerprint="c" * 64),
                   lambda v: v["evidenceBindings"].pop(), lambda v: v["mappings"].reverse(),
                   lambda v: v["nativeObservation"]["targets"].append(deepcopy(v["nativeObservation"]["targets"][0])),
                   lambda v: v["evidenceBindings"][0]["evidence"].update(privacy="internal"),
                   lambda v: v["sourceObservation"].update(classification="internal"),
                   lambda v: v.update(grantFingerprint="f" * 64)]
        for change in changes:
            v = deepcopy(base); change(v); rehash(v)
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                checked_snapshot(v, c)

    def test_ordinary_original_file_identity_and_bytes_are_pinned(self):
        with tempfile.TemporaryDirectory(prefix="mapping-pin-") as root:
            path = Path(root) / "pin.json"; path.write_bytes(b"{}")
            pin = FilePin(str(path), hashlib.sha256(b"{}").hexdigest(), 2)
            self.assertEqual(pin.verify(True), b"{}")
            retained = Path(root) / "retained.json"; path.rename(retained); path.write_bytes(b"{}")
            with self.assertRaises(ValueError): pin.verify()
            linked = Path(root) / "linked.json"; os.link(path, linked)
            with self.assertRaises(ValueError): FilePin(str(path), hashlib.sha256(b"{}").hexdigest())

    def test_path_and_handle_clocks_are_independent_but_both_remain_pinned(self):
        real_ordinary, real_fstat = mapping_module.ordinary, os.fstat
        def metadata(info, ctime):
            fields = {key: getattr(info, key) for key in
                      ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_nlink", "st_mode")}
            if hasattr(info, "st_birthtime_ns"):
                fields["st_birthtime_ns"] = info.st_birthtime_ns
            return SimpleNamespace(**fields, st_ctime_ns=ctime)
        with tempfile.TemporaryDirectory(prefix="mapping-pin-clocks-") as root:
            path = Path(root) / "pin.json"; path.write_bytes(b"{}")
            clocks = {"path": 100, "handle": 200}
            with patch("lmti_agent.mappings.ordinary",
                       side_effect=lambda p: metadata(real_ordinary(p), clocks["path"])), \
                 patch("lmti_agent.mappings.os.fstat",
                       side_effect=lambda fd: metadata(real_fstat(fd), clocks["handle"])):
                pin = FilePin(str(path), hashlib.sha256(b"{}").hexdigest(), 2)
                self.assertEqual(pin.verify(True), b"{}")
                for changed in ("path", "handle"):
                    clocks[changed] += 1
                    with self.subTest(clock=changed), self.assertRaises(ValueError):
                        pin.verify()
                    clocks[changed] -= 1
                self.assertEqual(pin.verify(True), b"{}")
                # A clock change during one handle read is still refused.
                handle_times = iter((200, 201))
                with patch("lmti_agent.mappings.os.fstat", side_effect=lambda fd: metadata(
                        real_fstat(fd), next(handle_times))):
                    with self.assertRaises(ValueError): pin.verify()
                path_times = iter((100, 101))
                with patch("lmti_agent.mappings.ordinary", side_effect=lambda p: metadata(
                        real_ordinary(p), next(path_times))):
                    with self.assertRaises(ValueError): pin.verify()

    def test_cross_api_identity_mismatch_is_not_tolerated(self):
        real_fstat = os.fstat
        with tempfile.TemporaryDirectory(prefix="mapping-pin-identity-") as root:
            path = Path(root) / "pin.json"; path.write_bytes(b"{}")
            fields = ["st_dev", "st_ino", "st_size", "st_mtime_ns", "st_nlink"]
            if hasattr(path.stat(), "st_birthtime_ns"):
                fields.append("st_birthtime_ns")
            for changed in fields:
                def replaced(fd):
                    info = real_fstat(fd)
                    values = {key: getattr(info, key) for key in
                              ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns",
                               "st_nlink", "st_mode")}
                    if hasattr(info, "st_birthtime_ns"):
                        values["st_birthtime_ns"] = info.st_birthtime_ns
                    values[changed] += 1
                    return SimpleNamespace(**values)
                with self.subTest(field=changed), \
                     patch("lmti_agent.mappings.os.fstat", side_effect=replaced), \
                     self.assertRaises(ValueError):
                    FilePin(str(path), hashlib.sha256(b"{}").hexdigest(), 2)

    def test_installed_node_file_can_be_pinned_without_executing_it(self):
        # Verification runner supplies a fixed PATH containing the pinned Node.
        selected = shutil.which("node")
        self.assertIsNotNone(selected, "The fixed verification PATH must include Node")
        path = Path(selected)
        self.assertTrue(path.is_absolute())
        before = path.lstat()
        with path.open("rb") as source:
            expected = hashlib.file_digest(source, "sha256").hexdigest()
        pin = FilePin(str(path), expected)
        self.assertEqual(pin.verify(), b"")
        after = path.lstat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns),
                         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))


def bare_source():
    source = MappingSource.__new__(MappingSource)
    source._lock, source._pending = threading.Lock(), False
    source.check = Mock()
    source.config, source.binding = fixtures()
    return source


class MappingLifetimeTests(unittest.TestCase):
    def test_caller_deadline_holds_busy_and_non_daemon_until_actual_worker_end(self):
        source = bare_source()
        entered, release, ended = threading.Event(), threading.Event(), threading.Event()
        daemon = []
        def run(abandoned):
            daemon.append(threading.current_thread().daemon); entered.set()
            try: release.wait(); return {}
            finally: ended.set()
        source._run = run
        try:
            with self.assertRaises(MappingFailure) as failed: source.read(time.monotonic() + .2)
            self.assertEqual(failed.exception.code, "BUDGET_EXCEEDED")
            self.assertTrue(entered.wait(1)); self.assertFalse(source.is_idle()); self.assertEqual(daemon, [False])
            with self.assertRaises(MappingFailure) as busy: source.read(time.monotonic() + 1)
            self.assertEqual(busy.exception.code, "BUSY")
        finally:
            release.set(); self.assertTrue(ended.wait(2))
        with source._lock:
            # The lifetime flag is cleared by the worker after its body returns.
            pass

    def test_no_start_resets_reservation_without_child(self):
        source = bare_source()
        with patch("lmti_agent.mappings.threading.Thread.start", side_effect=RuntimeError("fixed")):
            with self.assertRaises(MappingFailure): source.read(time.monotonic() + 1)
        self.assertTrue(source.is_idle())

    def test_fixed_transport_and_schema_tagged_error(self):
        source = bare_source()
        raw = encoded({"schema": "lmti.impact.mapping-current.v1", "error": "SOURCE_CHANGED"}) + b"\n"
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(raw), stderr=io.BytesIO(b""))
        child.wait.return_value = 3
        with patch("lmti_agent.mappings.subprocess.Popen", return_value=child) as spawn:
            with self.assertRaises(MappingFailure) as failed: source._run(threading.Event())
        self.assertEqual(failed.exception.code, "SOURCE_CHANGED")
        args, kwargs = spawn.call_args
        self.assertEqual(args[0][2:], ["accepted-mappings", "--config", source.binding["mappingOwner"]["config"],
                                     "--config-sha256", source.binding["mappingOwner"]["configSha256"]])
        self.assertFalse(kwargs["shell"])
        self.assertLessEqual(set(kwargs["env"]), {"SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"})
        child.wait.assert_called_once_with()

    def test_failed_drain_start_still_waits_actual_child(self):
        source = bare_source(); release, waited, ended = threading.Event(), threading.Event(), threading.Event()
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b""), stderr=io.BytesIO(b""))
        def wait():
            waited.set(); release.wait(); return 3
        child.wait.side_effect = wait
        errors = []
        def call():
            try:
                with patch("lmti_agent.mappings.subprocess.Popen", return_value=child), \
                     patch("lmti_agent.mappings.threading.Thread.start", side_effect=RuntimeError("fixed")):
                    source._run(threading.Event())
            except MappingFailure as error: errors.append(error.code)
            finally: ended.set()
        thread = threading.Thread(target=call)
        thread.start()
        try:
            self.assertTrue(waited.wait(2)); self.assertFalse(ended.is_set())
        finally:
            release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(errors, ["OWNER_UNAVAILABLE"])
        child.kill.assert_not_called()

    def test_wait_error_cannot_release_live_mapping_child(self):
        source = bare_source()
        release, waiting, ended = threading.Event(), threading.Event(), threading.Event()
        raw = encoded({"schema": "lmti.impact.mapping-current.v1", "error": "SOURCE_CHANGED"}) + b"\n"
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(raw), stderr=io.BytesIO(b""))
        calls = []
        def wait():
            calls.append(True)
            if len(calls) == 1: raise OSError("controlled wait failure")
            waiting.set(); release.wait(); return 3
        child.wait.side_effect = wait
        errors = []
        def call():
            try:
                with patch("lmti_agent.mappings.subprocess.Popen", return_value=child):
                    source._run(threading.Event())
            except MappingFailure as error: errors.append(error.code)
            finally: ended.set()
        thread = threading.Thread(target=call); thread.start()
        try:
            self.assertTrue(waiting.wait(2)); self.assertFalse(ended.is_set())
        finally:
            release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(errors, ["SOURCE_CHANGED"])
        child.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
