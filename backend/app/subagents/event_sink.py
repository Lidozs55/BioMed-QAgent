"""Durable event sink for managed child-agent lifecycle events."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.domain.contracts.events import EventEnvelope, EventPayload
from app.runtime.hub import EventHub
from app.runtime.repository import TaskRepository

logger = logging.getLogger(__name__)

_AttemptKey = tuple[str, ...]


@dataclass(slots=True)
class _EmitAttempt:
    after_sequence: int
    timestamp: datetime
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    event: EventEnvelope | None = None
    needs_reconciliation: bool = False
    execution: asyncio.Task[None] | None = None
    generation: int = 0
    succeeded_generation: int | None = None
    waiters: int = 0


class DurableSubagentEventSink:
    """Append one child event before publishing the same envelope live."""

    def __init__(self, *, repository: TaskRepository, hub: EventHub) -> None:
        self._repository = repository
        self._hub = hub
        self._attempts: dict[_AttemptKey, _EmitAttempt] = {}
        self._completed_keys: set[_AttemptKey] = set()
        self._attempts_lock = asyncio.Lock()

    async def emit(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        key = self._attempt_key(
            task_id,
            run_id,
            subagent_id,
            parent_tool_call_id,
            payload,
        )
        joined = await self._join_attempt(
            key=key,
            task_id=task_id,
            run_id=run_id,
            subagent_id=subagent_id,
            parent_tool_call_id=parent_tool_call_id,
            payload=payload,
        )
        if joined is None:
            return
        attempt, execution, generation = joined
        try:
            await asyncio.shield(execution)
        finally:
            await self._leave_attempt(
                key=key,
                attempt=attempt,
                execution=execution,
                generation=generation,
            )

    async def reconcile_terminal(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> bool:
        """Check one retained terminal identity without appending or publishing."""

        key = self._attempt_key(
            task_id,
            run_id,
            subagent_id,
            parent_tool_call_id,
            payload,
        )
        async with self._attempts_lock:
            if key in self._completed_keys:
                return True
            attempt = self._attempts.get(key)
        if attempt is None:
            return False

        async with attempt.lock:
            execution = attempt.execution
        if execution is not None and not execution.done():
            try:
                await asyncio.shield(execution)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            async with self._attempts_lock:
                if key in self._completed_keys:
                    return True

        async with attempt.lock:
            if attempt.event is not None:
                return True
            if not attempt.needs_reconciliation:
                return False
            after_sequence = attempt.after_sequence
            timestamp = attempt.timestamp

        event = await self._repository.find_matching_event(
            task_id=task_id,
            run_id=run_id,
            payload=payload,
            after_sequence=after_sequence,
            subagent_id=subagent_id,
            parent_tool_call_id=parent_tool_call_id,
            timestamp=timestamp,
        )
        async with attempt.lock:
            attempt.event = event
            attempt.needs_reconciliation = False
        return event is not None

    async def release_run_attempts(self, task_id: str, run_id: str) -> None:
        """Discard retained retry identities after Supervisor releases a Run."""

        async with self._attempts_lock:
            attempts = [
                attempt
                for key, attempt in self._attempts.items()
                if key[:2] == (task_id, run_id)
            ]
            if any(
                attempt.execution is not None
                and not attempt.execution.done()
                for attempt in attempts
            ):
                raise RuntimeError("cannot release active subagent event attempts")
            self._attempts = {
                key: attempt
                for key, attempt in self._attempts.items()
                if key[:2] != (task_id, run_id)
            }
            self._completed_keys = {
                key
                for key in self._completed_keys
                if key[:2] != (task_id, run_id)
            }

    async def _join_attempt(
        self,
        *,
        key: _AttemptKey,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> tuple[_EmitAttempt, asyncio.Task[None], int] | None:
        while True:
            attempt = await self._get_or_create_attempt(key, task_id)
            if attempt is None:
                return None
            async with self._attempts_lock:
                if key in self._completed_keys:
                    return None
                if self._attempts.get(key) is not attempt:
                    continue
                async with attempt.lock:
                    execution = attempt.execution
                    if execution is None:
                        attempt.generation += 1
                        generation = attempt.generation
                        execution = asyncio.create_task(
                            self._run_generation(
                                key=key,
                                attempt=attempt,
                                generation=generation,
                                task_id=task_id,
                                run_id=run_id,
                                subagent_id=subagent_id,
                                parent_tool_call_id=parent_tool_call_id,
                                payload=payload,
                            ),
                            name=(
                                f"subagent-event:{subagent_id}:"
                                f"{generation}"
                            ),
                        )
                        execution.add_done_callback(
                            self._consume_task_exception
                        )
                        attempt.execution = execution
                        attempt.succeeded_generation = None
                    else:
                        generation = attempt.generation
                    attempt.waiters += 1
                    return attempt, execution, generation

    async def _get_or_create_attempt(
        self,
        key: _AttemptKey,
        task_id: str,
    ) -> _EmitAttempt | None:
        async with self._attempts_lock:
            if key in self._completed_keys:
                return None
            existing = self._attempts.get(key)
        if existing is not None:
            return existing

        snapshot = await self._repository.get_snapshot(task_id)
        if snapshot is None:
            raise LookupError(task_id)
        candidate = _EmitAttempt(
            after_sequence=snapshot.task.latest_sequence,
            timestamp=datetime.now(UTC),
        )
        async with self._attempts_lock:
            if key in self._completed_keys:
                return None
            return self._attempts.setdefault(key, candidate)

    async def _run_generation(
        self,
        *,
        key: _AttemptKey,
        attempt: _EmitAttempt,
        generation: int,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        execution = asyncio.current_task()
        assert execution is not None
        try:
            await self._execute_attempt(
                attempt=attempt,
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
            )
        except BaseException:
            async with attempt.lock:
                if (
                    attempt.execution is execution
                    and attempt.generation == generation
                ):
                    attempt.execution = None
                    attempt.succeeded_generation = None
            raise
        async with attempt.lock:
            if (
                attempt.execution is execution
                and attempt.generation == generation
            ):
                attempt.succeeded_generation = generation
        await self._cleanup_completed_generation(
            key=key,
            attempt=attempt,
            execution=execution,
            generation=generation,
        )

    async def _execute_attempt(
        self,
        *,
        attempt: _EmitAttempt,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        event = attempt.event
        if event is None and attempt.needs_reconciliation:
            event = await self._repository.find_matching_event(
                task_id=task_id,
                run_id=run_id,
                payload=payload,
                after_sequence=attempt.after_sequence,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                timestamp=attempt.timestamp,
            )
            attempt.needs_reconciliation = False
            attempt.event = event

        if event is None:
            event = await self._append_or_reconcile(
                attempt=attempt,
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
            )

        attempt.event = event
        await self._publish(
            event=event,
            task_id=task_id,
            run_id=run_id,
            subagent_id=subagent_id,
        )

    async def _append_or_reconcile(
        self,
        *,
        attempt: _EmitAttempt,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> EventEnvelope:
        try:
            _, event = await self._repository.append_event_payload(
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
                timestamp=attempt.timestamp,
            )
        except BaseException as error:
            attempt.needs_reconciliation = True
            try:
                event = await self._repository.find_matching_event(
                    task_id=task_id,
                    run_id=run_id,
                    payload=payload,
                    after_sequence=attempt.after_sequence,
                    subagent_id=subagent_id,
                    parent_tool_call_id=parent_tool_call_id,
                    timestamp=attempt.timestamp,
                )
            except BaseException as reconciliation_error:
                error.add_note(
                    "durable subagent event reconciliation failed: "
                    f"{type(reconciliation_error).__name__}: "
                    f"{reconciliation_error}"
                )
                raise error from reconciliation_error
            if event is None:
                attempt.needs_reconciliation = False
                raise
            attempt.needs_reconciliation = False
        return event

    async def _publish(
        self,
        *,
        event: EventEnvelope,
        task_id: str,
        run_id: str,
        subagent_id: str,
    ) -> None:
        try:
            await self._hub.publish(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "failed to publish durable subagent event for task %s run %s "
                "subagent %s",
                task_id,
                run_id,
                subagent_id,
            )

    async def _leave_attempt(
        self,
        *,
        key: _AttemptKey,
        attempt: _EmitAttempt,
        execution: asyncio.Task[None],
        generation: int,
    ) -> None:
        async with attempt.lock:
            attempt.waiters -= 1
            if attempt.waiters < 0:
                raise RuntimeError("subagent event attempt waiter underflow")
        await self._cleanup_completed_generation(
            key=key,
            attempt=attempt,
            execution=execution,
            generation=generation,
        )

    async def _cleanup_completed_generation(
        self,
        *,
        key: _AttemptKey,
        attempt: _EmitAttempt,
        execution: asyncio.Task[None],
        generation: int,
    ) -> None:
        async with self._attempts_lock:
            if self._attempts.get(key) is not attempt:
                return
            async with attempt.lock:
                if (
                    attempt.execution is not execution
                    or attempt.generation != generation
                    or attempt.succeeded_generation != generation
                    or attempt.waiters != 0
                ):
                    return
                self._completed_keys.add(key)
                self._attempts.pop(key, None)

    @staticmethod
    def _attempt_key(
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> _AttemptKey:
        return (
            task_id,
            run_id,
            subagent_id,
            parent_tool_call_id,
            type(payload).__name__,
            payload.model_dump_json(),
        )

    @staticmethod
    def _consume_task_exception(task: asyncio.Task[None]) -> None:
        if not task.cancelled():
            task.exception()


__all__ = ["DurableSubagentEventSink"]
