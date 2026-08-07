from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import threading
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import app.agent_loop.runner as runner_module
import app.runtime.manager as manager_module
import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    CancelRequestedPayload,
    MessageRole,
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunStatus,
    StageName,
    StageStartedPayload,
    StartRunRequest,
    StartTaskRequest,
    TaskCompletedPayload,
    TaskCreatedPayload,
    TaskMode,
    TaskState,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    ValidationSummary,
    build_event,
)
from app.domain.contracts.dataset_state import ArtifactRole, BuildResultStatus
from app.pipeline.stages import PipelineCancelledError
from app.runtime.repository import TaskRepository


def completed_manifest(task_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        task_id=task_id,
        task_state=TaskState.COMPLETED,
        artifacts=[],
        validation=SimpleNamespace(status="valid"),
        build_result=None,
    )


class CompletedRunner:
    def __init__(self, **kwargs) -> None:
        self.task_id = kwargs["task_id"]
        self.events: list = []

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
async def test_fixture_stage_started_is_durable_before_stage_body_finishes(
    tmp_path,
) -> None:
    stage_entered = threading.Event()
    release_stage = threading.Event()

    class BlockingDiscoveryRunner(runner_module.PipelineRunner):
        def _execute_stage(self, stage, stage_outputs, stage_attempt_id):
            if stage is StageName.DISCOVERY:
                stage_entered.set()
                release_stage.wait()
            return super()._execute_stage(stage, stage_outputs, stage_attempt_id)

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=(
                Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
            ),
            pipeline_runner_factory=BlockingDiscoveryRunner,
        ),
    )
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_stage_started_durable",
            input="durable stage start",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(stage_entered.wait, 1),
            timeout=2,
        )

        events = await repository.list_events(accepted.task_id)
        stage_started = [
            event
            for event in events
            if event.payload.type.value == "stage_started"
        ]
        assert len(stage_started) == 1
        assert stage_started[0].run_id == accepted.run_id
        assert [event.sequence for event in events] == list(
            range(1, len(events) + 1)
        )
    finally:
        release_stage.set()
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_cancellation_preserves_prior_durable_audit_events(
    tmp_path,
) -> None:
    stage_entered = threading.Event()
    release_stage = threading.Event()

    class BlockingDiscoveryRunner(runner_module.PipelineRunner):
        def _execute_stage(self, stage, stage_outputs, stage_attempt_id):
            if stage is StageName.DISCOVERY:
                stage_entered.set()
                release_stage.wait()
            return super()._execute_stage(stage, stage_outputs, stage_attempt_id)

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=(
                Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
            ),
            pipeline_runner_factory=BlockingDiscoveryRunner,
        ),
    )
    await manager.start()
    accepted = await manager.create_task(
        StartTaskRequest(
            request_id="req_fixture_cancel_preserves_audit",
            input="cancel after durable audit",
            databases=["pubmed", "geo"],
            mode=TaskMode.FIXTURE,
        )
    )
    cancel_task: asyncio.Task | None = None
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(stage_entered.wait, 1),
            timeout=2,
        )
        before_cancel = await repository.list_events(accepted.task_id)
        assert "stage_started" in {
            event.payload.type.value for event in before_cancel
        }

        cancel_task = asyncio.create_task(
            manager.cancel_run(
                accepted.task_id,
                accepted.run_id,
                reason="test cancellation",
            )
        )
        for _ in range(100):
            during_cancel = await repository.list_events(accepted.task_id)
            if any(
                event.payload.type.value == "run_cancel_requested"
                for event in during_cancel
            ):
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("run_cancel_requested was not persisted")

        release_stage.set()
        await asyncio.wait_for(cancel_task, timeout=2)

        final_events = await repository.list_events(accepted.task_id)
        assert [event.event_id for event in final_events[: len(before_cancel)]] == [
            event.event_id for event in before_cancel
        ]
        final_types = [event.payload.type.value for event in final_events]
        assert "task_cancelled" in final_types
        assert "run_cancelled" in final_types
        assert "artifact_produced" not in final_types
        assert "task_completed" not in final_types
        assert "run_completed" not in final_types
        assert [event.sequence for event in final_events] == list(
            range(1, len(final_events) + 1)
        )
        assert all(event.run_id == accepted.run_id for event in final_events)
    finally:
        release_stage.set()
        if cancel_task is not None:
            await asyncio.gather(cancel_task, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_completion_projects_one_user_message_across_restart(
    tmp_path,
) -> None:
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
        user_input_events = [
            event
            for event in runtime_events
            if isinstance(
                event.payload,
                (UserInputRequiredPayload, UserInputResumedPayload),
            )
        ]
        assert [event.payload.type.value for event in user_input_events] == [
            "user_input_required",
            "user_input_resumed",
        ]
        assert all(event.run_id == accepted.run_id for event in user_input_events)
        assert isinstance(user_input_events[0].payload, UserInputRequiredPayload)
        assert user_input_events[0].payload.fixture_exempt
        assert isinstance(user_input_events[1].payload, UserInputResumedPayload)
        assert user_input_events[1].payload.request_id == (
            user_input_events[0].payload.request_id
        )
        assert user_input_events[1].payload.decision == "approve"

        manifest_path = (
            repository.tasks_dir / accepted.task_id / "artifacts" / "run_manifest.json"
        )
        manifest = json.loads(manifest_path.read_text("utf-8"))
        assert manifest["request"]["topic"] == "durable fixture topic"
        build_checkpoint = json.loads(
            (
                repository.tasks_dir
                / accepted.task_id
                / "state"
                / "artifact_build_output.json"
            ).read_text("utf-8")
        )
        assert (
            Path(build_checkpoint["output"]["staging_dir"]).name
            == accepted.run_id
        )

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
) -> None:
    def failed_factory(**kwargs):
        class FailedRunner:
            def __init__(self) -> None:
                self.events: list = []

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
) -> None:
    worker_started = threading.Event()

    def cancellable_factory(**kwargs):
        class CancellableRunner:
            def __init__(self) -> None:
                self.events: list = []

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
            def __init__(self) -> None:
                self.events: list = []

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
async def test_fixture_executor_aborts_validated_runner_on_cancellation(
    tmp_path,
) -> None:
    abort_calls = 0
    context = RunContext(
        task_id="task_fixture_abort",
        base_dir=tmp_path / "output" / "tasks",
        managed_run_id="run_fixture_abort",
    )
    context.cancellation_requested.set()

    class AbortableRunner:
        def __init__(self) -> None:
            self.events: list = []

        async def run(self):
            return completed_manifest(context.task_id)

        def abort(self) -> None:
            nonlocal abort_calls
            abort_calls += 1

    runner = AbortableRunner()
    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_abort",
        request_id="req_fixture_abort",
        input="cancel validated fixture",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
        pipeline_runner_factory=lambda **kwargs: runner,
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert abort_calls == 1


@pytest.mark.asyncio
async def test_fixture_pretransfer_abort_failure_cannot_be_cancelled(
    tmp_path: Path,
) -> None:
    abort_calls = 0
    runner_entered = asyncio.Event()

    class AbortFailingRunner:
        def __init__(self, **kwargs) -> None:
            self.task_id = str(kwargs["task_id"])
            self.run_id = str(kwargs["run_id"])
            self.cancellation_requested = kwargs["cancellation_requested"]
            self.events: list = []
            self.staging = Path(kwargs["base_dir"]) / self.task_id / "staging" / self.run_id
            self.staging.mkdir(parents=True, exist_ok=True)
            (self.staging / "cleanup-diagnostic.txt").write_text(
                "preserve failed cleanup\n",
                encoding="utf-8",
            )

        async def run(self) -> SimpleNamespace:
            runner_entered.set()
            await self.cancellation_requested.wait()
            return completed_manifest(self.task_id)

        def abort(self) -> None:
            nonlocal abort_calls
            abort_calls += 1
            raise OSError("fixture pretransfer staging cleanup failed")

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=tmp_path / "fixture",
            pipeline_runner_factory=AbortFailingRunner,
        ),
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_pretransfer_abort_failure",
                input="cancel fixture with persistent cleanup failure",
                databases=["pubmed", "geo"],
                mode=TaskMode.FIXTURE,
            )
        )
        await asyncio.wait_for(runner_entered.wait(), timeout=2)

        with pytest.raises(RuntimeError, match="completion abort failed"):
            await asyncio.wait_for(
                manager.cancel_run(accepted.task_id, accepted.run_id),
                timeout=5,
            )
        await manager.wait_until_idle()

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status is RunStatus.FAILED
        failure_error = failed.runs[-1].error or ""
        assert "fixture pretransfer staging cleanup failed" in failure_error
        assert "completion abort also failed" in failure_error
        staging = repository.tasks_dir / accepted.task_id / "staging" / accepted.run_id
        assert (staging / "cleanup-diagnostic.txt").is_file()
        assert abort_calls == 2
        events = await repository.list_events(accepted.task_id)
        assert not any(event.payload.type.value == "run_cancelled" for event in events)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_pretransfer_abort_retry_success_can_be_cancelled(
    tmp_path: Path,
) -> None:
    abort_calls = 0
    runner_entered = asyncio.Event()

    class TransientAbortFailingRunner:
        def __init__(self, **kwargs) -> None:
            self.task_id = str(kwargs["task_id"])
            self.run_id = str(kwargs["run_id"])
            self.cancellation_requested = kwargs["cancellation_requested"]
            self.events: list = []
            self.staging = Path(kwargs["base_dir"]) / self.task_id / "staging" / self.run_id
            self.staging.mkdir(parents=True, exist_ok=True)
            (self.staging / "cleanup-diagnostic.txt").write_text(
                "remove after retry\n",
                encoding="utf-8",
            )

        async def run(self) -> SimpleNamespace:
            runner_entered.set()
            await self.cancellation_requested.wait()
            return completed_manifest(self.task_id)

        def abort(self) -> None:
            nonlocal abort_calls
            abort_calls += 1
            if abort_calls == 1:
                raise OSError("fixture transient staging cleanup failed")
            shutil.rmtree(self.staging)

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=tmp_path / "fixture",
            pipeline_runner_factory=TransientAbortFailingRunner,
        ),
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_pretransfer_abort_retry",
                input="cancel fixture after transient cleanup failure",
                databases=["pubmed", "geo"],
                mode=TaskMode.FIXTURE,
            )
        )
        await asyncio.wait_for(runner_entered.wait(), timeout=2)

        cancelled = await asyncio.wait_for(
            manager.cancel_run(accepted.task_id, accepted.run_id),
            timeout=5,
        )
        await manager.wait_until_idle()

        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        staging = repository.tasks_dir / accepted.task_id / "staging" / accepted.run_id
        assert not staging.exists()
        assert abort_calls == 2
        events = await repository.list_events(accepted.task_id)
        assert any(event.payload.type.value == "run_cancelled" for event in events)
    finally:
        await manager.close()


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
            def __init__(self) -> None:
                self.events: list = []

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
async def test_fixture_bridge_replays_buffered_audit_before_existing_cancellation(
    tmp_path,
) -> None:
    context = RunContext(task_id="task_fixture_cancel_before_load")
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
            payload=TaskCreatedPayload(topic="fixture buffered audit"),
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
            payload=CancelRequestedPayload(reason="pipeline-local cancellation"),
        ),
        build_event(
            task_id=context.task_id,
            sequence=4,
            payload=ArtifactProducedPayload(
                artifact=ArtifactManifestEntry(
                    artifact_id="artifact_buffered_cancel",
                    role=ArtifactRole.AUDIT_REPORT,
                    name="cancelled.csv",
                    relative_path="artifacts/cancelled.csv",
                    media_type="text/csv",
                    size_bytes=1,
                    sha256="ab" * 32,
                    generated_by_step_id="step_buffered_cancel",
                )
            ),
        ),
        build_event(
            task_id=context.task_id,
            sequence=5,
            payload=TaskCompletedPayload(validation=validation),
        ),
    ]
    emitted: list[str] = []

    def cancel_before_bridge_factory(**kwargs):
        class CancelBeforeBridgeRunner:
            def __init__(self) -> None:
                self.events = list(legacy_events)

            async def run(self):
                kwargs["cancellation_requested"].set()
                return completed_manifest(kwargs["task_id"])

        return CancelBeforeBridgeRunner()

    async def emit(payload, **kwargs):
        emitted.append(payload.type.value)
        return SimpleNamespace()

    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_cancel_before_load",
        request_id="req_fixture_cancel_before_load",
        input="cancel before fixture bridge",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
        _event_emitter=emit,
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
        pipeline_runner_factory=cancel_before_bridge_factory,
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert emitted == ["task_created", "stage_started"]


@pytest.mark.asyncio
async def test_fixture_bridge_finishes_buffered_audit_after_mid_replay_cancellation(
    tmp_path,
) -> None:
    context = RunContext(task_id="task_fixture_bridge_cancel_mid_replay")
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
            payload=CancelRequestedPayload(reason="pipeline-local cancellation"),
        ),
        build_event(
            task_id=context.task_id,
            sequence=4,
            payload=TaskCompletedPayload(validation=validation),
        ),
    ]
    emitted: list[str] = []

    def legacy_events_factory(**kwargs):
        class LegacyEventsRunner:
            def __init__(self) -> None:
                self.events = list(legacy_events)

            async def run(self):
                return completed_manifest(kwargs["task_id"])

        return LegacyEventsRunner()

    async def emit(payload, **kwargs):
        emitted.append(payload.type.value)
        if len(emitted) == 1:
            context.cancellation_requested.set()
        return SimpleNamespace()

    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_bridge_cancel_mid_replay",
        request_id="req_fixture_bridge_cancel_mid_replay",
        input="cancel during fixture bridge",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
        _event_emitter=emit,
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
        pipeline_runner_factory=legacy_events_factory,
    )

    with pytest.raises(PipelineCancelledError):
        await executor(execution)

    assert emitted == ["task_created", "stage_started"]


@pytest.mark.asyncio
async def test_fixture_stream_does_not_replay_the_same_fallback_event(
    tmp_path,
) -> None:
    context = RunContext(task_id="task_fixture_stream_dedup")
    event = build_event(
        task_id=context.task_id,
        sequence=1,
        payload=TaskCreatedPayload(topic="streamed once"),
    )
    local_only_event = build_event(
        task_id=context.task_id,
        sequence=2,
        payload=CancelRequestedPayload(reason="legacy local cancellation"),
    )

    def streamed_and_buffered_factory(**kwargs):
        class StreamedAndBufferedRunner:
            def __init__(self) -> None:
                self.events = [event, local_only_event]
                self._event_sink = None

            def set_event_sink(self, sink) -> None:
                self._event_sink = sink

            async def run(self):
                assert self._event_sink is not None
                await self._event_sink(event)
                return completed_manifest(kwargs["task_id"])

        return StreamedAndBufferedRunner()

    emitted: list[str] = []

    async def emit(payload, **kwargs):
        emitted.append(payload.type.value)
        return SimpleNamespace()

    execution = manager_module.RunExecution(
        task_id=context.task_id,
        run_id="run_fixture_stream_dedup",
        request_id="req_fixture_stream_dedup",
        input="stream fixture event once",
        context=context,
        mode=TaskMode.FIXTURE,
        databases=["pubmed", "geo"],
        _event_emitter=emit,
    )
    executor = runner_module.FixtureRunExecutor(
        TaskRepository(tmp_path / "output"),
        fixture_dir=tmp_path / "fixture",
        pipeline_runner_factory=streamed_and_buffered_factory,
    )

    await executor(execution)

    assert emitted == ["task_created"]


@pytest.mark.asyncio
async def test_runtime_completion_seals_fixture_publication_against_late_cancel(
    tmp_path,
) -> None:
    publication_finished = threading.Event()
    release_publication = threading.Event()
    abort_calls = 0

    class BlockingPublicationRunner(runner_module.PipelineRunner):
        def publish(self, run_id: str) -> None:
            super().publish(run_id)
            publication_finished.set()
            release_publication.wait()

        def abort(self) -> None:
            nonlocal abort_calls
            abort_calls += 1
            super().abort()

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
        # 竞态测试：等待 publication 已开始（publish 阻塞在 release 上）。
        # 预算放宽到 30s——fixture 管线在慢速/负载环境下可能超过 2s，
        # 但竞态语义不变（cancel 仍在 publish 进行中提交）。
        assert await asyncio.wait_for(
            asyncio.to_thread(publication_finished.wait, 30),
            timeout=35,
        )
        cancel_task = asyncio.create_task(
            manager.cancel_run(accepted.task_id, accepted.run_id)
        )
        await asyncio.sleep(0.05)
        assert not cancel_task.done()
        execution = manager._running[(accepted.task_id, accepted.run_id)]
        assert not execution.context.cancellation_requested.is_set()

        release_publication.set()
        await manager.wait_until_idle()
        with pytest.raises(RuntimeError, match="not cancellable"):
            await cancel_task

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.runs[-1].status is RunStatus.COMPLETED
        assert abort_calls == 0
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


@pytest.mark.asyncio
async def test_fixture_no_primary_pipeline_emits_completed_no_data(
    monkeypatch, tmp_path,
) -> None:
    """A FIXTURE pipeline that recovers no primary (T1 output shape) must
    complete with RunCompletedPayload(BuildResult NO_DATA) — never FAILED.

    Phase 4b T4: the T1-T3 changes made NO_DATA pipeline manifests possible
    (previously the metadata-only placeholder always yielded SUCCEEDED), so
    the fixture executor completion path must handle them: the NO_DATA
    package is still published (audit publication, spec D6), and the NO_DATA
    build_result must NOT carry a publication_id (BuildResult.validate_state
    forbids publication_id on NO_DATA).
    """

    def no_primary_processing(ctx, source_asset, dataset_id, geo=None):
        from app.pipeline.processing.geo_tximport import GeoSampleMetadata
        from app.pipeline.stages.base import ProcessingOutput, StageResult

        return StageResult(
            output_digest=hashlib.sha256(b"no-primary-processing").hexdigest(),
            output=ProcessingOutput(
                parsed_datasets=[],
                samples=[
                    GeoSampleMetadata(
                        sample_id="GSM9999991",
                        source_alias="S1",
                        cell_line_raw="",
                        cell_line_canonical="",
                        normalization_rule="",
                        treatment="control",
                        replicate=1,
                        organism="Homo sapiens",
                    ),
                ],
                no_primary_reason="series_matrix_expression_empty_and_no_supplementary",
            ),
        )

    monkeypatch.setattr(
        "app.pipeline.runner.run_processing", no_primary_processing
    )

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=(
                Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
            ),
        ),
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_no_primary",
                input="no primary fixture",
                databases=["pubmed", "geo"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        # The manager emits COMPLETED with the NO_DATA build result.
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert completed[0].build_result is not None
        assert completed[0].build_result.status is BuildResultStatus.NO_DATA
        assert completed[0].build_result.valid_row_count == 0
        assert completed[0].build_result.reason_codes == ["no_primary_data"]
        # NO_DATA builds must not carry a publication_id (validate_state).
        assert completed[0].build_result.publication_id is None

        # The NO_DATA package is still published (audit publication, spec D6)
        # and the run never FAILED.
        assert any(
            isinstance(p, PublicationCreatedPayload) for p in payloads
        )
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_fixture_no_expression_assets_emit_completed_no_data(
    tmp_path,
) -> None:
    """A FIXTURE run whose source assets yield NO expression — through the
    REAL acquisition → run_processing chain (no monkeypatching) — must
    complete with RunCompletedPayload(BuildResult NO_DATA) + a published
    audit publication, and the manifest must carry no PRIMARY_DATASET.

    Phase 4b T6: the pinned fixture (GSE178352) always has expression, so a
    fixture-level no-expression scenario is modeled by copying the fixture
    dir and corrupting ``tximport_counts_slice.tsv`` (a header without twelve
    ``counts.*`` columns → ``process_geo_tximport_counts`` raises ValueError
    → the fixture fallback recovers no expression → the honest no-primary
    path). This pins the FULL chain end-to-end: processing no-primary →
    artifact build NO_DATA package → validation authorized valid → manifest
    without PRIMARY_DATASET → BuildResult NO_DATA → RunCompletedPayload
    NO_DATA + publication event (spec §5 / ADR-011).
    """

    fixture_dir = tmp_path / "fixture_no_expression"
    shutil.copytree(
        Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352",
        fixture_dir,
    )
    (fixture_dir / "tximport_counts_slice.tsv").write_bytes(
        b"gene\tvalue\nACTB\t1.5\n"
    )

    repository = TaskRepository(tmp_path / "output")
    manager = manager_module.TaskManager(
        repository,
        run_executor=runner_module.FixtureRunExecutor(
            repository,
            fixture_dir=fixture_dir,
        ),
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_fixture_no_expression",
                input="no expression fixture",
                databases=["pubmed", "geo"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        # The manager emits COMPLETED with the NO_DATA build result (never
        # FAILED) and NO_DATA builds carry no publication_id.
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert completed[0].build_result is not None
        assert completed[0].build_result.status is BuildResultStatus.NO_DATA
        assert completed[0].build_result.valid_row_count == 0
        assert completed[0].build_result.reason_codes == ["no_primary_data"]
        assert completed[0].build_result.publication_id is None

        # The NO_DATA package is still published (audit publication, spec D6).
        assert any(
            isinstance(p, PublicationCreatedPayload) for p in payloads
        )
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)

        # The published manifest carries no PRIMARY_DATASET role (ADR-011:
        # no fake main table) and no main_data.csv is staged.
        task_root = repository.tasks_dir / accepted.task_id
        artifacts_dir = task_root / "artifacts"
        assert (artifacts_dir / "run_manifest.json").is_file()
        assert not (artifacts_dir / "main_data.csv").exists()
        manifest_json = json.loads(
            (artifacts_dir / "run_manifest.json").read_text("utf-8")
        )
        roles = {
            entry.get("role") for entry in manifest_json["artifacts"]
        }
        assert "primary_dataset" not in roles
        assert roles, "NO_DATA package must still list supporting/audit artifacts"
    finally:
        await manager.close()
