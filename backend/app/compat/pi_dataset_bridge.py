"""Loopback-only, SDK-free Pi to Dataset Core migration bridge."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from app.agent_loop.context import RunContext
from app.datasets.contracts import DatasetBuildSpec
from app.datasets.service import (
    DatasetBuildCompleted,
    DatasetBuildExecutionError,
    DatasetBuildInputError,
    DatasetBuildLookup,
    execute_dataset_build,
    get_build_result,
    validate_dataset_build_spec,
)
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
from app.tools.workdir import validate_safe_path_id

BRIDGE_SECRET_HEADER = "x-biomed-bridge-secret"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_MAX_ACTIVE_REQUESTS = 128
_MAX_REASON_ITEMS = 32
_MAX_REASON_LENGTH = 512


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ValidateArgs(_StrictModel):
    spec: DatasetBuildSpec


class ExecuteArgs(_StrictModel):
    spec: DatasetBuildSpec
    source_files: dict[str, str]
    mapping_files: dict[str, str]

    @field_validator("source_files", "mapping_files")
    @classmethod
    def validate_file_references(cls, value: dict[str, str]) -> dict[str, str]:
        for binding_id, reference in value.items():
            validate_safe_path_id(binding_id, "binding_id")
            _validate_task_relative_reference(reference)
        return value


class GetBuildArgs(_StrictModel):
    build_id: str

    @field_validator("build_id")
    @classmethod
    def validate_build_id(cls, value: str) -> str:
        return validate_safe_path_id(value, "build_id")


class _RequestBase(_StrictModel):
    version: Literal[1]
    request_id: str
    task_id: str
    run_id: str

    @field_validator("request_id", "task_id", "run_id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if _SAFE_ID.fullmatch(value) is None:
            raise ValueError("must be a safe identifier")
        return value


class ValidateRequest(_RequestBase):
    op: Literal["validate_dataset_build_spec"]
    args: ValidateArgs


class ExecuteRequest(_RequestBase):
    op: Literal["execute_dataset_build"]
    args: ExecuteArgs


class GetBuildRequest(_RequestBase):
    op: Literal["get_build_result"]
    args: GetBuildArgs


BridgeRequest = Annotated[
    ValidateRequest | ExecuteRequest | GetBuildRequest,
    Field(discriminator="op"),
]
_REQUEST_ADAPTER = TypeAdapter(BridgeRequest)


class BridgeValidationData(_StrictModel):
    valid: bool
    reason_codes: list[str]
    reasons: list[str]


class BridgeManifestReference(_StrictModel):
    build_id: str
    manifest_id: str
    sha256: str


class BridgeArtifactReference(_StrictModel):
    build_id: str
    artifact_id: str
    role: str
    media_type: str
    size_bytes: int
    sha256: str


class BridgeBuildData(_StrictModel):
    build_id: str
    build_result: BuildResult
    publication_id: str | None
    manifest: BridgeManifestReference | None
    artifacts: list[BridgeArtifactReference]
    validation_summary: dict[str, object] | None


class BridgeErrorDetails(_StrictModel):
    reason_codes: list[str] | None = None
    fields: list[str] | None = None
    category: str | None = None
    cancellation_source: str | None = None
    build_result: BuildResult | None = None
    build_id: str | None = None
    publication_id: str | None = None
    manifest: BridgeManifestReference | None = None
    artifacts: list[BridgeArtifactReference] | None = None
    validation_summary: dict[str, object] | None = None


class BridgeError(_StrictModel):
    code: Literal[
        "invalid_input",
        "spec_rejected",
        "no_data",
        "partial_success",
        "core_execution_error",
        "bridge_unavailable",
        "cancelled",
    ]
    message: str
    retryable: bool
    details: BridgeErrorDetails


class BridgeResponse(_StrictModel):
    version: Literal[1] = 1
    request_id: str
    ok: bool
    data: BridgeValidationData | BridgeBuildData | None
    error: BridgeError | None


class ActiveBridgeRequestRegistry:
    """Bounded in-process request-to-Core cancellation mapping."""

    def __init__(self, *, capacity: int = _MAX_ACTIVE_REQUESTS) -> None:
        self._capacity = capacity
        self._active: dict[str, RunContext] = {}

    @property
    def active_count(self) -> int:
        return len(self._active)

    def register(self, request_id: str, context: RunContext) -> bool:
        if request_id in self._active or len(self._active) >= self._capacity:
            return False
        self._active[request_id] = context
        return True

    def cancel(self, request_id: str) -> bool:
        context = self._active.get(request_id)
        if context is None:
            return False
        context.cancellation_requested.set()
        return True

    def remove(self, request_id: str) -> None:
        self._active.pop(request_id, None)


class PiDatasetBridge:
    """Named-operation bridge that preserves Core as the sole authority."""

    def __init__(
        self,
        context_factory: Callable[[str], RunContext],
        *,
        secret: str | None = None,
        registry: ActiveBridgeRequestRegistry | None = None,
    ) -> None:
        self._context_factory = context_factory
        self.secret = secret if secret else None
        self._registry = registry or ActiveBridgeRequestRegistry()

    @property
    def active_count(self) -> int:
        return self._registry.active_count

    def cancel(self, request_id: str) -> bool:
        return self._registry.cancel(request_id)

    async def handle(self, request: BridgeRequest) -> BridgeResponse:
        if isinstance(request, ValidateRequest):
            validation = validate_dataset_build_spec(request.args.spec.model_dump_json())
            if isinstance(validation, DatasetBuildInputError):
                return _failure(request.request_id, "invalid_input", "DatasetBuildSpec is invalid")
            if not validation.valid:
                return _failure(
                    request.request_id,
                    "spec_rejected",
                    "DatasetBuildSpec was rejected",
                    details=BridgeErrorDetails(
                        reason_codes=_bounded(validation.reason_codes),
                    ),
                )
            return _success(
                request.request_id,
                BridgeValidationData(
                    valid=True,
                    reason_codes=[],
                    reasons=[],
                ),
            )

        context = self._context_factory(request.task_id)
        if isinstance(request, GetBuildRequest):
            try:
                lookup = get_build_result(context, request.args.build_id)
            except ValueError:
                return _failure(
                    request.request_id,
                    "core_execution_error",
                    "Build result is corrupt or unavailable",
                    retryable=False,
                    details=BridgeErrorDetails(category="invalid_build_state"),
                )
            if lookup is None:
                return _failure(
                    request.request_id,
                    "invalid_input",
                    "Build result was not found",
                    details=BridgeErrorDetails(fields=["build_id"]),
                )
            return _success(request.request_id, _build_data(lookup.build_result, lookup))

        validation = validate_dataset_build_spec(request.args.spec.model_dump_json())
        if isinstance(validation, DatasetBuildInputError):
            return _failure(request.request_id, "invalid_input", "DatasetBuildSpec is invalid")
        if not validation.valid:
            return _failure(
                request.request_id,
                "spec_rejected",
                "DatasetBuildSpec was rejected",
                details=BridgeErrorDetails(reason_codes=_bounded(validation.reason_codes)),
            )
        if not self._registry.register(request.request_id, context):
            return _failure(
                request.request_id,
                "invalid_input",
                "Bridge request ID is already active or capacity was reached",
                details=BridgeErrorDetails(fields=["request_id"]),
            )
        try:
            try:
                outcome = await execute_dataset_build(
                    context,
                    request.args.spec.model_dump_json(),
                    request.args.source_files,
                    request.args.mapping_files,
                )
            except ValueError:
                return _failure(
                    request.request_id,
                    "invalid_input",
                    "A source or mapping reference was rejected",
                    details=BridgeErrorDetails(fields=["source_files", "mapping_files"]),
                )
            except Exception:  # noqa: BLE001 - bounded migration boundary
                return _failure(
                    request.request_id,
                    "core_execution_error",
                    "Dataset Core execution failed",
                    retryable=True,
                    details=BridgeErrorDetails(category="internal_error"),
                )
            if isinstance(outcome, DatasetBuildInputError):
                return _failure(
                    request.request_id,
                    "invalid_input",
                    "Dataset build input was rejected",
                )
            if isinstance(outcome, DatasetBuildExecutionError):
                if context.cancellation_requested.is_set() and "cancel" in outcome.message.lower():
                    return _failure(
                        request.request_id,
                        "cancelled",
                        "Dataset Core acknowledged cancellation",
                        details=BridgeErrorDetails(cancellation_source="request_id"),
                    )
                return _failure(
                    request.request_id,
                    "core_execution_error",
                    "Dataset Core execution failed",
                    retryable=outcome.retryable,
                    details=BridgeErrorDetails(category="execution_error"),
                )
            assert isinstance(outcome, DatasetBuildCompleted)
            result = outcome.result.model_copy(update={"build_id": outcome.build_id})
            try:
                lookup = get_build_result(context, outcome.build_id)
            except ValueError:
                return _failure(
                    request.request_id,
                    "core_execution_error",
                    "Dataset Core result failed integrity validation",
                    details=BridgeErrorDetails(category="invalid_build_state"),
                )
            data = _build_data(result, lookup)
            if result.status is BuildResultStatus.NO_DATA:
                return _business_outcome(
                    request.request_id,
                    "no_data",
                    "Dataset build produced no data",
                    data,
                )
            if result.status is BuildResultStatus.PARTIAL_SUCCESS:
                return _business_outcome(
                    request.request_id,
                    "partial_success",
                    "Dataset build partially succeeded",
                    data,
                )
            return _success(request.request_id, data)
        finally:
            self._registry.remove(request.request_id)


def _validate_task_relative_reference(value: str) -> str:
    if not value or "\x00" in value or "\\" in value or re.match(r"^[A-Za-z]:", value):
        raise ValueError("file reference must be task-relative")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("file reference must be task-relative")
    return value


def _bounded(values: list[str]) -> list[str]:
    return [str(value)[:_MAX_REASON_LENGTH] for value in values[:_MAX_REASON_ITEMS]]


def _build_data(result: BuildResult, lookup: DatasetBuildLookup | None) -> BridgeBuildData:
    build_id = result.build_id
    if build_id is None and lookup is not None:
        build_id = lookup.build_id
    if build_id is None:
        raise ValueError("build result has no build identity")
    if lookup is None:
        return BridgeBuildData(
            build_id=build_id,
            build_result=result,
            publication_id=result.publication_id,
            manifest=None,
            artifacts=[],
            validation_summary=None,
        )
    return BridgeBuildData(
        build_id=build_id,
        build_result=result,
        publication_id=result.publication_id,
        manifest=BridgeManifestReference(
            build_id=build_id,
            manifest_id=lookup.manifest.manifest_id,
            sha256=lookup.manifest.sha256,
        ),
        artifacts=[
            BridgeArtifactReference(
                build_id=build_id,
                artifact_id=artifact.artifact_id,
                role=artifact.role.value,
                media_type=artifact.media_type,
                size_bytes=artifact.size_bytes,
                sha256=artifact.sha256,
            )
            for artifact in lookup.artifacts
        ],
        validation_summary=dict(lookup.manifest.validation_summary),
    )


def _success(request_id: str, data: BridgeValidationData | BridgeBuildData) -> BridgeResponse:
    return BridgeResponse(request_id=request_id, ok=True, data=data, error=None)


def _failure(
    request_id: str,
    code: Literal[
        "invalid_input",
        "spec_rejected",
        "no_data",
        "partial_success",
        "core_execution_error",
        "bridge_unavailable",
        "cancelled",
    ],
    message: str,
    *,
    retryable: bool = False,
    details: BridgeErrorDetails | None = None,
) -> BridgeResponse:
    return BridgeResponse(
        request_id=request_id,
        ok=False,
        data=None,
        error=BridgeError(
            code=code,
            message=message[:_MAX_REASON_LENGTH],
            retryable=retryable,
            details=details or BridgeErrorDetails(),
        ),
    )


def _business_outcome(
    request_id: str,
    code: Literal["no_data", "partial_success"],
    message: str,
    data: BridgeBuildData,
) -> BridgeResponse:
    return _failure(
        request_id,
        code,
        message,
        details=BridgeErrorDetails(
            reason_codes=_bounded(data.build_result.reason_codes),
            build_result=data.build_result,
            build_id=data.build_id,
            publication_id=data.publication_id,
            manifest=data.manifest,
            artifacts=data.artifacts,
            validation_summary=data.validation_summary,
        ),
    )


router = APIRouter(prefix="/internal/migration/pi/dataset")


def _response(response: BridgeResponse, *, status: int = 200) -> JSONResponse:
    content: dict[str, object] = {
        "version": response.version,
        "request_id": response.request_id,
        "ok": response.ok,
        "data": response.data.model_dump(mode="json") if response.data is not None else None,
        "error": (
            response.error.model_dump(mode="json", exclude_none=True)
            if response.error is not None
            else None
        ),
    }
    return JSONResponse(status_code=status, content=content)


def _request_id_from(value: object) -> str:
    if isinstance(value, dict):
        request_id = value.get("request_id")
        if isinstance(request_id, str) and _SAFE_ID.fullmatch(request_id):
            return request_id
    return "invalid"


def _is_loopback(host: str | None) -> bool:
    if host is None:
        return False
    normalized = host.removeprefix("[").removesuffix("]").lower()
    return normalized == "::1" or normalized == "localhost" or normalized.startswith("127.")


def _authorized(request: Request, service: PiDatasetBridge) -> bool:
    if not _is_loopback(request.client.host if request.client else None):
        return False
    if service.secret is None:
        return True
    return request.headers.get(BRIDGE_SECRET_HEADER) == service.secret


@router.post("/operations")
async def invoke_operation(request: Request) -> JSONResponse:
    service: PiDatasetBridge = request.app.state.pi_dataset_bridge
    if not _authorized(request, service):
        return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    raw: object
    try:
        raw = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raw = None
    try:
        parsed = _REQUEST_ADAPTER.validate_python(raw)
    except ValidationError as error:
        fields = [
            ".".join(str(part) for part in item["loc"])[-128:]
            for item in error.errors()[:16]
        ]
        return _response(
            _failure(
                _request_id_from(raw),
                "invalid_input",
                "Bridge request failed structural validation",
                details=BridgeErrorDetails(fields=fields),
            ),
            status=400,
        )
    return _response(await service.handle(parsed))


@router.post("/requests/{request_id}/cancel", status_code=202)
async def cancel_request(request_id: str, request: Request) -> JSONResponse:
    service: PiDatasetBridge = request.app.state.pi_dataset_bridge
    if not _authorized(request, service):
        return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    if _SAFE_ID.fullmatch(request_id) is None:
        return JSONResponse(status_code=400, content={"status": "invalid_request"})
    if not service.cancel(request_id):
        return JSONResponse(status_code=404, content={"status": "request_not_active"})
    return JSONResponse(status_code=202, content={"status": "cancel_requested"})
