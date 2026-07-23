"""Deterministic, replaceable search strategies for the skill catalog."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Protocol

from app.skills.catalog import SkillDescriptor

_TOKEN_PATTERN = re.compile(r"[^\W_]+", re.UNICODE)
_STOP_WORDS = {
    "download",
    "find",
    "search",
    "skill",
    "skills",
    "下载",
    "技能",
    "搜索",
    "查找",
    "检索",
}
_DOMAIN_INTENTS: dict[str, tuple[str, ...]] = {
    "文献": ("literature", "papers"),
    "基因表达": ("gene", "expression"),
    "差异表达": ("differential", "expression"),
    "蛋白结构": ("protein", "structure"),
    "通路": ("pathway",),
    "化合物": ("compound", "chemical"),
    "图表": ("chart", "figure"),
    "表格": ("table",),
    "统计分析": ("statistical", "analysis"),
}
_IDENTITY_WEIGHT = 12
_OPERATION_WEIGHT = 6
_DESCRIPTION_WEIGHT = 3
_COVERAGE_WEIGHT = 4
_EXACT_IDENTITY_BONUS = 20


def normalize_skill_search_text(value: str) -> str:
    """Return the canonical representation used by skill discovery."""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(_TOKEN_PATTERN.findall(normalized))


def _query_tokens(text: str) -> tuple[str, ...]:
    normalized = normalize_skill_search_text(text)
    tokens = [
        token for token in normalized.split() if token not in _STOP_WORDS
    ]
    for phrase, expansions in _DOMAIN_INTENTS.items():
        if phrase in normalized:
            tokens.extend(expansions)
    return tuple(dict.fromkeys(tokens))


def _field_tokens(*values: str) -> set[str]:
    return set(normalize_skill_search_text(" ".join(values)).split())


class SkillSearchStrategy(Protocol):
    """Rank an already-authorized sequence of skill descriptors."""

    def search(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
    ) -> tuple[SkillDescriptor, ...]:
        """Return matching candidates in descending relevance order."""
        ...


class LexicalSkillSearchStrategy:
    """Rank skills with deterministic weighted token matching."""

    def search(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
    ) -> tuple[SkillDescriptor, ...]:
        query = normalize_skill_search_text(text)
        query_tokens = _query_tokens(text)
        if not query_tokens:
            return tuple(candidates)

        ranked: list[tuple[int, int, SkillDescriptor]] = []
        for index, descriptor in enumerate(candidates):
            identity_values = (
                descriptor.name,
                descriptor.display_name,
                *descriptor.supported_sources,
            )
            identity_tokens = _field_tokens(*identity_values)
            operation_tokens = _field_tokens(*descriptor.operation_names)
            description_tokens = _field_tokens(descriptor.description)
            matched: set[str] = set()
            score = 0
            for token in query_tokens:
                if token in identity_tokens:
                    score += _IDENTITY_WEIGHT
                    matched.add(token)
                elif token in operation_tokens:
                    score += _OPERATION_WEIGHT
                    matched.add(token)
                elif token in description_tokens:
                    score += _DESCRIPTION_WEIGHT
                    matched.add(token)
            if not matched:
                continue
            normalized_identities = {
                normalize_skill_search_text(value)
                for value in identity_values
            }
            if query in normalized_identities:
                score += _EXACT_IDENTITY_BONUS
            score += len(matched) * _COVERAGE_WEIGHT
            ranked.append((score, index, descriptor))

        ranked.sort(key=lambda item: (-item[0], item[1]))
        return tuple(item[2] for item in ranked)
