"""Deterministic tests for the LLM reranking strategy (model calls mocked)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext
from app.model_config import RunModelSettings
from app.skills.catalog import SkillDescriptor
from app.skills.llm_search import (
    LLMRerankingSkillSearchStrategy,
    _parse_ranking_response,
)
from app.skills.registry import SkillCategory, SkillDef


@function_tool
async def demo_operation(
    ctx: RunContextWrapper[RunContext],
) -> dict[str, Any]:
    """Return deterministic test data."""
    return {"task_id": ctx.context.task_id}


def _descriptor(name: str, description: str, *, sources: list[str]) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name=name,
            category=SkillCategory.ACQUISITION,
            description=description,
            supported_sources=sources,
            tools=[demo_operation],
        ),
    )


def test_parse_ranking_response_keeps_only_valid_names() -> None:
    raw = '{"skills": ["pubmed", "ghost_skill", "pdb"]}'
    assert _parse_ranking_response(raw, {"pubmed", "pdb"}) == ("pubmed", "pdb")


def test_parse_ranking_response_handles_bare_list_and_garbage() -> None:
    assert _parse_ranking_response('["geo", "xena"]', {"geo", "xena"}) == ("geo", "xena")
    assert _parse_ranking_response("not json at all", {"geo"}) == ()
    assert _parse_ranking_response("", {"geo"}) == ()


def test_empty_text_fastpath_returns_all_candidates_no_model() -> None:
    strategy = LLMRerankingSkillSearchStrategy()
    first = _descriptor("first", "First capability.", sources=["first"])
    second = _descriptor("second", "Second capability.", sources=["second"])
    assert strategy.search((first, second), "") == (first, second)


class _SpyRanker:
    """Record whether the model ranker was invoked (zero-call assertion)."""

    def __init__(self) -> None:
        self.calls: list[tuple[Sequence[SkillDescriptor], str]] = []

    async def __call__(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        self.calls.append((candidates, text))
        return tuple(candidates)


class _FailingRanker:
    """Simulate an offline model: must never break discovery."""

    async def __call__(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        raise RuntimeError("offline")


@pytest.mark.asyncio
async def test_search_async_exact_hit_skips_model_call() -> None:
    """exact-identity hit -> the model ranker must never be invoked
    (production path is search_async, so this guards real cost)."""
    spy = _SpyRanker()
    strategy = LLMRerankingSkillSearchStrategy()
    strategy._model_ranker = spy  # type: ignore[attr-defined]
    pubmed = _descriptor("pubmed", "Search biomedical literature.", sources=["pubmed"])
    geo = _descriptor("geo", "GEO datasets.", sources=["geo"])

    result = await strategy.search_async(
        (geo, pubmed),
        "pubmed",
        RunModelSettings.default(),
    )

    # real LexicalSkillSearchStrategy drops non-matching candidates, so the
    # exact-hit result is (pubmed,) — the zero-call assertion below is the
    # actual contract of this test
    assert [d.name for d in result] == ["pubmed"]
    assert spy.calls == []


@pytest.mark.asyncio
async def test_search_async_model_failure_falls_back_to_lexical() -> None:
    """ranker raises -> return the lexical result, never raise."""
    strategy = LLMRerankingSkillSearchStrategy()
    strategy._model_ranker = _FailingRanker()  # type: ignore[attr-defined]
    pubmed = _descriptor("pubmed", "Search biomedical literature.", sources=["pubmed"])
    geo = _descriptor("geo", "GEO datasets.", sources=["geo"])

    # no lexical hit for "gene expression" against these two -> model called
    # -> fails -> falls back to the empty lexical result
    result = await strategy.search_async(
        (pubmed, geo),
        "gene expression",
        RunModelSettings.default(),
    )

    assert result == ()
