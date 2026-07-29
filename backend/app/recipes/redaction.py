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
_SENSITIVE_KEY_SUFFIXES = (
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "privatekey",
    "secret",
    "token",
)
_HEADER_PATTERN = re.compile(
    r"(?i)\b(?:authorization|proxy-authorization|cookie|set-cookie)"
    r"\s*:\s*[^\r\n]+"
)
_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(api[_-]?key|client[_-]?secret|access[_-]?token|"
    r"refresh[_-]?token|id[_-]?token|token|secret|password|"
    r"credential|credentials|private[_-]?key)"
    r"(\s*[:=]\s*)([^&\s,;]+)"
)
_PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?"
    r"-----END [A-Z ]*PRIVATE KEY-----",
    flags=re.DOTALL,
)
_URL_USERINFO_PATTERN = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@")


def redact_secrets(value: object, *, field_name: str = "") -> object:
    """Return a JSON-compatible copy with secrets removed at every depth."""

    if _is_sensitive_key(field_name):
        return REDACTED
    if isinstance(value, Mapping):
        return {str(key): redact_secrets(item, field_name=str(key)) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        redacted = _URL_USERINFO_PATTERN.sub(r"\1", value)
        redacted = _PRIVATE_KEY_PATTERN.sub(REDACTED, redacted)
        redacted = _HEADER_PATTERN.sub(REDACTED, redacted)
        redacted = _BEARER_PATTERN.sub(REDACTED, redacted)
        return _ASSIGNMENT_PATTERN.sub(
            lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
            redacted,
        )
    return value


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _is_sensitive_key(value: str) -> bool:
    normalized = _normalized_key(value)
    return normalized in _SENSITIVE_KEYS or normalized.endswith(_SENSITIVE_KEY_SUFFIXES)
