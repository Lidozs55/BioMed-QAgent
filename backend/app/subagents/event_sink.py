"""Durable event sink for managed child-agent lifecycle events."""

from __future__ import annotations

import asyncio
import logging

from app.domain.contracts.events import EventPayload
from app.runtime.hub import EventHub
from app.runtime.repository import TaskRepository

logger = logging.getLogger(__name__)


class DurableSubagentEventSink:
    """Append one child event before publishing the same envelope live."""

    def __init__(self, *, repository: TaskRepository, hub: EventHub) -> None:
        self._repository = repository
        self._hub = hub

    async def emit(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None:
        snapshot = await self._repository.get_snapshot(task_id)
        if snapshot is None:
            raise LookupError(task_id)
        try:
            _, event = await self._repository.append_event_payload(
                task_id=task_id,
                run_id=run_id,
                subagent_id=subagent_id,
                parent_tool_call_id=parent_tool_call_id,
                payload=payload,
            )
        except BaseException as error:
            try:
                event = await self._repository.find_matching_event(
                    task_id=task_id,
                    run_id=run_id,
                    payload=payload,
                    after_sequence=snapshot.task.latest_sequence,
                    subagent_id=subagent_id,
                    parent_tool_call_id=parent_tool_call_id,
                )
            except BaseException as reconciliation_error:
                error.add_note(
                    "durable subagent event reconciliation failed: "
                    f"{type(reconciliation_error).__name__}: "
                    f"{reconciliation_error}"
                )
                raise error from reconciliation_error
            if event is None:
                raise
        try:
            await self._hub.publish(event)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None:
                current.uncancel()
        except Exception:
            logger.exception(
                "failed to publish durable subagent event for task %s run %s "
                "subagent %s",
                task_id,
                run_id,
                subagent_id,
            )


__all__ = ["DurableSubagentEventSink"]
