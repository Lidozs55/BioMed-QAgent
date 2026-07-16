"""上下文管理子 Agent — 通过 Agent.as_tool() 暴露给主 Agent。

首个能力：查询日志压缩。复用 SDK 内置 loop 完成摘要推理，
custom_output_extractor 通过 result.context_wrapper.context 访问 RunContext，
把摘要写回 RunContext。

未来扩展：同一子 Agent 体系可增加压缩 records/warnings、
注入背景知识等上下文管理能力。
"""
from __future__ import annotations

import json

from agents import Agent, RunContextWrapper
from agents.result import RunResult, RunResultStreaming

from app.agent_loop.context import RunContext
from app.agent_loop.model import get_model

KEEP_RECENT = 5  # 压缩时保留的最近查询条数
COMPRESS_THRESHOLD_CHARS = 8000  # 触发压缩的字符数阈值（约 2000 token）


async def _summarizer_instructions(ctx: RunContextWrapper) -> str:
    """动态指令：从 RunContext 读取 query_log 并注入子 Agent 上下文。"""
    run_ctx: RunContext = ctx.context
    log_json = json.dumps(run_ctx.query_log, ensure_ascii=False, indent=2)
    return (
        "你是查询日志压缩专家。以下是当前任务的查询日志 JSON：\n\n"
        f"{log_json}\n\n"
        "请生成紧凑摘要：\n"
        "- 按数据源（source）分组统计查询次数、成功/失败数\n"
        "- 保留关键查询式和命中记录数（records_count）\n"
        "- 丢弃重复或无效查询\n"
        "- 输出纯文本，控制在 300 字以内"
    )


_context_manager_agent = Agent(
    name="ContextManager",
    instructions=_summarizer_instructions,
    model=get_model(),
)


async def _compress_extractor(result: RunResult | RunResultStreaming) -> str:
    """as_tool 的 custom_output_extractor：把摘要写回 RunContext。

    通过 result.context_wrapper.context 访问共享的 RunContext，
    用子 Agent 生成的摘要替换旧查询记录。
    """
    run_ctx: RunContext = result.context_wrapper.context
    summary = str(result.final_output)
    compressed = run_ctx.compress_log(keep_recent=KEEP_RECENT, summary=summary)
    if compressed == 0:
        return f"当前仅 {len(run_ctx.query_log)} 条查询记录，无需压缩。"
    return (
        f"已压缩 {compressed} 条旧查询记录为摘要（{len(summary)} 字）。"
        f"保留最近 {KEEP_RECENT} 条完整记录。"
    )


def build_compress_query_log_tool():
    """构造 compress_query_log 工具（ContextManager Agent 经 as_tool 包装）。"""
    return _context_manager_agent.as_tool(
        tool_name="compress_query_log",
        tool_description=(
            "压缩查询日志历史。当本次任务的查询日志累计较长（超过约 8000 字符）时调用此工具，"
            "将较早的查询记录压缩为摘要以控制上下文体积。"
            "调用时传入任意非空字符串（如 'compress'）即可触发。"
        ),
        custom_output_extractor=_compress_extractor,
    )
