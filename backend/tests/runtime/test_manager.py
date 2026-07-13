from __future__ import annotations

import asyncio
import importlib
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest

from app.domain.contracts import (
    RunCancelRequestedPayload,
    RunCancelledPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunStartedPayload,
    RunStatus,
    StartRunRequest,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.config import Settings
from app.runtime.repository import TaskRepository
from app.runtime.hub import EventHub


NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)


def empty_snapshot(task_id: str) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


@pytest.mark.asyncio
async def test_four_tasks_run_while_fifth_remains_durably_queued(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    release = {f"task_{number}": asyncio.Event() for number in range(5)}
    first_four_started = asyncio.Event()
    fifth_started = asyncio.Event()
    started: list[str] = []
    active: set[str] = set()
    maximum_active = 0

    async def run(execution) -> None:
        nonlocal maximum_active
        started.append(execution.task_id)
        active.add(execution.task_id)
        maximum_active = max(maximum_active, len(active))
        if len(started) == 4:
            first_four_started.set()
        if execution.task_id == "task_4":
            fifth_started.set()
        await release[execution.task_id].wait()
        active.remove(execution.task_id)

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=4,
        max_queued_runs=100,
    )
    await manager.start()
    try:
        for task_id in release:
            await repository.save_snapshot(empty_snapshot(task_id))
        accepted = [
            await manager.submit_run(
                task_id,
                StartRunRequest(
                    request_id=f"req_{number}",
                    input=f"question {number}",
                ),
            )
            for number, task_id in enumerate(release)
        ]

        await asyncio.wait_for(first_four_started.wait(), timeout=1)
        assert maximum_active == 4
        assert started == ["task_0", "task_1", "task_2", "task_3"]
        assert not fifth_started.is_set()
        queued = await repository.get_snapshot("task_4")
        assert queued is not None
        assert queued.runs[-1].run_id == accepted[-1].run_id
        assert queued.runs[-1].status is RunStatus.QUEUED

        release["task_0"].set()
        await asyncio.wait_for(fifth_started.wait(), timeout=1)
        assert started == [
            "task_0",
            "task_1",
            "task_2",
            "task_3",
            "task_4",
        ]
    finally:
        for gate in release.values():
            gate.set()
        await manager.close()


@pytest.mark.asyncio
async def test_second_active_run_in_same_task_is_rejected(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(execution) -> None:
        started.set()
        await release.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_same"))
        first = await manager.submit_run(
            "task_same",
            StartRunRequest(request_id="req_first", input="first"),
        )
        await asyncio.wait_for(started.wait(), timeout=1)

        with pytest.raises(manager_module.TaskRunConflictError):
            await manager.submit_run(
                "task_same",
                StartRunRequest(request_id="req_second", input="second"),
            )

        snapshot = await repository.get_snapshot("task_same")
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [first.run_id]
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_same_task_conflict_precedes_full_queue_error(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_active", "task_waiting", "task_distinct"):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        await manager.submit_run(
            "task_waiting",
            StartRunRequest(request_id="req_waiting", input="waiting"),
        )

        with pytest.raises(manager_module.TaskRunConflictError):
            await manager.submit_run(
                "task_active",
                StartRunRequest(request_id="req_conflict", input="conflict"),
            )
        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_distinct",
                StartRunRequest(request_id="req_distinct", input="distinct"),
            )
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
async def test_queue_limit_rejects_excess_and_retains_fifo_order(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    queued_runs_finished = asyncio.Event()
    started: list[str] = []

    async def run(execution) -> None:
        started.append(execution.task_id)
        if execution.task_id == "task_0":
            first_started.set()
            await release_first.wait()
        if execution.task_id == "task_2":
            queued_runs_finished.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=2,
    )
    await manager.start()
    try:
        for number in range(4):
            await repository.save_snapshot(empty_snapshot(f"task_{number}"))
        await manager.submit_run(
            "task_0",
            StartRunRequest(request_id="req_0", input="question 0"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        for number in (1, 2):
            await manager.submit_run(
                f"task_{number}",
                StartRunRequest(
                    request_id=f"req_{number}",
                    input=f"question {number}",
                ),
            )

        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_3",
                StartRunRequest(request_id="req_3", input="question 3"),
            )
        rejected = await repository.get_snapshot("task_3")
        assert rejected is not None
        assert rejected.runs == []

        release_first.set()
        await asyncio.wait_for(queued_runs_finished.wait(), timeout=1)
        assert started == ["task_0", "task_1", "task_2"]
    finally:
        release_first.set()
        await manager.close()


@pytest.mark.asyncio
async def test_cancelled_waiter_releases_exactly_one_logical_queue_slot(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    next_waiter_started = asyncio.Event()
    release_next_waiter = asyncio.Event()
    executed: list[str] = []

    async def run(execution) -> None:
        executed.append(execution.task_id)
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()
        elif execution.task_id == "task_waiting_001":
            next_waiter_started.set()
            await release_next_waiter.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=100,
    )
    await manager.start()
    try:
        task_ids = (
            ["task_active"]
            + [f"task_waiting_{number:03d}" for number in range(100)]
            + [
                "task_replacement",
                "task_after_dequeue_one",
                "task_after_dequeue_two",
            ]
        )
        for task_id in task_ids:
            await repository.save_snapshot(empty_snapshot(task_id))

        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active_100", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        waiting = []
        for number in range(100):
            waiting.append(
                await manager.submit_run(
                    f"task_waiting_{number:03d}",
                    StartRunRequest(
                        request_id=f"req_waiting_{number:03d}",
                        input=f"waiting {number}",
                    ),
                )
            )

        await manager.cancel_run(
            "task_waiting_000",
            waiting[0].run_id,
        )
        await manager.submit_run(
            "task_replacement",
            StartRunRequest(request_id="req_replacement", input="replacement"),
        )

        release_active.set()
        await asyncio.wait_for(next_waiter_started.wait(), timeout=1)
        await manager.submit_run(
            "task_after_dequeue_one",
            StartRunRequest(request_id="req_after_one", input="after one"),
        )
        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_after_dequeue_two",
                StartRunRequest(request_id="req_after_two", input="after two"),
            )

        release_next_waiter.set()
        await manager.wait_until_idle()
        assert "task_waiting_000" not in executed
        assert "task_replacement" in executed
        assert "task_after_dequeue_one" in executed
    finally:
        release_active.set()
        release_next_waiter.set()
        await manager.close()


@pytest.mark.asyncio
async def test_queued_cancellation_is_ordered_and_skips_executor(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    started: list[str] = []

    async def run(execution) -> None:
        started.append(execution.task_id)
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_active", "task_queued"):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        queued = await manager.submit_run(
            "task_queued",
            StartRunRequest(request_id="req_queued", input="queued"),
        )

        cancelled = await manager.cancel_run(
            "task_queued",
            queued.run_id,
            reason="user requested",
        )
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        events = await repository.list_events("task_queued")
        assert isinstance(events[-2].payload, RunCancelRequestedPayload)
        assert isinstance(events[-1].payload, RunCancelledPayload)

        release_active.set()
        await manager.wait_until_idle()
        assert started == ["task_active"]
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
async def test_running_cancellation_signals_cancels_drains_then_persists(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()
    stream_drained = asyncio.Event()
    execution_seen = None
    drained_events: list[str] = []

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            yield "tail event"
            stream_drained.set()

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution.set_streaming_result(streaming_result)
        executor_started.set()
        async for event in streaming_result.stream_events():
            drained_events.append(event)

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_running"))
        accepted = await manager.submit_run(
            "task_running",
            StartRunRequest(request_id="req_running", input="running"),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)

        cancelled = await manager.cancel_run(
            "task_running",
            accepted.run_id,
            reason="user requested",
        )

        assert execution_seen is not None
        assert execution_seen.context.cancellation_requested.is_set()
        assert streaming_result.cancel_calls == ["after_turn"]
        assert stream_drained.is_set()
        assert drained_events == ["tail event"]
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        events = await repository.list_events("task_running")
        assert [event.payload.type.value for event in events] == [
            "run_queued",
            "run_started",
            "run_cancel_requested",
            "run_cancelled",
        ]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_startup_recovers_queued_and_interrupts_in_flight_runs_once(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    seed = TaskRepository(output_dir)
    await seed.initialize()
    statuses = {
        "task_queued_first": [
            RunQueuedPayload(request_id="req_queued_first", input="queued first")
        ],
        "task_queued_second": [
            RunQueuedPayload(request_id="req_queued_second", input="queued second")
        ],
        "task_running": [
            RunQueuedPayload(request_id="req_running", input="running"),
            RunStartedPayload(),
        ],
        "task_finalizing": [
            RunQueuedPayload(request_id="req_finalizing", input="finalizing"),
            RunStartedPayload(),
            RunFinalizingPayload(),
        ],
        "task_cancelling": [
            RunQueuedPayload(request_id="req_cancelling", input="cancelling"),
            RunStartedPayload(),
            RunCancelRequestedPayload(reason="before restart"),
        ],
    }
    try:
        for task_id, payloads in statuses.items():
            await seed.save_snapshot(empty_snapshot(task_id))
            for sequence, payload in enumerate(payloads, start=1):
                await seed.append_event(
                    build_event(
                        task_id=task_id,
                        run_id=f"run_{task_id}",
                        sequence=sequence,
                        payload=payload,
                    )
                )
    finally:
        await seed.close()

    queued_executed = asyncio.Event()
    executed: list[str] = []

    async def run(execution) -> None:
        executed.append(execution.task_id)
        if len(executed) == 2:
            queued_executed.set()

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        await asyncio.wait_for(queued_executed.wait(), timeout=1)
        await manager.wait_until_idle()
        assert executed == ["task_queued_first", "task_queued_second"]
        for task_id in (
            "task_running",
            "task_finalizing",
            "task_cancelling",
        ):
            recovered = await repository.get_snapshot(task_id)
            assert recovered is not None
            assert recovered.runs[-1].status is RunStatus.INTERRUPTED
            events = await repository.list_events(task_id)
            assert isinstance(events[-1].payload, RunInterruptedPayload)
    finally:
        await manager.close()

    unexpected: list[str] = []

    async def must_not_run(execution) -> None:
        unexpected.append(execution.task_id)

    reopened_repository = TaskRepository(output_dir)
    reopened = manager_module.TaskManager(
        reopened_repository,
        run_executor=must_not_run,
    )
    await reopened.start()
    try:
        await reopened.wait_until_idle()
        assert unexpected == []
        for task_id in (
            "task_running",
            "task_finalizing",
            "task_cancelling",
        ):
            events = await reopened_repository.list_events(task_id)
            assert (
                sum(
                    isinstance(event.payload, RunInterruptedPayload) for event in events
                )
                == 1
            )
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_fastapi_lifespan_owns_runtime_executors_and_manager(tmp_path) -> None:
    main_module = importlib.import_module("app.main")
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        runtime_max_active_runs=2,
        runtime_sync_worker_threads=3,
        runtime_run_queue_size=5,
        runtime_subscriber_queue_size=7,
    )
    application = main_module.create_app(configured)

    async with application.router.lifespan_context(application):
        manager = application.state.task_manager
        assert manager.repository is application.state.task_repository
        assert manager.event_hub is application.state.event_hub
        assert manager.max_active_runs == 2
        assert manager.max_queued_runs == 5
        assert manager.event_hub.subscriber_queue_size == 7
        assert isinstance(application.state.sync_executor, ThreadPoolExecutor)
        assert application.state.sync_executor._max_workers == 3
        assert manager.repository.index.executor is application.state.index_executor
        assert application.state.index_executor._executor._max_workers == 1

    assert application.state.sync_executor._shutdown
    assert application.state.index_executor._closed


@pytest.mark.asyncio
async def test_manager_publishes_durable_lifecycle_events_in_order(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    subscription = await hub.subscribe(task_ids={"task_events"})

    async def run(execution) -> None:
        return None

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=hub,
    )
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_events"))
        await manager.submit_run(
            "task_events",
            StartRunRequest(request_id="req_events", input="events"),
        )
        received = [
            await asyncio.wait_for(subscription.receive(), timeout=1) for _ in range(4)
        ]
        persisted = await repository.list_events("task_events")

        assert [event.sequence for event in received] == [1, 2, 3, 4]
        assert [event.event_id for event in received] == [
            event.event_id for event in persisted
        ]
    finally:
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_duplicate_request_returns_authoritative_active_run(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(execution) -> None:
        started.set()
        await release.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_idempotent"))
        request = StartRunRequest(request_id="req_same", input="question")
        first = await manager.submit_run("task_idempotent", request)
        await asyncio.wait_for(started.wait(), timeout=1)

        duplicate = await manager.submit_run("task_idempotent", request)

        assert duplicate == first
        snapshot = await repository.get_snapshot("task_idempotent")
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [first.run_id]
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_running_cancel_waits_for_late_stream_and_retry_is_idempotent(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    subscription = await hub.subscribe(task_ids={"task_cancel_race"})
    executor_entered = asyncio.Event()
    allow_stream_attach = asyncio.Event()
    release_stream = asyncio.Event()
    execution_seen = None

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            await release_stream.wait()
            if False:
                yield None

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        executor_entered.set()
        await allow_stream_attach.wait()
        execution.set_streaming_result(streaming_result)
        async for _ in streaming_result.stream_events():
            pass

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=hub,
    )
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_cancel_race"))
        accepted = await manager.submit_run(
            "task_cancel_race",
            StartRunRequest(request_id="req_cancel_race", input="race"),
        )
        await asyncio.wait_for(executor_entered.wait(), timeout=1)
        await asyncio.wait_for(subscription.receive(), timeout=1)
        await asyncio.wait_for(subscription.receive(), timeout=1)

        first_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_race", accepted.run_id)
        )
        cancel_requested = await asyncio.wait_for(subscription.receive(), timeout=1)
        assert isinstance(cancel_requested.payload, RunCancelRequestedPayload)
        assert execution_seen is not None
        assert execution_seen.context.cancellation_requested.is_set()

        retry_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_race", accepted.run_id)
        )
        allow_stream_attach.set()
        await asyncio.wait_for(streaming_result.cancel_called.wait(), timeout=1)
        release_stream.set()
        first_result, retry_result = await asyncio.gather(
            first_cancel,
            retry_cancel,
        )

        assert first_result == retry_result
        assert streaming_result.cancel_calls == ["after_turn"]
        events = await repository.list_events("task_cancel_race")
        assert (
            sum(isinstance(event.payload, RunCancelledPayload) for event in events) == 1
        )
    finally:
        allow_stream_attach.set()
        release_stream.set()
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_cancel_retry_survives_drained_terminal_append_failure(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            if False:
                yield None

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        execution.set_streaming_result(streaming_result)
        executor_started.set()
        async for _ in streaming_result.stream_events():
            pass

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_cancel_append"))
        accepted = await manager.submit_run(
            "task_cancel_append",
            StartRunRequest(request_id="req_cancel_append", input="cancel"),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)
        real_append_event = repository.append_event
        terminal_append_entered = asyncio.Event()
        release_terminal_failure = asyncio.Event()
        failed_once = False

        async def fail_first_terminal_append(event):
            nonlocal failed_once
            if isinstance(event.payload, RunCancelledPayload) and not failed_once:
                failed_once = True
                terminal_append_entered.set()
                await release_terminal_failure.wait()
                raise OSError("simulated terminal append failure")
            return await real_append_event(event)

        monkeypatch.setattr(repository, "append_event", fail_first_terminal_append)
        first_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_append", accepted.run_id)
        )
        await asyncio.wait_for(terminal_append_entered.wait(), timeout=1)
        retry_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_append", accepted.run_id)
        )
        release_terminal_failure.set()

        with pytest.raises(OSError, match="terminal append failure"):
            await first_cancel
        cancelled = await retry_cancel

        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        assert streaming_result.cancel_calls == ["after_turn"]
        events = await repository.list_events("task_cancel_append")
        assert (
            sum(isinstance(event.payload, RunCancelledPayload) for event in events) == 1
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_worker_survives_finalization_failure_and_runs_next_item(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_executed = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_worker_failure":
            first_started.set()
            await release_first.wait()
        elif execution.task_id == "task_worker_next":
            second_executed.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_worker_failure", "task_worker_next"):
            await repository.save_snapshot(empty_snapshot(task_id))
        real_append_event = repository.append_event
        failed_once = False

        async def fail_first_finalizing_append(event):
            nonlocal failed_once
            if (
                event.task_id == "task_worker_failure"
                and isinstance(event.payload, RunFinalizingPayload)
                and not failed_once
            ):
                failed_once = True
                raise OSError("simulated finalization append failure")
            return await real_append_event(event)

        monkeypatch.setattr(repository, "append_event", fail_first_finalizing_append)
        caplog.set_level(logging.ERROR, logger="app.runtime.manager")
        await manager.submit_run(
            "task_worker_failure",
            StartRunRequest(request_id="req_worker_failure", input="first"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        await manager.submit_run(
            "task_worker_next",
            StartRunRequest(request_id="req_worker_next", input="second"),
        )

        release_first.set()
        await asyncio.wait_for(second_executed.wait(), timeout=1)
        await manager.wait_until_idle()

        failed = await repository.get_snapshot("task_worker_failure")
        completed = await repository.get_snapshot("task_worker_next")
        assert failed is not None
        assert failed.runs[-1].status is RunStatus.FAILED
        assert "simulated finalization append failure" in (failed.runs[-1].error or "")
        assert completed is not None
        assert completed.runs[-1].status is RunStatus.COMPLETED
        assert "run worker failed" in caplog.text
    finally:
        release_first.set()
        await manager.close()


@pytest.mark.asyncio
async def test_close_cancels_live_workers_without_waiting_for_executor(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    executor_cancelled = asyncio.Event()

    async def run(execution) -> None:
        executor_started.set()
        try:
            await release_executor.wait()
        except asyncio.CancelledError:
            executor_cancelled.set()
            raise

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    await repository.save_snapshot(empty_snapshot("task_shutdown"))
    await manager.submit_run(
        "task_shutdown",
        StartRunRequest(request_id="req_shutdown", input="shutdown"),
    )
    await asyncio.wait_for(executor_started.wait(), timeout=1)
    workers = tuple(manager._workers)
    close_task = asyncio.create_task(manager.close())
    try:
        done, _ = await asyncio.wait({close_task}, timeout=0.1)
        assert close_task in done
        assert executor_cancelled.is_set()
        assert manager._running == {}
        assert all(worker.done() for worker in workers)
    finally:
        release_executor.set()
        await close_task


@pytest.mark.asyncio
async def test_close_waits_for_in_flight_admission_before_repository_shutdown(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    admission_entered = asyncio.Event()
    release_admission = asyncio.Event()

    async def run(execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    await repository.save_snapshot(empty_snapshot("task_admission"))
    real_find_request = repository.find_request

    async def blocked_find_request(request_id: str):
        admission_entered.set()
        await release_admission.wait()
        return await real_find_request(request_id)

    monkeypatch.setattr(repository, "find_request", blocked_find_request)
    submission = asyncio.create_task(
        manager.submit_run(
            "task_admission",
            StartRunRequest(request_id="req_admission", input="admission"),
        )
    )
    await asyncio.wait_for(admission_entered.wait(), timeout=1)
    close_task = asyncio.create_task(manager.close())
    try:
        done, _ = await asyncio.wait({close_task}, timeout=0.1)
        assert close_task not in done
        release_admission.set()
        accepted = await submission
        await close_task
        assert accepted.task_id == "task_admission"
    finally:
        release_admission.set()
        await asyncio.gather(submission, close_task, return_exceptions=True)
