"""Live probe: real qwen-flash call against the builtin catalog.

Run with: uv run pytest -m live tests/test_llm_skill_search_live.py
Requires DASHSCOPE_API_KEY.
"""

from __future__ import annotations

import pytest
from app.model_config import RunModelSettings
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.llm_search import LLMRerankingSkillSearchStrategy


@pytest.mark.live
@pytest.mark.asyncio
async def test_llm_rerank_ranks_browser_skill_for_chinese_query() -> None:
    catalog = SkillCatalog(load_builtin_skill_descriptors())
    snapshot = catalog.snapshot()
    candidates = tuple(snapshot.skills.values())
    strategy = LLMRerankingSkillSearchStrategy()

    result = await strategy.search_async(
        candidates,
        "帮我抓取这个网页的内容并截图",
        RunModelSettings.default(),
    )

    names = [d.name for d in result]
    assert "web_visual_capture" in names or "browser_fallback" in names
