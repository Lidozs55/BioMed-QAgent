# Deterministic `find_skill` Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `find_skill` reliably discover existing skills from multi-term, Chinese, and case-variant queries while preserving its public JSON contract and hard permission filters.

**Architecture:** Add a focused search module containing a strategy protocol and a deterministic lexical implementation. The gateway applies enabled, allowlist, category, and source filters before delegating text ranking to the strategy; the default strategy performs Unicode normalization, domain-intent expansion, weighted token scoring, and stable ordering.

**Tech Stack:** Python 3.12, OpenAI Agents SDK `FunctionTool`, Pydantic v2 skill descriptors, pytest, Ruff.

## Global Constraints

- Do not create or call an LLM sub-agent, generate embeddings, add a vector database, or add a network dependency.
- Keep the `find_skill` input parameters and response keys unchanged.
- Keep `SkillManifest`, `CatalogSnapshot`, and `invoke_skill` contracts unchanged.
- A search strategy may only receive candidates that already passed enabled, RunContext allowlist, category, and source filters.
- Use deterministic NFKC/casefold normalization and stable catalog-order tie-breaking.
- All backend commands run from `backend/`.
- Every production behavior change starts with a failing test.

---

## File Map

- Create `backend/app/skills/search.py`: strategy protocol, query normalization, Chinese domain-intent expansion, weighted lexical ranking.
- Create `backend/tests/test_skill_search.py`: isolated tests for ranking behavior and deterministic ordering.
- Modify `backend/app/skills/gateway.py`: hard-filter candidates, normalize source matching, inject and call a search strategy.
- Modify `backend/tests/test_skill_gateway.py`: gateway regression tests for source casing, public response compatibility, and strategy isolation.
- Modify `backend/app/agent_loop/agent.py`: teach the Agent how to form and recover from `find_skill` queries.
- Modify `backend/tests/agent_loop/test_agent_build.py`: lock down the new discovery guidance.
- Modify `docs/ISSUES.md`: close the reported issue with the reproduced root cause and implemented boundary.

### Task 1: Deterministic lexical search strategy

**Files:**
- Create: `backend/app/skills/search.py`
- Create: `backend/tests/test_skill_search.py`

**Interfaces:**
- Consumes: `app.skills.catalog.SkillDescriptor`.
- Produces: `SkillSearchStrategy.search(candidates: Sequence[SkillDescriptor], text: str) -> tuple[SkillDescriptor, ...]`.
- Produces: `LexicalSkillSearchStrategy`, the default strategy implementation.
- Produces: `normalize_skill_search_text(value: str) -> str`, reused by the gateway for source comparison.

- [ ] **Step 1: Write the failing ranking tests**

Create `backend/tests/test_skill_search.py` with real descriptors and no gateway mocks:

```python
from __future__ import annotations

from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.catalog import SkillDescriptor
from app.skills.registry import SkillCategory, SkillDef
from app.skills.search import LexicalSkillSearchStrategy


@function_tool
async def demo_operation(ctx: RunContextWrapper[RunContext]) -> dict[str, Any]:
    """Return deterministic test data."""
    return {"task_id": ctx.context.task_id}


def _descriptor(
    name: str,
    description: str,
    *,
    sources: list[str],
    category: SkillCategory = SkillCategory.ACQUISITION,
) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name=name,
            category=category,
            description=description,
            supported_sources=sources,
            tools=[demo_operation],
        ),
    )


def test_multi_term_query_matches_non_contiguous_metadata() -> None:
    strategy = LexicalSkillSearchStrategy()
    geo = _descriptor(
        "geo",
        "Search and download Gene Expression Omnibus datasets.",
        sources=["geo", "ncbi_geo"],
    )
    analysis = _descriptor(
        "analysis",
        "Statistical analysis of expression tables.",
        sources=[],
        category=SkillCategory.ANALYSIS,
    )

    result = strategy.search((analysis, geo), "search GEO expression datasets")

    assert [item.name for item in result] == ["geo", "analysis"]


def test_chinese_domain_intent_expands_to_english_metadata() -> None:
    strategy = LexicalSkillSearchStrategy()
    pubmed = _descriptor(
        "pubmed",
        "Search biomedical literature and research papers.",
        sources=["pubmed"],
        category=SkillCategory.DISCOVERY,
    )
    pdb = _descriptor(
        "pdb",
        "Search and download protein structures and 3D models.",
        sources=["pdb", "rcsb_pdb"],
    )

    literature = strategy.search((pdb, pubmed), "检索相关文献")
    structure = strategy.search((pubmed, pdb), "查找蛋白结构")

    assert [item.name for item in literature] == ["pubmed"]
    assert [item.name for item in structure] == ["pdb"]


def test_identity_fields_rank_above_description_only_matches() -> None:
    strategy = LexicalSkillSearchStrategy()
    source_match = _descriptor(
        "geo",
        "Repository datasets.",
        sources=["gene_expression"],
    )
    description_match = _descriptor(
        "generic",
        "Analyze gene expression datasets.",
        sources=["generic"],
    )

    result = strategy.search(
        (description_match, source_match),
        "gene expression",
    )

    assert [item.name for item in result] == ["geo", "generic"]


def test_empty_or_generic_query_preserves_catalog_order() -> None:
    strategy = LexicalSkillSearchStrategy()
    first = _descriptor("first", "First capability.", sources=["first"])
    second = _descriptor("second", "Second capability.", sources=["second"])

    assert strategy.search((first, second), "") == (first, second)
    assert strategy.search((first, second), "search skill") == (first, second)


def test_equal_scores_preserve_catalog_order() -> None:
    strategy = LexicalSkillSearchStrategy()
    first = _descriptor("first", "Pathway records.", sources=["first"])
    second = _descriptor("second", "Pathway records.", sources=["second"])

    result = strategy.search((second, first), "pathway")

    assert result == (second, first)
```

- [ ] **Step 2: Run the new test module and verify RED**

Run:

```powershell
uv run pytest tests/test_skill_search.py -q
```

Expected: collection fails with `ModuleNotFoundError: No module named 'app.skills.search'`.

- [ ] **Step 3: Implement the strategy protocol and minimal lexical ranker**

Create `backend/app/skills/search.py`:

```python
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
        token
        for token in normalized.split()
        if token not in _STOP_WORDS
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
```

- [ ] **Step 4: Run the strategy tests and verify GREEN**

Run:

```powershell
uv run pytest tests/test_skill_search.py -q
```

Expected: `5 passed`.

- [ ] **Step 5: Run focused static checks**

Run:

```powershell
uv run ruff check app/skills/search.py tests/test_skill_search.py
uv run python -m compileall -q app/skills/search.py tests/test_skill_search.py
```

Expected: both commands exit `0` with no diagnostics.

- [ ] **Step 6: Commit Task 1**

```powershell
git add backend/app/skills/search.py backend/tests/test_skill_search.py
git diff --cached --check
git commit -m "feat(skills): add deterministic search ranking"
```

### Task 2: Gateway integration and Agent query guidance

**Files:**
- Modify: `backend/app/skills/gateway.py:13-90`
- Modify: `backend/tests/test_skill_gateway.py:20-103`
- Modify: `backend/app/agent_loop/agent.py:124-130`
- Modify: `backend/tests/agent_loop/test_agent_build.py:55-65`

**Interfaces:**
- Consumes: `SkillSearchStrategy`, `LexicalSkillSearchStrategy`, and `normalize_skill_search_text` from Task 1.
- Produces: `build_skill_gateway(catalog: SkillCatalog, search_strategy: SkillSearchStrategy | None = None) -> tuple[FunctionTool, FunctionTool]`.
- Preserves: the existing `find_skill(text="", category=None, source=None)` Function Tool schema and response keys.

- [ ] **Step 1: Add failing gateway regression tests**

Append these helpers and tests to `backend/tests/test_skill_gateway.py`:

```python
from collections.abc import Sequence

from app.skills.search import SkillSearchStrategy


class RecordingSearchStrategy:
    def __init__(self) -> None:
        self.candidate_names: tuple[str, ...] = ()

    def search(
        self,
        candidates: Sequence[SkillDescriptor],
        text: str,
    ) -> tuple[SkillDescriptor, ...]:
        self.candidate_names = tuple(item.name for item in candidates)
        return tuple(candidates)


@pytest.mark.asyncio
async def test_find_skill_source_filter_is_case_insensitive() -> None:
    find_skill, _ = build_skill_gateway(SkillCatalog([_skill()]))

    result = await _call(
        find_skill,
        _context(sources=["geo"]),
        source="GEO",
    )

    assert [item["name"] for item in result["skills"]] == ["geo_fetch"]


@pytest.mark.asyncio
async def test_find_skill_strategy_receives_only_hard_filtered_candidates() -> None:
    allowed = _skill()
    blocked = SkillDescriptor.from_skill_def(
        SkillDef(
            name="pubmed",
            category=SkillCategory.DISCOVERY,
            description="Search literature.",
            supported_sources=["pubmed"],
            tools=[fetch_record],
        ),
        user_selectable=True,
    )
    strategy = RecordingSearchStrategy()
    search_strategy: SkillSearchStrategy = strategy
    find_skill, _ = build_skill_gateway(
        SkillCatalog([allowed, blocked]),
        search_strategy=search_strategy,
    )

    result = await _call(
        find_skill,
        _context(sources=["geo"]),
        text="anything",
    )

    assert strategy.candidate_names == ("geo_fetch",)
    assert [item["name"] for item in result["skills"]] == ["geo_fetch"]
    assert set(result) == {"status", "generation", "skills"}
```

Update `test_find_skill_filters_text_category_source_and_allowlist` so the text is
`"download expression records"` instead of `"expression"`. This locks down the
original natural multi-term failure through the public Function Tool boundary.

- [ ] **Step 2: Add a failing Agent guidance assertion**

Extend `test_agent_instructions_require_dynamic_skill_discovery_protocol` in
`backend/tests/agent_loop/test_agent_build.py`:

```python
assert "简短自然语言能力描述" in INSTRUCTIONS
assert "缩短查询" in INSTRUCTIONS
assert "优先传 `source`" in INSTRUCTIONS
```

- [ ] **Step 3: Run gateway and Agent tests and verify RED**

Run:

```powershell
uv run pytest tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py -q
```

Expected failures:

- `source="GEO"` returns no skills.
- `build_skill_gateway` rejects `search_strategy`.
- the multi-term gateway query returns no skills.
- the three new Agent guidance strings are absent.

- [ ] **Step 4: Integrate hard filtering and strategy delegation**

Update imports and signature in `backend/app/skills/gateway.py`:

```python
from app.skills.search import (
    LexicalSkillSearchStrategy,
    SkillSearchStrategy,
    normalize_skill_search_text,
)


def build_skill_gateway(
    catalog: SkillCatalog,
    search_strategy: SkillSearchStrategy | None = None,
) -> tuple[FunctionTool, FunctionTool]:
    """Build stable SDK gateway tools bound to a catalog object."""
    resolved_search_strategy = (
        search_strategy
        if search_strategy is not None
        else LexicalSkillSearchStrategy()
    )
```

Replace `_find_skill` with hard filtering followed by ranking:

```python
@function_tool(name_override="find_skill")
async def _find_skill(
    ctx: RunContextWrapper[RunContext],
    text: str = "",
    category: SkillCategory | None = None,
    source: str | None = None,
) -> str:
    """Find enabled skills by capability text, category, and data source.

    Pass a short natural-language capability description in ``text``. When
    the database is known, prefer ``source`` for an exact, case-insensitive
    source filter.
    """
    snapshot = catalog.snapshot()
    normalized_source = (
        normalize_skill_search_text(source)
        if source is not None
        else None
    )
    candidates: list[SkillDescriptor] = []
    for descriptor in snapshot.skills.values():
        if not descriptor.enabled or not _is_allowed(descriptor, ctx.context):
            continue
        if category is not None and descriptor.category != category:
            continue
        if normalized_source is not None:
            normalized_supported_sources = {
                normalize_skill_search_text(item)
                for item in descriptor.supported_sources
            }
            if normalized_source not in normalized_supported_sources:
                continue
        candidates.append(descriptor)
    matches = resolved_search_strategy.search(candidates, text)
    return json.dumps(
        {
            "status": "ok",
            "generation": snapshot.generation,
            "skills": [
                descriptor.manifest.model_dump(mode="json")
                for descriptor in matches
            ],
        },
        ensure_ascii=False,
    )
```

Remove the old whole-query `haystack` construction. Retain the existing
`invoke_skill` implementation unchanged.

- [ ] **Step 5: Improve the main Agent instructions**

Replace the three bullets under `## 动态 Skill 发现协议` in
`backend/app/agent_loop/agent.py` with:

```text
- 业务数据库与处理能力不会作为主 Agent 的直接工具注入。执行相关操作前先调用
  `find_skill`，再用 `invoke_skill` 提交 `skill`、`operation` 和结构化参数。
- 已知数据库时优先传 `source`；否则给 `text` 传简短自然语言能力描述，无需猜测
  完整 Skill 名称。可同时用 `category` 缩小范围。
- `find_skill` 返回空结果时，缩短查询并移除疾病、基因等具体研究实体，或改用
  `source`/`category`；不要原样重复同一查询。
- 用户选择的数据库是硬 allowlist；只能发现和调用 allowlist 内的 acquisition Skill。
- 技能目录更新后重新调用 `find_skill`，不要依赖此前记住的 operation 列表。
- 自定义 Agent-only 数据库不能作为 Pipeline 完成证据，也不能绕过 Validation Gate。
```

- [ ] **Step 6: Run gateway and Agent tests and verify GREEN**

Run:

```powershell
uv run pytest tests/test_skill_search.py tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py -q
```

Expected: all selected tests pass.

- [ ] **Step 7: Run focused lint and compilation**

Run:

```powershell
uv run ruff check app/skills/search.py app/skills/gateway.py app/agent_loop/agent.py tests/test_skill_search.py tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py
uv run python -m compileall -q app/skills/search.py app/skills/gateway.py app/agent_loop/agent.py tests/test_skill_search.py tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py
```

Expected: both commands exit `0` with no diagnostics.

- [ ] **Step 8: Commit Task 2**

```powershell
git add backend/app/skills/gateway.py backend/app/agent_loop/agent.py backend/tests/test_skill_gateway.py backend/tests/agent_loop/test_agent_build.py
git diff --cached --check
git commit -m "fix(skills): improve find_skill discovery"
```

### Task 3: Issue closure and complete backend verification

**Files:**
- Modify: `docs/ISSUES.md:50`

**Interfaces:**
- Documents: the exact reproduction, root cause, deterministic search behavior, and future `SkillSearchStrategy` seam.
- Verifies: the entire backend test and startup contract without modifying frontend files.

- [ ] **Step 1: Re-run the original reproduction through the public gateway**

Run this finite script from `backend/`:

```powershell
@'
import asyncio
import json

from agents.tool_context import ToolContext

from app.agent_loop.context import RunContext
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.gateway import build_skill_gateway


async def main() -> None:
    catalog = SkillCatalog(load_builtin_skill_descriptors())
    find_skill, _ = build_skill_gateway(catalog)
    context = ToolContext(
        context=RunContext(task_id="find-skill-verification"),
        tool_name="find_skill",
        tool_call_id="verification",
        tool_arguments="{}",
    )
    queries = (
        {"text": "gene expression search"},
        {"text": "protein structure search"},
        {"text": "literature search"},
        {"text": "差异表达分析"},
        {"source": "GEO"},
    )
    for query in queries:
        raw = await find_skill.on_invoke_tool(context, json.dumps(query))
        payload = json.loads(raw)
        print(query, [item["name"] for item in payload["skills"]])


asyncio.run(main())
'@ | uv run python -
```

Expected:

- gene expression query includes `geo`.
- protein structure query includes `pdb`.
- literature query includes `pubmed`.
- Chinese differential-expression query includes `analysis`.
- uppercase GEO source query returns `geo`.

- [ ] **Step 2: Update the issue entry**

Replace the last unchecked item in `docs/ISSUES.md` with:

```markdown
- [X] (260723)**优化**：后端 `find_skill` 查找效率低下，经常找不到对应 Skill。
  - 状态：已解决（2026-07-23）。
  - 根因：旧实现把完整 `text` 当作一个连续子串匹配，且 `source` 区分大小写；
    自然多词、中文意图和 `GEO` 等大小写变体因此返回空目录。
  - 修复：新增确定性 `SkillSearchStrategy`，默认实现执行 NFKC/大小写归一化、
    中英文领域意图扩展、字段加权评分和稳定排序；Gateway 在策略运行前保留
    enabled、数据库 allowlist、category 和 source 硬过滤。
  - 扩展：未来可注入快速 LLM/Embedding 策略，但本次不调用模型、不新增网络依赖。
```

- [ ] **Step 3: Run the complete backend unit/integration suite**

Run:

```powershell
uv run pytest
```

Expected: exit `0`, with no failures or warnings. Live tests remain deselected by
the repository's pytest configuration.

- [ ] **Step 4: Run the complete backend lint and AST gates**

Run:

```powershell
uv run ruff check app/ tests/ launcher.py
uv run python -m compileall -q app tests launcher.py
```

Expected: both commands exit `0` with no diagnostics.

- [ ] **Step 5: Clear bytecode caches and run the Uvicorn startup smoke test**

Use the verified Windows template from `docs/DEVELOPER_QUICKSTART.md` §4.1.
Launch `.\.venv\Scripts\python.exe -m uvicorn app.main:app` directly with a
task-scoped process handle, poll `GET /api/v1/health` for at most 30 seconds,
assert HTTP `200`, and terminate the exact owned process in `finally`.

Expected: health endpoint returns HTTP `200`; the owned Uvicorn process exits
after cleanup. Do not use `Start-Process uv run`.

- [ ] **Step 6: Review the final diff against the approved specification**

Run:

```powershell
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git status --short
```

Expected: only the files named in this plan are changed, diff check exits `0`,
and no generated test/runtime files are tracked.

- [ ] **Step 7: Commit Task 3**

```powershell
git add docs/ISSUES.md
git diff --cached --check
git commit -m "docs: close find_skill discovery issue"
```

- [ ] **Step 8: Re-run fresh pre-push quality gates**

Run the full pytest, Ruff, compileall, and Uvicorn smoke commands from Steps
3–5 again after the documentation commit. Record their exact counts and exit
codes in the completion report. Do not push or merge until all fresh gates pass.
