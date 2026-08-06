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
import logging
import shutil
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol

from app.core.metrics import MetricsTracker
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    AttemptStatus,
    CancelRequestedPayload,
    DownloadAttempt,
    ErrorCode,
    ErrorDetail,
    EventEnvelope,
    PlanReadyPayload,
    RunManifest,
    StageAttempt,
    StageCompletedPayload,
    StageFailedPayload,
    StageName,
    StageProgressPayload,
    StageSkippedPayload,
    StageStartedPayload,
    TaskCancelledPayload,
    TaskCompletedPayload,
    TaskCreatedPayload,
    TaskFailedPayload,
    TaskRecoveredPayload,
    TaskSpecification,
    TaskState,
    ToolCalledPayload,
    ToolCompletedPayload,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    WarningPayload,
    WarningRecord,
    WarningSeverity,
    build_event,
    generate_prefixed_uuid,
)
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus
from app.model_config import RunModelSettings
from app.pipeline.stages import (
    STANDALONE_RUN_ID,
    AcquisitionOutput,
    ArtifactBuildOutput,
    DiscoveryOutput,
    DownloadError,
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
    DownloadAttemptAuditRecord,
    StageOutputFile,
    TaskLock,
    load_stage_output,
    load_state,
    save_stage_output,
    save_state,
)
from app.runtime.event_store import append_jsonl_records, read_jsonl
from app.tools.workdir import create_task_workdir

logger = logging.getLogger("app.pipeline")

# 人类可读摘要日志：与结构化 JSON 审计日志互补，仅覆盖关键事件
# （stage 开始/完成/失败、产物生成、任务完成/失败、警告），便于人类
# 和 LLM 直接阅读，无需逐条解析 JSON 事件。
_readable_logger = logging.getLogger("app.pipeline.readable")

DEFAULT_STAGE_TIMEOUTS: dict[StageName, float] = {
    StageName.DISCOVERY: 30.0,
    StageName.ACQUISITION: 60.0,
    StageName.PROCESSING: 120.0,
    StageName.ARTIFACT_BUILD: 60.0,
    StageName.VALIDATION: 60.0,
}
TOTAL_TIMEOUT: float = 300.0
USER_INPUT_TIMEOUT: float = 300.0


class CancellationToken(Protocol):
    def is_set(self) -> bool: ...


PipelineEventSink = Callable[[EventEnvelope], Awaitable[None]]


class PipelineEventSinkError(RuntimeError):
    """Raised when the runtime cannot durably accept a Pipeline event."""


class PipelinePlanRejectedError(RuntimeError):
    """Raised after a durable human rejection stops the Pipeline plan."""


class PipelineUserInputTimeoutError(RuntimeError):
    """Raised when an independently budgeted human-input request expires."""


@dataclass(frozen=True, slots=True)
class PendingPublication:
    """Validated Pipeline package awaiting manager-owned publication."""

    run_id: str
    manifest: RunManifest
    manifest_entry: ArtifactManifestEntry
    publish: Callable[[], None]
    abort: Callable[[], None]


@dataclass(frozen=True, slots=True)
class PendingPublicationCleanup:
    """Failed pre-transfer cleanup awaiting a manager-owned retry."""

    run_id: str
    abort: Callable[[], None]
    error: BaseException


_STAGES: list[StageName] = [
    StageName.DISCOVERY,
    StageName.ACQUISITION,
    StageName.PROCESSING,
    StageName.ARTIFACT_BUILD,
    StageName.VALIDATION,
]

_STAGE_OUTPUT_TYPES: dict[StageName, type] = {
    StageName.DISCOVERY: DiscoveryOutput,
    StageName.ACQUISITION: AcquisitionOutput,
    StageName.PROCESSING: ProcessingOutput,
    StageName.ARTIFACT_BUILD: ArtifactBuildOutput,
    StageName.VALIDATION: ValidationOutput,
}

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
        user_input_timeout: float = USER_INPUT_TIMEOUT,
        mode: Literal["fixture", "live"] = "fixture",
        databases: list[str] | None = None,
        specification: TaskSpecification | None = None,
        cancellation_requested: CancellationToken | None = None,
        defer_publication: bool = False,
        event_sink: PipelineEventSink | None = None,
        run_id: str = STANDALONE_RUN_ID,
        model_name: str = RunModelSettings.default().model_name,
        lock_timeout: float = 5.0,
    ) -> None:
        self.task_id = task_id
        self.fixture_dir = fixture_dir
        self.topic = topic
        self.databases = databases or ["pubmed", "geo"]
        self.specification = specification
        self.stage_timeouts = stage_timeouts or dict(DEFAULT_STAGE_TIMEOUTS)
        self.lock_timeout = lock_timeout
        self.total_timeout = total_timeout
        self.user_input_timeout = user_input_timeout
        self.mode = mode
        self.cancellation_requested = cancellation_requested
        self.defer_publication = defer_publication
        self._event_sink = event_sink
        self.model_name = model_name
        self.workdir = create_task_workdir(task_id, base_dir=str(base_dir))
        self.started_at = datetime.now(UTC)
        self.state = load_state(self.workdir.state, task_id, self.started_at)
        self.ctx = StageContext(
            task_id=task_id,
            workdir=self.workdir,
            fixture_dir=fixture_dir,
            topic=topic,
            started_at=self.state.started_at,
            run_id=run_id,
            model_name=model_name,
            mode=mode,
            databases=self.databases,
            specification=self.specification,
            cancellation_requested=self._is_cancelled,
            progress_emitter=self._emit_progress_event,
            download_attempt_recorder=self._record_download_attempt,
        )
        self.events: list[EventEnvelope] = []
        self._persisted_attempt_count = self._load_persisted_attempt_count()
        # TODO §1.7: MetricsTracker for per-stage timing and ablation export.
        self.metrics = MetricsTracker(task_id=task_id)
        # Sequence is task-local and monotonically increasing within a single
        # PipelineRunner instance. Cross-run continuity is handled by the
        # runtime EventStore, not by the pipeline.
        self._sequence: int = 1
        # Optional async queue for streaming events to WS consumers. When set,
        # each emitted event is pushed here after being appended to the
        # in-memory list. The sentinel ``None`` signals stream completion.
        self._event_queue: asyncio.Queue[EventEnvelope | None] | None = None
        self._pending_publication: Path | None = None
        # Human-in-the-loop pause-resume primitives. ``_user_input_event`` is
        # set when the pipeline is blocked in ``_await_user_input`` awaiting a
        # ``submit_user_input`` call from the runtime (POST /resume). The
        # ``_user_input_decision`` holds the resumed decision payload.
        self._user_input_event: asyncio.Event | None = None
        self._user_input_request_id: str | None = None
        self._user_input_decision: UserInputResumedPayload | None = None
        self._managed_terminal_error: BaseException | None = None
        self._total_timeout_scope: asyncio.Timeout | None = None

    def set_event_sink(self, sink: PipelineEventSink) -> None:
        """Attach the awaitable in-memory handoff used by the durable runtime."""

        if self._event_sink is not None and self._event_sink is not sink:
            raise RuntimeError("pipeline event sink is already attached")
        self._event_sink = sink

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
        if run_id != self.ctx.run_id:
            raise ValueError("publish run_id must match the PipelineRunner run_id")
        staging = self._pending_publication
        if staging is None or not staging.is_dir():
            raise RuntimeError("pipeline has no validated package awaiting publication")
        self.ctx.check_cancelled()
        publish_artifacts(
            staging,
            self.workdir.artifacts,
            self.ctx,
            run_id=run_id,
        )
        self._pending_publication = None

    def pending_publication(self) -> PendingPublication:
        """Return callbacks bound to this runner's validated managed package."""

        staging = self._pending_publication
        if not self.defer_publication or staging is None or not staging.is_dir():
            raise RuntimeError("pipeline has no validated package awaiting publication")
        manifest_path = staging / "run_manifest.json"
        manifest_bytes = manifest_path.read_bytes()
        manifest = RunManifest.model_validate_json(manifest_bytes)
        if manifest.task_id != self.task_id:
            raise RuntimeError("pending publication manifest task_id mismatch")
        manifest_entry = ArtifactManifestEntry(
            artifact_id="run_manifest",
            name="run_manifest.json",
            relative_path="artifacts/run_manifest.json",
            media_type="application/json",
            size_bytes=len(manifest_bytes),
            sha256=hashlib.sha256(manifest_bytes).hexdigest(),
            generated_by_step_id="step_artifact_builder_v1",
        )
        run_id = self.ctx.run_id
        return PendingPublication(
            run_id=run_id,
            manifest=manifest,
            manifest_entry=manifest_entry,
            publish=lambda: self.publish(run_id),
            abort=self.abort,
        )

    def abort(self) -> None:
        """Idempotently discard only this runner's staging package."""

        staging = self.workdir.staging / self.ctx.run_id
        with TaskLock(self.workdir.state / "publish.lock"):
            if staging.exists():
                if staging.is_symlink() or not staging.is_dir():
                    raise RuntimeError("pipeline staging path is not a directory")
                shutil.rmtree(staging)
            if self._pending_publication == staging:
                self._pending_publication = None

    async def run(self) -> RunManifest:
        """Execute the pipeline, guaranteeing a terminal task state.

        Acquires a task-level exclusive lock to prevent concurrent execution
        of the same task (e.g. a recovery run racing with a stuck prior
        process). The lock is held for the entire pipeline run and released
        in ``finally``.
        """
        lock = TaskLock(self.workdir.state / "task_running.lock", timeout=self.lock_timeout)
        try:
            lock.acquire()
        except TimeoutError as exc:
            return await self._finalize_failed(exc, ErrorCode.INTERNAL_ERROR)
        try:
            async with asyncio.timeout(self.total_timeout) as timeout_scope:
                self._total_timeout_scope = timeout_scope
                try:
                    return await self._run_inner()
                finally:
                    self._total_timeout_scope = None
        except PipelineCancelledError:
            return await self._finalize_cancelled()
        except PipelinePlanRejectedError as exc:
            self._managed_terminal_error = exc
            return await self._finalize_failed(exc, ErrorCode.INTERNAL_ERROR)
        except PipelineUserInputTimeoutError as exc:
            self._managed_terminal_error = exc
            return await self._finalize_failed(exc, ErrorCode.TIMEOUT)
        except PipelineEventSinkError:
            raise
        except TimeoutError:
            return await self._finalize_failed(
                TimeoutError(f"total pipeline timeout ({self.total_timeout}s) exceeded"),
                ErrorCode.TIMEOUT,
            )
        except Exception as exc:
            return await self._finalize_failed(exc, ErrorCode.INTERNAL_ERROR)
        finally:
            # TODO §1.7: save MetricsTracker regardless of run outcome
            # (success, failure, cancellation) so ablation data is never lost.
            try:
                with suppress(Exception):
                    self.metrics.save(self.workdir.logs / "metrics.json")
            finally:
                lock.release()

    async def run_streamed(self) -> AsyncIterator[EventEnvelope]:
        """Execute the pipeline, yielding each EventEnvelope as it is emitted.

        If a runtime sink is attached, each event is acknowledged by that sink
        before it is yielded. After the generator is exhausted,
        ``self.manifest`` holds the terminal RunManifest (or None if the run
        has not reached a terminal state).
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

        The legacy synchronous API records ``task_cancel_requested`` only in
        the runner's local audit list, then sets the persisted Pipeline flag.
        TaskManager owns authoritative managed-Run cancellation events.
        """
        self._record_local_event(
            self._build_event(CancelRequestedPayload(reason=reason))
        )
        self.state.cancel_requested = True
        self.state.cancel_reason = reason
        save_state(self.workdir.state, self.state)

    def submit_user_input(self, decision: UserInputResumedPayload) -> bool:
        """Submit a resume decision from the runtime (POST /resume).

        Returns ``True`` if the decision was accepted and the blocked
        pipeline will wake up, ``False`` if the pipeline is not awaiting
        input (e.g. already cancelled, timed out, or never paused).
        """

        if (
            self._user_input_event is None
            or self._user_input_request_id != decision.request_id
            or self._user_input_decision is not None
        ):
            return False
        self._user_input_decision = decision
        self._user_input_event.set()
        return True

    def take_managed_terminal_error(self) -> BaseException | None:
        """Return a managed-only terminal decision at most once."""

        error = self._managed_terminal_error
        self._managed_terminal_error = None
        return error

    @asynccontextmanager
    async def _pause_total_timeout(self) -> AsyncIterator[None]:
        """Exclude one HIL pause from the active Pipeline timeout budget."""

        timeout_scope = self._total_timeout_scope
        deadline = timeout_scope.when() if timeout_scope is not None else None
        if timeout_scope is None or deadline is None:
            yield
            return
        loop = asyncio.get_running_loop()
        paused_at = loop.time()
        timeout_scope.reschedule(None)
        try:
            yield
        finally:
            timeout_scope.reschedule(deadline + (loop.time() - paused_at))

    async def _await_user_input(
        self,
        *,
        request_id: str,
        prompt_kind: Literal[
            "plan_confirmation",
            "data_correction",
            "max_turns_reached",
        ],
        summary: str,
        detail: dict[str, object] | None = None,
        expires_at: datetime | None = None,
        timeout: float | None = None,
    ) -> UserInputResumedPayload:
        """Pause the pipeline and wait for human input via POST /resume.

        In fixture mode the request is informational only — the event is
        emitted but the pipeline auto-approves without blocking. In live
        mode the pipeline blocks on an ``asyncio.Event`` until
        ``submit_user_input`` is called by the runtime, or until ``timeout``
        seconds elapse.

        A ``plan_confirmation`` timeout does NOT fail the run: the plan is
        auto-approved with an explicit ``auto_approved`` marker on the resume
        event (REVIEW §3.3, 0805) so an unconfirmed plan cannot void the
        whole run. Other prompt kinds keep the historical behaviour and
        raise ``PipelineUserInputTimeoutError`` (handled by ``run``).
        """

        timeout_seconds = self.user_input_timeout if timeout is None else timeout
        effective_expires_at = expires_at or (
            datetime.now(UTC) + timedelta(seconds=timeout_seconds)
        )
        fixture_exempt = self.mode == "fixture"
        if fixture_exempt:
            decision = UserInputResumedPayload(
                request_id=request_id,
                decision="approve",
                detail=detail or {},
            )
            await self._emit_event(
                UserInputRequiredPayload(
                    request_id=request_id,
                    prompt_kind=prompt_kind,
                    summary=summary,
                    expires_at=effective_expires_at,
                    fixture_exempt=True,
                    detail=detail or {},
                )
            )
            await self._emit_event(decision)
            return decision
        event = asyncio.Event()
        if self._user_input_event is not None:
            raise RuntimeError("pipeline is already awaiting user input")
        self._user_input_event = event
        self._user_input_request_id = request_id
        self._user_input_decision = None
        decision: UserInputResumedPayload | None = None
        wait_deadline = asyncio.get_running_loop().time() + timeout_seconds
        input_waiter = asyncio.create_task(event.wait())
        waiters = {input_waiter}
        cancellation_waiter: asyncio.Task[bool] | None = None
        if isinstance(self.cancellation_requested, asyncio.Event):
            cancellation_waiter = asyncio.create_task(
                self.cancellation_requested.wait()
            )
            waiters.add(cancellation_waiter)
        try:
            async with self._pause_total_timeout():
                await self._emit_event(
                    UserInputRequiredPayload(
                        request_id=request_id,
                        prompt_kind=prompt_kind,
                        summary=summary,
                        expires_at=effective_expires_at,
                        fixture_exempt=fixture_exempt,
                        detail=detail or {},
                    )
                )
                done, _ = await asyncio.wait(
                    waiters,
                    timeout=max(
                        0.0,
                        wait_deadline - asyncio.get_running_loop().time(),
                    ),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    if prompt_kind == "plan_confirmation":
                        # REVIEW §3.3 (0805): a plan-confirmation timeout must
                        # not void the run. Auto-approve with an explicit
                        # marker so the pipeline proceeds instead of failing;
                        # the resume event lets the UI show that execution
                        # started without an explicit human decision.
                        decision = UserInputResumedPayload(
                            request_id=request_id,
                            decision="approve",
                            detail={
                                "auto_approved": True,
                                "auto_approve_reason": "plan_confirmation_timeout",
                                "timeout_seconds": timeout_seconds,
                            },
                        )
                    else:
                        raise PipelineUserInputTimeoutError(
                            f"user input timeout for request {request_id} "
                            f"after {timeout_seconds}s"
                        )
                if self._is_cancelled():
                    raise PipelineCancelledError(
                        "pipeline was cancelled while paused"
                    )
                if self._user_input_decision is not None:
                    decision = self._user_input_decision
        finally:
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
            if self._user_input_event is event:
                self._user_input_event = None
                self._user_input_request_id = None
                self._user_input_decision = None
        if decision is None:
            raise RuntimeError("user input event was set without a decision")
        await self._emit_event(decision)
        return decision

    def _is_cancelled(self) -> bool:
        return self.state.cancel_requested or (
            self.cancellation_requested is not None
            and self.cancellation_requested.is_set()
        )

    async def _run_inner(self) -> RunManifest:
        await self._prepare_run_start()
        stage_outputs: dict[StageName, Any] = {}
        cancelled_manifest = await self._run_stages_loop(stage_outputs)
        if cancelled_manifest is not None:
            return cancelled_manifest
        return await self._finalize_completed(stage_outputs)

    async def _prepare_run_start(self) -> None:
        """Emit recovery/creation events and confirm the plan before stages run.

        A run is recovered after terminalizing persisted inflight work, or
        when prior completed-stage progress belongs to a non-fresh task.
        This covers process interruption, completed reruns, and failed-task
        retries without treating a truly fresh CREATED task as recovery.
        """
        recovered_inflight = self._recover_inflight_attempt()
        # Treat any non-CREATED task as recovered — covers crash recovery,
        # reruns, and failed-task retries (which must skip plan confirmation).
        is_recovered = recovered_inflight or (
            self.state.task_state is not TaskState.CREATED
        )
        if is_recovered:
            await self._emit_event(
                TaskRecoveredPayload(
                    recovered_from_sequence=0
                )
            )
            return
        await self._emit_event(TaskCreatedPayload(topic=self.topic))
        specification = _build_specification_for_plan(self.ctx)
        await self._emit_event(PlanReadyPayload(specification=specification))
        # Pause for plan confirmation (human-in-the-loop). In fixture mode
        # this is informational only and the pipeline auto-approves.
        decision = await self._await_user_input(
            request_id=f"plan-{self.task_id}",
            prompt_kind="plan_confirmation",
            summary=f"Confirm research plan for topic: {self.topic}",
            detail=specification.model_dump(),
        )
        if decision.decision == "reject":
            raise PipelinePlanRejectedError("research plan was rejected by user")

    def _discovery_reuse_blocked(self, stage: StageName) -> bool:
        """C1: block live DISCOVERY reuse for a deliberately re-run task.

        REVIEW 2026-08-05 P1-1: digest reuse would silently skip fresh
        PubMed/GEO retrieval on a re-run of an already-completed task,
        hiding upstream updates (new papers, re-annotated GEO series).
        Recovery from a crash/interrupt (previous run never reached
        COMPLETED) may still reuse the last successful DISCOVERY output.
        """
        return (
            self.mode != "fixture"
            and stage is StageName.DISCOVERY
            and self.state.task_state is TaskState.COMPLETED
        )

    async def _try_reuse_stage(
        self,
        stage: StageName,
        input_digest: str,
        parameter_digest: str,
        stage_outputs: dict[StageName, Any],
        reuse_allowed: bool,
    ) -> bool:
        """Try to reuse a digest-matched stage output.

        Returns ``True`` (and mutates ``stage_outputs`` + state) when the stage
        was successfully reused — the caller should ``continue`` to the next
        stage.  Returns ``False`` when the stage must run fresh.
        """
        reusable = (
            self.state.find_reusable(stage, input_digest, parameter_digest)
            if reuse_allowed
            and not (self.defer_publication and stage is StageName.VALIDATION)
            and not self._discovery_reuse_blocked(stage)
            else None
        )
        completed_digest = self.state.completed_stages.get(stage.value)
        if not (
            reusable is not None
            and reusable.output_digest is not None
            and completed_digest == reusable.output_digest
        ):
            return False

        loaded = load_stage_output(
            self.workdir.state,
            task_root=self.workdir.root,
            task_id=self.task_id,
            stage=stage,
            stage_attempt_id=reusable.stage_attempt_id,
            output_digest=reusable.output_digest,
            expected_type=_STAGE_OUTPUT_TYPES[stage],
        )
        if loaded is not None:
            loaded_output, recorded_files = loaded
            try:
                expected_files = self._collect_stage_output_files(
                    stage, loaded_output, stage_outputs,
                )
            except Exception:
                logger.warning(
                    "collect stage output files failed for stage=%s attempt=%s",
                    stage.value,
                    reusable.stage_attempt_id,
                    exc_info=True,
                )
                expected_files = None
            if expected_files != recorded_files:
                loaded = None
        if loaded is None:
            return False

        stage_outputs[stage] = loaded_output
        skipped_attempt = self._build_attempt(
            stage, input_digest, parameter_digest,
            AttemptStatus.SKIPPED, output_digest=reusable.output_digest,
            attempt=self._next_attempt_number(stage),
        )
        self.state.append_attempt(skipped_attempt)
        await self._emit_stage_event(
            StageSkippedPayload(
                stage=stage,
                status=AttemptStatus.SKIPPED,
                reason="digest matched existing successful attempt",
                reused_stage_attempt_id=reusable.stage_attempt_id,
            ),
            stage_attempt_id=skipped_attempt.stage_attempt_id,
        )
        save_state(self.workdir.state, self.state)
        return True

    async def _run_stages_loop(
        self,
        stage_outputs: dict[StageName, Any],
    ) -> RunManifest | None:
        """Execute each stage, reusing digest-matched outputs where allowed.

        Returns a cancelled/failed manifest when a stage short-circuits the
        run, or ``None`` when every stage completed so the caller can
        finalize normally.
        """
        reuse_allowed = True
        for stage in _STAGES:
            if self._is_cancelled():
                return await self._finalize_cancelled()

            input_digest = self._compute_input_digest(stage, stage_outputs)
            parameter_digest = self._compute_parameter_digest(stage)

            if await self._try_reuse_stage(
                stage, input_digest, parameter_digest, stage_outputs, reuse_allowed
            ):
                continue

            reuse_allowed = False
            started = datetime.now(UTC)
            running_attempt = self._build_attempt(
                stage,
                input_digest,
                parameter_digest,
                AttemptStatus.RUNNING,
                attempt=self._next_attempt_number(stage),
                started=started,
            )
            stage_attempt_id = running_attempt.stage_attempt_id
            self.state.inflight_attempt = running_attempt
            self.state.current_stage = stage
            save_state(self.workdir.state, self.state)
            await self._emit_stage_event(
                StageStartedPayload(stage=stage, attempt=running_attempt.attempt),
                stage_attempt_id=stage_attempt_id,
            )
            await self._emit_stage_event(
                ToolCalledPayload(
                    tool_name=f"run_{stage.value}",
                    arguments_digest=parameter_digest,
                    # REVIEW 2026-08-05 P3-1: 注入截断参数供前端渲染标签
                    arguments={
                        "topic": self.topic,
                        "databases": sorted(self.databases),
                        "mode": self.mode,
                    },
                ),
                stage_attempt_id=stage_attempt_id,
            )

            with self.metrics.stage(stage.value):
                try:
                    result = await self._run_stage(
                        stage,
                        stage_outputs,
                        stage_attempt_id,
                        self.stage_timeouts[stage],
                    )
                except TimeoutError:
                    return await self._finalize_stage_failed(
                        stage,
                        TimeoutError(f"stage {stage.value} timeout exceeded"),
                        ErrorCode.TIMEOUT,
                    )
                except PipelineCancelledError:
                    return await self._finalize_cancelled()
                except DownloadError as exc:
                    return await self._finalize_stage_failed(
                        stage,
                        exc,
                        ErrorCode.NETWORK_ERROR,
                    )
                except Exception as exc:
                    return await self._finalize_stage_failed(
                        stage,
                        exc,
                        ErrorCode.INTERNAL_ERROR,
                    )

            await self._emit_stage_event(
                ToolCompletedPayload(
                    tool_name=f"run_{stage.value}",
                    output_digest=result.output_digest,
                ),
                stage_attempt_id=stage_attempt_id,
            )

            finished = datetime.now(UTC)
            save_stage_output(
                self.workdir.state,
                task_id=self.task_id,
                stage=stage,
                stage_attempt_id=stage_attempt_id,
                output_digest=result.output_digest,
                output=result.output,
                files=self._collect_stage_output_files(
                    stage,
                    result.output,
                    stage_outputs,
                ),
            )
            attempt = self._build_attempt(
                stage, input_digest, parameter_digest,
                AttemptStatus.SUCCEEDED, output_digest=result.output_digest,
                stage_attempt_id=stage_attempt_id, started=started, finished=finished,
                attempt=running_attempt.attempt,
            )
            self.state.append_attempt(attempt)
            self.state.inflight_attempt = None
            self.state.mark_completed(stage, result.output_digest)
            save_state(self.workdir.state, self.state)

            stage_outputs[stage] = result.output
            await self._emit_stage_event(
                StageCompletedPayload(
                    stage=stage,
                    status=AttemptStatus.SUCCEEDED,
                    output_digest=result.output_digest,
                ),
                stage_attempt_id=stage_attempt_id,
            )
            save_state(self.workdir.state, self.state)

            if stage is StageName.ARTIFACT_BUILD:
                await self._emit_warning_events(stage_outputs, stage_attempt_id)

        return None

    async def _emit_warning_events(
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
        # utf-8-sig strips the BOM that artifact_build._write_csv adds (TODO §1.7).
        with warnings_csv.open("r", encoding="utf-8-sig", newline="") as handle:
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
                await self._emit_stage_event(
                    WarningPayload(warning=warning),
                    stage_attempt_id=stage_attempt_id,
                )

    async def _run_stage(
        self,
        stage: StageName,
        stage_outputs: dict[StageName, Any],
        stage_attempt_id: str,
        timeout: float,
    ) -> StageResult:
        """Run sync stage work while draining threads before terminalization."""

        # Bind the running loop so sync stage functions can call
        # ``ctx.emit_progress_sync`` and reach the async emitter via
        # ``run_coroutine_threadsafe``. See docs/REVIEW_2026-07-18.md §4.
        self.ctx.bind_event_loop(asyncio.get_running_loop())
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
                self.ctx, acquisition.source_assets, discovery.dataset_id,
                geo=discovery.geo,
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
                parsed_dataset=processing.parsed_datasets[0],
                parsed_datasets=processing.parsed_datasets,
                merged_dataset=processing.merged_dataset,
                samples=processing.samples,
                literature=discovery.literature,
                geo=discovery.geo,
                specification=discovery.specification,
                retrieved_at=acquisition.retrieved_at,
                stage_attempt_id=stage_attempt_id,
                cleaning_report=processing.cleaning_report,
                field_alignment=processing.field_alignment,
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
        """Get a stage output already verified for the current run."""
        output = stage_outputs.get(stage)
        if output is None:
            raise RuntimeError(f"missing verified output for stage {stage.value}")
        if isinstance(output, dict):
            output = expected_type.model_validate(output)
            stage_outputs[stage] = output
        return output

    def _collect_stage_output_files(
        self,
        stage: StageName,
        output: Any,
        stage_outputs: dict[StageName, Any],
    ) -> list[StageOutputFile]:
        """Enumerate checkpoint files from the typed output for one stage."""
        if stage is StageName.DISCOVERY:
            return []
        if stage is StageName.ACQUISITION:
            acquisition = AcquisitionOutput.model_validate(output)
            files = [
                _stage_output_file_from_asset(asset)
                for asset in acquisition.source_assets
            ]
            source_path = _task_relative_path(
                self.workdir.root,
                acquisition.source_path,
            )
            if source_path not in {item.relative_path for item in files}:
                raise ValueError("acquisition source_path must alias a SourceAsset")
            return _sorted_stage_output_files(files)
        if stage is StageName.PROCESSING:
            processing = ProcessingOutput.model_validate(output)
            return _sorted_stage_output_files(
                [
                    _stage_output_file_from_asset(dataset.file_asset)
                    for dataset in processing.parsed_datasets
                ]
            )
        if stage is StageName.ARTIFACT_BUILD:
            build = ArtifactBuildOutput.model_validate(output)
            files = [
                _stage_output_file_from_asset(asset)
                for asset in build.source_assets
            ]
            source_path = _task_relative_path(
                self.workdir.root,
                build.source_path,
            )
            if source_path not in {item.relative_path for item in files}:
                raise ValueError("artifact build source_path must alias a SourceAsset")

            staging = _task_directory(self.workdir.root, build.staging_dir)
            direct_files = sorted(staging.iterdir(), key=lambda item: item.name)
            if any(path.is_symlink() or not path.is_file() for path in direct_files):
                raise ValueError("artifact build staging may contain only regular files")
            artifact_paths = sorted(
                (Path(path).resolve() for path in build.artifact_paths),
                key=lambda path: path.name,
            )
            if any(path.parent != staging for path in artifact_paths):
                raise ValueError("artifact build paths must be direct staging files")
            if artifact_paths != [path.resolve() for path in direct_files]:
                raise ValueError("artifact build paths must exactly match staging contents")
            files.extend(
                _stage_output_file_from_path(self.workdir.root, path)
                for path in artifact_paths
            )
            return _sorted_stage_output_files(files)
        if stage is StageName.VALIDATION:
            validation = ValidationOutput.model_validate(output)
            if validation.artifacts != validation.manifest.artifacts:
                raise ValueError("validation artifacts must match the run manifest")
            if validation.validation != validation.manifest.validation:
                raise ValueError("validation summary must match the run manifest")
            build = ArtifactBuildOutput.model_validate(
                stage_outputs.get(StageName.ARTIFACT_BUILD)
            )
            files = []
            physical_directory: Path | None = None
            for entry in validation.manifest.artifacts:
                if Path(entry.relative_path).name != entry.name:
                    raise ValueError("validation artifact name/path mismatch")
                artifact_path = self.workdir.root / entry.relative_path
                staging_path = Path(build.staging_dir) / entry.name
                if staging_path.is_file():
                    physical_path = staging_path
                elif artifact_path.is_file():
                    physical_path = artifact_path
                else:
                    raise FileNotFoundError(entry.name)
                if (
                    physical_path.stat().st_size != entry.size_bytes
                    or hashlib.sha256(physical_path.read_bytes()).hexdigest()
                    != entry.sha256
                ):
                    raise ValueError("validation artifact metadata mismatch")
                if physical_directory is None:
                    physical_directory = physical_path.parent
                elif physical_path.parent.resolve() != physical_directory.resolve():
                    raise ValueError("validation artifacts must share one directory")
                files.append(
                    StageOutputFile(
                        relative_path=_task_relative_path(
                            self.workdir.root,
                            physical_path,
                        ),
                        size_bytes=entry.size_bytes,
                        sha256=entry.sha256,
                    )
                )
            if physical_directory is None:
                raise ValueError("validation output must contain artifacts")
            run_manifest_path = physical_directory / "run_manifest.json"
            physical_manifest = RunManifest.model_validate_json(
                run_manifest_path.read_text("utf-8")
            )
            # In deferred-publication mode the physical manifest may carry the
            # finalize-time ``build_result`` enrichment (_finalize_completed
            # writes it back to the staging package); the validation output
            # never does. Compare the stage-owned fields, excluding the
            # enrichment.
            if physical_manifest.model_dump(
                exclude={"build_result"}
            ) != validation.manifest.model_dump(exclude={"build_result"}):
                raise ValueError("physical run manifest must match validation output")
            package_entries = list(physical_directory.iterdir())
            if any(path.is_symlink() or not path.is_file() for path in package_entries):
                raise ValueError("validation package may contain only regular files")
            expected_names = {
                *(entry.name for entry in validation.manifest.artifacts),
                "run_manifest.json",
            }
            actual_names = {path.name for path in package_entries}
            actual_names.discard(".runtime-publication.json")
            if actual_names != expected_names:
                raise ValueError("validation package files must match the run manifest")
            files.append(
                _stage_output_file_from_path(
                    self.workdir.root,
                    run_manifest_path,
                )
            )
            files.append(
                _stage_output_file_from_path(
                    self.workdir.root,
                    self.workdir.root / validation.validation.report_path,
                )
            )
            return _sorted_stage_output_files(files)
        raise ValueError(f"unknown stage output: {stage.value}")

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
        """Compute a digest of every input that can affect stage behavior.

        Uses the combined SHA-256 of all files under ``fixture_dir`` (sorted
        by name) rather than the directory mtime — directory mtime is unstable
        across filesystems and does not change when file contents change but
        filenames stay the same. Includes ``mode`` so a fixture run and a live
        run on the same topic produce different digests and are never reused
        for each other. Selected databases and the canonical task specification
        are included so recovery cannot reuse outputs produced for different
        sources, queries, datasets, or parsing semantics.
        """
        fixture_hash = (
            _hash_directory(self.fixture_dir) if self.mode == "fixture" else None
        )
        payload = {
            "stage": stage.value,
            "fixture_hash": fixture_hash,
            "topic": self.topic,
            "mode": self.mode,
            "databases": sorted(self.databases),
            "specification": (
                self.specification.model_dump(mode="json")
                if self.specification is not None
                else None
            ),
        }
        if stage in {StageName.ARTIFACT_BUILD, StageName.VALIDATION}:
            payload["run_id"] = self.ctx.run_id
        return _sha256_json(payload)

    def _build_attempt(
        self,
        stage: StageName,
        input_digest: str,
        parameter_digest: str,
        status: AttemptStatus,
        attempt: int = 1,
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
            attempt=attempt,
            input_digest=input_digest,
            parameter_digest=parameter_digest,
            output_digest=output_digest,
            status=status,
            started_at=started,
            finished_at=finished,
            error=error,
        )

    def _next_attempt_number(self, stage: StageName) -> int:
        attempts = [
            attempt.attempt
            for attempt in self.state.stage_attempts
            if attempt.stage is stage
        ]
        inflight = self.state.inflight_attempt
        if inflight is not None and inflight.stage is stage:
            attempts.append(inflight.attempt)
        return max(attempts, default=0) + 1

    def _recover_inflight_attempt(self) -> bool:
        inflight = self.state.inflight_attempt
        if inflight is None:
            return False
        cancelled = self._build_attempt(
            inflight.stage,
            inflight.input_digest,
            inflight.parameter_digest,
            AttemptStatus.CANCELLED,
            attempt=inflight.attempt,
            stage_attempt_id=inflight.stage_attempt_id,
            started=inflight.started_at,
            finished=datetime.now(UTC),
        )
        self.state.append_attempt(cancelled)
        self.state.inflight_attempt = None
        save_state(self.workdir.state, self.state)
        self._persist_logs()
        return True

    def _build_event(
        self,
        payload: Any,
        *,
        stage_attempt_id: str | None = None,
    ) -> EventEnvelope:
        event = build_event(
            task_id=self.task_id,
            sequence=self._sequence,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
        )
        self._sequence += 1
        return event

    def _record_local_event(self, event: EventEnvelope) -> None:
        self.events.append(event)

    async def _publish_event(self, event: EventEnvelope) -> None:
        if self._event_sink is not None:
            try:
                await self._event_sink(event)
            except Exception as exc:
                raise PipelineEventSinkError(str(exc) or type(exc).__name__) from exc
        self.events.append(event)
        if self._event_queue is not None:
            self._event_queue.put_nowait(event)
        # 结构化 JSON 审计日志（写入 logs/pipeline.jsonl）
        logger.info(json.dumps(event.model_dump(mode="json"), default=str))
        # 人类可读摘要日志（输出到 stdout）
        self._log_readable(event)

    @staticmethod
    def _log_readable(event: EventEnvelope) -> None:
        """对关键事件输出人类可读的单行摘要。

        仅覆盖 stage 开始/完成/失败、产物生成、任务完成/失败、警告等
        关键节点；tool_called/tool_completed/stage_progress 等细碎事件
        不输出，避免噪音。错误摘要包含根因和错误码。
        """
        payload = event.payload
        if isinstance(payload, StageStartedPayload):
            _readable_logger.info("stage started: %s", payload.stage.value)
        elif isinstance(payload, StageCompletedPayload):
            _readable_logger.info("stage completed: %s", payload.stage.value)
        elif isinstance(payload, StageFailedPayload):
            _readable_logger.error(
                "stage failed: %s — %s [%s]",
                payload.stage.value,
                payload.error.message,
                payload.error.code.value,
            )
        elif isinstance(payload, StageSkippedPayload):
            _readable_logger.info(
                "stage skipped: %s — %s", payload.stage.value, payload.reason,
            )
        elif isinstance(payload, ArtifactProducedPayload):
            _readable_logger.info(
                "artifact produced: %s (%d bytes)",
                payload.artifact.name,
                payload.artifact.size_bytes,
            )
        elif isinstance(payload, TaskCompletedPayload):
            v = payload.validation
            _readable_logger.info(
                "task completed: validation %s (%d checks, %d failed)",
                v.status, v.checked_count, v.failed_count,
            )
        elif isinstance(payload, TaskFailedPayload):
            _readable_logger.error(
                "task failed: %s [%s]",
                payload.error.message,
                payload.error.code.value,
            )
        elif isinstance(payload, WarningPayload):
            if payload.warning is not None:
                _readable_logger.warning("warning: %s", payload.warning.message)
            elif payload.message:
                _readable_logger.warning("warning: %s", payload.message)

    async def _emit_event(self, payload: Any) -> None:
        await self._publish_event(self._build_event(payload))

    async def _emit_stage_event(self, payload: Any, stage_attempt_id: str) -> None:
        await self._publish_event(
            self._build_event(payload, stage_attempt_id=stage_attempt_id)
        )

    async def _emit_progress_event(
        self,
        stage: StageName,
        kind: str,
        current: int,
        total: int | None,
        detail: dict[str, object],
    ) -> None:
        """Forward a StageProgressPayload to the event sink.

        Bound to ``StageContext.progress_emitter`` so stage functions can
        surface mid-stage numbers without knowing about EventEnvelope.
        See docs/REVIEW_2026-07-18.md §4.
        """

        await self._publish_event(
            self._build_event(
                StageProgressPayload(
                    stage=stage,
                    kind=kind,
                    current=current,
                    total=total,
                    detail=detail,
                ),
                stage_attempt_id=self.state.inflight_attempt.stage_attempt_id
                if self.state.inflight_attempt is not None
                else None,
            )
        )

    async def _finalize_stage_failed(
        self,
        stage: StageName,
        exc: Exception,
        error_code: ErrorCode,
    ) -> RunManifest:
        inflight = self.state.inflight_attempt
        if inflight is None:
            raise RuntimeError("stage failure requires an inflight attempt")
        finished = datetime.now(UTC)
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code in (ErrorCode.TIMEOUT, ErrorCode.NETWORK_ERROR),
            stage=stage,
        )
        attempt = self._build_attempt(
            stage,
            inflight.input_digest,
            inflight.parameter_digest,
            AttemptStatus.FAILED,
            attempt=inflight.attempt,
            stage_attempt_id=inflight.stage_attempt_id,
            started=inflight.started_at,
            finished=finished,
            error=error,
        )
        self.state.append_attempt(attempt)
        self.state.inflight_attempt = None
        save_state(self.workdir.state, self.state)
        self._persist_logs()
        # REVIEW 2026-08-05 P1-3: 失败路径补发 is_error tool_completed，闭合
        # stage_started → tool_called → (tool_completed) → stage_failed 事件流。
        await self._emit_stage_event(
            ToolCompletedPayload(
                tool_name=f"run_{stage.value}",
                is_error=True,
            ),
            stage_attempt_id=inflight.stage_attempt_id,
        )
        await self._emit_stage_event(
            StageFailedPayload(stage=stage, status=AttemptStatus.FAILED, error=error),
            stage_attempt_id=inflight.stage_attempt_id,
        )
        # _persist_logs is called once by _finalize_failed; no duplicate call here.
        return await self._finalize_failed(exc, error_code)

    async def _finalize_failed(
        self, exc: Exception, error_code: ErrorCode = ErrorCode.INTERNAL_ERROR
    ) -> RunManifest:
        inflight = self.state.inflight_attempt
        if inflight is not None:
            stage_error = ErrorDetail(
                code=error_code,
                message=str(exc),
                retryable=error_code in (ErrorCode.TIMEOUT, ErrorCode.NETWORK_ERROR),
                stage=inflight.stage,
            )
            failed = self._build_attempt(
                inflight.stage,
                inflight.input_digest,
                inflight.parameter_digest,
                AttemptStatus.FAILED,
                attempt=inflight.attempt,
                stage_attempt_id=inflight.stage_attempt_id,
                started=inflight.started_at,
                finished=datetime.now(UTC),
                error=stage_error,
            )
            self.state.append_attempt(failed)
            self.state.inflight_attempt = None
        self.state.task_state = TaskState.FAILED
        save_state(self.workdir.state, self.state)
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code in (ErrorCode.TIMEOUT, ErrorCode.NETWORK_ERROR),
        )
        await self._emit_event(TaskFailedPayload(error=error))
        self._persist_logs()
        return _build_failed_manifest(
            self.task_id,
            self.started_at,
            error,
            self.topic,
            self.mode,
            self.model_name,
            error_code=error_code,
        )

    async def _finalize_cancelled(self) -> RunManifest:
        inflight = self.state.inflight_attempt
        if inflight is not None:
            # REVIEW 2026-08-05 P1-3: 取消路径补发 is_error tool_completed，
            # 避免 stage_started/tool_called 悬空无终止事件。
            await self._emit_stage_event(
                ToolCompletedPayload(
                    tool_name=f"run_{inflight.stage.value}",
                    is_error=True,
                ),
                stage_attempt_id=inflight.stage_attempt_id,
            )
            cancelled = self._build_attempt(
                inflight.stage,
                inflight.input_digest,
                inflight.parameter_digest,
                AttemptStatus.CANCELLED,
                attempt=inflight.attempt,
                stage_attempt_id=inflight.stage_attempt_id,
                started=inflight.started_at,
                finished=datetime.now(UTC),
            )
            self.state.append_attempt(cancelled)
            self.state.inflight_attempt = None
        self.state.task_state = TaskState.CANCELLED
        save_state(self.workdir.state, self.state)
        await self._emit_event(
            TaskCancelledPayload(reason=self.state.cancel_reason or "cancel requested")
        )
        self._persist_logs()
        return _build_cancelled_manifest(
            self.task_id,
            self.started_at,
            self.topic,
            self.mode,
            self.model_name,
        )

    async def _finalize_completed(
        self, stage_outputs: dict[StageName, Any]
    ) -> RunManifest:
        validation_output = self._get_output(
            stage_outputs, StageName.VALIDATION, ValidationOutput
        )
        manifest = validation_output.manifest
        manifest = manifest.model_copy(
            update={"build_result": _compute_build_result(manifest)}
        )
        # Keep the deferred staging package's run_manifest.json in sync with
        # the enriched in-memory manifest so a deferred publication (and its
        # pending_publication() reader) carries the computed BuildResult.
        # This rewrite is deferred-publication-only: in the non-deferred path
        # validation already moved the staging package into artifacts/, so
        # rewriting would recreate an orphan staging directory while the
        # published artifacts/run_manifest.json stays untouched. The published
        # manifest lacking build_result is acceptable — the authoritative
        # build_result lives in the run events.
        if self._pending_publication is not None:
            (self._pending_publication / "run_manifest.json").write_text(
                manifest.model_dump_json(indent=2) + "\n", "utf-8"
            )

        for entry in manifest.artifacts:
            await self._emit_event_with_payload(
                _artifact_produced_payload(entry)
            )
        await self._emit_event(
            TaskCompletedPayload(
                validation=manifest.validation,
                build_result=manifest.build_result,
            )
        )

        self.state.task_state = TaskState.COMPLETED
        save_state(self.workdir.state, self.state)
        self._persist_logs()
        return manifest

    async def _emit_event_with_payload(self, payload: Any) -> None:
        await self._emit_event(payload)

    def _persist_logs(self) -> None:
        """Write stage_attempts.jsonl to logs/.

        Event persistence is handled by the runtime EventStore — the pipeline
        only keeps an in-memory ``events`` list for bridge consumption.
        """
        self.workdir.logs.mkdir(parents=True, exist_ok=True)
        attempts_file = self.workdir.logs / "stage_attempts.jsonl"
        new_attempts = self.state.stage_attempts[self._persisted_attempt_count :]
        append_jsonl_records(
            attempts_file,
            [attempt.model_dump(mode="json") for attempt in new_attempts],
        )
        self._persisted_attempt_count += len(new_attempts)

    def _record_download_attempt(self, attempt: DownloadAttempt) -> None:
        """Persist one URL attempt before Acquisition can fail or crash."""

        inflight = self.state.inflight_attempt
        if inflight is None or inflight.stage is not StageName.ACQUISITION:
            raise RuntimeError("download attempt requires an inflight acquisition")
        record = DownloadAttemptAuditRecord(
            task_id=self.task_id,
            run_id=self.ctx.run_id,
            stage_attempt_id=inflight.stage_attempt_id,
            attempt=attempt,
        )
        append_jsonl_records(
            self.workdir.logs / "download_attempts.jsonl",
            [record.model_dump(mode="json")],
        )


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _task_relative_path(task_root: Path, path: Path) -> str:
    root = task_root.resolve()
    resolved = Path(path).resolve()
    return resolved.relative_to(root).as_posix()


def _stage_output_file_from_asset(asset: Any) -> StageOutputFile:
    return StageOutputFile(
        relative_path=asset.relative_path,
        size_bytes=asset.size_bytes,
        sha256=asset.sha256,
    )


def _stage_output_file_from_path(task_root: Path, path: Path) -> StageOutputFile:
    resolved = Path(path).resolve(strict=True)
    if Path(path).is_symlink() or not resolved.is_file():
        raise ValueError("stage output checkpoint references a non-regular file")
    return StageOutputFile(
        relative_path=resolved.relative_to(task_root.resolve()).as_posix(),
        size_bytes=resolved.stat().st_size,
        sha256=hashlib.sha256(resolved.read_bytes()).hexdigest(),
    )


def _task_directory(task_root: Path, path: Path) -> Path:
    resolved = Path(path).resolve(strict=True)
    resolved.relative_to(task_root.resolve())
    if not resolved.is_dir():
        raise ValueError("stage output directory is not a directory")
    return resolved


def _sorted_stage_output_files(
    files: list[StageOutputFile],
) -> list[StageOutputFile]:
    ordered = sorted(files, key=lambda item: item.relative_path)
    paths = [item.relative_path for item in ordered]
    if len(paths) != len(set(paths)):
        raise ValueError("stage output file references must be unique")
    return ordered


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


_PRIMARY_ARTIFACT_NAME = "main_data.csv"


def _compute_build_result(manifest: RunManifest) -> BuildResult:
    """Conservative 4a BuildResult from a completed manifest.

    Only the presence of a primary dataset artifact is considered. Source-level
    partial-success statistics and accurate row counts arrive with 4b when the
    V2 chain statistics are wired in.

    ``SUCCEEDED`` carries a provisional ``publication_id`` (``pub-<task_id>``):
    ``BuildResult.validate_state`` forbids a SUCCEEDED build without one, and
    ``_compute_build_result`` receives no run identifier. The agent_loop
    publish path replaces it with the run-scoped ``pub-<run_id>`` before
    emitting ``PublicationCreatedPayload`` (4a Task 5). ``valid_row_count`` is
    0 until 4b injects the artifact_build primary row statistics.
    """

    has_primary = any(
        entry.name == _PRIMARY_ARTIFACT_NAME for entry in manifest.artifacts
    )
    if has_primary:
        return BuildResult(
            status=BuildResultStatus.SUCCEEDED,
            valid_row_count=0,
            successful_sources=list(manifest.source_ids),
            reason_codes=[],
            # Deterministic placeholder required by BuildResult.validate_state
            # (a SUCCEEDED build must carry a non-None publication_id). Task 5
            # stamps the real ``pub-<run_id>`` onto the run-level build_result
            # copy at commit time; this placeholder is not authoritative.
            publication_id=f"pub-{manifest.task_id}",
            user_summary="完成：主数据已发布。",
            recommended_next_action="可在产物区查看主表与审计报告。",
        )
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        reason_codes=["no_primary_data"],
        user_summary="任务完成，但未产出可发布的主数据。",
        recommended_next_action="检查数据源可用性或调整查询后重试。",
    )


def _build_specification_for_plan(ctx: StageContext) -> TaskSpecification:
    """Build a TaskSpecification for the plan_ready event.

    If the runner was constructed with an explicit ``specification``, return it.
    In fixture mode fall back to the pinned Phase 1 regression case
    (GSE178352 + PMID 34180400) so existing regression tests keep passing.
    In live mode derive a topic-driven specification from the selected
    ``databases``.
    """
    from app.domain.contracts import (
        Database,
        DatasetSelection,
        QuerySpecification,
        RequestedOutput,
        TaskSpecification,
    )
    if ctx.specification is not None:
        return ctx.specification

    # Fixture mode default: pinned Phase 1 regression case.
    if ctx.mode == "fixture":
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
                    source_id="",
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

    # Live mode: topic-driven derivation from selected databases.
    selected = {value.lower() for value in ctx.databases}
    queries: list[QuerySpecification] = []
    datasets: list[DatasetSelection] = []
    order = 0

    def _next_order() -> int:
        nonlocal order
        order += 1
        return order

    if "geo" in selected:
        queries.append(
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query=f"{ctx.topic} GEO[DataSet]",
                generated_by="pipeline",
                purpose="find expression dataset by topic",
                order=_next_order(),
            )
        )
    if "pubmed" in selected:
        queries.append(
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query=ctx.topic,
                generated_by="pipeline",
                purpose="find literature by topic",
                order=_next_order(),
            )
        )

    if not queries:
        _DB_NAME_MAP: dict[str, Database] = {
            "xena": Database.UCSC_XENA,
        }
        for db_name in ctx.databases:
            if db_name == "browser_fallback":
                continue
            database = _DB_NAME_MAP.get(db_name)
            if database is None:
                try:
                    database = Database(db_name)
                except ValueError:
                    continue
            queries.append(
                QuerySpecification(
                    query_id=f"query_{db_name}_1",
                    database=database,
                    query=ctx.topic,
                    generated_by="pipeline",
                    purpose=f"topic-driven {db_name} query",
                    order=_next_order(),
                )
            )

    return TaskSpecification(
        topic=ctx.topic,
        queries=queries,
        datasets=datasets,
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
    task_id: str,
    started_at: datetime,
    error: ErrorDetail,
    topic: str,
    mode: Literal["fixture", "live"] = "fixture",
    model_name: str = RunModelSettings.default().model_name,
    error_code: ErrorCode | None = None,
) -> RunManifest:
    """Build a minimal RunManifest for a failed task."""
    from app.domain.contracts import TaskRequest, TaskSpecification, ValidationSummary
    return RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=topic, mode=mode),
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
        model_name=model_name,
        mode=mode,
        live_accepted=False,
        started_at=started_at,
        finished_at=datetime.now(UTC),
        error_code=error_code,
    )


def _build_cancelled_manifest(
    task_id: str,
    started_at: datetime,
    topic: str,
    mode: Literal["fixture", "live"] = "fixture",
    model_name: str = RunModelSettings.default().model_name,
) -> RunManifest:
    """Build a minimal RunManifest for a cancelled task."""
    from app.domain.contracts import TaskRequest, TaskSpecification, ValidationSummary
    return RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=topic, mode=mode),
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
        model_name=model_name,
        mode=mode,
        live_accepted=False,
        started_at=started_at,
        finished_at=datetime.now(UTC),
    )
