# Subagent Research and Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Main Agent 委派真实研究子 Agent，自主探索公开来源、按三级回退采集 SourceAsset，并把新流程保存为不可执行 WorkflowRecipe。

**Architecture:** `SourceResearchAgent` 和 `SkillBuilderAgent` 实现 Runtime Foundation 的 runner 接口；声明式 Recipe Store/Executor 取代任意 Python learned skill。采集数据先进入每个子 Agent 的 staging，校验后才提交给父 Run。

**Tech Stack:** Python 3.12、OpenAI Agents SDK 0.18.2、Pydantic v2、httpx、BeautifulSoup、Playwright、pytest

## Global Constraints

- 用户勾选来源是偏好而不是硬 allowlist。
- 公开、免登录来源可自动访问；登录、CAPTCHA、API key、付费和凭据上传必须 HIL。
- 采集顺序固定为官方 API → HTML → Browser，并保存每次回退证据。
- 同一 Run 的同一 `domain + capability` 最多创建一次 Recipe。
- `not_found` 不触发 create_skill；`capability_gap` 才触发。
- WorkflowRecipe 不能包含任意 Python、Shell、JavaScript 或 secret。
- 子 Agent 只能写 `staging/subagents/<subagent_id>`。
- Validation Gate 仍是唯一正式 artifact 发布者。
- 不保留 `self_evolution` 任意代码写入入口。
- 每个任务提交后执行 `git fetch origin main && git rebase origin/main` 并重跑受影响测试。

---

### Task 1: WorkflowRecipe contracts and atomic store

**Files:**
- Create: `backend/app/domain/contracts/recipe.py`
- Modify: `backend/app/domain/contracts/__init__.py`
- Create: `backend/app/recipes/__init__.py`
- Create: `backend/app/recipes/store.py`
- Create: `backend/app/recipes/redaction.py`
- Test: `backend/tests/recipes/test_store.py`
- Test: `backend/tests/contracts/test_recipe_contracts.py`

**Interfaces:**
- Produces: `RecipeStatus`, `RecipeStep`, `RecipeAttempt`, `WorkflowRecipe`
- Produces: `WorkflowRecipeStore.save_draft`, `get`, `find_verified`, `mark_verified`, `reject`, `request_promotion`

- [ ] **Step 1: Write failing store tests**

```python
def test_store_writes_json_and_workflow_markdown(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(_recipe())
    recipe_dir = tmp_path / stored.recipe_id / str(stored.version)
    assert (recipe_dir / "recipe.json").is_file()
    assert (recipe_dir / "WORKFLOW.md").is_file()
    assert len(stored.digest) == 64


def test_store_redacts_secrets_before_persisting(tmp_path: Path) -> None:
    store = WorkflowRecipeStore(tmp_path)
    stored = store.save_draft(
        _recipe(request_headers={"Authorization": "Bearer private-token"})
    )
    raw = (tmp_path / stored.recipe_id / "1" / "recipe.json").read_text()
    assert "private-token" not in raw
    assert "[REDACTED]" in raw
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/recipes/test_store.py tests/contracts/test_recipe_contracts.py -q`
Expected: import failure because Recipe contracts/store do not exist.

- [ ] **Step 3: Implement immutable versioned storage**

Use a discriminated `RecipeStep` union for `api_request`, `html_extract`, and
`browser_action`; browser actions are limited to navigate, click, fill,
select, wait_for, and extract. Compute SHA-256 over canonical JSON excluding
`digest`. Write both files with `atomic_write_json`/`atomic_write_text`, then
atomically replace the version directory. Only allow transitions
`draft→verified`, `draft→rejected`, `verified→promoted`, and
`verified→rejected`.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/recipes/test_store.py tests/contracts/test_recipe_contracts.py -q`
Expected: versioning, digest, transitions, lookup, traversal rejection, and
redaction tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add backend/app/domain/contracts backend/app/recipes backend/tests/recipes backend/tests/contracts
git commit -m "feat: add auditable workflow recipe store"
git fetch origin main
git rebase origin/main
```

### Task 2: Controlled Recipe executor and SourceAsset staging

**Files:**
- Create: `backend/app/recipes/executor.py`
- Create: `backend/app/subagents/staging.py`
- Modify: `backend/app/integrations/acquisition.py`
- Test: `backend/tests/recipes/test_executor.py`
- Test: `backend/tests/subagents/test_staging.py`
- Create: `backend/tests/integration/test_acquisition_security.py`

**Interfaces:**
- Produces: `RecipeExecutor.execute(recipe, inputs, workspace) -> RecipeExecutionResult`
- Produces: `SubagentStagingWorkspace.commit_source_asset`
- Consumes: `SourceAsset`, `acquire_source`, crawler facade

- [ ] **Step 1: Write failing executor and escape tests**

```python
@pytest.mark.asyncio
async def test_verified_recipe_produces_validated_source_asset(tmp_path: Path) -> None:
    workspace = SubagentStagingWorkspace(tmp_path, "sub_1")
    result = await RecipeExecutor(client=FakeRecipeClient()).execute(
        _verified_api_recipe(),
        inputs={"accession": "GSE100"},
        workspace=workspace,
    )
    committed = workspace.commit_source_asset(result.source_asset)
    assert committed.sha256 == result.source_asset.sha256
    assert committed.path.is_relative_to(tmp_path)


def test_staging_rejects_symlink_escape(tmp_path: Path) -> None:
    workspace = SubagentStagingWorkspace(tmp_path, "sub_1")
    escaped = workspace.root / "escaped.csv"
    escaped.symlink_to(tmp_path.parent / "outside.csv")
    with pytest.raises(ValueError, match="staging workspace"):
        workspace.validate_path(escaped)
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/recipes/test_executor.py tests/subagents/test_staging.py -q`
Expected: import failure for executor/staging.

- [ ] **Step 3: Implement allowlisted execution**

Executor must reject unverified recipes and unknown step/action types. It
passes HTTP and browser operations only through the crawler facade, applies
input values only to declared template slots, enforces host and timeout rules,
and returns attempts plus one SourceAsset. Staging resolves every path before
read/write, rejects symlinks escaping its root, validates size/hash/metadata,
and commits with `Path.replace` on the same filesystem.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/recipes/test_executor.py tests/subagents/test_staging.py tests/integration/test_acquisition_security.py -q`
Expected: all selected tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add backend/app/recipes backend/app/subagents backend/app/integrations/acquisition.py backend/tests
git commit -m "feat: execute recipes in isolated staging"
git fetch origin main
git rebase origin/main
```

### Task 3: Internal create_skill Skill and removal of arbitrary learned code

**Files:**
- Create: `backend/app/skills/builtin/processing/create_skill/__init__.py`
- Create: `backend/app/skills/builtin/processing/create_skill/skill.py`
- Modify: `backend/app/skills/builtin/__init__.py`
- Modify: `backend/app/api/routes.py`
- Delete: `backend/app/skills/builtin/processing/self_evolution.py`
- Delete: `backend/app/skills/evolution.py`
- Delete: `backend/tests/test_skill_self_evolution.py`
- Create: `backend/tests/test_skill_create_skill.py`
- Modify: `backend/tests/test_builtin_skill_catalog.py`

**Interfaces:**
- Produces internal Skill `create_skill`
- Operations: `develop_workflow`, `validate_recipe`, `find_recipe`, `request_promotion`
- Consumes: WorkflowRecipeStore and RecipeExecutor

- [ ] **Step 1: Write failing tool-policy tests**

```python
def test_create_skill_is_internal_and_not_user_selectable(catalog) -> None:
    descriptor = catalog.get("create_skill")
    assert descriptor is not None
    assert descriptor.user_selectable is False


def test_create_skill_rejects_code_fields(tool_context) -> None:
    result = invoke_create_skill(
        tool_context,
        operation="develop_workflow",
        arguments={"code": "import os"},
    )
    assert result["error"]["code"] == "invalid_recipe_input"
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/test_skill_create_skill.py tests/test_builtin_skill_catalog.py -q`
Expected: fail because create_skill is absent and self_evolution is still registered.

- [ ] **Step 3: Implement four operations and remove old path**

Register one `SkillDef(name="create_skill", user_selectable=False)` whose
single dispatcher validates a discriminated operation model. `develop_workflow`
saves only a draft Recipe; `validate_recipe` executes and marks verified only
after SourceAsset validation; `find_recipe` returns verified metadata;
`request_promotion` creates an approval request without code generation.
Remove self_evolution catalog exports, API display metadata, module, evolution
engine, and obsolete tests.

- [ ] **Step 4: Verify GREEN and absence of code write APIs**

Run: `uv run pytest tests/test_skill_create_skill.py tests/test_builtin_skill_catalog.py tests/api/test_task_api.py -q`
Expected: tests pass.

Run: `rg -n "save_learned_skill|save_workflow_as_skill|self_evolution" backend/app`
Expected: no matches.

- [ ] **Step 5: Commit and sync**

```bash
git add backend/app/skills backend/app/api/routes.py backend/tests
git commit -m "feat: replace self evolution with create skill recipes"
git fetch origin main
git rebase origin/main
```

### Task 4: Preferred-source policy and Main Agent prompt

**Files:**
- Modify: `backend/app/agent_loop/context.py`
- Modify: `backend/app/skills/gateway.py`
- Modify: `backend/app/agent_loop/agent.py`
- Test: `backend/tests/test_skill_gateway.py`
- Test: `backend/tests/agent_loop/test_agent_build.py`

**Interfaces:**
- Produces: public sources allowed outside `preferred_sources`
- Produces: explicit prompt rules for `capability_gap`, `not_found`, HIL, and create_skill dedupe

- [ ] **Step 1: Write failing policy tests**

```python
def test_public_unselected_source_is_allowed(run_context, public_skill) -> None:
    run_context.preferred_sources = ["pubmed"]
    assert is_skill_allowed(public_skill, run_context) is True


def test_agent_prompt_distinguishes_not_found_from_capability_gap(run_context) -> None:
    instructions = resolve_agent_instructions(INSTRUCTIONS, run_context)
    assert "not_found 不得触发 create_skill" in instructions
    assert "capability_gap" in instructions
    assert "同一 domain + capability 最多调用一次" in instructions
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py -q`
Expected: public unselected source remains denied and prompt assertions fail.

- [ ] **Step 3: Implement direct policy replacement**

Replace allowlist logic with preference ranking. Deny only explicit policy,
authentication, capability, or mode constraints. Update RunContext docs and
Main Agent instructions so preferred sources are searched first, public
alternatives are allowed, protected sources use HIL, and only evidenced
capability gaps dispatch SkillBuilderAgent.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/test_skill_gateway.py tests/agent_loop/test_agent_build.py -q`
Expected: all selected tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add backend/app/agent_loop backend/app/skills/gateway.py backend/tests
git commit -m "feat: treat selected sources as preferences"
git fetch origin main
git rebase origin/main
```

### Task 5: Real child agents and Main Agent delegation tools

**Files:**
- Create: `backend/app/subagents/agents.py`
- Create: `backend/app/subagents/tools.py`
- Modify: `backend/app/agent_loop/agent.py`
- Modify: `backend/app/agent_loop/runner.py`
- Modify: `backend/app/agent_loop/context.py`
- Test: `backend/tests/subagents/test_agents.py`
- Test: `backend/tests/subagents/test_tools.py`
- Test: `backend/tests/agent_loop/test_agent_build.py`

**Interfaces:**
- Produces: `SourceResearchAgentRunner`, `SkillBuilderAgentRunner`
- Produces Main Agent tools: `delegate_research`, `get_subagent_results`, `cancel_subagent`
- Consumes: Supervisor, Recipe Store/Executor, separate child RunContext/session

- [ ] **Step 1: Write failing delegation tests**

```python
@pytest.mark.asyncio
async def test_delegate_returns_handles_before_children_finish(agent_context) -> None:
    result = await delegate_research_impl(
        agent_context,
        [_research_request("geo"), _research_request("arrayexpress")],
    )
    assert len(result.subagents) == 2
    assert {item.status for item in result.subagents} == {"queued"}


def test_child_agent_has_no_pipeline_or_delegation_tools(agent_factory) -> None:
    child = agent_factory.build_source_research_agent()
    names = {tool.name for tool in child.tools}
    assert "run_research_pipeline" not in names
    assert "delegate_research" not in names
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/subagents/test_agents.py tests/subagents/test_tools.py -q`
Expected: fail because real child agents/tools do not exist.

- [ ] **Step 3: Implement separate child sessions**

Build child Agents with the frozen parent model configuration but a new
RunContext and SDK session. SourceResearchAgent receives skill/recipe/crawler
tools only. SkillBuilderAgent receives create_skill plus crawler inspection
tools. Both cap `max_turns=10`, return typed SubagentResult, and never receive
pipeline, artifact publication, delegation, or final CSV tools. Register the
three Main Agent tools directly without a feature flag.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/subagents/test_agents.py tests/subagents/test_tools.py tests/agent_loop/test_agent_build.py tests/agent_loop/test_execution.py -q`
Expected: tool isolation, independent context, early handle return, result
lookup, and create_skill dedupe tests pass.

- [ ] **Step 5: Commit and sync**

```bash
git add backend/app/subagents backend/app/agent_loop backend/tests
git commit -m "feat: delegate research to managed child agents"
git fetch origin main
git rebase origin/main
```

### Task 6: Async crawler facade, per-host limiter, and BrowserPool

**Files:**
- Modify: `backend/app/tools/crawler.py`
- Create: `backend/app/tools/browser_pool.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_tools_crawler.py`
- Create: `backend/tests/test_browser_pool.py`

**Interfaces:**
- Produces: async `fetch_with_fallback`
- Produces: `BrowserPool.start`, `fetch`, `screenshot`, `close`
- Consumes: one lifespan-owned Chromium, maximum 4 contexts

- [ ] **Step 1: Write failing fallback/pool tests**

```python
@pytest.mark.asyncio
async def test_fallback_stops_after_successful_api() -> None:
    facade = FakeCrawlerFacade(api=_ok(), html=_unexpected(), browser=_unexpected())
    result = await fetch_with_fallback("https://example.org/data", facade=facade)
    assert result.method == "api"
    assert facade.calls == ["api"]


@pytest.mark.asyncio
async def test_pool_uses_one_browser_and_four_contexts(fake_playwright) -> None:
    pool = BrowserPool(max_contexts=4, playwright_factory=fake_playwright)
    await pool.start()
    await asyncio.gather(*(pool.fetch(f"https://example.org/{index}") for index in range(8)))
    assert fake_playwright.browser_launches == 1
    assert fake_playwright.max_active_contexts == 4
    await pool.close()
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/test_tools_crawler.py tests/test_browser_pool.py -q`
Expected: BrowserPool import fails and synchronous fallback cannot satisfy tests.

- [ ] **Step 3: Implement async facade and host-scoped limits**

Move blocking parser work through `asyncio.to_thread` only where a library has
no async API. Store `RateLimiter` by normalized host, revalidate every redirect,
and record `CrawlAttempt(method, url, started_at, status, reason)`. BrowserPool
launches one browser in lifespan, uses a semaphore of 4, creates one isolated
Context per call, and closes Context in `finally`.

- [ ] **Step 4: Verify GREEN and security**

Run: `uv run pytest tests/test_tools_crawler.py tests/test_browser_pool.py tests/integration/test_acquisition_security.py -q`
Expected: ordering, audit attempts, cross-host concurrency, same-host limits,
SSRF redirects, cancellation cleanup, and one-browser assertions pass.

- [ ] **Step 5: Run research-layer gates and commit**

Run: `uv run pytest tests/recipes tests/subagents tests/test_skill_create_skill.py tests/test_skill_gateway.py tests/test_tools_crawler.py tests/test_browser_pool.py -q`
Expected: all selected tests pass.

```bash
git add backend/app backend/tests
git commit -m "feat: add audited async crawler fallback"
git fetch origin main
git rebase origin/main
```
