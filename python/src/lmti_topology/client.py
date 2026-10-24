from __future__ import annotations

import json
import os
from pathlib import Path
import re
from dataclasses import dataclass
from typing import Any

from lmti_common.process import ProcessError, read_owner

MAX_OUTPUT = 2 * 1024 * 1024
_ID = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,63}\Z", re.ASCII)

class TopologyError(ValueError):
    """A safe boundary error without raw storage paths or contents."""

def _identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise TopologyError("Invalid topology identifier.")
    return value

def _interval(value: Any) -> int:
    if type(value) is not int or not 100 <= value <= 3_600_000:
        raise TopologyError("pollMs must be an integer between 100 and 3600000.")
    return value

@dataclass(frozen=True)
class Grant:
    """Trusted launcher configuration. Tool arguments cannot change this grant.

    A local grant permits internal metadata. An external grant includes only
    metadata explicitly classified public. The OS user controls the launcher.
    """
    site: str
    target: str = "external"

    def __post_init__(self) -> None:
        _identifier(self.site)
        if self.target not in ("local", "external"):
            raise TopologyError("Invalid model target.")

class Client:
    def __init__(self, binary: str | Path, database: str | Path, grant: Grant):
        binary_path = Path(binary).expanduser()
        database_path = Path(database).expanduser()
        if not binary_path.is_absolute() or not database_path.is_absolute():
            raise TopologyError("Launcher must configure absolute binary and database paths.")
        if binary_path.is_symlink() or database_path.is_symlink():
            raise TopologyError("Symlink paths are not accepted.")
        self._binary = binary_path.resolve(strict=True)
        self._database = database_path.resolve(strict=True)
        if self._binary.name not in ("lmti-topology", "lmti-topology.exe") or not self._binary.is_file() or not self._database.is_file() or self._database.stat().st_size > 64 * 1024 * 1024:
            raise TopologyError("Invalid runtime or topology database.")
        if not isinstance(grant, Grant):
            raise TopologyError("A trusted runtime grant is required.")
        self._grant = grant

    def _environment(self) -> dict[str, str]:
        # Do not inherit model-controlled Qt plugin paths, loader injection or keys.
        environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG") if key in os.environ}
        environment["PATH"] = str(self._binary.parent)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
        environment["QT_PLUGIN_PATH"] = str(self._binary.parent)
        return environment

    def context(self, limit: int = 100) -> dict[str, Any]:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise TopologyError("Context limit must be an integer from 1 to 200.")
        return self._read("context", str(limit), limit)

    def _read(self, command: str, argument: str, limit: int) -> dict[str, Any]:
        try:
            output = read_owner(
                [str(self._binary), command, str(self._database), self._grant.site, self._grant.target, argument],
                self._environment(), str(self._binary.parent), MAX_OUTPUT,
            )
        except (OSError, ProcessError) as error:
            raise TopologyError("Topology runtime unavailable or timed out.") from error
        try:
            value = json.loads(output.decode("utf-8"))
            self._validate_context(value, limit)
        except (UnicodeError, ValueError, TypeError, KeyError, RecursionError) as error:
            raise TopologyError("Invalid topology runtime response.") from error
        return value

    def asset_context(self, asset_id: str) -> dict[str, Any]:
        """Read an asset by identity even when it falls beyond a context window."""
        asset_id = _identifier(asset_id)
        context = self._read("asset", asset_id, 1)
        if not context["assets"] or context["assets"][0]["id"] != asset_id:
            raise TopologyError("Asset is unavailable in the authorized site and model target.")
        return context

    def _validate_context(self, value: Any, limit: int) -> None:
        if not isinstance(value, dict) or value.get("schema") != "lmti.topology.context.v1" or type(value.get("revision")) is not int or not 1 <= value["revision"] < 9_007_199_254_740_991 or type(value.get("truncated")) is not bool:
            raise TopologyError("Invalid context envelope.")
        assets, links = value["assets"], value["links"]
        if not isinstance(assets, list) or not isinstance(links, list) or len(assets) > limit or len(links) > 400:
            raise TopologyError("Invalid context size.")
        ids = set()
        for asset in assets:
            asset_id = _identifier(asset["id"])
            if asset_id in ids or asset["site"] != self._grant.site or (self._grant.target == "external" and asset["privacy"] != "public"):
                raise TopologyError("Context violates the launcher scope.")
            if asset["privacy"] not in ("public", "internal") or asset["kind"] not in ("machine", "gateway", "broker", "service", "sensor"):
                raise TopologyError("Invalid asset metadata.")
            if not isinstance(asset["label"], str) or not 1 <= len(asset["label"].encode("utf-8")) <= 120:
                raise TopologyError("Invalid label.")
            _interval(asset["desired"]["pollMs"])
            if type(asset["desired"]["enabled"]) is not bool:
                raise TopologyError("Invalid desired enabled flag.")
            observed = asset["observed"]
            if observed["status"] not in ("unknown", "online", "offline") or type(observed["at"]) is not int or not 0 <= observed["at"] <= 253_402_300_799 or ((observed["status"] == "unknown") != (observed["at"] == 0)):
                raise TopologyError("Invalid observed state.")
            ids.add(asset_id)
        for link in links:
            _identifier(link["id"])
            if link["from"] not in ids or link["to"] not in ids or link["from"] == link["to"] or link["protocol"] not in ("dependency", "mqtt", "opcua", "modbus-tcp") or link["state"] != "declared":
                raise TopologyError("Invalid context link.")

    def propose_config(self, asset_id: str, poll_ms: int, enabled: bool) -> dict[str, Any]:
        """Produce a diff against a saved revision. No write or device action occurs."""
        asset_id = _identifier(asset_id)
        _interval(poll_ms)
        if type(enabled) is not bool:
            raise TopologyError("enabled must be a boolean.")
        context = self.asset_context(asset_id)
        asset = next((a for a in context["assets"] if a["id"] == asset_id), None)
        if asset is None:
            raise TopologyError("Asset is unavailable in the bounded authorized context.")
        return {"schema": "lmti.topology.proposal.v1", "baseRevision": context["revision"],
                "assetId": asset_id, "site": self._grant.site,
                "expected": dict(asset["desired"]), "desired": {"enabled": enabled, "pollMs": poll_ms}}
