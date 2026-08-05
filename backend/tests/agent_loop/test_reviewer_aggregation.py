"""Tests for TODO §4.6 — 覆盖率确定性统计（reviewer 前置数据供给）。

REVIEW §7.1（0805 复核）: ReviewerAgent 现为纯 LLM 统计 query_log（大数
统计是 LLM 幻觉高发区）；确定性聚合应作为 reviewer 的前置数据供给注入，
而非让 LLM 自行计数。
"""
from __future__ import annotations

import asyncio
import json

from agents import RunContextWrapper
from app.agent_loop.context import RunContext
from app.agent_loop.reviewer import (
    _reviewer_instructions,
    aggregate_query_log_by_source,
)
from app.domain.contracts import QueryStatus

# ---------------------------------------------------------------------------
# 确定性聚合纯函数
# ---------------------------------------------------------------------------


def test_aggregate_empty_query_log_returns_empty() -> None:
    """空 query_log 必须返回空聚合（不产生幻影 source）。"""
    assert aggregate_query_log_by_source([]) == {}


def test_aggregate_counts_statuses_per_source() -> None:
    """按 source 分组统计 total/success/not_found/failed/skipped/page_fallback。"""
    query_log = [
        {"query": "a", "source": "pubmed", "status": "success", "records_count": 5},
        {"query": "b", "source": "pubmed", "status": "not_found", "records_count": 0},
        {"query": "c", "source": "geo", "status": "success", "records_count": 12},
        {"query": "d", "source": "geo", "status": "failed", "records_count": 0},
        {"query": "e", "source": "geo", "status": "skipped", "records_count": 0},
    ]
    assert aggregate_query_log_by_source(query_log) == {
        "pubmed": {
            "total": 2,
            "success": 1,
            "not_found": 1,
            "failed": 0,
            "skipped": 0,
            "page_fallback": 0,
            "records": 5,
        },
        "geo": {
            "total": 3,
            "success": 1,
            "not_found": 0,
            "failed": 1,
            "skipped": 1,
            "page_fallback": 0,
            "records": 12,
        },
    }


def test_aggregate_sums_records_count() -> None:
    """records 必须为各条 records_count 之和（success 才有非零值）。"""
    query_log = [
        {"query": "a", "source": "geo", "status": "success", "records_count": 3},
        {"query": "b", "source": "geo", "status": "success", "records_count": 7},
        {"query": "c", "source": "geo", "status": "not_found", "records_count": 0},
    ]
    agg = aggregate_query_log_by_source(query_log)["geo"]
    assert agg["records"] == 10
    assert agg["total"] == 3
    assert agg["success"] == 2


def test_aggregate_accepts_run_context_query_log_entries() -> None:
    """RunContext.log_query 产出的 query_log 必须可直接喂给聚合函数
    （status 已是 QueryStatus 字符串化后的值）。"""
    ctx = RunContext(task_id="test_agg_ctx")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.SUCCESS, 5)
    ctx.log_query("cancer[abstract]", "pubmed", QueryStatus.NOT_FOUND, 0)
    ctx.log_query("pdac", "geo", QueryStatus.FAILED, 0)
    agg = aggregate_query_log_by_source(ctx.query_log)
    assert agg["pubmed"] == {
        "total": 2,
        "success": 1,
        "not_found": 1,
        "failed": 0,
        "skipped": 0,
        "page_fallback": 0,
        "records": 5,
    }
    assert agg["geo"]["total"] == 1
    assert agg["geo"]["failed"] == 1


# ---------------------------------------------------------------------------
# reviewer instructions 注入确定性聚合
# ---------------------------------------------------------------------------


def test_reviewer_instructions_inject_deterministic_aggregation() -> None:
    """_reviewer_instructions 必须把确定性聚合结果注入给 ReviewerAgent，
    而不是只给完整 query_log 让 LLM 自行统计。

    agent 参数在 _reviewer_instructions 中未被使用（只读 ctx.context），
    此处传 None 仅作占位。
    """
    ctx = RunContext(task_id="test_agg_inject")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.SUCCESS, 5)
    ctx.log_query("cancer[abstract]", "pubmed", QueryStatus.NOT_FOUND, 0)
    ctx.log_query("pdac", "geo", QueryStatus.SUCCESS, 12)

    wrapper = RunContextWrapper(context=ctx)
    instructions = asyncio.run(_reviewer_instructions(wrapper, None))  # type: ignore[arg-type]

    # 注入的确定性统计必须包含按 source 的精确聚合结果（indent=2 与实现一致）
    assert "确定性统计" in instructions
    agg = aggregate_query_log_by_source(ctx.query_log)
    assert json.dumps(agg, ensure_ascii=False, indent=2) in instructions
    # 引导 LLM 直接引用统计、不要自行重新计数
    assert "不要自行重新计数" in instructions or "直接引用" in instructions
