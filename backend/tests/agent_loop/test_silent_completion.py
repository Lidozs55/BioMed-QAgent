"""回归测试：LLM 静默完成必须被结构化处理。

覆盖 docs/REVIEW_2026-07-18.md §1 中三类场景：
1. LLM 未调用任何 tool，final_output 为空 → executor 抛 RuntimeError
2. Agent 未产出 pending publication（未调 tool 或 tool 未产出 artifact）
   → 发射 WarningPayload(code="artifact_manifest_missing")
3. Agent 模式下未产出 artifact 事件 → manager 发射 COMPLETED + BuildResult(NO_DATA)

phase 4a 语义（见 docs/superpowers/plans/2026-08-06-phase4a-terminal-state.md
Task 6）：零产物完成不再是 run_failed，而是结构化终态 completed +
build_result.status == NO_DATA，由 TaskManager 直接构造。
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunStatus,
    StartTaskRequest,
    WarningPayload,
)
from app.domain.contracts.dataset_state import BuildResultStatus
from app.runtime.compaction import CompactionCancelledError
from app.runtime.manager import RunExecution, TaskManager
from app.runtime.repository import TaskRepository

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


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
            estimate=SimpleNamespace(total=0),
        )


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


def _make_context(
    tmp_path: Path,
    task_id: str = "task_test",
    run_id: str | None = None,
) -> RunContext:
    """构造真实 RunContext，并按需绑定 managed_run_id。

    managed_run_id 必须与 execution.run_id 一致才能通过
    bind_managed_pipeline_bridge 校验（manager._execute 也是先创建 context
    再 bind_managed_run）。
    """
    context = RunContext(task_id=task_id, base_dir=tmp_path)
    if run_id is not None:
        context.bind_managed_run(run_id)
    return context


@pytest.mark.asyncio
async def test_executor_raises_when_final_output_empty(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """final_output 为空时 executor 必须抛 RuntimeError，拒绝静默完成。"""

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    context = _make_context(tmp_path, "task_empty_output", "run_empty_output")
    execution = RunExecution(
        task_id="task_empty_output",
        run_id="run_empty_output",
        request_id="request_empty_output",
        input="produce nothing",
        context=context,
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = ""  # 空输出

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
        task_session=run_scoped_session(object()),
    )

    with pytest.raises(RuntimeError, match="empty final_output"):
        await make_executor(repository)(execution)

    # 不应发射任何 RunCompletedPayload
    assert not any(isinstance(p, RunCompletedPayload) for p in emitted)
    build.model.close.assert_awaited_once_with()

    # 空输出重试耗尽：每次空输出都发射 llm_empty_output_retry warning，
    # 耗尽后才抛 RuntimeError（保持 fail-loud 语义）。
    retry_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "llm_empty_output_retry"
    ]
    assert len(retry_warnings) == runner_module.EMPTY_OUTPUT_RETRY_LIMIT


@pytest.mark.asyncio
async def test_executor_recovers_from_empty_final_output_with_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """空 final_output（reasoning-only 回合）经重新提示恢复，不 fail。

    覆盖 qwen 类模型偶发"仅推理、无文本/工具调用"回合（SDK 对无
    MessageOutputItem 的响应把 final_output 置为空串）：前两次空输出触发
    llm_empty_output_retry warning 并重跑，第三次产出文本后正常收尾。
    """

    emitted: list[object] = []
    calls = {"count": 0}

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    context = _make_context(tmp_path, "task_empty_recovered", "run_empty_recovered")
    execution = RunExecution(
        task_id="task_empty_recovered",
        run_id="run_empty_recovered",
        request_id="request_empty_recovered",
        input="produce nothing first",
        context=context,
        _event_emitter=emit,
    )

    class FakeResult:
        @property
        def final_output(self) -> str:
            calls["count"] += 1
            return "" if calls["count"] <= 2 else "recovered output"

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
        task_session=run_scoped_session(object()),
    )

    await make_executor(repository)(execution)

    retry_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "llm_empty_output_retry"
    ]
    assert len(retry_warnings) == runner_module.EMPTY_OUTPUT_RETRY_LIMIT
    # 恢复后真实 SDK result 有 final_output 属性 → agent_executed 标记
    assert execution.agent_executed
    build.model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_warns_when_no_pending_publication(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Agent 未产出 pending publication 时发射 WarningPayload(code=artifact_manifest_missing)。

    Agent 调用了 tool 但 tool 未产出 artifact，或 Agent 未调 tool，
    take_pending_publication() 返回 None，executor 发射 warning。
    """

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    context = _make_context(tmp_path, "task_no_pending", "run_no_pending")
    execution = RunExecution(
        task_id="task_no_pending",
        run_id="run_no_pending",
        request_id="request_no_pending",
        input="produce no pending",
        context=context,
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = "done"

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
        task_session=run_scoped_session(object()),
    )

    await make_executor(repository)(execution)

    warnings = [p for p in emitted if isinstance(p, WarningPayload)]
    assert len(warnings) == 1
    assert warnings[0].code == "artifact_manifest_missing"
    build.model.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_executor_does_not_warn_when_cancelled(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """cancellation 发生时不发 artifact_manifest_missing warning。"""

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    build = _make_build()
    context = _make_context(tmp_path, "task_cancelled", "run_cancelled")
    context.cancellation_requested.set()
    execution = RunExecution(
        task_id="task_cancelled",
        run_id="run_cancelled",
        request_id="request_cancelled",
        input="cancelled before artifact",
        context=context,
        _event_emitter=emit,
    )

    class FakeResult:
        final_output = "partial"

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
        task_session=run_scoped_session(object()),
    )

    # cancellation 先于 Agent Run 时，executor 抛 CompactionCancelledError
    with pytest.raises(CompactionCancelledError):
        await make_executor(repository)(execution)

    # cancellation 时不发 artifact_manifest_missing warning
    manifest_warnings = [
        p for p in emitted
        if isinstance(p, WarningPayload) and p.code == "artifact_manifest_missing"
    ]
    assert len(manifest_warnings) == 0


@pytest.mark.asyncio
async def test_manager_completes_run_when_agent_produces_no_artifacts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Agent 模式下未产出任何 artifact 事件时，manager 发射 COMPLETED + BuildResult(NO_DATA)。

    phase 4a：零产物完成不再是 run_failed，而是结构化终态 completed +
    build_result.status == NO_DATA。Task 7 的 reducer 聚合会把该 build_result
    投影到 run.summary；本测试断言权威事件日志里的 RunCompletedPayload。
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()

    class FakeResult:
        final_output = "done without artifacts"

        async def stream_events(self):
            if False:
                yield None

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )

    # 直接使用默认 context_factory（创建真实 RunContext 并由 manager 绑定 managed_run_id）
    manager = TaskManager(
        repository,
        run_executor=make_executor(repository),
    )
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_no_artifacts_e2e",
                input="run without producing artifacts",
            )
        )
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.runs[-1].status is RunStatus.COMPLETED

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]
        # 必须有 RunFinalizingPayload
        assert any(isinstance(p, RunFinalizingPayload) for p in payloads)
        # 必须有 RunCompletedPayload 且 build_result.status == NO_DATA
        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert completed[0].build_result is not None
        assert completed[0].build_result.status is BuildResultStatus.NO_DATA
        assert completed[0].build_result.valid_row_count == 0
        assert completed[0].build_result.reason_codes == ["no_primary_data"]
        # 必须没有 RunFailedPayload
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()
