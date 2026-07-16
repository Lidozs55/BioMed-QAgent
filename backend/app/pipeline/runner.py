"""Deterministic Pipeline Runner state machine.

Executes the five fixed stages (Discovery → Acquisition → Processing →
Artifact Build → Validation) with append-only StageAttempt records, idempotent
recovery via digest matching, per-stage timeouts, and cancel support.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from app.domain.contracts import (
    AttemptStatus,
    ErrorCode,
    ErrorDetail,
    EventEnvelope,
    PlanReadyPayload,
    RunManifest,
    StageAttempt,
    StageCompletedPayload,
    StageFailedPayload,
    StageName,
    StageSkippedPayload,
    StageStartedPayload,
    TaskCancelledPayload,
    TaskCompletedPayload,
    TaskCreatedPayload,
    TaskFailedPayload,
    TaskRecoveredPayload,
    TaskState,
    build_event,
    generate_prefixed_uuid,
)
from app.pipeline.stages import (
    AcquisitionOutput,
    ArtifactBuildOutput,
    DiscoveryOutput,
    PipelineCancelledError,
    ProcessingOutput,
    StageContext,
    StageResult,
    ValidationOutput,
    publish_artifacts,
    run_acquisition,
    run_artifact_build,
    run_discovery,
    run_processing,
    run_validation,
)
from app.pipeline.state import (
    load_stage_output,
    load_state,
    save_stage_output,
    save_state,
)
from app.runtime.event_store import append_jsonl_records, read_jsonl
from app.tools.workdir import create_task_workdir

DEFAULT_STAGE_TIMEOUTS: dict[StageName, float] = {
    StageName.DISCOVERY: 30.0,
    StageName.ACQUISITION: 60.0,
    StageName.PROCESSING: 120.0,
    StageName.ARTIFACT_BUILD: 60.0,
    StageName.VALIDATION: 60.0,
}
TOTAL_TIMEOUT: float = 300.0


class CancellationToken(Protocol):
    def is_set(self) -> bool: ...

_STAGES: list[StageName] = [
    StageName.DISCOVERY,
    StageName.ACQUISITION,
    StageName.PROCESSING,
    StageName.ARTIFACT_BUILD,
    StageName.VALIDATION,
]

# Direct upstream stages per stage — used for input_digest computation.
# Only direct upstream digests are included so that the digest is stable
# across recovery runs regardless of the global completed_stages state.
_STAGE_UPSTREAM: dict[StageName, list[StageName]] = {
    StageName.DISCOVERY: [],
    StageName.ACQUISITION: [StageName.DISCOVERY],
    StageName.PROCESSING: [StageName.DISCOVERY, StageName.ACQUISITION],
    StageName.ARTIFACT_BUILD: [
        StageName.DISCOVERY,
        StageName.ACQUISITION,
        StageName.PROCESSING,
    ],
    StageName.VALIDATION: [StageName.ARTIFACT_BUILD],
}


class PipelineRunner:
    """Stateful pipeline runner with idempotent recovery and cancel support."""

    def __init__(
        self,
        task_id: str,
        base_dir: Path,
        fixture_dir: Path,
        topic: str = "breast cancer gene expression under Hsp70 inhibition",
        stage_timeouts: dict[StageName, float] | None = None,
        total_timeout: float = TOTAL_TIMEOUT,
        cancellation_requested: CancellationToken | None = None,
        defer_publication: bool = False,
        event_sink: Callable[[EventEnvelope], None] | None = None,
    ) -> None:
        self.task_id = task_id
        self.fixture_dir = fixture_dir
        self.topic = topic
        self.stage_timeouts = stage_timeouts or dict(DEFAULT_STAGE_TIMEOUTS)
        self.total_timeout = total_timeout
        self.cancellation_requested = cancellation_requested
        self.defer_publication = defer_publication
        self.event_sink = event_sink
        self.workdir = create_task_workdir(task_id, base_dir=str(base_dir))
        self.started_at = datetime.now(UTC)
        self.state = load_state(self.workdir.state, task_id, self.started_at)
        self.ctx = StageContext(
            task_id=task_id,
            workdir=self.workdir,
            fixture_dir=fixture_dir,
            topic=topic,
            started_at=self.state.started_at,
            cancellation_requested=self._is_cancelled,
        )
        self.events: list[EventEnvelope] = []
        self._persisted_attempt_count = self._load_persisted_attempt_count()
        self._persisted_event_count = 0
        self._sequence = self._next_event_sequence()
        self._pending_publication: Path | None = None

    def _load_persisted_attempt_count(self) -> int:
        """Validate the append-only attempt prefix and detect crash gaps."""

        path = self.workdir.logs / "stage_attempts.jsonl"
        records = read_jsonl(path).records
        if len(records) > len(self.state.stage_attempts):
            raise ValueError("pipeline attempt log is ahead of durable state")
        for index, (_, value) in enumerate(records):
            persisted = StageAttempt.model_validate(value)
            if persisted != self.state.stage_attempts[index]:
                raise ValueError("pipeline attempt log is not a durable state prefix")
        return len(records)

    def publish(self, run_id: str) -> None:
        """Atomically publish a validated managed-Run package and commit marker."""

        if not run_id or run_id in {".", ".."} or Path(run_id).name != run_id:
            raise ValueError("run_id must be a single path-safe component")
        staging = self._pending_publication
        if staging is None or not staging.is_dir():
            raise RuntimeError("pipeline has no validated package awaiting publication")
        self.ctx.check_cancelled()
        manifest_path = staging / "run_manifest.json"
        manifest_bytes = manifest_path.read_bytes()
        marker = {
            "schema_version": 1,
            "task_id": self.task_id,
            "run_id": run_id,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }
        (staging / ".runtime-publication.json").write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True) + "\n",
            "utf-8",
        )
        self.ctx.check_cancelled()
        publish_artifacts(staging, self.workdir.artifacts, self.ctx)
        self._pending_publication = None

    def _next_event_sequence(self) -> int:
        """Continue the task-local v1 audit sequence across recovery Runs."""

        events_path = self.workdir.logs / "events.jsonl"
        records = read_jsonl(events_path).records
        expected_sequence = 1
        for _, value in records:
            event = EventEnvelope.model_validate(value)
            if event.task_id != self.task_id or event.sequence != expected_sequence:
                raise ValueError("pipeline event log is not a contiguous task audit log")
            expected_sequence += 1
        return expected_sequence

    async def run(self) -> RunManifest:
        """Execute the pipeline, guaranteeing a terminal task state."""
        try:
            return await asyncio.wait_for(self._run_inner(), self.total_timeout)
        except PipelineCancelledError:
            return self._finalize_cancelled()
        except TimeoutError:
            return self._finalize_failed(
                TimeoutError(f"total pipeline timeout ({self.total_timeout}s) exceeded"),
                ErrorCode.TIMEOUT,
            )
        except Exception as exc:
            return self._finalize_failed(exc, ErrorCode.INTERNAL_ERROR)

    def request_cancel(self, reason: str | None = None) -> None:
        """Request cancellation; checked before each stage."""
        self.state.cancel_requested = True
        self.state.cancel_reason = reason
        save_state(self.workdir.state, self.state)

    def _is_cancelled(self) -> bool:
        return self.state.cancel_requested or (
            self.cancellation_requested is not None
            and self.cancellation_requested.is_set()
        )

    async def _run_inner(self) -> RunManifest:
        # A run is "recovered" when prior progress exists (completed_stages
        # non-empty) and the task is not in the fresh CREATED state. This
        # covers COMPLETED (re-run → all SKIPPED), FAILED (retry → prior
        # stages SKIPPED, failed stage re-executed), and intermediate states
        # after a process restart.
        is_recovered = (
            self.state.task_state is not TaskState.CREATED
            and bool(self.state.completed_stages)
        )
        if is_recovered:
            self._emit_event(
                TaskRecoveredPayload(
                    recovered_from_sequence=self._sequence - 1
                )
            )
        else:
            self._emit_event(TaskCreatedPayload(topic=self.topic))
            specification = _build_specification_for_plan(self.ctx)
            self._emit_event(PlanReadyPayload(specification=specification))

        stage_outputs: dict[StageName, Any] = {}
        for stage in _STAGES:
            if self._is_cancelled():
                return self._finalize_cancelled()

            input_digest = self._compute_input_digest(stage, stage_outputs)
            parameter_digest = self._compute_parameter_digest(stage)
            attempt_number = self.state.next_attempt_number(stage)

            reusable = self.state.find_reusable(stage, input_digest, parameter_digest)
            if reusable is not None and reusable.output_digest is not None:
                loaded = load_stage_output(
                    self.workdir.state,
                    stage,
                    reusable.output_digest,
                )
                if loaded is not None:
                    stage_outputs[stage] = loaded
                    skipped_attempt = self._build_attempt(
                        stage, input_digest, parameter_digest,
                        AttemptStatus.SKIPPED,
                        attempt_number,
                        output_digest=reusable.output_digest,
                    )
                    self.state.append_attempt(skipped_attempt)
                    self._emit_stage_event(
                        StageSkippedPayload(
                            stage=stage,
                            status=AttemptStatus.SKIPPED,
                            reason="digest matched existing successful attempt",
                            reused_stage_attempt_id=reusable.stage_attempt_id,
                        ),
                        stage_attempt_id=skipped_attempt.stage_attempt_id,
                    )
                    save_state(self.workdir.state, self.state)
                    continue

            stage_attempt_id = generate_prefixed_uuid("stage_attempt")
            started = datetime.now(UTC)
            self._emit_stage_event(
                StageStartedPayload(stage=stage, attempt=attempt_number),
                stage_attempt_id=stage_attempt_id,
            )

            try:
                result = await self._run_stage(
                    stage,
                    stage_outputs,
                    stage_attempt_id,
                    self.stage_timeouts[stage],
                )
            except TimeoutError:
                return self._finalize_stage_failed(
                    stage,
                    stage_attempt_id,
                    attempt_number,
                    input_digest,
                    parameter_digest,
                    started,
                    TimeoutError(f"stage {stage.value} timeout exceeded"),
                    ErrorCode.TIMEOUT,
                )
            except PipelineCancelledError:
                return self._finalize_cancelled()
            except Exception as exc:
                return self._finalize_stage_failed(
                    stage,
                    stage_attempt_id,
                    attempt_number,
                    input_digest,
                    parameter_digest,
                    started,
                    exc,
                    ErrorCode.INTERNAL_ERROR,
                )

            finished = datetime.now(UTC)
            attempt = self._build_attempt(
                stage, input_digest, parameter_digest,
                AttemptStatus.SUCCEEDED,
                attempt_number,
                output_digest=result.output_digest,
                stage_attempt_id=stage_attempt_id, started=started, finished=finished,
            )
            self.state.append_attempt(attempt)
            self.state.mark_completed(stage, result.output_digest)
            self.state.current_stage = stage
            save_state(self.workdir.state, self.state)
            save_stage_output(
                self.workdir.state,
                stage,
                result.output,
                result.output_digest,
            )

            stage_outputs[stage] = result.output
            self._emit_stage_event(
                StageCompletedPayload(
                    stage=stage,
                    status=AttemptStatus.SUCCEEDED,
                    output_digest=result.output_digest,
                ),
                stage_attempt_id=stage_attempt_id,
            )
            save_state(self.workdir.state, self.state)

        return self._finalize_completed(stage_outputs)

    async def _run_stage(
        self,
        stage: StageName,
        stage_outputs: dict[StageName, Any],
        stage_attempt_id: str,
        timeout: float,
    ) -> StageResult:
        """Run sync stage work while draining threads before terminalization."""

        worker = asyncio.create_task(
            asyncio.to_thread(
                self._execute_stage,
                stage,
                stage_outputs,
                stage_attempt_id,
            )
        )
        try:
            return await asyncio.wait_for(asyncio.shield(worker), timeout)
        except TimeoutError as timeout_error:
            with suppress(BaseException):
                await asyncio.shield(worker)
            raise timeout_error
        except asyncio.CancelledError:
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not worker.cancelled():
                worker.exception()
            raise

    def _execute_stage(
        self,
        stage: StageName,
        stage_outputs: dict[StageName, Any],
        stage_attempt_id: str,
    ) -> StageResult:
        """Dispatch to the appropriate stage function with upstream outputs."""
        self.ctx.check_cancelled()
        if stage is StageName.DISCOVERY:
            return run_discovery(self.ctx)
        if stage is StageName.ACQUISITION:
            discovery = self._get_output(stage_outputs, StageName.DISCOVERY, DiscoveryOutput)
            return run_acquisition(self.ctx, discovery.retrieved_at)
        if stage is StageName.PROCESSING:
            discovery = self._get_output(stage_outputs, StageName.DISCOVERY, DiscoveryOutput)
            acquisition = self._get_output(stage_outputs, StageName.ACQUISITION, AcquisitionOutput)
            return run_processing(
                self.ctx, acquisition.source_assets[0], discovery.dataset_id,
            )
        if stage is StageName.ARTIFACT_BUILD:
            discovery = self._get_output(stage_outputs, StageName.DISCOVERY, DiscoveryOutput)
            acquisition = self._get_output(stage_outputs, StageName.ACQUISITION, AcquisitionOutput)
            processing = self._get_output(stage_outputs, StageName.PROCESSING, ProcessingOutput)
            return run_artifact_build(
                self.ctx,
                sources=discovery.sources,
                source_assets=acquisition.source_assets,
                download_attempts=acquisition.download_attempts,
                parsed_dataset_relative_path=processing.parsed_datasets[0].file_asset.relative_path,
                parsed_row_count=processing.parsed_datasets[0].row_count,
                samples=processing.samples,
                literature=discovery.literature,
                geo=discovery.geo,
                specification=discovery.specification,
                retrieved_at=acquisition.retrieved_at,
                stage_attempt_id=stage_attempt_id,
            )
        if stage is StageName.VALIDATION:
            build = self._get_output(stage_outputs, StageName.ARTIFACT_BUILD, ArtifactBuildOutput)
            result = run_validation(
                self.ctx, build, self.state.stage_attempts, stage_attempt_id,
                publish=not self.defer_publication,
            )
            if self.defer_publication:
                self._pending_publication = build.staging_dir
            return result
        raise ValueError(f"unknown stage: {stage}")

    def _get_output(
        self,
        stage_outputs: dict[StageName, Any],
        stage: StageName,
        expected_type: type,
    ) -> Any:
        """Get a stage output, reconstructing from persisted dict if needed."""
        output = stage_outputs.get(stage)
        if output is None:
            expected_output_digest = self.state.completed_stages.get(stage.value)
            if expected_output_digest is None:
                raise RuntimeError(f"missing output digest for stage {stage.value}")
            loaded = load_stage_output(
                self.workdir.state,
                stage,
                expected_output_digest,
            )
            if loaded is None:
                raise RuntimeError(f"missing output for stage {stage.value}")
            output = expected_type.model_validate(loaded)
            stage_outputs[stage] = output
            return output
        if isinstance(output, dict):
            output = expected_type.model_validate(output)
            stage_outputs[stage] = output
        return output

    def _compute_input_digest(
        self, stage: StageName, stage_outputs: dict[StageName, Any]
    ) -> str:
        """Compute input digest from task_id, stage, and direct upstream digests.

        Only direct upstream stage digests are included (not the full
        completed_stages map) so the digest is stable across recovery runs.
        """
        upstream: dict[str, str] = {}
        for upstream_stage in _STAGE_UPSTREAM.get(stage, []):
            digest = self.state.completed_stages.get(upstream_stage.value)
            if digest is not None:
                upstream[upstream_stage.value] = digest
        payload = {"task_id": self.task_id, "stage": stage.value, "upstream": upstream}
        return _sha256_json(payload)

    def _compute_parameter_digest(self, stage: StageName) -> str:
        """Compute parameter digest from stage, fixture content hash, and topic.

        Uses the combined SHA-256 of all files under ``fixture_dir`` (sorted
        by name) rather than the directory mtime — directory mtime is unstable
        across filesystems and does not change when file contents change but
        filenames stay the same.
        """
        fixture_hash = _hash_directory(self.fixture_dir)
        payload = {
            "stage": stage.value,
            "fixture_dir": str(self.fixture_dir),
            "fixture_hash": fixture_hash,
            "topic": self.topic,
        }
        return _sha256_json(payload)

    def _build_attempt(
        self,
        stage: StageName,
        input_digest: str,
        parameter_digest: str,
        status: AttemptStatus,
        attempt_number: int,
        output_digest: str | None = None,
        stage_attempt_id: str | None = None,
        started: datetime | None = None,
        finished: datetime | None = None,
        error: ErrorDetail | None = None,
    ) -> StageAttempt:
        return StageAttempt(
            stage_attempt_id=stage_attempt_id or generate_prefixed_uuid("stage_attempt"),
            task_id=self.task_id,
            stage=stage,
            attempt=attempt_number,
            input_digest=input_digest,
            parameter_digest=parameter_digest,
            output_digest=output_digest,
            status=status,
            started_at=started,
            finished_at=finished,
            error=error,
        )

    def _emit_event(self, payload: Any) -> None:
        event = build_event(
            task_id=self.task_id,
            sequence=self._sequence,
            payload=payload,
        )
        self._record_event(event)

    def _emit_stage_event(self, payload: Any, stage_attempt_id: str) -> None:
        event = build_event(
            task_id=self.task_id,
            sequence=self._sequence,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
        )
        self._record_event(event)

    def _record_event(self, event: EventEnvelope) -> None:
        """Persist a v1 audit event before making it observable to consumers."""

        append_jsonl_records(
            self.workdir.logs / "events.jsonl",
            [event.model_dump(mode="json")],
        )
        self.events.append(event)
        self._persisted_event_count += 1
        self._sequence += 1
        if self.event_sink is not None:
            self.event_sink(event)

    def _finalize_stage_failed(
        self,
        stage: StageName,
        stage_attempt_id: str,
        attempt_number: int,
        input_digest: str,
        parameter_digest: str,
        started: datetime,
        exc: Exception,
        error_code: ErrorCode,
    ) -> RunManifest:
        finished = datetime.now(UTC)
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code is ErrorCode.TIMEOUT,
            stage=stage,
        )
        attempt = self._build_attempt(
            stage, input_digest, parameter_digest,
            AttemptStatus.FAILED,
            attempt_number,
            stage_attempt_id=stage_attempt_id,
            started=started, finished=finished, error=error,
        )
        self.state.append_attempt(attempt)
        self._emit_stage_event(
            StageFailedPayload(stage=stage, status=AttemptStatus.FAILED, error=error),
            stage_attempt_id=stage_attempt_id,
        )
        # _persist_logs is called once by _finalize_failed; no duplicate call here.
        return self._finalize_failed(exc, error_code)

    def _finalize_failed(
        self, exc: Exception, error_code: ErrorCode = ErrorCode.INTERNAL_ERROR
    ) -> RunManifest:
        self.state.task_state = TaskState.FAILED
        save_state(self.workdir.state, self.state)
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code is ErrorCode.TIMEOUT,
        )
        self._emit_event(TaskFailedPayload(error=error))
        self._persist_logs()
        return _build_failed_manifest(self.task_id, self.started_at, error, self.topic)

    def _finalize_cancelled(self) -> RunManifest:
        self.state.task_state = TaskState.CANCELLED
        save_state(self.workdir.state, self.state)
        self._emit_event(
            TaskCancelledPayload(reason=self.state.cancel_reason or "cancel requested")
        )
        self._persist_logs()
        return _build_cancelled_manifest(self.task_id, self.started_at, self.topic)

    def _finalize_completed(
        self, stage_outputs: dict[StageName, Any]
    ) -> RunManifest:
        validation_output = self._get_output(
            stage_outputs, StageName.VALIDATION, ValidationOutput
        )
        manifest = validation_output.manifest

        for entry in manifest.artifacts:
            self._emit_event_with_payload(
                _artifact_produced_payload(entry)
            )
        self._emit_event(TaskCompletedPayload(validation=manifest.validation))

        self.state.task_state = TaskState.COMPLETED
        save_state(self.workdir.state, self.state)
        self._persist_logs()
        return manifest

    def _emit_event_with_payload(self, payload: Any) -> None:
        self._emit_event(payload)

    def _persist_logs(self) -> None:
        """Durably append only this invocation's attempts and audit events."""
        self.workdir.logs.mkdir(parents=True, exist_ok=True)
        attempts_file = self.workdir.logs / "stage_attempts.jsonl"
        new_attempts = self.state.stage_attempts[self._persisted_attempt_count :]
        append_jsonl_records(
            attempts_file,
            [attempt.model_dump(mode="json") for attempt in new_attempts],
        )
        self._persisted_attempt_count += len(new_attempts)


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _hash_directory(directory: Path) -> str:
    """Compute a stable SHA-256 over all files in ``directory`` (sorted by name).

    Combines each file's relative path and content hash, so any content change
    produces a different digest regardless of filesystem mtime behavior.
    """
    hasher = hashlib.sha256()
    for path in sorted(directory.iterdir(), key=lambda p: p.name):
        if path.is_file():
            rel = path.relative_to(directory).as_posix()
            file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            hasher.update(rel.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(file_hash.encode("utf-8"))
            hasher.update(b"\0")
    return hasher.hexdigest()


def _build_specification_for_plan(ctx: StageContext) -> Any:
    """Build a TaskSpecification for the plan_ready event (reuses discovery logic)."""
    from app.domain.contracts import (
        Database,
        DatasetSelection,
        QuerySpecification,
        RequestedOutput,
        TaskSpecification,
    )
    return TaskSpecification(
        topic=ctx.topic,
        queries=[
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query="GSE178352[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            ),
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query="34180400[PMID]",
                generated_by="pipeline",
                purpose="pinned literature",
                order=2,
            ),
        ],
        datasets=[
            DatasetSelection(
                dataset_id="ds_geo_gse178352",
                database=Database.GEO,
                accession="GSE178352",
                source_id="src_placeholder",
                reason="linked from PMID 34180400",
            )
        ],
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )


def _artifact_produced_payload(entry: Any) -> Any:
    from app.domain.contracts import ArtifactProducedPayload
    return ArtifactProducedPayload(artifact=entry)


def _build_failed_manifest(
    task_id: str, started_at: datetime, error: ErrorDetail, topic: str
) -> RunManifest:
    """Build a minimal RunManifest for a failed task."""
    from app.domain.contracts import TaskRequest, TaskSpecification, ValidationSummary
    return RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=topic),
        specification=TaskSpecification(topic=topic, queries=[], datasets=[], requested_outputs=[]),
        task_state=TaskState.FAILED,
        stage_attempt_ids=[],
        source_ids=[],
        artifacts=[],
        validation=ValidationSummary(
            status="invalid",
            checked_count=1,
            failed_count=1,
            report_path="logs/validation_report.json",
        ),
        pipeline_version="0.1.0",
        started_at=started_at,
        finished_at=datetime.now(UTC),
    )


def _build_cancelled_manifest(
    task_id: str, started_at: datetime, topic: str
) -> RunManifest:
    """Build a minimal RunManifest for a cancelled task."""
    from app.domain.contracts import TaskRequest, TaskSpecification, ValidationSummary
    return RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=topic),
        specification=TaskSpecification(topic=topic, queries=[], datasets=[], requested_outputs=[]),
        task_state=TaskState.CANCELLED,
        stage_attempt_ids=[],
        source_ids=[],
        artifacts=[],
        validation=ValidationSummary(
            status="valid",
            checked_count=0,
            failed_count=0,
            report_path="logs/validation_report.json",
        ),
        pipeline_version="0.1.0",
        started_at=started_at,
        finished_at=datetime.now(UTC),
    )
