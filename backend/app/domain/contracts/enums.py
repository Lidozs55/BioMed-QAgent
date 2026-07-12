"""Stable wire enums used by deterministic pipeline contracts."""

from __future__ import annotations

from enum import StrEnum


class Database(StrEnum):
    PUBMED = "pubmed"
    GEO = "geo"
    GDC = "gdc"
    UCSC_XENA = "ucsc_xena"
    PDB = "pdb"


class DataLevel(StrEnum):
    RAW_SEQUENCE = "raw_sequence"
    SUBMITTER_PROCESSED = "submitter_processed"
    REPOSITORY_PROCESSED = "repository_processed"
    METADATA = "metadata"


class RequestedOutput(StrEnum):
    MAIN_DATA = "main_data"
    LITERATURE = "literature"
    DATASET_CATALOG = "dataset_catalog"
    SAMPLE_METADATA = "sample_metadata"


class TaskState(StrEnum):
    CREATED = "created"
    PLANNING = "planning"
    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    BUILDING_ARTIFACTS = "building_artifacts"
    VALIDATING = "validating"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StageName(StrEnum):
    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    ARTIFACT_BUILD = "artifact_build"
    VALIDATION = "validation"


class AttemptStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class DownloadStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WarningSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class ErrorCode(StrEnum):
    CONFIGURATION_ERROR = "configuration_error"
    NETWORK_ERROR = "network_error"
    TIMEOUT = "timeout"
    DOWNLOAD_INCOMPLETE = "download_incomplete"
    CHECKSUM_MISMATCH = "checksum_mismatch"
    PARSE_ERROR = "parse_error"
    VALIDATION_ERROR = "validation_error"
    CANCELLED = "cancelled"
    INTERNAL_ERROR = "internal_error"
