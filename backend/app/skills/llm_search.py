"""Hybrid skill retrieval: lexical baseline + optional LLM reranking.

The catalog is small (15 builtin skills, ~1.5-2K tokens for the full
manifest), so the LLM path is a single classification call: feed the whole
authorized candidate list and ask the fast model for a JSON top-k. Any model
failure (offline, timeout, bad JSON, hallucinated names) falls back to the
lexical result — the strategy never raises and never blocks discovery.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any, Protocol

from app.agent_loop.model import (
    build_openai_client,
    require_model_credentials,
)
from app.model_config import RunModelSettings
from app.skills.catalog import SkillDescriptor
from app.skills.search import (
    LexicalSkillSearchStrategy,
    SkillSearchStrategy,
    normalize_skill_search_text,
)

_DEFAULT_MODEL = "qwen-flash"
_DEFAULT_TIMEOUT = 5.0
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class _ModelRanker(Protocol):
    async def __call__(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        ...


def _build_catalog_prompt(
    candidates: Sequence[SkillDescriptor],
    text: str,
) -> str:
    lines = [
        "你是技能检索器。根据用户的能力描述，从下列技能中选出最匹配的，按相关度从高到低返回 JSON：",
        '{"skills": ["技能名", ...]}',
        "只允许输出候选列表中的技能名，最多 5 个；若都不匹配返回 {\"skills\": []}。",
        "",
        f"用户能力描述：{text}",
        "",
        "候选技能：",
    ]
    for i, d in enumerate(candidates, start=1):
        lines.append(
            f"{i}. {d.name} — {d.display_name} [{d.category.value}] "
            f"sources={','.join(d.supported_sources) or 'none'} — {d.description}"
        )
    return "\n".join(lines)


def _parse_ranking_response(raw: str, valid_names: set[str]) -> tuple[str, ...]:
    """Extract skill names from the model's JSON response; drop any name not
    in ``valid_names`` (anti-hallucination). Returns () on parse failure."""
    if not raw.strip():
        return ()
    match = _JSON_BLOCK_RE.search(raw)
    candidate_text = match.group(1) if match else raw
    try:
        payload = json.loads(candidate_text)
    except (json.JSONDecodeError, TypeError):
        return ()
    names: Any
    if isinstance(payload, dict):
        names = payload.get("skills")
    elif isinstance(payload, list):
        names = payload
    else:
        return ()
    if not isinstance(names, list):
        return ()
    return tuple(
        dict.fromkeys(  # dedupe, preserve order
            str(name).strip() for name in names if str(name).strip() in valid_names
        )
    )


class LLMRerankingSkillSearchStrategy:
    """Lexical search with optional LLM rerank for empty/ambiguous results.

    ``search`` is a sync bridge to the lexical baseline (sync callers get
    deterministic output). ``search_async`` is the production path dispatched
    by the gateway: it runs lexical first, skips the model entirely on an
    exact identity/source hit, and only then ranks with the fast model;
    any model failure falls back to the lexical result.
    """

    def __init__(
        self,
        lexical: SkillSearchStrategy | None = None,
        model_name: str = _DEFAULT_MODEL,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> None:
        self._lexical = lexical if lexical is not None else LexicalSkillSearchStrategy()
        self._model_name = model_name
        self._timeout = timeout
        self._model_ranker: _ModelRanker = self._default_ranker

    async def _default_ranker(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        require_model_credentials(model_settings)
        client = build_openai_client(model_settings, max_retries=0)
        try:
            response = await client.chat.completions.create(
                model=self._model_name,
                messages=[
                    {"role": "system", "content": "你是技能检索器，严格输出 JSON。"},
                    {"role": "user", "content": _build_catalog_prompt(candidates, text)},
                ],
                temperature=0.0,
                timeout=self._timeout,
            )
            raw = response.choices[0].message.content or ""
        finally:
            await client.close()
        valid_names = {d.name for d in candidates}
        ranked_names = _parse_ranking_response(raw, valid_names)
        by_name = {d.name: d for d in candidates}
        return tuple(by_name[name] for name in ranked_names)

    def search(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
    ) -> tuple[SkillDescriptor, ...]:
        """Sync bridge: delegate to the lexical baseline.

        The LLM path needs model settings and is async; the gateway
        dispatches ``search_async`` when available (production path).
        """
        return self._lexical.search(candidates, text)

    async def search_async(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
        model_settings: RunModelSettings,
    ) -> tuple[SkillDescriptor, ...]:
        lexical_result = self._lexical.search(candidates, text)
        if not candidates:
            return lexical_result
        if not text.strip():
            return lexical_result
        if len(lexical_result) == len(candidates):
            # lexical already returns every candidate (e.g. stop-word-only
            # query): reranking would be a no-op, skip the model call
            return lexical_result
        if self._has_exact_identity(lexical_result, text):
            # exact identity/source hit: lexical is authoritative, skip model
            return lexical_result
        try:
            reranked = await self._model_ranker(candidates, text, model_settings)
        except Exception:  # noqa: BLE001 — never let model failure break discovery
            return lexical_result
        if not reranked:
            return lexical_result
        # model result takes precedence only if non-empty; lexical fills tail
        ranked_names = {d.name for d in reranked}
        tail = tuple(d for d in lexical_result if d.name not in ranked_names)
        return reranked + tail

    @staticmethod
    def _has_exact_identity(
        lexical_result: Sequence[SkillDescriptor],
        text: str,
    ) -> bool:
        """True when the lexical result contains an exact name or source match.

        Also matches individual query tokens (length >= 3) against skill
        names/sources, so stop-word-padded queries like "search pubmed" are
        treated as exact identity hits without invoking the LLM reranker.
        """
        normalized = normalize_skill_search_text(text)
        tokens = [t for t in normalized.split() if len(t) >= 3]

        def _matches(candidate: str) -> bool:
            return any(
                normalize_skill_search_text(d.name) == candidate
                or candidate in {
                    normalize_skill_search_text(s) for s in d.supported_sources
                }
                for d in lexical_result
            )

        if _matches(normalized):
            return True
        return any(_matches(token) for token in tokens)
