"""Private bounded subprocess reader for fixed, trusted owner launchers."""
from __future__ import annotations

from contextlib import suppress
import os
import subprocess
import threading


class ProcessError(Exception):
    """Fixed code, never child output or launcher locations."""


def read_owner(argv: list[str], environment: dict[str, str], cwd: str,
               max_bytes: int, timeout: int = 10, *, retain_until_closed: bool = False) -> bytes:
    if type(retain_until_closed) is not bool:
        raise ProcessError("OWNER_UNAVAILABLE")
    if retain_until_closed:
        return _read_owner_retained(argv, environment, cwd, max_bytes, timeout)
    output = bytearray()
    overflow = threading.Event()
    failed = threading.Event()
    worker: threading.Thread | None = None
    child: subprocess.Popen[bytes] | None = None
    try:
        child = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False, env=environment, cwd=cwd,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        assert child.stdout is not None

        def read() -> None:
            try:
                while True:
                    chunk = child.stdout.read(min(65536, max_bytes + 1 - len(output)))
                    if not chunk:
                        return
                    output.extend(chunk)
                    if len(output) > max_bytes:
                        overflow.set()
                        child.kill()
                        return
            except (OSError, ValueError):
                failed.set()
            finally:
                with suppress(OSError, ValueError):
                    child.stdout.close()

        worker = threading.Thread(target=read, daemon=True)
        worker.start()
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            child.kill()
            child.wait(timeout=2)
            raise ProcessError("OWNER_TIMEOUT") from error
        worker.join(timeout=2)
        if overflow.is_set():
            raise ProcessError("OWNER_OUTPUT_BUDGET")
        if worker.is_alive() or failed.is_set() or child.returncode:
            raise ProcessError("OWNER_UNAVAILABLE")
        return bytes(output)
    except ProcessError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ProcessError("OWNER_UNAVAILABLE") from error
    finally:
        if child is not None:
            with suppress(OSError, subprocess.SubprocessError):
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=2)
            if child.stdout is not None and (worker is None or not worker.is_alive()):
                with suppress(OSError, ValueError):
                    child.stdout.close()


def _read_owner_retained(argv: list[str], environment: dict[str, str], cwd: str,
                         max_bytes: int, timeout: int) -> bytes:
    """Direct native child only. Its caller owns any outer deadline/BUSY gate.

    Timeout requests termination; it is not evidence that the process or reader
    has closed. The default reader above deliberately retains its old behavior.
    """
    output = bytearray()
    overflow, failed = threading.Event(), threading.Event()
    child: subprocess.Popen[bytes] | None = None
    worker: threading.Thread | None = None
    started = False
    reason: str | None = None

    def request_stop() -> None:
        if child is not None:
            try:
                if child.poll() is None:
                    child.kill()
            except (OSError, subprocess.SubprocessError):
                failed.set()

    try:
        child = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False, env=environment, cwd=cwd,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        assert child.stdout is not None

        def read() -> None:
            try:
                while True:
                    chunk = child.stdout.read(65536)
                    if not chunk:
                        return
                    if not overflow.is_set():
                        output.extend(chunk[:max(0, max_bytes + 1 - len(output))])
                        if len(output) > max_bytes:
                            overflow.set()
                            request_stop()
                    # Continue draining after overflow without retaining bytes.
            except (OSError, ValueError):
                failed.set()
                request_stop()
            finally:
                with suppress(OSError, ValueError):
                    child.stdout.close()

        worker = threading.Thread(target=read, daemon=True)
        worker.start()
        started = True
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            reason = "OWNER_TIMEOUT"
            request_stop()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        reason = "OWNER_UNAVAILABLE"
        request_stop()
    finally:
        if child is not None:
            request_stop()
            # A failed kill/wait does not release the caller's admission. A
            # successful wait/returncode observation is required before cleanup.
            while child.returncode is None:
                try:
                    child.wait()
                except (OSError, subprocess.SubprocessError):
                    failed.set()
                    request_stop()
                if child.returncode is None:
                    threading.Event().wait(0.05)
            # start() may have raised after creating a thread in an exceptional
            # runtime. Join every actually started worker, without a false 2s close.
            if worker is not None and (started or worker.ident is not None):
                worker.join()
            if child.stdout is not None:
                with suppress(OSError, ValueError):
                    child.stdout.close()
    if reason is not None:
        raise ProcessError(reason)
    if overflow.is_set():
        raise ProcessError("OWNER_OUTPUT_BUDGET")
    if child is None or failed.is_set() or child.returncode:
        raise ProcessError("OWNER_UNAVAILABLE")
    return bytes(output)
