"""One-shot read façade for the authenticated local web operator broker."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

from lmti_common.boundary import reject_nonfinite, strict_object
from lmti_project import Grant
from .client import Client
from .integration_config import load_integrated_native_client
from .integrated_mcp import IntegratedServer
from .mcp import Server
from .source import NativeProjectSource

OPERATIONS = {"context", "entity", "related", "task_context", "observations"}


def _local_path(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 4096 or
            not Path(value).is_absolute() or value.startswith(("\\\\", "//")) or
            any(ord(char) < 32 for char in value) or
            ":" in (value[2:] if re.match(r"^[A-Za-z]:[/\\]", value) else value)):
        raise ValueError("Invalid trusted owner path")
    return value


def execute(request):
    keys = {"binary", "database", "projectId", "site", "target", "integrationConfig", "integrationSha256",
            "operation", "arguments", "cursorKey"}
    if (not isinstance(request, dict) or set(request) != keys or
            request["operation"] not in OPERATIONS or not isinstance(request["arguments"], dict) or
            not isinstance(request["cursorKey"], str) or not re.fullmatch(r"[a-f0-9]{64}", request["cursorKey"])):
        raise ValueError("Invalid broker request")
    binary, database = _local_path(request["binary"]), _local_path(request["database"])
    config = request["integrationConfig"]
    pin = request["integrationSha256"]
    if (config is None and pin is not None) or (config is not None and
            (not isinstance(pin, str) or re.fullmatch(r"[a-f0-9]{64}", pin) is None)):
        raise ValueError("Invalid broker integration pin")
    if config is not None:
        config = _local_path(config)
    grant = Grant(request["projectId"], request["site"], request["target"])
    key = bytes.fromhex(request["cursorKey"])
    if config is not None:
        client = load_integrated_native_client(binary, database, grant, "native-project", config,
                                               cursor_key=key, expected_config_sha256=pin)
        server = IntegratedServer(client)
    else:
        source = NativeProjectSource(binary, database, grant, include_references=True)
        client = Client(source, cursor_key=key)
        server = Server(client)
    if request["operation"] == "task_context" and config is None:
        response = client._error("project.task_context", "NOT_SUPPORTED")
    else:
        response = server.call_tool("lmti_" + request["operation"], request["arguments"])
    return {"ok": True, "response": response}


def main():
    try:
        raw = sys.stdin.buffer.read(128 * 1024 + 1)
        if not raw or len(raw) > 128 * 1024:
            raise ValueError("Request budget exceeded")
        request = json.loads(raw.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
        result = execute(request)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > 520 * 1024:
            raise ValueError("Response budget exceeded")
    except Exception:
        # Local paths, raw stderr and payloads never cross back into a browser.
        encoded = '{"ok":false,"code":"OWNER_UNAVAILABLE"}'
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    main()
