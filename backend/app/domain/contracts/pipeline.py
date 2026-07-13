"""Processing, stage-attempt, artifact and run-manifest contracts."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal

from pydantic import Field, JsonValue, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import (
    AttemptStatus,
    ErrorCode,
    StageName,
    TaskState,
    WarningSeverity,
)
from app.domain.contracts.source import FileAsset, _validate_relative_path
from app.domain.contracts.task import TaskRequest, TaskSpecification

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _validate_sha256(value: str) -> str:
    checksum = value.lower()
    if not _SHA256_PATTERN.fullmatch(checksum):
        raise ValueError("digest must contain 64 hexadecimal characters")
    return checksum


class ErrorDetail(ContractModel):
    code: ErrorCode
    message: str = Field(min_length=1)
    retryable: bool
    stage: StageName | None = None
    details: dict[str, JsonValue] = Field(default_factory=dict)


class WarningRecord(ContractModel):
    warning_id: str = Field(min_length=1)
    severity: WarningSeverity
    stage: StageName
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    source_id: str | None = None
    asset_id: str | None = None
    record_id: str | None = None
    created_at: datetime


class ParsedDataset(ContractModel):
    dataset_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    source_asset_id: str = Field(min_length=1)
    file_asset: FileAsset
    columns: list[str] = Field(min_length=1)
    row_count: int = Field(ge=0)
    parser_name: str = Field(min_length=1)
    parser_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_file_asset(self) -> ParsedDataset:
        if self.file_asset.kind != "parsed":
            raise ValueError("ParsedDataset file_asset kind must be parsed")
        return self


class StageAttempt(ContractModel):
    stage_attempt_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    stage: StageName
    attempt: int = Field(ge=1)
    input_digest: str
    parameter_digest: str
    output_digest: str | None = None
    status: AttemptStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorDetail | None = None

    @field_validator("input_digest", "parameter_digest", "output_digest")
    @classmethod
    def validate_digest(cls, value: str | None) -> str | None:
        return None if value is None else _validate_sha256(value)

    @model_validator(mode="after")
    def validate_status_fields(self) -> StageAttempt:
        if self.finished_at is not None and self.started_at is None:
            raise ValueError("finished_at requires started_at")
        if (
            self.started_at is not None
            and self.finished_at is not None
            and self.finished_at < self.started_at
        ):
            raise ValueError("finished_at must not precede started_at")
        if self.status is AttemptStatus.SUCCEEDED and self.output_digest is None:
            raise ValueError("succeeded attempt requires output_digest")
        if self.status is AttemptStatus.FAILED and self.error is None:
            raise ValueError("failed attempt requires error")
        if self.status is AttemptStatus.SUCCEEDED and self.error is not None:
            raise ValueError("succeeded attempt must not contain error")
        return self


class ArtifactManifestEntry(ContractModel):
    artifact_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    relative_path: str
    media_type: str = Field(min_length=1)
    size_bytes: int = Field(ge=0)
    sha256: str
    generated_by_step_id: str = Field(min_length=1)

    @field_validator("relative_path")
    @classmethod
    def validate_artifact_path(cls, value: str) -> str:
        relative = _validate_relative_path(value)
        if PurePosixPath(relative).parts[0] != "artifacts":
            raise ValueError("artifact path must be inside artifacts")
        return relative

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        return _validate_sha256(value)


class ValidationSummary(ContractModel):
    status: Literal["valid", "invalid"]
    checked_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    report_path: str

    @field_validator("report_path")
    @classmethod
    def validate_report_path(cls, value: str) -> str:
        return _validate_relative_path(value)

    @model_validator(mode="after")
    def validate_counts(self) -> ValidationSummary:
        if self.failed_count > self.checked_count:
            raise ValueError("failed_count must not exceed checked_count")
        if self.status == "valid" and self.failed_count != 0:
            raise ValueError("valid status requires failed_count to be zero")
        if self.status == "invalid" and self.failed_count == 0:
            raise ValueError("invalid status requires failed_count greater than zero")
        return self


class RunManifest(ContractModel):
    task_id: str = Field(min_length=1)
    id_generation_version: str = Field(min_length=1)
    request: TaskRequest
    specification: TaskSpecification
    task_state: TaskState
    stage_attempt_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    artifacts: list[ArtifactManifestEntry] = Field(default_factory=list)
    validation: ValidationSummary
    pipeline_version: str = Field(min_length=1)
    model_name: str | None = None
    started_at: datetime
    finished_at: datetime

    @field_validator("stage_attempt_ids", "source_ids")
    @classmethod
    def validate_canonical_ids(cls, value: list[str]) -> list[str]:
        if value != sorted(set(value)):
            raise ValueError("ID lists must be sorted and unique")
        return value

    @field_validator("artifacts")
    @classmethod
    def validate_artifact_order(
        cls, value: list[ArtifactManifestEntry]
    ) -> list[ArtifactManifestEntry]:
        ids = [artifact.artifact_id for artifact in value]
        if ids != sorted(set(ids)):
            raise ValueError("artifacts must be sorted and unique by artifact_id")
        return value

    @model_validator(mode="after")
    def validate_time_order(self) -> RunManifest:
        if self.finished_at < self.started_at:
            raise ValueError("finished_at must not precede started_at")
        return self
