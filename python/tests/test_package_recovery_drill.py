"""Fast local boundaries for the synthetic recovery harness; no native launch."""
from contextlib import closing
import copy
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/package-recovery-drill.py"
SPEC = importlib.util.spec_from_file_location("package_recovery_drill", SCRIPT)
drill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drill)


class RecoveryDrillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-recovery-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(drill.UNKNOWN_OWNER_HANDLES.clear)
        self.addCleanup(setattr, drill, "UNKNOWN_OWNER_PID", None)
        self.addCleanup(setattr, drill, "LAST_OWNER_RECEIPT", None)

    def test_unsafe_lexical_paths_are_rejected_before_any_filesystem_probe(self):
        for path in (r"\\server\share\file", "//server/share/file", r"\\?\C:\file", r"C:\safe\file:stream", r"C:\safe\NUL.txt", "C:/safe/../file", "C:/safe/file\n"):
            with self.subTest(path=repr(path)), patch.object(Path, "lstat", side_effect=AssertionError("No filesystem probe permitted")):
                with self.assertRaises(drill.guards.ProbeError):
                    drill.checked_path(path)

    def test_parent_reparse_is_rejected_before_child_probe(self):
        import stat
        from types import SimpleNamespace
        selected = self.root / "linked" / "child"
        seen = []
        actual = Path.lstat
        def inspected(path):
            seen.append(path)
            if path == self.root / "linked":
                return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
            if path == selected:
                self.fail("Child of reparse point was probed")
            return actual(path)
        with patch.object(Path, "lstat", inspected), self.assertRaises(drill.guards.ProbeError):
            drill.checked_path(selected)
        self.assertNotIn(selected, seen)

    def test_sqlite_backup_includes_committed_wal_and_does_not_overwrite(self):
        source, target = self.root / "source.sqlite", self.root / "backup.sqlite"
        with closing(sqlite3.connect(source)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("PRAGMA application_id=1280135250")
            writer.execute("PRAGMA user_version=1")
            writer.execute("CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT)")
            writer.execute("INSERT INTO fixture VALUES(1,'committed-wal-row')")
            writer.commit()
            self.assertTrue(Path(str(source) + "-wal").exists())
            summary = drill.sqlite_backup(source, target)
            self.assertEqual(summary, drill.database_state(source))
            self.assertEqual(summary, drill.database_state(target))
            with closing(sqlite3.connect(target)) as restored:
                self.assertEqual(restored.execute("SELECT value FROM fixture").fetchone()[0], "committed-wal-row")
                self.assertEqual(restored.execute("PRAGMA journal_mode").fetchone()[0], "delete")
            before = target.read_bytes()
            with self.assertRaises(FileExistsError):
                drill.sqlite_backup(source, target)
            self.assertEqual(target.read_bytes(), before)

    def test_append_only_event_chain_detects_edit_and_gap(self):
        (self.root / "events").mkdir()
        drill.event(self.root, "frozen", {"test": True})
        drill.event(self.root, "restore_prepared")
        self.assertEqual(len(drill.event_log(self.root)[0]), 2)
        first = self.root / "events/0001.json"
        first.write_bytes(first.read_bytes() + b" ")
        with self.assertRaises(drill.DrillError):
            drill.event_log(self.root)
        (self.root / "events/0002.json").rename(self.root / "events/0003.json")
        with self.assertRaises(drill.DrillError):
            drill.event_log(self.root)

    def test_memory_backup_preserves_fts_and_owner_migration_metadata(self):
        source = self.root / "project-memory.sqlite"
        target_folder = self.root / "backup"
        target_folder.mkdir()
        with closing(sqlite3.connect(source)) as writer:
            writer.executescript("""
                CREATE TABLE memory_migrations(version INTEGER PRIMARY KEY);
                INSERT INTO memory_migrations VALUES(4);
                CREATE TABLE memory_items(id INTEGER PRIMARY KEY, content TEXT);
                CREATE VIRTUAL TABLE memory_fts USING fts5(content);
                CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items BEGIN
                    INSERT INTO memory_fts(rowid,content) VALUES(new.id,new.content);
                END;
                INSERT INTO memory_items VALUES(1,'reviewed synthetic memory');
            """)
            writer.commit()
        summary = drill.sqlite_backup(source, target_folder / source.name)
        self.assertEqual(summary["memoryMigrationVersion"], 4)
        self.assertEqual(summary, drill.database_state(target_folder / source.name))

    def test_restore_retains_updated_tree_and_resumes_forward_after_interruption(self):
        (self.root / "events").mkdir()
        (self.root / "state").mkdir()
        (self.root / "state/item").write_bytes(b"updated")
        (self.root / "restore-ready").mkdir()
        (self.root / "restore-ready/item").write_bytes(b"baseline")
        drill.event(self.root, "restore_prepared")
        def verify(path):
            return b"baseline" if path.name == "baseline" else b"updated"
        def matches(path, expected):
            self.assertEqual((path / "item").read_bytes(), expected)
        with patch.object(drill, "verify_snapshot", side_effect=verify), patch.object(drill, "state_matches", side_effect=matches):
            self.assertFalse(drill.finish_restore(self.root, interrupt=True))
            self.assertFalse((self.root / "state").exists())
            self.assertEqual((self.root / "retained-post-update/item").read_bytes(), b"updated")
            self.assertTrue(drill.finish_restore(self.root))
            self.assertEqual((self.root / "state/item").read_bytes(), b"baseline")
            self.assertEqual((self.root / "retained-post-update/item").read_bytes(), b"updated")
            with self.assertRaises(drill.DrillError):
                drill.finish_restore(self.root)

    def test_rename_refuses_existing_destination_or_unrelated_root(self):
        (self.root / "state").mkdir()
        (self.root / "retained-post-update").mkdir()
        with self.assertRaises(drill.DrillError):
            drill.retained_rename(self.root / "state", self.root / "retained-post-update", self.root)
        with self.assertRaises(drill.DrillError):
            drill.retained_rename(self.root / "state", self.root.parent / "unrelated", self.root)
        self.assertTrue((self.root / "state").exists())

    @staticmethod
    def inline_thread(*, target, args=(), daemon=False):
        # Synchronous finite fake pipes make cap/deadline tests deterministic.
        return Mock(start=lambda: target(*args))

    @staticmethod
    def process(stdout=b"", stderr=b"", returncode=None):
        process = Mock(pid=12345, stdin=io.BytesIO(), stdout=io.BytesIO(stdout), stderr=io.BytesIO(stderr))
        process.poll.return_value = returncode
        return process

    def test_unknown_write_timeout_is_not_killed_or_retried(self):
        process = self.process()
        with patch.object(drill, "checked_path"), patch.object(drill.subprocess, "Popen", return_value=process) as launch, \
             patch.object(drill.threading, "Thread", side_effect=self.inline_thread), \
             patch.object(drill.time, "monotonic", side_effect=[100, 131]):
            with self.assertRaises(drill.DrillError) as refused:
                drill.run(["fixed-owner"], write=True)
        self.assertEqual(refused.exception.code, "WRITE_OUTCOME_UNKNOWN")
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(drill.UNKNOWN_OWNER_PID, 12345)
        self.assertIs(drill.UNKNOWN_OWNER_HANDLES[0][0], process)
        process.kill.assert_not_called()
        process.wait.assert_not_called()
        process.communicate.assert_not_called()

    def test_both_output_caps_stop_reads_and_preserve_unknown_writes(self):
        for write in (False, True):
            for stream in ("stdout", "stderr"):
                with self.subTest(write=write, stream=stream):
                    process = self.process(**{stream: b"untrusted-output" * 10000})
                    captured = []
                    class CheckedBuffer(bytearray):
                        def extend(buffer, data):
                            super(CheckedBuffer, buffer).extend(data)
                            self.assertLessEqual(len(buffer), 16)
                            captured.append(len(buffer))
                    with patch.object(drill, "checked_path"), patch.object(drill.subprocess, "Popen", return_value=process) as launch, \
                         patch.object(drill.threading, "Thread", side_effect=self.inline_thread), \
                         patch.object(drill, "bytearray", CheckedBuffer, create=True), \
                         patch.object(drill.time, "monotonic", return_value=0):
                        with self.assertRaises(drill.DrillError) as refused:
                            drill.run(["fixed-owner"], write=write, cap=16)
                    self.assertEqual(refused.exception.code, "WRITE_OUTCOME_UNKNOWN" if write else "BUDGET_EXCEEDED")
                    self.assertEqual(launch.call_count, 1)
                    self.assertEqual(max(captured), 16)
                    process.communicate.assert_not_called()
                    if write:
                        process.kill.assert_not_called()
                        process.wait.assert_not_called()
                    else:
                        process.kill.assert_called_once_with()
                        process.wait.assert_called_once_with(timeout=1)

    def test_read_timeout_has_bounded_reap_even_if_reap_times_out(self):
        process = self.process()
        process.wait.side_effect = drill.subprocess.TimeoutExpired("fixed-owner", 1)
        with patch.object(drill, "checked_path"), patch.object(drill.subprocess, "Popen", return_value=process), \
             patch.object(drill.threading, "Thread", side_effect=self.inline_thread), \
             patch.object(drill.time, "monotonic", side_effect=[100, 131]):
            with self.assertRaises(drill.DrillError) as refused:
                drill.run(["fixed-owner"])
        self.assertEqual(refused.exception.code, "OWNER_FAILED")
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=1)

    def test_real_streaming_process_returns_stdout_and_drains_stderr(self):
        result = drill.run([sys.executable, "-I", "-B", "-c",
            "import sys; data=sys.stdin.buffer.read(); sys.stderr.buffer.write(b'notice'); sys.stdout.buffer.write(data.upper())"],
            payload=b"synthetic-only", cap=32)
        self.assertEqual(result, b"SYNTHETIC-ONLY")

    def test_input_cap_fails_before_spawn(self):
        with patch.object(drill.subprocess, "Popen") as launch:
            with self.assertRaises(drill.DrillError):
                drill.run(["fixed-owner"], payload=b"x" * (4 * 1024 * 1024 + 1))
        launch.assert_not_called()

    def test_busy_sqlite_backup_deadline_preserves_new_partial_target(self):
        source = self.root / "source.sqlite"
        target = self.root / "partial.sqlite"
        source.write_bytes(b"original retained")
        src, dst = Mock(), Mock()
        def busy_backup(destination, **options):
            self.assertIs(destination, dst)
            self.assertEqual(options["pages"], 128)
            self.assertEqual(options["sleep"], 0.01)
            options["progress"](sqlite3.SQLITE_BUSY, 1, 1)
        src.backup.side_effect = busy_backup
        with patch.object(drill, "database_state", return_value={"fixture": True}), \
             patch.object(drill, "sql_connection", side_effect=[src, dst]), \
             patch.object(drill.time, "monotonic", side_effect=[100, 131]):
            with self.assertRaises(drill.DrillError) as refused:
                drill.sqlite_backup(source, target)
        self.assertEqual(refused.exception.code, "BUDGET_EXCEEDED")
        self.assertEqual(source.read_bytes(), b"original retained")
        self.assertTrue(target.exists())
        src.backup.assert_called_once()
        src.execute.assert_called_once_with("PRAGMA busy_timeout=250")
        dst.execute.assert_called_once_with("PRAGMA busy_timeout=250")
        src.close.assert_called_once()
        dst.close.assert_called_once()

    def test_exported_python_spelling_is_preserved_after_identity_check(self):
        exported = Path(sys.executable).as_posix()
        arguments = drill.python_args(self.root, exported)
        self.assertEqual(arguments[0], exported)
        wrong = self.root / "different-python.exe"
        wrong.write_bytes(b"not executed")
        with self.assertRaises(drill.DrillError) as refused:
            drill.python_args(self.root, str(wrong))
        self.assertEqual(refused.exception.code, "OWNER_FAILED")

    def test_producer_uses_fresh_local_temp_without_inheriting_user_paths(self):
        runtime = self.root / "fixture-runtime"
        runtime.mkdir()
        with patch.dict(drill.os.environ, {"TEMP": r"\\network\private", "TMP": r"C:\private-user-temp"}):
            environment = drill.producer_environment(runtime, self.root / "package")
        self.assertEqual(set(environment), {"TMP", "TEMP", "LMTI_PYTHON_BINARY", "LMTI_AGENT_ENTRY", "LMTI_PROJECT_BINARY"})
        self.assertEqual(environment["TEMP"], str(runtime / "temp"))
        self.assertEqual(environment["TMP"], environment["TEMP"])
        self.assertTrue((runtime / "temp").is_dir())
        (runtime / "temp/preserved").write_bytes(b"fixture-only")
        with self.assertRaises(drill.DrillError):
            drill.producer_environment(runtime, self.root / "package")
        self.assertEqual((runtime / "temp/preserved").read_bytes(), b"fixture-only")

    def test_producer_rejects_remote_temp_root_before_filesystem_io(self):
        with patch.object(Path, "lstat", side_effect=AssertionError("No filesystem probe permitted")):
            with self.assertRaises(drill.guards.ProbeError):
                drill.producer_environment(Path(r"\\network\runtime"), self.root)

    def test_private_owner_receipt_contains_phase_exit_and_hashes_without_raw_output(self):
        process = self.process(stderr=b"private path and credential marker", returncode=7)
        with patch.object(drill, "checked_path"), patch.object(drill.subprocess, "Popen", return_value=process), \
             patch.object(drill.threading, "Thread", side_effect=self.inline_thread):
            with self.assertRaises(drill.DrillError) as refused:
                drill.run(["fixed-owner"], operation="fixture_producer", write=True)
        self.assertEqual(refused.exception.code, "OWNER_FAILED")
        receipt = drill.LAST_OWNER_RECEIPT
        self.assertEqual(receipt["operation"], "fixture_producer")
        self.assertEqual(receipt["exitCode"], 7)
        self.assertEqual(receipt["stderrBytesCaptured"], 34)
        self.assertEqual(receipt["stderrSha256"], drill.digest(b"private path and credential marker"))
        self.assertNotIn("private path", json.dumps(receipt))
        self.assertNotIn("credential marker", json.dumps(receipt))
        process.kill.assert_not_called()

    def test_diagnostic_operation_cannot_contain_paths_or_unbounded_text(self):
        with patch.object(drill.subprocess, "Popen") as launch:
            for operation in ("C:/private/file", "x" * 33, "newline\n"):
                with self.subTest(operation=operation), self.assertRaises(drill.DrillError):
                    drill.run(["fixed-owner"], operation=operation)
        launch.assert_not_called()

    @staticmethod
    def replay(value=24.5, revision=1):
        return {"status": "ok", "unknowns": [], "conflicts": [],
            "sources": [{"sourceId": "native"}, {"sourceId": "recovery-observations", "kind": "controlled_replay",
                "authority": "controlled_observation", "version": {"type": "replay_revision", "value": revision, "fingerprint": "a" * 64},
                "freshness": {"state": "fresh", "basis": "controlled_replay"}}],
            "data": {"observations": [{"identity": {"sourceId": "recovery-observations", "kind": "observation", "sourceEntityId": "recovery-temperature"},
                "projectId": "factory-monitor", "site": "factory-demo", "assetId": "machine-a", "deviceId": "sensor-a",
                "metric": "temperature", "unit": "C", "value": value, "ttlSeconds": 3600, "quality": "good", "classification": "public",
                "sampleAt": "2026-10-19T00:00:00Z", "receivedAt": "2026-10-19T00:00:00Z", "checkedAt": "2026-10-19T00:00:03Z",
                "freshness": {"state": "fresh", "reasons": [], "ageSeconds": 3}, "evidenceIds": ["obs-fixture"]}]},
            "evidence": [{"evidenceId": "obs-fixture", "sourceId": "recovery-observations", "sourceRevision": revision,
                "reference": {"kind": "observation", "sourceEntityId": "recovery-temperature"}, "basis": "controlled_replay"}]}

    def test_exact_baseline_update_and_restored_replay(self):
        baseline = drill.replay_state(self.replay(), value=24.5, revision=1)
        updated = drill.replay_state(self.replay(25.5, 2), value=25.5, revision=2)
        self.assertEqual(updated["sample"]["value"], 25.5)
        restored = self.replay()
        restored["data"]["observations"][0]["checkedAt"] = "2026-10-19T00:01:00Z"
        restored["data"]["observations"][0]["freshness"]["ageSeconds"] = 60
        self.assertEqual(baseline, drill.replay_state(restored, value=24.5, revision=1))
        with self.assertRaises(drill.DrillError):
            drill.replay_state(self.replay(25.5, 2), value=24.5, revision=1)

    def test_missing_wrong_or_stale_replay_cannot_pass(self):
        changes = [
            lambda x: x["data"].update(observations=[]),
            lambda x: x["data"]["observations"].append(copy.deepcopy(x["data"]["observations"][0])),
            lambda x: x.update(status="partial"),
            lambda x: x.update(unknowns=[{"code": "OBSERVATION_STALE"}]),
            lambda x: x.update(conflicts=[{"code": "OBSERVATION_CONFLICT"}]),
            lambda x: x["data"]["observations"][0].update(value=0),
            lambda x: x["data"]["observations"][0].update(unit="F"),
            lambda x: x["data"]["observations"][0].update(assetId="machine-b"),
            lambda x: x["data"]["observations"][0]["identity"].update(sourceId="other"),
            lambda x: x["data"]["observations"][0]["freshness"].update(state="stale"),
            lambda x: x["sources"][1].update(sourceId="other"),
            lambda x: x["sources"][1].update(kind="read_only_provider"),
            lambda x: x["sources"][1]["version"].update(value=2),
            lambda x: x["sources"][1]["freshness"].update(state="unknown"),
            lambda x: x.update(evidence=[]),
            lambda x: x["evidence"][0].update(sourceRevision=2),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                envelope = self.replay()
                change(envelope)
                with self.assertRaises(drill.DrillError) as refused:
                    drill.replay_state(envelope, value=24.5, revision=1)
                self.assertEqual(refused.exception.code, "OWNER_FAILED")


if __name__ == "__main__":
    unittest.main()
