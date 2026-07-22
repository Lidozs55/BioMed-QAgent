"""Qwen 偶发 400 (function.arguments 非 JSON) 重试回归测试。

验证 docs/REVIEW_2026-07-18.md §3 的关键不变量：
- Qwen 返回非 JSON 的 function.arguments 导致 400 时，AgentRunExecutor
  识别该错误并用原始 execution.input 重跑 Run
- 每次重试发射 ``WarningPayload(code="llm_function_args_retry")``
- ``QWEN_FUNCTION_ARGS_RETRY_LIMIT`` (2) 次后仍失败则错误向上传播
- 重试成功后正常产出 artifact 并 ``RunCompletedPayload``
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.runner as runner_module
import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ArtifactProducedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    StartTaskRequest,
    WarningPayload,
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


class _QwenFunctionArgsErrorResult:
    """FakeResult whose stream_events raises a Qwen 400 error.

    Simulates DashScope returning::
        Error code: 400 - {'error': {'message':
        '<400> InternalError.Algo.InvalidParameter: The "function.arguments"
        parameter of the code model must be in JSON format.',
        'type': 'invalid_request_error', 'code':
        'invalid_parameter_error'}}
    """

    final_output = ""  # never reached

    def __init__(self, context: RunContext) -> None:
        self.context = context

    async def stream_events(self):
        if False:
            yield None  # make this an async generator
        raise RuntimeError(
            "Error code: 400 - {'error': {'message': "
            "'<400> InternalError.Algo.InvalidParameter: The "
            "\"function.arguments\" parameter of the code model "
            "must be in JSON format.', 'type': 'invalid_request_error', "
            "'param': None, 'code': 'invalid_parameter_error'}, "
            "'id': 'chatcmpl-test', 'request_id': 'test'}"
        )


class _SuccessResult:
    """FakeResult that runs the fixture pipeline to produce artifacts."""

    final_output = "agent completed after qwen retry"

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


@pytest.mark.asyncio
async def test_qwen_function_args_error_retried_with_original_input(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """首次 400 → 重试成功。

    验证：
    1. 第一次 Runner.run_streamed 的 stream_events 抛 Qwen 400 错误
    2. AgentRunExecutor 捕获后发射 ``WarningPayload(code=
       "llm_function_args_retry")`` 并用原始 execution.input 重跑
    3. 第二轮成功产出 artifact 并 ``RunCompletedPayload``
    4. 重试用的 agent_input 是原始 execution.input (str),不是 to_input_list
    """
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()
    call_count = 0
    captured_inputs: list[object] = []

    def run_streamed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        captured_inputs.append(args[1])  # 第二个位置参数是 agent_input
        context = kwargs["context"]
        if call_count == 1:
            return _QwenFunctionArgsErrorResult(context)
        return _SuccessResult(context, output_dir)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_qwen_retry_success",
                input="qwen retry success path",
            )
        )
        await manager.wait_until_idle()

        assert call_count == 2  # 第一轮 400 + 第二轮 success

        # 重试必须用原始 execution.input (str),不是 to_input_list (list)
        assert captured_inputs[0] == "qwen retry success path"
        assert captured_inputs[1] == "qwen retry success path"

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        warnings = [
            p for p in payloads
            if isinstance(p, WarningPayload) and p.code == "llm_function_args_retry"
        ]
        assert len(warnings) == 1
        assert "1/2" in warnings[0].message  # 第 1 次重试 (共 2 次)

        completed = [p for p in payloads if isinstance(p, RunCompletedPayload)]
        assert len(completed) == 1
        assert any(isinstance(p, ArtifactProducedPayload) for p in payloads)
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_qwen_function_args_retry_limit_propagates_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """连续 ``QWEN_FUNCTION_ARGS_RETRY_LIMIT`` 次重试后仍 400 → RunFailed。

    验证：
    1. 前 ``QWEN_FUNCTION_ARGS_RETRY_LIMIT`` (2) 次重试各发射一个
       ``WarningPayload(code="llm_function_args_retry")``
    2. 第 3 次 400 (重试次数用尽) 错误向上传播 → ``RunFailedPayload``
    3. 总共调用 ``Runner.run_streamed`` 3 次 (1 原始 + 2 重试)
    4. 没有 ``RunCompletedPayload`` / ``ArtifactProducedPayload``
    """
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    build = _make_build()
    call_count = 0

    def run_streamed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        context = kwargs["context"]
        # 所有轮次都抛 Qwen 400
        return _QwenFunctionArgsErrorResult(context)

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_qwen_retry_exhausted",
                input="qwen retry exhausted path",
            )
        )
        await manager.wait_until_idle()

        # 1 原始 + 2 重试 = 3 次
        assert call_count == 1 + runner_module.QWEN_FUNCTION_ARGS_RETRY_LIMIT

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        warnings = [
            p for p in payloads
            if isinstance(p, WarningPayload) and p.code == "llm_function_args_retry"
        ]
        assert len(warnings) == runner_module.QWEN_FUNCTION_ARGS_RETRY_LIMIT

        failures = [p for p in payloads if isinstance(p, RunFailedPayload)]
        assert len(failures) == 1
        assert "function.arguments" in failures[0].error

        assert not any(isinstance(p, RunCompletedPayload) for p in payloads)
        assert not any(isinstance(p, ArtifactProducedPayload) for p in payloads)
    finally:
        await manager.close()


def test_is_qwen_function_args_error_detection() -> None:
    """``_is_qwen_function_args_error`` 正确识别 Qwen 400 错误消息。"""
    # 典型 DashScope 错误
    exc1 = RuntimeError(
        "Error code: 400 - {'error': {'message': "
        "'<400> InternalError.Algo.InvalidParameter: The "
        "\"function.arguments\" parameter of the code model "
        "must be in JSON format.', 'type': 'invalid_request_error', "
        "'code': 'invalid_parameter_error'}}"
    )
    assert runner_module._is_qwen_function_args_error(exc1) is True

    # 缺少关键短语 → False
    assert runner_module._is_qwen_function_args_error(
        RuntimeError("some other 400 error")
    ) is False

    # 非 400 的 function.arguments 错误 (例如解析错误) → False
    assert runner_module._is_qwen_function_args_error(
        RuntimeError("function.arguments is missing")
    ) is False

    # 其它类型异常不抛错
    assert runner_module._is_qwen_function_args_error(ValueError("foo")) is False
