"""Nonsecret metadata validation for transient Python owner boundaries."""
from __future__ import annotations

import re
from typing import Any

SECRET = re.compile(
    r"(-----BEGIN .*PRIVATE KEY-----)|(\b(?:sk-(?:proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,})"
    r"|(\bAKIA[0-9A-Z]{16})|"
    r"(\b(?:api[_-]?key|password|passwd|token|secret|client[_-]?secret)[\"']?\s*[:=]\s*[\"']?[^\s\"']{8,})"
    r"|((?:postgres(?:ql)?|mysql|mongodb|redis)://)", re.IGNORECASE,
)


def metadata(value: Any, limit: int, required: bool = False) -> None:
    if not isinstance(value, str) or (required and not value.strip()) or any(
            ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Invalid boundary metadata.")
    if len(value.encode("utf-8")) > limit or SECRET.search(value):
        raise ValueError("Invalid boundary metadata.")

