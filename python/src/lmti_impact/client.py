from __future__ import annotations

from contextlib import suppress
import json
import os
from pathlib import Path
import re
import subprocess
import threading
from typing import Any

from lmti_common.boundary import reject_nonfinite, strict_object
from lmti_topology.client import TopologyError

MAX_INPUT = 128 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
TIMEOUT_SECONDS = 10
_ID = re.compile(r"[A-Za-z][A-Za-z0-9._:-]{0,99}\Z", re.ASCII)
_DIGEST = re.compile(r"[a-f0-9]{64}\Z", re.ASCII)
_ERROR = re.compile(r"[A-Z][A-Z0-9_]{0,79}\Z", re.ASCII)
_CATEGORIES = ("code", "contract", "config", "version", "availability", "unknown")


class ImpactError(TopologyError):
    """A fixed error code; never raw source data, subprocess output or local paths."""


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ImpactError("INVALID_ID")
    return value


def text(value: Any, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or re.search(r"[\x00-\x1f\x7f]", value):
        raise ImpactError("INVALID_TEXT")
    try:
        if len(value.encode("utf-16-le")) // 2 > limit:
            raise ImpactError("INVALID_TEXT")
    except UnicodeError as error:
        raise ImpactError("INVALID_TEXT") from error
    return value


def change_request(value: Any) -> dict[str, Any]:
    required = {"entityId", "description", "category", "baselineRevision", "mode", "targetDeploymentIds"}
    optional = {"proposedRevision", "diffDigest"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - optional:
        raise ImpactError("INVALID_CHANGE")
    if value["category"] not in _CATEGORIES or value["mode"] not in ("prospective", "current-observed"):
        raise ImpactError("INVALID_CHANGE")
    targets = value["targetDeploymentIds"]
    if not isinstance(targets, list) or len(targets) > 100:
        raise ImpactError("INVALID_CHANGE")
    checked_targets = [identifier(item) for item in targets]
    if len(set(checked_targets)) != len(checked_targets):
        raise ImpactError("INVALID_CHANGE")
    result = {
        "entityId": identifier(value["entityId"]), "description": text(value["description"], 2000),
        "category": value["category"], "baselineRevision": text(value["baselineRevision"], 160),
        "mode": value["mode"], "targetDeploymentIds": checked_targets,
    }
    if "proposedRevision" in value:
        result["proposedRevision"] = text(value["proposedRevision"], 160)
    if "diffDigest" in value:
        if not isinstance(value["diffDigest"], str) or not _DIGEST.fullmatch(value["diffDigest"]):
            raise ImpactError("INVALID_DIGEST")
        result["diffDigest"] = value["diffDigest"]
    return result


class Client:
    """Launcher paths are fixed; every operation rechecks policy in the TS owner.

    This same-user process boundary is not an OS sandbox. The caller never receives
    a SQLite handle or a way to supply paths, source checks, grants or shell text.
    """

    def __init__(self, node: str | Path, cli: str | Path, config: str | Path):
        try:
            paths = [Path(value) for value in (node, cli, config)]
            if any(not candidate.is_absolute() or candidate.is_symlink() for candidate in paths):
                raise ImpactError("INVALID_LAUNCHER_PATH")
            self._node, self._cli, self._config = [candidate.resolve(strict=True) for candidate in paths]
            if any(not candidate.is_file() for candidate in (self._node, self._cli, self._config)):
                raise ImpactError("INVALID_LAUNCHER_PATH")
            if self._node.name.lower() not in ("node", "node.exe") or self._cli.suffix != ".js" or self._config.suffix != ".json":
                raise ImpactError("INVALID_LAUNCHER_PATH")
            if self._cli.stat().st_size > 8 * 1024 * 1024 or self._config.stat().st_size > MAX_INPUT:
                raise ImpactError("INVALID_LAUNCHER_PATH")
        except (OSError, ValueError, TypeError) as error:
            raise ImpactError("INVALID_LAUNCHER_PATH") from error

    def _environment(self) -> dict[str, str]:
        # No NODE_OPTIONS/NODE_PATH, cloud credentials or loader injection from the
        # caller environment. The owner resolves config paths without caller cwd.
        result = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG") if key in os.environ}
        result["PATH"] = str(self._node.parent)
        if os.name == "nt":
            result["PATH"] += os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        return result

    def _run(self, request: bytes) -> bytes:
        output = bytearray()
        overflow = threading.Event()
        stream_error = threading.Event()
        process: subprocess.Popen[bytes] | None = None
        reader: threading.Thread | None = None
        writer: threading.Thread | None = None
        try:
            if any(candidate.is_symlink() or candidate.resolve(strict=True) != candidate or not candidate.is_file()
                   for candidate in (self._node, self._cli, self._config)):
                raise ImpactError("INVALID_LAUNCHER_PATH")
            process = subprocess.Popen(
                [str(self._node), str(self._cli), "impact", "request", "--config", str(self._config)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                shell=False, cwd=str(self._cli.parent), env=self._environment(),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            assert process.stdin is not None and process.stdout is not None

            def read_output() -> None:
                try:
                    while True:
                        chunk = process.stdout.read(min(65_536, MAX_OUTPUT + 1 - len(output)))
                        if not chunk:
                            return
                        output.extend(chunk)
                        if len(output) > MAX_OUTPUT:
                            overflow.set()
                            process.kill()
                            return
                except (OSError, ValueError):
                    stream_error.set()
                finally:
                    with suppress(OSError, ValueError):
                        process.stdout.close()

            def write_request() -> None:
                try:
                    process.stdin.write(request)
                except (OSError, ValueError):
                    stream_error.set()
                finally:
                    with suppress(OSError, ValueError):
                        process.stdin.close()

            reader = threading.Thread(target=read_output, daemon=True)
            writer = threading.Thread(target=write_request, daemon=True)
            reader.start()
            writer.start()
            try:
                process.wait(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait(timeout=2)
                raise ImpactError("IMPACT_RUNTIME_TIMEOUT") from error
            finally:
                reader.join(timeout=2)
                writer.join(timeout=2)
            if overflow.is_set():
                raise ImpactError("IMPACT_RESPONSE_TOO_LARGE")
            if reader.is_alive() or writer.is_alive() or stream_error.is_set():
                raise ImpactError("IMPACT_RUNTIME_UNAVAILABLE")
            # Structured error envelopes are allowed even when the CLI exits 1.
            if process.returncode and not output:
                raise ImpactError("IMPACT_RUNTIME_REJECTED")
            return bytes(output)
        except ImpactError:
            raise
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise ImpactError("IMPACT_RUNTIME_UNAVAILABLE") from error
        finally:
            if process is not None:
                with suppress(OSError, subprocess.SubprocessError):
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=2)
                # A worker owns its pipe while running. Closing a buffered pipe
                # from another thread can block behind its read/write lock.
                for pipe, worker in ((process.stdin, writer), (process.stdout, reader)):
                    if pipe is not None and (worker is None or not worker.is_alive()):
                        with suppress(OSError, ValueError):
                            pipe.close()

    def _request(self, op: str, **fields: Any) -> dict[str, Any]:
        try:
            request = json.dumps({"schema": "lmti.impact.request.v1", "op": op, **fields},
                                 ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
            if len(request) > MAX_INPUT:
                raise ImpactError("IMPACT_REQUEST_TOO_LARGE")
            response = self._run(request)
            if len(response) > MAX_OUTPUT:
                raise ImpactError("IMPACT_RESPONSE_TOO_LARGE")
            payload = json.loads(response.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
            if not isinstance(payload, dict) or payload.get("schema") != "lmti.impact.response.v1" or type(payload.get("ok")) is not bool:
                raise ImpactError("INVALID_IMPACT_RESPONSE")
            if payload["ok"]:
                if set(payload) != {"schema", "ok", "result"} or not isinstance(payload["result"], dict):
                    raise ImpactError("INVALID_IMPACT_RESPONSE")
                return payload["result"]
            if set(payload) != {"schema", "ok", "error"} or not isinstance(payload["error"], str) or not _ERROR.fullmatch(payload["error"]):
                raise ImpactError("INVALID_IMPACT_RESPONSE")
            raise ImpactError(payload["error"])
        except ImpactError:
            raise
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            raise ImpactError("INVALID_IMPACT_RESPONSE") from error

    def snapshot(self) -> dict[str, Any]:
        return self._request("snapshot")

    def entity(self, entity_id: str) -> dict[str, Any]:
        return self._request("entity", id=identifier(entity_id))

    def evidence(self, evidence_id: str) -> dict[str, Any]:
        return self._request("evidence", id=identifier(evidence_id))

    def report(self, change: dict[str, Any]) -> dict[str, Any]:
        return self._request("report", change=change_request(change))

    def open_report(self, report_id: str) -> dict[str, Any]:
        return self._request("open-report", id=identifier(report_id))
