from __future__ import annotations

import asyncio
import json
import threading
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import app.agent_loop.runner as runner_module
import app.runtime.manager as manager_module
import pytest
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
    TaskState,
    ValidationSummary,
    build_event,
)
from app.pipeline.stages import PipelineCancelledError
from app.runtime.repository import TaskRepository


def completed_manifest(task_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        task_id=task_id,
        task_state=TaskState.COMPLETED,
        artifacts=[],
        validation=SimpleNamespace(status="valid"),
    )


class CompletedRunner:
    def __init__(self, **kwargs) -> None:
        self.task_id = kwargs["task_id"]

    async def run(self) -> SimpleNamespace:
        return completed_manifest(self.task_id)


def completed_runner_factory(**kwargs) -> CompletedRunner:
    return CompletedRunner(**kwargs)


async def run_blocking_with_drain(operation):
    worker = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        with suppress(BaseException):
            await asyncio.shield(worker)
        raise


@pytest.mark.asyncio
async def test_fixture_completion_projects_one_user_message_across_restart(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "_load_fixture_events", lambda _path: [])
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    fixture_executor = runner_module.FixtureRunExecutor(
        repository,
        fixture_dir=tmp_path / "fixture",
        pipeline_runner_factory=completed_runner_factory,
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
        assert completed.messages[0].run_id == accepted.run_id
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
        assert restarted.messages[0].run_id == accepted.run_id
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
        lifecycle_types = [
            event.payload.type.value
            for event in runtime_events
            if event.payload.type.value.startswith("run_")
        ]
        assert lifecycle_types[-2:] == [
            "run_finalizing",
            "run_completed",
        ]

        legacy_path = repository.tasks_dir / accepted.task_id / "logs" / "events.jsonl"
        legacy_events = [
            EventEnvelope.model_validate_json(line)
            for line in legacy_path.read_text("utf-8").splitlines()
        ]
        bridged_events = [
            event
            for event in runtime_events
            if not event.payload.type.value.startswith("run_")
        ]
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
async def test_pipeline_manifest_failure_never_becomes_run_completed(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "_load_fixture_events", lambda _path: [])

    def failed_factory(**kwargs):
        class FailedRunner:
            async def run(self):
                return SimpleNamespace(
                    task_id=kwargs["task_id"],
                    task_state=TaskState.FAILED,
                    artifacts=[],
                    validation=SimpleNamespace(status="invalid"),
                )

        return FailedRunner()

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=tmp_path / "fixture",
            pipeline_runner_factory=failed_factory,
        ),
    )
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_failed_manifest",
            input="failed manifest",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    try:
        await manager.wait_until_idle()
        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.runs[0].status is RunStatus.FAILED
        event_types = [event.payload.type.value for event in await repository.list_events(accepted.task_id)]
        assert "run_completed" not in event_types
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_pipeline_manifest_cancellation_maps_to_cancelled_run(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "_load_fixture_events", lambda _path: [])
    worker_started = threading.Event()

    def cancellable_factory(**kwargs):
        class CancellableRunner:
            async def run(self):
                worker_started.set()
                while not kwargs["cancellation_requested"].is_set():
                    await asyncio.sleep(0)
                return SimpleNamespace(
                    task_id=kwargs["task_id"],
                    task_state=TaskState.CANCELLED,
                    artifacts=[],
                    validation=SimpleNamespace(status="invalid"),
                )

        return CancellableRunner()

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=tmp_path / "fixture",
            pipeline_runner_factory=cancellable_factory,
        ),
    )
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_cancelled_manifest",
            input="cancelled manifest",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(worker_started.wait, 1),
            timeout=2,
        )
        await manager.cancel_run(accepted.task_id, accepted.run_id)
        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.runs[0].status is RunStatus.CANCELLED
        event_types = [event.payload.type.value for event in await repository.list_events(accepted.task_id)]
        assert "run_completed" not in event_types
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

    def controlled_factory(**kwargs):
        class ControlledRunner:
            async def run(self):
                def blocking_run():
                    worker_started.set()
                    release_worker.wait()
                    try:
                        assert kwargs["cancellation_requested"].is_set()
                        worker_effects.append("worker finished")
                    finally:
                        worker_exited.set()
                    return completed_manifest(kwargs["task_id"])

                return await run_blocking_with_drain(blocking_run)

        return ControlledRunner()
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
        pipeline_runner_factory=controlled_factory,
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

    def controlled_factory(**kwargs):
        class ControlledRunner:
            async def run(self):
                def blocking_run():
                    worker_started.set()
                    release_worker.wait()
                    try:
                        assert kwargs["cancellation_requested"].is_set()
                    finally:
                        worker_exited.set()
                    return completed_manifest(kwargs["task_id"])

                return await run_blocking_with_drain(blocking_run)

        return ControlledRunner()
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
            pipeline_runner_factory=controlled_factory,
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

    def cancel_before_bridge_factory(**kwargs):
        class CancelBeforeBridgeRunner:
            async def run(self):
                kwargs["cancellation_requested"].set()
                return completed_manifest(kwargs["task_id"])

        return CancelBeforeBridgeRunner()

    def load_events(path):
        nonlocal loader_called
        loader_called = True
        return []

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
        pipeline_runner_factory=cancel_before_bridge_factory,
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
        pipeline_runner_factory=completed_runner_factory,
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert emitted == [
        event.payload.type.value for event in legacy_events[:cancel_after]
    ]


@pytest.mark.asyncio
async def test_runtime_completion_seals_fixture_publication_against_late_cancel(
    tmp_path,
) -> None:
    publication_finished = threading.Event()
    release_publication = threading.Event()

    class BlockingPublicationRunner(runner_module.PipelineRunner):
        def publish(self, run_id: str) -> None:
            super().publish(run_id)
            publication_finished.set()
            release_publication.wait()

    def blocking_factory(**kwargs):
        return BlockingPublicationRunner(**kwargs)

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=(
                Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
            ),
            pipeline_runner_factory=blocking_factory,
        ),
    )
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_publication_race",
            input="publication race",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    cancel_task: asyncio.Task | None = None
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(publication_finished.wait, 2),
            timeout=3,
        )
        cancel_task = asyncio.create_task(
            manager.cancel_run(accepted.task_id, accepted.run_id)
        )
        await asyncio.sleep(0.05)
        assert not cancel_task.done()

        release_publication.set()
        await manager.wait_until_idle()
        with pytest.raises(RuntimeError, match="not cancellable"):
            await cancel_task

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.runs[-1].status is RunStatus.COMPLETED
        task_root = repository.tasks_dir / accepted.task_id
        assert (task_root / "artifacts" / "run_manifest.json").is_file()
        marker = json.loads(
            (task_root / "artifacts" / ".runtime-publication.json").read_text(
                "utf-8"
            )
        )
        assert marker["run_id"] == accepted.run_id
    finally:
        release_publication.set()
        if cancel_task is not None:
            await asyncio.gather(cancel_task, return_exceptions=True)
        await manager.close()
