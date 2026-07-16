"""Admission and scheduling for durable task Runs."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, TypeVar

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactProducedPayload,
    ConversationCompactedPayload,
    EventEnvelope,
    RunCancelledPayload,
    RunCancelRequestedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunStartedPayload,
    RunStatus,
    StartRunRequest,
    StartTaskRequest,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    WarningPayload,
    build_event,
    generate_run_id,
    generate_task_id,
)
from app.domain.contracts.runtime import validate_task_databases
from app.runtime.hub import EventHub
from app.runtime.repository import TaskNotFoundError, TaskRepository

logger = logging.getLogger(__name__)

_ResultT = TypeVar("_ResultT")

_TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}


class StreamingRunResult(Protocol):
    """Cancellation surface provided by the Agents SDK streaming result."""

    def cancel(
        self,
        mode: Literal["immediate", "after_turn"] = "immediate",
    ) -> None: ...


class RunEventEmitter(Protocol):
    async def __call__(
        self,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> TaskSnapshot: ...


RunCompactionCommit = Callable[
    [Mapping[str, object], ConversationCompactedPayload],
    Awaitable[bool],
]
RunCompletionCommit = Callable[[], Awaitable[list[EventEnvelope]]]


@dataclass(slots=True)
class RunExecution:
    """Run identity, context, and cancellation coordination for an executor."""

    task_id: str
    run_id: str
    request_id: str
    input: str
    context: RunContext
    mode: TaskMode = TaskMode.AGENT
    databases: list[str] = field(default_factory=list)
    _event_emitter: RunEventEmitter | None = field(default=None, repr=False)
    _compaction_committer: RunCompactionCommit | None = field(
        default=None,
        repr=False,
    )
    _completion_committer: RunCompletionCommit | None = field(
        default=None,
        repr=False,
    )
    _streaming_result: StreamingRunResult | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _stream_ready: asyncio.Event = field(
        default_factory=asyncio.Event,
        init=False,
        repr=False,
    )
    _drained: asyncio.Event = field(
        default_factory=asyncio.Event,
        init=False,
        repr=False,
    )
    _cancel_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock,
        init=False,
        repr=False,
    )
    _cancel_sent: bool = field(default=False, init=False, repr=False)
    _completion_sealed: bool = field(default=False, init=False, repr=False)

    def set_streaming_result(self, result: StreamingRunResult) -> None:
        if self._streaming_result is not None and self._streaming_result is not result:
            raise RuntimeError("streaming result is already attached")
        self._streaming_result = result
        self._stream_ready.set()

    async def emit(
        self,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> TaskSnapshot:
        """Persist one Run activity event through manager serialization."""

        if self._event_emitter is None:
            raise RuntimeError("run execution has no event emitter")
        if stage_attempt_id is None and timestamp is None:
            return await self._event_emitter(payload)
        return await self._event_emitter(
            payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
        )

    async def commit_compaction(
        self,
        record: Mapping[str, object],
        payload: ConversationCompactedPayload,
    ) -> bool:
        """Commit summary state and its event under manager serialization."""

        if self._compaction_committer is None:
            raise RuntimeError("run execution has no compaction committer")
        return await self._compaction_committer(record, payload)

    def set_completion_committer(self, committer: RunCompletionCommit) -> None:
        """Attach the executor's one-shot formal publication operation."""

        if self._completion_committer is not None:
            raise RuntimeError("completion committer is already attached")
        if self._completion_sealed:
            raise RuntimeError("run completion is already sealed")
        self._completion_committer = committer

    async def commit_completion(self) -> list[EventEnvelope]:
        if not self._completion_sealed:
            raise RuntimeError("run completion must be sealed before commit")
        if self._completion_committer is None:
            return []
        return await self._completion_committer()

    def request_cancellation(self) -> bool:
        """Set the cooperative token unless formal completion already won."""

        if self._completion_sealed:
            return False
        self.context.cancellation_requested.set()
        return True

    def seal_completion(self) -> None:
        """Choose completion as the winner over all later cancel requests."""

        if self.context.cancellation_requested.is_set():
            raise RuntimeError("cannot seal completion after cancellation")
        self._completion_sealed = True

    async def wait_for_streaming_result(self) -> StreamingRunResult | None:
        if self._streaming_result is not None or self._drained.is_set():
            return self._streaming_result
        stream_ready = asyncio.create_task(self._stream_ready.wait())
        drained = asyncio.create_task(self._drained.wait())
        done, pending = await asyncio.wait(
            {stream_ready, drained},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
        return self._streaming_result

    async def wait_until_drained(self) -> None:
        await self._drained.wait()

    async def cancel_after_turn(self) -> None:
        async with self._cancel_lock:
            if self._cancel_sent:
                return
            streaming_result = await self.wait_for_streaming_result()
            if streaming_result is not None:
                streaming_result.cancel("after_turn")
            self._cancel_sent = True

    def _mark_drained(self) -> None:
        self._drained.set()


RunExecutor = Callable[[RunExecution], Awaitable[None]]
RunContextFactory = Callable[[str], RunContext]


class TaskRunConflictError(RuntimeError):
    """Raised when a Task already owns a nonterminal Run."""

    def __init__(self, task_id: str, active_run_id: str) -> None:
        self.task_id = task_id
        self.active_run_id = active_run_id
        super().__init__(f"task {task_id} already has active run {active_run_id}")


class RequestIdConflictError(RuntimeError):
    """Raised when a request id already belongs to a different Task."""

    def __init__(
        self,
        request_id: str,
        existing_task_id: str,
        requested_task_id: str,
    ) -> None:
        self.request_id = request_id
        self.existing_task_id = existing_task_id
        self.requested_task_id = requested_task_id
        super().__init__(
            f"request_id {request_id} belongs to task {existing_task_id}, "
            f"not {requested_task_id}"
        )


class RunQueueFullError(RuntimeError):
    """Raised when all configured waiting-Run slots are occupied."""

    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        super().__init__(f"run queue is full ({maximum} waiting runs)")


class FixtureTaskContinuationError(RuntimeError):
    """Raised when a caller attempts to continue an immutable fixture Task."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"fixture task {task_id} cannot be continued")


class TaskDeletionConflictError(RuntimeError):
    """Raised when deletion targets a nonterminal or inconsistent Task."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"task {task_id} is not safely terminal")


@dataclass(frozen=True, slots=True)
class _QueuedRun:
    accepted: TaskRunAccepted
    input: str


def _run_key(accepted: TaskRunAccepted) -> tuple[str, str]:
    return accepted.task_id, accepted.run_id


class _RemovableRunQueue:
    """Bounded FIFO with keyed removal and asyncio-compatible join accounting."""

    def __init__(self, maxsize: int) -> None:
        self.maxsize = maxsize
        self._items: deque[_QueuedRun] = deque()
        self._keys: set[tuple[str, str]] = set()
        self._not_empty = asyncio.Event()
        self._finished = asyncio.Event()
        self._finished.set()
        self._unfinished_tasks = 0

    def qsize(self) -> int:
        return len(self._items)

    def empty(self) -> bool:
        return not self._items

    def full(self) -> bool:
        return len(self._items) >= self.maxsize

    def put_nowait(self, item: _QueuedRun) -> None:
        key = _run_key(item.accepted)
        if key in self._keys:
            raise ValueError(f"run is already queued: {item.accepted.run_id}")
        if self.full():
            raise asyncio.QueueFull
        self._items.append(item)
        self._keys.add(key)
        self._unfinished_tasks += 1
        self._finished.clear()
        self._not_empty.set()

    async def get(self) -> _QueuedRun:
        while not self._items:
            self._not_empty.clear()
            await self._not_empty.wait()
        item = self._items.popleft()
        self._keys.remove(_run_key(item.accepted))
        if not self._items:
            self._not_empty.clear()
        return item

    def remove(self, key: tuple[str, str]) -> _QueuedRun | None:
        if key not in self._keys:
            return None
        item = next(
            candidate
            for candidate in self._items
            if _run_key(candidate.accepted) == key
        )
        self._items.remove(item)
        self._keys.remove(key)
        if not self._items:
            self._not_empty.clear()
        self.task_done()
        return item

    def task_done(self) -> None:
        if self._unfinished_tasks <= 0:
            raise ValueError("task_done() called too many times")
        self._unfinished_tasks -= 1
        if self._unfinished_tasks == 0:
            self._finished.set()

    async def join(self) -> None:
        await self._finished.wait()

    def drain(self) -> list[_QueuedRun]:
        items = list(self._items)
        self._items.clear()
        self._keys.clear()
        self._not_empty.clear()
        for _ in items:
            self.task_done()
        return items


class TaskManager:
    """Persist Run lifecycle state and execute cross-task work concurrently."""

    def __init__(
        self,
        repository: TaskRepository,
        *,
        run_executor: RunExecutor,
        max_active_runs: int = 4,
        max_queued_runs: int = 100,
        context_factory: RunContextFactory | None = None,
        event_hub: EventHub | None = None,
    ) -> None:
        if max_active_runs < 1:
            raise ValueError("max_active_runs must be positive")
        if max_queued_runs < 1:
            raise ValueError("max_queued_runs must be positive")
        self.repository = repository
        self.run_executor = run_executor
        self.max_active_runs = max_active_runs
        self.max_queued_runs = max_queued_runs
        self.event_hub = event_hub or EventHub()
        self._context_factory = context_factory or (
            lambda task_id: RunContext(task_id=task_id)
        )
        self._queue = _RemovableRunQueue(max_queued_runs)
        self._semaphore = asyncio.Semaphore(max_active_runs)
        self._admission_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._task_locks: dict[str, asyncio.Lock] = {}
        self._running: dict[tuple[str, str], RunExecution] = {}
        self._active_cancellations: set[asyncio.Task[object]] = set()
        self._cancellations_drained = asyncio.Event()
        self._cancellations_drained.set()
        self._workers: list[asyncio.Task[None]] = []
        self._started = False
        self._closing = False
        self._closed = False

    async def start(self) -> None:
        if self._started:
            return
        if self._closing:
            raise RuntimeError("task manager is closing")
        await self.repository.initialize()
        await self._recover()
        self._workers = [
            asyncio.create_task(
                self._worker(),
                name=f"task-run-worker-{number}",
            )
            for number in range(self.max_active_runs)
        ]
        self._started = True

    async def close(self) -> None:
        async with self._lifecycle_lock:
            if self._closed:
                return
            async with self._admission_lock:
                self._closing = True
            try:
                if self._started:
                    for worker in self._workers:
                        worker.cancel()
                    await asyncio.gather(*self._workers, return_exceptions=True)
                    await self._cancellations_drained.wait()
                    self._workers.clear()
                    self._running.clear()
                    self._queue.drain()
                    self._started = False
            finally:
                await self.repository.close()
                self._closed = True

    async def submit_run(
        self,
        task_id: str,
        request: StartRunRequest,
    ) -> TaskRunAccepted:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        async with self._admission_lock:
            if not self._started or self._closing:
                raise RuntimeError("task manager is not running")
            candidate = await self.repository.get_snapshot(task_id)
            if candidate is not None and candidate.task.mode is TaskMode.FIXTURE:
                raise FixtureTaskContinuationError(task_id)
            existing = await self.repository.find_request(request.request_id)
            if existing is not None:
                if existing.task_id != task_id:
                    raise RequestIdConflictError(
                        request.request_id,
                        existing.task_id,
                        task_id,
                    )
                return existing
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:
                snapshot = await self.repository.get_snapshot(task_id)
                if snapshot is None:
                    raise LookupError(task_id)
                if snapshot.task.mode is TaskMode.FIXTURE:
                    raise FixtureTaskContinuationError(task_id)
                if snapshot.task.active_run_id is not None:
                    raise TaskRunConflictError(
                        task_id,
                        snapshot.task.active_run_id,
                    )
                if self._queue.full():
                    raise RunQueueFullError(self.max_queued_runs)
                accepted = TaskRunAccepted(
                    request_id=request.request_id,
                    task_id=task_id,
                    run_id=generate_run_id(),
                )
                return await self._shield_and_drain_locked(
                    self._admit_run_locked(
                        snapshot,
                        accepted,
                        request.input,
                    )
                )

    async def create_task(self, request: StartTaskRequest) -> TaskRunAccepted:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        async with self._admission_lock:
            if not self._started or self._closing:
                raise RuntimeError("task manager is not running")
            existing = await self.repository.find_request(request.request_id)
            if existing is not None:
                return existing
            validate_task_databases(request.mode, request.databases)
            if self._queue.full():
                raise RunQueueFullError(self.max_queued_runs)

            accepted = TaskRunAccepted(
                request_id=request.request_id,
                task_id=generate_task_id(),
                run_id=generate_run_id(),
            )
            created_at = datetime.now(UTC)
            snapshot = TaskSnapshot(
                task=TaskSummary(
                    task_id=accepted.task_id,
                    mode=request.mode,
                    databases=list(request.databases),
                    title=request.input,
                    status=RunStatus.QUEUED,
                    created_at=created_at,
                    updated_at=created_at,
                )
            )
            return await self._shield_and_drain_locked(
                self._create_and_admit_locked(
                    snapshot,
                    accepted,
                    request.input,
                )
            )

    async def delete_task(self, task_id: str) -> None:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        if not task_id or task_id in {".", ".."} or Path(task_id).name != task_id:
            raise LookupError(task_id)
        async with self._admission_lock:
            if not self._started or self._closing:
                raise RuntimeError("task manager is not running")
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:
                await self._shield_and_drain_locked(self._delete_task_locked(task_id))

    async def _shield_and_drain_locked(
        self,
        operation: Awaitable[_ResultT],
    ) -> _ResultT:
        operation_task = asyncio.create_task(operation)
        try:
            return await asyncio.shield(operation_task)
        except asyncio.CancelledError:
            while not operation_task.done():
                try:
                    await asyncio.shield(operation_task)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not operation_task.cancelled():
                operation_task.exception()
            raise

    async def _delete_task_locked(self, task_id: str) -> None:
        snapshot = await self.repository.get_snapshot(task_id)
        if snapshot is None:
            raise LookupError(task_id)
        if (
            snapshot.task.status not in _TERMINAL_RUN_STATUSES
            or snapshot.task.active_run_id is not None
            or any(run.status not in _TERMINAL_RUN_STATUSES for run in snapshot.runs)
        ):
            raise TaskDeletionConflictError(task_id)
        await self.repository.delete_task(task_id)

    async def _create_and_admit_locked(
        self,
        snapshot: TaskSnapshot,
        accepted: TaskRunAccepted,
        input_value: str,
    ) -> TaskRunAccepted:
        try:
            await self.repository.save_snapshot(snapshot)
        except Exception as error:
            try:
                await self.repository.delete_task(snapshot.task.task_id)
            except TaskNotFoundError:
                pass
            except Exception as rollback_error:
                error.add_note(
                    "initial task rollback also failed: "
                    f"{type(rollback_error).__name__}: {rollback_error}"
                )
            raise
        return await self._admit_run_locked(snapshot, accepted, input_value)

    async def _admit_run_locked(
        self,
        snapshot: TaskSnapshot,
        accepted: TaskRunAccepted,
        input_value: str,
    ) -> TaskRunAccepted:
        event = build_event(
            task_id=accepted.task_id,
            run_id=accepted.run_id,
            sequence=snapshot.task.latest_sequence + 1,
            payload=RunQueuedPayload(
                request_id=accepted.request_id,
                input=input_value,
            ),
        )
        await self.repository.append_event(event)
        try:
            await self.repository.record_request(accepted)
            await self.event_hub.publish(event)
        finally:
            self._queue.put_nowait(_QueuedRun(accepted=accepted, input=input_value))
        return accepted

    async def cancel_run(
        self,
        task_id: str,
        run_id: str,
        *,
        reason: str | None = None,
    ) -> TaskSnapshot:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        caller = asyncio.current_task()
        if caller is None:
            raise RuntimeError("cancellation requires an asyncio Task")
        async with self._admission_lock:
            if not self._started or self._closing:
                raise RuntimeError("task manager is not running")
            live_execution = self._running.get((task_id, run_id))
            if live_execution is not None:
                live_execution.request_cancellation()
            self._active_cancellations.add(caller)
            self._cancellations_drained.clear()
        try:
            return await self._shield_and_drain_locked(
                self._cancel_run(task_id, run_id, reason=reason)
            )
        finally:
            self._active_cancellations.discard(caller)
            if not self._active_cancellations:
                self._cancellations_drained.set()

    async def _cancel_run(
        self,
        task_id: str,
        run_id: str,
        *,
        reason: str | None = None,
    ) -> TaskSnapshot:
        live_execution = self._running.get((task_id, run_id))
        if live_execution is not None:
            live_execution.request_cancellation()
        lock = self._task_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            snapshot = await self.repository.get_snapshot(task_id)
            if snapshot is None:
                raise LookupError(task_id)
            run = next(
                (
                    candidate
                    for candidate in snapshot.runs
                    if candidate.run_id == run_id
                ),
                None,
            )
            if run is None:
                raise LookupError(run_id)
            if run.status is not RunStatus.QUEUED:
                if run.status is RunStatus.CANCELLED:
                    self._queue.remove((task_id, run_id))
                    self._running.pop((task_id, run_id), None)
                    return snapshot
                if run.status is RunStatus.CANCEL_REQUESTED and run.started_at is None:
                    accepted = TaskRunAccepted(
                        request_id=run.request_id,
                        task_id=task_id,
                        run_id=run_id,
                    )
                    return await self._append_status(
                        accepted,
                        RunCancelledPayload(reason=reason),
                        after_persist=lambda _: self._queue.remove((task_id, run_id)),
                    )
                if run.status not in {
                    RunStatus.RUNNING,
                    RunStatus.FINALIZING,
                    RunStatus.CANCEL_REQUESTED,
                }:
                    raise RuntimeError(f"run {run_id} is not cancellable")
                execution = self._running.get((task_id, run_id))
                if execution is None:
                    raise RuntimeError(f"run {run_id} has no live execution")
                execution.request_cancellation()
                accepted = TaskRunAccepted(
                    request_id=run.request_id,
                    task_id=task_id,
                    run_id=run_id,
                )
                if run.status is not RunStatus.CANCEL_REQUESTED:
                    await self._append_status(
                        accepted,
                        RunCancelRequestedPayload(reason=reason),
                    )
            else:
                accepted = TaskRunAccepted(
                    request_id=run.request_id,
                    task_id=task_id,
                    run_id=run_id,
                )
                await self._append_status(
                    accepted,
                    RunCancelRequestedPayload(reason=reason),
                    after_persist=lambda _: self._queue.remove((task_id, run_id)),
                )
                cancelled = await self._append_status(
                    accepted,
                    RunCancelledPayload(reason=reason),
                    after_persist=lambda _: self._queue.remove((task_id, run_id)),
                )
                return cancelled

        await execution.cancel_after_turn()
        await execution.wait_until_drained()
        async with lock:
            snapshot = await self.repository.get_snapshot(task_id)
            if snapshot is None:
                raise LookupError(task_id)
            run = next(
                candidate for candidate in snapshot.runs if candidate.run_id == run_id
            )
            if run.status is RunStatus.CANCELLED:
                self._running.pop((task_id, run_id), None)
                return snapshot
            if run.status is not RunStatus.CANCEL_REQUESTED:
                raise RuntimeError(f"run {run_id} left cancellation state")
            cancelled = await self._append_status(
                accepted,
                RunCancelledPayload(reason=reason),
                after_persist=lambda _: self._running.pop(
                    (task_id, run_id),
                    None,
                ),
            )
            return cancelled

    async def wait_until_idle(self) -> None:
        await self._queue.join()

    async def _recover(self) -> None:
        page = await self.repository.list_tasks(limit=1)
        queued: list[tuple[datetime, str, str, _QueuedRun]] = []
        recoverable = {
            RunStatus.QUEUED,
            RunStatus.RUNNING,
            RunStatus.FINALIZING,
            RunStatus.CANCEL_REQUESTED,
        }
        for summary in page.tasks:
            if summary.status not in recoverable or summary.active_run_id is None:
                continue
            snapshot = await self.repository.get_snapshot(summary.task_id)
            if snapshot is None:
                raise LookupError(summary.task_id)
            run = next(
                candidate
                for candidate in snapshot.runs
                if candidate.run_id == summary.active_run_id
            )
            accepted = TaskRunAccepted(
                request_id=run.request_id,
                task_id=summary.task_id,
                run_id=run.run_id,
            )
            if run.status is RunStatus.QUEUED:
                queued.append(
                    (
                        run.created_at,
                        summary.task_id,
                        run.run_id,
                        _QueuedRun(accepted=accepted, input=run.input),
                    )
                )
                continue
            lock = self._task_locks.setdefault(summary.task_id, asyncio.Lock())
            async with lock:
                await self._append_status(
                    accepted,
                    RunInterruptedPayload(reason="server restarted"),
                )

        for _, _, _, queued_run in sorted(queued):
            try:
                self._queue.put_nowait(queued_run)
            except asyncio.QueueFull as error:
                raise RunQueueFullError(self.max_queued_runs) from error

    async def _worker(self) -> None:
        while True:
            queued = await self._queue.get()
            try:
                async with self._semaphore:
                    await self._execute(queued)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await self._handle_worker_failure(queued, error)
            finally:
                self._queue.task_done()

    async def _handle_worker_failure(
        self,
        queued: _QueuedRun,
        error: Exception,
    ) -> None:
        accepted = queued.accepted
        logger.error(
            "run worker failed for task %s run %s",
            accepted.task_id,
            accepted.run_id,
            exc_info=(type(error), error, error.__traceback__),
        )
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        try:
            async with lock:
                snapshot = await self.repository.get_snapshot(accepted.task_id)
                if snapshot is None:
                    return
                run = next(
                    (
                        candidate
                        for candidate in snapshot.runs
                        if candidate.run_id == accepted.run_id
                    ),
                    None,
                )
                if run is None:
                    return
                if run.status in {RunStatus.RUNNING, RunStatus.FINALIZING}:
                    await self._append_status(
                        accepted,
                        RunFailedPayload(error=str(error) or type(error).__name__),
                    )
                if run.status is not RunStatus.CANCEL_REQUESTED:
                    self._running.pop(
                        (accepted.task_id, accepted.run_id),
                        None,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "failed to persist worker failure for task %s run %s",
                accepted.task_id,
                accepted.run_id,
            )

    async def _execute(self, queued: _QueuedRun) -> None:
        accepted = queued.accepted
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        async with lock:
            snapshot = await self.repository.get_snapshot(accepted.task_id)
            if snapshot is None:
                raise LookupError(accepted.task_id)
            run = next(
                candidate
                for candidate in snapshot.runs
                if candidate.run_id == accepted.run_id
            )
            if run.status is not RunStatus.QUEUED:
                return
            await self._append_status(accepted, RunStartedPayload())
            try:
                context = self._context_factory(accepted.task_id)
                execution = RunExecution(
                    task_id=accepted.task_id,
                    run_id=accepted.run_id,
                    request_id=accepted.request_id,
                    input=queued.input,
                    context=context,
                    mode=snapshot.task.mode,
                    databases=list(snapshot.task.databases),
                    _event_emitter=(
                        lambda payload, *, stage_attempt_id=None, timestamp=None: (
                            self._emit_activity(
                                accepted,
                                context,
                                payload,
                                stage_attempt_id=stage_attempt_id,
                                timestamp=timestamp,
                            )
                        )
                    ),
                    _compaction_committer=lambda record, payload: (
                        self._commit_compaction(
                            accepted,
                            context,
                            record,
                            payload,
                        )
                    ),
                )
            except Exception as error:
                await self._append_status(
                    accepted,
                    RunFailedPayload(error=str(error) or type(error).__name__),
                )
                raise
            self._running[(accepted.task_id, accepted.run_id)] = execution

        try:
            retain_cancellation = False
            error: BaseException | None = None
            try:
                await self.run_executor(execution)
            except asyncio.CancelledError as caught:
                worker_task = asyncio.current_task()
                if worker_task is not None and worker_task.cancelling() > 0:
                    raise
                error = caught
            except Exception as caught:
                error = caught
            finally:
                execution._mark_drained()

            async with lock:
                snapshot = await self.repository.get_snapshot(accepted.task_id)
                if snapshot is None:
                    raise LookupError(accepted.task_id)
                run = next(
                    candidate
                    for candidate in snapshot.runs
                    if candidate.run_id == accepted.run_id
                )
                if run.status is RunStatus.CANCEL_REQUESTED:
                    retain_cancellation = True
                    return
                if error is not None:
                    await self._append_status(
                        accepted,
                        RunFailedPayload(error=str(error) or type(error).__name__),
                    )
                    return
                await self._append_status(accepted, RunFinalizingPayload())
                if execution.context.cancellation_requested.is_set():
                    retain_cancellation = True
                    return
                execution.seal_completion()
                completion_events = await execution.commit_completion()
                for completion_event in completion_events:
                    await self._append_status(
                        accepted,
                        completion_event.payload,
                        stage_attempt_id=completion_event.stage_attempt_id,
                        timestamp=completion_event.timestamp,
                    )
                await self._append_status(accepted, RunCompletedPayload())
        finally:
            if not retain_cancellation:
                self._running.pop((accepted.task_id, accepted.run_id), None)

    async def _emit_activity(
        self,
        accepted: TaskRunAccepted,
        context: RunContext,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> TaskSnapshot:
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        async with lock:
            if context.cancellation_requested.is_set() and (
                isinstance(payload, ArtifactProducedPayload)
                or (
                    isinstance(payload, WarningPayload)
                    and payload.code == "compaction_failed"
                )
            ):
                snapshot = await self.repository.get_snapshot(accepted.task_id)
                if snapshot is None:
                    raise LookupError(accepted.task_id)
                return snapshot
            return await self._append_status(
                accepted,
                payload,
                stage_attempt_id=stage_attempt_id,
                timestamp=timestamp,
            )

    async def _commit_compaction(
        self,
        accepted: TaskRunAccepted,
        context: RunContext,
        record: Mapping[str, object],
        payload: ConversationCompactedPayload,
    ) -> bool:
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        async with lock:
            if context.cancellation_requested.is_set():
                return False
            previous = await self.repository.load_conversation_summary(accepted.task_id)
            if context.cancellation_requested.is_set():
                return False
            try:
                await self.repository.save_conversation_summary(
                    accepted.task_id,
                    record,
                )
            except asyncio.CancelledError:
                await self.repository.save_conversation_summary(
                    accepted.task_id,
                    previous,
                )
                raise
            if context.cancellation_requested.is_set():
                await self.repository.save_conversation_summary(
                    accepted.task_id,
                    previous,
                )
                return False
            event: EventEnvelope | None = None
            try:
                event = await self._build_status_event(accepted, payload)
                await self.repository.append_event(event)
            except BaseException as error:
                event_durable = event is not None and await self._event_is_durable(
                    event
                )
                if not event_durable:
                    await self.repository.save_conversation_summary(
                        accepted.task_id,
                        previous,
                    )
                    raise
                if isinstance(error, asyncio.CancelledError):
                    raise
                if isinstance(error, Exception):
                    logger.exception(
                        "durable compaction event projection failed for task %s run %s",
                        accepted.task_id,
                        accepted.run_id,
                    )
                    return True
                raise
            assert event is not None
            try:
                await self.event_hub.publish(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "failed to publish durable compaction event for task %s run %s",
                    accepted.task_id,
                    accepted.run_id,
                )
            return True

    async def _build_status_event(
        self,
        accepted: TaskRunAccepted,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> EventEnvelope:
        snapshot = await self.repository.get_snapshot(accepted.task_id)
        if snapshot is None:
            raise LookupError(accepted.task_id)
        return build_event(
            task_id=accepted.task_id,
            run_id=accepted.run_id,
            sequence=snapshot.task.latest_sequence + 1,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
        )

    async def _event_is_durable(self, expected: EventEnvelope) -> bool:
        events = await self.repository.list_events(
            expected.task_id,
            after_sequence=expected.sequence - 1,
            limit=1,
        )
        return any(event == expected for event in events)

    async def _persist_status(
        self,
        accepted: TaskRunAccepted,
        payload,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
        after_persist: Callable[[TaskSnapshot], None] | None = None,
    ) -> tuple[TaskSnapshot, EventEnvelope]:
        event = await self._build_status_event(
            accepted,
            payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
        )
        updated = await self.repository.append_event(event)
        if after_persist is not None:
            after_persist(updated)
        return updated, event

    async def _append_status(
        self,
        accepted: TaskRunAccepted,
        payload,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
        after_persist: Callable[[TaskSnapshot], None] | None = None,
    ) -> TaskSnapshot:
        updated, event = await self._persist_status(
            accepted,
            payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
            after_persist=after_persist,
        )
        await self.event_hub.publish(event)
        return updated


__all__ = [
    "FixtureTaskContinuationError",
    "RequestIdConflictError",
    "RunExecution",
    "RunEventEmitter",
    "RunCompactionCommit",
    "RunCompletionCommit",
    "RunExecutor",
    "StreamingRunResult",
    "RunQueueFullError",
    "TaskDeletionConflictError",
    "TaskManager",
    "TaskRunConflictError",
]
