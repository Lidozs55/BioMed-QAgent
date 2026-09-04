# LLM-Enhanced Skill Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pure keyword `find_skill` ranking with a hybrid strategy that uses a fast LLM (qwen-flash) to semantically rank skills when lexical matching is empty or ambiguous, keeping the lexical baseline as deterministic offline fallback.

**Architecture:** `LexicalSkillSearchStrategy` stays as-is (deterministic baseline). A new `LLMRerankingSkillSearchStrategy` wraps it: run lexical search first; if the lexical result lacks an exact-identity hit (ambiguous) or is empty, call the fast model once with the full authorized skill catalog (15 builtins ≈ 1.5–2K tokens) and ask for a JSON top-k list; validate returned names against the catalog (anti-hallucination), fall back to the lexical result on any model failure/timeout/offline. The `SkillSearchStrategy` sync protocol is preserved; the LLM path is exposed as an optional `search_async` method and dispatched via `hasattr` in the gateway, so all existing sync tests keep passing unchanged.

**Tech Stack:** Python 3.12, OpenAI Agents SDK, `AsyncOpenAI` (DashScope OpenAI-compatible endpoint), `qwen-flash` model, Pydantic v2.

## Global Constraints

- Never change the `SkillSearchStrategy` sync protocol (search.py:82-91) — 8 existing tests in `tests/test_skill_search.py` + `tests/test_skill_gateway.py` use sync `search()` calls.
- Keep the empty-text fast-path: `text == ""` returns all candidates without any model call (search.py:104-105 equivalent).
- All offline tests (`uv run pytest`) must pass without network or real model calls. Model-path tests are either mocked or marked `@pytest.mark.live`.
- LLM result must only reference skill names present in the authorized candidate list; anything else is discarded (anti-hallucination).
- Model credentials come from `ctx.context.model_settings` (context.py:139), never from new env vars. Reuse `require_model_credentials` + `validate_credentialed_public_url` from `app.agent_loop.model`.
- Model name: `qwen-flash` (catalog_qwen.py:18-25). Timeout per call ≤ 5s; total LLM latency must stay under 1s typical for 15-skill catalog.
- Only the main Agent gets the LLM strategy (agent.py:272). Child agents (subagents/agents.py:114,124) keep `LexicalSkillSearchStrategy` — their find_skill is called in high-frequency research loops.
- Deterministic tests for the strategy must not depend on model output ordering beyond documented top-k semantics.
- Follow backend conventions: PEP 8, type annotations on all signatures, Pydantic v2, `from app.<module>` imports.
- Quality gates before merge (AGENTS.md §7.3): `uv run pytest` (excludes live), `uv run ruff check app/ tests/`, uvicorn startup smoke.

---

### Task 1: LLM skill-reranking strategy module

**Files:**
- Create: `backend/app/skills/llm_search.py`
- Test: `backend/tests/test_llm_skill_search.py`

**Interfaces:**
- Consumes: `SkillDescriptor` (app.skills.catalog), `SkillSearchStrategy` protocol (app.skills.search), `RunModelSettings` (app.model_config), `require_model_credentials` + `validate_credentialed_public_url` (app.agent_loop.model)
- Produces: `class LLMRerankingSkillSearchStrategy` with:
  - `__init__(self, lexical: SkillSearchStrategy | None = None, model_name: str = "qwen-flash", timeout: float = 5.0)` — `lexical` defaults to `LexicalSkillSearchStrategy()`
  - `search(self, candidates, text) -> tuple[SkillDescriptor, ...]` — sync, never raises on model failure
  - `async search_async(self, candidates, text, model_settings: RunModelSettings) -> tuple[SkillDescriptor, ...]` — the LLM path
  - module-level `_build_catalog_prompt(candidates, text) -> str` and `_parse_ranking_response(raw: str, valid_names: set[str]) -> tuple[str, ...]`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_llm_skill_search.py
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

    assert [d.name for d in result] == ["pubmed", "geo"]
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_llm_skill_search.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.skills.llm_search'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/skills/llm_search.py
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

from openai import AsyncOpenAI

from app.agent_loop.model import (
    require_model_credentials,
    validate_credentialed_public_url,
)
from app.model_config import RunModelSettings
from app.skills.catalog import SkillDescriptor
from app.skills.search import LexicalSkillSearchStrategy, SkillSearchStrategy

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
        base_url = validate_credentialed_public_url(model_settings.base_url)
        client = AsyncOpenAI(
            api_key=model_settings.api_key,
            base_url=base_url,
        )
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
        if not text.strip():
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
        """True when the lexical result contains an exact name or source match."""
        normalized = text.strip().casefold()
        return any(
            d.name.casefold() == normalized
            or normalized in {s.casefold() for s in d.supported_sources}
            for d in lexical_result
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_llm_skill_search.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/skills/llm_search.py backend/tests/test_llm_skill_search.py
git commit -m "feat: LLM reranking skill search strategy with lexical fallback"
```

---

### Task 2: Gateway async dispatch + main-agent wiring

**Files:**
- Modify: `backend/app/skills/gateway.py:53-115`
- Modify: `backend/app/agent_loop/agent.py:271-283`
- Test: `backend/tests/test_skill_gateway.py` (extend)

**Interfaces:**
- Consumes: `LLMRerankingSkillSearchStrategy.search_async` (Task 1), `ctx.context.model_settings` (context.py:139), `SkillSearchStrategy` protocol
- Produces: `build_skill_gateway(catalog, search_strategy=None)` — unchanged signature; when the strategy exposes `search_async`, `_find_skill` calls it with `ctx.context.model_settings`; otherwise sync `search`

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_skill_gateway.py
import pytest
from app.skills.llm_search import LLMRerankingSkillSearchStrategy


class _AsyncRecordingStrategy(LLMRerankingSkillSearchStrategy):
    def __init__(self) -> None:
        super().__init__()
        self.async_called = False

    async def search_async(self, candidates, text, model_settings):  # type: ignore[override]
        self.async_called = True
        return tuple(candidates)


@pytest.mark.asyncio
async def test_find_skill_dispatches_to_search_async_when_available() -> None:
    from app.skills.gateway import build_skill_gateway
    from app.skills.catalog import SkillCatalog
    from app.skills.registry import SkillCategory, SkillDef
    from agents import RunContextWrapper

    cat = SkillCatalog(
        [
            SkillDef(
                name="geo",
                category=SkillCategory.ACQUISITION,
                description="GEO datasets.",
                supported_sources=["geo"],
                tools=[demo_operation],
            )
        ]
    )
    strategy = _AsyncRecordingStrategy()
    find_skill, _ = build_skill_gateway(cat, search_strategy=strategy)

    result = await _call(find_skill, "geo", preferred_sources=[])

    assert strategy.async_called is True
    assert '"geo"' in result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_skill_gateway.py -q`
Expected: FAIL — `_find_skill` never calls `search_async`; `async_called` stays False

- [ ] **Step 3: Implement dispatch in gateway**

In `_find_skill` (gateway.py:90), replace `matches = resolved_search_strategy.search(candidates, text)` with:

```python
search_async = getattr(resolved_search_strategy, "search_async", None)
if search_async is not None:
    matches = await search_async(
        candidates,
        text,
        ctx.context.model_settings,
    )
else:
    matches = resolved_search_strategy.search(candidates, text)
```

(Add a `# type: ignore[call-arg]`-free path: since `search_async` has a known signature on the strategy classes, use `typing.cast` if needed.)

- [ ] **Step 4: Wire main agent to the LLM strategy**

In `backend/app/agent_loop/agent.py:271-272`, change:

```python
from app.skills.llm_search import LLMRerankingSkillSearchStrategy
...
find_skill, invoke_skill = build_skill_gateway(
    resolved_catalog,
    search_strategy=LLMRerankingSkillSearchStrategy(),
)
```

- [ ] **Step 5: Run tests to verify**

Run: `cd backend && uv run pytest tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py tests/test_skill_search.py -q`
Expected: all pass (existing sync `RecordingSearchStrategy` tests unaffected — no `search_async` attr)

- [ ] **Step 6: Commit**

```bash
git add backend/app/skills/gateway.py backend/app/agent_loop/agent.py backend/tests/test_skill_gateway.py
git commit -m "feat: dispatch find_skill to LLM rerank when strategy provides search_async"
```

---

### Task 3: Live integration probe + docs

**Files:**
- Create: `backend/tests/test_llm_skill_search_live.py` (marked `@pytest.mark.live`)
- Modify: `docs/REVIEW_2026-07-31-browser-automation-audit.md` (append status note)

**Interfaces:**
- Consumes: `LLMRerankingSkillSearchStrategy.search_async`, real catalog via `load_builtin_skill_descriptors`

- [ ] **Step 1: Write the live test**

```python
# backend/tests/test_llm_skill_search_live.py
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
```

- [ ] **Step 2: Run offline suite to confirm it's excluded**

Run: `cd backend && uv run pytest tests/test_llm_skill_search_live.py -q`
Expected: SKIPPED (not live)

- [ ] **Step 3: Run live probe (requires API key)**

Run: `cd backend && uv run pytest -m live tests/test_llm_skill_search_live.py -v`
Expected: PASS — qwen-flash ranks `web_visual_capture`/`browser_fallback` for the Chinese web-capture query

- [ ] **Step 4: Document in audit doc**

Append to `docs/REVIEW_2026-07-31-browser-automation-audit.md` §四:

```markdown
5. **语义检索（已实施，branch `feat/llm-skill-retrieval`）**：`find_skill` 引入
   `LLMRerankingSkillSearchStrategy`（app/skills/llm_search.py）——词法检索为确定性基线，
   词法空结果/模糊时用 `qwen-flash` 单次分类调用对全目录（15 skills）重排 top-k；
   模型失败/离线回退词法，空 text fast-path 保留。仅主 Agent 启用；子代理保持词法。
   中文能力词（网页/截图/浏览器）由模型语义命中，不再依赖 `_DOMAIN_INTENTS` 手工表。
```

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_llm_skill_search_live.py docs/REVIEW_2026-07-31-browser-automation-audit.md
git commit -m "test: live qwen-flash skill rerank probe + audit doc note"
```

---

## Self-Review

**Spec coverage:**
- 快模型检索 → Task 1 (`LLMRerankingSkillSearchStrategy`) + Task 2 (gateway dispatch + main-agent wiring) + Task 3 (live probe). ✅
- 保留词法基线/离线确定性 → Task 1 `search()` sync fallback + Task 2 `hasattr` dispatch (sync-only strategies unaffected). ✅
- 成本控制 (子代理不翻倍) → Task 2 wires only agent.py:272; subagents/agents.py untouched. ✅
- 防幻觉 → Task 1 `_parse_ranking_response` validates against `valid_names`. ✅
- 空 text fast-path → Task 1 `search()`/`search_async()` both short-circuit. ✅

**Placeholder scan:** All steps contain concrete code; no TBD/TODO/"appropriate error handling" phrases.

**Type consistency:** `search_async(self, candidates, text, model_settings)` signature is identical across Task 1 (definition), Task 2 (dispatch call site `search_async(candidates, text, ctx.context.model_settings)`), Task 3 (live test call). `_parse_ranking_response(raw, valid_names) -> tuple[str, ...]` consistent. `LLMRerankingSkillSearchStrategy()` constructor args consistent.

**Known tradeoffs (documented, not hidden):**
- Model path is non-deterministic by nature; tests assert set membership / documented top-k semantics, not exact order (except mocked unit tests).
- `search_async` returning `reranked + tail` means model ranking takes precedence over lexical when non-empty — a deliberate product choice (semantic > keyword), reversible in one line.
- `hasattr` dispatch is a pragmatic duck-typing bridge; a stricter alternative (union protocol with `search_async` optional) was rejected as over-engineering for 2 call sites.
