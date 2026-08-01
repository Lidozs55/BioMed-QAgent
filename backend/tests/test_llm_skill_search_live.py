"""Live probe: real qwen-flash call against the builtin catalog.

Run with: uv run pytest -m live tests/test_llm_skill_search_live.py
Requires DASHSCOPE_API_KEY.
"""

from __future__ import annotations

import os

import pytest
from app.config import settings as app_settings
from app.model_config import RunModelSettings
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.llm_search import LLMRerankingSkillSearchStrategy


@pytest.mark.live
@pytest.mark.asyncio
async def test_llm_rerank_ranks_browser_skill_for_chinese_query() -> None:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        pytest.skip("DASHSCOPE_API_KEY not set")
    # Real credentials from the environment: the probe must exercise qwen-flash,
    # not the lexical fallback (which triggers when the key is empty).
    run_settings = RunModelSettings.default().model_copy(
        update={
            "api_key": api_key,
            "base_url": os.environ.get("DASHSCOPE_BASE_URL", app_settings.dashscope_base_url),
        }
    )

    catalog = SkillCatalog(load_builtin_skill_descriptors())
    snapshot = catalog.snapshot()
    candidates = tuple(snapshot.skills.values())
    strategy = LLMRerankingSkillSearchStrategy()

    # Query intentionally contains no _DOMAIN_INTENTS phrase and no token from
    # any skill metadata (打开/链接/页面/总结 appear nowhere), so the lexical
    # strategy returns EMPTY for it — a passing assertion below therefore
    # proves the ranked names came from qwen-flash, not the fallback.
    result = await strategy.search_async(
        candidates,
        "打开这个链接看看页面里有什么内容并帮我总结一下",
        run_settings,
    )

    names = [d.name for d in result]
    assert "web_visual_capture" in names or "browser_fallback" in names
