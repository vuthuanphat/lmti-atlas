"""Bounded project client-config adapter. Not an MCP/Agent tool.

No credentials or original configuration are returned to the caller. Windows
backup/recovery uses current-user DPAPI; existing replacement DACLs are retained.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib
from contextlib import contextmanager

LIMIT = 1024 * 1024
REQUEST_LIMIT = 128 * 1024
KEY = re.compile(r"[a-z][a-z0-9_-]{0,47}\Z")
PROJECT = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}\Z")


class Refused(Exception):
    def __init__(self, message, code="INVALID_INPUT"):
        super().__init__(message)
        self.code = code


def fail(message, code="INVALID_INPUT"):
    raise Refused(message, code)


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            fail("Duplicate JSON keys are unsupported.")
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=pairs,
                      parse_constant=lambda _: fail("Non-finite JSON is unsupported."))


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def local_path_spelling(path: Path):
    spelling = str(path)
    local_part = re.sub(r"^[A-Za-z]:[\\/]", "", spelling)
    if (not path.is_absolute() or spelling.startswith(("\\\\", "//")) or ":" in local_part or
            any(ord(char) < 32 for char in spelling) or ".." in path.parts or any(
                re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.IGNORECASE)
                or part.endswith((".", " ")) for part in path.parts[1:])):
        fail("Choose an absolute local project/configuration path.")


def safe_path(path: Path):
    local_path_spelling(path)
    # Check parents before touching children through possible junctions.
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            fail("Linked or reparse-point config locations are unsupported.")


def read(path, limit=LIMIT):
    safe_path(path)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > limit:
        fail("Client configuration exceeds file limits.")
    with path.open("rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        fail("Client configuration exceeds file limits.")
    return value


class Blob(ctypes.Structure):
    _fields_ = [("length", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def crypt(value, decrypt=False):
    if os.name != "nt":
        fail("Automatic apply/restore requires Windows protected backups. Export is available.", "NOT_SUPPORTED")
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    library = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if decrypt:
        function = library.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        ok = function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        function = library.CryptProtectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_wchar_p, ctypes.c_void_p,
                            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        ok = function(ctypes.byref(source), "LMTI client config backup", None, None, None, 1,
                      ctypes.byref(output))
    if not ok:
        fail("Protected backup encryption is unavailable.")
    try:
        return ctypes.string_at(output.data, output.length)
    finally:
        kernel.LocalFree(output.data)


def preserve_acl(source, target):
    if not source.exists():
        return
    if os.name != "nt":
        os.chmod(target, stat.S_IMODE(source.stat().st_mode))
        return
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    get = api.GetFileSecurityW
    get.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                   ctypes.POINTER(ctypes.c_uint32)]
    set_security = api.SetFileSecurityW
    set_security.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p]
    get_control = api.GetSecurityDescriptorControl
    get_control.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(ctypes.c_uint32)]
    needed = ctypes.c_uint32()
    get(str(source), 4, None, 0, ctypes.byref(needed))
    if not needed.value or needed.value > 65536:
        fail("Cannot preserve client configuration permissions.")
    descriptor = ctypes.create_string_buffer(needed.value)
    control, revision = ctypes.c_uint16(), ctypes.c_uint32()
    if not get(str(source), 4, descriptor, needed.value, ctypes.byref(needed)) or \
            not get_control(descriptor, ctypes.byref(control), ctypes.byref(revision)) or \
            not set_security(str(target), 4 | (0x80000000 if control.value & 0x1000 else 0x20000000), descriptor):
        fail("Cannot preserve client configuration permissions.")


def atomic(path, value):
    safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_path(path)
    fd, name = tempfile.mkstemp(prefix=".lmti-write-", dir=path.parent)
    temporary = Path(name)
    try:
        preserve_acl(path, temporary)
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        safe_path(path)
        os.replace(temporary, path)
    finally:
        if fd is not None:
            os.close(fd)
        temporary.unlink(missing_ok=True)


@contextmanager
def writer_lock(root, client):
    if os.name != "nt":
        yield
        return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    for name in ("WaitForSingleObject", "ReleaseMutex", "CloseHandle"):
        getattr(kernel, name).argtypes = [ctypes.c_void_p] + ([ctypes.c_uint32] if name == "WaitForSingleObject" else [])
    name = "Local\\LMTI-MCP-" + digest(str(root).casefold().encode() + client.encode())
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        fail("Client config lock is unavailable.")
    acquired = kernel.WaitForSingleObject(handle, 0) in (0, 0x80)
    try:
        if not acquired:
            fail("Another LMTI operation is updating this client. Retry later.", "BUSY")
        yield
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def validate_integration_export(args, project, *, check_content=True):
    if len(args) == 12:
        return
    if len(args) != 16 or args[12::2] != ["--integration-config", "--integration-sha256"] or not re.fullmatch(r"[a-f0-9]{64}", args[15]):
        fail("Invalid integration export pin.")
    path = Path(args[13])
    local_path_spelling(path)
    if not check_content:
        # Recovery of existing settings does not read a withdrawn source.
        return
    safe_path(path)
    before = path.stat()
    if not path.is_file() or before.st_size > 65536:
        fail("Invalid integration export file.")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
            fail("Integration export changed.", "CONFIG_CHANGED")
        value = stream.read(65537)
        after_handle = os.fstat(stream.fileno())
    safe_path(path)
    after = path.stat()
    if (len(value) > 65536 or len(value) != opened.st_size or digest(value) != args[15] or
            (opened.st_size, opened.st_mtime_ns) != (after_handle.st_size, after_handle.st_mtime_ns) or
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) !=
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        fail("Integration export changed.", "CONFIG_CHANGED")
    config = decode(value)
    # The reviewed source bytes carry this capability. No extra launch switch
    # may enable structure independently of the pinned trusted configuration.
    keys = {"schema", "projectId", "site", "target", "knowledge", "observations"}
    reviewed = isinstance(config, dict) and config.get("schema") == "lmti.agent.integration.v3"
    structure = reviewed or (isinstance(config, dict) and config.get("schema") == "lmti.agent.integration.v2")
    if structure:
        keys.add("structure")
    if (not isinstance(config, dict) or
            set(config) != keys or
            (not structure and config.get("schema") != "lmti.agent.integration.v1") or
            (structure and config.get("structure") is not True) or config.get("projectId") != project or
            config.get("site") != args[9] or config.get("target") != "external"):
        fail("Integration export scope differs.", "SCOPE_DENIED")
    if reviewed and (
            not isinstance(config["knowledge"], dict) or config["knowledge"].get("mode") != "reviewed" or
            not (config["observations"] is None or isinstance(config["observations"], dict))):
        fail("Invalid reviewed integration export.", "SCOPE_DENIED")


def validate_request(request):
    allowed = {"action", "root", "client", "project", "revision", "content", "servers", "expected"}
    if not isinstance(request, dict) or set(request) - allowed:
        fail("Unsupported client-config request.")
    for field in ("action", "root", "client", "project"):
        if not isinstance(request.get(field), str):
            fail("Missing client-config field.")
    if request["action"] not in ("preview", "apply", "status", "restore", "restore_preview", "restore_commit", "inspect") or \
            request["client"] not in ("codex", "cursor") or not PROJECT.fullmatch(request["project"]):
        fail("Unsupported client or project.")
    root = Path(request["root"])
    safe_path(root)
    if not root.is_dir() or root.parent == root or len(str(root)) > 1024:
        fail("Select a project folder, not a filesystem root.")
    if request["action"] in ("inspect", "restore_preview", "restore_commit"):
        wanted = {"action", "root", "client", "project"}
        if request["action"] == "restore_commit":
            wanted.add("expected")
            if not isinstance(request.get("expected"), str) or not re.fullmatch(r"[a-f0-9]{64}", request["expected"]):
                fail("Missing recovery preview identity.")
        if set(request) != wanted:
            fail("Unsupported inspection fields.")
        return root
    if isinstance(request.get("revision"), bool) or not isinstance(request.get("revision"), int) or \
            not 0 < request["revision"] <= 9007199254740991:
        fail("Save the MCP profile before configuring a client.")
    servers = request.get("servers")
    if not isinstance(servers, dict) or len(servers) > 32 or \
            not isinstance(request.get("content"), str) or len(request["content"].encode()) > REQUEST_LIMIT:
        fail("Invalid generated configuration.")
    # Only the generator's URL or fixed LMTI launcher forms are accepted.
    for key, value in servers.items():
        if not KEY.fullmatch(key) or not isinstance(value, dict):
            fail("Invalid generated server definition.")
        if set(value) == {"url"}:
            from urllib.parse import urlsplit
            url = urlsplit(value["url"])
            if url.scheme != "https" or not url.hostname or url.port not in (None, 443) or \
                    url.username or url.password or url.query or url.fragment or \
                    any(c in value["url"] for c in '%\\\r\n\t'):
                fail("Invalid generated remote endpoint.")
        elif set(value) == {"command", "args"}:
            args = value["args"]
            if not isinstance(value["command"], str) or not Path(value["command"]).is_absolute() or \
                    not isinstance(args, list) or len(args) not in (12, 16) or \
                    any(not isinstance(v, str) or len(v) > 1024 or any(ord(c) < 32 for c in v) for v in args) or \
                    args[0] != "-I" or args[2:12:2] != ["--binary", "--database", "--project", "--site", "--target"] or \
                    args[7] != request["project"] or args[11] != "external" or \
                    Path(args[1]).name != "lmti-agent-mcp.py" or \
                    any(not isinstance(v, str) or len(v) > 1024 or any(ord(c) < 32 for c in v) for v in args):
                fail("Only the fixed LMTI local launcher is supported.")
            if Path(value["command"]).resolve(strict=True) != Path(sys.executable).resolve(strict=True) or \
                    Path(args[1]).resolve(strict=True) != Path(__file__).with_name("lmti-agent-mcp.py").resolve(strict=True) or \
                    not Path(args[3]).is_absolute() or Path(args[3]).name not in ("lmti-project.exe", "lmti-project") or \
                    not Path(args[5]).is_absolute():
                fail("Local configuration must use the publisher's current LMTI launcher.")
            validate_integration_export(args, request["project"], check_content=request["action"] != "restore")
        else:
            fail("Secrets, custom headers and arbitrary commands are unsupported.")
    parsed = tomllib.loads(request["content"]) if request["client"] == "codex" else decode(request["content"])
    expected_key = "mcp_servers" if request["client"] == "codex" else "mcpServers"
    if parsed != ({expected_key: servers} if servers else ({} if request["client"] == "codex" else {expected_key: {}})):
        fail("Generated content does not match the profile.")
    return root


def old_config(value, client):
    if value is None:
        return {}, {}
    parsed = tomllib.loads(value.decode("utf-8-sig")) if client == "codex" else decode(value.decode("utf-8-sig"))
    field = "mcp_servers" if client == "codex" else "mcpServers"
    if not isinstance(parsed, dict) or not isinstance(parsed.get(field, {}), dict):
        fail("Existing client configuration has an unsupported structure.")
    return parsed, parsed.get(field, {})


def record_bytes(value):
    return None if value is None else base64.b64encode(value).decode("ascii")


def bytes_record(value):
    return None if value is None else base64.b64decode(value, validate=True)


def fingerprint(value):
    return "missing" if value is None else digest(value)


def snapshot(config, state):
    return digest(packed([fingerprint(config), fingerprint(state)]))


def merge(request, original, state_bytes):
    client, project, wanted = request["client"], request["project"], request["servers"]
    parsed, existing = old_config(original, client)
    state = decode(state_bytes) if state_bytes else None
    if state is not None and (not isinstance(state, dict) or state.get("project") != project or
                              state.get("schema") != 1 or not isinstance(state.get("owned"), dict)):
        fail("Client configuration is managed by another project or unsupported owner.", "SCOPE_DENIED")
    owned = state["owned"] if state else {}
    for key, expected_hash in owned.items():
        if key not in existing or digest(packed(existing[key])) != expected_hash:
            fail("A managed server changed outside LMTI. Review it before replacing.", "OWNED_CONFIG_DRIFT")
    for key in wanted:
        if key in existing and key not in owned:
            fail("A server key already exists outside LMTI. Choose another key.", "UNMANAGED_COLLISION")
    if client == "cursor":
        servers = dict(existing)
        for key in owned:
            servers.pop(key)
        servers.update(wanted)
        parsed["mcpServers"] = servers
        result = json.dumps(parsed, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    else:
        text = original.decode("utf-8-sig") if original else ""
        start, end = f"# LMTI-BEGIN {project}", f"# LMTI-END {project}"
        if state:
            region = re.search(r"(?m)^" + re.escape(start) + r"\r?\n[\s\S]*?^" + re.escape(end) + r"(?:\r?\n|$)", text)
            if not region or text.count(start) != 1 or text.count(end) != 1 or \
                    digest(region.group().encode()) != state.get("region"):
                fail("Managed TOML region was edited or is unavailable.", "OWNED_CONFIG_DRIFT")
            text = text[:region.start()] + text[region.end():]
        elif "# LMTI-BEGIN" in text or "# LMTI-END" in text:
            fail("Unowned LMTI TOML region requires manual review.", "UNMANAGED_COLLISION")
        _, remaining = old_config(text.encode(), "codex")
        if set(remaining) & set(wanted):
            fail("A TOML server is defined outside the managed region.", "UNMANAGED_COLLISION")
        region_text = start + "\n" + request["content"] + "\n" + end + "\n"
        result = (text + ("\n" if text and not text.endswith("\n") else "") + region_text).encode()
        # Ensure appending did not alter TOML table semantics or unowned entries.
        complete, actual = old_config(result, "codex")
        expected = dict(remaining)
        expected.update(wanted)
        before_without_mcp = old_config(text.encode(), "codex")[0]
        before_without_mcp.pop("mcp_servers", None)
        after_without_mcp = dict(complete)
        after_without_mcp.pop("mcp_servers", None)
        if actual != expected or before_without_mcp != after_without_mcp:
            fail("TOML merge would alter unrelated configuration.")
    if len(result) > LIMIT:
        fail("Merged client configuration exceeds limits.")
    new_state = {"schema": 1, "project": project, "revision": request["revision"],
                 "profile": digest(request["content"].encode()),
                 "owned": {key: digest(packed(value)) for key, value in wanted.items()}}
    if client == "codex":
        new_state["region"] = digest(region_text.encode())
    return result, packed(new_state), {"added": sorted(set(wanted) - set(owned)),
                                      "updated": sorted(set(wanted) & set(owned)),
                                      "removed": sorted(set(owned) - set(wanted))}


def restorable(bundle, current, state):
    original, old_state = bytes_record(bundle["config"]), bytes_record(bundle["state"])
    if fingerprint(current) not in (bundle["after_config"], fingerprint(original)) or \
            fingerprint(state) not in (bundle["after_state"], fingerprint(old_state)):
        fail("Configuration changed after this transaction. Restore requires manual review.", "CONFIG_CHANGED")
    return original, old_state


def restore_bundle(bundle, config_path, state_path):
    original, old_state = restorable(bundle, read(config_path), read(state_path))
    for path, value in ((config_path, original), (state_path, old_state)):
        if value is None:
            safe_path(path)
            path.unlink(missing_ok=True)
        else:
            atomic(path, value)


def owned_state(value, project):
    if value is None:
        return None
    state = decode(value)
    if not isinstance(state, dict) or state.get("schema") != 1 or state.get("project") != project or \
            not isinstance(state.get("owned"), dict) or len(state["owned"]) > 32 or \
            isinstance(state.get("revision"), bool) or not isinstance(state.get("revision"), int) or \
            not 0 < state["revision"] <= 9007199254740991:
        fail("Client configuration belongs to another project or unsupported owner.", "SCOPE_DENIED")
    return state


def recovery_snapshot(config, state, recovery, backup):
    return digest(packed([fingerprint(v) for v in (config, state, recovery, backup)]))


def protected_bundle(value, request):
    bundle = decode(crypt(value, True))
    if not isinstance(bundle, dict) or bundle.get("schema") != 1:
        fail("Unsupported protected recovery record.", "OWNER_UNAVAILABLE")
    for key, wanted in (("project", request["project"]), ("client", request["client"]),
                        ("rootHash", digest(str(Path(request["root"])).casefold().encode()))):
        if key in bundle and bundle[key] != wanted:
            fail("Protected recovery belongs to another project.", "SCOPE_DENIED")
    owned_state(bytes_record(bundle["state"]), request["project"])
    return bundle


def recheck_integration_exports(request):
    if request["action"] not in ("preview", "status", "apply"):
        return
    for definition in request["servers"].values():
        if "args" in definition and len(definition["args"]) == 16:
            validate_integration_export(definition["args"], request["project"])


def operate(request):
    root = validate_request(request)
    if request["action"] == "restore_commit":
        request = dict(request, action="restore")
    client = request["client"]
    config_path = root / (".codex/config.toml" if client == "codex" else ".cursor/mcp.json")
    state_path = root / ".lmti-client" / f"{client}.state.json"
    journal = root / ".lmti-client" / f"{client}.recovery.dpapi"
    backup = root / ".lmti-client" / f"{client}.backup.dpapi"
    with writer_lock(root, client):
        # A writer may have waited after request validation. Recheck the
        # reviewed source before reads/merge or any recovery write on apply.
        recheck_integration_exports(request)
        recovery = read(journal, 3 * LIMIT)
        backup_bytes = read(backup, 3 * LIMIT)
        config, state_bytes = read(config_path), read(state_path)
        state = owned_state(state_bytes, request["project"])
        if request["action"] == "inspect":
            old_config(config, client)  # Strict parse only, never return existing settings.
            return {"ok": True, "state": "recovery_required" if recovery else "configured" if state else "not_applied",
                    "appliedRevision": state["revision"] if state else None,
                    "canRestore": recovery is not None or backup_bytes is not None, "verified": False}
        restore_expected = recovery_snapshot(config, state_bytes, recovery, backup_bytes)
        if request["action"] == "restore_preview":
            if recovery is None and backup_bytes is None:
                fail("No protected backup is available.", "NOT_SUPPORTED")
            virtual_config, virtual_state = config, state_bytes
            if recovery is not None:
                virtual_config, virtual_state = restorable(protected_bundle(recovery, request), virtual_config, virtual_state)
            if backup_bytes is not None:
                restorable(protected_bundle(backup_bytes, request), virtual_config, virtual_state)
            return {"ok": True, "expected": restore_expected, "protectedRecovery": True, "verified": False}
        if request["action"] == "restore" and "expected" in request and request["expected"] != restore_expected:
            fail("Recovery configuration changed since preview.", "CONFIG_CHANGED")
        if recovery is not None:
            # Never silently recover on a read-only preview/status operation.
            if request["action"] not in ("restore", "apply"):
                fail("An interrupted update needs Restore before previewing again.", "RECOVERY_REQUIRED")
            recovered = protected_bundle(recovery, request)
            recheck_integration_exports(request)
            restore_bundle(recovered, config_path, state_path)
            journal.unlink()
        if request["action"] == "restore":
            value = read(backup, 3 * LIMIT)
            if value is None:
                if recovery is not None:
                    return {"ok": True, "state": "restored", "target": str(config_path)}
                fail("No protected backup is available.", "NOT_SUPPORTED")
            restore_bundle(protected_bundle(value, request), config_path, state_path)
            backup.unlink()
            return {"ok": True, "state": "restored", "target": str(config_path)}
        original, state_bytes = read(config_path), read(state_path)
        expected = snapshot(original, state_bytes)
        result, new_state, changes = merge(request, original, state_bytes)
        matched = state_bytes is not None and decode(state_bytes).get("profile") == digest(request["content"].encode()) and \
            decode(state_bytes).get("revision") == request["revision"]
        response = {"ok": True, "state": "applied" if matched else "update_pending" if state_bytes else "not_applied",
                    "expected": expected, "changes": changes, "target": str(config_path),
                    "revision": request["revision"], "verified": False}
        if request["action"] in ("preview", "status"):
            return response
        if request.get("expected") != expected:
            fail("Configuration changed since preview. Create a new preview.", "CONFIG_CHANGED")
        bundle = {"schema": 1, "config": record_bytes(original), "state": record_bytes(state_bytes),
                  "project": request["project"], "client": client,
                  "rootHash": digest(str(root).casefold().encode()),
                  "after_config": fingerprint(result), "after_state": fingerprint(new_state)}
        encrypted = crypt(packed(bundle))
        # DPAPI or merge can take time: no backup/journal/client write may
        # start using a source configuration which changed meanwhile.
        recheck_integration_exports(request)
        atomic(backup, encrypted)
        atomic(journal, encrypted)
        try:
            # The named mutex serializes LMTI writers. Recheck external edits before commit.
            if snapshot(read(config_path), read(state_path)) != expected:
                fail("Configuration changed before commit. Create a new preview.", "CONFIG_CHANGED")
            recheck_integration_exports(request)
            atomic(config_path, result)
            atomic(state_path, new_state)
            journal.unlink()
        except Exception:
            restore_bundle(bundle, config_path, state_path)
            journal.unlink(missing_ok=True)
            raise
        response["state"] = "applied"
        return response


def main():
    try:
        value = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(value) > REQUEST_LIMIT:
            fail("Client-config request exceeds limits.")
        result = operate(decode(value))
    except Refused as error:
        result = {"ok": False, "error": str(error), "code": error.code}
    except Exception:
        result = {"ok": False, "code": "OWNER_UNAVAILABLE", "error": "Client configuration is invalid or unavailable. Existing settings were preserved."}
    sys.stdout.buffer.write(packed(result) + b"\n")


if __name__ == "__main__":
    main()
