"""Tests for TODO §8.4 — Follow-up Loop + ReviewerAgent.

Covers three P0/P1 items:
1. Agent INSTRUCTIONS include follow-up strategy (max 3 rounds, not_found
   not retried).
2. ReviewerAgent implemented as as_tool, reviews query log before pipeline.
3. RunContext exposes ``followup_search_count`` for LLM self-check.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from agents import RunContextWrapper
from app.agent_loop.agent import INSTRUCTIONS
from app.agent_loop.context import RunContext
from app.agent_loop.reviewer import build_review_query_strategy_tool
from app.domain.contracts import QueryStatus

REPO_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------------
# §8.4 P0: Agent INSTRUCTIONS follow-up strategy
# ---------------------------------------------------------------------------


def test_instructions_describe_followup_max_3_rounds() -> None:
    """INSTRUCTIONS must tell the LLM: max 3 follow-up rounds per source."""
    assert "follow-up" in INSTRUCTIONS.lower() or "followup" in INSTRUCTIONS.lower(), (
        "INSTRUCTIONS must mention follow-up strategy"
    )
    assert "3" in INSTRUCTIONS, (
        "INSTRUCTIONS must mention the 3-round follow-up limit"
    )


def test_instructions_tell_llm_not_to_retry_not_found() -> None:
    """INSTRUCTIONS must tell the LLM: failed queries marked not_found are
    not retried (project_memory hard constraint)."""
    instructions_lower = INSTRUCTIONS.lower()
    assert "not_found" in instructions_lower, (
        "INSTRUCTIONS must mention not_found status"
    )
    # Either "不重试" or "not retry" or equivalent.
    assert (
        "不重试" in instructions_lower
        or "不再重试" in instructions_lower
        or "do not retry" in instructions_lower
        or "don't retry" in instructions_lower
    ), (
        "INSTRUCTIONS must explicitly say not_found queries are not retried"
    )


def test_instructions_mention_followup_search_count() -> None:
    """INSTRUCTIONS must mention ``followup_search_count`` so the LLM knows
    it can self-check the follow-up round count via RunContext."""
    assert "followup_search_count" in INSTRUCTIONS, (
        "INSTRUCTIONS must mention followup_search_count for LLM self-check"
    )


# ---------------------------------------------------------------------------
# §8.4 P0: RunContext.followup_search_count
# ---------------------------------------------------------------------------


def test_run_context_has_followup_search_count_field() -> None:
    """RunContext must expose ``followup_search_count`` for LLM self-check."""
    ctx = RunContext(task_id="test_followup_count")
    assert hasattr(ctx, "followup_search_count"), (
        "RunContext must expose followup_search_count"
    )
    assert ctx.followup_search_count == 0, (
        "followup_search_count must default to 0"
    )


def test_log_query_increments_followup_count_on_not_found() -> None:
    """log_query(status=NOT_FOUND) must increment followup_search_count.

    This is the lightweight programmatic support: each failed query
    increments the counter, LLM reads it via RunContext to self-enforce
    the 3-round limit.
    """
    ctx = RunContext(task_id="test_followup_increment")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.NOT_FOUND, 0)
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.NOT_FOUND, 0)
    assert ctx.followup_search_count == 2, (
        f"expected 2 followup searches, got {ctx.followup_search_count}"
    )


def test_log_query_does_not_increment_on_success() -> None:
    """Successful queries must not increment followup_search_count."""
    ctx = RunContext(task_id="test_no_increment")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.SUCCESS, 10)
    assert ctx.followup_search_count == 0


def test_log_query_does_not_increment_on_failed() -> None:
    """Non-not_found failures (e.g. network errors marked FAILED) must not
    increment followup_search_count — they are retried, not follow-up."""
    ctx = RunContext(task_id="test_failed_no_increment")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.FAILED, 0)
    assert ctx.followup_search_count == 0


# ---------------------------------------------------------------------------
# §8.4 P0: ReviewerAgent as_tool
# ---------------------------------------------------------------------------


def test_review_query_strategy_tool_exists() -> None:
    """build_review_query_strategy_tool must return a tool-like object."""
    from app.agent_loop.model import get_model
    tool = build_review_query_strategy_tool(get_model())
    assert hasattr(tool, "name"), "tool must have a name"
    assert tool.name == "review_query_strategy", (
        f"expected tool name 'review_query_strategy', got {tool.name!r}"
    )
    assert hasattr(tool, "description") or hasattr(tool, "tool_description")


def test_review_query_strategy_tool_description_mentions_query_log() -> None:
    """Tool description must mention it reviews the query log."""
    from app.agent_loop.model import get_model
    tool = build_review_query_strategy_tool(get_model())
    desc = getattr(tool, "description", None) or getattr(
        tool, "tool_description", ""
    )
    assert "query" in desc.lower(), (
        f"tool description must mention query log; got: {desc!r}"
    )


@pytest.mark.asyncio
async def test_review_query_strategy_extractor_writes_review_to_context(
    tmp_path: Path,
) -> None:
    """The custom_output_extractor must write the LLM review to
    RunContext.query_log_summary (appending, not replacing) so the review
    is preserved across compress_query_log runs.

    This satisfies the project_memory hard constraint: "压缩前完整传递 query
    log 给 ReviewerAgent" — the review happens BEFORE compression and its
    output is retained.

    Note: ``Agent.as_tool`` wraps ``custom_output_extractor`` into a closure
    inside the returned ``FunctionTool`` — it is not exposed as a public
    attribute. We test the extractor function directly via the module-level
    ``_review_extractor`` to avoid coupling to SDK internals.
    """
    from agents.result import RunResult
    from app.agent_loop.reviewer import _review_extractor

    ctx = RunContext(task_id="test_reviewer")
    ctx.log_query("cancer[title]", "pubmed", QueryStatus.SUCCESS, 5)
    ctx.log_query("cancer[abstract]", "pubmed", QueryStatus.NOT_FOUND, 0)

    # Build a fake RunResult that the extractor can consume.
    fake_result = AsyncMock(spec=RunResult)
    fake_result.context_wrapper = RunContextWrapper(ctx)
    fake_result.final_output = (
        "「策略审查：」pubmed 上 cancer[title] 命中 5 条，已覆盖主题；"
        "cancer[abstract] 零命中，建议不再重试（not_found）。"
    )

    output = await _review_extractor(fake_result)

    assert isinstance(output, str)
    assert len(output) > 0
    # The review text must be retained in query_log_summary.
    assert "策略审查" in ctx.query_log_summary, (
        f"review not written to query_log_summary; got: "
        f"{ctx.query_log_summary!r}"
    )
    assert "[ReviewerAgent 审查]" in ctx.query_log_summary


@pytest.mark.asyncio
async def test_review_extractor_appends_to_existing_summary() -> None:
    """When query_log_summary already has content (e.g. from a previous
    compress_query_log run), the review must be appended, not replace."""
    from agents.result import RunResult
    from app.agent_loop.reviewer import _review_extractor

    ctx = RunContext(task_id="test_append")
    ctx.query_log_summary = "[后续摘要]\n之前压缩过的摘要内容"

    fake_result = AsyncMock(spec=RunResult)
    fake_result.context_wrapper = RunContextWrapper(ctx)
    fake_result.final_output = "「策略审查：」新审查意见"

    await _review_extractor(fake_result)

    assert "[后续摘要]" in ctx.query_log_summary, (
        "existing summary must be preserved"
    )
    assert "[ReviewerAgent 审查]" in ctx.query_log_summary, (
        "new review must be appended"
    )
    assert "新审查意见" in ctx.query_log_summary


@pytest.mark.asyncio
async def test_review_extractor_raises_on_empty_llm_output() -> None:
    """LLM returning empty string must raise RuntimeError, not silently
    fallback — satisfies project_memory hard constraint."""
    from agents.result import RunResult
    from app.agent_loop.reviewer import _review_extractor

    ctx = RunContext(task_id="test_empty")
    fake_result = AsyncMock(spec=RunResult)
    fake_result.context_wrapper = RunContextWrapper(ctx)
    fake_result.final_output = ""

    with pytest.raises(RuntimeError, match="no usable text"):
        await _review_extractor(fake_result)


# ---------------------------------------------------------------------------
# §8.4 P1: Agent loop turn counter (follow-up count guard)
# ---------------------------------------------------------------------------


def test_run_context_followup_search_count_is_per_source() -> None:
    """followup_search_count tracks per-source consecutive not_found.

    When a different source succeeds, the counter resets for that source.
    This matches the TODO: "失败查询标记 not_found 不重试" — each source
    has its own follow-up budget.
    """
    ctx = RunContext(task_id="test_per_source")
    # pubmed not_found × 2
    ctx.log_query("q1", "pubmed", QueryStatus.NOT_FOUND, 0)
    ctx.log_query("q2", "pubmed", QueryStatus.NOT_FOUND, 0)
    assert ctx.followup_search_count == 2
    # geo success — should NOT reset pubmed's counter (separate sources)
    ctx.log_query("q3", "geo", QueryStatus.SUCCESS, 10)
    assert ctx.followup_search_count == 2, (
        "geo success must not reset pubmed's followup count"
    )
    # pubmed not_found again — should increment to 3
    ctx.log_query("q4", "pubmed", QueryStatus.NOT_FOUND, 0)
    assert ctx.followup_search_count == 3
