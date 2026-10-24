"""Private Windows broker claim gate; coordination only, never domain authority.

Only participating fixed brokers are covered. Initial enrollment cannot prove
that an older, uninstrumented broker has no writer. No process is terminated.
"""
from __future__ import annotations

import contextlib
import ctypes
from ctypes import wintypes
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import sys
import time
import uuid

REQUEST_SCHEMA = "lmti.web.broker.guard.request.v2"
RESULT_SCHEMA = "lmti.web.broker.guard.v2"
MARKER_SCHEMA = "lmti.web.broker.marker.v2"
LOCK_NAME = ".lmti-web-broker.lock"
MARKER_NAME = ".lmti-web-broker.json"
ENROLLED = b"LMTI-WEB-BROKER-GUARD-2\n"
INPUT_CAP = 64 * 1024
MARKER_CAP = 256 * 1024
SUBJECT_CAP = 32 * 1024
ENTRIES_CAP = 240 * 1024
MAX_SAFE = 9007199254740991
RESERVED = {"__proto__", "constructor", "prototype"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HEX = re.compile(r"[0-9a-f]{64}")
PROJECT = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}")
PROCESS_CAP = 32768
SCAN_SECONDS = 5.0
REPARSE = 0x400
INVALID_HANDLE = ctypes.c_void_p(-1).value


class Unavailable(Exception):
    """Fixed opaque failure; do not expose OS errors or paths."""


class Busy(Exception):
    pass


def result(outcome: str, recovery: bool = True, *, action=None, state=None) -> dict:
    return {"schema": RESULT_SCHEMA, "action": action, "outcome": outcome,
            "recoveryRequired": recovery, "state": state}


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8", "strict")


def json_value(value, depth=0, nodes=None, max_depth=16, max_nodes=8192):
    nodes = [0] if nodes is None else nodes
    nodes[0] += 1
    if depth > max_depth or nodes[0] > max_nodes:
        raise Unavailable()
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if abs(value) > MAX_SAFE:
            raise Unavailable()
        return
    if type(value) is str:
        if len(value.encode("utf-8", "strict")) > 8192:
            raise Unavailable()
        return
    if type(value) is list:
        if len(value) > 256:
            raise Unavailable()
        for item in value:
            json_value(item, depth + 1, nodes, max_depth, max_nodes)
        return
    if type(value) is dict:
        if len(value) > 128:
            raise Unavailable()
        for key, item in value.items():
            if type(key) is not str or key in RESERVED:
                raise Unavailable()
            if len(key.encode("utf-8", "strict")) > 8192:
                raise Unavailable()
            json_value(item, depth + 1, nodes, max_depth, max_nodes)
        return
    raise Unavailable()


def subject(value):
    json_value(value)
    if type(value) is not dict or set(value) != {"version", "kind", "action", "projectId", "grantId", "target"}:
        raise Unavailable()
    actions = {
        "library_management": {"create", "register", "link", "pin", "forget"},
        "legacy": {"profile_save", "desired_proposal", "project_content", "client_apply", "client_restore"},
        "logical_hierarchy": {"logical-hierarchy-commit"},
        "physical_hierarchy": {"physical-hierarchy-commit"},
        "project_operations": {"copy-prepare", "library-upgrade-v1", "library-upgrade-v2",
                               "activation-prepare", "activation-activate", "activation-abandon"},
    }
    kind, action, project = value["kind"], value["action"], value["projectId"]
    if (type(value["version"]) is not int or value["version"] != 1
            or type(kind) is not str or kind not in actions
            or type(action) is not str or action not in actions[kind]
            or type(value["grantId"]) is not str or HEX.fullmatch(value["grantId"]) is None
            or type(value["target"]) is not dict
            or (project is None and action not in {"library-upgrade-v1", "library-upgrade-v2"})
            or (project is not None and (type(project) is not str or PROJECT.fullmatch(project) is None))
            or (action in {"library-upgrade-v1", "library-upgrade-v2"} and project is not None)
            or len(canonical(value)) > SUBJECT_CAP):
        raise Unavailable()
    return value


def entry(value):
    if (type(value) is not dict or set(value) != {"id", "subject"}
            or type(value["id"]) is not str or UUID.fullmatch(value["id"]) is None
            or value["id"] == "00000000-0000-0000-0000-000000000000"):
        raise Unavailable()
    subject(value["subject"])
    return value


def entries(value):
    if type(value) is not list or len(value) > 32:
        raise Unavailable()
    for item in value:
        entry(item)
    json_value(value, max_depth=24, max_nodes=65536)
    ids = [item["id"] for item in value]
    if len(set(ids)) != len(ids) or ids != sorted(ids) or len(canonical(value)) > ENTRIES_CAP:
        raise Unavailable()
    return value


def recovery_state(value):
    return {key: value[key] for key in ("generation", "domainId", "coverage", "entries")}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise Unavailable()
        value[key] = item
    return value


def reject_constant(_):
    raise Unavailable()


def integer_number(text):
    value = Decimal(text)
    if value != value.to_integral_value() or abs(value) > MAX_SAFE:
        raise Unavailable()
    return int(value)


def strict_json(data: bytes, cap: int) -> dict:
    if not data or len(data) > cap:
        raise Unavailable()
    try:
        value = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant, parse_float=integer_number)
    except (ValueError, UnicodeError, RecursionError):
        raise Unavailable() from None
    if type(value) is not dict:
        raise Unavailable()
    return value


def lexical_path(value: str) -> Path:
    # This entire check precedes filesystem calls, including resolve/lstat.
    if (type(value) is not str or not value or len(value) > 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or any(c in '<>"|?*' for c in value)
            or value.startswith(("\\\\", "//"))
            or not re.match(r"^[A-Za-z]:[\\/]", value)
            or ":" in value[2:]):
        raise Unavailable()
    normal = value.replace("/", "\\")
    parts = normal[3:].split("\\")
    if normal[3:] and any(not part or part in (".", "..") or part.endswith((" ", "."))
                         or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",
                                     part, re.IGNORECASE)
                         for part in parts):
        raise Unavailable()
    return Path(normal)


def local_path(value: str, *, directory: bool = False, missing: bool = False) -> Path:
    path = lexical_path(value)
    pure = PureWindowsPath(str(path))
    current = Path(pure.anchor)
    chain = [current]
    for part in pure.parts[1:]:
        current = current / part
        chain.append(current)
    for index, item in enumerate(chain):
        leaf = index == len(chain) - 1
        try:
            info = item.lstat()
        except FileNotFoundError:
            if leaf and missing:
                return path
            raise Unavailable() from None
        except OSError:
            raise Unavailable() from None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE:
            raise Unavailable()
        if not leaf or directory:
            if not stat.S_ISDIR(info.st_mode):
                raise Unavailable()
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Unavailable()
    return path


def request(data: bytes) -> dict:
    value = strict_json(data, INPUT_CAP)
    common = {"schema", "action", "stateRoot", "brokerPid", "domainId"}
    action = value.get("action")
    additions = {"claim": set(), "retain": {"generation", "entry"},
                 "forget_known": {"generation", "entry"},
                 "acknowledge": {"generation", "entriesDigest"}}
    if (type(action) is not str or action not in additions
            or set(value) != common | additions[action]
            or value["schema"] != REQUEST_SCHEMA
            or type(value["brokerPid"]) is not int or not 0 < value["brokerPid"] <= 0xFFFFFFFF):
        raise Unavailable()
    lexical_path(value["stateRoot"])
    if type(value["domainId"]) is not str or HEX.fullmatch(value["domainId"]) is None:
        raise Unavailable()
    if action != "claim":
        if type(value["generation"]) is not int or not 1 <= value["generation"] <= MAX_SAFE:
            raise Unavailable()
        if action in ("retain", "forget_known"):
            entry(value["entry"])
        elif type(value["entriesDigest"]) is not str or HEX.fullmatch(value["entriesDigest"]) is None:
            raise Unavailable()
    return value


class ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]


class FileInformation(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD), ("creation", wintypes.FILETIME),
        ("access", wintypes.FILETIME), ("write", wintypes.FILETIME),
        ("volume", wintypes.DWORD), ("sizeHigh", wintypes.DWORD),
        ("sizeLow", wintypes.DWORD), ("links", wintypes.DWORD),
        ("indexHigh", wintypes.DWORD), ("indexLow", wintypes.DWORD),
    ]


class Windows:
    def __init__(self):
        if os.name != "nt":
            raise Unavailable()
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        declarations = {
            "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                             ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                             wintypes.HANDLE], wintypes.HANDLE),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
            "GetFileInformationByHandle": ([wintypes.HANDLE, ctypes.POINTER(FileInformation)], wintypes.BOOL),
            "ReadFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                           ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
            "WriteFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                            ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
            "FlushFileBuffers": ([wintypes.HANDLE], wintypes.BOOL),
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Process32FirstW": ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
            "Process32NextW": ([wintypes.HANDLE, ctypes.POINTER(ProcessEntry)], wintypes.BOOL),
        }
        for name, (args, returns) in declarations.items():
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, returns

    @contextlib.contextmanager
    def handle(self, value):
        if value is None or value == INVALID_HANDLE:
            raise Unavailable()
        try:
            yield value
        finally:
            self.k.CloseHandle(value)

    def file_info(self, handle, cap: int):
        info = FileInformation()
        if not self.k.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise Unavailable()
        size = (info.sizeHigh << 32) | info.sizeLow
        if info.attributes & (REPARSE | 0x10) or info.links != 1 or size > cap:
            raise Unavailable()
        return info

    def read_handle(self, handle, cap: int) -> bytes:
        self.file_info(handle, cap)
        buffer = ctypes.create_string_buffer(cap + 1)
        count = wintypes.DWORD()
        if not self.k.ReadFile(handle, buffer, cap + 1, ctypes.byref(count), None):
            raise Unavailable()
        if count.value > cap:
            raise Unavailable()
        after = self.file_info(handle, cap)
        if count.value != ((after.sizeHigh << 32) | after.sizeLow):
            raise Unavailable()
        return buffer.raw[:count.value]

    @contextlib.contextmanager
    def lock(self, path: Path):
        local_path(str(path), missing=True)
        raw = self.k.CreateFileW(str(path), 0x80000000 | 0x40000000, 0, None,
                                4, 0x00200000, None)  # OPEN_ALWAYS, OPEN_REPARSE_POINT.
        if raw == INVALID_HANDLE and ctypes.get_last_error() in (32, 33):
            raise Busy()
        with self.handle(raw) as handle:
            tag = self.read_handle(handle, len(ENROLLED))
            if tag not in (b"", ENROLLED):
                raise Unavailable()
            yield handle, bool(tag)

    def enroll(self, handle, enrolled: bool):
        if enrolled:
            return
        # read_handle left an empty, exclusively locked file at position zero.
        count = wintypes.DWORD()
        if (not self.k.WriteFile(handle, ENROLLED, len(ENROLLED), ctypes.byref(count), None)
                or count.value != len(ENROLLED) or not self.k.FlushFileBuffers(handle)):
            raise Unavailable()

    def marker_bytes(self, path: Path) -> bytes | None:
        local_path(str(path), missing=True)
        raw = self.k.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
        if raw == INVALID_HANDLE and ctypes.get_last_error() in (2, 3):
            return None
        with self.handle(raw) as handle:
            return self.read_handle(handle, MARKER_CAP)

    def process(self, pid: int) -> tuple[str, str | None]:
        raw = self.k.OpenProcess(0x1000 | 0x100000, False, pid)
        if not raw:
            if ctypes.get_last_error() == 87:  # Definitively absent PID, not access denied.
                return "gone", None
            raise Unavailable()
        with self.handle(raw) as handle:
            state = self.k.WaitForSingleObject(handle, 0)
            if state == 0:
                return "gone", None
            if state != 258:
                raise Unavailable()
            values = [wintypes.FILETIME() for _ in range(4)]
            if not self.k.GetProcessTimes(handle, *(ctypes.byref(v) for v in values)):
                raise Unavailable()
            birth = (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
            return "alive", f"{birth:016x}"

    def children(self, parent: int):
        start = time.monotonic()
        raw = self.k.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS only.
        with self.handle(raw) as handle:
            row = ProcessEntry()
            row.dwSize = ctypes.sizeof(row)
            present = self.k.Process32FirstW(handle, ctypes.byref(row))
            count = 0
            while present:
                count += 1
                if count > PROCESS_CAP or time.monotonic() - start > SCAN_SECONDS:
                    raise Unavailable()
                if row.th32ParentProcessID == parent:
                    yield row.th32ProcessID
                present = self.k.Process32NextW(handle, ctypes.byref(row))
            if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES; no silent truncation.
                raise Unavailable()


def marker(data: bytes, scope: str) -> dict:
    value = strict_json(data, MARKER_CAP)
    if (set(value) != {"schema", "scopeHash", "brokerPid", "creationTime", "recoveryRequired",
                      "generation", "domainId", "coverage", "entries"}
            or value["schema"] != MARKER_SCHEMA or value["scopeHash"] != scope
            or type(value["brokerPid"]) is not int or not 0 < value["brokerPid"] <= 0xFFFFFFFF
            or type(value["creationTime"]) is not str
            or re.fullmatch(r"[0-9a-f]{16}", value["creationTime"]) is None
            or type(value["recoveryRequired"]) is not bool
            or type(value["generation"]) is not int or not 1 <= value["generation"] <= MAX_SAFE
            or type(value["domainId"]) is not str or HEX.fullmatch(value["domainId"]) is None
            or type(value["coverage"]) is not str
            or value["coverage"] not in ("complete", "missing", "unverifiable")):
        raise Unavailable()
    entries(value["entries"])
    return value


def quiescent(windows, old: dict, broker: int):
    state, birth = windows.process(old["brokerPid"])
    if state == "alive" and birth == old["creationTime"]:
        raise Busy()
    # No wall-clock comparison: an old writer may have an earlier FILETIME.
    for pid in windows.children(old["brokerPid"]):
        if pid in (os.getpid(), broker):
            continue  # Exact current read-only helper and still-unadmitted parent.
        state, _ = windows.process(pid)
        if state == "alive":
            raise Busy()


def publish(path: Path, value: dict):
    data = canonical(value) + b"\n"
    if len(data) > MARKER_CAP:
        raise Unavailable()
    local_path(str(path), missing=True)
    temporary = path.parent / (".lmti-web-broker." + uuid.uuid4().hex + ".tmp")
    descriptor = None
    created = False
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_BINARY, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            if stream.write(data) != len(data):
                raise Unavailable()
            stream.flush()
            os.fsync(stream.fileno())
        local_path(str(path), missing=True)
        os.replace(temporary, path)
        created = False
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            # Only this exact newly created temporary leaf; never recursive cleanup.
            with contextlib.suppress(OSError, Unavailable):
                local_path(str(temporary))
                temporary.unlink()


def claim(value: dict, windows=None) -> dict:
    """Fixed action dispatcher; helper never follows provenance target fields."""
    if value["brokerPid"] != os.getppid():
        raise Unavailable()
    windows = windows or Windows()
    root = local_path(value["stateRoot"], directory=True)
    # Resolve only after top-down checks; do not normalize unsafe input first.
    root = local_path(os.path.realpath(root), directory=True)
    scope = hashlib.sha256(str(root).casefold().encode("utf-8")).hexdigest()
    broker = value["brokerPid"]
    state, birth = windows.process(broker)
    if state != "alive" or birth is None:
        raise Unavailable()
    with windows.lock(root / LOCK_NAME) as (handle, enrolled):
        data = windows.marker_bytes(root / MARKER_NAME)
        action = value["action"]
        if data is None:
            if enrolled or action != "claim":
                raise Unavailable()
            old = {"schema": MARKER_SCHEMA, "scopeHash": scope, "brokerPid": broker,
                   "creationTime": birth, "recoveryRequired": False,
                   "generation": 1, "domainId": value["domainId"],
                   "coverage": "complete", "entries": []}
            changed = True
        else:
            old = marker(data, scope)
            domain_changed = old["domainId"] != value["domainId"]
            if domain_changed and (action != "claim" or old["coverage"] != "complete"
                                   or old["entries"] or old["recoveryRequired"]):
                raise Unavailable()
            same = old["brokerPid"] == broker and old["creationTime"] == birth
            changed = False
            if action == "claim":
                if not same:
                    quiescent(windows, old, broker)
                    old.update(brokerPid=broker, creationTime=birth,
                               recoveryRequired=not domain_changed)
                    changed = True
                if domain_changed:
                    # Only a proven clean v2 scope can adopt a new grant domain.
                    # This never acknowledges or discards an unresolved entry.
                    old["domainId"] = value["domainId"]
                    changed = True
            elif not same or old["generation"] != value["generation"]:
                raise Unavailable()
            if action in ("retain", "forget_known"):
                wanted = value["entry"]
                found = next((item for item in old["entries"] if item["id"] == wanted["id"]), None)
                if found is not None and canonical(found) != canonical(wanted):
                    raise Unavailable()
                if action == "retain":
                    if old["coverage"] != "complete" or old["recoveryRequired"]:
                        raise Unavailable()
                    if found is None:
                        old["entries"] = sorted([*old["entries"], wanted], key=lambda item: item["id"])
                        entries(old["entries"])
                        changed = True
                else:
                    if found is None:
                        raise Unavailable()
                    old["entries"] = [item for item in old["entries"] if item["id"] != wanted["id"]]
                    changed = True
            elif action == "acknowledge":
                if (old["coverage"] != "complete"
                        or hashlib.sha256(canonical(old["entries"])).hexdigest() != value["entriesDigest"]):
                    raise Unavailable()
                old["entries"] = []
                old["recoveryRequired"] = False
                changed = True
            if changed:
                if old["generation"] == MAX_SAFE:
                    raise Unavailable()
                old["generation"] += 1
        if windows.process(broker) != ("alive", birth):
            raise Unavailable()
        answer = result("claimed" if action == "claim" else "updated",
                        old["recoveryRequired"] or bool(old["entries"]) or old["coverage"] != "complete",
                        action=action, state=recovery_state(old))
        if len(canonical(answer)) + 1 > MARKER_CAP or len(canonical(old)) + 1 > MARKER_CAP:
            raise Unavailable()
        if changed:
            publish(root / MARKER_NAME, old)
        windows.enroll(handle, enrolled)
        return answer


def main() -> int:
    action = None
    answer = result("unavailable")
    try:
        if len(sys.argv) != 1:
            raise Unavailable()
        if os.name == "nt":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        value = request(sys.stdin.buffer.read(INPUT_CAP + 1))
        action = value["action"]
        answer = claim(value)
    except Busy:
        answer = result("busy", action=action)
    except Exception:
        # Deliberately no traceback, exception string, local path or process data.
        answer = result("unavailable", action=action)
    try:
        sys.stdout.buffer.write(canonical(answer) + b"\n")
        sys.stdout.buffer.flush()
        return 0
    except OSError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
