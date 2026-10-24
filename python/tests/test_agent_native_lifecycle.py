"""Direct-child lifetime tests; controlled events are not native/subtree proof."""
from __future__ import annotations

from collections import deque
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from lmti_agent.source import NativeProjectSource
from lmti_common.process import ProcessError, read_owner
from lmti_project import Client as ProjectClient, Grant, ProjectError


RealThread = threading.Thread
RealPopen = subprocess.Popen


class ControlledStream:
    """Independently controlled pipe EOF, distinct from direct process exit."""
    def __init__(self, chunks=(), *, read_error=False):
        self.chunks = deque(chunks)
        self.condition = threading.Condition()
        self.eof = False
        self.closed = False
        self.read_error = read_error
        self.reading = threading.Event()
        self.bytes_read = 0

    def read(self, size):
        self.reading.set()
        with self.condition:
            if self.read_error:
                raise OSError("fixture-only private pipe failure")
            while not self.chunks and not self.eof:
                self.condition.wait()
            if not self.chunks:
                return b""
            data = self.chunks.popleft()
            if len(data) > size:
                self.chunks.appendleft(data[size:])
                data = data[:size]
            self.bytes_read += len(data)
            return data

    def finish(self):
        with self.condition:
            self.eof = True
            self.condition.notify_all()

    def close(self):
        with self.condition:
            self.closed = True
            self.eof = True
            self.condition.notify_all()


class ControlledChild:
    """kill() requests termination but deliberately does not prove close."""
    def __init__(self, stream=None, *, timeout=False, wait_error=False, kill_error=False):
        self.stdout = stream if stream is not None else ControlledStream()
        self.returncode = None
        self.closed = threading.Event()
        self.kill_requested = threading.Event()
        self.wait_entered = threading.Event()
        self.force_timeout = timeout
        self.force_wait_error = wait_error
        self.kill_error = kill_error
        self.kill_count = 0

    def wait(self, timeout=None):
        self.wait_entered.set()
        if self.force_wait_error:
            self.force_wait_error = False
            raise OSError("fixture-only private wait failure")
        if timeout is not None and self.force_timeout:
            self.force_timeout = False
            raise subprocess.TimeoutExpired("fixture-only-private-command", timeout)
        if not self.closed.wait(timeout):
            raise subprocess.TimeoutExpired("fixture-only-private-command", timeout)
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.kill_count += 1
        self.kill_requested.set()
        if self.kill_error:
            raise OSError("fixture-only private kill failure")

    def finish(self, code=-9):
        self.returncode = code
        self.closed.set()


class Invocation:
    def __init__(self, call):
        self.done = threading.Event()
        self.value = None
        self.error = None

        def invoke():
            try:
                self.value = call()
            except BaseException as error:
                self.error = error
            finally:
                self.done.set()

        self.worker = RealThread(target=invoke, daemon=True)
        self.worker.start()

    def cleanup(self, child):
        child.finish()
        child.stdout.finish()
        self.worker.join(3)


class NativeCloseTest(unittest.TestCase):
    def invoke(self, child, *, max_bytes=100):
        return Invocation(lambda: read_owner(["fixed-owner", "snapshot"], {"PATH": "fixed"},
                                            "/fixed", max_bytes, retain_until_closed=True))

    def assert_pending(self, invocation):
        self.assertFalse(invocation.done.wait(0.05), "caller released before proven close")

    def assert_error(self, invocation, code):
        self.assertTrue(invocation.done.wait(3))
        invocation.worker.join(3)
        self.assertFalse(invocation.worker.is_alive())
        self.assertIsInstance(invocation.error, ProcessError)
        self.assertEqual(str(invocation.error), code)

    def test_success_keeps_call_until_direct_child_exit_after_pipe_eof(self):
        child = ControlledChild(ControlledStream([b"exact-output"]))
        child.stdout.finish()
        with patch("lmti_common.process.subprocess.Popen", return_value=child) as spawn:
            call = self.invoke(child)
            try:
                self.assertTrue(child.wait_entered.wait(3))
                self.assert_pending(call)
                child.finish(0)
                self.assertTrue(call.done.wait(3))
                self.assertIsNone(call.error)
                self.assertEqual(call.value, b"exact-output")
                self.assertTrue(child.stdout.closed)
                self.assertEqual(child.kill_count, 0)
                self.assertFalse(spawn.call_args.kwargs["shell"])
                self.assertEqual(spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)
                self.assertEqual(spawn.call_args.kwargs["stderr"], subprocess.DEVNULL)
            finally:
                call.cleanup(child)

    def test_timeout_and_failed_kill_retain_child_then_pipe_drain(self):
        child = ControlledChild(timeout=True, kill_error=True)
        with patch("lmti_common.process.subprocess.Popen", return_value=child):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_pending(call)  # actual process exit is not pipe EOF
                child.stdout.finish()
                self.assert_error(call, "OWNER_TIMEOUT")
                self.assertTrue(child.stdout.closed)
            finally:
                call.cleanup(child)

    def test_overflow_discards_later_bytes_but_drains_before_return(self):
        child = ControlledChild(ControlledStream([b"x" * 101, b"z" * 10000]))
        with patch("lmti_common.process.subprocess.Popen", return_value=child):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_pending(call)
                child.stdout.finish()
                self.assert_error(call, "OWNER_OUTPUT_BUDGET")
                self.assertEqual(child.stdout.bytes_read, 10101)
                self.assertTrue(child.stdout.closed)
                self.assertIsNone(call.value)
            finally:
                call.cleanup(child)

    def test_pipe_read_failure_waits_for_live_child(self):
        child = ControlledChild(ControlledStream(read_error=True))
        with patch("lmti_common.process.subprocess.Popen", return_value=child):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_error(call, "OWNER_UNAVAILABLE")
                self.assertTrue(child.stdout.closed)
            finally:
                call.cleanup(child)

    def test_thread_start_failure_after_spawn_still_waits_for_child(self):
        class NeverStarted:
            ident = None

            def __init__(self, **_kwargs):
                pass

            def start(self):
                raise RuntimeError("fixture-only thread limit")

        child = ControlledChild()
        with patch("lmti_common.process.subprocess.Popen", return_value=child), \
                patch("lmti_common.process.threading.Thread", NeverStarted):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_error(call, "OWNER_UNAVAILABLE")
                self.assertTrue(child.stdout.closed)
            finally:
                call.cleanup(child)

    def test_exception_after_thread_actually_started_still_joins_reader(self):
        class StartedThenRaised:
            def __init__(self, **kwargs):
                self.inner = RealThread(**kwargs)

            @property
            def ident(self):
                return self.inner.ident

            def start(self):
                self.inner.start()
                raise RuntimeError("fixture-only post-start failure")

            def join(self):
                self.inner.join()

        child = ControlledChild()
        with patch("lmti_common.process.subprocess.Popen", return_value=child), \
                patch("lmti_common.process.threading.Thread", StartedThenRaised):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assertTrue(child.stdout.reading.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_pending(call)
                child.stdout.finish()
                self.assert_error(call, "OWNER_UNAVAILABLE")
                self.assertTrue(child.stdout.closed)
            finally:
                call.cleanup(child)

    def test_wait_error_does_not_release_a_live_process(self):
        child = ControlledChild(wait_error=True)
        with patch("lmti_common.process.subprocess.Popen", return_value=child):
            call = self.invoke(child)
            try:
                self.assertTrue(child.kill_requested.wait(3))
                self.assert_pending(call)
                child.finish()
                self.assert_pending(call)
                child.stdout.finish()
                self.assert_error(call, "OWNER_UNAVAILABLE")
            finally:
                call.cleanup(child)

    def test_proven_no_start_is_bounded_and_does_not_export_private_error(self):
        with patch("lmti_common.process.subprocess.Popen",
                   side_effect=OSError("private fixture launcher path")):
            with self.assertRaisesRegex(ProcessError, "^OWNER_UNAVAILABLE$"):
                read_owner(["fixed-owner"], {}, "/fixed", 100, retain_until_closed=True)

    def test_capability_is_exact_bool_and_default_keeps_legacy_route(self):
        class Completed:
            stdout = io.BytesIO(b"legacy")
            returncode = 0

            def wait(self, timeout=None):
                return 0

            def poll(self):
                return 0

        with patch("lmti_common.process.subprocess.Popen", return_value=Completed()) as spawn, \
                patch("lmti_common.process._read_owner_retained") as strict:
            self.assertEqual(read_owner(["fixed-owner"], {}, "/fixed", 100), b"legacy")
            strict.assert_not_called()
            spawn.reset_mock()
            with self.assertRaisesRegex(ProcessError, "^OWNER_UNAVAILABLE$"):
                read_owner(["fixed-owner"], {}, "/fixed", 100, retain_until_closed=1)
            spawn.assert_not_called()


class NativeCapabilityTest(unittest.TestCase):
    def test_source_capability_is_constructor_only_and_preserves_default_call_shape(self):
        grant = Grant("project-a", "site-a")
        with patch("lmti_agent.source.ProjectClient") as client:
            legacy = NativeProjectSource("/fixed/owner", "/fixed/db", grant)
            self.assertFalse(legacy.retain_until_closed)
            client.assert_called_once_with("/fixed/owner", "/fixed/db", grant)
            client.reset_mock()
            strict = NativeProjectSource("/fixed/owner", "/fixed/db", grant,
                                         include_structure=True, retain_until_closed=True)
            self.assertTrue(strict.retain_until_closed)
            self.assertTrue(strict.include_structure)
            client.assert_called_once_with("/fixed/owner", "/fixed/db", grant,
                                           retain_until_closed=True)
            with self.assertRaises(AttributeError):
                strict.retain_until_closed = False
            client.reset_mock()
            with self.assertRaises(ValueError):
                NativeProjectSource("/fixed/owner", "/fixed/db", grant, retain_until_closed=1)
            client.assert_not_called()

    def test_project_snapshot_keeps_validator_and_environment_with_explicit_strict_route(self):
        grant = Grant("project-a", "site-a")
        with tempfile.TemporaryDirectory(prefix="lmti-native-close-") as directory:
            root = Path(directory).resolve()
            binary, database = root / "lmti-project.exe", root / "project.sqlite"
            binary.write_bytes(b"fixture-not-executable")
            database.write_bytes(b"fixture-not-sqlite")
            for retained in (False, True):
                with self.subTest(retained=retained):
                    client = ProjectClient(binary, database, grant, retain_until_closed=retained)
                    # Snapshot validation itself is covered by existing native DTO tests.
                    payload = {"fixture": "owned bytes"}
                    with patch("lmti_project.client.read_owner",
                               return_value=json.dumps(payload).encode()) as read, \
                            patch("lmti_project.client.validate_snapshot") as validate:
                        self.assertEqual(client.snapshot(include_structure=True), payload)
                        self.assertEqual(read.call_args.args[0],
                                         [str(binary), "structure-snapshot", str(database),
                                          "project-a", "site-a", "external"])
                        self.assertEqual(read.call_args.args[2:], (str(root), 4 * 1024 * 1024))
                        self.assertEqual(read.call_args.kwargs,
                                         {"retain_until_closed": True} if retained else {})
                        environment = read.call_args.args[1]
                        self.assertTrue(set(environment) <= {
                            "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "PATH", "QT_PLUGIN_PATH"})
                        self.assertEqual(environment["QT_PLUGIN_PATH"], str(root))
                        validate.assert_called_once_with(payload, "project-a", "site-a",
                                                         True, False, True)
            with self.assertRaises(ProjectError):
                ProjectClient(binary, database, grant, retain_until_closed="true")


class ActualDirectChildTest(unittest.TestCase):
    """Actual Python child/pipe closure; no Qt/native DTO or subtree assertion."""
    def run_child(self, script, *, max_bytes=100, timeout=10):
        children = []

        def spawn(*args, **kwargs):
            child = RealPopen(*args, **kwargs)
            children.append(child)
            return child

        environment = {key: os.environ[key] for key in
                       ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        environment["PATH"] = str(Path(sys.executable).resolve().parent)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(
                Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        with tempfile.TemporaryDirectory(prefix="lmti-native-direct-") as directory:
            with patch("lmti_common.process.subprocess.Popen", side_effect=spawn):
                try:
                    value = read_owner([sys.executable, "-I", "-c", script], environment,
                                       str(Path(directory).resolve()), max_bytes, timeout,
                                       retain_until_closed=True)
                    return value
                finally:
                    self.assertEqual(len(children), 1)
                    child = children[0]
                    # Cleanup also protects the test host if an assertion exposes a regression.
                    was_closed = child.poll() is not None and child.stdout.closed
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
                    child.stdout.close()
                    self.assertTrue(was_closed, "reader returned before actual child/pipe close")

    def test_actual_direct_child_success_is_closed(self):
        self.assertEqual(self.run_child("import sys; sys.stdout.buffer.write(b'closed')"), b"closed")

    def test_actual_direct_child_timeout_is_closed(self):
        with self.assertRaisesRegex(ProcessError, "^OWNER_TIMEOUT$"):
            self.run_child("import time; time.sleep(5)", timeout=1)

    def test_actual_direct_child_overflow_is_closed(self):
        with self.assertRaisesRegex(ProcessError, "^OWNER_OUTPUT_BUDGET$"):
            self.run_child("import sys; sys.stdout.buffer.write(b'x' * 8192)", max_bytes=16)


if __name__ == "__main__":
    unittest.main()
