"""Recursive secret redaction for recipe JSON and generated documentation."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

REDACTED = "[REDACTED]"

_SENSITIVE_KEYS = {
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "secret",
    "token",
    "xapikey",
    "xauthtoken",
}
_HEADER_PATTERN = re.compile(r"(?i)\b(?:authorization|cookie)\s*:\s*[^\r\n]+")
_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password|credential)"
    r"(\s*[:=]\s*)([^&\s,;]+)"
)


def redact_secrets(value: object, *, field_name: str = "") -> object:
    """Return a JSON-compatible copy with secrets removed at every depth."""

    if _normalized_key(field_name) in _SENSITIVE_KEYS:
        return REDACTED
    if isinstance(value, Mapping):
        return {str(key): redact_secrets(item, field_name=str(key)) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        redacted = _HEADER_PATTERN.sub(REDACTED, value)
        redacted = _BEARER_PATTERN.sub(REDACTED, redacted)
        return _ASSIGNMENT_PATTERN.sub(
            lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
            redacted,
        )
    return value


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())
