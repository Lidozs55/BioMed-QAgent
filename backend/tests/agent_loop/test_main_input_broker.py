"""T1 (Phase 4c): main-run input broker — ``request_main_input`` tests.

Covers docs/archive/superpowers/specs/2026-08-07-phase4c-hil-correction-design.md
§3-D1 / §4-T1:

- Fixture runs auto-approve immediately (``fixture_exempt`` marker) and never
  block;
- Live runs pause via ``UserInputRequiredPayload(prompt_kind="data_correction")``
  and the broker returns the human decision delivered through the execution
  submitter channel (``RunExecution.submit_user_input`` — the exact path used
  by ``manager.resume_run``);
- A deadline timeout returns a structured degraded result (``timed_out=True``)
  instead of raising, and emits a synthetic auto-approved resume so the Run
  leaves ``AWAITING_USER_INPUT`` (the reducer forbids FINALIZING from it);
- Cancellation while paused propagates the agent-loop cancellation exception
  (``CompactionCancelledError``);
- ``RunContext.request_main_input`` raises a clear error when the broker is
  not installed (subagent contexts);
- The runner installs one broker per Run (request-id counter resets per Run);
- Full manager E2E: tool pauses the Run, resume delivers the decision, Run
  completes with the decision observable in the tool output event.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from agents import Agent, RunContextWrapper, function_tool
from agents.models.interface import Model
from app.agent_loop.context import RunContext
from app.agent_loop.main_input_broker import MainInputBroker, MainInputDecision
from app.domain.contracts import (
    RunCompletedPayload,
    RunFailedPayload,
    StartTaskRequest,
    ToolCompletedPayload,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.runtime.compaction import CompactionCancelledError
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


def run_scoped_session(session: object):
    def task_session(task_id: str, *, run_id: str) -> object:
        return session

    return task_session


def _make_build():
    return SimpleNamespace(
        agent=object(),
        skill_names=(),
        model=SimpleNamespace(close=AsyncMock()),
    )


def _make_broker(
    *,
    run_id: str,
    fixture: bool = False,
    emit,
    install,
    clear,
    cancellation_requested: asyncio.Event | None = None,
    default_timeout_seconds: float = 300.0,
) -> MainInputBroker:
    return MainInputBroker(
        run_id=run_id,
        fixture=fixture,
        emit=emit,
        install_user_input_submitter=install,
        clear_user_input_submitter=clear,
        cancellation_requested=cancellation_requested,
        default_timeout_seconds=default_timeout_seconds,
    )


async def _wait_for_required(
    emitted: list[object],
    *,
    timeout: float = 2.0,
) -> UserInputRequiredPayload:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for payload in emitted:
            if (
                isinstance(payload, UserInputRequiredPayload)
                and payload.prompt_kind == "data_correction"
            ):
                return payload
        await asyncio.sleep(0.01)
    raise TimeoutError("data_correction UserInputRequiredPayload was not emitted")


# ---------------------------------------------------------------------------
# RunContext.request_main_input: broker-not-installed + delegation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_main_input_without_broker_raises_clear_error(
    tmp_path: Path,
) -> None:
    """subagent/isolated contexts have no broker: the error must be explicit."""

    context = RunContext(task_id="task_no_broker", base_dir=tmp_path)

    with pytest.raises(RuntimeError, match="main input broker"):
        await context.request_main_input(summary="需要人工修正")


@pytest.mark.asyncio
async def test_request_main_input_delegates_to_bound_broker(
    tmp_path: Path,
) -> None:
    """request_main_input forwards summary/detail/timeout to the broker."""

    received: dict[str, object] = {}

    class FakeBroker:
        async def request_input(
            self,
            *,
            summary: str,
            detail: dict[str, object] | None = None,
            timeout_seconds: float | None = None,
        ) -> MainInputDecision:
            received["summary"] = summary
            received["detail"] = detail
            received["timeout_seconds"] = timeout_seconds
            return MainInputDecision(
                request_id="data_correction-run_fake-0",
                summary=summary,
                detail=dict(detail or {}),
                requested_at=datetime.now(UTC),
                expires_at=datetime.now(UTC),
                timeout_seconds=timeout_seconds or 0.0,
                timed_out=False,
                resumed=None,
            )

    context = RunContext(task_id="task_delegates", base_dir=tmp_path)
    context.bind_main_input_broker(FakeBroker())  # type: ignore[arg-type]

    decision = await context.request_main_input(
        summary="澄清平台",
        detail={"field": "platform"},
        timeout_seconds=42.0,
    )

    assert received == {
        "summary": "澄清平台",
        "detail": {"field": "platform"},
        "timeout_seconds": 42.0,
    }
    assert decision.request_id == "data_correction-run_fake-0"
    assert context.main_input_broker is not None


# ---------------------------------------------------------------------------
# Fixture mode: auto-approve, no blocking
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fixture_broker_auto_approves_without_blocking() -> None:
    """fixture: synthetic approve immediately; fixture_exempt markers; no wait."""

    emitted: list[object] = []
    installed: list[object] = []
    cleared: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    def install(submitter) -> None:
        installed.append(submitter)

    def clear(submitter) -> None:
        cleared.append(submitter)

    broker = _make_broker(
        run_id="run_fixture",
        fixture=True,
        emit=emit,
        install=install,
        clear=clear,
    )

    started = asyncio.get_running_loop().time()
    decision = await broker.request_input(
        summary="确认数据平台",
        detail={"field": "platform"},
    )
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.5  # 立即返回,不阻塞
    assert decision.timed_out is False
    assert decision.resumed is not None
    assert decision.resumed.decision == "approve"
    assert decision.resumed.detail["fixture_exempt"] is True
    assert "fixture_note" in decision.resumed.detail
    assert decision.request_id == "data_correction-run_fixture-0"
    assert decision.expires_at is not None

    required = emitted[0]
    assert isinstance(required, UserInputRequiredPayload)
    assert required.prompt_kind == "data_correction"
    assert required.fixture_exempt is True
    assert required.expires_at is not None
    assert required.detail == {"field": "platform"}

    resumed = emitted[1]
    assert isinstance(resumed, UserInputResumedPayload)
    assert resumed.request_id == decision.request_id

    # fixture 模式不安装 submitter(不等待)
    assert installed == []
    assert cleared == []


# ---------------------------------------------------------------------------
# Live mode: roundtrip through the execution submitter channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_live_broker_roundtrip_delivers_human_decision() -> None:
    """live: pause → submit_user_input (manager resume path) → decision returned."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    context = SimpleNamespace(cancellation_requested=asyncio.Event())
    execution = RunExecution(
        task_id="task_live_roundtrip",
        run_id="run_live_roundtrip",
        request_id="request_live_roundtrip",
        input="request a correction",
        context=context,
        _event_emitter=emit,
    )
    broker = _make_broker(
        run_id=execution.run_id,
        fixture=False,
        emit=execution.emit,
        install=execution.set_user_input_submitter,
        clear=execution.clear_user_input_submitter,
        cancellation_requested=context.cancellation_requested,
        default_timeout_seconds=30.0,
    )

    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", detail={"field": "platform"})
    )
    required = await _wait_for_required(emitted)
    assert required.request_id == "data_correction-run_live_roundtrip-0"
    assert required.fixture_exempt is False
    assert required.expires_at is not None
    assert required.detail == {"field": "platform"}

    # 模拟 manager.resume_run 的投递路径:live_execution.submit_user_input
    accepted = execution.submit_user_input(
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "GPL570"},
        )
    )
    assert accepted is True

    decision = await asyncio.wait_for(pending, timeout=2.0)
    assert decision.timed_out is False
    assert decision.resumed is not None
    assert decision.resumed.decision == "approve"
    assert decision.resumed.detail == {"correction": "GPL570"}

    # resumed 事件在 required 之后发射(reducer AWAITING_USER_INPUT -> RUNNING)
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1
    assert emitted.index(resumed_payloads[0]) > emitted.index(required)


@pytest.mark.asyncio
async def test_live_broker_timeout_returns_degraded_result_without_raising() -> None:
    """live timeout: degraded decision (timed_out=True), synthetic resume, no raise."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_live_timeout",
        run_id="run_live_timeout",
        request_id="request_live_timeout",
        input="request a correction",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
        _event_emitter=emit,
    )
    broker = _make_broker(
        run_id=execution.run_id,
        fixture=False,
        emit=execution.emit,
        install=execution.set_user_input_submitter,
        clear=execution.clear_user_input_submitter,
        cancellation_requested=execution.context.cancellation_requested,
    )

    started = asyncio.get_running_loop().time()
    decision = await broker.request_input(
        summary="需要人工修正",
        timeout_seconds=0.05,
    )
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 2.0  # 不阻塞
    assert decision.timed_out is True
    assert decision.resumed is None
    assert decision.request_id == "data_correction-run_live_timeout-0"
    assert decision.expires_at is not None
    assert decision.summary == "需要人工修正"

    # 超时后发射合成的 auto-approved resume,让 Run 离开 AWAITING_USER_INPUT
    required = await _wait_for_required(emitted)
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1
    resumed = resumed_payloads[0]
    assert resumed.request_id == required.request_id
    assert resumed.decision == "approve"
    assert resumed.detail["auto_approved"] is True
    assert resumed.detail["auto_approve_reason"] == "data_correction_timeout"
    assert emitted.index(resumed) > emitted.index(required)


@pytest.mark.asyncio
async def test_live_broker_cancellation_while_paused_raises() -> None:
    """cancellation while paused propagates the agent-loop cancellation error."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    cancellation = asyncio.Event()
    execution = RunExecution(
        task_id="task_live_cancel",
        run_id="run_live_cancel",
        request_id="request_live_cancel",
        input="request a correction",
        context=SimpleNamespace(cancellation_requested=cancellation),
        _event_emitter=emit,
    )
    broker = _make_broker(
        run_id=execution.run_id,
        fixture=False,
        emit=execution.emit,
        install=execution.set_user_input_submitter,
        clear=execution.clear_user_input_submitter,
        cancellation_requested=cancellation,
    )

    pending = asyncio.create_task(broker.request_input(summary="需要人工修正"))
    await _wait_for_required(emitted)
    cancellation.set()

    with pytest.raises(CompactionCancelledError):
        await asyncio.wait_for(pending, timeout=2.0)
    # submitter 已清理,后续 resume 不应再被接受
    assert execution._user_input_submitter is None  # noqa: SLF001


@pytest.mark.asyncio
async def test_broker_request_ids_increment_per_run() -> None:
    """request_id = data_correction-{run_id}-{counter},counter 每 run 递增."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    broker = _make_broker(
        run_id="run_counter",
        fixture=True,
        emit=emit,
        install=lambda submitter: None,
        clear=lambda submitter: None,
    )

    first = await broker.request_input(summary="第一次修正")
    second = await broker.request_input(summary="第二次修正")

    assert first.request_id == "data_correction-run_counter-0"
    assert second.request_id == "data_correction-run_counter-1"

    # 每 run 新安装的 broker 从 0 重新计数
    fresh = _make_broker(
        run_id="run_counter",
        fixture=True,
        emit=emit,
        install=lambda submitter: None,
        clear=lambda submitter: None,
    )
    assert (await fresh.request_input(summary="新 run")).request_id == (
        "data_correction-run_counter-0"
    )


# ---------------------------------------------------------------------------
# Runner installs the broker per Run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_runner_installs_main_input_broker_per_run(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """AgentRunExecutor.__call__ 为每个 Run 安装 main_input_broker。"""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    build = _make_build()
    context = RunContext(task_id="task_broker_install", base_dir=tmp_path)
    context.bind_managed_run("run_broker_install")
    execution = RunExecution(
        task_id="task_broker_install",
        run_id="run_broker_install",
        request_id="request_broker_install",
        input="install the broker",
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
    repository = SimpleNamespace(task_session=run_scoped_session(object()))

    await make_executor(repository)(execution)

    assert context.main_input_broker is not None
    assert context.main_input_broker._run_id == "run_broker_install"  # noqa: SLF001
    build.model.close.assert_awaited_once_with()


# ---------------------------------------------------------------------------
# Manager E2E: data_correction pause → resume → decision → COMPLETED
# ---------------------------------------------------------------------------


@function_tool
async def request_human_correction_probe(
    ctx: RunContextWrapper[RunContext],
    summary: str,
) -> str:
    """Probe tool that pauses the main Run for a human correction decision."""

    decision = await ctx.context.request_main_input(
        summary=summary,
        detail={"probe": "correction-e2e"},
    )
    if decision.timed_out:
        return json.dumps(
            {"status": "timed_out", "request_id": decision.request_id},
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "status": "decided",
            "decision": decision.resumed.decision if decision.resumed else None,
            "detail": decision.resumed.detail if decision.resumed else {},
        },
        ensure_ascii=False,
    )


class _ScriptedCorrectionModel(Model):
    """Two rounds: data_correction tool call, then the final answer."""

    def __init__(self) -> None:
        self.allow_tool_call = asyncio.Event()
        self.tool_round_entered = asyncio.Event()
        self.final_round_entered = asyncio.Event()
        self.release_final_answer = asyncio.Event()
        self.stream_calls = 0
        self.close_calls = 0

    async def get_response(self, *args: object, **kwargs: object) -> object:
        raise AssertionError("scripted integration must use streaming")

    async def stream_response(
        self,
        *args: object,
        **kwargs: object,
    ) -> object:
        self.stream_calls += 1
        if self.stream_calls == 1:
            self.tool_round_entered.set()
            await self.allow_tool_call.wait()
            item = ResponseFunctionToolCall(
                arguments=json.dumps({"summary": "确认数据平台"}),
                call_id="call_correction",
                name="request_human_correction_probe",
                type="function_call",
                status="completed",
            )
        elif self.stream_calls == 2:
            self.final_round_entered.set()
            await self.release_final_answer.wait()
            item = ResponseOutputMessage(
                id="message_correction",
                content=[
                    ResponseOutputText(
                        annotations=[],
                        text="correction decision received",
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
            model="scripted-correction-model",
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


async def _wait_for_data_correction_payload(
    repository: TaskRepository,
    task_id: str,
    *,
    timeout: float = 5.0,
) -> UserInputRequiredPayload:
    """Poll the durable event log until the data_correction prompt lands."""

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        events = await repository.list_events(task_id)
        for event in events:
            payload = event.payload
            if (
                isinstance(payload, UserInputRequiredPayload)
                and payload.prompt_kind == "data_correction"
            ):
                return payload
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"task {task_id} did not emit data_correction UserInputRequiredPayload"
    )


@pytest.mark.asyncio
async def test_agent_loop_data_correction_pause_resume_e2e(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """真实 SDK 链路:工具暂停 → manager.resume_run 投递 → 决策返回 → COMPLETED。

    验证 runner 安装的 broker 全链路:
    1. request_human_correction_probe 工具调用 request_main_input → Run 暂停
       (user_input_required data_correction,request_id 前缀 + expires_at)
    2. manager.resume_run(approve, detail={"correction": "GPL570"})
       → 决策经 submitter 回到工具
    3. 工具输出事件包含人类决策;Run 最终 COMPLETED
    4. 事件顺序:user_input_required < user_input_resumed < run_completed
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    model = _ScriptedCorrectionModel()
    agent = Agent[RunContext](
        name="Correction Agent",
        instructions="Call request_human_correction_probe, then answer.",
        tools=[request_human_correction_probe],
        model=model,
    )
    build = SimpleNamespace(
        agent=agent,
        skill_names=("request_human_correction_probe",),
        model=model,
    )
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_data_correction_e2e",
                input="request a data correction",
            )
        )
        await asyncio.wait_for(model.tool_round_entered.wait(), timeout=2)
        model.allow_tool_call.set()

        required = await _wait_for_data_correction_payload(
            repository,
            accepted.task_id,
        )
        assert required.request_id.startswith(
            f"data_correction-{accepted.run_id}-"
        )
        assert required.expires_at is not None
        assert required.detail == {"probe": "correction-e2e"}

        paused = await repository.get_snapshot(accepted.task_id)
        assert paused is not None
        assert paused.runs[-1].status.value == "awaiting_user_input"

        await manager.resume_run(
            accepted.task_id,
            accepted.run_id,
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "GPL570"},
        )
        await asyncio.wait_for(model.final_round_entered.wait(), timeout=5)
        model.release_final_answer.set()
        await manager.wait_until_idle()

        completed = await repository.get_snapshot(accepted.task_id)
        assert completed is not None
        assert completed.runs[-1].status.value == "completed"

        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]

        required_idx = next(
            i for i, p in enumerate(payloads)
            if isinstance(p, UserInputRequiredPayload)
        )
        resumed = [p for p in payloads if isinstance(p, UserInputResumedPayload)]
        assert len(resumed) == 1
        assert resumed[0].decision == "approve"
        assert resumed[0].detail == {"correction": "GPL570"}
        resumed_idx = payloads.index(resumed[0])
        completed_idx = next(
            i for i, p in enumerate(payloads)
            if isinstance(p, RunCompletedPayload)
        )
        assert required_idx < resumed_idx < completed_idx

        # 工具输出事件携带人类决策,证明 broker 把 decision 返回给了工具
        tool_outputs = [
            p.output
            for p in payloads
            if isinstance(p, ToolCompletedPayload)
            and p.tool_name == "request_human_correction_probe"
        ]
        assert len(tool_outputs) == 1
        assert '"decision": "approve"' in tool_outputs[0]
        assert '"correction": "GPL570"' in tool_outputs[0]
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        await manager.close()
