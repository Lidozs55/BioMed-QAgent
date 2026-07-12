"""Authoritative, versioned contracts for the deterministic backend pipeline."""

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import (
    AttemptStatus,
    Database,
    DataLevel,
    DownloadStatus,
    ErrorCode,
    RequestedOutput,
    StageName,
    TaskState,
    WarningSeverity,
)
from app.domain.contracts.ids import (
    asset_id_from_sha256,
    generate_prefixed_uuid,
    make_dataset_id,
    make_record_id,
    make_source_id,
)
from app.domain.contracts.source import (
    DownloadAttempt,
    FileAsset,
    SourceAsset,
    SourceLocator,
    SourceRecord,
    SourceRelation,
)
from app.domain.contracts.task import (
    DatasetSelection,
    QuerySpecification,
    TaskRequest,
    TaskSpecification,
)

__all__ = [
    "AttemptStatus",
    "ContractModel",
    "DataLevel",
    "Database",
    "DatasetSelection",
    "DownloadAttempt",
    "DownloadStatus",
    "ErrorCode",
    "FileAsset",
    "QuerySpecification",
    "RequestedOutput",
    "SourceAsset",
    "SourceLocator",
    "SourceRecord",
    "SourceRelation",
    "StageName",
    "TaskRequest",
    "TaskSpecification",
    "TaskState",
    "WarningSeverity",
    "asset_id_from_sha256",
    "generate_prefixed_uuid",
    "make_dataset_id",
    "make_record_id",
    "make_source_id",
]
