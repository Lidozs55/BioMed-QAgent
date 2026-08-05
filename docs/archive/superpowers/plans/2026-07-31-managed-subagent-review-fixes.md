# Managed Subagent Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified production-path and security gaps found during the managed-subagent pre-merge review, then merge the branch into the latest `main`.

**Architecture:** Child `RunContext` instances will own a task-local staging root at `staging/subagents/<subagent_id>`. Acquisition tools will publish validated `SourceAsset` metadata through that boundary, and the child runner will return the collected IDs and recipe metadata in `SubagentResult`. Protected operations will use the existing request-keyed input broker and durable subagent events. Production acquisition requests will use the lifespan-owned pinned crawler facade; legacy urllib fallbacks remain test-only for contexts without a bound facade.

**Tech Stack:** Python 3.12, FastAPI runtime, OpenAI Agents SDK, Pydantic v2, pytest, Ruff.

## Global Constraints

- Do not modify or commit the user-owned `AGENTS.md` changes.
- Child files must remain under `<task-runtime>/staging/subagents/<subagent_id>/` until validated and atomically committed.
- `SubagentResult` must contain only bounded metadata: IDs, summary, warnings, and error fields.
- Credential values must never be copied into durable event payloads.
- Every implementation change requires a failing regression test first.

---

### Task 1: Child result metadata and staging ownership

**Files:**
- Modify: `backend/app/tools/workdir.py`
- Modify: `backend/app/agent_loop/context.py`
- Modify: `backend/app/subagents/agents.py`
- Modify: `backend/app/skills/builtin/processing/create_skill/skill.py`
- Modify: `backend/app/skills/builtin/acquisition/browser.py`
- Modify: `backend/app/skills/builtin/acquisition/web_visual_capture.py`
- Modify: `backend/app/skills/builtin/acquisition/geo.py`
- Test: `backend/tests/agent_loop/test_context.py`
- Test: `backend/tests/subagents/test_agents.py`
- Test: `backend/tests/test_skill_create_skill_runtime.py`

**Interfaces:**
- `RunContext.create_child_context()` produces a child work directory rooted at the parent task's `staging/subagents/<id>` path.
- `RunContext.record_source_asset()` and `record_recipe()` collect bounded child metadata.
- `_ChildAgentRunner._run_agent()` returns those collected fields in `SubagentResult`.

- [x] Write tests that assert child paths are isolated and a mocked child tool result is returned as `source_asset_ids`, `recipe_id`, and warnings.
- [x] Run the focused tests and observe the expected failure.
- [x] Add the explicit child work-root and metadata collectors, then connect existing SourceAsset/Recipe-producing tools to them.
- [x] Run the focused tests until green, then run the affected acquisition and recipe tests.

### Task 2: Protected-source child HIL

**Files:**
- Modify: `backend/app/agent_loop/context.py`
- Modify: `backend/app/agent_loop/runner.py`
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/skills/gateway.py`
- Test: `backend/tests/test_skill_gateway.py`
- Test: `backend/tests/subagents/test_input_broker.py`
- Test: `backend/tests/agent_loop/test_execution.py`

**Interfaces:**
- Runtime binding passes `SubagentInputBroker` into child contexts.
- `RunContext.request_subagent_input()` emits `subagent_input_required`, waits on the request-keyed broker, emits `subagent_input_resumed`, and returns the decision without persisting credential values.
- `invoke_skill` gates `credential_required` operations through that method only for managed child contexts; the existing main-agent error remains unchanged.

- [x] Add a test proving a child credential operation emits a request, waits, resumes on the exact request ID, and rejects without approval.
- [x] Run the HIL tests and observe the expected failure.
- [x] Bind the broker/event sink and implement the request/resume path with bounded event details.
- [x] Run the HIL and runtime regression tests until green.

### Task 3: Pinned acquisition transport for child-capable skills

**Files:**
- Modify: `backend/app/tools/crawler.py`
- Modify: `backend/app/skills/builtin/acquisition/gdc.py`
- Modify: `backend/app/skills/builtin/acquisition/pdb.py`
- Modify: `backend/app/skills/builtin/acquisition/xena.py`
- Test: `backend/tests/test_tools_crawler.py`
- Test: `backend/tests/test_skill_gdc.py`
- Test: `backend/tests/test_skill_pdb.py`
- Test: `backend/tests/test_skill_xena.py`

**Interfaces:**
- `CrawlerFacade` exposes bounded pinned JSON request support for GET/POST and the existing binary download path.
- GDC, PDB, and Xena use the facade whenever the RunContext has one; their old synchronous helpers are only used by isolated legacy unit contexts without a runtime facade.
- Child downloads are staged and registered as validated SourceAsset metadata before the tool returns.

- [x] Add facade-backed tests that prove acquisition calls use the injected transport and never call urllib in a managed context.
- [x] Run those tests and observe the expected failure.
- [x] Implement the minimal facade request helper and update the three skills while preserving existing fixture-test contracts.
- [x] Run all affected skill, crawler, and staging tests until green.

### Task 4: Full verification and integration

**Files:**
- Modify: `docs/REVIEW_2026-07-28.md`
- Modify: `docs/TODO.md`

- [x] Record the resolved boundaries and remaining limitations in the existing review/TODO documents.
- [ ] Run backend pytest, Ruff, compileall, frontend lint, tsc, tests, and build.
- [ ] Run the bounded Uvicorn health smoke and verify the exact process is stopped.
- [ ] Fetch the latest `origin/main`, merge it into this branch with the branch-scale merge strategy, rerun affected gates, then merge the feature branch into local `main` with `--no-ff`.
