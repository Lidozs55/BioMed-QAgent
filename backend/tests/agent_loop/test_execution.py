from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

import app.agent_loop.runner as runner_module
from app.domain.contracts import (
    AssistantDeltaPayload,
    ArtifactProducedPayload,
    ToolCompletedPayload,
    ToolStartedPayload,
)
from app.pipeline.pinned_case import run_pinned_fixture
from app.runtime.manager import RunExecution


class NoopCompactor:
    async def prepare(self, task_id, *, model_handle, emit, session):
        return SimpleNamespace(session=session)


def make_executor(repository):
    return runner_module.AgentRunExecutor(
        repository,
        compactor=NoopCompactor(),
    )


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


@pytest.mark.asyncio
async def test_executor_uses_durable_task_session_at_sdk_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = object()
    repository = SimpleNamespace(task_session=lambda task_id: session)
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

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    await make_executor(repository)(execution)

    assert captured == {
        "args": (agent, "continue the analysis"),
        "kwargs": {"context": context, "session": session},
    }
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
    executor = make_executor(SimpleNamespace(task_session=lambda task_id: object()))

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

    await make_executor(SimpleNamespace(task_session=lambda task_id: object()))(
        execution
    )

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

    await make_executor(SimpleNamespace(task_session=lambda task_id: object()))(
        execution
    )

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
    executor = make_executor(SimpleNamespace(task_session=lambda task_id: object()))

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

    await make_executor(SimpleNamespace(task_session=lambda task_id: object()))(
        execution
    )

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
    repository = SimpleNamespace(task_session=lambda task_id: original_session)
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_compaction",
        run_id="run_compaction",
        request_id="request_compaction",
        input="continue",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=AsyncMock(),
    )
    order: list[str] = []

    class Compactor:
        async def prepare(self, task_id, *, model_handle, emit, session):
            order.append("prepare")
            assert task_id == execution.task_id
            assert model_handle is model
            assert session is original_session
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
async def test_executor_emits_manifest_artifact_ids_after_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    manifest = run_pinned_fixture(
        task_id="task_artifacts",
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
        task_id="task_artifacts",
        run_id="run_artifacts",
        request_id="request_artifacts",
        input="build artifacts",
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
        task_session=lambda task_id: object(),
    )

    await make_executor(repository)(execution)

    artifact_payloads = [
        payload for payload in emitted if isinstance(payload, ArtifactProducedPayload)
    ]
    assert artifact_payloads[0].artifact.artifact_id == "run_manifest"
    assert {payload.artifact.artifact_id for payload in artifact_payloads[1:]} == {
        artifact.artifact_id for artifact in manifest.artifacts
    }
