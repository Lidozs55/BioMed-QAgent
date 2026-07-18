"""回归测试：LLM 输出截断必须发射 warning 且不静默完成。

覆盖 docs/REVIEW_2026-07-18.md §2：
DashScope/Qwen 走 Chat Completions 路径，finish_reason="length" 时 SDK
不抛异常，把 partial content 当 final_output 返回。executor 必须主动
检测 finish_reason 并发射 WarningPayload(code="llm_output_truncated")。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from agents.stream_events import RawResponsesStreamEvent
from app.domain.contracts import (
    AssistantDeltaPayload,
    WarningPayload,
)
from app.runtime.manager import RunExecution


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
        return session

    return task_session


def _make_build():
    return SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )


def _chunk(content: str | None = None, finish_reason: str | None = None):
    """构造一个 ChatCompletionChunk 风格的 SimpleNamespace。"""

    delta = SimpleNamespace(content=content) if content is not None else SimpleNamespace()
    choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice])


@pytest.mark.asyncio
async def test_executor_warns_on_finish_reason_length(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """finish_reason='length' 时发射 WarningPayload(code=llm_output_truncated)。"""

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    output_dir = tmp_path / "output"
    execution = RunExecution(
        task_id="task_truncated",
        run_id="run_truncated",
        request_id="request_truncated",
        input="produce truncated output",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = "partial content"

        async def stream_events(self):
            yield RawResponsesStreamEvent(data=_chunk(content="partial"))
            yield RawResponsesStreamEvent(data=_chunk(finish_reason="length"))

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

    truncation_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "llm_output_truncated"
    ]
    assert len(truncation_warnings) == 1
    # 截断 warning 前应 flush 文本缓冲，确保 AssistantDeltaPayload 先到达
    delta_indices = [
        i for i, p in enumerate(emitted) if isinstance(p, AssistantDeltaPayload)
    ]
    truncation_warning_indices = [
        i for i, p in enumerate(emitted)
        if isinstance(p, WarningPayload) and p.code == "llm_output_truncated"
    ]
    assert delta_indices and truncation_warning_indices
    assert max(delta_indices) < truncation_warning_indices[0]
    build.model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_emits_truncation_warning_only_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """多次 finish_reason='length' 只发射一次 warning（去重）。"""

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    output_dir = tmp_path / "output"
    execution = RunExecution(
        task_id="task_multi_truncated",
        run_id="run_multi_truncated",
        request_id="request_multi_truncated",
        input="produce multiple truncations",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = "partial content"

        async def stream_events(self):
            yield RawResponsesStreamEvent(data=_chunk(content="part1"))
            yield RawResponsesStreamEvent(data=_chunk(finish_reason="length"))
            yield RawResponsesStreamEvent(data=_chunk(content="part2"))
            yield RawResponsesStreamEvent(data=_chunk(finish_reason="length"))

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

    truncation_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "llm_output_truncated"
    ]
    assert len(truncation_warnings) == 1


@pytest.mark.asyncio
async def test_executor_does_not_warn_on_normal_finish_reason(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """finish_reason='stop'（正常结束）不发射 truncation warning。"""

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    output_dir = tmp_path / "output"
    execution = RunExecution(
        task_id="task_normal_finish",
        run_id="run_normal_finish",
        request_id="request_normal_finish",
        input="produce normal output",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = "normal content"

        async def stream_events(self):
            yield RawResponsesStreamEvent(data=_chunk(content="normal"))
            yield RawResponsesStreamEvent(data=_chunk(finish_reason="stop"))

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

    truncation_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "llm_output_truncated"
    ]
    assert len(truncation_warnings) == 0


@pytest.mark.asyncio
async def test_extract_finish_reason_returns_none_for_missing_choices() -> None:
    """_extract_finish_reason 对无 choices 的事件返回 None。"""

    assert runner_module._extract_finish_reason(SimpleNamespace()) is None
    assert runner_module._extract_finish_reason(SimpleNamespace(choices=[])) is None
    assert (
        runner_module._extract_finish_reason(
            SimpleNamespace(choices=[SimpleNamespace(finish_reason=None)])
        )
        is None
    )


@pytest.mark.asyncio
async def test_extract_finish_reason_returns_value_for_length() -> None:
    """_extract_finish_reason 正确提取 finish_reason='length'。"""

    chunk = SimpleNamespace(choices=[SimpleNamespace(finish_reason="length")])
    assert runner_module._extract_finish_reason(chunk) == "length"
