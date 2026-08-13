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
import csv
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from agents import Agent, RunContextWrapper, function_tool
from agents.models.interface import Model
from app.agent_loop.context import RunContext, UserInputSubmitter
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
    artifacts_dir: Path | None = None,
) -> MainInputBroker:
    return MainInputBroker(
        run_id=run_id,
        fixture=fixture,
        emit=emit,
        install_user_input_submitter=install,
        clear_user_input_submitter=clear,
        cancellation_requested=cancellation_requested,
        default_timeout_seconds=default_timeout_seconds,
        artifacts_dir=artifacts_dir,
    )


async def _wait_for_required(
    emitted: list[object],
    *,
    timeout: float = 2.0,
    request_id: str | None = None,
) -> UserInputRequiredPayload:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for payload in emitted:
            if (
                isinstance(payload, UserInputRequiredPayload)
                and payload.prompt_kind == "data_correction"
                and (request_id is None or payload.request_id == request_id)
            ):
                return payload
        await asyncio.sleep(0.01)
    raise TimeoutError("data_correction UserInputRequiredPayload was not emitted")


def _read_corrections_todo(path: Path) -> list[dict[str, str]]:
    """Read the corrections_todo CSV back (utf-8-sig BOM, dict rows)."""

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


# ---------------------------------------------------------------------------
# RunContext.request_main_input: broker-not-installed + delegation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_main_input_without_broker_raises_clear_error(
    tmp_path: Path,
) -> None:
    """subagent/isolated contexts have no broker: the error must be explicit.

    Final-review FIX 1: the missing-broker case raises the dedicated
    ``MainInputBrokerUnavailableError`` (a ``RuntimeError`` subclass) so the
    tool can degrade to a failure message for exactly this case while genuine
    runtime failures still propagate.
    """

    from app.agent_loop.context import MainInputBrokerUnavailableError

    context = RunContext(task_id="task_no_broker", base_dir=tmp_path)

    with pytest.raises(MainInputBrokerUnavailableError, match="main input broker"):
        await context.request_main_input(summary="需要人工修正")

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
# FIX 2 (final review): deterministic deadline arbitration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_late_resume_after_deadline_is_rejected_and_timeout_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """FIX 2 (a): a resume arriving after the deadline is rejected consistently.

    Both rejection layers are exercised deterministically:

    - in-flight request: the monotonic clock is advanced past the deadline
      (monkeypatched ``loop.time``) and the captured submitter call is
      rejected by the submitter's own deadline check
      (``loop.time() > deadline``);
    - completed request: the claimed-timed-out marker rejects any late submit
      call after the timeout won.

    In both cases the human path emits nothing and the synthetic timeout
    resume is the single resumed event.
    """

    emitted: list[object] = []
    installed: list[UserInputSubmitter] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    def install(submitter: UserInputSubmitter) -> None:
        installed.append(submitter)

    def clear(submitter: UserInputSubmitter) -> None:
        pass

    broker = _make_broker(
        run_id="run_late_resume",
        fixture=False,
        emit=emit,
        install=install,
        clear=clear,
        cancellation_requested=asyncio.Event(),
        default_timeout_seconds=0.05,
    )

    # 1) in-flight request, clock advanced past the deadline: the submitter's
    #    own deadline check rejects the late call (no human-path event).
    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", timeout_seconds=0.05)
    )
    required = await _wait_for_required(emitted)
    loop = asyncio.get_running_loop()
    real_time = loop.time
    monkeypatch.setattr(loop, "time", lambda: real_time() + 100.0)
    try:
        accepted = installed[0](
            UserInputResumedPayload(
                request_id=required.request_id,
                decision="approve",
                detail={"correction": "迟到的人类修正"},
            )
        )
    finally:
        monkeypatch.undo()
    assert accepted is False

    decision = await asyncio.wait_for(pending, timeout=2.0)
    assert decision.timed_out is True
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1  # 只有合成的超时 resume,无人类路径事件
    assert resumed_payloads[0].detail["auto_approved"] is True
    assert (
        resumed_payloads[0].detail["auto_approve_reason"]
        == "data_correction_timeout"
    )

    # 2) completed request: the claimed-timed-out marker rejects a late call.
    assert installed[0](
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "更迟的提交"},
        )
    ) is False
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1  # 仍只有合成事件,无重复


@pytest.mark.asyncio
async def test_resume_before_deadline_wins_and_no_synthetic_resume() -> None:
    """FIX 2 (b): a resume arriving before the deadline is accepted and wins.

    The submitter accepts the call (the deadline is not reached), the broker
    returns the human decision, and NO synthetic timeout resume is emitted.
    """

    emitted: list[object] = []
    installed: list[UserInputSubmitter] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    def install(submitter: UserInputSubmitter) -> None:
        installed.append(submitter)

    def clear(submitter: UserInputSubmitter) -> None:
        pass

    broker = _make_broker(
        run_id="run_early_resume",
        fixture=False,
        emit=emit,
        install=install,
        clear=clear,
        cancellation_requested=asyncio.Event(),
        default_timeout_seconds=30.0,
    )

    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", timeout_seconds=30.0)
    )
    required = await _wait_for_required(emitted)

    # deadline 未到:submitter 接受,人类决策成为唯一赢家
    accepted = installed[0](
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
    assert decision.resumed.detail == {"correction": "GPL570"}

    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1
    assert "auto_approved" not in resumed_payloads[0].detail
    assert resumed_payloads[0].request_id == required.request_id


@pytest.mark.asyncio
async def test_resume_racing_timeout_resolves_to_single_deterministic_winner() -> None:
    """FIX 2 (c): a resume racing the deadline resolves to exactly ONE winner.

    Repeated races around the expiry tick: an accepted submission must never
    be discarded by the timeout (accepted ⇒ human wins), and a rejected/late
    submission must never produce a human resumed event (rejected ⇒ timeout
    wins). Exactly one resumed event is emitted per race — no double resume
    events, no lost decision.
    """

    for iteration in range(20):
        await _run_single_deadline_race(iteration)


@pytest.mark.asyncio
async def test_submission_accepted_exactly_at_deadline_wins_over_timeout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """FIX 2 (final wave): an accepted submission wins even when the wait times out.

    Deterministically reproduces the exact-boundary hole: ``asyncio.wait``'s
    timeout fires with an EMPTY done set (``_wait_for_decision`` returns True)
    while a submitter running in the same loop tick already accepted a payload
    at ``loop.time() <= deadline`` — the append is synchronous in the submitter
    and happens-before the event is set, so the holder is authoritative. The
    accepted decision must NOT be discarded by the synthetic timeout:

    - ``decision.timed_out`` is False and the human detail is returned;
    - the human resumed event is emitted (no synthetic auto-approved resume);
    - ``corrections_todo.csv`` is NOT written (a won request never degrades).
    """

    emitted: list[object] = []
    installed: list[UserInputSubmitter] = []
    artifacts_dir = tmp_path / "artifacts"
    submission_injected = asyncio.Event()

    async def emit(payload: object) -> None:
        emitted.append(payload)

    def install(submitter: UserInputSubmitter) -> None:
        installed.append(submitter)

    def clear(submitter: UserInputSubmitter) -> None:
        pass

    broker = _make_broker(
        run_id="run_exact_deadline",
        fixture=False,
        emit=emit,
        install=install,
        clear=clear,
        cancellation_requested=asyncio.Event(),
        default_timeout_seconds=30.0,
        artifacts_dir=artifacts_dir,
    )

    async def fake_wait_for_decision(
        event: asyncio.Event, deadline: float
    ) -> bool:
        # 模拟边界洞:wait 的 timeout 以空 done 集返回(报告超时),但同一 loop
        # tick 内 submitter 已在 loop.time() <= deadline 接受了提交。
        await submission_injected.wait()
        return True

    monkeypatch.setattr(broker, "_wait_for_decision", fake_wait_for_decision)

    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", timeout_seconds=30.0)
    )
    required = await _wait_for_required(emitted)
    assert required.request_id == "data_correction-run_exact_deadline-0"

    # 恰好在 deadline 处被接受的提交(submitter 检查 loop.time() > deadline
    # 为 False → accepted=True,决策同步落入 holder)。
    accepted = installed[0](
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "边界提交"},
        )
    )
    assert accepted is True
    submission_injected.set()

    decision = await asyncio.wait_for(pending, timeout=2.0)
    assert decision.timed_out is False  # 被接受的提交赢,不降级为合成超时
    assert decision.resumed is not None
    assert decision.resumed.detail == {"correction": "边界提交"}

    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1  # 仅人类事件,无合成 resume
    assert resumed_payloads[0].request_id == required.request_id
    assert resumed_payloads[0].detail == {"correction": "边界提交"}
    assert resumed_payloads[0].detail.get("auto_approved") is not True

    # 赢家请求绝不写 corrections_todo.csv
    assert not (artifacts_dir / "corrections_todo.csv").exists()


async def _run_single_deadline_race(iteration: int) -> None:
    """Run one deadline race and assert the single-winner invariant."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id=f"task_race_{iteration}",
        run_id=f"run_race_{iteration}",
        request_id=f"request_race_{iteration}",
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
        default_timeout_seconds=0.05,
    )

    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", timeout_seconds=0.05)
    )
    required = await _wait_for_required(emitted)
    # 在 deadline 附近注入 resume:每次迭代落在边界两侧都可能
    await asyncio.sleep(0.02 + (iteration % 5) * 0.008)
    accepted = execution.submit_user_input(
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": f"race-{iteration}"},
        )
    )
    decision = await asyncio.wait_for(pending, timeout=2.0)

    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1, resumed_payloads
    resumed = resumed_payloads[0]
    assert resumed.request_id == required.request_id

    if accepted:
        # 被接受的提交绝不因超时被丢弃:人类决策成为唯一赢家
        assert decision.timed_out is False, iteration
        assert decision.resumed is not None
        assert decision.resumed.detail == {
            "correction": f"race-{iteration}"
        }
        assert resumed.detail.get("auto_approved") is not True
    else:
        # 被拒绝(迟到/已声明超时)的提交:超时赢,合成 resume 为唯一事件
        assert decision.timed_out is True, iteration
        assert resumed.detail.get("auto_approved") is True
        assert (
            resumed.detail.get("auto_approve_reason")
            == "data_correction_timeout"
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

    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None, **_: build)
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
# T3: corrections_todo.csv timeout degradation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_decision_carries_corrections_path_and_writes_csv(
    tmp_path: Path,
) -> None:
    """T3: live timeout → corrections_path (Path) + artifacts CSV row."""

    emitted: list[object] = []
    artifacts_dir = tmp_path / "artifacts"

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_t3_timeout",
        run_id="run_t3_timeout",
        request_id="request_t3_timeout",
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
        artifacts_dir=artifacts_dir,
    )

    decision = await broker.request_input(
        summary="确认数据平台",
        detail={"field": "platform"},
        timeout_seconds=0.05,
    )

    assert decision.timed_out is True
    assert isinstance(decision.corrections_path, Path)
    assert decision.corrections_path == artifacts_dir / "corrections_todo.csv"
    assert decision.corrections_path.exists()

    rows = _read_corrections_todo(artifacts_dir / "corrections_todo.csv")
    assert len(rows) == 1
    row = rows[0]
    assert row["request_id"] == "data_correction-run_t3_timeout-0"
    assert row["summary"] == "确认数据平台"
    assert json.loads(row["detail_json"]) == {"field": "platform"}
    assert row["status"] == "timed_out"
    assert datetime.fromisoformat(row["requested_at"]).tzinfo is not None
    assert datetime.fromisoformat(row["expires_at"]).tzinfo is not None
    # 原子写:重写后文件仍为合法 CSV,且无临时文件残留
    assert not list(artifacts_dir.glob("corrections_todo.csv.tmp"))


@pytest.mark.asyncio
async def test_corrections_todo_appends_rows_across_timeouts_same_run(
    tmp_path: Path,
) -> None:
    """T3: 同 run 多次超时 → 逐行追加,历史行保留。"""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_t3_append",
        run_id="run_t3_append",
        request_id="request_t3_append",
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
        artifacts_dir=tmp_path / "artifacts",
    )

    first = await broker.request_input(summary="第一次修正", timeout_seconds=0.05)
    second = await broker.request_input(summary="第二次修正", timeout_seconds=0.05)

    assert first.timed_out is True
    assert second.timed_out is True
    rows = _read_corrections_todo(first.corrections_path)
    assert len(rows) == 2
    assert rows[0]["request_id"] == "data_correction-run_t3_append-0"
    assert rows[0]["summary"] == "第一次修正"
    assert rows[1]["request_id"] == "data_correction-run_t3_append-1"
    assert rows[1]["summary"] == "第二次修正"
    assert all(r["status"] == "timed_out" for r in rows)


@pytest.mark.asyncio
async def test_corrections_todo_preserves_history_across_runs(
    tmp_path: Path,
) -> None:
    """T3: 跨 run 累积 — 新 run 超时保留旧 run 的历史行。"""

    async def emit(payload: object) -> None:
        pass

    def make_run(run_id: str) -> tuple[RunExecution, MainInputBroker]:
        execution = RunExecution(
            task_id="task_t3_cross",
            run_id=run_id,
            request_id=f"request_{run_id}",
            input="request a correction",
            context=SimpleNamespace(cancellation_requested=asyncio.Event()),
            _event_emitter=emit,
        )
        broker = _make_broker(
            run_id=run_id,
            fixture=False,
            emit=execution.emit,
            install=execution.set_user_input_submitter,
            clear=execution.clear_user_input_submitter,
            cancellation_requested=execution.context.cancellation_requested,
            artifacts_dir=tmp_path / "artifacts",
        )
        return execution, broker

    _, run_one = make_run("run_t3_cross_a")
    await run_one.request_input(summary="第一次修正", timeout_seconds=0.05)

    _, run_two = make_run("run_t3_cross_b")
    second = await run_two.request_input(summary="第二次修正", timeout_seconds=0.05)

    rows = _read_corrections_todo(second.corrections_path)
    assert len(rows) == 2
    assert rows[0]["request_id"] == "data_correction-run_t3_cross_a-0"
    assert rows[1]["request_id"] == "data_correction-run_t3_cross_b-0"
    assert rows[0]["summary"] == "第一次修正"
    assert rows[1]["summary"] == "第二次修正"


@pytest.mark.asyncio
async def test_resumed_decision_does_not_write_corrections_todo(
    tmp_path: Path,
) -> None:
    """T3: resume 到达的请求不写 corrections_todo.csv(也不新增行)。"""

    emitted: list[object] = []
    artifacts_dir = tmp_path / "artifacts"

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_t3_resumed",
        run_id="run_t3_resumed",
        request_id="request_t3_resumed",
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
        artifacts_dir=artifacts_dir,
    )

    # 1) 干净目录:resume 到达 → 不创建文件
    pending = asyncio.create_task(
        broker.request_input(summary="需要人工修正", timeout_seconds=5.0)
    )
    required = await _wait_for_required(emitted)
    execution.submit_user_input(
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "GPL570"},
        )
    )
    decision = await asyncio.wait_for(pending, timeout=2.0)
    assert decision.timed_out is False
    assert decision.corrections_path is None
    assert not (artifacts_dir / "corrections_todo.csv").exists()

    # 2) 已有历史行:resume 到达 → 不新增行
    timed_out = await broker.request_input(summary="超时修正", timeout_seconds=0.05)
    assert timed_out.timed_out is True
    csv_path = artifacts_dir / "corrections_todo.csv"
    assert csv_path.exists()
    rows_before = _read_corrections_todo(csv_path)
    assert len(rows_before) == 1

    pending = asyncio.create_task(
        broker.request_input(summary="resume 修正", timeout_seconds=5.0)
    )
    required = await _wait_for_required(
        emitted, request_id="data_correction-run_t3_resumed-2"
    )
    execution.submit_user_input(
        UserInputResumedPayload(
            request_id=required.request_id,
            decision="approve",
            detail={"correction": "OK"},
        )
    )
    decision = await asyncio.wait_for(pending, timeout=2.0)
    assert decision.timed_out is False
    assert _read_corrections_todo(csv_path) == rows_before


@pytest.mark.asyncio
async def test_corrections_todo_write_failure_degrades_gracefully(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """T3: 写失败不崩溃 — warning 记录,corrections_path=None,请求仍返回降级结果。"""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    blocker = tmp_path / "artifacts_blocked"
    blocker.write_text("not a directory")  # mkdir 将失败(FileExistsError)

    execution = RunExecution(
        task_id="task_t3_fail",
        run_id="run_t3_fail",
        request_id="request_t3_fail",
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
        artifacts_dir=blocker,
    )

    with caplog.at_level("WARNING", logger="app.agent_loop.main_input_broker"):
        decision = await broker.request_input(
            summary="需要人工修正",
            timeout_seconds=0.05,
        )

    assert decision.timed_out is True  # 运行继续,不抛异常
    assert decision.corrections_path is None
    assert "corrections_todo" in caplog.text

    # 合成 resume 仍正常发射,Run 可离开 AWAITING_USER_INPUT
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1
    assert resumed_payloads[0].detail["auto_approved"] is True


@pytest.mark.asyncio
async def test_corrections_todo_without_artifacts_dir_warns_and_degrades(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """T5 (T3 review 可选): artifacts_dir=None 时记录 warning 并降级,不崩溃。

    broker 未配置 artifacts 目录(单元/非 manager 上下文)时,超时请求无法
    落盘 corrections_todo.csv —— 必须显式告警,而不是静默假成功。
    """

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_t5_no_dir",
        run_id="run_t5_no_dir",
        request_id="request_t5_no_dir",
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
        artifacts_dir=None,
    )

    with caplog.at_level("WARNING", logger="app.agent_loop.main_input_broker"):
        decision = await broker.request_input(
            summary="需要人工修正",
            timeout_seconds=0.05,
        )

    assert decision.timed_out is True  # 运行继续,不抛异常
    assert decision.corrections_path is None
    assert "corrections_todo" in caplog.text

    # 合成 resume 仍正常发射,Run 可离开 AWAITING_USER_INPUT
    resumed_payloads = [
        p for p in emitted if isinstance(p, UserInputResumedPayload)
    ]
    assert len(resumed_payloads) == 1
    assert resumed_payloads[0].detail["auto_approved"] is True


@pytest.mark.asyncio
async def test_corrections_todo_csv_escapes_comma_newline_quotes(
    tmp_path: Path,
) -> None:
    """T5 (T3 review 可选): 逗号/换行/引号重自由文本在 CSV 中正确转义往返。

    summary/detail_json 携带逗号、换行与双引号时,落盘行必须能被
    ``csv.DictReader`` 无损读回(逐字节一致),否则待办修正内容会被截断/错列。
    """

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    execution = RunExecution(
        task_id="task_t5_escape",
        run_id="run_t5_escape",
        request_id="request_t5_escape",
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
        artifacts_dir=tmp_path / "artifacts",
    )

    summary = '第一行,含逗号 "引号"\n第二行'
    detail: dict[str, object] = {
        "dataset_id": 'GSE"1,234"',
        "note": "多行\n注释,含逗号",
    }
    decision = await broker.request_input(
        summary=summary,
        detail=detail,
        timeout_seconds=0.05,
    )

    assert decision.timed_out is True
    assert decision.corrections_path is not None
    rows = _read_corrections_todo(decision.corrections_path)
    assert len(rows) == 1
    assert rows[0]["summary"] == summary
    assert json.loads(rows[0]["detail_json"]) == detail


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


@function_tool
async def request_human_correction_timeout_probe(
    ctx: RunContextWrapper[RunContext],
    summary: str,
) -> str:
    """Probe tool that pauses with a short deadline so the broker times out."""

    decision = await ctx.context.request_main_input(
        summary=summary,
        detail={"probe": "correction-timeout-e2e"},
        timeout_seconds=1.0,
    )
    if decision.timed_out:
        return json.dumps(
            {
                "status": "timed_out",
                "request_id": decision.request_id,
                "corrections_path": (
                    str(decision.corrections_path)
                    if decision.corrections_path is not None
                    else None
                ),
            },
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "status": "decided",
            "detail": decision.resumed.detail if decision.resumed else {},
        },
        ensure_ascii=False,
    )


@pytest.mark.asyncio
async def test_agent_loop_data_correction_timeout_e2e(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """真实 TaskManager 流:data_correction 暂停 → 超时降级 → 文件落盘 → COMPLETED。

    T1 REVIEW 残余项(manager 级超时集成):AWAITING_USER_INPUT → (合成 resume)
    → RUNNING → COMPLETED,且 corrections_todo.csv 写入任务 artifacts 目录,
    降级路径经 decision.corrections_path 流回工具输出。
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    model = _ScriptedCorrectionModel(
        tool_name="request_human_correction_timeout_probe"
    )
    agent = Agent[RunContext](
        name="Correction Agent",
        instructions="Call request_human_correction_timeout_probe, then answer.",
        tools=[request_human_correction_timeout_probe],
        model=model,
    )
    build = SimpleNamespace(
        agent=agent,
        skill_names=("request_human_correction_timeout_probe",),
        model=model,
    )
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None, **_: build)

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_data_correction_timeout_e2e",
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

        paused = await repository.get_snapshot(accepted.task_id)
        assert paused is not None
        assert paused.runs[-1].status.value == "awaiting_user_input"

        # 无人答复:broker 超时 → 写 corrections_todo.csv + 合成 resume → 继续
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
        assert resumed[0].detail["auto_approved"] is True
        resumed_idx = payloads.index(resumed[0])
        completed_idx = next(
            i for i, p in enumerate(payloads)
            if isinstance(p, RunCompletedPayload)
        )
        assert required_idx < resumed_idx < completed_idx

        # corrections_todo.csv 落盘:一行,status=timed_out,字段完整
        csv_path = (
            repository.tasks_dir
            / accepted.task_id
            / "artifacts"
            / "corrections_todo.csv"
        )
        assert csv_path.exists()
        rows = _read_corrections_todo(csv_path)
        assert len(rows) == 1
        assert rows[0]["request_id"] == required.request_id
        assert rows[0]["status"] == "timed_out"
        assert rows[0]["summary"] == "确认数据平台"
        assert json.loads(rows[0]["detail_json"]) == {
            "probe": "correction-timeout-e2e"
        }
        assert datetime.fromisoformat(rows[0]["requested_at"]).tzinfo is not None
        assert datetime.fromisoformat(rows[0]["expires_at"]).tzinfo is not None

        # 工具输出携带降级路径,证明 corrections_path 经 decision 流回工具
        tool_outputs = [
            p.output
            for p in payloads
            if isinstance(p, ToolCompletedPayload)
            and p.tool_name == "request_human_correction_timeout_probe"
        ]
        assert len(tool_outputs) == 1
        parsed_output = json.loads(tool_outputs[0])
        assert parsed_output["status"] == "timed_out"
        # 经 JSON 序列化后比较,避免 Windows 反斜杠转义 (json.dumps → \\)
        # 导致子串匹配失败
        assert parsed_output["corrections_path"] == str(csv_path)
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        await manager.close()


class _ScriptedCorrectionModel(Model):
    """Two rounds: data_correction tool call, then the final answer."""

    def __init__(
        self,
        *,
        tool_name: str = "request_human_correction_probe",
        tool_arguments: dict[str, object] | None = None,
    ) -> None:
        self.tool_name = tool_name
        self.tool_arguments = tool_arguments or {"summary": "确认数据平台"}
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
                arguments=json.dumps(self.tool_arguments),
                call_id="call_correction",
                name=self.tool_name,
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


class _CorrectionAwareModel(Model):
    """Two rounds: tool call, then a final answer derived from the tool output.

    The second round reads the real SDK conversation history (the ``input``
    items passed to ``stream_response``) for the ``function_call_output`` item
    and echoes the human correction it carries. The final message can only
    reference the correction if the human decision actually flowed through the
    agent loop (pause → resume → tool output → next model turn), which is the
    proof T5 needs: the correction influences the outcome, not just the tool
    return value.
    """

    def __init__(self) -> None:
        self.allow_tool_call = asyncio.Event()
        self.tool_round_entered = asyncio.Event()
        self.final_round_entered = asyncio.Event()
        self.release_final_answer = asyncio.Event()
        self.stream_calls = 0
        self.close_calls = 0

    async def get_response(self, *args: object, **kwargs: object) -> object:
        raise AssertionError("scripted integration must use streaming")

    @staticmethod
    def _extract_correction(input_items: object) -> str:
        """Pull ``detail.correction`` out of the round-2 conversation history."""

        if not isinstance(input_items, list):
            raise AssertionError(
                "expected conversation input list in round 2"
            )
        for item in input_items:
            if (
                not isinstance(item, dict)
                or item.get("type") != "function_call_output"
            ):
                continue
            output = item.get("output")
            if not isinstance(output, str):
                continue
            try:
                parsed = json.loads(output)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            detail = parsed.get("detail")
            if (
                isinstance(detail, dict)
                and isinstance(detail.get("correction"), str)
            ):
                return detail["correction"]
        raise AssertionError(
            "correction not found in round-2 conversation input"
        )

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
                call_id="call_correction_aware",
                name="request_human_correction_probe",
                type="function_call",
                status="completed",
            )
        elif self.stream_calls == 2:
            self.final_round_entered.set()
            await self.release_final_answer.wait()
            correction = self._extract_correction(args[1])
            item = ResponseOutputMessage(
                id="message_correction_aware",
                content=[
                    ResponseOutputText(
                        annotations=[],
                        text=f"使用 {correction} 继续分析",
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
            model="scripted-correction-aware-model",
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
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None, **_: build)

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


@pytest.mark.asyncio
async def test_agent_loop_data_correction_influences_outcome_e2e(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """T5 E2E: 暂停 → 人工修正 → 恢复 → 修正影响最终结果 (真实 agent turn)。

    与 T1 E2E 的区别:第二轮的 scripted 模型必须从真实 SDK 会话历史
    (``function_call_output`` 项)中提取人工修正文本,最终助手消息才能引用它
    (``使用 GPL570 继续分析``)。修正值只能通过真实 agent 循环到达模型:
    工具暂停 → manager.resume_run 投递 → broker 返回决策 → 工具输出进入会话
    → 下一轮模型调用看到它。若任一环节断裂,最终消息不会包含 GPL570。
    """

    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    model = _CorrectionAwareModel()
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
    monkeypatch.setattr(
        runner_module, "build_agent", lambda databases=None, **_: build
    )

    manager = TaskManager(repository, run_executor=make_executor(repository))
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="request_data_correction_influence_e2e",
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

        # 人工修正影响了最终结果:助手消息引用 GPL570,而模型只能从
        # 真实会话历史(工具输出)学到该值。
        final_contents = [
            message.content
            for message in completed.messages
            if message.role.value == "assistant"
        ]
        assert any(
            "GPL570" in content for content in final_contents
        ), final_contents

        # 工具输出事件携带人类决策(与 T1 一致)
        events = await repository.list_events(accepted.task_id)
        payloads = [event.payload for event in events]
        tool_outputs = [
            p.output
            for p in payloads
            if isinstance(p, ToolCompletedPayload)
            and p.tool_name == "request_human_correction_probe"
        ]
        assert len(tool_outputs) == 1
        assert '"correction": "GPL570"' in tool_outputs[0]
        assert not any(isinstance(p, RunFailedPayload) for p in payloads)
    finally:
        model.allow_tool_call.set()
        model.release_final_answer.set()
        await manager.close()
