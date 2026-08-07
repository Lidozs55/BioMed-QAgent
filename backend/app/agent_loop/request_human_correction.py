"""``request_human_correction`` FunctionTool — 主 Run 人类在环（Phase 4c, T2）。

对应 docs/archive/superpowers/specs/2026-08-07-phase4c-hil-correction-design.md
§3-D2 / §4-T2：Agent 遇到真正需要人类决策/澄清的场景（数据源选择歧义、参数
确认、候选 GSE 无法判断等）时，调用本工具暂停 Run，经 runner 安装的
``MainInputBroker`` 请求人工修正，并把人类答复（approve/reject + detail）的
文本摘要返回给 Agent 继续执行。

返回语义：

- 已答复：``用户已确认：<correction>`` / ``用户已拒绝并继续：<correction>``；
  无 ``correction`` 字段时退化为决策动词 + 其余 detail（不丢人类答复）；
- 超时：降级消息 ``人工修正请求超时（<summary>），已记录到
  corrections_todo.csv``——broker（T3）在 ``MainInputDecision.corrections_path``
  上提供完整落盘路径（Path 字段，非空时消息携带完整位置，否则退化为
  文件名占位）。
- broker 未安装（子代理/单元测试上下文）：返回明确的失败文本而非向 SDK
  抛异常，Agent 据此自行判断继续；取消（``CompactionCancelledError``）保持
  原样向上传播，不吞掉取消语义。

fixture 模式：broker 侧已自动合成 approve（T1），本工具仅透传合成文本。
"""

from __future__ import annotations

import json

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import (
    MainInputBrokerUnavailableError,
    RunContext,
)
from app.agent_loop.main_input_broker import MainInputDecision
from app.runtime.compaction import CompactionCancelledError

# T3 契约：超时待办写入任务 artifacts 目录的 corrections_todo.csv，并在
# MainInputDecision 上提供 corrections_path 字段；T2 在字段缺失时退化为
# 文件名占位，T3 补上字段后消息自动携带完整位置。
_CORRECTIONS_TODO_FILENAME = "corrections_todo.csv"

# D3 (Phase 4 review): the model-controlled timeout override must be a
# finite value in [1, MAX]; anything else is rejected at the tool entry with
# agent-facing failure text (never a Run failure or an immediate expiry).
_MIN_TIMEOUT_SECONDS = 1.0
_MAX_TIMEOUT_SECONDS = 3600.0

_DESCRIPTION = (
    "请求人类人工修正：暂停当前 Run，向用户弹出修正对话框并等待人工答复，"
    "返回人类决策（approve/reject + 修正内容）的文本摘要，Agent 据此继续。"
    "仅在真正需要人类决策/澄清时才调用——例如数据源选择歧义、参数确认、"
    "候选 GSE 无法判断是否匹配主题等场景；不要在同一轮内重复调用（调用后"
    "等待人类答复再继续）。summary 是向人类提出的修正问题；detail 可携带"
    "待修正字段/建议选项/上下文；timeout_seconds 覆盖运行级超时（默认由运行"
    "配置决定）。人类在超时前未答复时返回降级提示，请求已记录到 "
    "corrections_todo.csv。"
)


def _is_valid_timeout(timeout_seconds: float) -> bool:
    """True when *timeout_seconds* is a finite value within [1, MAX] (D3)."""

    try:
        return _MIN_TIMEOUT_SECONDS <= float(timeout_seconds) <= _MAX_TIMEOUT_SECONDS
    except (TypeError, ValueError, OverflowError):
        return False


def _format_resumed_text(decision: MainInputDecision) -> str:
    """Serialize an answered request into agent-facing human decision text."""

    resumed = decision.resumed
    if resumed is None:
        raise RuntimeError("resumed decision expected when not timed out")
    prefix = (
        "用户已确认" if resumed.decision == "approve" else "用户已拒绝并继续"
    )
    correction = resumed.detail.get("correction")
    if correction:
        return f"{prefix}：{correction}"
    if resumed.detail:
        return f"{prefix}：{json.dumps(resumed.detail, ensure_ascii=False)}"
    return prefix


def _format_timeout_text(decision: MainInputDecision) -> str:
    """Build the degraded timeout message carrying the full CSV path (T3)."""

    path = decision.corrections_path
    location = str(path) if path is not None else _CORRECTIONS_TODO_FILENAME
    return f"人工修正请求超时（{decision.summary}），已记录到 {location}"


@function_tool(
    name_override="request_human_correction",
    description_override=_DESCRIPTION,
    strict_mode=False,
)
async def request_human_correction(
    ctx: RunContextWrapper[RunContext],
    summary: str,
    detail: dict[str, object] | None = None,
    timeout_seconds: float | None = None,
) -> str:
    """Pause the main Run for a human data-correction decision.

    ``summary`` is the question/clarification presented to the human;
    ``detail`` optionally carries the fields to fix, suggested options, or
    context; ``timeout_seconds`` overrides the run-level HIL timeout and must
    be a finite value in [1, 3600]. Returns the human decision text
    (approve/reject + detail), a degraded timeout message when nobody
    answered, or a clear failure text when the broker is not installed
    (subagent contexts). Cancellation while paused propagates.
    """

    if timeout_seconds is not None and not _is_valid_timeout(timeout_seconds):
        return (
            f"request_human_correction 参数无效：timeout_seconds 必须是 "
            f"[{_MIN_TIMEOUT_SECONDS:.0f}, {_MAX_TIMEOUT_SECONDS:.0f}] 范围内"
            "的有限数值（收到 "
            f"{timeout_seconds!r}）。请修正参数后重试，或省略该参数使用默认超时。"
        )

    try:
        decision = await ctx.context.request_main_input(
            summary=summary,
            detail=detail,
            timeout_seconds=timeout_seconds,
        )
    except CompactionCancelledError:
        raise
    except MainInputBrokerUnavailableError as exc:
        # FIX 1 (final review): only the missing-broker case degrades to a
        # failure message. Broker, event-persistence, duplicate-request, and
        # resume-emission failures are real runtime errors — they propagate
        # so the HIL request (and the Run) fails instead of silently
        # continuing without a valid HIL event chain.
        return (
            "request_human_correction 不可用：主 Run 未安装人工输入 broker"
            f"（详情：{exc}）。当前上下文可能为子代理或单元测试环境，无法"
            "暂停 Run 等待人工修正——请基于已有证据自行判断并继续执行。"
        )
    if decision.timed_out:
        return _format_timeout_text(decision)
    return _format_resumed_text(decision)
