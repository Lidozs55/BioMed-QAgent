from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
from app.domain.contracts import (
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    RunCompletedPayload,
    RunFinalizingPayload,
    StartTaskRequest,
    ToolCompletedPayload,
    ToolStartedPayload,
)
from app.pipeline.pinned_case import run_pinned_fixture
from app.runtime.compaction import CompactionCancelledError
from app.runtime.manager import RunExecution, TaskManager
from app.runtime.repository import TaskRepository


class NoopCompactor:
    async def prepare(
        self,
        task_id,
        *,
        model_handle,
        emit,
        session,
        cancellation_requested,
        commit,
    ):
        return SimpleNamespace(session=session)


def make_executor(repository):
    return runner_module.AgentRunExecutor(
        repository,
        compactor=NoopCompactor(),
    )


def run_scoped_session(session: object) -> Callable[..., object]:
    def task_session(task_id: str, *, run_id: str) -> object:
        assert task_id.startswith("task_")
        assert run_id.startswith("run_")
        return session

    return task_session


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


@pytest.mark.asyncio
async def test_executor_uses_durable_task_session_at_sdk_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = object()
    session_requests: list[tuple[str, str]] = []

    def task_session(task_id: str, *, run_id: str) -> object:
        session_requests.append((task_id, run_id))
        return session

    repository = SimpleNamespace(task_session=task_session)
    agent = object()
    build = SimpleNamespace(
        agent=agent,
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    context = SimpleNamespace(cancellation_requested=asyncio.Event())
    execution = RunExecution(
        task_id="task_123",
        run_id="run_123",
        request_id="request_123",
        input="continue the analysis",
        context=context,
        databases=["geo"],
    )
    captured: dict[str, object] = {}

    class FakeResult:
        async def stream_events(self):
            if False:
                yield None

    result = FakeResult()

    def run_streamed(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return result

    def build_selected_agent(databases=None):
        captured["databases"] = databases
        return build

    monkeypatch.setattr(runner_module, "build_agent", build_selected_agent)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    await make_executor(repository)(execution)

    assert captured == {
        "databases": ["geo"],
        "args": (agent, "continue the analysis"),
        "kwargs": {"context": context, "session": session},
    }
    assert session_requests == [(execution.task_id, execution.run_id)]
    assert await execution.wait_for_streaming_result() is result


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
async def test_executor_closes_model_on_every_terminal_path(
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_close",
        run_id="run_close",
        request_id="request_close",
        input="close resources",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
    )

    class FakeResult:
        async def stream_events(self):
            if outcome == "error":
                raise RuntimeError("stream failed")
            if outcome == "cancel":
                raise asyncio.CancelledError
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    executor = make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )

    if outcome == "error":
        with pytest.raises(RuntimeError, match="stream failed"):
            await executor(execution)
    elif outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await executor(execution)
    else:
        await executor(execution)

    model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_coalesces_text_at_utf8_kib_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[object] = []
    wide = "\u754c"

    async def emit(payload: object):
        emitted.append(payload)

    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_text",
        run_id="run_text",
        request_id="request_text",
        input="stream text",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="a" * 600))]
                )
            )
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=wide * 200))]
                )
            )

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )

    await make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )(execution)

    deltas = [
        payload.delta
        for payload in emitted
        if isinstance(payload, AssistantDeltaPayload)
    ]
    assert "".join(deltas) == "a" * 600 + wide * 200
    assert all(len(delta.encode("utf-8")) <= 1024 for delta in deltas)


@pytest.mark.asyncio
async def test_executor_flushes_text_after_100ms_while_stream_is_idle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[object] = []
    flushed_before_second = False

    async def emit(payload: object):
        emitted.append(payload)

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    execution = RunExecution(
        task_id="task_timed_text",
        run_id="run_timed_text",
        request_id="request_timed_text",
        input="stream slowly",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            nonlocal flushed_before_second
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="first"))]
                )
            )
            await asyncio.sleep(0.15)
            flushed_before_second = any(
                isinstance(payload, AssistantDeltaPayload) for payload in emitted
            )
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="second"))]
                )
            )

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )

    await make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )(execution)

    assert runner_module.ASSISTANT_FLUSH_INTERVAL_SECONDS == 0.1
    assert flushed_before_second is True
    assert (
        "".join(
            payload.delta
            for payload in emitted
            if isinstance(payload, AssistantDeltaPayload)
        )
        == "firstsecond"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["error", "cancel"])
async def test_executor_flushes_buffered_text_before_abnormal_exit(
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_abnormal_text",
        run_id="run_abnormal_text",
        request_id="request_abnormal_text",
        input="fail after text",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="not lost"))]
                )
            )
            if outcome == "error":
                raise RuntimeError("stream failed")
            raise asyncio.CancelledError

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    executor = make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )

    if outcome == "error":
        with pytest.raises(RuntimeError, match="stream failed"):
            await executor(execution)
    else:
        with pytest.raises(asyncio.CancelledError):
            await executor(execution)

    assert [
        payload.delta
        for payload in emitted
        if isinstance(payload, AssistantDeltaPayload)
    ] == ["not lost"]
    model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_emits_ordered_tool_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    execution = RunExecution(
        task_id="task_tool",
        run_id="run_tool",
        request_id="request_tool",
        input="use a tool",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="before"))]
                )
            )
            yield RunItemStreamEvent(
                name="tool_called",
                item=SimpleNamespace(
                    raw_item=SimpleNamespace(
                        call_id="call_123",
                        name="search_pubmed",
                        arguments='{"query":"BRCA1"}',
                    )
                ),
            )
            yield RunItemStreamEvent(
                name="tool_output",
                item=SimpleNamespace(
                    raw_item=SimpleNamespace(call_id="call_123"),
                    output={"hits": 2},
                ),
            )

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )

    await make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )(execution)

    assert [type(payload) for payload in emitted] == [
        AssistantDeltaPayload,
        ToolStartedPayload,
        ToolCompletedPayload,
    ]
    assert emitted[1].tool_call_id == "call_123"
    assert emitted[1].tool_name == "search_pubmed"
    assert emitted[2].tool_call_id == "call_123"
    assert emitted[2].tool_name == "search_pubmed"
    assert emitted[2].output == "{'hits': 2}"


@pytest.mark.asyncio
async def test_executor_prepares_compaction_before_starting_sdk_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_session = object()
    effective_session = object()
    repository = SimpleNamespace(
        task_session=run_scoped_session(original_session)
    )
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_compaction",
        run_id="run_compaction",
        request_id="request_compaction",
        input="continue",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=AsyncMock(),
        _compaction_committer=AsyncMock(return_value=True),
    )
    order: list[str] = []

    class Compactor:
        async def prepare(
            self,
            task_id,
            *,
            model_handle,
            emit,
            session,
            cancellation_requested,
            commit,
        ):
            order.append("prepare")
            assert task_id == execution.task_id
            assert model_handle is model
            assert session is original_session
            assert cancellation_requested is execution.context.cancellation_requested
            assert commit == execution.commit_compaction
            return SimpleNamespace(session=effective_session)

    class FakeResult:
        async def stream_events(self):
            if False:
                yield None

    def run_streamed(*args, **kwargs):
        order.append("run")
        assert kwargs["session"] is effective_session
        return FakeResult()

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    await runner_module.AgentRunExecutor(
        repository,
        compactor=Compactor(),
    )(execution)

    assert order == ["prepare", "run"]


@pytest.mark.asyncio
async def test_executor_does_not_start_sdk_run_after_compaction_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancellation_requested = asyncio.Event()
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_cancelled_compaction",
        run_id="run_cancelled_compaction",
        request_id="request_cancelled_compaction",
        input="do not start",
        context=SimpleNamespace(cancellation_requested=cancellation_requested),
        _event_emitter=AsyncMock(),
        _compaction_committer=AsyncMock(return_value=False),
    )

    class Compactor:
        async def prepare(self, task_id, **kwargs):
            cancellation_requested.set()
            return SimpleNamespace(session=object())

    def run_streamed(*args, **kwargs):
        raise AssertionError("SDK Run must not start after cancellation")

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    with pytest.raises(CompactionCancelledError):
        await runner_module.AgentRunExecutor(
            SimpleNamespace(task_session=run_scoped_session(object())),
            compactor=Compactor(),
        )(execution)

    model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_emits_manifest_artifact_ids_after_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    manifest = None
    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    execution = RunExecution(
        task_id="task_artifacts",
        run_id="run_artifacts",
        request_id="request_artifacts",
        input="build artifacts",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            nonlocal manifest
            manifest = run_pinned_fixture(
                task_id="task_artifacts",
                base_dir=output_dir / "tasks",
                fixture_dir=FIXTURE_DIR,
            )
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    repository = SimpleNamespace(
        output_dir=output_dir,
        task_session=run_scoped_session(object()),
    )

    await make_executor(repository)(execution)

    assert not any(
        isinstance(payload, ArtifactProducedPayload) for payload in emitted
    )
    execution.seal_completion()
    completion_events = await execution.commit_completion()
    artifact_payloads = [
        event.payload
        for event in completion_events
        if isinstance(event.payload, ArtifactProducedPayload)
    ]
    assert manifest is not None
    assert artifact_payloads[0].artifact.artifact_id == "run_manifest"
    assert {payload.artifact.artifact_id for payload in artifact_payloads[1:]} == {
        artifact.artifact_id for artifact in manifest.artifacts
    }


@pytest.mark.asyncio
async def test_manager_persists_all_executor_artifacts_before_terminal_events(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )

    class FakeResult:
        def __init__(self, task_id: str) -> None:
            self.task_id = task_id

        async def stream_events(self):
            run_pinned_fixture(
                task_id=self.task_id,
                base_dir=output_dir / "tasks",
                fixture_dir=FIXTURE_DIR,
            )
            if False:
                yield None

    def run_streamed(*args, **kwargs):
        return FakeResult(kwargs["context"].task_id)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_artifact_ordering",
                input="build ordered artifacts",
            )
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        artifact_indices = [
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, ArtifactProducedPayload)
        ]
        finalizing_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, RunFinalizingPayload)
        )
        completed_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, RunCompletedPayload)
        )
        marker_path = (
            repository.tasks_dir
            / accepted.task_id
            / "artifacts"
            / ".runtime-publication.json"
        )
        marker = json.loads(marker_path.read_text("utf-8"))
        manifest_path = marker_path.with_name("run_manifest.json")

        assert len(artifact_indices) > 1
        assert finalizing_index < min(artifact_indices) < completed_index
        assert max(artifact_indices) < completed_index
        assert marker == {
            "schema_version": 1,
            "task_id": accepted.task_id,
            "run_id": accepted.run_id,
            "manifest_sha256": hashlib.sha256(
                manifest_path.read_bytes()
            ).hexdigest(),
        }
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_executor_does_not_reemit_unchanged_manifest_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    run_pinned_fixture(
        task_id="task_unchanged_artifacts",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    execution = RunExecution(
        task_id="task_unchanged_artifacts",
        run_id="run_unchanged_artifacts",
        request_id="request_unchanged_artifacts",
        input="continue without artifacts",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    repository = SimpleNamespace(
        output_dir=output_dir,
        task_session=run_scoped_session(object()),
    )

    await make_executor(repository)(execution)

    assert not any(isinstance(payload, ArtifactProducedPayload) for payload in emitted)


@pytest.mark.asyncio
async def test_executor_changed_manifest_keeps_stable_artifact_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "task_changed_artifacts"
    output_dir = tmp_path / "output"
    manifest = run_pinned_fixture(
        task_id=task_id,
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    expected_ids = {
        "run_manifest",
        *(artifact.artifact_id for artifact in manifest.artifacts),
    }
    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )
    execution = RunExecution(
        task_id=task_id,
        run_id="run_changed_artifacts",
        request_id="request_changed_artifacts",
        input="change artifacts",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            changed = manifest.model_copy(
                update={
                    "request": manifest.request.model_copy(
                        update={"topic": "changed artifact topic"}
                    )
                }
            )
            manifest_path = (
                output_dir / "tasks" / task_id / "artifacts" / "run_manifest.json"
            )
            manifest_path.write_text(
                changed.model_dump_json(indent=2) + "\n",
                encoding="utf-8",
            )
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    repository = SimpleNamespace(
        output_dir=output_dir,
        task_session=run_scoped_session(object()),
    )

    await make_executor(repository)(execution)

    assert not any(
        isinstance(payload, ArtifactProducedPayload) for payload in emitted
    )
    execution.seal_completion()
    completion_events = await execution.commit_completion()
    artifact_ids = {
        event.payload.artifact.artifact_id
        for event in completion_events
        if isinstance(event.payload, ArtifactProducedPayload)
    }
    assert artifact_ids == expected_ids
