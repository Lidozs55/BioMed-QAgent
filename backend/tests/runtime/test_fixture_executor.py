from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace

import pytest

import app.agent_loop.runner as runner_module
import app.runtime.manager as manager_module
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    EventEnvelope,
    MessageRole,
    RunStatus,
    StageName,
    StageStartedPayload,
    StartRunRequest,
    StartTaskRequest,
    TaskCompletedPayload,
    TaskCreatedPayload,
    TaskMode,
    ValidationSummary,
    build_event,
)
from app.pipeline.pinned_case import PipelineCancelledError
from app.runtime.repository import TaskRepository


@pytest.mark.asyncio
async def test_fixture_completion_projects_one_user_message_across_restart(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def complete_fixture(**_kwargs) -> None:
        return None

    monkeypatch.setattr(runner_module, "run_pinned_fixture", complete_fixture)
    monkeypatch.setattr(runner_module, "_load_fixture_events", lambda _path: [])
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    fixture_executor = runner_module.FixtureRunExecutor(
        repository,
        fixture_dir=tmp_path / "fixture",
    )

    async def run_twice(execution) -> None:
        await fixture_executor(execution)
        await fixture_executor(execution)

    manager = manager_module.TaskManager(repository, run_executor=run_twice)
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_message_projection",
            input="  durable fixture question  ",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    try:
        await manager.wait_until_idle()

        completed = await repository.get_snapshot(accepted.task_id)
        assert completed is not None
        assert completed.task.status is RunStatus.COMPLETED
        assert len(completed.messages) == 1
        assert completed.messages[0].role is MessageRole.USER
        assert completed.messages[0].content == "durable fixture question"
        live_page = await repository.list_messages(accepted.task_id)
        assert live_page.messages == completed.messages
    finally:
        await manager.close()

    reopened = TaskRepository(output_dir)
    await reopened.initialize()
    try:
        restarted = await reopened.get_snapshot(accepted.task_id)
        assert restarted is not None
        assert len(restarted.messages) == 1
        assert restarted.messages[0].role is MessageRole.USER
        assert restarted.messages[0].content == "durable fixture question"
        restarted_page = await reopened.list_messages(accepted.task_id)
        assert restarted_page.messages == restarted.messages
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_real_pinned_fixture_first_run_bridges_legacy_events_durably(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.ModeDispatchRunExecutor(repository),
    )
    await manager.start()
    request = StartTaskRequest(
        request_id="req_fixture_durable",
        input="  durable fixture topic  ",
        databases=["geo", "pubmed"],
        mode=TaskMode.FIXTURE,
    )
    try:
        accepted = await manager.create_task(request)

        assert accepted.status is RunStatus.QUEUED
        assert accepted.task_id.startswith("task_")
        assert accepted.run_id.startswith("run_")
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.task.mode is TaskMode.FIXTURE
        assert snapshot.task.databases == ["geo", "pubmed"]
        assert snapshot.task.status is RunStatus.COMPLETED
        assert snapshot.task.active_run_id is None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == accepted.run_id
        assert snapshot.runs[0].status is RunStatus.COMPLETED

        runtime_events = await repository.list_events(accepted.task_id)
        assert [event.sequence for event in runtime_events] == list(
            range(1, len(runtime_events) + 1)
        )
        assert [event.payload.type.value for event in runtime_events[:2]] == [
            "run_queued",
            "run_started",
        ]
        assert [event.payload.type.value for event in runtime_events[-2:]] == [
            "run_finalizing",
            "run_completed",
        ]

        legacy_path = repository.tasks_dir / accepted.task_id / "logs" / "events.jsonl"
        legacy_events = [
            EventEnvelope.model_validate_json(line)
            for line in legacy_path.read_text("utf-8").splitlines()
        ]
        bridged_events = runtime_events[2:-2]
        assert len(bridged_events) == len(legacy_events)
        for bridged, legacy in zip(bridged_events, legacy_events, strict=True):
            assert bridged.schema_version == "2.0"
            assert bridged.run_id == accepted.run_id
            assert bridged.type == legacy.type
            assert bridged.payload == legacy.payload
            assert bridged.stage_attempt_id == legacy.stage_attempt_id
            assert bridged.timestamp == legacy.timestamp
            assert bridged.event_id != legacy.event_id

        manifest_path = (
            repository.tasks_dir / accepted.task_id / "artifacts" / "run_manifest.json"
        )
        manifest = json.loads(manifest_path.read_text("utf-8"))
        assert manifest["request"]["topic"] == "durable fixture topic"

        with pytest.raises(manager_module.FixtureTaskContinuationError):
            await manager.submit_run(
                accepted.task_id,
                StartRunRequest(
                    request_id="req_fixture_new_continuation",
                    input="continue fixture",
                ),
            )
        with pytest.raises(manager_module.FixtureTaskContinuationError):
            await manager.submit_run(
                accepted.task_id,
                StartRunRequest(
                    request_id=request.request_id,
                    input="reuse create request",
                ),
            )
        unchanged = await repository.get_snapshot(accepted.task_id)
        assert unchanged is not None
        assert len(unchanged.runs) == 1
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_executor_cancellation_sets_token_and_drains_sync_worker(
    tmp_path,
    monkeypatch,
) -> None:
    worker_started = threading.Event()
    release_worker = threading.Event()
    worker_exited = threading.Event()
    worker_effects: list[str] = []

    def controlled_fixture(*, cancellation_requested, **kwargs) -> None:
        worker_started.set()
        release_worker.wait()
        try:
            assert cancellation_requested.is_set()
            worker_effects.append("worker finished")
        finally:
            worker_exited.set()

    monkeypatch.setattr(runner_module, "run_pinned_fixture", controlled_fixture)
    context = RunContext(task_id="task_fixture_executor_cancel")
    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_executor_cancel",
        request_id="req_fixture_executor_cancel",
        input="cancel controlled fixture",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
    )
    executor_task = asyncio.create_task(executor(execution))
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(worker_started.wait, 1),
            timeout=2,
        )
        executor_task.cancel()
        await asyncio.sleep(0)

        assert context.cancellation_requested.is_set()
        assert not executor_task.done()

        release_worker.set()
        with pytest.raises(asyncio.CancelledError):
            await executor_task
        assert worker_exited.is_set()
        effects_after_cancellation = list(worker_effects)
        await asyncio.sleep(0)
        assert worker_effects == effects_after_cancellation == ["worker finished"]
    finally:
        release_worker.set()
        await asyncio.gather(executor_task, return_exceptions=True)
        assert await asyncio.wait_for(
            asyncio.to_thread(worker_exited.wait, 1),
            timeout=2,
        )


@pytest.mark.asyncio
async def test_manager_close_drains_fixture_worker_before_repository_close(
    tmp_path,
    monkeypatch,
) -> None:
    worker_started = threading.Event()
    release_worker = threading.Event()
    worker_exited = threading.Event()
    close_observations: list[bool] = []

    def controlled_fixture(*, cancellation_requested, **kwargs) -> None:
        worker_started.set()
        release_worker.wait()
        try:
            assert cancellation_requested.is_set()
        finally:
            worker_exited.set()

    monkeypatch.setattr(runner_module, "run_pinned_fixture", controlled_fixture)
    repository = TaskRepository(tmp_path / "output")
    real_close = repository.close

    async def observed_close() -> None:
        close_observations.append(worker_exited.is_set())
        await real_close()

    monkeypatch.setattr(repository, "close", observed_close)
    contexts: list[RunContext] = []

    def create_context(task_id: str) -> RunContext:
        context = RunContext(task_id=task_id)
        contexts.append(context)
        return context

    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=tmp_path / "fixture",
        ),
        context_factory=create_context,
    )
    await manager.start()
    await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_close",
            input="close controlled fixture",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    assert await asyncio.wait_for(
        asyncio.to_thread(worker_started.wait, 1),
        timeout=2,
    )
    close_task = asyncio.create_task(manager.close())
    try:
        done, _ = await asyncio.wait({close_task}, timeout=0.05)
        assert close_task not in done
        assert len(contexts) == 1
        assert contexts[0].cancellation_requested.is_set()
        assert close_observations == []

        release_worker.set()
        await asyncio.wait_for(close_task, timeout=1)
        assert worker_exited.is_set()
        assert close_observations == [True]
    finally:
        release_worker.set()
        await asyncio.gather(close_task, return_exceptions=True)
        assert await asyncio.wait_for(
            asyncio.to_thread(worker_exited.wait, 1),
            timeout=2,
        )


@pytest.mark.asyncio
async def test_fixture_bridge_checks_cancellation_before_loading_legacy_events(
    tmp_path,
    monkeypatch,
) -> None:
    context = RunContext(task_id="task_fixture_cancel_before_load")
    loader_called = False

    def cancel_before_bridge(*, cancellation_requested, **kwargs) -> None:
        cancellation_requested.set()

    def load_events(path):
        nonlocal loader_called
        loader_called = True
        return []

    monkeypatch.setattr(runner_module, "run_pinned_fixture", cancel_before_bridge)
    monkeypatch.setattr(runner_module, "_load_fixture_events", load_events)
    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_cancel_before_load",
        request_id="req_fixture_cancel_before_load",
        input="cancel before fixture bridge",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert not loader_called


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_after", [1, 2])
async def test_fixture_bridge_stops_before_event_after_cancellation(
    tmp_path,
    monkeypatch,
    cancel_after: int,
) -> None:
    context = RunContext(task_id=f"task_fixture_bridge_cancel_{cancel_after}")
    validation = ValidationSummary(
        status="valid",
        checked_count=1,
        failed_count=0,
        report_path="logs/validation_report.json",
    )
    legacy_events = [
        build_event(
            task_id=context.task_id,
            sequence=1,
            payload=TaskCreatedPayload(topic="fixture bridge cancellation"),
        ),
        build_event(
            task_id=context.task_id,
            sequence=2,
            payload=StageStartedPayload(stage=StageName.DISCOVERY, attempt=1),
            stage_attempt_id="stage_attempt_discovery_1",
        ),
        build_event(
            task_id=context.task_id,
            sequence=3,
            payload=TaskCompletedPayload(validation=validation),
        ),
    ]
    emitted: list[str] = []

    def complete_fixture(**kwargs) -> None:
        return None

    monkeypatch.setattr(runner_module, "run_pinned_fixture", complete_fixture)
    monkeypatch.setattr(
        runner_module,
        "_load_fixture_events",
        lambda path: legacy_events,
    )

    async def emit(payload, **kwargs):
        emitted.append(payload.type.value)
        if len(emitted) == cancel_after:
            context.cancellation_requested.set()
        return SimpleNamespace()

    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id=f"run_fixture_bridge_cancel_{cancel_after}",
        request_id=f"req_fixture_bridge_cancel_{cancel_after}",
        input="cancel during fixture bridge",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
        _event_emitter=emit,
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert emitted == [
        event.payload.type.value for event in legacy_events[:cancel_after]
    ]
