from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from app.domain.contracts import (
    RunQueuedPayload,
    RunStatus,
    SubagentCancelledPayload,
    SubagentQueuedPayload,
    SubagentRequest,
    SubagentResult,
    SubagentStatus,
    SubagentType,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime.hub import EventHub
from app.runtime.repository import TaskRepository
from app.subagents.event_sink import DurableSubagentEventSink

NOW = datetime(2026, 7, 28, tzinfo=UTC)


def _empty_snapshot() -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_1",
            mode=TaskMode.AGENT,
            title="Managed research",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def _queued_payload(subagent_id: str = "sub_1") -> SubagentQueuedPayload:
    return SubagentQueuedPayload(
        subagent_id=subagent_id,
        request=SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find a public source",
            domain="example.org",
            capability="dataset_search",
        ),
    )


@pytest.mark.asyncio
async def test_durable_sink_appends_projects_and_publishes_one_event(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    await repository.initialize()
    await repository.save_snapshot(_empty_snapshot())
    await repository.append_event(
        build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=1,
            payload=RunQueuedPayload(request_id="req_1", input="research"),
        )
    )
    subscription = await hub.subscribe(task_ids={"task_1"})
    sink = DurableSubagentEventSink(repository=repository, hub=hub)
    try:
        await sink.emit(
            task_id="task_1",
            run_id="run_1",
            subagent_id="sub_1",
            parent_tool_call_id="call_1",
            payload=_queued_payload(),
        )

        snapshot = await repository.get_snapshot("task_1")
        published = await subscription.receive()
        events = await repository.list_events("task_1")

        assert snapshot is not None
        assert snapshot.subagents[0].subagent_id == "sub_1"
        assert snapshot.subagents[0].status is SubagentStatus.QUEUED
        assert snapshot.task.latest_sequence == 2
        assert published == events[-1]
        assert len(events) == 2
    finally:
        await subscription.close()
        await hub.close()
        await repository.close()


@pytest.mark.asyncio
async def test_durable_sink_allocates_contiguous_sequences_concurrently(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    await repository.initialize()
    await repository.save_snapshot(_empty_snapshot())
    await repository.append_event(
        build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=1,
            payload=RunQueuedPayload(request_id="req_1", input="research"),
        )
    )
    sink = DurableSubagentEventSink(repository=repository, hub=hub)
    try:
        await asyncio.gather(
            *(
                sink.emit(
                    task_id="task_1",
                    run_id="run_1",
                    subagent_id=subagent_id,
                    parent_tool_call_id="call_1",
                    payload=_queued_payload(subagent_id),
                )
                for subagent_id in ("sub_1", "sub_2")
            )
        )

        snapshot = await repository.get_snapshot("task_1")
        events = await repository.list_events("task_1")

        assert snapshot is not None
        assert {child.subagent_id for child in snapshot.subagents} == {
            "sub_1",
            "sub_2",
        }
        assert [event.sequence for event in events] == [1, 2, 3]
    finally:
        await hub.close()
        await repository.close()


@pytest.mark.asyncio
async def test_durable_sink_reconciles_terminal_persist_before_raise_once(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    await repository.initialize()
    await repository.save_snapshot(_empty_snapshot())
    await repository.append_event(
        build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=1,
            payload=RunQueuedPayload(request_id="req_1", input="research"),
        )
    )
    sink = DurableSubagentEventSink(repository=repository, hub=hub)
    await sink.emit(
        task_id="task_1",
        run_id="run_1",
        subagent_id="sub_1",
        parent_tool_call_id="call_1",
        payload=_queued_payload(),
    )
    real_append_payload = repository.append_event_payload
    raised_after_persist = False

    async def append_then_raise_once(**kwargs):
        nonlocal raised_after_persist
        result = await real_append_payload(**kwargs)
        if (
            isinstance(kwargs["payload"], SubagentCancelledPayload)
            and not raised_after_persist
        ):
            raised_after_persist = True
            raise OSError("projection failed after durable append")
        return result

    monkeypatch.setattr(repository, "append_event_payload", append_then_raise_once)
    cancelled = SubagentCancelledPayload(
        subagent_id="sub_1",
        result=SubagentResult(
            subagent_id="sub_1",
            status=SubagentStatus.CANCELLED,
            summary="Cancelled",
        ),
    )
    try:
        await sink.emit(
            task_id="task_1",
            run_id="run_1",
            subagent_id="sub_1",
            parent_tool_call_id="call_1",
            payload=cancelled,
        )

        events = await repository.list_events("task_1")
        assert (
            sum(
                isinstance(event.payload, SubagentCancelledPayload)
                for event in events
            )
            == 1
        )
    finally:
        await hub.close()
        await repository.close()
