"""Disposable Windows process evidence for the private broker coordination gate."""
from __future__ import annotations

import contextlib
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(os.environ.get("LMTI_WEB_TEST_BROKER_GUARD",
                             Path(__file__).resolve().parents[1] / "scripts" / "web-broker-guard.py"))
spec = importlib.util.spec_from_file_location("web_broker_guard", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def environment():
    value = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    value["LMTI_WEB_TEST_BROKER_GUARD"] = str(SCRIPT)
    return value


DOMAIN = "a" * 64


def public_result(outcome, recovery=True):
    return {"outcome": outcome, "recoveryRequired": recovery}


def invoke_private(root, *, raw=None, pid=None):
    if raw is None:
        raw = json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "claim",
                          "stateRoot": str(root), "brokerPid": pid or os.getpid(), "domainId": DOMAIN}).encode()
    completed = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)], input=raw,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment(), timeout=8, creationflags=0x08000000 if os.name == "nt" else 0)
    if completed.returncode != 0 or completed.stderr or len(completed.stdout) > guard.MARKER_CAP:
        raise AssertionError("Guard did not return its bounded private response.")
    value = json.loads(completed.stdout)
    if set(value) != {"schema", "action", "outcome", "recoveryRequired", "state"} or value["schema"] != guard.RESULT_SCHEMA:
        raise AssertionError("Unexpected response shape.")
    return value


def invoke(root, **kwargs):
    value = invoke_private(root, **kwargs)
    return public_result(value["outcome"], value["recoveryRequired"])


def mutation(root, action, generation, **extra):
    return invoke_private(root, raw=json.dumps({"schema": guard.REQUEST_SCHEMA, "action": action,
        "stateRoot": str(root), "brokerPid": os.getpid(), "domainId": DOMAIN,
        "generation": generation, **extra}).encode("utf-8"))


def retained(number=1, project="factory-monitor"):
    return {"id": f"00000000-0000-4000-8000-{number:012d}", "subject": {
        "version": 1, "kind": "legacy", "action": "profile_save", "projectId": project,
        "grantId": "b"*64, "target": {"path": "D:/synthetic/never-open.sqlite", "identity": "fixture"}}}


def until(check, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    raise AssertionError("Controlled fixture phase did not complete.")


def fixture_actor(args):
    mode = args[0]
    if mode == "writer":
        release, started, finished = map(Path, args[1:])
        started.write_bytes(b"started")
        deadline = time.monotonic() + 20
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        finished.write_bytes(b"released" if release.exists() else b"deadline")
        return
    root, stop = map(Path, args[1:3])
    if mode == "racing-broker":
        until(Path(args[3]).exists)
    if mode == "broker-discard-ack":
        raw = json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "claim",
                          "stateRoot": str(root), "brokerPid": os.getpid(), "domainId": DOMAIN}).encode()
        completed = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)], input=raw,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=environment(), timeout=8, creationflags=0x08000000)
        response = {"outcome": "ack_discarded", "exit": completed.returncode}
    else:
        response = invoke(root)
    if mode in ("broker-retained", "broker-retained-writer") and response["outcome"] == "claimed":
        current = json.loads((root / guard.MARKER_NAME).read_bytes())
        saved = mutation(root, "retain", current["generation"], entry=retained())
        if saved["outcome"] != "updated":
            raise AssertionError("Fixture could not retain original target.")
    child = None
    if mode in ("broker-with-writer", "broker-retained-writer") and response["outcome"] == "claimed":
        release, started, finished = map(Path, args[3:])
        child = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                                  "--fixture", "writer", str(release), str(started), str(finished)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, env=environment(), creationflags=0x08000000)
        until(started.exists)
    print(json.dumps({"claim": response, "writer": child.pid if child else None}), flush=True)
    deadline = time.monotonic() + 20
    while not stop.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    # Real abrupt parent exit: it deliberately does not wait for its writer.
    os._exit(0)


@unittest.skipUnless(os.name == "nt", "Win32 process/lock contract requires Windows")
class BrokerGuardTests(unittest.TestCase):
    def setUp(self):
        temporary_parent = Path(__file__).resolve().parents[1] / "build" / "broker-guard-tests"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="fixture-", dir=temporary_parent)
        self.root = Path(self.temporary.name)
        self.scope = self.root / "scope"
        self.scope.mkdir()
        self.domain = self.scope / "domain-fixture.bin"
        self.domain.write_bytes(b"synthetic domain data must remain unchanged")
        self.domain_hash = hashlib.sha256(self.domain.read_bytes()).hexdigest()
        self.actors = []
        self.writers = []
        self.junctions = []

    def tearDown(self):
        for _, stop in self.actors:
            stop.write_bytes(b"stop")
        for release, _, _ in self.writers:
            release.write_bytes(b"release")
        for actor, _ in self.actors:
            actor.wait(timeout=8)
            actor.stdout.close()
        for _, finished, pid in self.writers:
            until(finished.exists)
            until(lambda: guard.Windows().process(pid)[0] == "gone")
            self.assertEqual(finished.read_bytes(), b"released")
        for junction in self.junctions:
            junction.rmdir()
        self.assertEqual(hashlib.sha256(self.domain.read_bytes()).hexdigest(), self.domain_hash)
        self.temporary.cleanup()

    def start_actor(self, writer=False, scope=None, discard_ack=False, retain=False):
        number = len(self.actors)
        stop = self.root / f"actor-{number}.stop"
        mode = "broker-with-writer" if writer else ("broker-discard-ack" if discard_ack else "broker")
        if retain:
            mode = "broker-retained-writer" if writer else "broker-retained"
        args = [mode, str(scope or self.scope), str(stop)]
        if writer:
            release = self.root / f"writer-{number}.release"
            started = self.root / f"writer-{number}.started"
            finished = self.root / f"writer-{number}.finished"
            args += [str(release), str(started), str(finished)]
        actor = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--fixture", *args],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env=environment(), creationflags=0x08000000)
        self.actors.append((actor, stop))
        # Readiness pipe is bounded by the fixture's own 20s deadline.
        record = json.loads(actor.stdout.readline(512))
        if writer and record["writer"]:
            self.writers.append((release, finished, record["writer"]))
        return actor, stop, record

    def test_first_claim_repeat_exact_private_shape_and_only_coordination_files(self):
        self.assertEqual(invoke(self.scope), public_result("claimed", False))
        self.assertEqual(invoke(self.scope), public_result("claimed", False))
        record = json.loads((self.scope / guard.MARKER_NAME).read_bytes())
        self.assertEqual(record["brokerPid"], os.getpid())
        self.assertRegex(record["creationTime"], r"^[0-9a-f]{16}$")
        self.assertEqual((self.scope / guard.LOCK_NAME).read_bytes(), guard.ENROLLED)
        self.assertEqual({p.name for p in self.scope.iterdir()},
                         {"domain-fixture.bin", guard.MARKER_NAME, guard.LOCK_NAME})

    def test_retained_union_exact_cleanup_and_explicit_full_cas_ack(self):
        state = invoke_private(self.scope)["state"]
        first, second = retained(), retained(2, "second-project")
        first["subject"]["target"]["flag"] = False
        one = mutation(self.scope, "retain", state["generation"], entry=first)
        self.assertEqual(one["outcome"], "updated")
        two = mutation(self.scope, "retain", one["state"]["generation"], entry=second)
        self.assertEqual(two["state"]["entries"], [first, second])
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        for generation, changed in ((state["generation"], first),
                                    (two["state"]["generation"], {**first, "subject": second["subject"]})):
            self.assertEqual(mutation(self.scope, "forget_known", generation, entry=changed)["outcome"], "unavailable")
            self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)
        numeric_alias = json.loads(json.dumps(first))
        numeric_alias["subject"]["target"]["flag"] = 0
        self.assertEqual(mutation(self.scope, "forget_known", two["state"]["generation"],
                                 entry=numeric_alias)["outcome"], "unavailable")
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)
        known = mutation(self.scope, "forget_known", two["state"]["generation"], entry=second)
        self.assertEqual(known["state"]["entries"], [first])
        stale = mutation(self.scope, "acknowledge", known["state"]["generation"],
                         entriesDigest=hashlib.sha256(guard.canonical([])).hexdigest())
        self.assertEqual(stale["outcome"], "unavailable")
        fresh = invoke_private(self.scope)
        self.assertTrue(fresh["recoveryRequired"])
        self.assertEqual(fresh["state"]["entries"], [first])
        cleared = mutation(self.scope, "acknowledge", fresh["state"]["generation"],
                           entriesDigest=hashlib.sha256(guard.canonical([first])).hexdigest())
        self.assertEqual(cleared["state"]["entries"], [])
        self.assertFalse(cleared["recoveryRequired"])

    def test_real_parent_loss_retains_original_target_and_blocks_live_writer(self):
        actor, stop, _ = self.start_actor(writer=True, retain=True)
        original = json.loads((self.scope / guard.MARKER_NAME).read_bytes())
        self.assertEqual(original["entries"], [retained()])
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(invoke(self.scope), public_result("busy"))
        self.assertEqual(json.loads((self.scope / guard.MARKER_NAME).read_bytes()), original)
        release, finished, pid = self.writers[0]
        release.write_bytes(b"release")
        until(finished.exists)
        until(lambda: guard.Windows().process(pid)[0] == "gone")
        claimed = invoke_private(self.scope)
        self.assertEqual(claimed["outcome"], "claimed")
        self.assertTrue(claimed["recoveryRequired"])
        self.assertEqual(claimed["state"]["entries"], original["entries"])
        self.assertGreater(claimed["state"]["generation"], original["generation"])

    def test_publication_before_spawn_parent_exit_keeps_target_without_domain_write(self):
        actor, stop, _ = self.start_actor(retain=True)
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        claimed = invoke_private(self.scope)
        self.assertTrue(claimed["recoveryRequired"])
        self.assertEqual(claimed["state"]["entries"], [retained()])
        self.assertEqual(hashlib.sha256(self.domain.read_bytes()).hexdigest(), self.domain_hash)

    def test_lost_retain_ack_and_publication_failure_do_not_erase_provenance(self):
        state = invoke_private(self.scope)["state"]
        raw = json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "retain",
            "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": DOMAIN,
            "generation": state["generation"], "entry": retained()}).encode()
        done = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)], input=raw,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              env=environment(), timeout=8, creationflags=0x08000000)
        self.assertEqual((done.returncode, done.stderr), (0, b""))
        claimed = invoke_private(self.scope)
        self.assertTrue(claimed["recoveryRequired"])
        self.assertEqual(claimed["state"]["entries"], [retained()])
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        value = guard.request(json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "retain",
            "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": DOMAIN,
            "generation": claimed["state"]["generation"], "entry": retained(2)}).encode())
        with mock.patch.object(guard.os, "getppid", return_value=os.getpid()), \
             mock.patch.object(guard, "publish", side_effect=OSError("synthetic publication failure")):
            with self.assertRaises(OSError):
                guard.claim(value)
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)

    def test_v1_and_changed_domain_preserve_coordination_bytes(self):
        state = invoke_private(self.scope)["state"]
        mutation(self.scope, "retain", state["generation"], entry=retained())
        marker_path, lock_path = self.scope / guard.MARKER_NAME, self.scope / guard.LOCK_NAME
        original = marker_path.read_bytes()
        raw = json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "claim",
            "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": "c"*64}).encode()
        self.assertEqual(invoke(self.scope, raw=raw), public_result("unavailable"))
        self.assertEqual(marker_path.read_bytes(), original)
        value = json.loads(original)
        legacy = {k: value[k] for k in ("scopeHash", "brokerPid", "creationTime", "recoveryRequired")}
        legacy["schema"] = "lmti.web.broker.marker.v1"
        data = guard.canonical(legacy)
        marker_path.write_bytes(data)
        for tag in (guard.ENROLLED, b"LMTI-WEB-BROKER-GUARD-1\n"):
            lock_path.write_bytes(tag)
            self.assertEqual(invoke(self.scope), public_result("unavailable"))
            self.assertEqual(marker_path.read_bytes(), data)
            self.assertEqual(lock_path.read_bytes(), tag)

    def test_clean_domain_change_is_claim_only_and_invalidates_old_generation(self):
        first = invoke_private(self.scope)["state"]
        raw = {"schema": guard.REQUEST_SCHEMA, "action": "claim",
               "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": "c"*64}
        changed = invoke_private(self.scope, raw=json.dumps(raw).encode())
        self.assertEqual(changed["outcome"], "claimed")
        self.assertFalse(changed["recoveryRequired"])
        self.assertEqual(changed["state"], {**first, "domainId": "c"*64,
                                          "generation": first["generation"]+1})
        marker_path = self.scope / guard.MARKER_NAME
        before = marker_path.read_bytes()
        # A stale same-process guard cannot publish into the newly adopted domain.
        self.assertEqual(mutation(self.scope, "retain", first["generation"],
                                  entry=retained())["outcome"], "unavailable")
        self.assertEqual(marker_path.read_bytes(), before)
        for field, value in (("coverage", "missing"), ("coverage", "unverifiable"),
                             ("recoveryRequired", True)):
            blocked = {**json.loads(before), field: value}
            marker_path.write_bytes(guard.canonical(blocked))
            original = marker_path.read_bytes()
            self.assertEqual(invoke(self.scope), public_result("unavailable"))
            self.assertEqual(marker_path.read_bytes(), original)

    def test_clean_domain_change_requires_old_broker_and_direct_child_quiescence(self):
        actor, stop, _ = self.start_actor(writer=True)
        marker_path = self.scope / guard.MARKER_NAME
        original = marker_path.read_bytes()
        raw = json.dumps({"schema": guard.REQUEST_SCHEMA, "action": "claim",
            "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": "c"*64}).encode()
        self.assertEqual(invoke(self.scope, raw=raw), public_result("busy"))
        self.assertEqual(marker_path.read_bytes(), original)
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(invoke(self.scope, raw=raw), public_result("busy"))
        self.assertEqual(marker_path.read_bytes(), original)
        release, finished, pid = self.writers[0]
        release.write_bytes(b"release")
        until(finished.exists)
        until(lambda: guard.Windows().process(pid)[0] == "gone")
        changed = invoke_private(self.scope, raw=raw)
        self.assertEqual(changed["outcome"], "claimed")
        self.assertFalse(changed["recoveryRequired"])
        self.assertEqual(changed["state"]["entries"], [])
        self.assertEqual(changed["state"]["domainId"], "c"*64)
        self.assertEqual(changed["state"]["generation"], json.loads(original)["generation"]+1)

    def test_entry_count_and_aggregate_bytes_refuse_before_publication(self):
        state = invoke_private(self.scope)["state"]
        for number in range(1, 33):
            saved = mutation(self.scope, "retain", state["generation"], entry=retained(number))
            self.assertEqual(saved["outcome"], "updated")
            state = saved["state"]
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        self.assertEqual(mutation(self.scope, "retain", state["generation"], entry=retained(33))["outcome"], "unavailable")
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)
        state = mutation(self.scope, "acknowledge", state["generation"],
                         entriesDigest=hashlib.sha256(guard.canonical(state["entries"])).hexdigest())["state"]
        for number in range(1, 8):
            item = retained(number)
            item["subject"]["target"] = {str(i): "x"*7900 for i in range(4)}
            saved = mutation(self.scope, "retain", state["generation"], entry=item)
            self.assertEqual(saved["outcome"], "updated")
            state = saved["state"]
        item = retained(8)
        item["subject"]["target"] = {str(i): "x"*7900 for i in range(4)}
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        self.assertEqual(mutation(self.scope, "retain", state["generation"], entry=item)["outcome"], "unavailable")
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)

    def test_subject_shape_unicode_and_safe_integer_wire_limits(self):
        state = invoke_private(self.scope)["state"]
        item = retained()
        item["subject"]["target"] = {"\U00010000": "Việt", "\ue000": 9007199254740991, "zero": -0.0}
        saved = mutation(self.scope, "retain", state["generation"], entry=item)
        self.assertEqual(saved["outcome"], "updated")
        expected = retained()
        expected["subject"]["target"] = {"\U00010000": "Việt", "\ue000": 9007199254740991, "zero": 0}
        self.assertEqual(guard.canonical(saved["state"]["entries"]), guard.canonical([expected]))
        for target in ({"constructor": 1}, {"number": 9007199254740992}, {"number": 1.5},
                       {"text": "\ud800"}, {"text": "x"*8193}, {"items": [0]*257}):
            item = retained(2)
            item["subject"]["target"] = target
            before = (self.scope / guard.MARKER_NAME).read_bytes()
            self.assertEqual(mutation(self.scope, "retain", saved["state"]["generation"], entry=item)["outcome"], "unavailable")
            self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)

    def test_another_live_broker_is_busy_then_pre_spawn_exit_is_reclaimable(self):
        actor, stop, record = self.start_actor()
        self.assertEqual(record["claim"], public_result("claimed", False))
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        self.assertEqual(invoke(self.scope), public_result("busy"))
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(invoke(self.scope), public_result("claimed", True))
        self.assertEqual(invoke(self.scope), public_result("claimed", True))

    def test_orphan_with_no_recorded_child_pid_blocks_then_exit_allows_fresh_claim(self):
        actor, stop, record = self.start_actor(writer=True)
        self.assertEqual(record["claim"]["outcome"], "claimed")
        before = (self.scope / guard.MARKER_NAME).read_bytes()
        self.assertNotIn(str(record["writer"]).encode(), before)
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(guard.Windows().process(record["writer"])[0], "alive")
        self.assertEqual(invoke(self.scope), public_result("busy"))
        self.assertEqual((self.scope / guard.MARKER_NAME).read_bytes(), before)
        release, finished, pid = self.writers[0]
        release.write_bytes(b"release")
        until(finished.exists)
        until(lambda: guard.Windows().process(pid)[0] == "gone")
        self.assertEqual(invoke(self.scope), public_result("claimed", True))

    def test_pid_reuse_with_live_direct_children_stays_conservative(self):
        actor, stop, _ = self.start_actor(writer=True)
        marker_path = self.scope / guard.MARKER_NAME
        record = json.loads(marker_path.read_bytes())
        # Synthetic reused PID: recorded birth is not this currently live process.
        record["creationTime"] = "0000000000000001"
        marker_path.write_text(json.dumps(record), encoding="utf-8")
        # A reused parent's live direct children remain a conservative blocker;
        # birth mismatch is not permission to ignore its child snapshot.
        self.assertTrue(any(guard.Windows().process(pid)[0] == "alive"
                            for pid in guard.Windows().children(actor.pid)))
        self.assertEqual(invoke(self.scope), public_result("busy"))
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(invoke(self.scope), public_result("busy"))
        release, finished, pid = self.writers[0]
        release.write_bytes(b"release")
        until(finished.exists)
        until(lambda: guard.Windows().process(pid)[0] == "gone")
        self.assertEqual(invoke(self.scope), public_result("claimed", True))

    def test_discarded_real_ack_keeps_marker_and_restart_recovery(self):
        actor, stop, record = self.start_actor(discard_ack=True)
        self.assertEqual(record["claim"], {"outcome": "ack_discarded", "exit": 0})
        self.assertEqual(json.loads((self.scope / guard.MARKER_NAME).read_bytes())["brokerPid"], actor.pid)
        self.assertEqual(invoke(self.scope), public_result("busy"))
        stop.write_bytes(b"stop")
        actor.wait(timeout=8)
        self.assertEqual(invoke(self.scope), public_result("claimed", True))

    def test_simultaneous_first_claim_has_exactly_one_live_runtime_winner(self):
        gate = self.root / "race.release"
        racing = []
        for number in range(2):
            stop = self.root / f"race-{number}.stop"
            actor = subprocess.Popen(
                [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--fixture",
                 "racing-broker", str(self.scope), str(stop), str(gate)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=environment(), creationflags=0x08000000)
            self.actors.append((actor, stop))
            racing.append(actor)
        gate.write_bytes(b"start")
        outcomes = [json.loads(actor.stdout.readline(512))["claim"]["outcome"] for actor in racing]
        self.assertEqual(outcomes.count("claimed"), 1)
        self.assertTrue(all(value in ("claimed", "busy", "unavailable") for value in outcomes))
        winner = racing[outcomes.index("claimed")]
        self.assertEqual(json.loads((self.scope / guard.MARKER_NAME).read_bytes())["brokerPid"], winner.pid)
        self.assertEqual(invoke(self.scope), public_result("busy"))

    def test_exclusive_start_lock_refuses_competing_helper_without_marker_change(self):
        windows = guard.Windows()
        with windows.lock(self.scope / guard.LOCK_NAME):
            self.assertIn(invoke(self.scope)["outcome"], ("busy", "unavailable"))
            self.assertFalse((self.scope / guard.MARKER_NAME).exists())
        self.assertEqual(invoke(self.scope), public_result("claimed", False))

    def test_enrolled_missing_and_corrupt_markers_fail_closed(self):
        self.assertEqual(invoke(self.scope)["outcome"], "claimed")
        path = self.scope / guard.MARKER_NAME
        original = path.read_bytes()
        for malformed in (b"", b"{" + b"x" * guard.MARKER_CAP, b"\xff",
                          b'{"schema":"x","schema":"x"}', b"null"):
            path.write_bytes(malformed)
            self.assertEqual(invoke(self.scope), public_result("unavailable"))
            self.assertEqual(path.read_bytes(), malformed)
        path.write_bytes(original)
        path.unlink()  # Exact disposable fixture leaf; never a production recovery action.
        self.assertEqual(invoke(self.scope), public_result("unavailable"))
        self.assertFalse(path.exists())

    def test_strict_requests_reject_before_any_coordination_io(self):
        base = {"schema": guard.REQUEST_SCHEMA, "action": "claim",
                "stateRoot": str(self.scope), "brokerPid": os.getpid(), "domainId": DOMAIN}
        malformed = [
            b"\xff", b"\xef\xbb\xbf{}", b"{} \x00", b"[]", b"{}" + b" " * guard.INPUT_CAP,
            json.dumps({**base, "extra": 1}).encode(),
            json.dumps({**base, "brokerPid": True}).encode(),
            json.dumps({**base, "brokerPid": os.getpid() + 1}).encode(),
            json.dumps({**base, "action": "reset"}).encode(),
            (json.dumps(base)[:-1] + ',"action":"claim"}').encode(),
        ]
        for raw in malformed:
            self.assertEqual(invoke(self.scope, raw=raw), public_result("unavailable"))
        self.assertEqual([p.name for p in self.scope.iterdir()], ["domain-fixture.bin"])

    def test_unsafe_lexical_paths_never_reach_filesystem(self):
        values = [r"\\server\share", "//server/share", r"\\?\C:\fixture", r"\\.\C:\fixture",
                  r"C:\scope:stream", r"C:\scope\..\other", r"C:\scope\.", r"C:relative",
                  r"C:\scope\\child", r"C:\CON\child", "C:\\scope\nchild", r"C:\scope. "]
        values += ["C:\\scope\\" + character + "child" for character in '<>"|?*']
        with mock.patch.object(Path, "lstat", side_effect=AssertionError("Unexpected filesystem call")):
            for value in values:
                with self.assertRaises(guard.Unavailable):
                    guard.local_path(value, directory=True)

    def test_hardlinked_coordination_file_is_refused(self):
        link = self.scope / guard.LOCK_NAME
        source = self.root / "lock-source"
        source.write_bytes(b"")
        os.link(source, link)
        self.assertEqual(invoke(self.scope), public_result("unavailable"))
        self.assertEqual(source.read_bytes(), b"")
        self.assertFalse((self.scope / guard.MARKER_NAME).exists())

    def make_junction(self, path, target):
        path.mkdir()
        windows = guard.Windows()
        function = windows.k.DeviceIoControl
        function.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong,
                             ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
        function.restype = ctypes.c_int
        substitute = ("\\??\\" + str(target)).encode("utf-16-le")
        printed = str(target).encode("utf-16-le")
        names = substitute + b"\0\0" + printed + b"\0\0"
        data = struct.pack("<IHHHHHH", 0xA0000003, 8 + len(names), 0, 0,
                           len(substitute), len(substitute) + 2, len(printed)) + names
        raw = windows.k.CreateFileW(str(path), 0x40000000, 0, None, 3, 0x02200000, None)
        with windows.handle(raw) as handle:
            count = ctypes.c_ulong()
            if not function(handle, 0x900A4, data, len(data), None, 0, ctypes.byref(count), None):
                path.rmdir()
                self.skipTest("Host did not permit a disposable local junction.")
        self.junctions.append(path)

    def test_real_local_junction_parent_is_rejected_without_following(self):
        junction = self.root / "redirected"
        self.make_junction(junction, self.scope)
        self.assertEqual(invoke(junction), public_result("unavailable"))
        self.assertFalse((self.scope / guard.MARKER_NAME).exists())

    def test_real_local_junction_coordination_leaf_is_rejected(self):
        target = self.root / "target"
        target.mkdir()
        self.make_junction(self.scope / guard.MARKER_NAME, target)
        self.assertEqual(invoke(self.scope), public_result("unavailable"))
        self.assertEqual(list(target.iterdir()), [])

    def test_denied_process_and_snapshot_errors_do_not_prove_quiescence(self):
        class Fake:
            def process(self, pid):
                if pid == 23:
                    return "gone", None
                raise guard.Unavailable()
            def children(self, parent):
                yield 24
        with self.assertRaises(guard.Unavailable):
            guard.quiescent(Fake(), {"brokerPid": 23, "creationTime": "1" * 16}, os.getpid())
        class ErrorSnapshot(Fake):
            def children(self, parent):
                raise guard.Unavailable()
                yield
        with self.assertRaises(guard.Unavailable):
            guard.quiescent(ErrorSnapshot(), {"brokerPid": 23, "creationTime": "1" * 16}, os.getpid())

    def test_clock_rollback_never_excludes_a_live_child(self):
        class Fake:
            def process(self, pid):
                return ("gone", None) if pid == 23 else ("alive", "0" * 15 + "1")
            def children(self, parent):
                yield 24
        with self.assertRaises(guard.Busy):
            guard.quiescent(Fake(), {"brokerPid": 23, "creationTime": "f" * 16}, os.getpid())

    def test_process_snapshot_cap_and_end_error_are_checked(self):
        class Kernel:
            def __init__(self, count, end=18):
                self.count, self.end, self.index = count, end, 0
            def CreateToolhelp32Snapshot(self, flags, pid):
                if (flags, pid) != (2, 0):
                    raise AssertionError("Unexpected process inspection scope.")
                return 123
            def CloseHandle(self, handle):
                return 1
            def put(self, pointer):
                if self.index >= self.count:
                    ctypes.set_last_error(self.end)
                    return 0
                row = ctypes.cast(pointer, ctypes.POINTER(guard.ProcessEntry)).contents
                row.th32ParentProcessID = 23
                row.th32ProcessID = 100 + self.index
                return 1
            def Process32FirstW(self, handle, pointer):
                return self.put(pointer)
            def Process32NextW(self, handle, pointer):
                self.index += 1
                return self.put(pointer)
        windows = object.__new__(guard.Windows)
        with mock.patch.object(guard, "PROCESS_CAP", 3):
            windows.k = Kernel(3)
            self.assertEqual(list(windows.children(23)), [100, 101, 102])
            windows.k = Kernel(4)
            with self.assertRaises(guard.Unavailable):
                list(windows.children(23))
            windows.k = Kernel(2, 5)
            with self.assertRaises(guard.Unavailable):
                list(windows.children(23))
        windows.k = Kernel(1)
        with mock.patch.object(guard.time, "monotonic", side_effect=[0, guard.SCAN_SECONDS + 1]):
            with self.assertRaises(guard.Unavailable):
                list(windows.children(23))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--fixture":
        fixture_actor(sys.argv[2:])
    else:
        unittest.main()
