# Core Architecture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SDK-centric demo skeleton with typed task contracts, a durable task state machine, a replaceable AgentRuntime port, safe workspace tools, and a stable frontend event protocol.

**Architecture:** Application code owns tasks, state transitions, event envelopes, persistence, and safety. OpenAI Agents SDK is isolated under `infrastructure/openai_agents` and maps SDK stream events into runtime-neutral events. The first slice retains the existing WebSocket interaction while making it testable and resumable at task metadata level.

**Tech Stack:** Python 3.12, Pydantic v2, sqlite3, FastAPI, openai-agents 0.18.2, pytest, React 18, TypeScript 5.9, Zustand, Vitest.

## Global Constraints

- The only required user business input is a non-empty research topic.
- The product must not generate scientific or clinical conclusions.
- Only `backend/app/infrastructure/openai_agents/` may import `agents` or `openai`.
- Every production behavior is introduced by a failing test first.
- Task IDs match `^[A-Za-z0-9_-]{1,64}$`.
- AgentEvent sequences are strictly increasing within one task run.
- File tools reject absolute paths and any resolved path outside the task workspace.

---

### Task 1: Test Infrastructure and Domain Contracts

**Files:**
- Modify: `backend/pyproject.toml`
- Create: `backend/tests/test_domain_contracts.py`
- Create: `backend/app/domain/__init__.py`
- Create: `backend/app/domain/task.py`
- Create: `backend/app/domain/events.py`

**Interfaces:**
- Produces: `TaskRequest`, `TaskRecord`, `TaskStatus`, `TaskStateMachine`, `AgentEvent`, `EventFactory`.

- [ ] **Step 1: Add pytest and pytest-asyncio as development dependencies and create the failing domain tests.**

```python
def test_topic_is_the_only_required_business_input():
    request = TaskRequest(topic="pancreatic cancer GEO datasets")
    assert request.topic == "pancreatic cancer GEO datasets"

def test_empty_topic_is_rejected():
    with pytest.raises(ValidationError):
        TaskRequest(topic="   ")

def test_state_machine_rejects_invalid_transition():
    with pytest.raises(InvalidTaskTransition):
        TaskStateMachine.transition(TaskStatus.CREATED, TaskStatus.COMPLETED)

def test_event_factory_increments_sequence():
    factory = EventFactory(task_id="task-1", run_id="run-1")
    assert factory.create(EventType.TASK_CREATED, {}).sequence == 1
    assert factory.create(EventType.STATUS_CHANGED, {}).sequence == 2
```

- [ ] **Step 2: Run `uv run --frozen pytest tests/test_domain_contracts.py -q` from `backend/` and verify import failures.**
- [ ] **Step 3: Implement the Pydantic models, transition table, event enum and event factory.**
- [ ] **Step 4: Re-run the test and verify all domain tests pass.**

### Task 2: Task Repository and Application Service

**Files:**
- Create: `backend/tests/test_task_service.py`
- Create: `backend/app/ports/__init__.py`
- Create: `backend/app/ports/task_repository.py`
- Create: `backend/app/infrastructure/persistence/__init__.py`
- Create: `backend/app/infrastructure/persistence/sqlite_task_repository.py`
- Create: `backend/app/application/__init__.py`
- Create: `backend/app/application/task_service.py`

**Interfaces:**
- Consumes: `TaskRequest`, `TaskRecord`, `TaskStatus`, `EventFactory`.
- Produces: `TaskRepository`, `SqliteTaskRepository`, `TaskService.create_task()`, `TaskService.stream_task()`.

- [ ] **Step 1: Write failing tests for create/read, legal status updates, generated task IDs and persisted failures.**
- [ ] **Step 2: Run `uv run --frozen pytest tests/test_task_service.py -q` and verify missing repository/service failures.**
- [ ] **Step 3: Implement the repository Protocol and sqlite3 repository using JSON serialization of Pydantic models.**
- [ ] **Step 4: Implement `TaskService` so application events and runtime events share one `EventFactory`.**
- [ ] **Step 5: Re-run domain and task service tests.**

### Task 3: AgentRuntime Port and OpenAI Agents Adapter

**Files:**
- Create: `backend/tests/test_openai_agents_runtime.py`
- Create: `backend/app/ports/agent_runtime.py`
- Create: `backend/app/infrastructure/openai_agents/__init__.py`
- Create: `backend/app/infrastructure/openai_agents/model.py`
- Create: `backend/app/infrastructure/openai_agents/agent_factory.py`
- Create: `backend/app/infrastructure/openai_agents/runtime.py`
- Modify: `backend/app/agent_loop/model.py`
- Modify: `backend/app/agent_loop/agent.py`
- Modify: `backend/app/agent_loop/runner.py`

**Interfaces:**
- Produces: `AgentRunRequest`, `RuntimeEvent`, `AgentRuntime`, `OpenAIAgentsRuntime`.
- Consumes: ordinary application tools from Task 4 through constructor injection.

- [ ] **Step 1: Write failing synthetic-event tests proving text delta mapping, tool event mapping and function-argument delta rejection.**
- [ ] **Step 2: Run the targeted test with `uv run --frozen pytest tests/test_openai_agents_runtime.py -q`.**
- [ ] **Step 3: Implement the port and pure `map_stream_event()` function.**
- [ ] **Step 4: Implement `OpenAIAgentsRuntime.stream()` and move model/agent construction behind infrastructure.**
- [ ] **Step 5: Convert old `agent_loop/*` modules into compatibility imports without direct SDK imports.**
- [ ] **Step 6: Run the adapter and domain test suites.**

### Task 4: Safe Workspace Tool Boundary

**Files:**
- Create: `backend/tests/test_workspace_service.py`
- Create: `backend/app/application/workspace_service.py`
- Create: `backend/app/infrastructure/openai_agents/tool_adapter.py`
- Modify: `backend/app/tools/io.py`
- Modify: `backend/app/tools/search.py`
- Modify: `backend/app/tools/parse.py`
- Modify: `backend/app/tools/analyze.py`
- Modify: `backend/app/tools/_registry.py`

**Interfaces:**
- Produces: `WorkspaceService.read_text()`, `write_text()`, `list_files()`, `build_agent_tools()`.

- [ ] **Step 1: Write failing tests for valid relative access, absolute path rejection, `..` rejection and workspace isolation.**
- [ ] **Step 2: Run the targeted tests and verify failures against the current permissive implementation.**
- [ ] **Step 3: Implement safe resolution using `Path.resolve()` plus `is_relative_to(workspace_root)`.**
- [ ] **Step 4: Build SDK FunctionTools only in `infrastructure/openai_agents/tool_adapter.py`; convert old modules to runtime-neutral compatibility helpers.**
- [ ] **Step 5: Run workspace and architecture boundary tests.**

### Task 5: WebSocket Task Integration

**Files:**
- Create: `backend/tests/test_ws_protocol.py`
- Modify: `backend/app/config.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/api/ws.py`

**Interfaces:**
- Consumes: `TaskService`, `SqliteTaskRepository`, `OpenAIAgentsRuntime`.
- Produces: versioned JSON `AgentEvent` envelopes on `/api/v1/ws`.

- [ ] **Step 1: Write a failing FastAPI WebSocket test with a fake runtime and temporary SQLite repository.**
- [ ] **Step 2: Verify the test fails because the endpoint emits legacy unversioned dictionaries.**
- [ ] **Step 3: Add database/workspace settings and an application composition root in `main.py`.**
- [ ] **Step 4: Route run messages through `TaskService`; reject invalid JSON, empty input and invalid task IDs with typed failure events.**
- [ ] **Step 5: Run backend tests and import the FastAPI application.**

### Task 6: Frontend Connection Ownership and Event Protocol

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/tsconfig.json`
- Modify: `frontend/tsconfig.app.json`
- Modify: `frontend/tsconfig.node.json`
- Modify: `.gitignore`
- Add: `frontend/src/lib/utils.ts` to version control
- Create: `frontend/src/services/agentSocket.ts`
- Create: `frontend/src/services/agentSocket.test.ts`
- Modify: `frontend/src/hooks/useAgentStream.ts`
- Modify: `frontend/src/stores/agentStore.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`

**Interfaces:**
- Produces: one `AgentSocketClient` per Hook instance and typed `AgentEvent` consumption.

- [ ] **Step 1: Add Vitest and write a failing test proving one client both connects and sends.**
- [ ] **Step 2: Run `pnpm test --run` and verify the missing client failure.**
- [ ] **Step 3: Implement `AgentSocketClient`, adapt the Hook, and make ChatPanel own connect/send/cleanup.**
- [ ] **Step 4: Update the store to consume `event_type` and payload from the internal envelope.**
- [ ] **Step 5: Correct TypeScript deprecation settings and `.gitignore`; run Vitest, `pnpm tsc`, and `pnpm build`.**

### Task 7: Architecture Enforcement and Documentation

**Files:**
- Create: `backend/tests/test_architecture_boundaries.py`
- Create: `docs/architecture/ADR-001-agent-runtime.md`
- Create: `docs/architecture/ADR-002-skill-tool-boundary.md`
- Create: `docs/architecture/ADR-003-data-provenance.md`
- Modify: `backend/README.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Enforces: SDK imports remain isolated; documentation matches executable architecture.

- [ ] **Step 1: Write a failing AST-based test that reports every `agents/openai` import outside the allowed infrastructure directory.**
- [ ] **Step 2: Remove remaining boundary violations until the test passes.**
- [ ] **Step 3: Write the three ADRs, backend run/test instructions, and replace inaccurate completed markers in the affected TODO sections.**
- [ ] **Step 4: Run full backend and frontend verification, `git diff --check`, and inspect `git status`.**

## Plan Self-Review

- The plan covers every requirement in the approved foundation design.
- Every production behavior has an explicit preceding failing test.
- SDK types are contained by the AgentRuntime and Tool adapter boundaries.
- The frontend and backend consume the same versioned event names.
- Real data sources, advanced Skills and full provenance storage are intentionally excluded from this slice.

