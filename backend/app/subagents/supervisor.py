"""Concurrency, lifecycle, and cancellation management for child agents."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

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
    cancel_requested: bool = False


class SubagentSupervisor:
    def __init__(
        self,
        *,
        global_limit: int = 4,
        per_run_limit: int = 3,
        batch_limit: int = 8,
        timeout_seconds: float = 900,
    ) -> None:
        if global_limit < 1:
            raise ValueError("global_limit must be at least 1")
        if per_run_limit < 1:
            raise ValueError("per_run_limit must be at least 1")
        if not 1 <= batch_limit <= 8:
            raise ValueError("batch_limit must be between 1 and 8")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than 0")

        self._global_semaphore = asyncio.Semaphore(global_limit)
        self._per_run_limit = per_run_limit
        self._batch_limit = batch_limit
        self._timeout_seconds = timeout_seconds
        self._run_semaphores: dict[tuple[str, str], asyncio.Semaphore] = {}
        self._entries: dict[str, _SubagentEntry] = {}
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

        async with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("subagent supervisor has shut down")

            run_semaphore = self._run_semaphores.setdefault(
                (task_id, run_id),
                asyncio.Semaphore(self._per_run_limit),
            )
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

            for record, request, _ in pending:
                await sink.emit(
                    task_id=task_id,
                    run_id=run_id,
                    subagent_id=record.subagent_id,
                    parent_tool_call_id=parent_tool_call_id,
                    payload=SubagentQueuedPayload(
                        subagent_id=record.subagent_id,
                        request=request,
                    ),
                )

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

        return [record for record, _, _ in pending]

    async def wait(self, subagent_id: str) -> SubagentResult:
        entry = self._require_entry(subagent_id)
        if entry.result is not None:
            return entry.result
        if entry.task is None:
            raise RuntimeError("subagent was not scheduled")
        return await asyncio.shield(entry.task)

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
            if not entry.cancel_requested:
                entry.cancel_requested = True
                try:
                    await self._emit(
                        entry,
                        subagent_id,
                        SubagentCancelRequestedPayload(
                            subagent_id=subagent_id,
                            reason=reason,
                        ),
                    )
                finally:
                    if entry.task is not None:
                        entry.task.cancel()

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
        subagent_ids = [
            subagent_id
            for subagent_id, entry in self._entries.items()
            if entry.task_id == task_id
            and entry.run_id == run_id
            and entry.result is None
        ]
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

    async def shutdown(self) -> None:
        async with self._shutdown_lock:
            async with self._lifecycle_lock:
                self._closed = True
                active_ids = [
                    subagent_id
                    for subagent_id, entry in self._entries.items()
                    if entry.result is None
                ]

            if active_ids:
                await asyncio.gather(
                    *(
                        self.cancel(
                            subagent_id,
                            reason="subagent supervisor shutdown",
                        )
                        for subagent_id in active_ids
                    )
                )

            tasks = [
                entry.task
                for entry in self._entries.values()
                if entry.task is not None and not entry.task.done()
            ]
            if tasks:
                await asyncio.gather(*tasks)

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
            result = self._cancelled_result(subagent_id)
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
                self._cancelled_result(subagent_id),
            )

    async def _publish_terminal(
        self,
        entry: _SubagentEntry,
        result: SubagentResult,
    ) -> SubagentResult:
        async with entry.terminal_lock:
            if entry.result is not None:
                return entry.result
            if entry.cancel_requested and result.status is not SubagentStatus.CANCELLED:
                result = self._cancelled_result(result.subagent_id)

            payload: EventPayload
            if result.status is SubagentStatus.COMPLETED:
                payload = SubagentCompletedPayload(
                    subagent_id=result.subagent_id,
                    result=result,
                )
            elif result.status is SubagentStatus.FAILED:
                payload = SubagentFailedPayload(
                    subagent_id=result.subagent_id,
                    result=result,
                )
            elif result.status is SubagentStatus.CANCELLED:
                payload = SubagentCancelledPayload(
                    subagent_id=result.subagent_id,
                    result=result,
                )
            elif result.status is SubagentStatus.INTERRUPTED:
                payload = SubagentInterruptedPayload(
                    subagent_id=result.subagent_id,
                    result=result,
                )
            else:
                raise ValueError("runner returned a non-terminal result")

            await self._emit(entry, result.subagent_id, payload)
            entry.result = result
            return result

    async def _emit(
        self,
        entry: _SubagentEntry,
        subagent_id: str,
        payload: EventPayload,
    ) -> None:
        await entry.sink.emit(
            task_id=entry.task_id,
            run_id=entry.run_id,
            subagent_id=subagent_id,
            parent_tool_call_id=entry.parent_tool_call_id,
            payload=payload,
        )

    def _require_entry(self, subagent_id: str) -> _SubagentEntry:
        try:
            return self._entries[subagent_id]
        except KeyError as error:
            raise LookupError(f"unknown subagent: {subagent_id}") from error

    @staticmethod
    def _cancelled_result(subagent_id: str) -> SubagentResult:
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.CANCELLED,
            summary="Subagent cancelled",
            error_code=SubagentErrorCode.CANCELLED,
        )
