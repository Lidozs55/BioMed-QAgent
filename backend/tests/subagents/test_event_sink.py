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


def _cancelled_payload(subagent_id: str = "sub_1") -> SubagentCancelledPayload:
    return SubagentCancelledPayload(
        subagent_id=subagent_id,
        result=SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.CANCELLED,
            summary="Cancelled",
        ),
    )


async def _prepared_sink(tmp_path):
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
    return repository, hub, sink


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
async def test_same_key_callers_share_one_journal_and_live_execution(
    tmp_path,
    monkeypatch,
) -> None:
    repository, hub, sink = await _prepared_sink(tmp_path)
    real_append = repository.append_event_payload
    real_publish = hub.publish
    append_entered = asyncio.Event()
    release_append = asyncio.Event()
    append_calls = 0
    publish_calls = 0

    async def block_terminal_append(**kwargs):
        nonlocal append_calls
        if isinstance(kwargs["payload"], SubagentCancelledPayload):
            append_calls += 1
            append_entered.set()
            await release_append.wait()
        return await real_append(**kwargs)

    async def count_terminal_publish(event) -> None:
        nonlocal publish_calls
        if isinstance(event.payload, SubagentCancelledPayload):
            publish_calls += 1
        await real_publish(event)

    monkeypatch.setattr(repository, "append_event_payload", block_terminal_append)
    monkeypatch.setattr(hub, "publish", count_terminal_publish)
    emit_kwargs = {
        "task_id": "task_1",
        "run_id": "run_1",
        "subagent_id": "sub_1",
        "parent_tool_call_id": "call_1",
        "payload": _cancelled_payload(),
    }
    first = asyncio.create_task(sink.emit(**emit_kwargs))
    try:
        await asyncio.wait_for(append_entered.wait(), timeout=1)
        second = asyncio.create_task(sink.emit(**emit_kwargs))
        await asyncio.sleep(0)
        release_append.set()
        await asyncio.gather(first, second)

        events = await repository.list_events("task_1")
        assert append_calls == 1
        assert publish_calls == 1
        assert (
            sum(
                isinstance(event.payload, SubagentCancelledPayload)
                for event in events
            )
            == 1
        )
    finally:
        release_append.set()
        await asyncio.gather(first, return_exceptions=True)
        await hub.close()
        await repository.close()


@pytest.mark.asyncio
async def test_caller_cancellation_does_not_cancel_shared_emit(
    tmp_path,
    monkeypatch,
) -> None:
    repository, hub, sink = await _prepared_sink(tmp_path)
    real_append = repository.append_event_payload
    real_publish = hub.publish
    publish_entered = asyncio.Event()
    release_publish = asyncio.Event()
    append_calls = 0
    publish_calls = 0

    async def count_terminal_append(**kwargs):
        nonlocal append_calls
        if isinstance(kwargs["payload"], SubagentCancelledPayload):
            append_calls += 1
        return await real_append(**kwargs)

    async def block_terminal_publish(event) -> None:
        nonlocal publish_calls
        if isinstance(event.payload, SubagentCancelledPayload):
            publish_calls += 1
            publish_entered.set()
            await release_publish.wait()
        await real_publish(event)

    monkeypatch.setattr(repository, "append_event_payload", count_terminal_append)
    monkeypatch.setattr(hub, "publish", block_terminal_publish)
    emit_kwargs = {
        "task_id": "task_1",
        "run_id": "run_1",
        "subagent_id": "sub_1",
        "parent_tool_call_id": "call_1",
        "payload": _cancelled_payload(),
    }
    first = asyncio.create_task(sink.emit(**emit_kwargs))
    try:
        await asyncio.wait_for(publish_entered.wait(), timeout=1)
        second = asyncio.create_task(sink.emit(**emit_kwargs))
        await asyncio.sleep(0)
        first.cancel()
        release_publish.set()

        with pytest.raises(asyncio.CancelledError):
            await first
        await second

        events = await repository.list_events("task_1")
        assert append_calls == 1
        assert publish_calls == 1
        assert (
            sum(
                isinstance(event.payload, SubagentCancelledPayload)
                for event in events
            )
            == 1
        )
    finally:
        release_publish.set()
        await asyncio.gather(first, return_exceptions=True)
        await hub.close()
        await repository.close()


class _CleanupBoundarySink(DurableSubagentEventSink):
    def __init__(self, *, repository: TaskRepository, hub: EventHub) -> None:
        super().__init__(repository=repository, hub=hub)
        self.second_waiter_leaving = asyncio.Event()
        self.release_second_waiter = asyncio.Event()

    async def _leave_attempt(self, **kwargs) -> None:
        current = asyncio.current_task()
        if current is not None and current.get_name() == "same-key-second":
            self.second_waiter_leaving.set()
            await self.release_second_waiter.wait()
        await super()._leave_attempt(**kwargs)


@pytest.mark.asyncio
async def test_three_callers_do_not_cross_attempt_cleanup_generations(
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
    sink = _CleanupBoundarySink(repository=repository, hub=hub)
    await sink.emit(
        task_id="task_1",
        run_id="run_1",
        subagent_id="sub_1",
        parent_tool_call_id="call_1",
        payload=_queued_payload(),
    )
    real_publish = hub.publish
    publish_entered = asyncio.Event()
    release_publish = asyncio.Event()
    publish_calls = 0

    async def block_first_terminal_publish(event) -> None:
        nonlocal publish_calls
        if isinstance(event.payload, SubagentCancelledPayload):
            publish_calls += 1
            if publish_calls == 1:
                publish_entered.set()
                await release_publish.wait()
        await real_publish(event)

    monkeypatch.setattr(hub, "publish", block_first_terminal_publish)
    emit_kwargs = {
        "task_id": "task_1",
        "run_id": "run_1",
        "subagent_id": "sub_1",
        "parent_tool_call_id": "call_1",
        "payload": _cancelled_payload(),
    }
    first = asyncio.create_task(sink.emit(**emit_kwargs), name="same-key-first")
    try:
        await asyncio.wait_for(publish_entered.wait(), timeout=1)
        second = asyncio.create_task(
            sink.emit(**emit_kwargs),
            name="same-key-second",
        )
        await asyncio.sleep(0)
        release_publish.set()
        await asyncio.wait_for(sink.second_waiter_leaving.wait(), timeout=1)
        await first

        third = asyncio.create_task(
            sink.emit(**emit_kwargs),
            name="same-key-third",
        )
        await third
        sink.release_second_waiter.set()
        await second

        events = await repository.list_events("task_1")
        assert publish_calls == 1
        assert (
            sum(
                isinstance(event.payload, SubagentCancelledPayload)
                for event in events
            )
            == 1
        )
        assert sink._attempts == {}
    finally:
        release_publish.set()
        sink.release_second_waiter.set()
        await asyncio.gather(first, return_exceptions=True)
        await hub.close()
        await repository.close()


@pytest.mark.asyncio
async def test_release_run_attempts_removes_abandoned_failures(
    tmp_path,
    monkeypatch,
) -> None:
    repository, hub, sink = await _prepared_sink(tmp_path)
    real_append = repository.append_event_payload

    async def fail_terminal_before_persistence(**kwargs):
        if isinstance(kwargs["payload"], SubagentCancelledPayload):
            raise OSError("terminal storage unavailable")
        return await real_append(**kwargs)

    monkeypatch.setattr(
        repository,
        "append_event_payload",
        fail_terminal_before_persistence,
    )
    try:
        with pytest.raises(OSError, match="terminal storage unavailable"):
            await sink.emit(
                task_id="task_1",
                run_id="run_1",
                subagent_id="sub_1",
                parent_tool_call_id="call_1",
                payload=_cancelled_payload(),
            )
        assert sink._attempts

        await sink.release_run_attempts("task_1", "run_1")

        assert sink._attempts == {}
        assert sink._completed_keys == set()
    finally:
        await hub.close()
        await repository.close()


@pytest.mark.asyncio
async def test_durable_sink_propagates_publish_cancellation_after_append(
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
    cancelled = SubagentCancelledPayload(
        subagent_id="sub_1",
        result=SubagentResult(
            subagent_id="sub_1",
            status=SubagentStatus.CANCELLED,
            summary="Cancelled",
        ),
    )
    publish_entered = asyncio.Event()
    release_publish = asyncio.Event()
    real_publish = hub.publish

    async def block_publish(event) -> None:
        publish_entered.set()
        await release_publish.wait()
        await real_publish(event)

    monkeypatch.setattr(hub, "publish", block_publish)
    emit_task = asyncio.create_task(
        sink.emit(
            task_id="task_1",
            run_id="run_1",
            subagent_id="sub_1",
            parent_tool_call_id="call_1",
            payload=cancelled,
        )
    )
    try:
        await asyncio.wait_for(publish_entered.wait(), timeout=1)
        emit_task.cancel()
        release_publish.set()
        with pytest.raises(asyncio.CancelledError):
            await emit_task

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
        release_publish.set()
        await asyncio.gather(emit_task, return_exceptions=True)
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
async def test_durable_sink_reuses_exact_identity_after_reconciliation_failure(
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
    cancelled = SubagentCancelledPayload(
        subagent_id="sub_1",
        result=SubagentResult(
            subagent_id="sub_1",
            status=SubagentStatus.CANCELLED,
            summary="Cancelled",
        ),
    )
    real_append_payload = repository.append_event_payload
    real_find_matching = repository.find_matching_event
    append_attempts = 0
    matching_attempts = 0
    matching_identities: list[tuple[int, datetime | None]] = []

    async def persist_then_raise_once(**kwargs):
        nonlocal append_attempts
        if isinstance(kwargs["payload"], SubagentCancelledPayload):
            append_attempts += 1
            if append_attempts > 1:
                raise AssertionError("retry must reconcile before append")
            await real_append_payload(**kwargs)
            raise OSError("projection failed after durable append")
        return await real_append_payload(**kwargs)

    async def fail_first_matching_lookup(**kwargs):
        nonlocal matching_attempts
        if isinstance(kwargs["payload"], SubagentCancelledPayload):
            matching_attempts += 1
            matching_identities.append(
                (kwargs["after_sequence"], kwargs.get("timestamp"))
            )
            if matching_attempts == 1:
                raise RuntimeError("matching lookup temporarily unavailable")
        return await real_find_matching(**kwargs)

    monkeypatch.setattr(
        repository,
        "append_event_payload",
        persist_then_raise_once,
    )
    monkeypatch.setattr(
        repository,
        "find_matching_event",
        fail_first_matching_lookup,
    )
    try:
        with pytest.raises(
            OSError,
            match="projection failed after durable append",
        ):
            await sink.emit(
                task_id="task_1",
                run_id="run_1",
                subagent_id="sub_1",
                parent_tool_call_id="call_1",
                payload=cancelled,
            )

        await sink.emit(
            task_id="task_1",
            run_id="run_1",
            subagent_id="sub_1",
            parent_tool_call_id="call_1",
            payload=cancelled,
        )

        events = await repository.list_events("task_1")
        assert append_attempts == 1
        assert matching_attempts == 2
        assert matching_identities[0] == matching_identities[1]
        assert matching_identities[0][0] == 2
        assert matching_identities[0][1] is not None
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
