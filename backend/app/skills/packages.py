"""Safe loaders for declarative HTTP skills and user Python ZIP packages."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from collections.abc import Mapping
from importlib import metadata
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import httpx
import yaml
from agents import FunctionTool
from packaging.requirements import InvalidRequirement, Requirement
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.skills.catalog import SkillDescriptor, SkillManifest, SkillOperation
from app.skills.registry import SkillCategory, SkillDef
from app.tools.network_safety import UnsafeUrlError, validate_public_http_url

_PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*)\}")
_FIXED_ENTRYPOINT = "skill.py:skill"
_LOCAL_CODE_WARNING = (
    "This package executes local Python code with the backend process permissions; "
    "install only code you trust."
)


class PackageValidationError(ValueError):
    """Raised when a user package cannot be safely validated or loaded."""


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


class DeclarativeSkillManifest(BaseModel):
    """Declarative user skill whose operations are outbound HTTP requests."""

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
    def _validate_unique_operations(self) -> DeclarativeSkillManifest:
        names = [operation.name for operation in self.operations]
        if len(names) != len(set(names)):
            raise ValueError("operation names must be unique")
        if self.requirements:
            raise ValueError("declarative skills cannot declare Python requirements")
        return self


class LoadedZipPackage(BaseModel):
    """Validated Python ZIP result and its explicit trust warning."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    descriptor: SkillDescriptor
    module_name: str
    warning: str = _LOCAL_CODE_WARNING


def parse_manifest_document(content: bytes, filename: str) -> dict[str, Any]:
    """Parse a JSON/YAML upload into a mapping without evaluating expressions."""
    try:
        if filename.lower().endswith((".yaml", ".yml")):
            value = yaml.safe_load(content.decode("utf-8"))
        else:
            value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, yaml.YAMLError) as error:
        raise PackageValidationError("manifest is not valid JSON/YAML") from error
    if not isinstance(value, dict):
        raise PackageValidationError("manifest root must be an object")
    return value


class SkillPackageLoader:
    """Load user packages using installed dependencies only."""

    def __init__(
        self,
        *,
        secrets: Mapping[str, str] | None = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
        max_zip_files: int = 100,
        max_zip_bytes: int = 10 * 1024 * 1024,
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
        self._max_zip_files = max_zip_files
        self._max_zip_bytes = max_zip_bytes

    def load_manifest(self, raw: Mapping[str, Any]) -> SkillDescriptor:
        """Validate and bind a declarative HTTP manifest."""
        try:
            manifest = DeclarativeSkillManifest.model_validate(raw)
        except ValueError as error:
            raise PackageValidationError(str(error)) from error
        operations = tuple(
            SkillOperation(
                name=operation.name,
                tool=self._build_http_tool(operation),
                access_requirement=(
                    "credential_required" if operation.auth is not None else "public"
                ),
            )
            for operation in manifest.operations
        )
        return SkillDescriptor(
            name=manifest.name,
            display_name=manifest.display_name,
            version=manifest.version,
            category=manifest.category,
            description=manifest.description,
            origin="package",
            supported_sources=manifest.supported_sources,
            operations=operations,
            enabled=manifest.enabled,
            user_selectable=manifest.user_selectable,
            pipeline_supported=False,
        )

    def load_zip(self, content: bytes, *, extraction_root: Path) -> LoadedZipPackage:
        """Safely extract and load ``manifest.json`` + ``skill.py:skill``."""
        package_hash = hashlib.sha256(content).hexdigest()
        module_name = f"_biomed_user_skill_{package_hash}"
        extraction_root.mkdir(parents=True, exist_ok=True)
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except (zipfile.BadZipFile, OSError) as error:
            raise PackageValidationError("package is not a valid ZIP archive") from error
        with archive:
            infos = archive.infolist()
            files = [info for info in infos if not info.is_dir()]
            if len(files) > self._max_zip_files:
                raise PackageValidationError("ZIP file-count limit exceeded")
            if sum(info.file_size for info in files) > self._max_zip_bytes:
                raise PackageValidationError("ZIP uncompressed size limit exceeded")
            for info in infos:
                self._validate_zip_member(info)
            names = {info.filename for info in files}
            if "manifest.json" not in names or "skill.py" not in names:
                raise PackageValidationError("ZIP requires manifest.json and skill.py")
            try:
                raw_manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                manifest = SkillManifest.model_validate(raw_manifest)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
                raise PackageValidationError("Python package manifest is invalid") from error
            if manifest.origin != "package":
                manifest = manifest.model_copy(update={"origin": "package"})
            if manifest.entrypoint != _FIXED_ENTRYPOINT:
                raise PackageValidationError("Python entrypoint must be skill.py:skill")
            self._validate_requirements(manifest.requirements)
            with tempfile.TemporaryDirectory(prefix="skill-load-", dir=extraction_root) as temp:
                package_dir = Path(temp)
                for info in files:
                    destination = package_dir.joinpath(*PurePosixPath(info.filename).parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read(info))
                module = self._load_module(module_name, package_dir / "skill.py", package_dir)
                exported = getattr(module, "skill", None)
                descriptor = self._adapt_python_export(exported, manifest, package_hash)
        return LoadedZipPackage(descriptor=descriptor, module_name=module_name)

    def validate_zip(self, content: bytes) -> LoadedZipPackage:
        """Validate ZIP structure, metadata, dependencies, and Python syntax only."""
        package_hash = hashlib.sha256(content).hexdigest()
        module_name = f"_biomed_user_skill_{package_hash}"
        manifest, source = self._inspect_zip(content)
        try:
            ast.parse(source, filename="skill.py")
        except SyntaxError as error:
            raise PackageValidationError(f"Python entrypoint syntax is invalid: {error}") from error
        descriptor = SkillDescriptor(
            name=manifest.name,
            display_name=manifest.display_name,
            version=manifest.version,
            category=manifest.category,
            description=manifest.description,
            origin="package",
            supported_sources=manifest.supported_sources,
            operations=(),
            enabled=manifest.enabled,
            user_selectable=manifest.user_selectable,
            pipeline_supported=False,
            requirements=manifest.requirements,
            entrypoint=manifest.entrypoint,
            package_hash=package_hash,
        )
        return LoadedZipPackage(descriptor=descriptor, module_name=module_name)

    def _inspect_zip(self, content: bytes) -> tuple[SkillManifest, str]:
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except (zipfile.BadZipFile, OSError) as error:
            raise PackageValidationError("package is not a valid ZIP archive") from error
        with archive:
            infos = archive.infolist()
            files = [info for info in infos if not info.is_dir()]
            if len(files) > self._max_zip_files:
                raise PackageValidationError("ZIP file-count limit exceeded")
            if sum(info.file_size for info in files) > self._max_zip_bytes:
                raise PackageValidationError("ZIP uncompressed size limit exceeded")
            for info in infos:
                self._validate_zip_member(info)
            names = {info.filename for info in files}
            if "manifest.json" not in names or "skill.py" not in names:
                raise PackageValidationError("ZIP requires manifest.json and skill.py")
            try:
                manifest = SkillManifest.model_validate_json(archive.read("manifest.json"))
                source = archive.read("skill.py").decode("utf-8")
            except (UnicodeDecodeError, ValueError) as error:
                raise PackageValidationError("Python package manifest is invalid") from error
        if manifest.entrypoint != _FIXED_ENTRYPOINT:
            raise PackageValidationError("Python entrypoint must be skill.py:skill")
        self._validate_requirements(manifest.requirements)
        return manifest, source

    def _build_http_tool(self, operation: HttpOperationManifest) -> FunctionTool:
        parameters = sorted(_collect_placeholders(operation.model_dump(exclude={"auth"})))
        schema = {
            "type": "object",
            "properties": {name: {"type": "string"} for name in parameters},
            "required": parameters,
            "additionalProperties": False,
        }

        async def invoke(_context: Any, arguments_json: str) -> Any:
            try:
                arguments = json.loads(arguments_json)
                if not isinstance(arguments, dict):
                    raise ValueError("arguments must be an object")
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
                        raise PackageValidationError(
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
                        if received > 10 * 1024 * 1024:
                            raise ValueError("response exceeds 10 MiB limit")
                        chunks.append(chunk)
                payload = json.loads(b"".join(chunks))
                return _extract_response(payload, operation.extract)
            except (httpx.HTTPError, UnsafeUrlError, ValueError) as error:
                raise PackageValidationError(str(error)) from error

        return FunctionTool(
            name=operation.name,
            description=operation.description,
            params_json_schema=schema,
            on_invoke_tool=invoke,
            strict_json_schema=True,
        )

    def _validate_zip_member(self, info: zipfile.ZipInfo) -> None:
        path = PurePosixPath(info.filename)
        if (
            not info.filename
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in info.filename
            or path.parts[0].endswith(":")
        ):
            raise PackageValidationError(f"unsafe ZIP path: {info.filename}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise PackageValidationError(f"ZIP symlinks are not allowed: {info.filename}")

    def _validate_requirements(self, requirements: tuple[str, ...]) -> None:
        for raw in requirements:
            try:
                requirement = Requirement(raw)
                installed = metadata.version(requirement.name)
            except (InvalidRequirement, metadata.PackageNotFoundError) as error:
                raise PackageValidationError(f"unavailable requirement: {raw}") from error
            if requirement.specifier and installed not in requirement.specifier:
                raise PackageValidationError(
                    f"unavailable requirement: {raw} (installed {installed})"
                )

    def _load_module(self, name: str, source: Path, package_dir: Path) -> ModuleType:
        spec = importlib.util.spec_from_file_location(name, source)
        if spec is None or spec.loader is None:
            raise PackageValidationError("Python entrypoint could not be loaded")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        sys.path.insert(0, str(package_dir))
        try:
            spec.loader.exec_module(module)
        except Exception as error:
            sys.modules.pop(name, None)
            raise PackageValidationError(f"Python entrypoint failed: {error}") from error
        finally:
            sys.path.remove(str(package_dir))
        return module

    def _adapt_python_export(
        self,
        exported: Any,
        manifest: SkillManifest,
        package_hash: str,
    ) -> SkillDescriptor:
        if isinstance(exported, SkillDef):
            descriptor = SkillDescriptor.from_skill_def(
                exported,
                display_name=manifest.display_name,
                origin="package",
                user_selectable=manifest.user_selectable,
                pipeline_supported=False,
                requirements=manifest.requirements,
                entrypoint=_FIXED_ENTRYPOINT,
                package_hash=package_hash,
            )
        elif isinstance(exported, SkillDescriptor):
            descriptor = exported.model_copy(
                update={
                    "origin": "package",
                    "display_name": manifest.display_name,
                    "user_selectable": manifest.user_selectable,
                    "pipeline_supported": False,
                    "requirements": manifest.requirements,
                    "entrypoint": _FIXED_ENTRYPOINT,
                    "package_hash": package_hash,
                }
            )
        else:
            raise PackageValidationError(
                "skill.py must export SkillDef or SkillDescriptor as skill"
            )
        if (
            descriptor.name != manifest.name
            or descriptor.version != manifest.version
            or descriptor.category != manifest.category
            or descriptor.operation_names != manifest.operations
        ):
            raise PackageValidationError("Python export does not match manifest metadata")
        return descriptor


async def _validate_request_url(request: httpx.Request) -> None:
    validate_public_http_url(str(request.url))


def _collect_placeholders(value: Any) -> set[str]:
    if isinstance(value, str):
        return set(_PLACEHOLDER.findall(value))
    if isinstance(value, Mapping):
        found: set[str] = set()
        for key, item in value.items():
            found.update(_collect_placeholders(key))
            found.update(_collect_placeholders(item))
        return found
    if isinstance(value, (list, tuple)):
        found = set()
        for item in value:
            found.update(_collect_placeholders(item))
        return found
    return set()


def _render_template(template: str, arguments: Mapping[str, Any]) -> str:
    try:
        return _PLACEHOLDER.sub(lambda match: str(arguments[match.group(1)]), template)
    except KeyError as error:
        raise ValueError(f"missing template argument: {error.args[0]}") from error


def _render_url(template: str, arguments: Mapping[str, Any]) -> str:
    parsed = urlsplit(template)
    try:
        path = _PLACEHOLDER.sub(
            lambda match: quote(str(arguments[match.group(1)]), safe=""), parsed.path
        )
    except KeyError as error:
        raise ValueError(f"missing template argument: {error.args[0]}") from error
    return parsed._replace(path=path).geturl()


def _render_value(value: Any, arguments: Mapping[str, Any]) -> Any:
    if isinstance(value, str):
        return _render_template(value, arguments)
    if isinstance(value, dict):
        return {
            _render_template(str(key), arguments): _render_value(item, arguments)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_render_value(item, arguments) for item in value]
    return value


def _extract_response(payload: Any, path: str | None) -> Any:
    if path is None:
        return payload
    current = payload
    for segment in path.split("."):
        if isinstance(current, list) and segment.isdigit():
            current = current[int(segment)]
        elif isinstance(current, Mapping):
            current = current[segment]
        else:
            raise PackageValidationError(f"response extraction failed at: {segment}")
    return current
