"""No-progress detector unit tests (docs/REVIEW_2026-07-31 §4.2 B2).

验证用户确认的重复检测语义：
- 仅检测"大量短时密集重复"：同一 (tool, args) 指纹在滑动窗口内出现
  >= threshold 次才触发
- 长时间间隔不累计：同指纹两次调用间隔超过窗口 → 先前计数作废
- 两次调用之间有用户指令 → 计数清零，不算重复
- 每个指纹每次 Run 至多触发一次
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.runner as runner_module
import pytest
from agents.stream_events import RunItemStreamEvent
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    RunCompletedPayload,
    RunFailedPayload,
    StartTaskRequest,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.pipeline.runner import PipelineRunner
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


class NoopCompactor:
    async def prepare(
        self,
        task_id,
        *,
        model_handle,
        emit,
        request=None,
        session,
        cancellation_requested,
        commit,
    ):
        return SimpleNamespace(
            session=session,
            agent_input=request.agent_input if request is not None else "",
            estimate=Mock(total=0),
        )


def make_executor(repository):
    return runner_module.AgentRunExecutor(
        repository,
        compactor=NoopCompactor(),
    )


def _make_build():
    return SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )


class _RepeatingToolResult:
    """FakeResult that emits N identical tool_called events then succeeds."""

    final_output = "done"

    def __init__(self, context: RunContext, repeats: int) -> None:
        self.context = context
        self.repeats = repeats

    async def stream_events(self):
        for idx in range(self.repeats):
            yield RunItemStreamEvent(
                name="tool_called",
                item=SimpleNamespace(
                    raw_item=SimpleNamespace(
                        call_id=f"call_{idx}",
                        name="search_pubmed",
                        arguments='{"query": "cancer"}',
                    ),
                ),
            )
        yield None


class _SuccessResult:
    """FakeResult that runs the fixture pipeline to produce artifacts."""

    final_output = "agent completed after no-progress resume"

    def __init__(self, context: RunContext, output_dir: Path) -> None:
        self.context = context
        self.output_dir = output_dir

    async def stream_events(self):
        run_id = self.context.reserve_pipeline_publication()
        assert run_id is not None
        runner = PipelineRunner(
            task_id=self.context.task_id,
            base_dir=self.output_dir / "tasks",
            fixture_dir=FIXTURE_DIR,
            defer_publication=True,
            run_id=run_id,
        )
        await runner.run()
        self.context.set_pending_publication(runner.pending_publication())
        if False:
            yield None


async def _wait_for_user_input_required(repository, task_id, request_id_prefix):
    import asyncio

    for _ in range(100):
        events = await repository.list_events(task_id)
        for event in events:
            payload = event.payload
            if (
                isinstance(payload, UserInputRequiredPayload)
                and payload.request_id.startswith(request_id_prefix)
            ):
                return payload
        await asyncio.sleep(0.05)
    raise AssertionError("user_input_required not emitted")


@pytest.mark.asyncio
async def test_dense_repeat_fires_no_progress_prompt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """同一指纹在窗口内密集重复 >= 阈值 → no_progress HITL。

    验证：
    1. 第一轮 stream_events 连续发射 3 次相同 search_pubmed 调用
    2. AgentRunExecutor 发射 ``UserInputRequiredPayload(prompt_kind=
       "no_progress")``
    3. approve 后续跑成功，Run COMPLETED
    """
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()
    call_count = 0

    def run_streamed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        context = kwargs["context"]
        if call_count == 1:
            return _RepeatingToolResult(context, repeats=5)
        return _SuccessResult(context, output_dir)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_no_progress",
                input="find cancer datasets",
            )
        )
        required = await _wait_for_user_input_required(
            repository, accepted.task_id, "no_progress-"
        )
        assert required.prompt_kind == "no_progress"
        assert required.detail["tool_name"] == "search_pubmed"
        assert required.detail["occurrences"] == 3

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="approve",
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]
        resumed = [p for p in payloads if isinstance(p, UserInputResumedPayload)]
        assert len(resumed) == 1
        assert resumed[0].decision == "approve"
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_no_progress_rejection_fails_run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """no_progress 时用户 reject → RunFailed。"""
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    def run_streamed(*args, **kwargs):
        return _RepeatingToolResult(kwargs["context"], repeats=5)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_no_progress_reject",
                input="find cancer datasets",
            )
        )
        required = await _wait_for_user_input_required(
            repository, accepted.task_id, "no_progress-"
        )
        assert required.prompt_kind == "no_progress"

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="reject",
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]
        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1
        assert "no-progress" in failures[0].error.lower()
        assert not any(isinstance(p, RunCompletedPayload) for p in payloads)
    finally:
        await manager.close()


def test_detector_long_gap_resets_count() -> None:
    """同指纹两次调用间隔超过窗口 → 先前计数作废（可能是复查）。"""
    detector = runner_module.NoProgressDetector(window_seconds=300, threshold=3)
    t0 = 1000.0
    assert detector.record("search_pubmed", "h1", now=t0) is None
    assert detector.record("search_pubmed", "h1", now=t0 + 1) is None
    # 间隔超过窗口 (301 > 300) → 计数作废
    assert detector.record("search_pubmed", "h1", now=t0 + 301) is None
    assert detector.record("search_pubmed", "h1", now=t0 + 302) is None
    # 新窗口内连续 3 次才触发
    assert detector.record("search_pubmed", "h1", now=t0 + 303) == 3


def test_detector_user_instruction_resets_count() -> None:
    """两次调用之间有用户指令（reset）→ 计数清零。"""
    detector = runner_module.NoProgressDetector(window_seconds=300, threshold=3)
    t0 = 1000.0
    assert detector.record("search_pubmed", "h1", now=t0) is None
    assert detector.record("search_pubmed", "h1", now=t0 + 1) is None
    detector.reset()  # 用户指令
    assert detector.record("search_pubmed", "h1", now=t0 + 2) is None
    assert detector.record("search_pubmed", "h1", now=t0 + 3) is None
    assert detector.record("search_pubmed", "h1", now=t0 + 4) == 3


def test_detector_distinct_fingerprints_do_not_aggregate() -> None:
    """不同 args 指纹不互相累计。"""
    detector = runner_module.NoProgressDetector(window_seconds=300, threshold=3)
    t0 = 1000.0
    detector.record("search_pubmed", "h1", now=t0)
    detector.record("search_pubmed", "h1", now=t0 + 1)
    detector.record("search_pubmed", "h2", now=t0 + 2)  # 不同参数
    assert detector.record("search_pubmed", "h1", now=t0 + 3) == 3


def test_detector_fires_once_per_fingerprint() -> None:
    """每个指纹每次 Run 至多触发一次。"""
    detector = runner_module.NoProgressDetector(window_seconds=300, threshold=3)
    t0 = 1000.0
    detector.record("search_pubmed", "h1", now=t0)
    detector.record("search_pubmed", "h1", now=t0 + 1)
    assert detector.record("search_pubmed", "h1", now=t0 + 2) == 3
    # 再次出现不再触发
    assert detector.record("search_pubmed", "h1", now=t0 + 3) is None
