"""Base types for pipeline stages: context, result, and per-stage output models."""
from __future__ import annotations

import asyncio
import csv
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
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
    StageName,
    TaskSpecification,
    ValidationSummary,
)
from app.domain.contracts.discovery import GeoSeriesRecord
from app.model_config import RunModelSettings
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.tools.workdir import TaskWorkDir

STANDALONE_RUN_ID = "run_standalone"


def write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    """Write a CSV with a UTF-8 BOM and strict column keys.

    utf-8-sig writes a BOM so Excel opens UTF-8 CSVs without garbling
    Chinese characters (TODO §1.7). extrasaction="raise" surfaces typo'd
    row keys instead of silently dropping them (TODO §1.7).
    """
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="raise")
        writer.writeheader()
        writer.writerows(rows)


# Progress emitter signature: (stage, kind, current, total, detail).
# PipelineRunner installs one before running stages; in fixture mode without
# a sink the emitter is None and emit_progress is a no-op.
# See docs/REVIEW_2026-07-18.md §4.
StageProgressEmitter = Callable[
    [StageName, str, int, int | None, dict[str, object]],
    Awaitable[None],
]
DownloadAttemptRecorder = Callable[[DownloadAttempt], None]


class PipelineCancelledError(RuntimeError):
    """Raised when cooperative cancellation reaches a stage boundary."""


class DownloadError(RuntimeError):
    """Raised when all download candidates fail in the acquisition stage.

    The pipeline runner maps this to ``ErrorCode.NETWORK_ERROR`` with
    ``retryable=True`` so the Agent can retry with an alternative accession
    or request human-in-the-loop guidance, instead of treating it as an
    unrecoverable internal error (TODO §2.8 / RESEARCH_SYSTEM_REVIEW §9.2).
    """


@dataclass
class StageContext:
    """Immutable context shared by all stages in one pipeline run."""

    task_id: str
    workdir: TaskWorkDir
    fixture_dir: Path
    topic: str
    started_at: datetime
    run_id: str = STANDALONE_RUN_ID
    model_name: str = RunModelSettings.default().model_name
    mode: Literal["fixture", "live"] = "fixture"
    databases: list[str] = field(default_factory=list)
    specification: TaskSpecification | None = None
    cancellation_requested: Callable[[], bool] | None = None
    progress_emitter: StageProgressEmitter | None = None
    download_attempt_recorder: DownloadAttemptRecorder | None = None
    _event_loop: asyncio.AbstractEventLoop | None = field(
        default=None,
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        self.workdir.staging_run(self.run_id)

    def check_cancelled(self) -> None:
        if self.cancellation_requested is not None and self.cancellation_requested():
            raise PipelineCancelledError("pipeline was cancelled")

    def record_download_attempt(self, attempt: DownloadAttempt) -> None:
        """Durably hand off a completed URL attempt before stage completion."""

        if self.download_attempt_recorder is not None:
            self.download_attempt_recorder(attempt)

    def bind_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the main event loop for sync→async progress bridging.

        PipelineRunner calls this from ``_run_stage`` (async context) before
        dispatching sync stage work to a worker thread, so stages can call
        ``emit_progress_sync`` and reach the async emitter on the main loop.
        """

        self._event_loop = loop

    async def emit_progress(
        self,
        stage: StageName,
        kind: str,
        current: int,
        total: int | None = None,
        detail: dict[str, object] | None = None,
    ) -> None:
        """Forward a mid-stage progress event to the runner's event sink.

        No-op when no emitter is attached (fixture mode without sink).
        """

        emitter = self.progress_emitter
        if emitter is None:
            return
        await emitter(stage, kind, current, total, detail or {})

    def emit_progress_sync(
        self,
        stage: StageName,
        kind: str,
        current: int,
        total: int | None = None,
        detail: dict[str, object] | None = None,
    ) -> None:
        """Sync wrapper callable from sync stage functions running in a thread.

        Uses ``asyncio.run_coroutine_threadsafe`` to invoke the async emitter
        on the bound main loop. No-op when no emitter or no loop is bound
        (e.g. fixture mode without sink, or unit tests constructing
        StageContext directly). See docs/REVIEW_2026-07-18.md §4.
        """

        emitter = self.progress_emitter
        if emitter is None:
            return
        loop = self._event_loop
        if loop is None or not loop.is_running():
            return
        future = asyncio.run_coroutine_threadsafe(
            emitter(stage, kind, current, total, detail or {}),
            loop,
        )
        future.result(timeout=5.0)


@dataclass
class StageResult:
    """Wrapper for a stage execution result: digest + typed output."""

    output_digest: str
    output: Any


class DiscoveryOutput(ContractModel):
    """Output of the discovery stage: parsed fixture sources + specification."""

    sources: list[SourceRecord]
    literature: LiteratureRecord | None = None
    specification: TaskSpecification
    geo: GeoSeriesRecord | None = None
    pubmed_source_id: str | None = None
    geo_source_id: str | None = None
    dataset_source_id: str
    dataset_accession: str
    dataset_title: str
    dataset_url: str
    dataset_id: str
    retrieved_at: datetime


class AcquisitionOutput(ContractModel):
    """Output of the acquisition stage: downloaded source assets + attempts."""

    source_assets: list[SourceAsset]
    download_attempts: list[DownloadAttempt]
    source_path: Path
    retrieved_at: datetime


class CleaningReportModel(ContractModel):
    """Cleaning report produced during the processing stage.

    Mirrors ``app.domain.processing.CleaningReport`` but uses Pydantic
    and omits the dataclass dependency so the pipeline is self-contained.
    """

    missing_stats: dict[str, int] = {}
    duplicate_count: int = 0
    type_issues: dict[str, int] = {}
    format_corrections: dict[str, int] = {}
    anomaly_flags: list[str] = []
    total_anomalies: int = 0
    # REVIEW 2026-08-05 P0-1: 超过清洗行数上限被截断的行数（>0 表示数据不完整，
    # 必须通过 cleaning_report.csv 与 warnings.csv 对用户/Agent 可见）。
    truncated_rows: int = 0


class ProcessingOutput(ContractModel):
    """Output of the processing stage: parsed datasets + samples + cleaning + alignment.

    ``parsed_datasets`` carries one entry per parsed source asset. When two
    or more datasets are parsed in one run, ``merged_dataset`` holds the
    deterministic vertical merge produced by ``alignment.merge_datasets``
    (TODO §1.2) and ``field_alignment`` holds the real ``align_fields``
    mapping used to build it.
    """

    parsed_datasets: list[ParsedDataset]
    samples: list[GeoSampleMetadata]
    cleaning_report: CleaningReportModel | None = None
    field_alignment: dict[str, list[str]] | None = None
    merged_dataset: ParsedDataset | None = None


class ArtifactBuildOutput(ContractModel):
    """Output of the artifact builder: staging dir + artifact file paths."""

    staging_dir: Path
    artifact_paths: list[Path]
    source_assets: list[SourceAsset]
    source_path: Path
    literature: LiteratureRecord | None
    geo: GeoSeriesRecord | None
    specification: TaskSpecification
    sources: list[SourceRecord]
    parsed_datasets: list[ParsedDataset]
    samples: list[GeoSampleMetadata]
    download_attempts: list[DownloadAttempt]
    retrieved_at: datetime
    started_at: datetime
    dataset_source_id: str = ""
    dataset_accession: str = ""
    dataset_title: str = ""
    dataset_url: str = ""
    dataset_id: str = ""


class ValidationOutput(ContractModel):
    """Output of the validation stage: validation summary + published artifacts + manifest."""

    validation: ValidationSummary
    artifacts: list[ArtifactManifestEntry]
    manifest: RunManifest
