"""SkillRetriever — keyword/tag-based skill retrieval with optional LLM re-rank.

Primary: tokenize query → score each skill on name/description/tag overlap → top_k.
Optional: LLM re-rank via DashScopeClient.chat_json().
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.skills.manifest import SkillManifest

logger = logging.getLogger(__name__)

# ── 停用词 ─────────────────────────────────────────────────────────
_STOPWORDS: frozenset = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "for", "and", "nor",
    "but", "or", "yet", "so", "at", "by", "in", "of", "on", "to", "with",
    "from", "about", "into", "through", "during", "before", "after",
    "above", "below", "between", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "not",
    "only", "own", "same", "so", "than", "too", "very", "just", "because",
    "as", "until", "while", "if", "find", "get", "me", "my", "i", "you",
    "use", "using", "that", "this", "what", "which", "it",
})

# ── 分词 ───────────────────────────────────────────────────────────
_SPLIT_RE = re.compile(r"[^a-zA-Z0-9]+")


class SkillRetriever:
    """Keyword/tag-based skill retrieval with optional LLM re-rank.

    Primary: tokenize query → score each skill on name/description/tag overlap → top_k.
    Optional: LLM re-rank via DashScopeClient.chat_json().
    """

    # ── 公开 API ───────────────────────────────────────────────

    @classmethod
    def retrieve(
        cls,
        query: str,
        top_k: int = 10,
        use_llm: bool = False,
        category: str | None = None,
        registry=None,
    ) -> list[SkillManifest]:
        """Retrieve top_k matching SkillManifest entries.

        Args:
            query: Natural-language search query.
            top_k: Maximum number of results to return.
            use_llm: If True, re-rank top 2*top_k keyword results via LLM.
            category: Optional category filter.
            registry: SkillRegistry class; defaults to app.skills.registry.SkillRegistry.

        Returns:
            Ranked list of SkillManifest entries.
        """
        if registry is None:
            from app.skills.registry import SkillRegistry
            registry = SkillRegistry

        candidates = registry.list_skills(category=category)
        if not candidates:
            return []

        query_tokens = cls._tokenize(query)

        scored: list[tuple[float, SkillManifest]] = []
        for m in candidates:
            score = cls._score(m, query_tokens)
            if score > 0:
                scored.append((score, m))

        # 按分数降序
        scored.sort(key=lambda x: x[0], reverse=True)

        pool = [m for _, m in scored[: top_k * 2]] if use_llm else [m for _, m in scored[:top_k]]

        if use_llm and pool:
            try:
                return cls._llm_rerank(query, pool, top_k)
            except Exception:
                logger.warning("LLM re-rank 失败，回退到关键词排序", exc_info=True)
                return pool[:top_k]

        return pool[:top_k]

    # ── 分词 ───────────────────────────────────────────────────

    @classmethod
    def _tokenize(cls, text: str) -> set[str]:
        """Lowercase, split on whitespace/punctuation, filter stopwords.

        Returns a set of meaningful tokens.
        """
        return {
            tok for tok in _SPLIT_RE.split(text.lower()) if tok and tok not in _STOPWORDS
        }

    # ── 评分 ───────────────────────────────────────────────────

    @classmethod
    def _score(cls, manifest: SkillManifest, query_tokens: set[str]) -> float:
        """Score manifest vs query tokens.

        - exact skill_id match → +10  (if any query token equals skill_id)
        - name token overlap → +3 per token
        - description token overlap → +1 per token
        - tag overlap → +2 per tag
        """
        score: float = 0.0

        # exact skill_id match
        if manifest.skill_id in query_tokens:
            score += 10.0

        # name overlap
        name_tokens = cls._tokenize(manifest.name)
        score += 3.0 * len(name_tokens & query_tokens)

        # description overlap
        desc_tokens = cls._tokenize(manifest.description)
        score += 1.0 * len(desc_tokens & query_tokens)

        # tag overlap
        tag_tokens = set(manifest.tags)
        score += 2.0 * len(tag_tokens & query_tokens)

        return score

    # ── LLM 重排序 ─────────────────────────────────────────────

    @classmethod
    def _llm_rerank(
        cls,
        query: str,
        candidates: list[SkillManifest],
        top_k: int,
    ) -> list[SkillManifest]:
        """LLM re-rank via DashScopeClient.chat_json().

        System prompt asks LLM to rank skills by relevance to query.
        Falls back to original order on failure.
        """
        from app.llm.client import DashScopeClient

        # 构建候选列表文本
        lines: list[str] = []
        for i, m in enumerate(candidates):
            lines.append(
                f"{i}: {m.skill_id} | {m.name} | {m.description} | tags: {', '.join(m.tags)}"
            )
        candidate_text = "\n".join(lines)

        system_prompt = (
            "You are a biomedical skill retrieval ranker. "
            "Given a user query and a list of candidate skills, "
            "rank them by relevance to the query. "
            "Return a JSON object with a single key 'ranking' — "
            "an array of candidate indices in descending relevance order. "
            "Include ALL candidate indices, even if some seem unrelated. "
            "Only return the JSON object, no additional text."
        )

        user_prompt = (
            f"Query: {query}\n\n"
            f"Candidates:\n{candidate_text}\n\n"
            "Return the ranking as JSON: {\"ranking\": [3, 0, 5, 1, 2, 4]}"
        )

        client = DashScopeClient()
        result = client.chat_json(messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ])

        ranking: list[int] = result.get("ranking", [])
        if not ranking or len(ranking) != len(candidates):
            logger.warning("LLM 返回的 ranking 无效，回退到原顺序")
            return candidates[:top_k]

        # 按 LLM 排序索引重排
        reranked = [candidates[i] for i in ranking if 0 <= i < len(candidates)]
        return reranked[:top_k]
