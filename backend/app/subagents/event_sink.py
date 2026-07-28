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


@dataclass(slots=True)
class _EmitAttempt:
    after_sequence: int
    timestamp: datetime
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    event: EventEnvelope | None = None
    needs_reconciliation: bool = False


class DurableSubagentEventSink:
    """Append one child event before publishing the same envelope live."""

    def __init__(self, *, repository: TaskRepository, hub: EventHub) -> None:
        self._repository = repository
        self._hub = hub
        self._attempts: dict[tuple[str, ...], _EmitAttempt] = {}
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
        key = (
            task_id,
            run_id,
            subagent_id,
            parent_tool_call_id,
            type(payload).__name__,
            payload.model_dump_json(),
        )
        attempt = await self._get_or_create_attempt(key, task_id)
        async with attempt.lock:
            await self._emit_attempt(
                key=key,
                attempt=attempt,
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
            )

    async def _get_or_create_attempt(
        self,
        key: tuple[str, ...],
        task_id: str,
    ) -> _EmitAttempt:
        async with self._attempts_lock:
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
            return self._attempts.setdefault(key, candidate)

    async def _emit_attempt(
        self,
        *,
        key: tuple[str, ...],
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
            key=key,
            attempt=attempt,
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
        key: tuple[str, ...],
        attempt: _EmitAttempt,
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
        async with self._attempts_lock:
            if self._attempts.get(key) is attempt:
                self._attempts.pop(key, None)


__all__ = ["DurableSubagentEventSink"]
