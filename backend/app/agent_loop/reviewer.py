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

    滚动合并（docs/REVIEW_2026-07-31 §4.3 C2）：审查结果**替换**旧的
    审查块，保留所有压缩摘要（``[后续摘要]``）部分，避免长跑后审查意见
    无限累积、且不丢失已压缩的检索历史（审查与压缩可能交错发生）。

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
    # 滚动合并：去掉所有旧 [ReviewerAgent 审查] 块，保留压缩摘要前缀与
    # 任何 [后续摘要] 压缩块（含其正文），再追加最新一条审查。
    marker = "[ReviewerAgent 审查]"
    kept: list[str] = []
    blocks = run_ctx.query_log_summary.split(marker)
    for index, block in enumerate(blocks):
        stripped = block.strip()
        if not stripped:
            continue
        # 块内若含 [后续摘要] 行，从该行起保留到块尾（压缩正文可多行）
        lines = stripped.splitlines()
        summary_start = next(
            (i for i, line in enumerate(lines) if line.startswith("[后续摘要]")),
            None,
        )
        if summary_start is not None:
            kept.append("\n".join(lines[summary_start:]))
        elif index == 0:
            # 仅首个 marker 之前的段可以是压缩摘要前缀；review-only 摘要
            # （第一个 marker 前为空）不会把旧审查文本误当前缀保留。
            kept.append(stripped)
    parts = [part for part in (*kept, f"{marker}\n{review}") if part]
    run_ctx.query_log_summary = "\n\n".join(parts)
    return f"已写入策略审查到 query_log_summary（{len(review)} 字，滚动合并）。"


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
        model_settings=model.model_settings,
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
