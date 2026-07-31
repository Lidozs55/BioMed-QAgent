"""Concurrency, lifecycle, and cancellation management for child agents."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable

from app.domain.contracts import (
    SubagentCancelledPayload,
    SubagentCancelRequestedPayload,
    SubagentCompletedPayload,
    SubagentErrorCode,
    SubagentFailedPayload,
    SubagentInterruptedPayload,
    SubagentQueuedPayload,
    SubagentRecord,
    SubagentRequest,
    SubagentResult,
    SubagentStartedPayload,
    SubagentStatus,
    generate_prefixed_uuid,
)
from app.domain.contracts.events import EventPayload
from app.subagents.input_broker import SubagentInputBroker


class SubagentEventSink(Protocol):
    async def emit(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None: ...


@runtime_checkable
class SubagentTerminalReconciler(Protocol):
    async def reconcile_terminal(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> bool: ...


@runtime_checkable
class SubagentAttemptLifecycle(Protocol):
    async def release_run_attempts(self, task_id: str, run_id: str) -> None: ...


class SubagentRunner(Protocol):
    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult: ...


@dataclass(slots=True)
class _SubagentEntry:
    task_id: str
    run_id: str
    parent_tool_call_id: str
    sink: SubagentEventSink
    terminal_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task[SubagentResult] | None = None
    result: SubagentResult | None = None
    pending_result: SubagentResult | None = None
    cancel_requested: bool = False
    forced_interruption: bool = False
    forced_interruption_reason: str | None = None
    sink_error: BaseException | None = None


class SubagentSupervisor:
    def __init__(
        self,
        *,
        global_limit: int = 4,
        per_run_limit: int = 3,
        batch_limit: int = 8,
        timeout_seconds: float = 3600,
        event_timeout_seconds: float = 30,
        input_broker: SubagentInputBroker | None = None,
    ) -> None:
        if global_limit < 1:
            raise ValueError("global_limit must be at least 1")
        if per_run_limit < 1:
            raise ValueError("per_run_limit must be at least 1")
        if not 1 <= batch_limit <= 8:
            raise ValueError("batch_limit must be between 1 and 8")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than 0")
        if event_timeout_seconds <= 0:
            raise ValueError("event_timeout_seconds must be greater than 0")

        self._global_semaphore = asyncio.Semaphore(global_limit)
        self._per_run_limit = per_run_limit
        self._batch_limit = batch_limit
        self._timeout_seconds = timeout_seconds
        self._event_timeout_seconds = event_timeout_seconds
        self._input_broker = input_broker
        self._run_semaphores: dict[tuple[str, str], asyncio.Semaphore] = {}
        self._entries: dict[str, _SubagentEntry] = {}
        self._admissions: dict[
            tuple[str, str],
            set[asyncio.Future[None]],
        ] = {}
        self._owner_lifecycle_sinks: dict[
            tuple[str, str],
            dict[int, SubagentAttemptLifecycle],
        ] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._shutdown_lock = asyncio.Lock()
        self._closed = False

    async def start_batch(
        self,
        *,
        task_id: str,
        run_id: str,
        parent_tool_call_id: str,
        requests: list[SubagentRequest],
        runner: SubagentRunner,
        sink: SubagentEventSink,
    ) -> list[SubagentRecord]:
        request_count = len(requests)
        if request_count < 1:
            raise ValueError("batch must contain at least 1 request")
        if request_count > self._batch_limit:
            raise ValueError(
                f"batch may contain at most {self._batch_limit} requests"
            )

        owner = (task_id, run_id)
        async with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("subagent supervisor has shut down")

            run_semaphore = self._run_semaphores.setdefault(
                owner,
                asyncio.Semaphore(self._per_run_limit),
            )
            admission = asyncio.get_running_loop().create_future()
            self._admissions.setdefault(owner, set()).add(admission)
            if isinstance(sink, SubagentAttemptLifecycle):
                self._owner_lifecycle_sinks.setdefault(owner, {})[
                    id(sink)
                ] = sink

        pending: list[
            tuple[SubagentRecord, SubagentRequest, _SubagentEntry]
        ] = []
        for request in requests:
            subagent_id = generate_prefixed_uuid("subagent")
            record = SubagentRecord(
                subagent_id=subagent_id,
                task_id=task_id,
                run_id=run_id,
                agent_type=request.agent_type,
                objective=request.objective,
                target_source=request.target_source,
                status=SubagentStatus.QUEUED,
                parent_tool_call_id=parent_tool_call_id,
                created_at=datetime.now(UTC),
                progress_current=0,
            )
            pending.append(
                (
                    record,
                    request,
                    _SubagentEntry(
                        task_id=task_id,
                        run_id=run_id,
                        parent_tool_call_id=parent_tool_call_id,
                        sink=sink,
                    ),
                )
            )

        attempted: list[
            tuple[SubagentRecord, SubagentRequest, _SubagentEntry]
        ] = []
        admission_finished = False
        try:
            for record, request, entry in pending:
                attempted.append((record, request, entry))
                await self._emit_to_sink(
                    sink=sink,
                    task_id=task_id,
                    run_id=run_id,
                    subagent_id=record.subagent_id,
                    parent_tool_call_id=parent_tool_call_id,
                    payload=SubagentQueuedPayload(
                        subagent_id=record.subagent_id,
                        request=request,
                    ),
                )

            async with self._lifecycle_lock:
                for record, request, entry in pending:
                    self._entries[record.subagent_id] = entry
                    entry.task = asyncio.create_task(
                        self._run_child(
                            entry=entry,
                            request=request,
                            runner=runner,
                            run_semaphore=run_semaphore,
                            subagent_id=record.subagent_id,
                        ),
                        name=f"subagent:{record.subagent_id}",
                    )
                self._finish_admission(owner, admission)
                admission_finished = True
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                current_task = asyncio.current_task()
                if current_task is not None:
                    current_task.uncancel()
            await self._cleanup_failed_admission(attempted, error)
            raise
        finally:
            if not admission_finished:
                async with self._lifecycle_lock:
                    self._finish_admission(owner, admission)

        return [record for record, _, _ in pending]

    async def wait(self, subagent_id: str) -> SubagentResult:
        entry = self._require_entry(subagent_id)
        if entry.result is not None:
            return entry.result
        if entry.task is None:
            raise RuntimeError("subagent was not scheduled")
        if not entry.task.done():
            await asyncio.shield(entry.task)
        try:
            return entry.task.result()
        except BaseException:
            if entry.pending_result is None:
                raise
        async with entry.terminal_lock:
            if entry.result is not None:
                return entry.result
            if entry.pending_result is None:
                raise RuntimeError("subagent terminal result is unavailable")
            return await self._persist_terminal_locked(
                entry,
                entry.pending_result,
            )

    async def cancel(
        self,
        subagent_id: str,
        *,
        reason: str | None = None,
    ) -> SubagentResult:
        entry = self._require_entry(subagent_id)
        async with entry.terminal_lock:
            if entry.result is not None:
                return entry.result
            if (
                entry.pending_result is not None
                and await self._promote_reconciled_terminal_locked(
                    entry,
                    subagent_id,
                )
            ):
                assert entry.result is not None
                return entry.result
            if not entry.cancel_requested:
                await self._emit(
                    entry,
                    subagent_id,
                    SubagentCancelRequestedPayload(
                        subagent_id=subagent_id,
                        reason=reason,
                    ),
                )
                await self._complete_cancel_finalization(entry, subagent_id)
            if entry.pending_result is not None:
                return await self._persist_terminal_locked(
                    entry,
                    entry.pending_result,
                )

        if entry.task is None:
            raise RuntimeError("subagent was not scheduled")
        return await asyncio.shield(entry.task)

    async def _complete_cancel_finalization(
        self,
        entry: _SubagentEntry,
        subagent_id: str,
    ) -> None:
        finalization = asyncio.create_task(
            self._finalize_cancel(entry, subagent_id),
            name=f"subagent-cancel-finalize:{subagent_id}",
        )
        try:
            await asyncio.shield(finalization)
        except asyncio.CancelledError:
            while not finalization.done():
                try:
                    await asyncio.shield(finalization)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not finalization.cancelled():
                finalization.exception()
            raise

    async def _finalize_cancel(
        self,
        entry: _SubagentEntry,
        subagent_id: str,
    ) -> None:
        entry.cancel_requested = True
        try:
            if self._input_broker is not None:
                await self._input_broker.cancel_subagent(
                    task_id=entry.task_id,
                    run_id=entry.run_id,
                    subagent_id=subagent_id,
                )
        except BaseException as error:
            entry.sink_error = entry.sink_error or error
        finally:
            if entry.task is not None:
                entry.task.cancel()

    async def _cancel_for_shutdown(
        self,
        subagent_id: str,
        *,
        reason: str,
    ) -> SubagentResult:
        entry = self._require_entry(subagent_id)
        async with entry.terminal_lock:
            if entry.result is not None:
                return entry.result
            if (
                entry.pending_result is not None
                and await self._promote_reconciled_terminal_locked(
                    entry,
                    subagent_id,
                )
            ):
                assert entry.result is not None
                return entry.result
            terminal_was_pending = entry.pending_result is not None
            if terminal_was_pending:
                entry.forced_interruption = True
                entry.forced_interruption_reason = reason
            if not entry.cancel_requested:
                try:
                    await self._emit(
                        entry,
                        subagent_id,
                        SubagentCancelRequestedPayload(
                            subagent_id=subagent_id,
                            reason=reason,
                        ),
                    )
                except BaseException as error:
                    entry.sink_error = error
                    entry.forced_interruption = True
                    entry.forced_interruption_reason = reason
                    if entry.task is not None:
                        entry.task.cancel()
                    raise
                entry.cancel_requested = True
                if self._input_broker is not None:
                    await self._input_broker.cancel_subagent(
                        task_id=entry.task_id,
                        run_id=entry.run_id,
                        subagent_id=subagent_id,
                    )
                if entry.task is not None:
                    entry.task.cancel()
            if terminal_was_pending:
                assert entry.pending_result is not None
                return await self._persist_terminal_locked(
                    entry,
                    entry.pending_result,
                )

        if entry.task is None:
            raise RuntimeError("subagent was not scheduled")
        return await asyncio.shield(entry.task)

    async def cancel_run(
        self,
        task_id: str,
        run_id: str,
        *,
        reason: str | None = None,
    ) -> list[SubagentResult]:
        subagent_ids = await self._owner_active_ids((task_id, run_id))
        if not subagent_ids:
            return []
        return list(
            await asyncio.gather(
                *(
                    self.cancel(subagent_id, reason=reason)
                    for subagent_id in subagent_ids
                )
            )
        )

    async def release_run(self, task_id: str, run_id: str) -> None:
        owner = (task_id, run_id)
        while True:
            await self._wait_for_owner_admissions(owner)
            async with self._lifecycle_lock:
                if owner in self._admissions:
                    continue
                entries = [
                    (subagent_id, entry)
                    for subagent_id, entry in self._entries.items()
                    if (entry.task_id, entry.run_id) == owner
                ]
                if any(
                    entry.result is None
                    or entry.task is None
                    or not entry.task.done()
                    for _, entry in entries
                ):
                    raise RuntimeError(
                        "cannot release run with nonterminal subagents"
                    )
                sinks = self._owner_lifecycle_sinks.setdefault(owner, {})
                for sink_id, sink in tuple(sinks.items()):
                    await sink.release_run_attempts(task_id, run_id)
                    current = self._owner_lifecycle_sinks.get(owner)
                    if current is not None and current.get(sink_id) is sink:
                        current.pop(sink_id, None)
                if not sinks:
                    self._owner_lifecycle_sinks.pop(owner, None)
                for subagent_id, _ in entries:
                    self._entries.pop(subagent_id, None)
                if (
                    not self._owner_has_entries(owner)
                    and owner not in self._admissions
                ):
                    self._run_semaphores.pop(owner, None)
                return

    async def shutdown(self) -> None:
        async with self._shutdown_lock:
            async with self._lifecycle_lock:
                self._closed = True
                admissions = [
                    admission
                    for owner_admissions in self._admissions.values()
                    for admission in owner_admissions
                ]

            if admissions:
                await asyncio.gather(
                    *(asyncio.shield(admission) for admission in admissions),
                    return_exceptions=True,
                )

            async with self._lifecycle_lock:
                active_ids = [
                    subagent_id
                    for subagent_id, entry in self._entries.items()
                    if entry.result is None
                ]

            if active_ids:
                outcomes = await asyncio.gather(
                    *(
                        self._cancel_for_shutdown(
                            subagent_id,
                            reason="subagent supervisor shutdown",
                        )
                        for subagent_id in active_ids
                    ),
                    return_exceptions=True,
                )
                for subagent_id, outcome in zip(active_ids, outcomes, strict=True):
                    if isinstance(outcome, BaseException):
                        entry = self._entries.get(subagent_id)
                        if entry is not None and entry.task is not None:
                            entry.sink_error = entry.sink_error or outcome
                            entry.forced_interruption = True
                            entry.forced_interruption_reason = (
                                entry.forced_interruption_reason
                                or "subagent supervisor shutdown"
                            )
                            entry.task.cancel()

            tasks = [
                entry.task
                for entry in self._entries.values()
                if entry.task is not None and not entry.task.done()
            ]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_child(
        self,
        *,
        entry: _SubagentEntry,
        request: SubagentRequest,
        runner: SubagentRunner,
        run_semaphore: asyncio.Semaphore,
        subagent_id: str,
    ) -> SubagentResult:
        try:
            async with run_semaphore, self._global_semaphore:
                await self._emit(
                    entry,
                    subagent_id,
                    SubagentStartedPayload(subagent_id=subagent_id),
                )
                async with asyncio.timeout(self._timeout_seconds):
                    result = await runner.run(
                        request,
                        subagent_id=subagent_id,
                        task_id=entry.task_id,
                        run_id=entry.run_id,
                    )
                if result.subagent_id != subagent_id:
                    raise ValueError(
                        "runner result subagent_id does not match child"
                    )
        except TimeoutError:
            result = SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.FAILED,
                summary="Subagent timed out",
                error_code=SubagentErrorCode.TIMED_OUT,
                error_message=(
                    f"Execution exceeded {self._timeout_seconds} seconds"
                ),
            )
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if current_task is not None:
                current_task.uncancel()
            result = self._task_cancelled_result(entry, subagent_id)
        except Exception as error:
            result = SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.FAILED,
                summary="Subagent failed unexpectedly",
                error_code=SubagentErrorCode.INTERNAL_ERROR,
                error_message=str(error) or type(error).__name__,
            )

        try:
            return await self._publish_terminal(entry, result)
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if current_task is not None:
                current_task.uncancel()
            return await self._publish_terminal(
                entry,
                self._task_cancelled_result(entry, subagent_id),
            )

    async def _publish_terminal(
        self,
        entry: _SubagentEntry,
        result: SubagentResult,
    ) -> SubagentResult:
        async with entry.terminal_lock:
            if entry.result is not None:
                return entry.result
            return await self._persist_terminal_locked(entry, result)

    async def _persist_terminal_locked(
        self,
        entry: _SubagentEntry,
        result: SubagentResult,
    ) -> SubagentResult:
        pending = entry.pending_result
        if entry.forced_interruption:
            result = self._task_cancelled_result(
                entry,
                result.subagent_id,
            )
        elif (
            entry.cancel_requested
            and result.status is not SubagentStatus.CANCELLED
        ):
            result = self._cancelled_result(result.subagent_id)
        elif pending is not None:
            result = pending
        entry.pending_result = result

        payload = self._terminal_payload(result)
        try:
            await self._emit(entry, result.subagent_id, payload)
        except BaseException as error:
            entry.sink_error = entry.sink_error or error
            raise
        entry.pending_result = None
        entry.result = result
        return result

    async def _promote_reconciled_terminal_locked(
        self,
        entry: _SubagentEntry,
        subagent_id: str,
    ) -> bool:
        pending = entry.pending_result
        if pending is None or not isinstance(
            entry.sink,
            SubagentTerminalReconciler,
        ):
            return False
        payload = self._terminal_payload(pending)
        async with asyncio.timeout(self._event_timeout_seconds):
            durable = await entry.sink.reconcile_terminal(
                task_id=entry.task_id,
                run_id=entry.run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=entry.parent_tool_call_id,
                payload=payload,
            )
        if not durable:
            return False
        entry.pending_result = None
        entry.result = pending
        return True

    async def _emit(
        self,
        entry: _SubagentEntry,
        subagent_id: str,
        payload: EventPayload,
    ) -> None:
        await self._emit_to_sink(
            sink=entry.sink,
            task_id=entry.task_id,
            run_id=entry.run_id,
            subagent_id=subagent_id,
            parent_tool_call_id=entry.parent_tool_call_id,
            payload=payload,
        )

    async def _emit_to_sink(
        self,
        *,
        sink: SubagentEventSink,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        async with asyncio.timeout(self._event_timeout_seconds):
            await sink.emit(
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
            )

    async def _cleanup_failed_admission(
        self,
        attempted: list[
            tuple[SubagentRecord, SubagentRequest, _SubagentEntry]
        ],
        error: BaseException,
    ) -> None:
        error_message = str(error) or type(error).__name__
        results = [
            self._interrupted_result(
                record.subagent_id,
                summary="Subagent admission interrupted",
                reason=f"Admission failed: {error_message}",
            )
            for record, _, _ in attempted
        ]
        await asyncio.gather(
            *(
                self._emit_to_sink(
                    sink=entry.sink,
                    task_id=entry.task_id,
                    run_id=entry.run_id,
                    subagent_id=result.subagent_id,
                    parent_tool_call_id=entry.parent_tool_call_id,
                    payload=self._terminal_payload(result),
                )
                for result, (_, _, entry) in zip(
                    results,
                    attempted,
                    strict=True,
                )
            ),
            return_exceptions=True,
        )

    async def _owner_active_ids(
        self,
        owner: tuple[str, str],
    ) -> list[str]:
        await self._wait_for_owner_admissions(owner)
        async with self._lifecycle_lock:
            return [
                subagent_id
                for subagent_id, entry in self._entries.items()
                if (entry.task_id, entry.run_id) == owner
                and entry.result is None
            ]

    async def _wait_for_owner_admissions(
        self,
        owner: tuple[str, str],
    ) -> None:
        while True:
            async with self._lifecycle_lock:
                admissions = tuple(self._admissions.get(owner, ()))
                if not admissions:
                    return
            await asyncio.gather(
                *(asyncio.shield(admission) for admission in admissions),
                return_exceptions=True,
            )

    def _owner_has_entries(self, owner: tuple[str, str]) -> bool:
        return any(
            (entry.task_id, entry.run_id) == owner
            for entry in self._entries.values()
        )

    def _finish_admission(
        self,
        owner: tuple[str, str],
        admission: asyncio.Future[None],
    ) -> None:
        owner_admissions = self._admissions.get(owner)
        if owner_admissions is not None:
            owner_admissions.discard(admission)
            if not owner_admissions:
                self._admissions.pop(owner, None)
        if not admission.done():
            admission.set_result(None)
        if not self._owner_has_entries(owner) and owner not in self._admissions:
            self._run_semaphores.pop(owner, None)

    def _require_entry(self, subagent_id: str) -> _SubagentEntry:
        try:
            return self._entries[subagent_id]
        except KeyError as error:
            raise LookupError(f"unknown subagent: {subagent_id}") from error

    @staticmethod
    def _terminal_payload(result: SubagentResult) -> EventPayload:
        if result.status is SubagentStatus.COMPLETED:
            return SubagentCompletedPayload(
                subagent_id=result.subagent_id,
                result=result,
            )
        if result.status is SubagentStatus.FAILED:
            return SubagentFailedPayload(
                subagent_id=result.subagent_id,
                result=result,
            )
        if result.status is SubagentStatus.CANCELLED:
            return SubagentCancelledPayload(
                subagent_id=result.subagent_id,
                result=result,
            )
        if result.status is SubagentStatus.INTERRUPTED:
            return SubagentInterruptedPayload(
                subagent_id=result.subagent_id,
                result=result,
            )
        raise ValueError("runner returned a non-terminal result")

    @classmethod
    def _task_cancelled_result(
        cls,
        entry: _SubagentEntry,
        subagent_id: str,
    ) -> SubagentResult:
        if entry.forced_interruption:
            return cls._interrupted_result(
                subagent_id,
                summary="Subagent interrupted during shutdown",
                reason=(
                    entry.forced_interruption_reason
                    or "Cancellation request could not be persisted"
                ),
            )
        return cls._cancelled_result(subagent_id)

    @staticmethod
    def _interrupted_result(
        subagent_id: str,
        *,
        summary: str,
        reason: str,
    ) -> SubagentResult:
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.INTERRUPTED,
            summary=summary,
            error_code=SubagentErrorCode.INTERNAL_ERROR,
            error_message=reason,
        )

    @staticmethod
    def _cancelled_result(subagent_id: str) -> SubagentResult:
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.CANCELLED,
            summary="Subagent cancelled",
            error_code=SubagentErrorCode.CANCELLED,
        )
