"""Declarative HTTP database manifests — the thin Phase 2 replacement for
Python skill packages.

Only declarative, expression-free HTTP operations are supported. ZIP packages,
Python code execution, and the runtime skill catalog are gone
(docs/migration/phase2-skills-tools-migration.md, decision D4). The HIL
approval gate for credential-protected operations is enforced inside the
built tool (previously the SkillGateway's job).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
import yaml
from agents import FunctionTool, RunContextWrapper
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.skills.categories import SkillCategory
from app.tools.network_safety import UnsafeUrlError, validate_public_http_url

_PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*)\}")
_MAX_RESPONSE_BYTES = 10 * 1024 * 1024


class DatabaseValidationError(ValueError):
    """Raised when a declarative database manifest cannot be accepted."""


class HttpAuthReference(BaseModel):
    """Reference to a configured secret; never contains the secret value."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source: Literal["env"] = "env"
    reference: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    location: Literal["header", "query"]
    name: str = Field(min_length=1)
    prefix: str = ""


class HttpOperationManifest(BaseModel):
    """One minimal, expression-free HTTP operation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    url: str = Field(min_length=1)
    query: dict[str, Any] = Field(default_factory=dict)
    headers: dict[str, Any] = Field(default_factory=dict)
    body: Any | None = None
    timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    auth: HttpAuthReference | None = None
    extract: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_.-]+$")

    @field_validator("url")
    @classmethod
    def _validate_url_template(cls, value: str) -> str:
        original = urlsplit(value)
        if _PLACEHOLDER.search(original.netloc):
            raise ValueError("operation URL authority cannot contain placeholders")
        rendered = _PLACEHOLDER.sub("placeholder", value)
        parsed = urlsplit(rendered)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("operation URL must be an absolute HTTP(S) URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("operation URL credentials are not allowed")
        if parsed.hostname.lower() == "localhost":
            raise ValueError("operation URL must use a public hostname")
        return value

    @field_validator("headers")
    @classmethod
    def _validate_header_names(cls, value: dict[str, Any]) -> dict[str, Any]:
        if any(_PLACEHOLDER.search(name) or "\r" in name or "\n" in name for name in value):
            raise ValueError("header names must be fixed manifest values")
        return value


class DeclarativeDatabaseManifest(BaseModel):
    """Declarative user database whose operations are outbound HTTP requests."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["1.0"] = "1.0"
    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    category: SkillCategory
    description: str = Field(min_length=1)
    supported_sources: tuple[str, ...] = ()
    operations: tuple[HttpOperationManifest, ...]
    enabled: bool = True
    user_selectable: bool = True
    pipeline_supported: Literal[False] = False
    requirements: tuple[str, ...] = ()

    @model_validator(mode="after")
    def _validate_unique_operations(self) -> DeclarativeDatabaseManifest:
        names = [operation.name for operation in self.operations]
        if len(names) != len(set(names)):
            raise ValueError("operation names must be unique")
        if self.requirements:
            raise ValueError("declarative databases cannot declare Python requirements")
        return self


def parse_manifest_document(content: bytes, filename: str) -> dict[str, Any]:
    """Parse a JSON/YAML upload into a mapping without evaluating expressions."""
    try:
        if filename.lower().endswith((".yaml", ".yml")):
            value = yaml.safe_load(content.decode("utf-8"))
        else:
            value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, yaml.YAMLError) as error:
        raise DatabaseValidationError("manifest is not valid JSON/YAML") from error
    if not isinstance(value, dict):
        raise DatabaseValidationError("manifest root must be an object")
    return value


def validate_declarative_manifest(raw: Mapping[str, Any]) -> DeclarativeDatabaseManifest:
    """Validate a declarative database manifest without building tools."""
    try:
        return DeclarativeDatabaseManifest.model_validate(raw)
    except ValueError as error:
        raise DatabaseValidationError(str(error)) from error


def _collect_placeholders(value: Any, seen: set[str] | None = None) -> set[str]:
    """Collect placeholder names from a nested manifest value."""
    if seen is None:
        seen = set()
    if isinstance(value, str):
        seen.update(_PLACEHOLDER.findall(value))
    elif isinstance(value, list):
        for item in value:
            _collect_placeholders(item, seen)
    elif isinstance(value, dict):
        for item in value.values():
            _collect_placeholders(item, seen)
    return seen


def _render_value(value: Any, arguments: dict[str, str]) -> Any:
    """Render placeholders in a nested value using the provided arguments."""
    if isinstance(value, str):
        return _PLACEHOLDER.sub(
            lambda match: arguments.get(match.group(1), match.group(0)),
            value,
        )
    if isinstance(value, list):
        return [_render_value(item, arguments) for item in value]
    if isinstance(value, dict):
        return {key: _render_value(item, arguments) for key, item in value.items()}
    return value


def _render_url(url: str, arguments: dict[str, str]) -> str:
    missing = {
        name
        for name in _collect_placeholders(url)
        if name not in arguments
    }
    if missing:
        raise ValueError(f"missing URL arguments: {sorted(missing)}")
    return _render_value(url, arguments)


def _extract_response(payload: Any, extract: str | None) -> Any:
    if extract is None:
        return payload
    current = payload
    for part in extract.split("."):
        if not isinstance(current, dict) or part not in current:
            raise ValueError(f"extraction path not found: {extract}")
        current = current[part]
    return current


async def _validate_request_url(request: httpx.Request) -> None:
    validate_public_http_url(str(request.url))


class DeclarativeHttpToolBuilder:
    """Build direct SDK tools from declarative HTTP operation manifests."""

    def __init__(
        self,
        *,
        secrets: Mapping[str, str] | None = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._secrets = (
            {
                key: value
                for key, value in os.environ.items()
                if key.startswith("BIOMED_SKILL_SECRET_")
            }
            if secrets is None
            else dict(secrets)
        )
        self._http_transport = http_transport

    def build_tool(self, operation: HttpOperationManifest) -> FunctionTool:
        parameters = sorted(_collect_placeholders(operation.model_dump(exclude={"auth"})))
        schema = {
            "type": "object",
            "properties": {name: {"type": "string"} for name in parameters},
            "required": parameters,
            "additionalProperties": False,
        }

        async def invoke(ctx: RunContextWrapper[Any], arguments_json: str) -> Any:
            try:
                arguments = json.loads(arguments_json)
                if not isinstance(arguments, dict):
                    raise ValueError("arguments must be an object")
                await self._approve_credential_use(operation, ctx)
                url = _render_url(operation.url, arguments)
                validate_public_http_url(url)
                query = _render_value(operation.query, arguments)
                headers = _render_value(operation.headers, arguments)
                if any("\r" in str(value) or "\n" in str(value) for value in headers.values()):
                    raise ValueError("header values cannot contain CR/LF")
                body = _render_value(operation.body, arguments)
                if operation.auth is not None:
                    secret = self._secrets.get(operation.auth.reference)
                    if secret is None:
                        raise DatabaseValidationError(
                            f"configured secret is unavailable: {operation.auth.reference}"
                        )
                    value = f"{operation.auth.prefix}{secret}"
                    target = headers if operation.auth.location == "header" else query
                    target[operation.auth.name] = value
                async with (
                    httpx.AsyncClient(
                        transport=self._http_transport,
                        follow_redirects=True,
                        timeout=operation.timeout_seconds,
                        event_hooks={"request": [_validate_request_url]},
                    ) as client,
                    client.stream(
                        operation.method,
                        url,
                        params=query,
                        headers=headers,
                        json=body,
                    ) as response,
                ):
                    response.raise_for_status()
                    chunks: list[bytes] = []
                    received = 0
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > _MAX_RESPONSE_BYTES:
                            raise ValueError("response exceeds 10 MiB limit")
                        chunks.append(chunk)
                payload = json.loads(b"".join(chunks))
                return _extract_response(payload, operation.extract)
            except (httpx.HTTPError, UnsafeUrlError, ValueError) as error:
                raise DatabaseValidationError(str(error)) from error

        return FunctionTool(
            name=operation.name,
            description=operation.description,
            params_json_schema=schema,
            on_invoke_tool=invoke,
            strict_json_schema=True,
        )

    async def _approve_credential_use(
        self,
        operation: HttpOperationManifest,
        ctx: RunContextWrapper[Any],
    ) -> None:
        """Keep the legacy HIL gate: credential-protected operations require
        subagent-context approval before their server-side secret is used."""
        if operation.auth is None:
            return
        context = getattr(ctx, "context", None)
        if getattr(context, "subagent_id", None) is None:
            raise DatabaseValidationError(
                f"Operation '{operation.name}' requires HIL approval before "
                "credentials can be used."
            )
        try:
            resumed = await context.request_subagent_input(
                summary=f"Approve credential use for {operation.name}",
                prompt_kind="api_key_or_credential",
                detail={"operation": operation.name},
            )
        except (LookupError, RuntimeError, ValueError) as error:
            raise DatabaseValidationError(str(error)) from error
        if resumed.decision != "approve":
            raise DatabaseValidationError(
                f"Operation '{operation.name}': credential use was rejected by the user."
            )


__all__ = [
    "DatabaseValidationError",
    "DeclarativeDatabaseManifest",
    "DeclarativeHttpToolBuilder",
    "HttpAuthReference",
    "HttpOperationManifest",
    "parse_manifest_document",
    "validate_declarative_manifest",
]
