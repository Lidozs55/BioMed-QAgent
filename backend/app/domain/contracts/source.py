"""Source metadata, download attempt and immutable file contracts."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import DataLevel, Database, DownloadStatus, ErrorCode


_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _validate_relative_path(value: str) -> str:
    if not value or "\\" in value:
        raise ValueError("relative_path must be a non-empty POSIX relative path")
    path = PurePosixPath(value)
    windows_path = PureWindowsPath(value)
    if path.is_absolute() or windows_path.is_absolute() or ".." in path.parts:
        raise ValueError("relative_path must not be absolute or escape its root")
    return path.as_posix()


class SourceRecord(ContractModel):
    source_id: str = Field(min_length=1)
    database: Database
    accession: str = Field(min_length=1)
    url: str = Field(min_length=1)
    title: str
    retrieved_at: datetime


class SourceRelation(ContractModel):
    relation_id: str = Field(min_length=1)
    from_source_id: str = Field(min_length=1)
    to_source_id: str = Field(min_length=1)
    relation_type: str = Field(min_length=1)
    evidence_type: str = Field(min_length=1)
    evidence_value: str = Field(min_length=1)
    evidence_url: str = Field(min_length=1)


class DownloadAttempt(ContractModel):
    attempt_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    url: str = Field(min_length=1)
    status: DownloadStatus
    bytes_received: int = Field(ge=0)
    error_code: ErrorCode | None = None
    error_message: str | None = None
    started_at: datetime
    finished_at: datetime

    @model_validator(mode="after")
    def validate_outcome(self) -> "DownloadAttempt":
        if self.finished_at < self.started_at:
            raise ValueError("finished_at must not precede started_at")
        has_error = self.error_code is not None or self.error_message is not None
        if self.status is DownloadStatus.SUCCEEDED and has_error:
            raise ValueError("successful download must not contain an error")
        if self.status is not DownloadStatus.SUCCEEDED and not has_error:
            raise ValueError("failed download must contain an error")
        return self


class FileAsset(ContractModel):
    asset_id: str = Field(min_length=1)
    kind: Literal["source", "parsed", "normalized", "artifact"]
    relative_path: str
    sha256: str
    size_bytes: int = Field(ge=0)
    media_type: str = Field(min_length=1)
    generated_by_step_id: str | None = None

    @field_validator("relative_path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        return _validate_relative_path(value)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        checksum = value.lower()
        if not _SHA256_PATTERN.fullmatch(checksum):
            raise ValueError("sha256 must contain 64 hexadecimal characters")
        return checksum

    @model_validator(mode="after")
    def validate_asset_id(self) -> "FileAsset":
        if self.asset_id != f"asset_{self.sha256}":
            raise ValueError("asset_id must be derived from the full sha256")
        return self


class SourceAsset(FileAsset):
    kind: Literal["source"] = "source"
    source_id: str = Field(min_length=1)
    successful_attempt_id: str = Field(min_length=1)
    data_level: DataLevel

    @model_validator(mode="after")
    def validate_source_path(self) -> "SourceAsset":
        if PurePosixPath(self.relative_path).parts[0] != "source_assets":
            raise ValueError("SourceAsset path must be inside source_assets")
        return self


class SourceLocator(ContractModel):
    asset_id: str = Field(min_length=1)
    logical_file: str
    source_line_number: int = Field(ge=1)
    source_column_index: int = Field(ge=0)
    source_column_name: str
    raw_value: str

    @field_validator("logical_file")
    @classmethod
    def validate_logical_file(cls, value: str) -> str:
        return _validate_relative_path(value)
