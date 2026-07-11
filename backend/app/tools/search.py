"""文献检索工具 — 占位，数据获取接口暂缓实现。

context 参数为 RunContextWrapper，由 SDK 自动注入，不暴露给 LLM。
"""
from __future__ import annotations

from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext


@function_tool
def search_literature(ctx: RunContextWrapper[Any], query: str, max_results: int = 20) -> str:
    """检索生物医学文献，返回标题+摘要+来源信息的 JSON 字符串。

    Args:
        query: 检索词（基因/疾病/药物/通路等）
        max_results: 最大返回条数
    """
    run_ctx: RunContext = ctx.context
    # 记录查询日志
    run_ctx.query_log.append({
        "query": query,
        "source": "placeholder",
        "status": "not_implemented",
        "records_count": 0,
    })
    # 接口暂缓实现
    return '{"records": [], "note": "文献检索接口待实现 — 当前为占位返回"}'
