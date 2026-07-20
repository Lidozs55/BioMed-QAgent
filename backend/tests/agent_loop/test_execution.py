from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import app.pipeline.runner as pipeline_runner_module
import app.pipeline.tool as pipeline_tool_module
import pytest
from agents import Agent
from agents.exceptions import MaxTurnsExceeded
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
from app.agent_loop.context import RunContext
from app.api.routes import _load_validated_manifest
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    AssistantStreamDeltaFrame,
    AssistantStreamEndFrame,
    AssistantStreamFrame,
    EventEnvelope,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunQueuedPayload,
    RunStartedPayload,
    RunStatus,
    StartTaskRequest,
    TaskFailedPayload,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    ToolCompletedPayload,
    ToolStartedPayload,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    build_event,
)
from app.pipeline.runner import PipelineRunner
from app.pipeline.tool import run_research_pipeline
from app.runtime.compaction import CompactionCancelledError
from app.runtime.hub import AssistantStreamHub
from app.runtime.manager import RunExecution, TaskManager
from app.runtime.repository import TaskRepository
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
)


def test_extract_text_delta_supports_responses_api_event() -> None:
    data = SimpleNamespace(delta="Responses API answer")

    assert runner_module._extract_text_delta(data) == "Responses API answer"


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


class ScriptedPipelineModel(Model):
    def __init__(
        self,
        *,
        mode: str = "fixture",
        topic: str = "real SDK managed fixture",
    ) -> None:
        self.mode = mode
        self.topic = topic
        self.allow_tool_call = asyncio.Event()
        self.tool_round_entered = asyncio.Event()
        self.final_round_entered = asyncio.Event()
        self.release_final_answer = asyncio.Event()
        self.stream_calls = 0
        self.close_calls = 0

    async def get_response(
        self,
        *args: object,
        **kwargs: object,
    ) -> ModelResponse:
        raise AssertionError("scripted integration must use streaming")

    async def stream_response(
        self,
        *args: object,
        **kwargs: object,
    ) -> AsyncIterator[object]:
        self.stream_calls += 1
        if self.stream_calls == 1:
            self.tool_round_entered.set()
            await self.allow_tool_call.wait()
            item = ResponseFunctionToolCall(
                arguments=json.dumps(
                    {
                        "topic": self.topic,
                        "databases": ["pubmed", "geo"],
                        "mode": self.mode,
                    }
                ),
                call_id="call_real_pipeline",
                name="run_research_pipeline",
                type="function_call",
                status="completed",
            )
        elif self.stream_calls == 2:
            self.final_round_entered.set()
            await self.release_final_answer.wait()
            item = ResponseOutputMessage(
                id="message_real_pipeline",
                content=[
                    ResponseOutputText(
                        annotations=[],
                        text="pipeline finished",
                        type="output_text",
                    )
                ],
                role="assistant",
                status="completed",
                type="message",
            )
        else:
            raise AssertionError("scripted model received an unexpected round")

        response = Response(
            id=f"response_{self.stream_calls}",
            created_at=0.0,
            model="scripted-pipeline-model",
            object="response",
            output=[item],
            parallel_tool_calls=False,
            tool_choice="auto",
            tools=[],
            status="completed",
        )
        yield ResponseOutputItemDoneEvent(
            item=item,
            output_index=0,
            sequence_number=1,
            type="response.output_item.done",
        )
        yield ResponseCompletedEvent(
            response=response,
            sequence_number=2,
            type="response.completed",
        )

    async def close(self) -> None:
        self.close_calls += 1


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


def assistant_stream_delta(
    execution: RunExecution,
    *,
    chunk_index: int,
    delta: str,
    stream_id: str | None = None,
) -> AssistantStreamDeltaFrame:
    return AssistantStreamDeltaFrame(
        task_id=execution.task_id,
        run_id=execution.run_id,
        stream_id=stream_id or f"assistant:{execution.run_id}",
        chunk_index=chunk_index,
        delta=delta,
    )


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


@pytest.mark.asyncio
async def test_text_buffer_publishes_atomic_live_chunk_before_blocked_durable_flush(
) -> None:
    durable_started = asyncio.Event()
    release_durable = asyncio.Event()
    live_frames: list[object] = []
    durable_payloads: list[object] = []

    async def emit_durable(payload: object) -> None:
        durable_started.set()
        await release_durable.wait()
        durable_payloads.append(payload)

    async def emit_live(frame: object) -> None:
        live_frames.append(frame)

    execution = RunExecution(
        task_id="task_live_first",
        run_id="run_live_first",
        request_id="request_live_first",
        input="stream now",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit_durable,
        _assistant_stream_emitter=emit_live,
    )
    buffer = runner_module._AssistantTextBuffer(execution, max_bytes=1)

    adding = asyncio.create_task(buffer.add("a"))
    await asyncio.wait_for(durable_started.wait(), timeout=1)
    try:
        assert live_frames == [
            assistant_stream_delta(execution, chunk_index=0, delta="a")
        ]
        assert not adding.done()
    finally:
        release_durable.set()
        await adding

    assert durable_payloads == [
        AssistantDeltaPayload(
            delta="a",
            stream_id="assistant:run_live_first",
            from_chunk_index=0,
            through_chunk_index=0,
        )
    ]


@pytest.mark.asyncio
async def test_text_buffer_batches_whole_unicode_chunks_with_exact_ranges() -> None:
    durable_payloads: list[object] = []
    live_frames: list[object] = []

    async def emit_durable(payload: object) -> None:
        durable_payloads.append(payload)

    async def emit_live(frame: object) -> None:
        live_frames.append(frame)

    execution = RunExecution(
        task_id="task_chunk_ranges",
        run_id="run_chunk_ranges",
        request_id="request_chunk_ranges",
        input="preserve unicode",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit_durable,
        _assistant_stream_emitter=emit_live,
    )
    buffer = runner_module._AssistantTextBuffer(execution, max_bytes=8)

    await buffer.add("中")
    await buffer.add("🙂")
    await buffer.add("ab")
    await buffer.end("stop")

    assert live_frames == [
        assistant_stream_delta(execution, chunk_index=0, delta="中"),
        assistant_stream_delta(execution, chunk_index=1, delta="🙂"),
        assistant_stream_delta(execution, chunk_index=2, delta="ab"),
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id="assistant:run_chunk_ranges",
            last_chunk_index=2,
            finish_reason="stop",
        ),
    ]
    assert durable_payloads == [
        AssistantDeltaPayload(
            delta="中🙂",
            stream_id="assistant:run_chunk_ranges",
            from_chunk_index=0,
            through_chunk_index=1,
        ),
        AssistantDeltaPayload(
            delta="ab",
            stream_id="assistant:run_chunk_ranges",
            from_chunk_index=2,
            through_chunk_index=2,
        ),
    ]


@pytest.mark.asyncio
async def test_text_buffer_splits_oversized_unicode_delta_at_codepoint_boundaries(
) -> None:
    durable_payloads: list[object] = []
    live_frames: list[object] = []

    execution = RunExecution(
        task_id="task_oversized_chunk",
        run_id="run_oversized_chunk",
        request_id="request_oversized_chunk",
        input="keep atomic",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async(durable_payloads, payload),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution, max_bytes=4)

    await buffer.add("🙂🙂")

    assert live_frames == [
        assistant_stream_delta(execution, chunk_index=0, delta="🙂"),
        assistant_stream_delta(execution, chunk_index=1, delta="🙂"),
    ]
    assert durable_payloads == [
        AssistantDeltaPayload(
            delta="🙂",
            stream_id="assistant:run_oversized_chunk",
            from_chunk_index=0,
            through_chunk_index=0,
        ),
        AssistantDeltaPayload(
            delta="🙂",
            stream_id="assistant:run_oversized_chunk",
            from_chunk_index=1,
            through_chunk_index=1,
        ),
    ]
    assert all(len(payload.delta.encode("utf-8")) <= 4 for payload in durable_payloads)


@pytest.mark.asyncio
async def test_text_buffer_rejects_codepoint_wider_than_configured_max_bytes(
) -> None:
    live_frames: list[object] = []
    durable_payloads: list[object] = []
    execution = RunExecution(
        task_id="task_impossible_max",
        run_id="run_impossible_max",
        request_id="request_impossible_max",
        input="reject impossible split",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async(durable_payloads, payload),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution, max_bytes=3)

    with pytest.raises(ValueError, match="UTF-8 code point"):
        await buffer.add("🙂")

    assert live_frames == []
    assert durable_payloads == []


def test_text_buffer_rejects_nonpositive_max_bytes() -> None:
    execution = RunExecution(
        task_id="task_nonpositive_max",
        run_id="run_nonpositive_max",
        request_id="request_nonpositive_max",
        input="reject invalid max",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
    )

    with pytest.raises(ValueError, match="max_bytes must be positive"):
        runner_module._AssistantTextBuffer(execution, max_bytes=0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [RuntimeError("durable failed"), asyncio.CancelledError()],
)
async def test_text_buffer_end_retains_unconfirmed_batch_without_publishing_end(
    failure: BaseException,
) -> None:
    attempts = 0
    durable_payloads: list[object] = []
    live_frames: list[object] = []

    async def emit_durable(payload: object) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise failure
        durable_payloads.append(payload)

    execution = RunExecution(
        task_id="task_retained_batch",
        run_id="run_retained_batch",
        request_id="request_retained_batch",
        input="retain failed flush",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit_durable,
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution.emit)
    await buffer.add("中🙂")

    with pytest.raises(type(failure)) as raised:
        await buffer.end("error")

    if isinstance(failure, asyncio.CancelledError):
        assert isinstance(raised.value, asyncio.CancelledError)
    else:
        assert raised.value is failure
    assert not any(isinstance(frame, AssistantStreamEndFrame) for frame in live_frames)

    await buffer.end("error")

    assert durable_payloads == [
        AssistantDeltaPayload(
            delta="中🙂",
            stream_id="assistant:run_retained_batch",
            from_chunk_index=0,
            through_chunk_index=0,
        )
    ]
    assert [
        frame for frame in live_frames if isinstance(frame, AssistantStreamEndFrame)
    ] == [
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id="assistant:run_retained_batch",
            last_chunk_index=0,
            finish_reason="error",
        )
    ]


@pytest.mark.asyncio
async def test_text_buffer_cancelled_after_durable_commit_does_not_reappend(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    task_id = "task_cancelled_flush_commit"
    run_id = "run_cancelled_flush_commit"
    now = datetime.now(UTC)
    await repository.initialize()
    await repository.save_snapshot(
        TaskSnapshot(
            task=TaskSummary(
                task_id=task_id,
                mode=TaskMode.AGENT,
                title="cancel a committing flush",
                status=RunStatus.QUEUED,
                created_at=now,
                updated_at=now,
            )
        )
    )
    await repository.append_event(
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=1,
            payload=RunQueuedPayload(
                request_id="request_cancelled_flush_commit",
                input="cancel a committing flush",
            ),
        )
    )
    await repository.append_event(
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=2,
            payload=RunStartedPayload(),
        )
    )
    append_committed = threading.Event()
    release_append = threading.Event()
    real_append = repository._append_event_sync

    def append_then_block(event: EventEnvelope) -> TaskSnapshot:
        snapshot = real_append(event)
        if isinstance(event.payload, AssistantDeltaPayload):
            append_committed.set()
            assert release_append.wait(timeout=5)
        return snapshot

    monkeypatch.setattr(repository, "_append_event_sync", append_then_block)
    live_frames: list[object] = []

    async def emit(payload: object) -> TaskSnapshot:
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        return await repository.append_event(
            build_event(
                task_id=task_id,
                run_id=run_id,
                sequence=snapshot.task.latest_sequence + 1,
                payload=payload,
            )
        )

    execution = RunExecution(
        task_id=task_id,
        run_id=run_id,
        request_id="request_cancelled_flush_commit",
        input="cancel a committing flush",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution)
    await buffer.add("buffered 中🙂")
    ending = asyncio.create_task(buffer.end("cancelled"))
    try:
        committed = await asyncio.to_thread(append_committed.wait, 2)
        assert committed
        ending.cancel()
        release_append.set()

        with pytest.raises(asyncio.CancelledError):
            await ending

        await buffer.end("cancelled")

        events = await repository.list_events(task_id)
        assistant_deltas = [
            event.payload
            for event in events
            if isinstance(event.payload, AssistantDeltaPayload)
        ]
        assert assistant_deltas == [
            AssistantDeltaPayload(
                delta="buffered 中🙂",
                stream_id=f"assistant:{run_id}",
                from_chunk_index=0,
                through_chunk_index=0,
            )
        ]
        assert (
            sum(isinstance(frame, AssistantStreamEndFrame) for frame in live_frames)
            == 1
        )
    finally:
        release_append.set()
        if not ending.done():
            ending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await ending
        await repository.close()


async def _append_async(items: list[object], item: object) -> None:
    items.append(item)


@pytest.mark.asyncio
async def test_text_buffer_live_publish_failure_keeps_durable_text_complete(
    caplog: pytest.LogCaptureFixture,
) -> None:
    durable_payloads: list[object] = []

    async def fail_live(frame: object) -> None:
        raise RuntimeError("live hub unavailable")

    execution = RunExecution(
        task_id="task_live_failure",
        run_id="run_live_failure",
        request_id="request_live_failure",
        input="keep durable",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async(durable_payloads, payload),
        _assistant_stream_emitter=fail_live,
    )
    buffer = runner_module._AssistantTextBuffer(execution)

    with caplog.at_level("ERROR", logger="app.runtime.manager"):
        await buffer.add("complete ")
        await buffer.add("中文🙂")
        await buffer.end("stop")

    assert "assistant stream publish failed" in caplog.text
    assert "".join(payload.delta for payload in durable_payloads) == "complete 中文🙂"


@pytest.mark.asyncio
async def test_text_buffer_does_not_swallow_live_publish_cancellation() -> None:
    durable_payloads: list[object] = []

    async def cancel_live(frame: object) -> None:
        raise asyncio.CancelledError

    execution = RunExecution(
        task_id="task_live_cancel",
        run_id="run_live_cancel",
        request_id="request_live_cancel",
        input="cancel",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async(durable_payloads, payload),
        _assistant_stream_emitter=cancel_live,
    )
    buffer = runner_module._AssistantTextBuffer(execution)

    with pytest.raises(asyncio.CancelledError):
        await buffer.add("not buffered")

    assert durable_payloads == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("boundary", "finish_reason", "expected_exception"),
    [
        ("finish", "stop", None),
        ("tool", "tool_call", None),
        ("exhaustion", "stop", None),
        ("error", "error", RuntimeError),
        ("cancel", "cancelled", asyncio.CancelledError),
        ("max_turns", "max_turns", MaxTurnsExceeded),
    ],
)
async def test_consume_events_ends_each_active_segment_once_at_boundaries(
    boundary: str,
    finish_reason: str,
    expected_exception: type[BaseException] | None,
) -> None:
    durable_payloads: list[object] = []
    live_frames: list[object] = []
    order: list[str] = []

    async def emit_durable(payload: object) -> None:
        durable_payloads.append(payload)
        if isinstance(payload, AssistantDeltaPayload):
            order.append("durable_delta")
        elif isinstance(payload, ToolStartedPayload):
            order.append("tool_started")

    async def emit_live(frame: object) -> None:
        live_frames.append(frame)
        if isinstance(frame, AssistantStreamEndFrame):
            order.append("stream_end")

    execution = RunExecution(
        task_id=f"task_{boundary}",
        run_id=f"run_{boundary}",
        request_id=f"request_{boundary}",
        input="boundary",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit_durable,
        _assistant_stream_emitter=emit_live,
    )
    buffer = runner_module._AssistantTextBuffer(execution)

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="text"))]
                )
            )
            if boundary == "finish":
                yield RawResponsesStreamEvent(
                    data=SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                delta=SimpleNamespace(content=None),
                                finish_reason="stop",
                            )
                        ]
                    )
                )
            elif boundary == "tool":
                yield RunItemStreamEvent(
                    name="tool_called",
                    item=SimpleNamespace(
                        raw_item=SimpleNamespace(call_id="call_boundary", name="search")
                    ),
                )
            elif boundary == "error":
                raise RuntimeError("stream failed")
            elif boundary == "cancel":
                raise asyncio.CancelledError
            elif boundary == "max_turns":
                raise MaxTurnsExceeded("maximum turns exceeded")

    consume = runner_module.AgentRunExecutor._consume_events(
        execution,
        FakeResult(),
        buffer,
    )
    if expected_exception is None:
        await consume
    else:
        with pytest.raises(expected_exception):
            await consume

    ends = [frame for frame in live_frames if isinstance(frame, AssistantStreamEndFrame)]
    assert ends == [
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id=f"assistant:{execution.run_id}",
            last_chunk_index=0,
            finish_reason=finish_reason,
        )
    ]
    assert [
        payload
        for payload in durable_payloads
        if isinstance(payload, AssistantDeltaPayload)
    ] == [
        AssistantDeltaPayload(
            delta="text",
            stream_id=f"assistant:{execution.run_id}",
            from_chunk_index=0,
            through_chunk_index=0,
        )
    ]
    assert order.index("durable_delta") < order.index("stream_end")
    if boundary == "tool":
        assert order.index("stream_end") < order.index("tool_started")


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_finish_reason", ["tool_calls", "function_call"])
async def test_consume_events_normalizes_provider_tool_finish_reasons(
    provider_finish_reason: str,
) -> None:
    live_frames: list[object] = []
    execution = RunExecution(
        task_id=f"task_{provider_finish_reason}",
        run_id=f"run_{provider_finish_reason}",
        request_id=f"request_{provider_finish_reason}",
        input="normalize tool finish reason",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async([], payload),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution)

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="text"))]
                )
            )
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=None),
                            finish_reason=provider_finish_reason,
                        )
                    ]
                )
            )

    await runner_module.AgentRunExecutor._consume_events(
        execution,
        FakeResult(),
        buffer,
    )

    ends = [frame for frame in live_frames if isinstance(frame, AssistantStreamEndFrame)]
    assert [frame.finish_reason for frame in ends] == ["tool_call"]


@pytest.mark.asyncio
async def test_consume_events_separates_reasoning_from_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_reasoning",
        run_id="run_reasoning",
        request_id="request_reasoning",
        input="reasoning",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )
    buffer = runner_module._AssistantTextBuffer(execution.emit)

    class FakeResult:
        async def stream_events(self):
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(
                                content=None,
                                reasoning_content="内部思考",
                            )
                        )
                    ]
                )
            )
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="最终回答"))]
                )
            )

    await runner_module.AgentRunExecutor._consume_events(
        execution,
        FakeResult(),
        buffer,
    )
    await buffer.flush()

    assert [type(payload) for payload in emitted] == [
        runner_module.AssistantReasoningDeltaPayload,
        runner_module.AssistantDeltaPayload,
    ]


@pytest.mark.asyncio
async def test_later_text_rotates_stream_and_restarts_chunk_index() -> None:
    live_frames: list[object] = []
    execution = RunExecution(
        task_id="task_segments",
        run_id="run_segments",
        request_id="request_segments",
        input="segments",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=lambda payload: _append_async([], payload),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
    )
    buffer = runner_module._AssistantTextBuffer(execution)

    await buffer.add("before tool")
    await buffer.end("tool_call")
    await buffer.end("tool_call")
    await buffer.add("after tool")
    await buffer.end("stop")

    assert [
        (frame.stream_id, frame.chunk_index)
        for frame in live_frames
        if isinstance(frame, AssistantStreamDeltaFrame)
    ] == [
        ("assistant:run_segments", 0),
        ("assistant:run_segments:1", 0),
    ]
    assert [
        (frame.stream_id, frame.last_chunk_index)
        for frame in live_frames
        if isinstance(frame, AssistantStreamEndFrame)
    ] == [
        ("assistant:run_segments", 0),
        ("assistant:run_segments:1", 0),
    ]


@pytest.mark.asyncio
async def test_manager_cooperative_cancel_flushes_text_before_end_and_terminal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    assistant_stream_hub = AssistantStreamHub()
    order: list[str] = []
    real_append_event = repository.append_event
    real_publish = assistant_stream_hub.publish

    async def record_event(event: EventEnvelope) -> TaskSnapshot:
        snapshot = await real_append_event(event)
        if isinstance(event.payload, AssistantDeltaPayload):
            order.append("durable_delta")
        elif isinstance(event.payload, RunCancelledPayload):
            order.append("run_cancelled")
        return snapshot

    async def record_frame(frame: AssistantStreamFrame) -> None:
        await real_publish(frame)
        if isinstance(frame, AssistantStreamEndFrame):
            order.append("stream_end")

    monkeypatch.setattr(repository, "append_event", record_event)
    monkeypatch.setattr(assistant_stream_hub, "publish", record_frame)
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    allow_text = asyncio.Event()

    class CooperativeResult:
        def __init__(self) -> None:
            self.cancelled = asyncio.Event()
            self.cancel_calls: list[str] = []

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancelled.set()

        async def stream_events(self) -> AsyncIterator[object]:
            await allow_text.wait()
            yield RawResponsesStreamEvent(
                data=SimpleNamespace(
                    choices=[
                        SimpleNamespace(delta=SimpleNamespace(content="buffered 中🙂"))
                    ]
                )
            )
            await self.cancelled.wait()
            raise asyncio.CancelledError

    result = CooperativeResult()
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: result,
    )
    manager = TaskManager(
        repository,
        run_executor=make_executor(repository),
        assistant_stream_hub=assistant_stream_hub,
    )
    subscription = await assistant_stream_hub.subscribe()
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_buffered_cooperative_cancel",
                input="cancel buffered response",
            )
        )
        await subscription.subscribe_task(accepted.task_id)
        allow_text.set()
        delta_frame = await asyncio.wait_for(subscription.receive(), timeout=2)
        assert isinstance(delta_frame, AssistantStreamDeltaFrame)

        cancelled = await asyncio.wait_for(
            manager.cancel_run(accepted.task_id, accepted.run_id),
            timeout=3,
        )
        end_frame = await asyncio.wait_for(subscription.receive(), timeout=2)

        assert cancelled.runs[-1].status.value == "cancelled"
        assert result.cancel_calls == ["after_turn"]
        assert isinstance(end_frame, AssistantStreamEndFrame)
        assert end_frame.finish_reason == "cancelled"
        assert end_frame.last_chunk_index == 0
        assert order.index("durable_delta") < order.index("stream_end")
        assert order.index("stream_end") < order.index("run_cancelled")
        events = await repository.list_events(accepted.task_id)
        assistant_deltas = [
            event.payload
            for event in events
            if isinstance(event.payload, AssistantDeltaPayload)
        ]
        assert assistant_deltas == [
            AssistantDeltaPayload(
                delta="buffered 中🙂",
                stream_id=f"assistant:{accepted.run_id}",
                from_chunk_index=0,
                through_chunk_index=0,
            )
        ]
        assert (
            sum(
                isinstance(frame, AssistantStreamEndFrame)
                for frame in (delta_frame, end_frame)
            )
            == 1
        )
        model.close.assert_awaited_once_with()
    finally:
        allow_text.set()
        await subscription.close()
        await manager.close()
        await assistant_stream_hub.close()


@pytest.mark.asyncio
async def test_run_execution_abort_is_shared_and_caller_cancellation_safe() -> None:
    abort_started = asyncio.Event()
    release_abort = asyncio.Event()
    abort_calls = 0

    async def commit() -> list:
        return []

    async def abort() -> None:
        nonlocal abort_calls
        abort_calls += 1
        abort_started.set()
        await release_abort.wait()

    execution = RunExecution(
        task_id="task_shared_abort",
        run_id="run_shared_abort",
        request_id="request_shared_abort",
        input="abort safely",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
    )
    execution.set_completion_operations(commit, abort)

    first = asyncio.create_task(execution.abort_completion())
    await asyncio.wait_for(abort_started.wait(), timeout=1)
    second = asyncio.create_task(execution.abort_completion())
    first.cancel()

    with pytest.raises(asyncio.CancelledError):
        await first
    assert abort_calls == 1
    assert not second.done()

    release_abort.set()
    await asyncio.wait_for(second, timeout=1)
    await execution.abort_completion()

    assert abort_calls == 1


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
        "kwargs": {
            "context": context,
            "session": session,
            "max_turns": runner_module.AGENT_MAX_TURNS,
        },
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
async def test_executor_transfers_pending_publication_before_model_close(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    context = RunContext(
        task_id="task_transfer",
        base_dir=tmp_path,
        managed_run_id="run_transfer",
    )
    pending = SimpleNamespace(
        run_id="run_transfer",
        manifest=SimpleNamespace(artifacts=[]),
        manifest_entry=ArtifactManifestEntry(
            artifact_id="run_manifest",
            name="run_manifest.json",
            relative_path="artifacts/run_manifest.json",
            media_type="application/json",
            size_bytes=2,
            sha256="0" * 64,
            generated_by_step_id="step_artifact_builder_v1",
        ),
        publish=lambda: order.append("publish"),
        abort=lambda: order.append("abort"),
    )
    context.reserve_pipeline_publication()
    context.set_pending_publication(pending)
    execution = RunExecution(
        task_id=context.task_id,
        run_id="run_transfer",
        request_id="request_transfer",
        input="transfer publication",
        context=context,
    )

    async def close_model() -> None:
        assert execution._completion_aborter is not None  # noqa: SLF001
        order.append("close")

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock(side_effect=close_model)),
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

    await make_executor(
        SimpleNamespace(task_session=run_scoped_session(object()))
    )(execution)
    execution.seal_completion()
    completion_events = await execution.commit_completion()

    assert order == ["close", "publish"]
    assert [event.payload.artifact.artifact_id for event in completion_events] == [
        "run_manifest"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["error", "cancel"])
async def test_executor_transfers_pending_publication_on_stream_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    order: list[str] = []
    context = RunContext(
        task_id=f"task_transfer_{outcome}",
        base_dir=tmp_path,
        managed_run_id=f"run_transfer_{outcome}",
    )
    pending = SimpleNamespace(
        run_id=f"run_transfer_{outcome}",
        manifest=SimpleNamespace(artifacts=[]),
        manifest_entry=ArtifactManifestEntry(
            artifact_id="run_manifest",
            name="run_manifest.json",
            relative_path="artifacts/run_manifest.json",
            media_type="application/json",
            size_bytes=2,
            sha256="1" * 64,
            generated_by_step_id="step_artifact_builder_v1",
        ),
        publish=lambda: order.append("publish"),
        abort=lambda: order.append("abort"),
    )
    context.reserve_pipeline_publication()
    context.set_pending_publication(pending)
    execution = RunExecution(
        task_id=context.task_id,
        run_id=f"run_transfer_{outcome}",
        request_id=f"request_transfer_{outcome}",
        input="transfer failed stream publication",
        context=context,
    )

    async def close_model() -> None:
        assert execution._completion_aborter is not None  # noqa: SLF001
        order.append("close")

    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock(side_effect=close_model)),
    )

    class FakeResult:
        async def stream_events(self):
            if outcome == "error":
                raise RuntimeError("stream transfer failure")
            raise asyncio.CancelledError
            yield  # pragma: no cover

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
        with pytest.raises(RuntimeError, match="stream transfer failure"):
            await executor(execution)
    else:
        with pytest.raises(asyncio.CancelledError):
            await executor(execution)

    await execution.abort_completion()

    assert order == ["close", "abort"]


@pytest.mark.asyncio
async def test_executor_aborts_handle_when_completion_transfer_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    context = RunContext(
        task_id="task_transfer_failure",
        base_dir=tmp_path,
        managed_run_id="run_transfer_failure",
    )
    pending = SimpleNamespace(
        run_id="run_transfer_failure",
        manifest=SimpleNamespace(artifacts=[]),
        manifest_entry=ArtifactManifestEntry(
            artifact_id="run_manifest",
            name="run_manifest.json",
            relative_path="artifacts/run_manifest.json",
            media_type="application/json",
            size_bytes=2,
            sha256="2" * 64,
            generated_by_step_id="step_artifact_builder_v1",
        ),
        publish=lambda: order.append("publish"),
        abort=lambda: order.append("abort"),
    )
    context.reserve_pipeline_publication()
    context.set_pending_publication(pending)
    execution = RunExecution(
        task_id=context.task_id,
        run_id="run_transfer_failure",
        request_id="request_transfer_failure",
        input="fail transfer",
        context=context,
    )

    async def existing_commit() -> list:
        return []

    async def existing_abort() -> None:
        return None

    execution.set_completion_operations(existing_commit, existing_abort)
    build = SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(
            close=AsyncMock(side_effect=lambda: order.append("close"))
        ),
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

    with pytest.raises(RuntimeError, match="already attached"):
        await make_executor(
            SimpleNamespace(task_session=run_scoped_session(object()))
        )(execution)

    assert order == ["abort", "close"]


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
    assert [
        payload
        for payload in emitted
        if isinstance(payload, AssistantDeltaPayload)
    ] == [
        AssistantDeltaPayload(
            delta="first",
            stream_id="assistant:run_timed_text",
            from_chunk_index=0,
            through_chunk_index=0,
        ),
        AssistantDeltaPayload(
            delta="second",
            stream_id="assistant:run_timed_text",
            from_chunk_index=1,
            through_chunk_index=1,
        ),
    ]


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
                        name="invoke_skill",
                        arguments=json.dumps(
                            {
                                "skill": "pubmed",
                                "operation": "search_pubmed",
                                "arguments": {"query": "BRCA1"},
                            }
                        ),
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
    assert emitted[1].tool_name == "invoke_skill"
    assert emitted[1].arguments == {
        "skill": "pubmed",
        "operation": "search_pubmed",
        "arguments": {"query": "BRCA1"},
    }
    assert emitted[2].tool_call_id == "call_123"
    assert emitted[2].tool_name == "invoke_skill"
    assert emitted[2].output == "{'hits': 2}"


def test_tool_arguments_are_bounded_for_event_projection() -> None:
    raw_item = SimpleNamespace(
        arguments=json.dumps(
            {
                "text": "x" * 250,
                "items": list(range(25)),
                "nested": {"one": {"two": {"three": {"four": "hidden"}}}},
            }
        )
    )

    projected = runner_module._extract_tool_arguments(raw_item)

    assert projected is not None
    assert projected["text"] == "x" * 200 + "...[truncated]"
    assert projected["items"] == list(range(20))
    assert projected["nested"]["one"]["two"] == "[dict:1]"


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
async def test_executor_ends_stream_when_compaction_preparation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failure = RuntimeError("compaction preparation failed")
    live_frames: list[object] = []
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_compaction_failure",
        run_id="run_compaction_failure",
        request_id="request_compaction_failure",
        input="fail during preparation",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=AsyncMock(),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
        _compaction_committer=AsyncMock(return_value=False),
    )

    class FailingCompactor:
        async def prepare(self, task_id, **kwargs):
            raise failure

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: pytest.fail("SDK Run must not start"),
    )

    with pytest.raises(RuntimeError, match="compaction preparation failed") as raised:
        await runner_module.AgentRunExecutor(
            SimpleNamespace(task_session=run_scoped_session(object())),
            compactor=FailingCompactor(),
        )(execution)

    assert raised.value is failure
    assert live_frames == [
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id="assistant:run_compaction_failure",
            last_chunk_index=None,
            finish_reason="error",
        )
    ]
    model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_ends_stream_when_compaction_preparation_is_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancellation = asyncio.CancelledError()
    live_frames: list[object] = []
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_compaction_cancelled",
        run_id="run_compaction_cancelled",
        request_id="request_compaction_cancelled",
        input="cancel during preparation",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=AsyncMock(),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
        _compaction_committer=AsyncMock(return_value=False),
    )

    class CancelledCompactor:
        async def prepare(self, task_id, **kwargs):
            raise cancellation

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: pytest.fail("SDK Run must not start"),
    )

    with pytest.raises(asyncio.CancelledError) as raised:
        await runner_module.AgentRunExecutor(
            SimpleNamespace(task_session=run_scoped_session(object())),
            compactor=CancelledCompactor(),
        )(execution)

    assert raised.value is cancellation
    assert live_frames == [
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id="assistant:run_compaction_cancelled",
            last_chunk_index=None,
            finish_reason="cancelled",
        )
    ]
    model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_does_not_start_sdk_run_after_compaction_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancellation_requested = asyncio.Event()
    live_frames: list[object] = []
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)
    execution = RunExecution(
        task_id="task_cancelled_compaction",
        run_id="run_cancelled_compaction",
        request_id="request_cancelled_compaction",
        input="do not start",
        context=SimpleNamespace(cancellation_requested=cancellation_requested),
        _event_emitter=AsyncMock(),
        _assistant_stream_emitter=lambda frame: _append_async(live_frames, frame),
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

    assert live_frames == [
        AssistantStreamEndFrame(
            task_id=execution.task_id,
            run_id=execution.run_id,
            stream_id="assistant:run_cancelled_compaction",
            last_chunk_index=None,
            finish_reason="cancelled",
        )
    ]
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
    context = RunContext(
        task_id="task_artifacts",
        base_dir=output_dir / "tasks",
        managed_run_id="run_artifacts",
    )
    execution = RunExecution(
        task_id="task_artifacts",
        run_id="run_artifacts",
        request_id="request_artifacts",
        input="build artifacts",
        context=context,
        _event_emitter=emit,
    )

    class FakeResult:
        async def stream_events(self):
            nonlocal manifest
            run_id = context.reserve_pipeline_publication()
            assert run_id == execution.run_id
            runner = PipelineRunner(
                task_id="task_artifacts",
                base_dir=output_dir / "tasks",
                fixture_dir=FIXTURE_DIR,
                defer_publication=True,
                run_id=run_id,
            )
            manifest = await runner.run()
            context.set_pending_publication(runner.pending_publication())
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

    assert not (
        output_dir / "tasks" / execution.task_id / "artifacts" / "run_manifest.json"
    ).exists()
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
    assert (
        output_dir / "tasks" / execution.task_id / "artifacts" / "run_manifest.json"
    ).is_file()


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
        def __init__(self, context: RunContext) -> None:
            self.context = context

        async def stream_events(self):
            run_id = self.context.reserve_pipeline_publication()
            assert run_id is not None
            runner = PipelineRunner(
                task_id=self.context.task_id,
                base_dir=output_dir / "tasks",
                fixture_dir=FIXTURE_DIR,
                defer_publication=True,
                run_id=run_id,
            )
            await runner.run()
            self.context.set_pending_publication(runner.pending_publication())
            if False:
                yield None

    def run_streamed(*args, **kwargs):
        return FakeResult(kwargs["context"])

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
async def test_manager_commit_failure_rolls_back_then_aborts_staging(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    allow_pipeline = asyncio.Event()

    def fail_publish_marker(marker_file: Path, target: Path) -> None:
        raise OSError("managed publish marker failed")

    monkeypatch.setattr(
        "app.pipeline.stages.validation._write_publish_completed_marker",
        fail_publish_marker,
    )

    async def run(execution) -> None:
        await allow_pipeline.wait()
        runner = PipelineRunner(
            task_id=execution.task_id,
            base_dir=repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
            defer_publication=True,
            run_id=execution.run_id,
        )
        await runner.run()
        pending = runner.pending_publication()

        async def commit() -> list:
            await asyncio.to_thread(pending.publish)
            return []

        async def abort() -> None:
            await asyncio.to_thread(pending.abort)

        execution.set_completion_operations(commit, abort)

    manager = TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_publish_rollback_abort",
                input="rollback failed managed publish",
            )
        )
        task_root = repository.tasks_dir / accepted.task_id
        artifacts = task_root / "artifacts"
        state = task_root / "state"
        artifacts.mkdir(parents=True, exist_ok=True)
        state.mkdir(parents=True, exist_ok=True)
        old_files = {
            "run_manifest.json": b'{"old":"manifest"}\n',
            "old-result.csv": b"old,result\n1,2\n",
            ".runtime-publication.json": b'{"old":"runtime"}\n',
        }
        for name, content in old_files.items():
            (artifacts / name).write_bytes(content)
        old_state_marker = b'{"old":"state"}\n'
        (state / "publish_completed.json").write_bytes(old_state_marker)
        allow_pipeline.set()

        await manager.wait_until_idle()

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status.value == "failed"
        assert "managed publish marker failed" in (failed.runs[-1].error or "")
        assert {
            path.name: path.read_bytes()
            for path in artifacts.iterdir()
            if path.is_file()
        } == old_files
        assert (state / "publish_completed.json").read_bytes() == old_state_marker
        assert not (task_root / "staging" / accepted.run_id).exists()
        events = await repository.list_events(accepted.task_id)
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
    finally:
        allow_pipeline.set()
        await manager.close()


@pytest.mark.asyncio
async def test_publish_success_with_nondurable_artifact_event_stays_hidden(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    real_append_event = repository.append_event
    failed_artifact_append = False

    async def fail_first_artifact_append(event):
        nonlocal failed_artifact_append
        if isinstance(event.payload, ArtifactProducedPayload) and not failed_artifact_append:
            failed_artifact_append = True
            raise OSError("artifact event was not durable")
        return await real_append_event(event)

    monkeypatch.setattr(repository, "append_event", fail_first_artifact_append)

    async def run(execution) -> None:
        runner = PipelineRunner(
            task_id=execution.task_id,
            base_dir=repository.tasks_dir,
            fixture_dir=FIXTURE_DIR,
            defer_publication=True,
            run_id=execution.run_id,
        )
        await runner.run()
        pending = runner.pending_publication()

        async def commit() -> list:
            await asyncio.to_thread(pending.publish)
            payloads = [
                ArtifactProducedPayload(artifact=pending.manifest_entry),
                *(
                    ArtifactProducedPayload(artifact=artifact)
                    for artifact in pending.manifest.artifacts
                ),
            ]
            return [
                build_event(
                    task_id=execution.task_id,
                    run_id=execution.run_id,
                    sequence=index,
                    payload=payload,
                )
                for index, payload in enumerate(payloads, start=1)
            ]

        async def abort() -> None:
            await asyncio.to_thread(pending.abort)

        execution.set_completion_operations(commit, abort)

    manager = TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_nondurable_artifact_event",
                input="publish before event failure",
            )
        )
        await manager.wait_until_idle()

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status.value == "failed"
        assert "artifact event was not durable" in (failed.runs[-1].error or "")
        task_root = repository.tasks_dir / accepted.task_id
        assert (task_root / "artifacts" / "run_manifest.json").is_file()
        assert (task_root / "artifacts" / ".runtime-publication.json").is_file()
        assert _load_validated_manifest(
            repository.tasks_dir,
            accepted.task_id,
            failed,
        ) is None
        events = await repository.list_events(accepted.task_id)
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_live_pipeline_pauses_durably_before_discovery_and_resumes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    discovery_started = asyncio.Event()
    real_discovery = pipeline_runner_module.run_discovery

    def offline_discovery(context):
        discovery_started.set()
        context.mode = "fixture"
        return real_discovery(context)

    monkeypatch.setattr(
        pipeline_runner_module,
        "run_discovery",
        offline_discovery,
    )
    model = ScriptedPipelineModel(
        mode="live",
        topic="durable live approval boundary",
    )
    agent = Agent[RunContext](
        name="Scripted live approval Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    subscription = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_live_approval",
                input="pause the real live Tool for approval",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        subscription = await manager.event_hub.subscribe(
            task_ids={accepted.task_id}
        )
        model.allow_tool_call.set()

        while True:
            event = await asyncio.wait_for(subscription.receive(), timeout=3)
            if isinstance(event.payload, UserInputRequiredPayload):
                required = event.payload
                break

        paused = await repository.get_snapshot(accepted.task_id)
        assert paused is not None
        assert paused.runs[-1].status.value == "awaiting_user_input"
        assert required.request_id == f"plan-{accepted.task_id}"
        assert not discovery_started.is_set()
        events_before_resume = await repository.list_events(accepted.task_id)
        assert not any(
            event.payload.type.value == "stage_started"
            for event in events_before_resume
        )

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="approve",
        )
        await asyncio.wait_for(model.final_round_entered.wait(), timeout=5)
        model.release_final_answer.set()
        await manager.wait_until_idle()

        completed = await repository.get_snapshot(accepted.task_id)
        assert completed is not None
        assert completed.runs[-1].status.value == "completed"
        assert discovery_started.is_set()
        events = await repository.list_events(accepted.task_id)
        required_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, UserInputRequiredPayload)
        )
        resumed_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, UserInputResumedPayload)
        )
        assert required_index < resumed_index
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        if subscription is not None:
            await subscription.close()
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_live_pipeline_rejection_fails_authoritative_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    discovery_started = asyncio.Event()

    def unexpected_discovery(context):
        discovery_started.set()
        raise AssertionError("Discovery must not start after plan rejection")

    monkeypatch.setattr(
        pipeline_runner_module,
        "run_discovery",
        unexpected_discovery,
    )
    model = ScriptedPipelineModel(
        mode="live",
        topic="durable live rejection boundary",
    )
    agent = Agent[RunContext](
        name="Scripted live rejection Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    subscription = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_live_rejection",
                input="reject the real live Tool plan",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        subscription = await manager.event_hub.subscribe(
            task_ids={accepted.task_id}
        )
        model.allow_tool_call.set()

        while True:
            event = await asyncio.wait_for(subscription.receive(), timeout=3)
            if isinstance(event.payload, UserInputRequiredPayload):
                required = event.payload
                break

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="reject",
            detail={"reason": "plan is off-topic"},
        )
        model.release_final_answer.set()
        await manager.wait_until_idle()

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status.value == "failed"
        assert "rejected" in (failed.runs[-1].error or "").lower()
        assert not discovery_started.is_set()
        events = await repository.list_events(accepted.task_id)
        rejected = [
            event.payload
            for event in events
            if isinstance(event.payload, UserInputResumedPayload)
        ]
        assert len(rejected) == 1
        assert rejected[0].decision == "reject"
        assert any(isinstance(event.payload, TaskFailedPayload) for event in events)
        assert any(isinstance(event.payload, RunFailedPayload) for event in events)
        assert not any(
            event.payload.type.value == "stage_started" for event in events
        )
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
        assert model.close_calls == 1
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        if subscription is not None:
            await subscription.close()
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_live_pipeline_user_input_timeout_fails_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    discovery_started = asyncio.Event()

    def unexpected_discovery(context):
        discovery_started.set()
        raise AssertionError("Discovery must not start after user-input timeout")

    def timeout_runner(**kwargs: object) -> PipelineRunner:
        return PipelineRunner(**kwargs, user_input_timeout=0.02)

    monkeypatch.setattr(
        pipeline_runner_module,
        "run_discovery",
        unexpected_discovery,
    )
    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", timeout_runner)
    model = ScriptedPipelineModel(
        mode="live",
        topic="durable live user-input timeout",
    )
    agent = Agent[RunContext](
        name="Scripted live timeout Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_live_input_timeout",
                input="let the real live Tool prompt expire",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        model.release_final_answer.set()
        model.allow_tool_call.set()
        await asyncio.wait_for(manager.wait_until_idle(), timeout=3)

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status.value == "failed"
        assert "user input timeout" in (failed.runs[-1].error or "").lower()
        assert not discovery_started.is_set()
        events = await repository.list_events(accepted.task_id)
        required = next(
            event
            for event in events
            if isinstance(event.payload, UserInputRequiredPayload)
        )
        assert required.payload.expires_at is not None
        assert any(isinstance(event.payload, TaskFailedPayload) for event in events)
        assert any(isinstance(event.payload, RunFailedPayload) for event in events)
        assert not any(
            event.payload.type.value == "stage_started" for event in events
        )
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_live_pipeline_pause_is_promptly_cancellable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    discovery_started = asyncio.Event()

    def unexpected_discovery(context):
        discovery_started.set()
        raise AssertionError("Discovery must not start before plan approval")

    monkeypatch.setattr(
        pipeline_runner_module,
        "run_discovery",
        unexpected_discovery,
    )
    model = ScriptedPipelineModel(
        mode="live",
        topic="durable live cancellation boundary",
    )
    agent = Agent[RunContext](
        name="Scripted live cancellation Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    subscription = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_live_pause_cancel",
                input="cancel the paused real live Tool",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        task_root = repository.tasks_dir / accepted.task_id
        artifacts = task_root / "artifacts"
        state = task_root / "state"
        artifacts.mkdir(parents=True, exist_ok=True)
        state.mkdir(parents=True, exist_ok=True)
        old_artifacts = {
            "run_manifest.json": b'{"old":"manifest"}\n',
            "old-result.csv": b"old,result\n1,2\n",
            ".runtime-publication.json": b'{"old":"runtime"}\n',
        }
        for name, content in old_artifacts.items():
            (artifacts / name).write_bytes(content)
        old_state_marker = b'{"old":"state"}\n'
        (state / "publish_completed.json").write_bytes(old_state_marker)
        subscription = await manager.event_hub.subscribe(
            task_ids={accepted.task_id}
        )
        model.allow_tool_call.set()

        while True:
            event = await asyncio.wait_for(subscription.receive(), timeout=3)
            if isinstance(event.payload, UserInputRequiredPayload):
                break

        model.release_final_answer.set()
        cancelled = await asyncio.wait_for(
            manager.cancel_run(accepted.task_id, accepted.run_id),
            timeout=3,
        )

        assert cancelled.runs[-1].status.value == "cancelled"
        assert not discovery_started.is_set()
        assert not (task_root / "staging" / accepted.run_id).exists()
        assert {
            path.name: path.read_bytes()
            for path in artifacts.iterdir()
            if path.is_file()
        } == old_artifacts
        assert (state / "publish_completed.json").read_bytes() == old_state_marker
        events = await repository.list_events(accepted.task_id)
        assert not any(
            isinstance(event.payload, UserInputResumedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        if subscription is not None:
            await subscription.close()
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_cancel_after_pipeline_tool_preserves_old_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = ScriptedPipelineModel()
    agent = Agent[RunContext](
        name="Scripted managed Pipeline Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    subscription = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_pipeline_cancel",
                input="run the real SDK fixture Tool",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        task_root = repository.tasks_dir / accepted.task_id
        artifacts = task_root / "artifacts"
        state = task_root / "state"
        artifacts.mkdir(parents=True, exist_ok=True)
        state.mkdir(parents=True, exist_ok=True)
        old_artifacts = {
            "run_manifest.json": b'{"old":"manifest"}\n',
            "old-result.csv": b"old,result\n1,2\n",
            ".runtime-publication.json": b'{"old":"runtime"}\n',
        }
        for name, content in old_artifacts.items():
            (artifacts / name).write_bytes(content)
        old_state_marker = b'{"old":"state"}\n'
        (state / "publish_completed.json").write_bytes(old_state_marker)
        subscription = await manager.event_hub.subscribe(
            task_ids={accepted.task_id}
        )
        model.allow_tool_call.set()

        while True:
            event = await asyncio.wait_for(subscription.receive(), timeout=5)
            if (
                isinstance(event.payload, ToolCompletedPayload)
                and event.payload.tool_name == "run_research_pipeline"
            ):
                break
        await asyncio.wait_for(model.final_round_entered.wait(), timeout=2)

        staging = task_root / "staging" / accepted.run_id
        assert (staging / "run_manifest.json").is_file()
        assert {
            path.name: path.read_bytes()
            for path in artifacts.iterdir()
            if path.is_file()
        } == old_artifacts
        assert (state / "publish_completed.json").read_bytes() == old_state_marker

        cancellation = asyncio.create_task(
            manager.cancel_run(accepted.task_id, accepted.run_id)
        )
        execution = manager._running[(accepted.task_id, accepted.run_id)]
        await asyncio.wait_for(
            execution.context.cancellation_requested.wait(),
            timeout=2,
        )
        model.release_final_answer.set()
        cancelled = await asyncio.wait_for(cancellation, timeout=5)

        assert cancelled.runs[-1].status.value == "cancelled"
        assert model.stream_calls == 2
        assert model.close_calls == 1
        assert not staging.exists()
        assert {
            path.name: path.read_bytes()
            for path in artifacts.iterdir()
            if path.is_file()
        } == old_artifacts
        assert (state / "publish_completed.json").read_bytes() == old_state_marker
        events = await repository.list_events(accepted.task_id)
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert not any(
            isinstance(event.payload, RunCompletedPayload) for event in events
        )
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        if subscription is not None:
            await subscription.close()
        await manager.close()


@pytest.mark.asyncio
async def test_real_sdk_managed_pipeline_publishes_once_in_completion_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish_calls: list[tuple[str, str]] = []
    abort_calls: list[tuple[str, str]] = []
    real_publish = PipelineRunner.publish
    real_abort = PipelineRunner.abort

    def counted_publish(runner: PipelineRunner, run_id: str) -> None:
        publish_calls.append((runner.task_id, run_id))
        real_publish(runner, run_id)

    def counted_abort(runner: PipelineRunner) -> None:
        abort_calls.append((runner.task_id, runner.ctx.run_id))
        real_abort(runner)

    monkeypatch.setattr(PipelineRunner, "publish", counted_publish)
    monkeypatch.setattr(PipelineRunner, "abort", counted_abort)
    model = ScriptedPipelineModel()
    agent = Agent[RunContext](
        name="Scripted successful Pipeline Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    subscription = None
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_real_sdk_pipeline_success",
                input="complete the real SDK fixture Tool",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        subscription = await manager.event_hub.subscribe(
            task_ids={accepted.task_id}
        )
        model.allow_tool_call.set()

        while True:
            event = await asyncio.wait_for(subscription.receive(), timeout=5)
            if (
                isinstance(event.payload, ToolCompletedPayload)
                and event.payload.tool_name == "run_research_pipeline"
            ):
                break
        await asyncio.wait_for(model.final_round_entered.wait(), timeout=2)
        task_root = repository.tasks_dir / accepted.task_id
        assert (
            task_root / "staging" / accepted.run_id / "run_manifest.json"
        ).is_file()
        assert not (task_root / "artifacts" / "run_manifest.json").exists()

        model.release_final_answer.set()
        await manager.wait_until_idle()

        completed = await repository.get_snapshot(accepted.task_id)
        assert completed is not None
        assert completed.runs[-1].status.value == "completed"
        manifest_path = task_root / "artifacts" / "run_manifest.json"
        manifest = json.loads(manifest_path.read_text("utf-8"))
        events = await repository.list_events(accepted.task_id)
        finalizing_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, RunFinalizingPayload)
        )
        artifact_indices = [
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, ArtifactProducedPayload)
        ]
        completed_index = next(
            index
            for index, event in enumerate(events)
            if isinstance(event.payload, RunCompletedPayload)
        )
        artifact_ids = [
            events[index].payload.artifact.artifact_id
            for index in artifact_indices
        ]

        assert publish_calls == [(accepted.task_id, accepted.run_id)]
        assert abort_calls == []
        assert finalizing_index < min(artifact_indices)
        assert max(artifact_indices) < completed_index
        assert artifact_ids[0] == "run_manifest"
        assert len(artifact_ids) == len(manifest["artifacts"]) + 1
        assert len(artifact_ids) == len(set(artifact_ids))
        assert model.stream_calls == 2
        assert model.close_calls == 1
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        if subscription is not None:
            await subscription.close()
        await manager.close()


@pytest.mark.asyncio
async def test_agent_pretransfer_abort_failure_cannot_be_cancelled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    abort_calls = 0

    class AbortFailingRunner:
        def __init__(self, **kwargs: object) -> None:
            self.task_id = str(kwargs["task_id"])
            self.run_id = str(kwargs["run_id"])
            base_dir = Path(kwargs["base_dir"])
            self.staging = base_dir / self.task_id / "staging" / self.run_id
            self.staging.mkdir(parents=True, exist_ok=True)
            (self.staging / "cleanup-diagnostic.txt").write_text(
                "preserve failed cleanup\n",
                encoding="utf-8",
            )

        async def run(self) -> SimpleNamespace:
            return SimpleNamespace(
                task_id=self.task_id,
                task_state=SimpleNamespace(value="failed"),
                validation=SimpleNamespace(status="invalid"),
                artifacts=[],
            )

        def abort(self) -> None:
            nonlocal abort_calls
            abort_calls += 1
            raise OSError("agent pretransfer staging cleanup failed")

    monkeypatch.setattr(
        pipeline_tool_module,
        "PipelineRunner",
        AbortFailingRunner,
    )
    model = ScriptedPipelineModel()
    agent = Agent[RunContext](
        name="Scripted abort-failing Pipeline Agent",
        instructions="Call run_research_pipeline, then answer.",
        tools=[run_research_pipeline],
        model=model,
    )
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    repository = TaskRepository(tmp_path / "output")
    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_agent_pretransfer_abort_failure",
                input="run the abort-failing Agent Tool",
                databases=["pubmed", "geo"],
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        model.allow_tool_call.set()
        await asyncio.wait_for(model.final_round_entered.wait(), timeout=2)

        cancellation = asyncio.create_task(manager.cancel_run(accepted.task_id, accepted.run_id))
        execution = manager._running[(accepted.task_id, accepted.run_id)]
        await asyncio.wait_for(
            execution.context.cancellation_requested.wait(),
            timeout=2,
        )
        model.release_final_answer.set()

        with pytest.raises(RuntimeError, match="completion abort failed"):
            await asyncio.wait_for(cancellation, timeout=5)
        await manager.wait_until_idle()

        failed = await repository.get_snapshot(accepted.task_id)
        assert failed is not None
        assert failed.runs[-1].status.value == "failed"
        failure_error = failed.runs[-1].error or ""
        assert "agent pretransfer staging cleanup failed" in failure_error
        assert "completion abort also failed" in failure_error
        staging = repository.tasks_dir / accepted.task_id / "staging" / accepted.run_id
        assert (staging / "cleanup-diagnostic.txt").is_file()
        assert abort_calls == 2
        events = await repository.list_events(accepted.task_id)
        assert not any(event.payload.type.value == "run_cancelled" for event in events)
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        await manager.close()


@pytest.mark.asyncio
async def test_executor_without_pending_publication_ignores_existing_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "output"
    await PipelineRunner(
        task_id="task_unchanged_artifacts",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    ).run()
    manifest_path = (
        output_dir
        / "tasks"
        / "task_unchanged_artifacts"
        / "artifacts"
        / "run_manifest.json"
    )
    manifest_bytes = manifest_path.read_bytes()
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
    execution.seal_completion()
    assert await execution.commit_completion() == []
    assert manifest_path.read_bytes() == manifest_bytes
