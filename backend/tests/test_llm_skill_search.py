"""Deterministic tests for the LLM reranking strategy (model calls mocked)."""

from __future__ import annotations

from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import app.skills.llm_search as llm_search_module
import pytest
from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext
from app.model_config import RunModelSettings, UserSettings
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


def test_parse_ranking_response_strips_code_fence() -> None:
    assert _parse_ranking_response('```json\n{"skills": ["geo"]}\n```', {"geo"}) == ("geo",)


def test_parse_ranking_response_dedupes_names() -> None:
    assert _parse_ranking_response(
        '{"skills": ["geo", "geo", "xena"]}', {"geo", "xena"}
    ) == ("geo", "xena")


@pytest.mark.asyncio
async def test_default_ranker_uses_pinned_shared_client_and_closes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    geo = _descriptor("geo", "GEO datasets.", sources=["geo"])
    settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="https://provider.example/v1",
            context_window=65_536,
        )
    )
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content='{"skills": ["geo"]}')
                )
            ]
        )
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    client_builder = Mock(return_value=client)
    monkeypatch.setattr(
        llm_search_module,
        "build_openai_client",
        client_builder,
    )

    result = await LLMRerankingSkillSearchStrategy()._default_ranker(
        (geo,),
        "gene expression",
        settings,
    )

    assert result == (geo,)
    client_builder.assert_called_once_with(settings, max_retries=0)
    client.close.assert_awaited_once_with()


def test_empty_text_fastpath_returns_all_candidates_no_model() -> None:
    strategy = LLMRerankingSkillSearchStrategy()
    first = _descriptor("first", "First capability.", sources=["first"])
    second = _descriptor("second", "Second capability.", sources=["second"])
    assert strategy.search((first, second), "") == (first, second)


class _SpyRanker:
    """Record whether the model ranker was invoked; optionally return a
    fixed subset instead of all candidates."""

    def __init__(
        self, result: Sequence[SkillDescriptor] | None = None
    ) -> None:
        self.calls: list[tuple[Sequence[SkillDescriptor], str]] = []
        self._result = tuple(result) if result is not None else None

    async def __call__(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        self.calls.append((candidates, text))
        return self._result if self._result is not None else tuple(candidates)


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
    strategy._model_ranker = spy
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
async def test_search_async_stopword_padded_exact_hit_skips_model_call() -> None:
    """"search pubmed" should be treated as an exact identity hit on the
    pubmed skill (token "pubmed" matches the skill name), so the LLM
    reranker must not be invoked — otherwise it may reorder pubchem/geo
    ahead of pubmed."""
    spy = _SpyRanker()
    strategy = LLMRerankingSkillSearchStrategy()
    strategy._model_ranker = spy
    pubmed = _descriptor("pubmed", "Search biomedical literature.", sources=["pubmed"])
    pubchem = _descriptor(
        "pubchem", "Search chemical compounds.", sources=["pubchem"]
    )
    geo = _descriptor("geo", "GEO datasets.", sources=["geo"])

    result = await strategy.search_async(
        (pubchem, geo, pubmed),
        "search pubmed",
        RunModelSettings.default(),
    )

    assert [d.name for d in result] == ["pubmed"]
    assert spy.calls == []


@pytest.mark.asyncio
async def test_search_async_model_failure_falls_back_to_lexical() -> None:
    """ranker raises -> return the lexical result, never raise."""
    strategy = LLMRerankingSkillSearchStrategy()
    strategy._model_ranker = _FailingRanker()
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


@pytest.mark.asyncio
async def test_search_async_reranked_takes_precedence_lexical_fills_tail() -> None:
    """model returns a proper subset -> reranked names first (model
    precedence), lexical-only hits fill the tail, no duplicates."""
    pubmed = _descriptor("pubmed", "Search biomedical literature.", sources=["pubmed"])
    geo = _descriptor("geo", "GEO datasets.", sources=["geo"])
    spy = _SpyRanker(result=(geo,))
    strategy = LLMRerankingSkillSearchStrategy()
    strategy._model_ranker = spy

    # "literature" hits only pubmed lexically; the model overrides with geo
    result = await strategy.search_async(
        (pubmed, geo),
        "literature",
        RunModelSettings.default(),
    )
    assert [d.name for d in result] == ["geo", "pubmed"]
    assert spy.calls == [((pubmed, geo), "literature")]

    # empty text short-circuits before the model: all candidates, zero calls
    spy.calls.clear()
    result = await strategy.search_async(
        (pubmed, geo),
        "",
        RunModelSettings.default(),
    )
    assert [d.name for d in result] == ["pubmed", "geo"]
    assert spy.calls == []
