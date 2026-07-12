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
from app.domain.contracts.pipeline import (
    ArtifactManifestEntry,
    ErrorDetail,
    ParsedDataset,
    RunManifest,
    StageAttempt,
    ValidationSummary,
    WarningRecord,
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
    "ArtifactManifestEntry",
    "ContractModel",
    "DataLevel",
    "Database",
    "DatasetSelection",
    "DownloadAttempt",
    "DownloadStatus",
    "ErrorCode",
    "ErrorDetail",
    "FileAsset",
    "ParsedDataset",
    "QuerySpecification",
    "RequestedOutput",
    "RunManifest",
    "SourceAsset",
    "SourceLocator",
    "SourceRecord",
    "SourceRelation",
    "StageName",
    "StageAttempt",
    "TaskRequest",
    "TaskSpecification",
    "TaskState",
    "ValidationSummary",
    "WarningRecord",
    "WarningSeverity",
    "asset_id_from_sha256",
    "generate_prefixed_uuid",
    "make_dataset_id",
    "make_record_id",
    "make_source_id",
]
