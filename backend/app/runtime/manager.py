"""Admission and scheduling for durable task Runs."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    RunCancelRequestedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunStatus,
    RunStartedPayload,
    StartRunRequest,
    TaskRunAccepted,
    TaskSnapshot,
    build_event,
    generate_run_id,
)
from app.runtime.hub import EventHub
from app.runtime.repository import TaskRepository


logger = logging.getLogger(__name__)


class StreamingRunResult(Protocol):
    """Cancellation surface provided by the Agents SDK streaming result."""

    def cancel(
        self,
        mode: Literal["immediate", "after_turn"] = "immediate",
    ) -> None: ...


@dataclass(slots=True)
class RunExecution:
    """Run identity, context, and cancellation coordination for an executor."""

    task_id: str
    run_id: str
    request_id: str
    input: str
    context: RunContext
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

    def set_streaming_result(self, result: StreamingRunResult) -> None:
        if self._streaming_result is not None and self._streaming_result is not result:
            raise RuntimeError("streaming result is already attached")
        self._streaming_result = result
        self._stream_ready.set()

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


class RunQueueFullError(RuntimeError):
    """Raised when all configured waiting-Run slots are occupied."""

    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        super().__init__(f"run queue is full ({maximum} waiting runs)")


@dataclass(frozen=True, slots=True)
class _QueuedRun:
    accepted: TaskRunAccepted
    input: str


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
        self._queue: asyncio.Queue[_QueuedRun] = asyncio.Queue()
        self._waiting_run_keys: set[tuple[str, str]] = set()
        self._semaphore = asyncio.Semaphore(max_active_runs)
        self._admission_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._task_locks: dict[str, asyncio.Lock] = {}
        self._running: dict[tuple[str, str], RunExecution] = {}
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
                    self._workers.clear()
                    self._running.clear()
                    while not self._queue.empty():
                        queued = self._queue.get_nowait()
                        self._release_waiting_slot(queued.accepted)
                        self._queue.task_done()
                    self._waiting_run_keys.clear()
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
            existing = await self.repository.find_request(request.request_id)
            if existing is not None:
                return existing
            lock = self._task_locks.setdefault(task_id, asyncio.Lock())
            async with lock:
                snapshot = await self.repository.get_snapshot(task_id)
                if snapshot is None:
                    raise LookupError(task_id)
                if snapshot.task.active_run_id is not None:
                    raise TaskRunConflictError(
                        task_id,
                        snapshot.task.active_run_id,
                    )
                if len(self._waiting_run_keys) >= self.max_queued_runs:
                    raise RunQueueFullError(self.max_queued_runs)
                accepted = TaskRunAccepted(
                    request_id=request.request_id,
                    task_id=task_id,
                    run_id=generate_run_id(),
                )
                event = build_event(
                    task_id=task_id,
                    run_id=accepted.run_id,
                    sequence=snapshot.task.latest_sequence + 1,
                    payload=RunQueuedPayload(
                        request_id=request.request_id,
                        input=request.input,
                    ),
                )
                self._reserve_waiting_slot(accepted)
                try:
                    await self.repository.append_event(event)
                except BaseException:
                    self._release_waiting_slot(accepted)
                    raise
                try:
                    await self.event_hub.publish(event)
                    await self.repository.record_request(accepted)
                finally:
                    self._queue.put_nowait(
                        _QueuedRun(accepted=accepted, input=request.input)
                    )
                return accepted

    async def cancel_run(
        self,
        task_id: str,
        run_id: str,
        *,
        reason: str | None = None,
    ) -> TaskSnapshot:
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
                    self._running.pop((task_id, run_id), None)
                    return snapshot
                if run.status not in {
                    RunStatus.RUNNING,
                    RunStatus.FINALIZING,
                    RunStatus.CANCEL_REQUESTED,
                }:
                    raise RuntimeError(f"run {run_id} is not cancellable")
                execution = self._running.get((task_id, run_id))
                if execution is None:
                    raise RuntimeError(f"run {run_id} has no live execution")
                execution.context.cancellation_requested.set()
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
                )
                cancelled = await self._append_status(
                    accepted,
                    RunCancelledPayload(reason=reason),
                )
                self._release_waiting_slot(accepted)
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
                return snapshot
            if run.status is not RunStatus.CANCEL_REQUESTED:
                raise RuntimeError(f"run {run_id} left cancellation state")
            cancelled = await self._append_status(
                accepted,
                RunCancelledPayload(reason=reason),
            )
            self._running.pop((task_id, run_id), None)
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
            self._reserve_waiting_slot(queued_run.accepted)
            self._queue.put_nowait(queued_run)

    async def _worker(self) -> None:
        while True:
            queued = await self._queue.get()
            self._release_waiting_slot(queued.accepted)
            try:
                async with self._semaphore:
                    await self._execute(queued)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await self._handle_worker_failure(queued, error)
            finally:
                self._queue.task_done()

    def _reserve_waiting_slot(self, accepted: TaskRunAccepted) -> None:
        key = (accepted.task_id, accepted.run_id)
        if key in self._waiting_run_keys:
            return
        if len(self._waiting_run_keys) >= self.max_queued_runs:
            raise RunQueueFullError(self.max_queued_runs)
        self._waiting_run_keys.add(key)

    def _release_waiting_slot(self, accepted: TaskRunAccepted) -> bool:
        key = (accepted.task_id, accepted.run_id)
        if key not in self._waiting_run_keys:
            return False
        self._waiting_run_keys.remove(key)
        return True

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
            execution = RunExecution(
                task_id=accepted.task_id,
                run_id=accepted.run_id,
                request_id=accepted.request_id,
                input=queued.input,
                context=self._context_factory(accepted.task_id),
            )
            self._running[(accepted.task_id, accepted.run_id)] = execution
            await self._append_status(accepted, RunStartedPayload())

        try:
            retain_cancellation = False
            error: Exception | None = None
            try:
                await self.run_executor(execution)
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
                await self._append_status(accepted, RunCompletedPayload())
        finally:
            if not (
                retain_cancellation or execution.context.cancellation_requested.is_set()
            ):
                self._running.pop((accepted.task_id, accepted.run_id), None)

    async def _append_status(self, accepted: TaskRunAccepted, payload) -> TaskSnapshot:
        snapshot = await self.repository.get_snapshot(accepted.task_id)
        if snapshot is None:
            raise LookupError(accepted.task_id)
        event = build_event(
            task_id=accepted.task_id,
            run_id=accepted.run_id,
            sequence=snapshot.task.latest_sequence + 1,
            payload=payload,
        )
        updated = await self.repository.append_event(event)
        await self.event_hub.publish(event)
        return updated


__all__ = [
    "RunExecution",
    "RunExecutor",
    "StreamingRunResult",
    "RunQueueFullError",
    "TaskManager",
    "TaskRunConflictError",
]
