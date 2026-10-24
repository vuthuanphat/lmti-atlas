"""Trusted local integration settings; requests cannot select sources or paths."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

from lmti_common.boundary import reject_nonfinite, strict_object
from lmti_project import Grant
from .integrated import IntegratedClient
from .knowledge import KnowledgeSource
from .observations import ReplayObservationSource
from .source import NativeProjectSource


def _file(path: str | Path) -> Path:
    spelling = str(path)
    local_part = re.sub(r"^[A-Za-z]:[\\/]", "", spelling)
    # Deny network/device namespaces and alternate streams before touching them.
    if (spelling.startswith(("\\\\", "//")) or ":" in local_part or
            any(ord(char) < 32 for char in spelling)):
        raise ValueError("Invalid trusted integration path")
    value = Path(path)
    if (not value.is_absolute() or ".." in value.parts or any(
            re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.IGNORECASE)
            or part.endswith((".", " ")) for part in value.parts[1:])):
        raise ValueError("Invalid trusted integration path")
    # Inspect the volume and parents first: touching a child through a junction
    # could already initiate remote I/O before the junction itself was checked.
    for part in (*reversed(value.parents), value):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("Linked integration paths are not supported")
    resolved = value.resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size > 65536:
        raise ValueError("Invalid integration configuration")
    return resolved


def _raw(path: Path) -> bytes:
    checked = _file(path)
    before = checked.stat()
    with checked.open("rb") as source:
        opened = os.fstat(source.fileno())
        if (before.st_dev, before.st_ino, before.st_size) != (opened.st_dev, opened.st_ino, opened.st_size):
            raise ValueError("Integration configuration changed during read")
        value = source.read(65537)
        after_handle = os.fstat(source.fileno())
    after = _file(path).stat()
    if ((opened.st_size, opened.st_mtime_ns) != (after_handle.st_size, after_handle.st_mtime_ns)
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise ValueError("Integration configuration changed during read")
    if len(value) > 65536:
        raise ValueError("Integration configuration budget exceeded")
    return value


def _load_settings(config_path: str | Path, expected_config_sha256: str | None):
    # Generated client configuration pins the exact operator-reviewed bytes.
    if expected_config_sha256 is not None and (not isinstance(expected_config_sha256, str) or
            re.fullmatch(r"[0-9a-f]{64}", expected_config_sha256) is None):
        raise ValueError("Invalid integration configuration fingerprint")
    path = _file(config_path)
    initial = _raw(path)
    if expected_config_sha256 is not None and not hmac.compare_digest(
            hashlib.sha256(initial).hexdigest(), expected_config_sha256):
        raise ValueError("Integration configuration differs from the reviewed export")
    data = json.loads(initial.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
    keys = {"schema", "projectId", "site", "target", "knowledge", "observations"}
    if not isinstance(data, dict):
        raise ValueError("Invalid integration configuration")
    if data.get("schema") == "lmti.agent.integration.v1":
        valid = set(data) == keys
    elif data.get("schema") == "lmti.agent.integration.v2":
        valid = set(data) == keys | {"structure"} and data["structure"] is True
    elif data.get("schema") == "lmti.agent.integration.v3":
        from .mappings import strict_json
        data = strict_json(initial, 65536)
        valid = (expected_config_sha256 is not None and set(data) == keys | {"structure"}
                 and data["structure"] is True and isinstance(data["knowledge"], dict)
                 and data["knowledge"].get("mode") == "reviewed")
    else:
        valid = False
    if not valid:
        raise ValueError("Invalid integration capability")
    expected = hashlib.sha256(initial).digest()
    original_pin = None
    if data["schema"] == "lmti.agent.integration.v3":
        from .mappings import FilePin
        original_pin = FilePin(str(path), expected.hex(), 65536)
        # Bind the exact parsed bytes and original ordinary leaf identity.
        if original_pin.verify(True) != initial:
            raise ValueError("Integration configuration changed during read")

    revoked = False

    def authorized() -> bool:
        nonlocal revoked
        if revoked:
            return False
        try:
            if original_pin is not None:
                original_pin.verify()
            current = hashlib.sha256(_raw(path)).digest()
            revoked = not hmac.compare_digest(current, expected)
        except (OSError, ValueError, TypeError):
            revoked = True
        # Restoring bytes does not revive an already detected revocation.
        return not revoked

    return data, authorized


def _assemble(source, source_id, data, authorized, cursor_key, reviewed=None):
    structure = data["schema"] in ("lmti.agent.integration.v2", "lmti.agent.integration.v3")
    if (Grant(data["projectId"], data["site"], data["target"]) != source.grant or
            getattr(source, "include_structure", False) is not structure):
        raise ValueError("Integration configuration does not match launcher capability")
    knowledge = None
    if data["schema"] == "lmti.agent.integration.v3":
        if reviewed is None:
            raise ValueError("Reviewed source requires fixed native launch paths")
    elif data["knowledge"] is not None:
        value = data["knowledge"]
        if not isinstance(value, dict) or set(value) != {"node", "cli", "root", "sourceId", "mappings"}:
            raise ValueError("Invalid knowledge owner configuration")
        knowledge = KnowledgeSource(value["node"], value["cli"], value["root"], source.grant,
                                    value["sourceId"], value["mappings"])
    observations = None
    if data["observations"] is not None:
        value = data["observations"]
        if not isinstance(value, dict) or set(value) != {"path", "sourceId"}:
            raise ValueError("Invalid observation configuration")
        observations = ReplayObservationSource(value["path"], source.grant, value["sourceId"], authorize=authorized)
    return IntegratedClient(source, source_id, knowledge=knowledge, observations=observations,
                            authorize=authorized, cursor_key=cursor_key, reviewed=reviewed)


def _reviewed(data, authorized, binary, database, pin):
    from .mappings import MappingFailure, MappingSource
    from .reviewed_knowledge import ReviewedKnowledge
    try:
        return ReviewedKnowledge(MappingSource(data["knowledge"],
            Grant(data["projectId"], data["site"], data["target"]), str(binary), str(database), authorized), pin)
    except MappingFailure as error:
        raise ValueError("Reviewed source configuration is unavailable") from error


def load_integrated_client(source, source_id: str, config_path: str | Path, *, cursor_key: bytes | None = None,
                           expected_config_sha256: str | None = None) -> IntegratedClient:
    """Attach configured owners only when the supplied trusted source matches."""
    data, authorized = _load_settings(config_path, expected_config_sha256)
    reviewed = None
    if data["schema"] == "lmti.agent.integration.v3":
        if not isinstance(source, NativeProjectSource) or not source.retain_until_closed:
            raise ValueError("Reviewed integration requires a fixed native source")
        reviewed = _reviewed(data, authorized, source._owner._binary, source._owner._database, expected_config_sha256)
    return _assemble(source, source_id, data, authorized, cursor_key, reviewed)


def load_integrated_native_client(binary: str | Path, database: str | Path, grant: Grant,
                                  source_id: str, config_path: str | Path, *,
                                  cursor_key: bytes | None = None,
                                  expected_config_sha256: str | None = None) -> IntegratedClient:
    """Pin and parse once before constructing the fixed native read capability."""
    data, authorized = _load_settings(config_path, expected_config_sha256)
    if Grant(data["projectId"], data["site"], data["target"]) != grant:
        raise ValueError("Integration configuration does not match launcher scope")
    reviewed = (_reviewed(data, authorized, binary, database, expected_config_sha256)
                if data["schema"] == "lmti.agent.integration.v3" else None)
    source = NativeProjectSource(binary, database, grant, include_references=True,
                                 include_structure=data["schema"] in ("lmti.agent.integration.v2", "lmti.agent.integration.v3"),
                                 **({"retain_until_closed": True} if data["schema"] == "lmti.agent.integration.v3" else {}))
    return _assemble(source, source_id, data, authorized, cursor_key, reviewed)
