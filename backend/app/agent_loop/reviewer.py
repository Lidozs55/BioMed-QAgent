"""ReviewerAgent — 策略审查子 Agent。

通过 Agent.as_tool() 暴露给主 Agent，在调用 ``run_research_pipeline``
前主动审查 query log，给出策略建议（哪些 source 已覆盖、哪些 not_found
不应重试、是否需要换关键词）。

project_memory 硬约束："压缩前完整传递 query log 给 ReviewerAgent"。
ReviewerAgent 与 ``compress_query_log`` 解耦——审查在压缩之前发生，
审查结果写入 ``RunContext.query_log_summary``，不会被压缩丢失。
"""
from __future__ import annotations

import json

from agents import Agent, RunContextWrapper
from agents.result import RunResult, RunResultStreaming

from app.agent_loop.context import RunContext
from app.agent_loop.model import LazyDashScopeModel


async def _reviewer_instructions(ctx: RunContextWrapper) -> str:
    """动态指令：从 RunContext 读取完整 query log 并注入子 Agent 上下文。

    project_memory 硬约束："压缩前完整传递 query log 给 ReviewerAgent" —— 这里
    传递的是压缩前的完整 query_log（调用 review_query_strategy 工具的时机由
    主 Agent 决定，INSTRUCTIONS 指导其在 run_research_pipeline 前调用）。
    """
    run_ctx: RunContext = ctx.context
    log_json = json.dumps(run_ctx.query_log, ensure_ascii=False, indent=2)
    return (
        "你是查询策略审查专家（ReviewerAgent）。以下是当前任务的完整查询日志 JSON：\n\n"
        f"{log_json}\n\n"
        "请审查查询策略并给出建议：\n"
        "- 按数据源（source）分组统计查询次数、成功/not_found/失败数\n"
        "- 指出哪些 source 已充分覆盖（有足够 success 记录）\n"
        "- 指出哪些 not_found 查询不应重试（关键词已穷尽或该 source 确无相关数据）\n"
        "- 建议是否需要换关键词、换 source，或已可进入 pipeline 阶段\n"
        "- 输出纯文本，控制在 400 字以内，以「策略审查：」开头"
    )


async def _review_extractor(result: RunResult | RunResultStreaming) -> str:
    """as_tool 的 custom_output_extractor：把审查结果写入 RunContext。

    审查结果**追加**到 ``RunContext.query_log_summary``（不替换），确保
    后续 ``compress_query_log`` 压缩时审查意见保留在 summary 中。

    LLM 返回非字符串或空字符串时抛 ``RuntimeError``，不静默 fallback
    —— 符合"LLM 失败必须抛异常"的硬约束。
    """
    run_ctx: RunContext = result.context_wrapper.context
    raw_output = result.final_output
    if not isinstance(raw_output, str) or not raw_output.strip():
        raise RuntimeError(
            "review_query_strategy LLM returned no usable text; "
            "refusing to silently fallback to a placeholder review"
        )
    review = raw_output.strip()
    if run_ctx.query_log_summary:
        run_ctx.query_log_summary = (
            f"{run_ctx.query_log_summary}\n\n[ReviewerAgent 审查]\n{review}"
        )
    else:
        run_ctx.query_log_summary = f"[ReviewerAgent 审查]\n{review}"
    return f"已写入策略审查到 query_log_summary（{len(review)} 字）。"


def build_review_query_strategy_tool(model: LazyDashScopeModel):
    """构造 review_query_strategy 工具（ReviewerAgent 经 as_tool 包装）。

    主 Agent 在调用 ``run_research_pipeline`` 前应主动调用此工具，
    审查当前 query log 的策略合理性。审查结果写入
    ``RunContext.query_log_summary``，在后续 ``compress_query_log``
    压缩时保留。
    """
    reviewer_agent = Agent(
        name="ReviewerAgent",
        instructions=_reviewer_instructions,
        model=model,
    )
    return reviewer_agent.as_tool(
        tool_name="review_query_strategy",
        tool_description=(
            "审查当前任务的查询日志策略。在调用 run_research_pipeline 前"
            "调用此工具，让 ReviewerAgent 检查 query log 中各数据源的"
            "查询覆盖情况、not_found 记录、是否需要换关键词或换 source。"
            "审查结果会写入 query_log_summary 供后续 compress_query_log 保留。"
            "调用时传入任意非空字符串（如 'review'）即可触发。"
        ),
        custom_output_extractor=_review_extractor,
    )
