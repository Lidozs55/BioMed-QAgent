"""Durable event sink for managed child-agent lifecycle events."""

from __future__ import annotations

from app.domain.contracts.events import EventPayload
from app.runtime.hub import EventHub
from app.runtime.repository import TaskRepository


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
        _, event = await self._repository.append_event_payload(
            task_id=task_id,
            run_id=run_id,
            subagent_id=subagent_id,
            parent_tool_call_id=parent_tool_call_id,
            payload=payload,
        )
        await self._hub.publish(event)


__all__ = ["DurableSubagentEventSink"]
