"""Server-side fixed build skeleton executor (ARCHITECTURE §3.4/§5; Design §12.2).

The skeleton is fixed in code (``build_operation_plan``); the Agent cannot
declare steps. Each operation records an append-only ``OperationAttempt`` with
digest-matched idempotent reuse, checkpointed output, cooperative cancellation,
per-operation timeout and typed events. Operation semantics are injected via
``run_operation`` — real Adapter/Acquisition implementations arrive in Phase 3.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from app.datasets.contracts import DatasetBuildSpec
from app.datasets.runtime.checkpoint import (
    BuildState,
    load_build_state,
    load_operation_output,
    save_build_state,
    save_operation_output,
    validate_attempt_log_prefix,
)
from app.datasets.runtime.operations import (
    OperationAttempt,
    OperationKind,
    OperationOutput,
    OperationSpec,
)
from app.domain.contracts import (
    ErrorCode,
    ErrorDetail,
    EventEnvelope,
    OperationCompletedPayload,
    OperationFailedPayload,
    OperationStartedPayload,
    build_event,
    generate_prefixed_uuid,
)
from app.domain.contracts.enums import AttemptStatus
from app.domain.contracts.source import SourceAsset
from app.pipeline.state import TaskLock
from app.runtime.event_store import append_jsonl_records


class CancellationToken(Protocol):
    def is_set(self) -> bool: ...


BuildEventSink = Callable[[EventEnvelope], Awaitable[None]]
OperationRunner = Callable[
    [OperationSpec, dict[str, Any]], Awaitable[OperationOutput]
]


class BuildCancelledError(RuntimeError):
    """Raised when cooperative cancellation stops the skeleton."""


class BuildOperationTimeoutError(RuntimeError):
    """Raised when one operation exceeds its timeout budget."""


@dataclass(frozen=True, slots=True)
class BuildRunOutcome:
    status: Literal["completed", "failed", "cancelled"]
    error: ErrorDetail | None = None
    completed_operation_ids: tuple[str, ...] = ()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_operation_plan(spec: DatasetBuildSpec) -> tuple[OperationSpec, ...]:
    """Expand the fixed skeleton for one build spec (fan-out per source).

    Plan order is topological: acquire/parse/canonicalize fan out per source
    binding, then compatibility gate -> integrate -> validate profile ->
    publish fan back in. The Agent never supplies this plan.
    """
    ops: list[OperationSpec] = []
    bindings = spec.source_bindings
    for binding in bindings:
        op_id = f"acquire:{binding.binding_id}"
        ops.append(
            OperationSpec(
                operation_id=op_id,
                kind=OperationKind.ACQUIRE,
                label=f"获取 {binding.source}",
                category=binding.binding_id,
            )
        )
    for binding in bindings:
        op_id = f"parse:{binding.binding_id}"
        ops.append(
            OperationSpec(
                operation_id=op_id,
                kind=OperationKind.PARSE,
                label=f"解析 {binding.source}",
                category=binding.binding_id,
                upstream=(f"acquire:{binding.binding_id}",),
            )
        )
    for binding in bindings:
        op_id = f"canonicalize:{binding.binding_id}"
        ops.append(
            OperationSpec(
                operation_id=op_id,
                kind=OperationKind.CANONICALIZE,
                label=f"规范化 {binding.source}",
                category=binding.binding_id,
                upstream=(f"parse:{binding.binding_id}",),
            )
        )
    canonicalize_ids = tuple(
        f"canonicalize:{binding.binding_id}" for binding in bindings
    )
    ops.append(
        OperationSpec(
            operation_id="compatibility_gate",
            kind=OperationKind.COMPATIBILITY_GATE,
            label="兼容性检查",
            upstream=canonicalize_ids,
        )
    )
    ops.append(
        OperationSpec(
            operation_id="integrate",
            kind=OperationKind.INTEGRATE,
            label="确定性合并",
            upstream=("compatibility_gate",),
        )
    )
    ops.append(
        OperationSpec(
            operation_id="validate_profile",
            kind=OperationKind.VALIDATE_PROFILE,
            label="Validation Profile",
            upstream=("integrate",),
        )
    )
    ops.append(
        OperationSpec(
            operation_id="publish",
            kind=OperationKind.PUBLISH,
            label="原子发布",
            upstream=("validate_profile",),
        )
    )
    return tuple(ops)


class DatasetBuildExecutor:
    """Executes one fixed skeleton with idempotent recovery and cancel support."""

    def __init__(
        self,
        *,
        task_id: str,
        build_id: str,
        run_id: str,
        state_dir: Path,
        lock_path: Path,
        task_root: Path,
        plan: tuple[OperationSpec, ...],
        run_operation: OperationRunner,
        event_sink: BuildEventSink | None = None,
        cancellation_requested: CancellationToken | None = None,
        parameter_scope: dict[str, Any] | None = None,
        implementation_versions: Mapping[str, str] | None = None,
        source_assets: Mapping[str, SourceAsset] | None = None,
        operation_timeout: float = 120.0,
        lock_timeout: float = 5.0,
        resume_from: str | None = None,
    ) -> None:
        self._task_id = task_id
        self._build_id = build_id
        self._run_id = run_id
        self._state_dir = Path(state_dir)
        self._lock_path = Path(lock_path)
        self._task_root = Path(task_root)
        self._plan = plan
        self._operation_runner = run_operation
        self._event_sink = event_sink
        self._cancellation_requested = cancellation_requested
        self._parameter_scope = parameter_scope or {}
        self._implementation_versions = implementation_versions or {}
        self._source_assets = dict(source_assets or {})
        self._operation_timeout = operation_timeout
        self._lock_timeout = lock_timeout
        self._resume_from = resume_from
        if resume_from is not None and resume_from not in {
            op.operation_id for op in plan
        }:
            raise ValueError(
                f"resume_from must name a plan operation, got {resume_from!r}"
            )
        self._state: BuildState | None = None
        self._outputs: dict[str, Any] = {}
        self._sequence: int = 1
        self._persisted_attempt_count: int = 0

    async def run(self) -> BuildRunOutcome:
        """Execute the skeleton, guaranteeing a terminal outcome.

        A build-level exclusive lock prevents concurrent execution of the same
        build (recovery racing a stuck prior process). The lock is released in
        ``finally``. When ``resume_from`` names a plan operation, that operation
        is re-executed and its downstream is revalidated through the digest
        closure; earlier operations still run or reuse as usual.
        """
        lock = TaskLock(self._lock_path, timeout=self._lock_timeout)
        try:
            lock.acquire()
        except TimeoutError as exc:
            return self._outcome_failed(
                ErrorCode.INTERNAL_ERROR, f"could not acquire build lock: {exc}"
            )
        try:
            try:
                self._state = load_build_state(
                    self._state_dir, self._task_id, self._build_id
                )
                self._persisted_attempt_count = validate_attempt_log_prefix(
                    self._state, self._attempts_path()
                )
                self._recover_inflight_attempt()
            except Exception as exc:
                # A corrupt/mismatched state or diverged attempt log is a
                # recovery failure, not a plan failure: return a structured
                # outcome instead of escaping a bare exception (the caller
                # only expects BuildRunOutcome).
                return self._outcome_failed(
                    ErrorCode.INTERNAL_ERROR,
                    f"build state could not be loaded or recovered: {exc}",
                )
            try:
                return await self._run_plan()
            except BuildCancelledError:
                return await self._finalize_cancelled()
            except BuildOperationTimeoutError as exc:
                return await self._finalize_failed(
                    exc, ErrorCode.TIMEOUT
                )
            except Exception as exc:
                return await self._finalize_failed(
                    exc, ErrorCode.INTERNAL_ERROR
                )
        finally:
            lock.release()

    def _attempts_path(self) -> Path:
        return self._state_dir / "operation_attempts.jsonl"

    def _is_cancelled(self) -> bool:
        return (
            self._cancellation_requested is not None
            and self._cancellation_requested.is_set()
        )

    def _recover_inflight_attempt(self) -> None:
        """Mark a crash-interrupted inflight attempt as CANCELLED."""
        state = self._state
        assert state is not None
        inflight = state.inflight_attempt
        if inflight is None:
            return
        cancelled = self._build_attempt(
            inflight.operation_id,
            inflight.input_digest,
            inflight.parameter_digest,
            AttemptStatus.CANCELLED,
            attempt=inflight.attempt,
            operation_attempt_id=inflight.operation_attempt_id,
            started=inflight.started_at,
            finished=datetime.now(UTC),
        )
        state.append_attempt(cancelled)
        state.inflight_attempt = None
        save_build_state(self._state_dir, state)
        self._persist_attempts()

    async def _run_plan(self) -> BuildRunOutcome:
        state = self._state
        assert state is not None
        for op in self._plan:
            if self._is_cancelled():
                raise BuildCancelledError("build was cancelled before an operation")
            await self._run_operation_once(op, force=(op.operation_id == self._resume_from))
        return BuildRunOutcome(
            status="completed",
            completed_operation_ids=tuple(state.completed_operations.keys()),
        )

    async def _run_operation_once(
        self,
        op: OperationSpec,
        *,
        force: bool = False,
    ) -> None:
        """Run (or reuse) one operation with digest matching and checkpointing.

        ``force`` marks a server-controlled restart point (``resume_from``):
        the operation itself is re-executed even when a digest-matched attempt
        exists; downstream operations are still reused only when their upstream
        digests match (ARCHITECTURE §5.2). The Agent cannot skip arbitrary
        operations.
        """
        input_digest = self._compute_input_digest(op)
        parameter_digest = self._compute_parameter_digest(op)

        if not force and await self._try_reuse_operation(op, input_digest, parameter_digest):
            return

        started = datetime.now(UTC)
        running = self._build_attempt(
            op.operation_id,
            input_digest,
            parameter_digest,
            AttemptStatus.RUNNING,
            attempt=self._next_attempt_number(op.operation_id),
            started=started,
        )
        state = self._state
        assert state is not None
        state.inflight_attempt = running
        save_build_state(self._state_dir, state)
        await self._emit(
            OperationStartedPayload(
                operation_id=op.operation_id,
                label=op.label,
                category=op.category,
                attempt=running.attempt,
            )
        )

        try:
            upstream = {
                upstream_id: self._outputs[upstream_id]
                for upstream_id in op.upstream
            }
            result = await self._run_with_timeout(op, upstream)
        except BuildCancelledError:
            cancelled = self._build_attempt(
                op.operation_id,
                input_digest,
                parameter_digest,
                AttemptStatus.CANCELLED,
                attempt=running.attempt,
                operation_attempt_id=running.operation_attempt_id,
                started=started,
                finished=datetime.now(UTC),
            )
            state.append_attempt(cancelled)
            state.inflight_attempt = None
            save_build_state(self._state_dir, state)
            self._persist_attempts()
            await self._emit(
                OperationFailedPayload(
                    operation_id=op.operation_id,
                    status=AttemptStatus.CANCELLED,
                )
            )
            raise

        output_digest = _sha256_json(result.output)
        finished = datetime.now(UTC)
        save_operation_output(
            self._state_dir,
            task_id=self._task_id,
            build_id=self._build_id,
            operation_id=op.operation_id,
            operation_attempt_id=running.operation_attempt_id,
            output_digest=output_digest,
            output=result.output,
            files=list(result.files),
        )
        succeeded = self._build_attempt(
            op.operation_id,
            input_digest,
            parameter_digest,
            AttemptStatus.SUCCEEDED,
            output_digest=output_digest,
            attempt=running.attempt,
            operation_attempt_id=running.operation_attempt_id,
            started=started,
            finished=finished,
        )
        state.append_attempt(succeeded)
        state.inflight_attempt = None
        state.mark_completed(op.operation_id, output_digest)
        save_build_state(self._state_dir, state)
        self._persist_attempts()

        self._outputs[op.operation_id] = result.output
        await self._emit(
            OperationCompletedPayload(
                operation_id=op.operation_id,
                output_digest=output_digest,
            )
        )

    async def _try_reuse_operation(
        self,
        op: OperationSpec,
        input_digest: str,
        parameter_digest: str,
    ) -> bool:
        """Reuse a digest-matched SUCCEEDED attempt when its checkpoint verifies."""
        state = self._state
        assert state is not None
        reusable = state.find_reusable(op.operation_id, input_digest, parameter_digest)
        if reusable is None or reusable.output_digest is None:
            return False
        completed = state.completed_operations.get(op.operation_id)
        if completed != reusable.output_digest:
            return False
        loaded = load_operation_output(
            self._state_dir,
            task_root=self._task_root,
            task_id=self._task_id,
            build_id=self._build_id,
            operation_id=op.operation_id,
            operation_attempt_id=reusable.operation_attempt_id,
            output_digest=reusable.output_digest,
        )
        if loaded is None:
            return False

        self._outputs[op.operation_id] = loaded
        skipped = self._build_attempt(
            op.operation_id,
            input_digest,
            parameter_digest,
            AttemptStatus.SKIPPED,
            output_digest=reusable.output_digest,
            attempt=self._next_attempt_number(op.operation_id),
            reused_operation_attempt_id=reusable.operation_attempt_id,
        )
        state.append_attempt(skipped)
        save_build_state(self._state_dir, state)
        self._persist_attempts()
        await self._emit(
            OperationCompletedPayload(
                operation_id=op.operation_id,
                status=AttemptStatus.SKIPPED,
                output_digest=reusable.output_digest,
                reused_operation_attempt_id=reusable.operation_attempt_id,
            )
        )
        return True

    async def _run_with_timeout(
        self, op: OperationSpec, upstream: dict[str, Any]
    ) -> OperationOutput:
        """Run one operation under a cooperative timeout and cancel checks."""
        try:
            async with asyncio.timeout(self._operation_timeout):
                return await self._execute_operation(op, upstream)
        except TimeoutError as exc:
            raise BuildOperationTimeoutError(
                f"operation {op.operation_id} exceeded {self._operation_timeout}s"
            ) from exc

    async def _execute_operation(
        self, op: OperationSpec, upstream: dict[str, Any]
    ) -> OperationOutput:
        if self._is_cancelled():
            raise BuildCancelledError(f"operation {op.operation_id} was cancelled")
        result = await self._operation_runner(op, upstream)
        if self._is_cancelled():
            raise BuildCancelledError(
                f"operation {op.operation_id} completed after cancel request"
            )
        return result

    def _compute_input_digest(self, op: OperationSpec) -> str:
        upstream = {
            upstream_id: self._outputs[upstream_id]
            for upstream_id in op.upstream
        }
        payload: dict[str, object] = {
            "build_id": self._build_id,
            "operation_id": op.operation_id,
            "upstream": {
                operation_id: _sha256_json(value)
                for operation_id, value in upstream.items()
            },
        }
        if self._source_assets:
            # B2 (Phase 4 review): checkpoint reuse must never serve stale
            # output after a source file changed. Operation outputs are
            # structural metadata (row counts, file paths, batch ids), so a
            # change to source content would not otherwise flow through the
            # upstream digest chain — folding the authoritative
            # binding -> {sha256, size_bytes} mapping into every operation's
            # input digest conservatively invalidates all checkpoints when
            # any source asset changes (ARCHITECTURE §5.2 digest closure).
            payload["source_assets"] = {
                binding_id: {
                    "sha256": asset.sha256,
                    "size_bytes": asset.size_bytes,
                }
                for binding_id, asset in sorted(self._source_assets.items())
            }
        return _sha256_json(payload)

    def _compute_parameter_digest(self, op: OperationSpec) -> str:
        # The implementation version is part of the reuse contract: a
        # SUCCEEDED attempt is only reused when input, parameter **and
        # implementation version** all match (ARCHITECTURE §5.2), so an
        # upgraded adapter/parser never serves stale output.
        return _sha256_json(
            {
                "build_id": self._build_id,
                "operation_id": op.operation_id,
                "parameters": self._parameter_scope,
                "implementation_version": self._implementation_versions.get(
                    op.operation_id
                ),
            }
        )

    def _build_attempt(
        self,
        operation_id: str,
        input_digest: str,
        parameter_digest: str,
        status: AttemptStatus,
        attempt: int = 1,
        output_digest: str | None = None,
        operation_attempt_id: str | None = None,
        started: datetime | None = None,
        finished: datetime | None = None,
        error: ErrorDetail | None = None,
        reused_operation_attempt_id: str | None = None,
    ) -> OperationAttempt:
        return OperationAttempt(
            operation_attempt_id=operation_attempt_id
            or generate_prefixed_uuid("operation_attempt"),
            task_id=self._task_id,
            build_id=self._build_id,
            operation_id=operation_id,
            attempt=attempt,
            input_digest=input_digest,
            parameter_digest=parameter_digest,
            output_digest=output_digest,
            status=status,
            implementation_version=self._implementation_versions.get(operation_id),
            started_at=started,
            finished_at=finished,
            error=error,
            reused_operation_attempt_id=reused_operation_attempt_id,
        )

    def _next_attempt_number(self, operation_id: str) -> int:
        state = self._state
        assert state is not None
        attempts = [
            attempt.attempt
            for attempt in state.operation_attempts
            if attempt.operation_id == operation_id
        ]
        inflight = state.inflight_attempt
        if inflight is not None and inflight.operation_id == operation_id:
            attempts.append(inflight.attempt)
        return max(attempts, default=0) + 1

    async def _finalize_cancelled(self) -> BuildRunOutcome:
        state = self._state
        if state is None:
            return BuildRunOutcome(status="cancelled")
        inflight = state.inflight_attempt
        if inflight is not None:
            cancelled = self._build_attempt(
                inflight.operation_id,
                inflight.input_digest,
                inflight.parameter_digest,
                AttemptStatus.CANCELLED,
                attempt=inflight.attempt,
                operation_attempt_id=inflight.operation_attempt_id,
                started=inflight.started_at,
                finished=datetime.now(UTC),
            )
            state.append_attempt(cancelled)
            state.inflight_attempt = None
            save_build_state(self._state_dir, state)
            self._persist_attempts()
            await self._emit(
                OperationFailedPayload(
                    operation_id=inflight.operation_id,
                    status=AttemptStatus.CANCELLED,
                )
            )
        return BuildRunOutcome(status="cancelled")

    async def _finalize_failed(
        self, exc: Exception, error_code: ErrorCode
    ) -> BuildRunOutcome:
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code in (ErrorCode.TIMEOUT, ErrorCode.NETWORK_ERROR),
        )
        state = self._state
        if state is None:
            return BuildRunOutcome(status="failed", error=error)
        inflight = state.inflight_attempt
        if inflight is not None:
            failed = self._build_attempt(
                inflight.operation_id,
                inflight.input_digest,
                inflight.parameter_digest,
                AttemptStatus.FAILED,
                attempt=inflight.attempt,
                operation_attempt_id=inflight.operation_attempt_id,
                started=inflight.started_at,
                finished=datetime.now(UTC),
                error=error,
            )
            state.append_attempt(failed)
            state.inflight_attempt = None
            save_build_state(self._state_dir, state)
            self._persist_attempts()
            await self._emit(
                OperationFailedPayload(
                    operation_id=inflight.operation_id,
                    status=AttemptStatus.FAILED,
                    error=error,
                )
            )
            return BuildRunOutcome(status="failed", error=error)
        return BuildRunOutcome(status="failed", error=error)

    def _outcome_failed(self, error_code: ErrorCode, message: str) -> BuildRunOutcome:
        return BuildRunOutcome(
            status="failed",
            error=ErrorDetail(
                code=error_code,
                message=message,
                retryable=False,
            ),
        )

    async def _emit(self, payload: Any) -> None:
        event = build_event(
            task_id=self._task_id,
            sequence=self._sequence,
            payload=payload,
            run_id=self._run_id,
        )
        self._sequence += 1
        if self._event_sink is not None:
            await self._event_sink(event)

    def _persist_attempts(self) -> None:
        state = self._state
        assert state is not None
        self._state_dir.mkdir(parents=True, exist_ok=True)
        new_attempts = state.operation_attempts[self._persisted_attempt_count :]
        append_jsonl_records(
            self._attempts_path(),
            [attempt.model_dump(mode="json") for attempt in new_attempts],
        )
        self._persisted_attempt_count += len(new_attempts)
