"""Agent max_turns 暂停-续跑回归测试。

验证 docs/REVIEW_2026-07-18.md §11 / docs/TODO.md §8.5 批次 3 的关键不变量：
- ``MaxTurnsExceeded`` → 发射 ``UserInputRequiredPayload(prompt_kind=
  "max_turns_reached")`` → Run 进入 ``AWAITING_USER_INPUT``
- 用户 approve → 复用 durable Session 并以空的新输入续跑 → 第二轮成功产出 artifact
  → ``RunCompletedPayload``
- 用户 reject → ``PipelineCancelledError`` → ``RunFailedPayload``
- 连续超过 ``MAX_TURNS_RESUME_LIMIT`` 次 → ``RunFailedPayload`` (RuntimeError)
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.runner as runner_module
import pytest
from agents.exceptions import MaxTurnsExceeded
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactProducedPayload,
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    StartTaskRequest,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository
from tests.agent_loop._v2_build_helpers import run_fixture_build

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


class _MaxTurnsResult:
    """FakeResult that raises ``MaxTurnsExceeded`` from its stream_events."""

    final_output = "max_turns partial output"

    def __init__(self, context: RunContext) -> None:
        self.context = context

    async def stream_events(self):
        if False:
            yield None  # make this an async generator
        raise MaxTurnsExceeded(
            f"max turns ({runner_module.AGENT_MAX_TURNS}) exceeded"
        )

    def to_input_list(self):
        return [{"role": "user", "content": self.context.task_id}]


class _SuccessResult:
    """FakeResult that runs the fixture pipeline to produce artifacts."""

    final_output = "agent completed after resume"

    def __init__(self, context: RunContext, output_dir: Path) -> None:
        self.context = context
        self.output_dir = output_dir

    async def stream_events(self):
        envelope = await run_fixture_build(self.context)
        if envelope.get("status") != "ok":
            raise RuntimeError(f"fixture build failed: {envelope}")
        if False:
            yield None


async def _wait_for_user_input_required(
    repository: TaskRepository,
    task_id: str,
    *,
    resume_count: int,
    timeout: float = 5.0,
) -> UserInputRequiredPayload:
    """Poll repository until the ``max_turns-{run_id}-{resume_count}`` prompt lands.

    The event_hub does not buffer events for late subscribers, and
    ``MaxTurnsExceeded`` fires near-instantly from the mocked
    ``Runner.run_streamed``. Polling the persisted event log is the
    race-free way to observe the pause. The ``resume_count`` selector
    distinguishes successive pause rounds in the resume-limit test.
    """

    expected_suffix = f"-{resume_count}"
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        events = await repository.list_events(task_id)
        for event in events:
            payload = event.payload
            if (
                isinstance(payload, UserInputRequiredPayload)
                and payload.prompt_kind == "max_turns_reached"
                and payload.request_id.endswith(expected_suffix)
            ):
                return payload
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"task {task_id} did not emit max_turns UserInputRequiredPayload "
        f"for resume_count={resume_count} within {timeout}s"
    )


@pytest.mark.asyncio
async def test_max_turns_exceeded_emits_prompt_and_resumes_on_approve(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """approve 续跑:MaxTurnsExceeded → UserInputRequired → resume → success。

    验证：
    1. 第一次 Runner.run_streamed 抛 MaxTurnsExceeded 后发射
       ``UserInputRequiredPayload(prompt_kind="max_turns_reached")``
    2. manager.resume_run(decision="approve") 后第二轮 Runner.run_streamed
       复用 durable Session、以空的新输入续跑并产出 artifact
    3. Run 最终 COMPLETED（有 RunCompletedPayload + ArtifactProducedPayload）
    4. 事件顺序：user_input_required < user_input_resumed < run_completed
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()
    call_count = 0
    agent_inputs: list[str | list[object]] = []

    def run_streamed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        agent_inputs.append(args[1])
        context = kwargs["context"]
        if call_count == 1:
            return _MaxTurnsResult(context)
        return _SuccessResult(context, output_dir)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_max_turns_approve",
                input="max_turns approve path",
            )
        )
        required = await _wait_for_user_input_required(
            repository, accepted.task_id, resume_count=0
        )
        assert required.prompt_kind == "max_turns_reached"
        assert required.request_id == f"max_turns-{accepted.run_id}-0"
        assert required.detail["resume_count"] == 0
        assert required.detail["resume_limit"] == runner_module.MAX_TURNS_RESUME_LIMIT

        paused = await repository.get_snapshot(accepted.task_id)
        assert paused is not None
        assert paused.runs[-1].status.value == "awaiting_user_input"

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="approve",
        )
        await manager.wait_until_idle()

        assert call_count == 2  # 第一轮 max_turns + 第二轮 success
        assert agent_inputs == ["max_turns approve path", []]

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        required_idx = next(
            i for i, p in enumerate(payloads)
            if isinstance(p, UserInputRequiredPayload)
        )
        resumed = [p for p in payloads if isinstance(p, UserInputResumedPayload)]
        assert len(resumed) == 1
        assert resumed[0].decision == "approve"
        resumed_idx = payloads.index(resumed[0])
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        completed_idx = payloads.index(completed[0])

        assert required_idx < resumed_idx < completed_idx
        # V2 语义：成功构建以 PublicationCreated 为完成证据。
        assert any(isinstance(p, PublicationCreatedPayload) for p in payloads)
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_max_turns_exceeded_rejection_fails_run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """reject 取消:MaxTurnsExceeded → UserInputRequired → reject → RunFailed。

    验证：
    1. 用户选 reject 后 ``PipelineCancelledError`` → ``RunFailedPayload``
    2. 没有 ``RunCompletedPayload`` / ``ArtifactProducedPayload``
    3. ``UserInputResumedPayload(decision="reject")`` 被持久化
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    def run_streamed(*args, **kwargs):
        return _MaxTurnsResult(kwargs["context"])

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_max_turns_reject",
                input="max_turns reject path",
            )
        )
        required = await _wait_for_user_input_required(
            repository, accepted.task_id, resume_count=0
        )
        assert required.prompt_kind == "max_turns_reached"

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="reject",
        )
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        resumed = [p for p in payloads if isinstance(p, UserInputResumedPayload)]
        assert len(resumed) == 1
        assert resumed[0].decision == "reject"

        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1
        assert "cancelled" in failures[0].error.lower() or "max_turns" in failures[0].error.lower()

        assert not any(isinstance(p, RunCompletedPayload) for p in payloads)
        assert not any(isinstance(p, ArtifactProducedPayload) for p in payloads)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_max_turns_resume_limit_enforced(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """连续 approve 超过 MAX_TURNS_RESUME_LIMIT 后 RuntimeError → RunFailed。

    验证：
    1. 前 ``MAX_TURNS_RESUME_LIMIT`` 次 (3 次) approve 正常续跑
    2. 第 4 次 MaxTurnsExceeded 时 resume_count >= limit → RuntimeError
    3. ``RunFailedPayload`` 的 error 含 "resume limit"
    4. 恰好 4 个 ``UserInputRequiredPayload`` 和 3 个 approve ``UserInputResumedPayload``
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    def run_streamed(*args, **kwargs):
        return _MaxTurnsResult(kwargs["context"])

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_max_turns_resume_limit",
                input="max_turns resume limit path",
            )
        )

        # 前 MAX_TURNS_RESUME_LIMIT 次 approve
        for round_idx in range(runner_module.MAX_TURNS_RESUME_LIMIT):
            required = await _wait_for_user_input_required(
                repository, accepted.task_id, resume_count=round_idx
            )
            assert required.prompt_kind == "max_turns_reached"
            await manager.resume_run(
                accepted.task_id,
                accepted.run_id,
                request_id=required.request_id,
                decision="approve",
            )

        # 第 4 次 MaxTurnsExceeded → RuntimeError("resume limit") → RunFailed
        # 注意:第 4 次 MaxTurnsExceeded 在 resume_count == limit 时直接抛
        # RuntimeError,不会发射 UserInputRequiredPayload。
        await manager.wait_until_idle()

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        required_payloads = [
            p for p in payloads if isinstance(p, UserInputRequiredPayload)
        ]
        assert len(required_payloads) == runner_module.MAX_TURNS_RESUME_LIMIT

        approved = [
            p for p in payloads
            if isinstance(p, UserInputResumedPayload) and p.decision == "approve"
        ]
        assert len(approved) == runner_module.MAX_TURNS_RESUME_LIMIT

        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1
        assert "resume limit" in failures[0].error.lower()

        assert not any(isinstance(p, RunCompletedPayload) for p in payloads)
    finally:
        await manager.close()
