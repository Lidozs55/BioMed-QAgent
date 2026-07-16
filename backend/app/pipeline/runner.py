"""Deterministic Pipeline Runner state machine.

Executes the five fixed stages (Discovery → Acquisition → Processing →
Artifact Build → Validation) with append-only StageAttempt records, idempotent
recovery via digest matching, per-stage timeouts, and cancel support.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.contracts import (
    AttemptStatus,
    CancelRequestedPayload,
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
    ToolCalledPayload,
    ToolCompletedPayload,
    WarningPayload,
    WarningRecord,
    WarningSeverity,
    build_event,
    generate_prefixed_uuid,
)
from app.pipeline.stages import (
    AcquisitionOutput,
    ArtifactBuildOutput,
    DiscoveryOutput,
    ProcessingOutput,
    StageContext,
    StageResult,
    ValidationOutput,
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
from app.tools.workdir import create_task_workdir

DEFAULT_STAGE_TIMEOUTS: dict[StageName, float] = {
    StageName.DISCOVERY: 30.0,
    StageName.ACQUISITION: 60.0,
    StageName.PROCESSING: 120.0,
    StageName.ARTIFACT_BUILD: 60.0,
    StageName.VALIDATION: 60.0,
}
TOTAL_TIMEOUT: float = 300.0

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
    ) -> None:
        self.task_id = task_id
        self.fixture_dir = fixture_dir
        self.topic = topic
        self.stage_timeouts = stage_timeouts or dict(DEFAULT_STAGE_TIMEOUTS)
        self.total_timeout = total_timeout
        self.workdir = create_task_workdir(task_id, base_dir=str(base_dir))
        self.started_at = datetime.now(UTC)
        self.state = load_state(self.workdir.state, task_id, self.started_at)
        self.ctx = StageContext(
            task_id=task_id,
            workdir=self.workdir,
            fixture_dir=fixture_dir,
            topic=topic,
            started_at=self.state.started_at,
        )
        self.events: list[EventEnvelope] = []
        # Sequence is task-local and monotonically increasing across recovery
        # runs. On init, resume from the highest sequence already persisted to
        # events.jsonl so that replay-by-sequence remains unambiguous.
        self._events_file: Path = self.workdir.logs / "events.jsonl"
        self._sequence: int = self._load_last_sequence() + 1
        # Optional async queue for streaming events to WS consumers. When set,
        # each emitted event is persisted to events.jsonl THEN pushed here.
        # The sentinel ``None`` signals stream completion to subscribers.
        self._event_queue: asyncio.Queue[EventEnvelope | None] | None = None

    def _load_last_sequence(self) -> int:
        """Return the highest sequence number in the existing events.jsonl.

        Returns 0 if the file does not exist or is empty, so the next event
        gets sequence 1 on a fresh run.
        """
        if not self._events_file.is_file():
            return 0
        max_seq = 0
        for line in self._events_file.read_text("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                seq = json.loads(line).get("sequence", 0)
            except json.JSONDecodeError:
                continue
            if isinstance(seq, int) and seq > max_seq:
                max_seq = seq
        return max_seq

    async def run(self) -> RunManifest:
        """Execute the pipeline, guaranteeing a terminal task state."""
        try:
            return await asyncio.wait_for(self._run_inner(), self.total_timeout)
        except TimeoutError:
            return self._finalize_failed(
                TimeoutError(f"total pipeline timeout ({self.total_timeout}s) exceeded"),
                ErrorCode.TIMEOUT,
            )
        except Exception as exc:
            return self._finalize_failed(exc, ErrorCode.INTERNAL_ERROR)

    async def run_streamed(self) -> AsyncIterator[EventEnvelope]:
        """Execute the pipeline, yielding each EventEnvelope as it is emitted.

        Persists every event to events.jsonl before yielding (persist-then-push)
        so a WS disconnect can resume via ``GET /tasks/{task_id}/events?since=N``.
        After the generator is exhausted, ``self.manifest`` holds the terminal
        RunManifest (or None if the run has not reached a terminal state).
        """
        if self._event_queue is not None:
            raise RuntimeError("run_streamed() cannot be called concurrently")
        self._event_queue = asyncio.Queue()
        self.manifest: RunManifest | None = None

        async def _drive() -> None:
            try:
                self.manifest = await self.run()
            finally:
                self._event_queue.put_nowait(None)

        driver = asyncio.create_task(_drive())
        try:
            while True:
                event = await self._event_queue.get()
                if event is None:
                    break
                yield event
        finally:
            await driver
            self._event_queue = None

    def request_cancel(self, reason: str | None = None) -> None:
        """Request cancellation; checked before each stage.

        Emits a ``task_cancel_requested`` event (persisted + pushed) so WS
        clients see the request immediately, then sets the in-memory and
        persisted state flag checked by ``_run_inner`` before each stage.
        """
        self._emit_event(CancelRequestedPayload(reason=reason))
        self.state.cancel_requested = True
        self.state.cancel_reason = reason
        save_state(self.workdir.state, self.state)

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
            if self.state.cancel_requested:
                return self._finalize_cancelled()

            input_digest = self._compute_input_digest(stage, stage_outputs)
            parameter_digest = self._compute_parameter_digest(stage)

            reusable = self.state.find_reusable(stage, input_digest, parameter_digest)
            if reusable is not None and reusable.output_digest is not None:
                loaded = load_stage_output(self.workdir.state, stage)
                if loaded is not None:
                    stage_outputs[stage] = loaded
                    skipped_attempt = self._build_attempt(
                        stage, input_digest, parameter_digest,
                        AttemptStatus.SKIPPED, output_digest=reusable.output_digest,
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
                StageStartedPayload(stage=stage, attempt=1),
                stage_attempt_id=stage_attempt_id,
            )
            self._emit_stage_event(
                ToolCalledPayload(
                    tool_name=f"run_{stage.value}",
                    arguments_digest=parameter_digest,
                ),
                stage_attempt_id=stage_attempt_id,
            )

            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._execute_stage, stage, stage_outputs, stage_attempt_id
                    ),
                    self.stage_timeouts[stage],
                )
            except TimeoutError:
                return self._finalize_stage_failed(
                    stage, stage_attempt_id, input_digest, parameter_digest, started,
                    TimeoutError(f"stage {stage.value} timeout exceeded"),
                    ErrorCode.TIMEOUT,
                )
            except Exception as exc:
                return self._finalize_stage_failed(
                    stage, stage_attempt_id, input_digest, parameter_digest, started,
                    exc, ErrorCode.INTERNAL_ERROR,
                )

            self._emit_stage_event(
                ToolCompletedPayload(
                    tool_name=f"run_{stage.value}",
                    output_digest=result.output_digest,
                ),
                stage_attempt_id=stage_attempt_id,
            )

            finished = datetime.now(UTC)
            attempt = self._build_attempt(
                stage, input_digest, parameter_digest,
                AttemptStatus.SUCCEEDED, output_digest=result.output_digest,
                stage_attempt_id=stage_attempt_id, started=started, finished=finished,
            )
            self.state.append_attempt(attempt)
            self.state.mark_completed(stage, result.output_digest)
            self.state.current_stage = stage
            save_state(self.workdir.state, self.state)
            save_stage_output(self.workdir.state, stage, result.output)

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

            if stage is StageName.ARTIFACT_BUILD:
                self._emit_warning_events(stage_outputs, stage_attempt_id)

        return self._finalize_completed(stage_outputs)

    def _emit_warning_events(
        self,
        stage_outputs: dict[StageName, Any],
        stage_attempt_id: str,
    ) -> None:
        """Emit WarningPayload events for each row in warnings.csv.

        Called after the artifact_build stage writes the staging package.
        In fixture mode, warnings.csv is empty, so no events are emitted.
        """
        build_output = stage_outputs.get(StageName.ARTIFACT_BUILD)
        if build_output is None:
            return
        staging_dir = getattr(build_output, "staging_dir", None)
        if staging_dir is None:
            return
        warnings_csv = Path(staging_dir) / "warnings.csv"
        if not warnings_csv.is_file():
            return
        with warnings_csv.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                try:
                    warning = WarningRecord(
                        warning_id=row["warning_id"],
                        severity=WarningSeverity(row["severity"]),
                        stage=StageName(row["stage"]),
                        code=row["code"],
                        message=row["message"],
                        source_id=row.get("source_id") or None,
                        asset_id=row.get("asset_id") or None,
                        record_id=row.get("record_id") or None,
                        created_at=datetime.fromisoformat(row["created_at"]),
                    )
                except (KeyError, ValueError):
                    continue
                self._emit_stage_event(
                    WarningPayload(warning=warning),
                    stage_attempt_id=stage_attempt_id,
                )

    def _execute_stage(
        self,
        stage: StageName,
        stage_outputs: dict[StageName, Any],
        stage_attempt_id: str,
    ) -> StageResult:
        """Dispatch to the appropriate stage function with upstream outputs."""
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
            return run_validation(
                self.ctx, build, self.state.stage_attempts, stage_attempt_id,
            )
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
            loaded = load_stage_output(self.workdir.state, stage)
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
            attempt=1,
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
        self.events.append(event)
        self._sequence += 1
        self._persist_event(event)

    def _emit_stage_event(self, payload: Any, stage_attempt_id: str) -> None:
        event = build_event(
            task_id=self.task_id,
            sequence=self._sequence,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
        )
        self.events.append(event)
        self._sequence += 1
        self._persist_event(event)

    def _persist_event(self, event: EventEnvelope) -> None:
        """Persist-then-push: append the event to events.jsonl before any push.

        This satisfies §11 line 340 (事件先持久化再推送) so that a crash after
        persist but before push never loses an event, and a WS reconnect can
        resume by reading events.jsonl from the last seen sequence.
        """
        self._events_file.parent.mkdir(parents=True, exist_ok=True)
        with self._events_file.open("a", encoding="utf-8") as handle:
            handle.write(event.model_dump_json() + "\n")
        if self._event_queue is not None:
            self._event_queue.put_nowait(event)

    def _finalize_stage_failed(
        self,
        stage: StageName,
        stage_attempt_id: str,
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
            AttemptStatus.FAILED, stage_attempt_id=stage_attempt_id,
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
        """Write stage_attempts.jsonl to logs/.

        events.jsonl is now appended per-event by ``_persist_event`` so that
        the persist-then-push invariant holds and recovery runs do not
        overwrite prior events.
        """
        self.workdir.logs.mkdir(parents=True, exist_ok=True)
        attempts_file = self.workdir.logs / "stage_attempts.jsonl"
        attempts_file.write_text(
            "".join(a.model_dump_json() + "\n" for a in self.state.stage_attempts),
            "utf-8",
        )


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
