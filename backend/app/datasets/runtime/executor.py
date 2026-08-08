"""Server-side fixed build skeleton executor (ARCHITECTURE §3.4/§5; Design §12.2).

The skeleton is fixed in code (``build_operation_plan``); the Agent cannot
declare steps. Each operation records an append-only ``OperationAttempt`` with
digest-matched idempotent reuse, checkpointed output, cooperative cancellation,
per-operation timeout and typed events. Operation semantics are injected via
``run_operation`` — real Adapter/Acquisition implementations arrive in Phase 3.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import hashlib
import json
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import JsonValue

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

logger = logging.getLogger(__name__)

#: K1 residual (wave 10): a process-lifetime nonce generated ONCE per
#: process. Together with the marker's ``pid`` it identifies which process
#: owns a ``.worker_unfinished`` marker, so a retry can tell a LIVE
#: in-process straggler (same pid + nonce) from a marker whose owning
#: process is gone (its worker threads died with it — stale by definition).
_PROCESS_NONCE = uuid.uuid4().hex

#: K1 residual (wave 10): poll interval for the bounded straggler wait.
#: The wait polls the worker completion futures instead of awaiting a
#: ``wrap_future`` gather under ``asyncio.timeout``, because a timed-out
#: gather CANCELLES the (pending) completion futures — destroying the
#: liveness signal a marker write needs (a cancelled future reads as
#: ``done()`` while the thread is still writing).
_STRAGGLER_POLL_INTERVAL = 0.01


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
        straggler_grace: float = 10.0,
        unstable_marker_ttl: float = 60.0,
        unstable_poll_interval: float = 0.05,
        unstable_poll_cap: float = 5.0,
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
        # K1 residual (Phase 4 review): the operation timeout cancels only
        # the await; the to_thread worker keeps running. This bounds how long
        # the executor waits for such a straggler before finalizing the
        # failure and releasing the build lock (a straggler is work already
        # in progress, so a short fixed cap suffices — the operation timeout
        # already bounded the work itself). If a straggler still does not
        # finish within the grace, the state dir is marked so a retry cannot
        # reuse the unstable workspace.
        self._straggler_grace = straggler_grace
        # K1 residual (wave 9): ``.worker_unfinished`` is a real exclusion,
        # not an observation. ``unstable_marker_ttl`` bounds how old a
        # marker must be to be treated as stale (worker threads die with the
        # process, so a marker surviving a restart is stale by definition);
        # a fresh marker is polled every ``unstable_poll_interval`` until
        # the straggler's finally removes it, bounded by
        # ``unstable_poll_cap``, after which a retryable conflict is
        # returned.
        self._unstable_marker_ttl = unstable_marker_ttl
        self._unstable_poll_interval = unstable_poll_interval
        self._unstable_poll_cap = unstable_poll_cap
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
                self._register_worker_marker()
            except Exception as exc:
                # A corrupt/mismatched state or diverged attempt log is a
                # recovery failure, not a plan failure: return a structured
                # outcome instead of escaping a bare exception (the caller
                # only expects BuildRunOutcome).
                return self._outcome_failed(
                    ErrorCode.INTERNAL_ERROR,
                    f"build state could not be loaded or recovered: {exc}",
                )
            unstable = await self._exclude_unstable_workspace()
            if unstable is not None:
                return unstable
            try:
                return await self._run_plan()
            except BuildCancelledError:
                await self._await_straggler_workers()
                return await self._finalize_cancelled()
            except BuildOperationTimeoutError as exc:
                await self._await_straggler_workers()
                return await self._finalize_failed(
                    exc, ErrorCode.TIMEOUT
                )
            except Exception as exc:
                await self._await_straggler_workers()
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
            # K1 (D2 residual, Phase 4 review): the boundary check runs only
            # after the operation's worker thread await completed, so the
            # thread's files are finished but must be DISCARDED — the
            # completed-too-late outputs never become part of the build state
            # (a retry of the same build_id starts from a clean workspace and
            # cannot overlap with, or leak, the cancelled attempt's leftovers).
            # In-flight sync work itself is not preemptable; only its finished
            # outputs are dropped here, never mid-write.
            self._discard_cancelled_operation_outputs(op.operation_id)
            raise BuildCancelledError(
                f"operation {op.operation_id} completed after cancel request"
            )
        return result

    def _discard_cancelled_operation_outputs(self, operation_id: str) -> None:
        """Best-effort workspace hygiene for a cancelled operation (K1)."""

        op = next(
            (
                candidate
                for candidate in self._plan
                if candidate.operation_id == operation_id
            ),
            None,
        )
        if op is None:
            return
        discard = getattr(self._operation_runner, "discard_operation_outputs", None)
        if discard is None:
            return
        # Output discard must never mask the cancellation outcome; a failure
        # here degrades to the retry re-running the operation (no SUCCEEDED
        # attempt is recorded) and rewriting the paths.
        with contextlib.suppress(Exception):
            discard(op)

    async def _await_straggler_workers(self) -> None:
        """Wait (bounded) for operation worker threads that may still run.

        K1 residual (Phase 4 review): ``asyncio.timeout`` cancels only the
        await — the ``to_thread`` worker keeps running and may still be
        writing its deterministic outputs. The executor must not return (and
        thus must not release the build lock in ``run()``'s ``finally``)
        while such a straggler may still be alive: a same-build_id retry
        could otherwise acquire the lock and validate/publish a file the
        late thread later overwrites. The wait is bounded by
        ``straggler_grace``; if a straggler still does not finish within the
        grace, the state dir is marked (``_mark_unfinished_worker``) so a
        retry cannot reuse the unstable workspace, and the condition is
        logged. The wait defers only lock release, never the operation
        outcome: the timeout/cancellation/failure that triggered it is still
        the outcome.
        """
        workers = self._in_flight_worker_futures()
        if not workers:
            return
        # K1 residual (wave 10): the wait POLLS the worker completion
        # futures instead of awaiting a ``wrap_future`` gather under
        # ``asyncio.timeout`` — a timed-out gather CANCELLES the (pending)
        # completion futures, and a cancelled future reads as ``done()``
        # while the thread is still writing, destroying the liveness signal
        # ``_mark_unfinished_worker`` needs. With polling, a pending
        # completion future means exactly "thread still running", so the
        # marker step can distinguish a worker that resolved during the
        # grace (never write an orphan marker) from one that genuinely
        # outlived it (write the marker).
        pending = {worker for worker in workers if not worker.done()}
        deadline = time.monotonic() + self._straggler_grace
        while pending:
            now = time.monotonic()
            if now >= deadline:
                break
            await asyncio.sleep(min(_STRAGGLER_POLL_INTERVAL, deadline - now))
            pending = {worker for worker in pending if not worker.done()}
        if pending:
            self._mark_unfinished_worker()
            logger.warning(
                "build %s: operation worker(s) still running after %.1fs "
                "grace; state dir marked so a retry cannot reuse the "
                "unstable workspace",
                self._build_id,
                self._straggler_grace,
            )

    def _in_flight_worker_futures(
        self,
    ) -> tuple[concurrent.futures.Future[Any], ...]:
        """The operation runner's still-running worker futures (duck-typed).

        ``ExpressionBuildRunner`` exposes ``in_flight_workers()``; runners
        without the accessor simply have no trackable stragglers.
        """
        probe = getattr(self._operation_runner, "in_flight_workers", None)
        if probe is None:
            return ()
        with contextlib.suppress(Exception):
            workers = probe()
            return tuple(worker for worker in workers if not worker.done())
        return ()

    def _mark_unfinished_worker(self) -> None:
        """Record (durably, in the state dir) a worker that outlived the grace.

        K1 residual (Phase 4 review): the thread cannot be interrupted, so a
        same-build_id retry must not trust the workspace to be stable. The
        marker is a real exclusion: the next run polls it
        (``_exclude_unstable_workspace``) before executing any operation; the
        retry re-executes the failed operation (its attempt is FAILED, never
        reusable) and everything downstream via the digest closure, rewriting
        the same deterministic paths.

        K1 residual (wave 10): the marker is written ONLY when the straggler
        is genuinely still running (its raw completion future is pending) — a
        worker that resolved during the grace wait has already run its
        ``finally`` (which cleans any marker that existed), so writing a
        marker now would orphan it and block retries up to the poll cap. The
        write is atomic (temp file + rename) and the payload carries process
        identity (``pid`` + ``process_nonce``) and the straggler's
        ``worker_id`` so a retry can tell a live in-process straggler from a
        marker whose owning process is gone, and a worker's finally can
        remove only its own marker. After the write the straggler's future is
        re-checked: if it resolved between the probe and the write (its
        finally unlinked before the marker existed), the marker is dropped
        immediately.
        """
        pending = self._in_flight_worker_futures()
        if not pending:
            # The straggler(s) resolved during the grace wait: their finally
            # blocks already ran (and cleaned any marker that existed).
            # Writing a marker now would orphan it — no live worker would
            # ever remove it. Skip.
            return
        worker = pending[0]
        operation_id: str | None = None
        state = self._state
        if state is not None and state.inflight_attempt is not None:
            operation_id = state.inflight_attempt.operation_id
        payload = {
            "build_id": self._build_id,
            "operation_id": operation_id,
            "pid": os.getpid(),
            "process_nonce": _PROCESS_NONCE,
            "worker_id": getattr(worker, "worker_id", None),
            "ts": datetime.now(UTC).isoformat(),
        }
        marker = self._state_dir / ".worker_unfinished"
        with contextlib.suppress(OSError):
            self._state_dir.mkdir(parents=True, exist_ok=True)
            staged = self._state_dir / ".worker_unfinished.tmp"
            staged.write_text(
                json.dumps(payload, ensure_ascii=False) + "\n", "utf-8"
            )
            staged.replace(marker)
        # Write-then-verify: the named worker may have resolved between the
        # probe and the atomic rename (its finally unlinked before the marker
        # existed). Drop the marker so a retry is never blocked by an orphan.
        if worker.done():
            with contextlib.suppress(OSError):
                marker.unlink(missing_ok=True)

    def _register_worker_marker(self) -> None:
        """Point the operation runner's workers at the marker path.

        K1 residual (wave 9): the runner's worker threads remove
        ``.worker_unfinished`` from their ``finally`` when they truly
        finish, so a retry polling the marker observes the workspace
        stabilizing exactly when the straggler dies. Duck-typed like
        ``in_flight_workers``: runners without the accessor simply cannot
        clean the marker (the TTL/staleness path still unblocks a retry
        after a crash).
        """
        probe = getattr(self._operation_runner, "set_worker_marker_path", None)
        if probe is None:
            return
        with contextlib.suppress(Exception):
            probe(self._state_dir / ".worker_unfinished")

    async def _exclude_unstable_workspace(self) -> BuildRunOutcome | None:
        """Honor the worker-unfinished marker as a real exclusion.

        K1 residual (wave 9/10): the marker written by a grace-expired run
        means a worker thread may still be writing the build's deterministic
        paths. This runs BEFORE any operation of a same-build_id run
        executes. Wave 10 makes staleness a matter of PROCESS OWNERSHIP, not
        wall-clock age — the mtime TTL alone cannot establish process death,
        so a live in-process straggler must never be misclassified stale:

        - marker owned by THIS process (``pid`` + ``process_nonce`` match):
          the straggler thread is LIVE in-process. Poll every
          ``unstable_poll_interval`` until the worker's finally removes the
          marker, bounded by ``unstable_poll_cap``; if the cap expires the
          workspace is genuinely unstable — a retryable conflict is returned
          and the marker is NEVER auto-deleted (only the owning worker's
          finally may remove it);
        - marker owned by a DIFFERENT process (pid or nonce mismatch): the
          owning process is gone, so its worker threads are dead with it —
          remove the marker and proceed (no permanent block after a crash);
        - legacy wave-9 marker without ``pid``/``process_nonce``: fall back
          to the mtime TTL (``unstable_marker_ttl``) as the only staleness
          signal; fresh legacy markers are polled like any other.

        Returns ``None`` when the workspace is safe to execute.
        """
        marker = self._state_dir / ".worker_unfinished"
        if not marker.is_file():
            return None
        payload = self._read_marker_payload(marker)
        pid = payload.get("pid")
        process_nonce = payload.get("process_nonce")
        operation_id = payload.get("operation_id")
        if isinstance(pid, int) and isinstance(process_nonce, str):
            if pid == os.getpid() and process_nonce == _PROCESS_NONCE:
                logger.warning(
                    "build %s: previous run left an operation worker "
                    "unfinished (operation=%s) and it is LIVE in this "
                    "process; waiting for the worker's finally to remove "
                    "the marker before executing the plan",
                    self._build_id,
                    operation_id,
                )
            else:
                logger.warning(
                    "build %s: worker-unfinished marker owned by a dead "
                    "process (pid=%s); removing it and proceeding",
                    self._build_id,
                    pid,
                )
                with contextlib.suppress(OSError):
                    marker.unlink(missing_ok=True)
                return None
        else:
            # Legacy wave-9 marker without process identity: the mtime TTL
            # is the only staleness signal available.
            if self._worker_marker_is_stale(marker):
                logger.warning(
                    "build %s: stale legacy worker-unfinished marker "
                    "removed (mtime beyond %.1fs ttl)",
                    self._build_id,
                    self._unstable_marker_ttl,
                )
                with contextlib.suppress(OSError):
                    marker.unlink(missing_ok=True)
                return None
            logger.warning(
                "build %s: previous run left an operation worker unfinished "
                "(operation=%s); waiting for the worker to finish before "
                "executing the plan",
                self._build_id,
                operation_id,
            )
        try:
            async with asyncio.timeout(self._unstable_poll_cap):
                while marker.is_file():
                    await asyncio.sleep(self._unstable_poll_interval)
        except TimeoutError:
            logger.error(
                "build %s: worker-unfinished marker persisted beyond %.1fs; "
                "returning retryable conflict (workspace unstable)",
                self._build_id,
                self._unstable_poll_cap,
            )
            return self._outcome_unstable_conflict()
        return None

    def _read_marker_payload(self, marker: Path) -> dict[str, Any]:
        """Best-effort parse of the worker-unfinished marker ({} on failure)."""
        with contextlib.suppress(Exception):
            payload = json.loads(marker.read_text("utf-8"))
            if isinstance(payload, dict):
                return payload
        return {}

    def _worker_marker_is_stale(self, marker: Path) -> bool:
        """A legacy marker older than the TTL is stale (wave-10 fallback).

        Wave 9 relied on the mtime TTL alone; wave 10 uses it only for
        markers that predate the pid/process_nonce schema (no process
        identity to reason about). A marker older than ``unstable_marker_ttl``
        is removed; fresh legacy markers are polled like same-process ones.
        """
        try:
            return time.time() - marker.stat().st_mtime > self._unstable_marker_ttl
        except OSError:
            # The marker vanished while we looked; treat as gone (stable).
            return True

    def _outcome_unstable_conflict(self) -> BuildRunOutcome:
        """A retryable conflict: the workspace cannot be trusted right now.

        The tool maps failed+retryable outcomes to the generic retryable
        error envelope; the straggler that outlived the grace keeps the
        marker in place so the next retry re-checks it.
        """
        return BuildRunOutcome(
            status="failed",
            error=ErrorDetail(
                code=ErrorCode.TIMEOUT,
                message=(
                    f"build {self._build_id} state is unstable: a previous "
                    "operation worker is still running in this process "
                    "(worker-unfinished marker persisted beyond "
                    f"{self._unstable_poll_cap:.1f}s); retry later"
                ),
                retryable=True,
            ),
        )

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
        # H3 (Phase 4 review): propagate structured failure signals into the
        # outcome error details so callers never substring-match error text —
        # the typed reason_code (e.g. an empty source) and the operation that
        # was running when the build failed (which scopes a persisted manifest
        # to this attempt).
        details: dict[str, JsonValue] = {}
        reason_code = getattr(exc, "reason_code", None)
        if reason_code is not None:
            details["reason_code"] = str(reason_code)
        state = self._state
        if state is not None and state.inflight_attempt is not None:
            details["failed_operation"] = state.inflight_attempt.operation_id
        error = ErrorDetail(
            code=error_code,
            message=str(exc),
            retryable=error_code in (ErrorCode.TIMEOUT, ErrorCode.NETWORK_ERROR),
            details=details,
        )
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
