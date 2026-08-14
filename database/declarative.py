"""Declarative HTTP database manifests — stdlib-only validation models.

Phase 8: this module was extracted from ``backend/app/databases/declarative.py``
and reimplemented on Python stdlib (dataclasses) so the ``database/`` package
has zero third-party runtime dependencies. The HTTP tool construction
(``DeclarativeHttpToolBuilder``) moved to TypeScript
(``server/src/agent/tools/declarative-db.ts``) in Phase 5 and is NOT part of
the Python persistence boundary anymore.

The validation semantics mirror the retired Pydantic models exactly:
extra keys are forbidden, names/URLs/headers are constrained, operations must
be unique, and declarative databases cannot declare Python requirements.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

_PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*)\}")

_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
_CATEGORIES = ("discovery", "acquisition", "processing", "analysis")

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_SECRET_REFERENCE_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
_EXTRACT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

# Manifest keys whose values never leave the server verbatim (mirrors the
# retired UserSkillStore._SENSITIVE_MANIFEST_KEYS redaction).
_SENSITIVE_MANIFEST_KEYS = {
    "authorization", "api-key", "api_key", "x-api-key", "x-auth-token",
    "token", "secret", "password", "credential", "credentials",
}
_REDACTED = "[redacted]"


class DatabaseValidationError(ValueError):
    """Raised when a declarative database manifest cannot be accepted."""


def _type_error(field_path: str, expected: str) -> DatabaseValidationError:
    return DatabaseValidationError(f"{field_path} must be {expected}")


def _require_str(
    value: Any, field_path: str, *, min_length: int = 0,
) -> str:
    if not isinstance(value, str):
        raise _type_error(field_path, "a string")
    if len(value) < min_length:
        raise DatabaseValidationError(
            f"{field_path} must have at least {min_length} character"
            + ("" if min_length == 1 else "s")
        )
    return value


def _require_bool(value: Any, field_path: str) -> bool:
    # Pydantic v2 lax-mode coercion parity: JSON booleans and "true"/"false"
    # strings are accepted; anything else is rejected.
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value == "true":
            return True
        if value == "false":
            return False
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    raise DatabaseValidationError(f"{field_path} must be a boolean")


def _require_str_tuple(value: Any, field_path: str) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise _type_error(field_path, "an array")
    result: list[str] = []
    for index, item in enumerate(value):
        result.append(_require_str(item, f"{field_path}[{index}]"))
    return tuple(result)


@dataclass(frozen=True, slots=True)
class HttpAuthReference:
    """Reference to a configured secret; never contains the secret value."""

    reference: str
    location: str
    name: str
    source: str = "env"
    prefix: str = ""

    @classmethod
    def parse(cls, raw: Any, field_path: str) -> HttpAuthReference:
        if not isinstance(raw, dict):
            raise _type_error(field_path, "an object")
        _reject_unknown(raw, {"source", "reference", "location", "name", "prefix"},
                        field_path)
        source = raw.get("source", "env")
        if source != "env":
            raise DatabaseValidationError(f"{field_path}.source must be 'env'")
        location = raw.get("location")
        if location not in ("header", "query"):
            raise DatabaseValidationError(
                f"{field_path}.location must be 'header' or 'query'"
            )
        reference = _require_str(raw.get("reference"), f"{field_path}.reference")
        if _SECRET_REFERENCE_RE.fullmatch(reference) is None:
            raise DatabaseValidationError(
                f"{field_path}.reference must match {_SECRET_REFERENCE_RE.pattern}"
            )
        name = _require_str(raw.get("name"), f"{field_path}.name", min_length=1)
        prefix = raw.get("prefix", "")
        if not isinstance(prefix, str):
            raise _type_error(f"{field_path}.prefix", "a string")
        return cls(reference=reference, location=location, name=name, prefix=prefix)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "reference": self.reference,
            "location": self.location,
            "name": self.name,
            "prefix": self.prefix,
        }


@dataclass(frozen=True, slots=True)
class HttpOperationManifest:
    """One minimal, expression-free HTTP operation."""

    name: str
    description: str
    method: str
    url: str
    query: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, Any] = field(default_factory=dict)
    body: Any | None = None
    timeout_seconds: float = 30.0
    auth: HttpAuthReference | None = None
    extract: str | None = None

    @classmethod
    def parse(cls, raw: Any, index: int) -> HttpOperationManifest:
        field_path = f"operations[{index}]"
        if not isinstance(raw, dict):
            raise _type_error(field_path, "an object")
        _reject_unknown(raw, {
            "name", "description", "method", "url", "query", "headers",
            "body", "timeout_seconds", "auth", "extract",
        }, field_path)
        name = _require_str(raw.get("name"), f"{field_path}.name")
        if _NAME_RE.fullmatch(name) is None:
            raise DatabaseValidationError(
                f"{field_path}.name must match {_NAME_RE.pattern}"
            )
        description = _require_str(
            raw.get("description"), f"{field_path}.description", min_length=1,
        )
        method = raw.get("method")
        if method not in _METHODS:
            raise DatabaseValidationError(
                f"{field_path}.method must be one of {'/'.join(_METHODS)}"
            )
        url = _require_str(raw.get("url"), f"{field_path}.url", min_length=1)
        _validate_url_template(url, field_path)
        timeout = raw.get("timeout_seconds", 30.0)
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool):
            raise DatabaseValidationError(
                f"{field_path}.timeout_seconds must be a number"
            )
        timeout_value = float(timeout)
        if not (0 < timeout_value <= 120):
            raise DatabaseValidationError(
                f"{field_path}.timeout_seconds must be in (0, 120]"
            )
        query = _require_str_dict(raw.get("query"), f"{field_path}.query")
        headers = _require_str_dict(raw.get("headers"), f"{field_path}.headers")
        for header_name in headers:
            if (
                _PLACEHOLDER.search(header_name)
                or "\r" in header_name
                or "\n" in header_name
            ):
                raise DatabaseValidationError(
                    f"{field_path}.headers: header names must be fixed "
                    "manifest values"
                )
        auth: HttpAuthReference | None = None
        if raw.get("auth") is not None:
            auth = HttpAuthReference.parse(raw.get("auth"), f"{field_path}.auth")
        extract: str | None = None
        if raw.get("extract") is not None:
            extract = _require_str(raw.get("extract"), f"{field_path}.extract")
            if _EXTRACT_RE.fullmatch(extract) is None:
                raise DatabaseValidationError(
                    f"{field_path}.extract must match {_EXTRACT_RE.pattern}"
                )
        body = raw.get("body")
        return cls(
            name=name,
            description=description,
            method=method,
            url=url,
            query=query,
            headers=headers,
            body=body,
            timeout_seconds=timeout_value,
            auth=auth,
            extract=extract,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "method": self.method,
            "url": self.url,
            "query": dict(self.query),
            "headers": dict(self.headers),
            "body": self.body,
            "timeout_seconds": self.timeout_seconds,
            "auth": self.auth.to_dict() if self.auth is not None else None,
            "extract": self.extract,
        }


def _validate_url_template(url: str, field_path: str) -> None:
    original = urlsplit(url)
    if _PLACEHOLDER.search(original.netloc):
        raise DatabaseValidationError(
            f"{field_path}.url: operation URL authority cannot contain "
            "placeholders"
        )
    rendered = _PLACEHOLDER.sub("placeholder", url)
    parsed = urlsplit(rendered)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise DatabaseValidationError(
            f"{field_path}.url must be an absolute HTTP(S) URL"
        )
    if parsed.username is not None or parsed.password is not None:
        raise DatabaseValidationError(
            f"{field_path}.url: operation URL credentials are not allowed"
        )
    if parsed.hostname.lower() == "localhost":
        raise DatabaseValidationError(
            f"{field_path}.url must use a public hostname"
        )


def _require_str_dict(raw: Any, field_path: str) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise _type_error(field_path, "an object")
    return {str(key): value for key, value in raw.items()}


def _reject_unknown(raw: dict[str, Any], allowed: set[str], field_path: str) -> None:
    unknown = [key for key in raw if key not in allowed]
    if unknown:
        raise DatabaseValidationError(
            f"{field_path}: extra fields not allowed: {', '.join(sorted(unknown))}"
        )


@dataclass(frozen=True, slots=True)
class DeclarativeDatabaseManifest:
    """Declarative user database whose operations are outbound HTTP requests."""

    schema_version: str
    name: str
    display_name: str
    version: str
    category: str
    description: str
    supported_sources: tuple[str, ...]
    operations: tuple[HttpOperationManifest, ...]
    enabled: bool
    user_selectable: bool
    pipeline_supported: bool
    requirements: tuple[str, ...]

    @classmethod
    def parse(cls, raw: Any) -> DeclarativeDatabaseManifest:
        if not isinstance(raw, dict):
            raise DatabaseValidationError("manifest must be an object")
        _reject_unknown(raw, {
            "schema_version", "name", "display_name", "version", "category",
            "description", "supported_sources", "operations", "enabled",
            "user_selectable", "pipeline_supported", "requirements",
        }, "manifest")
        schema_version = raw.get("schema_version")
        if schema_version != "1.0":
            raise DatabaseValidationError("schema_version must be '1.0'")
        name = _require_str(raw.get("name"), "name")
        if _NAME_RE.fullmatch(name) is None:
            raise DatabaseValidationError(
                f"name must match {_NAME_RE.pattern}"
            )
        display_name = _require_str(
            raw.get("display_name"), "display_name", min_length=1,
        )
        version = _require_str(raw.get("version"), "version", min_length=1)
        category = _require_str(raw.get("category"), "category")
        if category not in _CATEGORIES:
            raise DatabaseValidationError(
                f"category must be one of {'/'.join(_CATEGORIES)}"
            )
        description = _require_str(
            raw.get("description"), "description", min_length=1,
        )
        supported_sources = _require_str_tuple(
            raw.get("supported_sources", []), "supported_sources",
        )
        operations_raw = raw.get("operations")
        if not isinstance(operations_raw, list):
            raise _type_error("operations", "an array")
        operations = tuple(
            HttpOperationManifest.parse(item, index)
            for index, item in enumerate(operations_raw)
        )
        names = [operation.name for operation in operations]
        if len(names) != len(set(names)):
            raise DatabaseValidationError("operation names must be unique")
        enabled = _require_bool(raw.get("enabled", True), "enabled")
        user_selectable = _require_bool(
            raw.get("user_selectable", True), "user_selectable",
        )
        pipeline_supported = raw.get("pipeline_supported", False)
        if pipeline_supported is not False:
            raise DatabaseValidationError("pipeline_supported must be false")
        requirements = _require_str_tuple(
            raw.get("requirements", []), "requirements",
        )
        if requirements:
            raise DatabaseValidationError(
                "declarative databases cannot declare Python requirements"
            )
        return cls(
            schema_version=schema_version,
            name=name,
            display_name=display_name,
            version=version,
            category=category,
            description=description,
            supported_sources=supported_sources,
            operations=operations,
            enabled=enabled,
            user_selectable=user_selectable,
            pipeline_supported=False,
            requirements=(),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "name": self.name,
            "display_name": self.display_name,
            "version": self.version,
            "category": self.category,
            "description": self.description,
            "supported_sources": list(self.supported_sources),
            "operations": [operation.to_dict() for operation in self.operations],
            "enabled": self.enabled,
            "user_selectable": self.user_selectable,
            "pipeline_supported": self.pipeline_supported,
            "requirements": list(self.requirements),
        }


def redact_sensitive_manifest(value: object, *, key: str = "") -> object:
    """Redact sensitive manifest keys before serializing to API responses."""
    if key.lower() in _SENSITIVE_MANIFEST_KEYS:
        return _REDACTED
    if isinstance(value, dict):
        return {
            str(item_key): redact_sensitive_manifest(item, key=str(item_key))
            for item_key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive_manifest(item) for item in value]
    return value


__all__ = [
    "DatabaseValidationError",
    "DeclarativeDatabaseManifest",
    "HttpAuthReference",
    "HttpOperationManifest",
    "redact_sensitive_manifest",
]
