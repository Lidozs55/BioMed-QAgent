"""Base types for pipeline stages: context, result, and per-stage output models."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from app.domain.contracts import (
    ArtifactManifestEntry,
    ContractModel,
    DownloadAttempt,
    LiteratureRecord,
    ParsedDataset,
    RunManifest,
    SourceAsset,
    SourceRecord,
    TaskSpecification,
    ValidationSummary,
)
from app.domain.contracts.discovery import GeoSeriesRecord
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.tools.workdir import TaskWorkDir

STANDALONE_RUN_ID = "run_standalone"


class PipelineCancelledError(RuntimeError):
    """Raised when cooperative cancellation reaches a stage boundary."""


@dataclass
class StageContext:
    """Immutable context shared by all stages in one pipeline run."""

    task_id: str
    workdir: TaskWorkDir
    fixture_dir: Path
    topic: str
    started_at: datetime
    run_id: str = STANDALONE_RUN_ID
    mode: Literal["fixture", "live"] = "fixture"
    cancellation_requested: Callable[[], bool] | None = None

    def __post_init__(self) -> None:
        self.workdir.staging_run(self.run_id)

    def check_cancelled(self) -> None:
        if self.cancellation_requested is not None and self.cancellation_requested():
            raise PipelineCancelledError("pipeline was cancelled")


@dataclass
class StageResult:
    """Wrapper for a stage execution result: digest + typed output."""

    output_digest: str
    output: Any


class DiscoveryOutput(ContractModel):
    """Output of the discovery stage: parsed fixture sources + specification."""

    sources: list[SourceRecord]
    literature: LiteratureRecord
    geo: GeoSeriesRecord
    specification: TaskSpecification
    pubmed_source_id: str
    geo_source_id: str
    dataset_id: str
    retrieved_at: datetime


class AcquisitionOutput(ContractModel):
    """Output of the acquisition stage: downloaded source assets + attempts."""

    source_assets: list[SourceAsset]
    download_attempts: list[DownloadAttempt]
    source_path: Path
    retrieved_at: datetime


class ProcessingOutput(ContractModel):
    """Output of the processing stage: parsed datasets + samples."""

    parsed_datasets: list[ParsedDataset]
    samples: list[GeoSampleMetadata]


class ArtifactBuildOutput(ContractModel):
    """Output of the artifact builder: staging dir + artifact file paths."""

    staging_dir: Path
    artifact_paths: list[Path]
    source_assets: list[SourceAsset]
    source_path: Path
    literature: LiteratureRecord
    geo: GeoSeriesRecord
    specification: TaskSpecification
    sources: list[SourceRecord]
    parsed_datasets: list[ParsedDataset]
    samples: list[GeoSampleMetadata]
    download_attempts: list[DownloadAttempt]
    retrieved_at: datetime
    started_at: datetime


class ValidationOutput(ContractModel):
    """Output of the validation stage: validation summary + published artifacts + manifest."""

    validation: ValidationSummary
    artifacts: list[ArtifactManifestEntry]
    manifest: RunManifest
