"""T2 (Phase 4c): ``request_human_correction`` FunctionTool tests.

Covers docs/archive/superpowers/specs/2026-08-07-phase4c-hil-correction-design.md
§3-D2 / §4-T2:

- The tool calls ``RunContext.request_main_input`` and serializes the human
  decision into agent-facing text: approve → ``用户已确认：<correction>``,
  reject → ``用户已拒绝并继续：<correction>``;
- A resume without a ``correction`` field falls back to the decision verb plus
  the remaining detail (never loses the human's reply);
- A ``timed_out`` decision returns the degraded message referencing
  ``corrections_todo.csv`` (T3 fills the full path via a ``corrections_path``
  field on the decision when present);
- A missing broker (subagent/unit-test context) returns a clear failure
  message instead of raising into the SDK;
- The tool is registered in ``build_agent``'s tools list with the expected
  parameters and guidance description;
- Fixture mode flows through the broker's synthetic approval (no blocking).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.agent_loop.main_input_broker import MainInputBroker, MainInputDecision
from app.domain.contracts import (
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.model_config.token_estimation import serialize_function_tool_schemas
from app.skills.catalog import SkillCatalog

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _resumed(
    *,
    decision: str = "approve",
    detail: dict[str, object] | None = None,
    request_id: str = "data_correction-run_t2-0",
) -> UserInputResumedPayload:
    return UserInputResumedPayload(
        request_id=request_id,
        decision=decision,  # type: ignore[arg-type]
        detail=detail or {},
    )


def _decision(
    *,
    timed_out: bool,
    resumed: UserInputResumedPayload | None,
    summary: str = "确认数据平台",
    request_id: str = "data_correction-run_t2-0",
) -> MainInputDecision:
    return MainInputDecision(
        request_id=request_id,
        summary=summary,
        detail={},
        requested_at=datetime.now(UTC),
        expires_at=datetime.now(UTC),
        timeout_seconds=30.0,
        timed_out=timed_out,
        resumed=resumed,
    )


class _DecisionBroker:
    """Duck-typed broker returning a canned decision and recording the call."""

    def __init__(self, decision: MainInputDecision) -> None:
        self._decision = decision
        self.received: dict[str, object] = {}

    async def request_input(
        self,
        *,
        summary: str,
        detail: dict[str, object] | None = None,
        timeout_seconds: float | None = None,
    ) -> MainInputDecision:
        self.received = {
            "summary": summary,
            "detail": detail,
            "timeout_seconds": timeout_seconds,
        }
        return self._decision


def _make_ctx(run_ctx: RunContext) -> ToolContext:
    return ToolContext(
        context=run_ctx,
        tool_name="request_human_correction",
        tool_call_id="call_t2",
        tool_arguments="{}",
    )


async def _invoke_tool(
    run_ctx: RunContext,
    *,
    summary: str = "确认数据平台",
    detail: dict[str, object] | None = None,
    timeout_seconds: float | None = None,
) -> str:
    from app.agent_loop.request_human_correction import request_human_correction

    kwargs: dict[str, object] = {"summary": summary}
    if detail is not None:
        kwargs["detail"] = detail
    if timeout_seconds is not None:
        kwargs["timeout_seconds"] = timeout_seconds
    result = await request_human_correction.on_invoke_tool(
        _make_ctx(run_ctx),
        json.dumps(kwargs),
    )
    assert isinstance(result, str)
    return result


def _ctx_with_broker(tmp_path: Path, decision: MainInputDecision) -> RunContext:
    context = RunContext(task_id="task_t2_broker", base_dir=tmp_path)
    context.bind_main_input_broker(_DecisionBroker(decision))  # type: ignore[arg-type]
    return context


# ---------------------------------------------------------------------------
# approve / reject serialization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approve_with_correction_returns_confirmation_text(
    tmp_path: Path,
) -> None:
    """approve + detail.correction → 用户已确认：<correction>;args forwarded."""

    decision = _decision(
        timed_out=False,
        resumed=_resumed(decision="approve", detail={"correction": "GPL570"}),
    )
    context = _ctx_with_broker(tmp_path, decision)

    result = await _invoke_tool(
        context,
        summary="澄清平台",
        detail={"field": "platform"},
        timeout_seconds=42.0,
    )

    assert result == "用户已确认：GPL570"
    broker = context.main_input_broker
    assert broker is not None
    assert broker.received == {  # type: ignore[attr-defined]
        "summary": "澄清平台",
        "detail": {"field": "platform"},
        "timeout_seconds": 42.0,
    }


@pytest.mark.asyncio
async def test_reject_with_correction_returns_rejection_text(
    tmp_path: Path,
) -> None:
    """reject + detail.correction → 用户已拒绝并继续：<correction>."""

    decision = _decision(
        timed_out=False,
        resumed=_resumed(decision="reject", detail={"correction": "跳过 GEO"}),
    )
    context = _ctx_with_broker(tmp_path, decision)

    result = await _invoke_tool(context, summary="是否继续 GEO 下载")

    assert result == "用户已拒绝并继续：跳过 GEO"


@pytest.mark.asyncio
async def test_resume_without_correction_falls_back_to_detail(
    tmp_path: Path,
) -> None:
    """No correction field: decision verb + serialized detail, never empty."""

    decision = _decision(
        timed_out=False,
        resumed=_resumed(
            decision="approve",
            detail={"note": "使用 TCGA-PAAD", "fixture_exempt": True},
        ),
    )
    context = _ctx_with_broker(tmp_path, decision)

    result = await _invoke_tool(context, summary="确认数据平台")

    assert "用户已确认" in result
    assert "使用 TCGA-PAAD" in result
    assert "fixture_exempt" in result


@pytest.mark.asyncio
async def test_resume_with_empty_detail_returns_verb_only(
    tmp_path: Path,
) -> None:
    """Empty detail and no correction: the decision verb alone is enough."""

    decision = _decision(
        timed_out=False,
        resumed=_resumed(decision="approve", detail={}),
    )
    context = _ctx_with_broker(tmp_path, decision)

    result = await _invoke_tool(context, summary="确认数据平台")

    assert result == "用户已确认"


# ---------------------------------------------------------------------------
# timed-out degradation (T3 fills the corrections_todo.csv path)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timed_out_decision_returns_degraded_timeout_message(
    tmp_path: Path,
) -> None:
    """timed_out=True → degraded message referencing corrections_todo.csv."""

    decision = _decision(timed_out=True, resumed=None, summary="确认数据平台")
    context = _ctx_with_broker(tmp_path, decision)

    result = await _invoke_tool(context, summary="确认数据平台")

    assert result == (
        "人工修正请求超时（确认数据平台），已记录到 corrections_todo.csv"
    )


@pytest.mark.asyncio
async def test_timeout_message_uses_corrections_path_when_present(
    tmp_path: Path,
) -> None:
    """T3 contract seam: a corrections_path on the decision fills the location."""

    decision = SimpleNamespace(
        request_id="data_correction-run_t2-0",
        summary="确认数据平台",
        timed_out=True,
        resumed=None,
        corrections_path=(
            tmp_path / "tasks" / "task_x" / "artifacts" / "corrections_todo.csv"
        ),
    )
    context = _ctx_with_broker(tmp_path, decision)  # type: ignore[arg-type]

    result = await _invoke_tool(context, summary="确认数据平台")

    assert result == (
        f"人工修正请求超时（确认数据平台），已记录到 "
        f"{tmp_path / 'tasks' / 'task_x' / 'artifacts' / 'corrections_todo.csv'}"
    )


# ---------------------------------------------------------------------------
# missing broker (subagent context)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_broker_returns_failure_message_without_raising(
    tmp_path: Path,
) -> None:
    """No broker installed → clear failure text, NOT an exception."""

    context = RunContext(task_id="task_t2_no_broker", base_dir=tmp_path)

    result = await _invoke_tool(context, summary="确认数据平台")

    assert "request_human_correction 不可用" in result
    assert "broker" in result
    assert "子代理" in result


# ---------------------------------------------------------------------------
# agent registration
# ---------------------------------------------------------------------------


def test_tool_registered_in_agent_tools_with_expected_params() -> None:
    """build_agent registers request_human_correction after run_research_pipeline."""

    from app.agent_loop.agent import build_agent

    build = build_agent(SkillCatalog(), databases=["pubmed", "geo"])
    names = [tool.name for tool in build.agent.tools]

    assert "request_human_correction" in names
    assert names.index("run_research_pipeline") < names.index(
        "request_human_correction"
    )
    assert names.index("request_human_correction") < names.index("read_file")

    tool = next(
        t for t in build.agent.tools if t.name == "request_human_correction"
    )
    params = tool.params_json_schema.get("properties", {})
    assert set(params) == {"summary", "detail", "timeout_seconds"}
    assert params["summary"]["type"] == "string"
    assert "detail" in params
    assert "timeout_seconds" in params
    assert "人工修正" in tool.description
    assert "不要在同一轮内重复调用" in tool.description

    schemas = serialize_function_tool_schemas([tool])
    parsed = json.loads(schemas[0])
    assert parsed["function"]["name"] == "request_human_correction"
    assert parsed["type"] == "function"


# ---------------------------------------------------------------------------
# fixture mode: broker synthetic approval flows through the tool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fixture_mode_returns_synthetic_approval_text(
    tmp_path: Path,
) -> None:
    """Fixture broker auto-approves: the tool returns the synthetic text."""

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    context = RunContext(task_id="task_t2_fixture", base_dir=tmp_path)
    context.bind_main_input_broker(
        MainInputBroker(
            run_id="run_t2_fixture",
            fixture=True,
            emit=emit,
            install_user_input_submitter=lambda submitter: None,
            clear_user_input_submitter=lambda submitter: None,
        )
    )

    started = asyncio.get_running_loop().time()
    result = await _invoke_tool(
        context,
        summary="确认数据平台",
        detail={"field": "platform"},
    )
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.5  # 不阻塞
    assert "用户已确认" in result
    assert "fixture" in result
    assert "platform" in result
    assert any(
        isinstance(p, UserInputRequiredPayload) and p.fixture_exempt
        for p in emitted
    )
    assert any(isinstance(p, UserInputResumedPayload) for p in emitted)
