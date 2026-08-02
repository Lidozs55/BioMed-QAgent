"""Admission and scheduling for durable task Runs."""

from __future__ import annotations

import asyncio
import inspect
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
    AssistantStreamFrame,
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
    SubagentErrorCode,
    SubagentInterruptedPayload,
    SubagentResult,
    SubagentStatus,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    WarningPayload,
    generate_run_id,
    generate_task_id,
)
from app.domain.contracts.runtime import validate_task_databases
from app.runtime.hub import AssistantStreamHub, EventHub
from app.runtime.repository import TaskNotFoundError, TaskRepository
from app.subagents.event_sink import DurableSubagentEventSink
from app.subagents.input_broker import SubagentInputBroker
from app.subagents.supervisor import SubagentSupervisor

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


class AssistantStreamEmitter(Protocol):
    async def __call__(self, frame: AssistantStreamFrame) -> None: ...


RunCompactionCommit = Callable[
    [Mapping[str, object], ConversationCompactedPayload],
    Awaitable[bool],
]
RunCompletionCommit = Callable[[], Awaitable[list[EventEnvelope]]]
RunCompletionAbort = Callable[[], Awaitable[None]]
UserInputSubmitter = Callable[[UserInputResumedPayload], bool]
PrepareTask = Callable[[str], Awaitable[None]]


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
    _assistant_stream_emitter: AssistantStreamEmitter | None = field(
        default=None,
        repr=False,
    )
    _compaction_committer: RunCompactionCommit | None = field(
        default=None,
        repr=False,
    )
    _completion_committer: RunCompletionCommit | None = field(
        default=None,
        repr=False,
    )
    _completion_aborter: RunCompletionAbort | None = field(
        default=None,
        repr=False,
    )
    _commit_task: asyncio.Task[list[EventEnvelope]] | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _abort_task: asyncio.Task[None] | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _user_input_submitter: UserInputSubmitter | None = field(
        default=None,
        repr=False,
    )
    _pending_user_input_request_id: str | None = field(
        default=None,
        init=False,
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
    _completion_committed: bool = field(default=False, init=False, repr=False)
    _completion_abort_error: BaseException | None = field(
        default=None,
        init=False,
        repr=False,
    )
    _agent_executed: bool = field(default=False, init=False, repr=False)

    def set_streaming_result(self, result: StreamingRunResult) -> None:
        if self._streaming_result is not None and self._streaming_result is not result:
            raise RuntimeError("streaming result is already attached")
        self._streaming_result = result
        self._stream_ready.set()

    def reset_streaming_result(self) -> None:
        """Clear the streaming result so a new one can be attached.

        Used by ``AgentRunExecutor`` when resuming after ``max_turns``: the
        previous ``RunResultStreaming`` is exhausted, and a new
        ``Runner.run_streamed`` call needs to attach a fresh result for the
        cancellation channel to target the active SDK run. See
        docs/REVIEW_2026-07-18.md §11.
        """

        self._streaming_result = None
        self._stream_ready.clear()

    def set_user_input_submitter(self, submitter: UserInputSubmitter) -> None:
        """Attach the executor-side resume channel (e.g. PipelineRunner)."""

        if self._user_input_submitter is not None:
            raise RuntimeError("user input submitter is already attached")
        self._user_input_submitter = submitter

    def clear_user_input_submitter(self, submitter: UserInputSubmitter) -> None:
        """Clear a Tool-owned resume channel without removing a newer owner."""

        if self._user_input_submitter is submitter:
            self._user_input_submitter = None
            self._pending_user_input_request_id = None

    def submit_user_input(self, decision: UserInputResumedPayload) -> bool:
        """Forward a resume decision to the executor's user-input channel."""

        submitter = self._user_input_submitter
        if (
            submitter is None
            or self._pending_user_input_request_id != decision.request_id
        ):
            return False
        self._pending_user_input_request_id = None
        try:
            accepted = submitter(decision)
        except BaseException:
            self._pending_user_input_request_id = decision.request_id
            raise
        if not accepted:
            self._pending_user_input_request_id = decision.request_id
        return accepted

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
        pending_request_id: str | None = None
        if isinstance(payload, UserInputRequiredPayload) and not payload.fixture_exempt:
            if self._user_input_submitter is None:
                raise RuntimeError("user input request has no live submitter")
            if self._pending_user_input_request_id is not None:
                raise RuntimeError("user input request is already pending")
            pending_request_id = payload.request_id
            self._pending_user_input_request_id = pending_request_id
        try:
            if stage_attempt_id is None and timestamp is None:
                return await self._event_emitter(payload)
            return await self._event_emitter(
                payload,
                stage_attempt_id=stage_attempt_id,
                timestamp=timestamp,
            )
        except BaseException:
            if self._pending_user_input_request_id == pending_request_id:
                self._pending_user_input_request_id = None
            raise

    async def emit_assistant_stream(self, frame: AssistantStreamFrame) -> None:
        """Publish one best-effort, non-durable frame for this exact Run."""

        if frame.task_id != self.task_id or frame.run_id != self.run_id:
            raise ValueError("assistant stream frame identity does not match execution")
        if self._assistant_stream_emitter is None:
            return
        try:
            await self._assistant_stream_emitter(frame)
        except Exception:
            logger.exception(
                "assistant stream publish failed for task_id=%s run_id=%s",
                self.task_id,
                self.run_id,
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

    def set_completion_operations(
        self,
        committer: RunCompletionCommit,
        aborter: RunCompletionAbort,
    ) -> None:
        """Atomically attach one managed package's commit and abort operations."""

        if self._completion_committer is not None or self._completion_aborter is not None:
            raise RuntimeError("completion operations are already attached")
        if self._completion_sealed:
            raise RuntimeError("run completion is already sealed")
        self._completion_committer = committer
        self._completion_aborter = aborter

    def set_completion_cleanup(self, aborter: RunCompletionAbort) -> None:
        """Attach cleanup-only ownership after a pre-transfer abort failure."""

        if self._completion_committer is not None or self._completion_aborter is not None:
            raise RuntimeError("completion operations are already attached")
        if self._completion_sealed:
            raise RuntimeError("run completion is already sealed")
        self._completion_aborter = aborter

    async def commit_completion(self) -> list[EventEnvelope]:
        if not self._completion_sealed:
            raise RuntimeError("run completion must be sealed before commit")
        if self._completion_committer is None:
            return []
        if self._abort_task is not None:
            raise RuntimeError("run completion abort already started")
        if self._commit_task is None:
            self._commit_task = asyncio.create_task(self._commit_completion_once())
        return await asyncio.shield(self._commit_task)

    async def _commit_completion_once(self) -> list[EventEnvelope]:
        if self._completion_committer is None:
            return []
        events = await self._completion_committer()
        self._completion_committed = True
        return events

    async def abort_completion(self) -> None:
        """Run cleanup once without letting a waiting caller cancel it."""

        if self._abort_task is None:
            self._abort_task = asyncio.create_task(self._abort_completion_once())
        await asyncio.shield(self._abort_task)

    async def _abort_completion_once(self) -> None:
        if self._commit_task is not None:
            try:
                await asyncio.shield(self._commit_task)
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.error(
                    "_commit_task failed in _abort_completion_once",
                    exc_info=True,
                )
        if self._completion_committed or self._completion_aborter is None:
            return
        try:
            await self._completion_aborter()
        except BaseException as error:
            self._completion_abort_error = error
            raise

    @property
    def completion_abort_error(self) -> BaseException | None:
        return self._completion_abort_error

    def discard_completion(self) -> None:
        """Release in-memory callbacks after durable completion or cleanup."""

        self._completion_committer = None
        self._completion_aborter = None

    def mark_agent_executed(self) -> None:
        """Mark that the real AgentRunExecutor completed this Run.

        Used by manager's success-evidence check to distinguish a real
        Agent executor that produced no artifacts from a mock executor
        used in tests. See docs/REVIEW_2026-07-18.md §1.
        """

        self._agent_executed = True

    @property
    def agent_executed(self) -> bool:
        return self._agent_executed

    def request_cancellation(self) -> bool:
        """Set the cooperative token unless formal completion already won."""

        if self._completion_sealed:
            return False
        self.context.cancellation_requested.set()
        return True

    def request_compaction(self) -> bool:
        """Signal the agent loop to compact at its next preflight check."""

        if self._completion_sealed:
            return False
        self.context.compaction_requested.set()
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


class RunAdmission(Protocol):
    """Synchronous policy gate evaluated before a model-backed Run is durable."""

    def __call__(self, mode: TaskMode) -> None: ...


class RunAdmissionRejectedError(RuntimeError):
    """Raised when active runtime policy disallows a new model-backed Run."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


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


@dataclass(slots=True)
class _DispatchOutcome:
    """Mutable dispatch state shared between _dispatch_run and _finalize_run."""

    retain_cancellation: bool = False
    completion_durable: bool = False
    completion_cleanup_attempted: bool = False


@dataclass(frozen=True, slots=True)
class _ExecutionState:
    """Frozen state carried between _execute phases.

    The ``outcome`` field is a mutable object, so ``_dispatch_run`` can record
    dispatch/finalization results that ``_finalize_run`` reads in the finally
    block. The frozen constraint only prevents reassigning the fields, not
    mutating the ``_DispatchOutcome`` instance.
    """

    accepted: TaskRunAccepted
    lock: asyncio.Lock
    execution: RunExecution
    outcome: _DispatchOutcome


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
        run_admission: RunAdmission | None = None,
        event_hub: EventHub | None = None,
        assistant_stream_hub: AssistantStreamHub | None = None,
        subagent_supervisor: SubagentSupervisor | None = None,
        subagent_input_broker: SubagentInputBroker | None = None,
        subagent_event_sink: DurableSubagentEventSink | None = None,
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
        self.assistant_stream_hub = assistant_stream_hub
        self._subagent_supervisor = subagent_supervisor
        self._subagent_input_broker = subagent_input_broker
        self._subagent_event_sink = subagent_event_sink or DurableSubagentEventSink(
            repository=repository,
            hub=self.event_hub,
        )
        if context_factory is None:
            self._context_factory = lambda task_id: RunContext(
                task_id=task_id,
                base_dir=repository.tasks_dir,
            )
        else:
            self._context_factory = context_factory
        self._run_admission = run_admission
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

    def attach_subagent_runtime(
        self,
        *,
        supervisor: SubagentSupervisor,
        input_broker: SubagentInputBroker,
        event_sink: DurableSubagentEventSink,
    ) -> None:
        """Attach lifespan-owned child runtime services before startup."""

        if self._started or self._closing or self._closed:
            raise RuntimeError("subagent runtime must be attached before manager start")
        self._subagent_supervisor = supervisor
        self._subagent_input_broker = input_broker
        self._subagent_event_sink = event_sink
        attach = getattr(self.run_executor, "attach_subagent_runtime", None)
        if callable(attach):
            try:
                parameters = inspect.signature(attach).parameters
            except (TypeError, ValueError):
                parameters = {}
            accepts_input_broker = (
                not parameters
                or "input_broker" in parameters
                or any(
                    parameter.kind is inspect.Parameter.VAR_KEYWORD
                    for parameter in parameters.values()
                )
            )
            attach_kwargs: dict[str, object] = {
                "supervisor": supervisor,
                "event_sink": event_sink,
            }
            if accepts_input_broker:
                attach_kwargs["input_broker"] = input_broker
            attach(**attach_kwargs)

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
                self._check_run_admission(snapshot.task.mode)
                if self._queue.full():
                    raise RunQueueFullError(self.max_queued_runs)
                accepted = TaskRunAccepted(
                    request_id=request.request_id,
                    task_id=task_id,
                    run_id=generate_run_id(),
                )
                return await self._shield_and_drain_locked(
                    self._admit_run_locked(
                        accepted,
                        request.input,
                    )
                )

    async def create_task(
        self,
        request: StartTaskRequest,
        *,
        prepare_task: PrepareTask | None = None,
    ) -> TaskRunAccepted:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        async with self._admission_lock:
            if not self._started or self._closing:
                raise RuntimeError("task manager is not running")
            existing = await self.repository.find_request(request.request_id)
            if existing is not None:
                return existing
            validate_task_databases(request.mode, request.databases)
            self._check_run_admission(request.mode)
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
                    prepare_task,
                )
            )

    def _check_run_admission(self, mode: TaskMode) -> None:
        """Apply the injected model-readiness policy only to model-backed modes."""

        if mode in {TaskMode.AGENT, TaskMode.IMPORT} and self._run_admission is not None:
            self._run_admission(mode)

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
        prepare_task: PrepareTask | None,
    ) -> TaskRunAccepted:
        try:
            await self.repository.save_snapshot(snapshot)
            if prepare_task is not None:
                await prepare_task(snapshot.task.task_id)
        except BaseException as error:
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
        return await self._admit_run_locked(accepted, input_value)

    async def _admit_run_locked(
        self,
        accepted: TaskRunAccepted,
        input_value: str,
    ) -> TaskRunAccepted:
        _, event = await self.repository.append_event_payload(
            task_id=accepted.task_id,
            run_id=accepted.run_id,
            payload=RunQueuedPayload(
                request_id=accepted.request_id,
                input=input_value,
            ),
        )
        try:
            await self.repository.task_session(accepted.task_id).add_run_input_once(
                accepted.run_id,
                input_value,
            )
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
                    await self._append_status(
                        accepted,
                        RunCancelledPayload(reason=reason),
                        after_persist=lambda _: self._queue.remove((task_id, run_id)),
                    )
                    return await self._require_snapshot(task_id)
                if run.status not in {
                    RunStatus.RUNNING,
                    RunStatus.AWAITING_USER_INPUT,
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
                await self._append_status(
                    accepted,
                    RunCancelledPayload(reason=reason),
                    after_persist=lambda _: self._queue.remove((task_id, run_id)),
                )
                return await self._require_snapshot(task_id)

        await execution.cancel_after_turn()
        await execution.wait_until_drained()
        if execution.completion_abort_error is not None:
            raise RuntimeError("completion abort failed") from (
                execution.completion_abort_error
            )
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
            await self._append_status(
                accepted,
                RunCancelledPayload(reason=reason),
                after_persist=lambda _: self._running.pop(
                    (task_id, run_id),
                    None,
                ),
            )
            return await self._require_snapshot(task_id)

    async def _require_snapshot(self, task_id: str) -> TaskSnapshot:
        snapshot = await self.repository.get_snapshot(task_id)
        if snapshot is None:
            raise LookupError(task_id)
        return snapshot

    async def cancel_subagent(
        self,
        task_id: str,
        run_id: str,
        subagent_id: str,
        *,
        reason: str | None = None,
    ) -> TaskSnapshot:
        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")

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
            subagent = next(
                (
                    candidate
                    for candidate in snapshot.subagents
                    if candidate.subagent_id == subagent_id
                    and candidate.task_id == task_id
                    and candidate.run_id == run_id
                ),
                None,
            )
            if subagent is None:
                raise LookupError(subagent_id)
            if subagent.status in {
                SubagentStatus.COMPLETED,
                SubagentStatus.FAILED,
                SubagentStatus.CANCELLED,
                SubagentStatus.INTERRUPTED,
            }:
                raise RuntimeError(
                    f"subagent {subagent_id} is not cancellable"
                )
            supervisor = self._subagent_supervisor
            if supervisor is None:
                raise RuntimeError("subagent runtime is unavailable")
            try:
                await supervisor.cancel(subagent_id, reason=reason)
            except LookupError as error:
                raise RuntimeError("subagent runtime is unavailable") from error
            return await self._require_snapshot(task_id)

    async def request_compaction(self, task_id: str, run_id: str) -> None:
        """Signal a running execution to compact at its next preflight check.

        Raises ``LookupError`` when no live execution matches the given
        task/run pair.
        """

        live_execution = self._running.get((task_id, run_id))
        if live_execution is None:
            raise LookupError(f"no active execution for {task_id}/{run_id}")
        live_execution.request_compaction()

    async def resume_run(
        self,
        task_id: str,
        run_id: str,
        *,
        request_id: str,
        decision: Literal["approve", "reject"],
        detail: dict[str, object] | None = None,
    ) -> TaskSnapshot:
        """Submit a human-in-the-loop resume decision to a paused run.

        Validates that the run is in ``AWAITING_USER_INPUT`` state and that
        ``request_id`` matches the pending request, then forwards the decision
        to the executor's user-input channel (e.g. PipelineRunner). The
        ``UserInputResumedPayload`` is persisted by the pipeline after the
        run wakes up, so this method returns the snapshot as-is if the
        executor has not yet emitted the resume event.
        """

        if not self._started or self._closing:
            raise RuntimeError("task manager is not running")
        if self._subagent_input_broker is not None and (
            await self._subagent_input_broker.try_resume(
                task_id=task_id,
                run_id=run_id,
                request_id=request_id,
                decision=decision,
                detail=detail,
            )
        ):
            return await self._require_snapshot(task_id)
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
            if run.status is not RunStatus.AWAITING_USER_INPUT:
                raise RuntimeError(
                    f"run {run_id} is not awaiting user input "
                    f"(status: {run.status.value})"
                )
            live_execution = self._running.get((task_id, run_id))
            if live_execution is None:
                raise RuntimeError(f"run {run_id} has no live execution")
            payload = UserInputResumedPayload(
                request_id=request_id,
                decision=decision,
                detail=detail or {},
            )
            accepted = live_execution.submit_user_input(payload)
            if not accepted:
                raise RuntimeError(
                    f"run {run_id} executor rejected the resume decision"
                )
            return await self.repository.get_snapshot(task_id) or snapshot

    async def wait_until_idle(self) -> None:
        await self._queue.join()

    async def _recover(self) -> None:
        summaries: dict[str, TaskSummary] = {}
        cursor: str | None = None
        while True:
            page = await self.repository.list_tasks(
                limit=self.repository.settings.task_page_max_size,
                cursor=cursor,
            )
            summaries.update(
                (summary.task_id, summary) for summary in page.tasks
            )
            if page.next_cursor is None:
                break
            cursor = page.next_cursor

        queued: list[tuple[datetime, str, str, _QueuedRun]] = []
        recoverable = {
            RunStatus.QUEUED,
            RunStatus.RUNNING,
            RunStatus.FINALIZING,
            RunStatus.CANCEL_REQUESTED,
            RunStatus.AWAITING_USER_INPUT,
        }
        for summary in summaries.values():
            snapshot = await self.repository.get_snapshot(summary.task_id)
            if snapshot is None:
                raise LookupError(summary.task_id)
            if (
                summary.status in recoverable
                and summary.active_run_id is not None
            ):
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
                await self.repository.task_session(
                    summary.task_id
                ).add_run_input_once(
                    run.run_id,
                    run.input,
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
                else:
                    lock = self._task_locks.setdefault(
                        summary.task_id,
                        asyncio.Lock(),
                    )
                    async with lock:
                        await self._append_status(
                            accepted,
                            RunInterruptedPayload(reason="server restarted"),
                        )
                    snapshot = await self._require_snapshot(summary.task_id)

            await self._interrupt_terminal_parent_subagents(snapshot)

        for _, _, _, queued_run in sorted(queued):
            try:
                self._queue.put_nowait(queued_run)
            except asyncio.QueueFull as error:
                raise RunQueueFullError(self.max_queued_runs) from error

    async def _interrupt_terminal_parent_subagents(
        self,
        snapshot: TaskSnapshot,
    ) -> None:
        terminal_run_ids = {
            run.run_id
            for run in snapshot.runs
            if run.status in _TERMINAL_RUN_STATUSES
        }
        for subagent in snapshot.subagents:
            if (
                subagent.run_id not in terminal_run_ids
                or subagent.status
                not in {
                    SubagentStatus.QUEUED,
                    SubagentStatus.RUNNING,
                    SubagentStatus.CANCEL_REQUESTED,
                }
            ):
                continue
            await self._subagent_event_sink.emit(
                task_id=snapshot.task.task_id,
                run_id=subagent.run_id,
                subagent_id=subagent.subagent_id,
                parent_tool_call_id=subagent.parent_tool_call_id,
                payload=SubagentInterruptedPayload(
                    subagent_id=subagent.subagent_id,
                    result=SubagentResult(
                        subagent_id=subagent.subagent_id,
                        status=SubagentStatus.INTERRUPTED,
                        summary="Subagent interrupted after server restart",
                        error_code=SubagentErrorCode.INTERNAL_ERROR,
                        error_message="server restarted",
                    ),
                ),
            )

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
        state = await self._prepare_execution(queued)
        if state is None:
            return
        try:
            await self._dispatch_run(state)
        finally:
            await self._finalize_run(state)

    async def _prepare_execution(self, queued: _QueuedRun) -> _ExecutionState | None:
        """Acquire lock, read snapshot, validate state, and build RunExecution.

        Returns ``None`` when the run is no longer queued (skip silently).
        Raises when the task or run cannot be found, or when RunExecution
        construction fails (after persisting a RunFailedPayload).
        """

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
                return None
            await self._append_status(accepted, RunStartedPayload())
            try:
                context = self._context_factory(accepted.task_id)
                context.preferred_sources = list(snapshot.task.databases)
                context.bind_managed_run(accepted.run_id)
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
                    _assistant_stream_emitter=(
                        self.assistant_stream_hub.publish
                        if self.assistant_stream_hub is not None
                        else None
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
        return _ExecutionState(
            accepted=accepted,
            lock=lock,
            execution=execution,
            outcome=_DispatchOutcome(),
        )

    async def _dispatch_run(self, state: _ExecutionState) -> None:
        """Run the executor and finalize the completion state.

        Must be called inside ``_execute``'s try block so that
        ``_finalize_run`` always runs afterwards. All dispatch outcomes
        (success, failure, cancellation) are recorded on ``state.outcome``
        so the finally block can clean up correctly.
        """

        accepted = state.accepted
        lock = state.lock
        execution = state.execution
        outcome = state.outcome

        cleanup_error: BaseException | None = None
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

        if error is not None:
            outcome.completion_cleanup_attempted = True
            try:
                await self._abort_completion_and_drain(execution)
            except BaseException as caught:
                cleanup_error = caught
            else:
                execution.discard_completion()

        if error is not None:
            async with lock:
                snapshot = await self.repository.get_snapshot(accepted.task_id)
                if snapshot is None:
                    raise LookupError(accepted.task_id)
                run = next(
                    candidate
                    for candidate in snapshot.runs
                    if candidate.run_id == accepted.run_id
                )
                if (
                    run.status is RunStatus.CANCEL_REQUESTED
                    and cleanup_error is None
                ):
                    outcome.retain_cancellation = True
                    return
                await self._append_status(
                    accepted,
                    RunFailedPayload(
                        error=self._format_completion_error(error, cleanup_error)
                    ),
                )
                return

        finalization_error: BaseException | None = None
        try:
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
                    outcome.retain_cancellation = True
                    return
                await self._append_completion_status(
                    accepted,
                    RunFinalizingPayload(),
                )
                if execution.context.cancellation_requested.is_set():
                    outcome.retain_cancellation = True
                    return
                execution.seal_completion()
                completion_events = await execution.commit_completion()
                for completion_event in completion_events:
                    await self._append_completion_status(
                        accepted,
                        completion_event.payload,
                        stage_attempt_id=completion_event.stage_attempt_id,
                        timestamp=completion_event.timestamp,
                    )
                # 成功证据校验：AGENT 模式下若 AgentRunExecutor 真的跑过
                # 但未产出任何 artifact 事件，转 RunFailedPayload 而非
                # RunCompletedPayload。修复"LLM 完成但无 artifact"与
                # "LLM 截断静默完成"两个症状
                # (见 docs/REVIEW_2026-07-18.md §0、§1、§2)。
                # agent_executed 标记由 AgentRunExecutor 在真实 SDK result
                # 完成时设置，mock executor 不设置，避免破坏测试。
                if (
                    execution.mode is TaskMode.AGENT
                    and execution.agent_executed
                    and not completion_events
                    and not execution.context.cancellation_requested.is_set()
                ):
                    await self._append_status(
                        accepted,
                        RunFailedPayload(
                            error=(
                                "agent completed without producing any artifacts "
                                "(manifest missing or unchanged)"
                            ),
                        ),
                    )
                    outcome.completion_durable = True
                    execution.discard_completion()
                    return
                await self._append_completion_status(
                    accepted,
                    RunCompletedPayload(),
                )
                outcome.completion_durable = True
                execution.discard_completion()
        except asyncio.CancelledError as caught:
            worker_task = asyncio.current_task()
            if worker_task is not None and worker_task.cancelling() > 0:
                raise
            finalization_error = caught
        except Exception as caught:
            finalization_error = caught

        if finalization_error is not None:
            outcome.completion_cleanup_attempted = True
            cleanup_error = None
            try:
                await self._abort_completion_and_drain(execution)
            except BaseException as caught:
                cleanup_error = caught
            else:
                execution.discard_completion()
            async with lock:
                snapshot = await self.repository.get_snapshot(accepted.task_id)
                if snapshot is None:
                    raise LookupError(accepted.task_id)
                run = next(
                    candidate
                    for candidate in snapshot.runs
                    if candidate.run_id == accepted.run_id
                )
                if run.status is RunStatus.COMPLETED:
                    outcome.completion_durable = True
                    execution.discard_completion()
                    return
                await self._append_status(
                    accepted,
                    RunFailedPayload(
                        error=self._format_completion_error(
                            finalization_error,
                            cleanup_error,
                        )
                    ),
                )
            return

    async def _finalize_run(self, state: _ExecutionState) -> None:
        """Run completion cleanup after dispatch, whether or not it succeeded.

        Placed in ``_execute``'s finally block so it always runs. Reads the
        outcome flags set by ``_dispatch_run`` to decide whether to attempt
        a fallback abort and whether to retain the cancellation slot.
        """

        accepted = state.accepted
        execution = state.execution
        outcome = state.outcome
        try:
            if not outcome.completion_durable and not outcome.completion_cleanup_attempted:
                outcome.completion_cleanup_attempted = True
                try:
                    await self._abort_completion_and_drain(execution)
                except BaseException as cleanup_error:
                    outcome.retain_cancellation = False
                    await self._record_completion_cleanup_failure(
                        accepted,
                        cleanup_error,
                    )
                else:
                    execution.discard_completion()
        finally:
            execution._mark_drained()
            if not outcome.retain_cancellation:
                self._running.pop((accepted.task_id, accepted.run_id), None)

    @staticmethod
    async def _abort_completion_and_drain(execution: RunExecution) -> None:
        cleanup = asyncio.create_task(execution.abort_completion())
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        cleanup.result()

    async def _record_completion_cleanup_failure(
        self,
        accepted: TaskRunAccepted,
        cleanup_error: BaseException,
    ) -> None:
        lock = self._task_locks.setdefault(accepted.task_id, asyncio.Lock())
        async with lock:
            snapshot = await self.repository.get_snapshot(accepted.task_id)
            if snapshot is None:
                return
            run = next(
                candidate
                for candidate in snapshot.runs
                if candidate.run_id == accepted.run_id
            )
            if run.status not in {
                RunStatus.RUNNING,
                RunStatus.FINALIZING,
                RunStatus.CANCEL_REQUESTED,
            }:
                return
            await self._append_status(
                accepted,
                RunFailedPayload(
                    error=(
                        "completion abort failed: "
                        f"{type(cleanup_error).__name__}: {cleanup_error}"
                    )
                ),
            )

    @staticmethod
    def _format_completion_error(
        primary_error: BaseException,
        cleanup_error: BaseException | None,
    ) -> str:
        primary = str(primary_error) or type(primary_error).__name__
        if cleanup_error is None:
            return primary
        cleanup = str(cleanup_error) or type(cleanup_error).__name__
        return (
            f"{primary}; completion abort also failed: "
            f"{type(cleanup_error).__name__}: {cleanup}"
        )

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
            baseline = await self.repository.get_snapshot(accepted.task_id)
            if baseline is None:
                raise LookupError(accepted.task_id)
            try:
                _, event = await self.repository.append_event_payload(
                    task_id=accepted.task_id,
                    run_id=accepted.run_id,
                    payload=payload,
                )
            except BaseException as error:
                event = await self.repository.find_matching_event(
                    task_id=accepted.task_id,
                    run_id=accepted.run_id,
                    payload=payload,
                    after_sequence=baseline.task.latest_sequence,
                )
                if event is None:
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

    async def _event_is_durable(self, expected: EventEnvelope) -> bool:
        events = await self.repository.list_events(
            expected.task_id,
            after_sequence=expected.sequence - 1,
            limit=1,
        )
        return any(event == expected for event in events)

    async def _append_completion_status(
        self,
        accepted: TaskRunAccepted,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
    ) -> TaskSnapshot:
        """Persist completion state and reconcile projection-only failures."""

        await self._terminate_owned_subagents(accepted, payload)
        baseline = await self.repository.get_snapshot(accepted.task_id)
        if baseline is None:
            raise LookupError(accepted.task_id)
        event: EventEnvelope | None = None
        try:
            updated, event = await self.repository.append_event_payload(
                task_id=accepted.task_id,
                run_id=accepted.run_id,
                payload=payload,
                stage_attempt_id=stage_attempt_id,
                timestamp=timestamp,
            )
        except BaseException as error:
            event = await self.repository.find_matching_event(
                task_id=accepted.task_id,
                run_id=accepted.run_id,
                payload=payload,
                after_sequence=baseline.task.latest_sequence,
                stage_attempt_id=stage_attempt_id,
                timestamp=timestamp,
            )
            if event is None:
                raise
            current = asyncio.current_task()
            if (
                isinstance(error, asyncio.CancelledError)
                and current is not None
                and current.cancelling() > 0
            ):
                raise
            logger.error(
                "durable completion event projection failed for task %s run %s",
                accepted.task_id,
                accepted.run_id,
                exc_info=(type(error), error, error.__traceback__),
            )
            updated = await self._require_snapshot(accepted.task_id)
        assert event is not None
        try:
            await self.event_hub.publish(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not await self._event_is_durable(event):
                raise RuntimeError(
                    "completion event was not durable after projection failure"
                ) from error
            logger.error(
                "durable completion event projection failed for task %s run %s",
                accepted.task_id,
                accepted.run_id,
                exc_info=(type(error), error, error.__traceback__),
            )
        return updated

    async def _persist_status(
        self,
        accepted: TaskRunAccepted,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
        after_persist: Callable[[TaskSnapshot], None] | None = None,
    ) -> tuple[TaskSnapshot, EventEnvelope]:
        updated, event = await self.repository.append_event_payload(
            task_id=accepted.task_id,
            run_id=accepted.run_id,
            payload=payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
        )
        if after_persist is not None:
            after_persist(updated)
        return updated, event

    async def _append_status(
        self,
        accepted: TaskRunAccepted,
        payload: object,
        *,
        stage_attempt_id: str | None = None,
        timestamp: datetime | None = None,
        after_persist: Callable[[TaskSnapshot], None] | None = None,
    ) -> TaskSnapshot:
        await self._terminate_owned_subagents(accepted, payload)
        updated, event = await self._persist_status(
            accepted,
            payload,
            stage_attempt_id=stage_attempt_id,
            timestamp=timestamp,
            after_persist=after_persist,
        )
        await self.event_hub.publish(event)
        return updated

    async def _terminate_owned_subagents(
        self,
        accepted: TaskRunAccepted,
        payload: object,
    ) -> None:
        reason_by_type = {
            RunCompletedPayload: "parent run completed",
            RunFailedPayload: "parent run failed",
            RunCancelledPayload: "parent run cancelled",
            RunInterruptedPayload: "parent run interrupted",
        }
        reason = next(
            (
                message
                for payload_type, message in reason_by_type.items()
                if isinstance(payload, payload_type)
            ),
            None,
        )
        if reason is None:
            return
        if self._subagent_supervisor is not None:
            await self._subagent_supervisor.cancel_run(
                accepted.task_id,
                accepted.run_id,
                reason=reason,
            )
        if self._subagent_input_broker is not None:
            await self._subagent_input_broker.cancel_run(
                task_id=accepted.task_id,
                run_id=accepted.run_id,
            )
        if self._subagent_supervisor is not None:
            await self._subagent_supervisor.release_run(
                accepted.task_id,
                accepted.run_id,
            )


__all__ = [
    "FixtureTaskContinuationError",
    "RequestIdConflictError",
    "RunExecution",
    "RunEventEmitter",
    "RunCompactionCommit",
    "RunCompletionAbort",
    "RunCompletionCommit",
    "RunExecutor",
    "StreamingRunResult",
    "RunQueueFullError",
    "TaskDeletionConflictError",
    "TaskManager",
    "TaskRunConflictError",
]
