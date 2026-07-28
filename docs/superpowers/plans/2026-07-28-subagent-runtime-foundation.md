# Subagent Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在父 Run 内提供可持久化、可并发、可取消、可恢复投影且支持局部 HIL 的托管式 SubagentSupervisor。

**Architecture:** 子 Agent 生命周期写入父 Task 的同一事件流，`TaskSnapshot` 由纯 reducer 重建；Supervisor 只管理执行资源和生命周期，具体研究逻辑由注入的 runner 实现。TaskManager 负责 durable event append、父 Run 取消传播和 API 协调。

**Tech Stack:** Python 3.12、FastAPI、Pydantic v2、asyncio、pytest、OpenAI Agents SDK 运行时外壳

## Global Constraints

- 单次批量委派最多 8 个子任务。
- 每个父 Run 最多同时运行 3 个子 Agent。
- 整个进程最多同时运行 4 个子 Agent。
- 每个子 Agent 默认最多 10 个模型 turns，默认总时限 15 分钟。
- 子 Agent 只有一层，不能递归委派。
- 所有事件使用父 Task 的单调递增 sequence。
- 子 Agent 模型流和隐藏推理不进入主聊天。
- 历史 schema version 1.0/2.0 事件必须继续解析；新增 linkage 字段仅用于 2.0。
- 不增加功能开关或旧执行路径。
- 每个任务形成干净提交后执行 `git fetch origin main` 和 `git rebase origin/main`；有冲突立即解决并重跑该任务测试。

---

### Task 1: Subagent contracts and event envelope linkage

**Files:**
- Modify: `backend/app/domain/contracts/enums.py`
- Modify: `backend/app/domain/contracts/events.py`
- Modify: `backend/app/domain/contracts/runtime.py`
- Modify: `backend/app/domain/contracts/__init__.py`
- Test: `backend/tests/contracts/test_event_contracts.py`
- Test: `backend/tests/contracts/test_runtime_contracts.py`

**Interfaces:**
- Produces: `SubagentType`, `SubagentStatus`, `SubagentErrorCode`, `SubagentRecord`, `SubagentRequest`, `SubagentResult`
- Produces: ten `Subagent*Payload` classes and optional `EventEnvelope.subagent_id` / `parent_tool_call_id`
- Consumes: existing `ContractModel`, `RuntimeEventType`, `build_event`

- [ ] **Step 1: Write failing contract tests**

```python
def test_subagent_event_requires_run_linkage() -> None:
    payload = SubagentQueuedPayload(
        subagent_id="subagent_1",
        agent_type=SubagentType.SOURCE_RESEARCH,
        objective="Find public cohort metadata",
    )
    event = build_event(
        task_id="task_1",
        run_id="run_1",
        sequence=1,
        payload=payload,
        subagent_id="subagent_1",
        parent_tool_call_id="call_1",
    )
    assert event.schema_version == "2.0"
    assert event.subagent_id == "subagent_1"
    assert event.parent_tool_call_id == "call_1"


def test_task_snapshot_defaults_to_no_subagents() -> None:
    snapshot = TaskSnapshot(task=_task_summary())
    assert snapshot.subagents == []
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/contracts/test_event_contracts.py tests/contracts/test_runtime_contracts.py -q`
Expected: collection fails because the Subagent contracts do not exist.

- [ ] **Step 3: Implement the contracts**

Add string enums with values `source_research`, `skill_builder`; statuses
`queued`, `running`, `completed`, `failed`, `cancel_requested`, `cancelled`,
`interrupted`; and the stable error codes from the design spec. Add
`SubagentRecord` with optional timestamps/result/error fields and
`TaskSnapshot.subagents: list[SubagentRecord] = Field(default_factory=list)`.

Extend `build_event` exactly as follows:

```python
def build_event(
    *,
    task_id: str,
    sequence: int,
    payload: EventPayload,
    run_id: str | None = None,
    stage_attempt_id: str | None = None,
    subagent_id: str | None = None,
    parent_tool_call_id: str | None = None,
    timestamp: datetime | None = None,
    schema_version: Literal["1.0", "2.0"] | None = None,
) -> EventEnvelope:
```

Validate that either linkage field requires schema `2.0`, `run_id`, and a
non-empty matching `payload.subagent_id` for dedicated subagent events.

- [ ] **Step 4: Verify GREEN and compatibility**

Run: `uv run pytest tests/contracts/test_event_contracts.py tests/contracts/test_runtime_contracts.py tests/pipeline/test_event_envelope_unified.py -q`
Expected: all selected tests pass.

- [ ] **Step 5: Commit and sync main**

```bash
git add backend/app/domain/contracts backend/tests/contracts
git commit -m "feat: add durable subagent contracts"
git fetch origin main
git rebase origin/main
```

### Task 2: Pure reducer projection

**Files:**
- Modify: `backend/app/runtime/state.py`
- Test: `backend/tests/runtime/test_state_reducer_subagents.py`
- Test: `backend/tests/runtime/test_repository.py`

**Interfaces:**
- Consumes: `TaskSnapshot.subagents` and all dedicated Subagent payloads from Task 1
- Produces: deterministic `reduce_task_event(snapshot, event)` transitions

- [ ] **Step 1: Write failing lifecycle tests**

```python
def test_reducer_projects_subagent_lifecycle() -> None:
    snapshot = _snapshot()
    snapshot = reduce_task_event(snapshot, _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=3))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=4))
    record = snapshot.subagents[0]
    assert record.status == SubagentStatus.COMPLETED
    assert record.source_asset_ids == ["source_1"]
    assert record.finished_at is not None


def test_reducer_rejects_completed_to_running_transition() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=3))
    with pytest.raises(ValueError, match="invalid subagent transition"):
        reduce_task_event(snapshot, _started_event(sequence=4))
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/runtime/test_state_reducer_subagents.py -q`
Expected: fail because reducer has no subagent branches.

- [ ] **Step 3: Implement minimal immutable projection**

Use `_subagent_index(snapshot, subagent_id)` and one explicit transition table:

```python
_SUBAGENT_TRANSITIONS: dict[SubagentStatus, frozenset[SubagentStatus]] = {
    SubagentStatus.QUEUED: frozenset({
        SubagentStatus.RUNNING,
        SubagentStatus.CANCEL_REQUESTED,
        SubagentStatus.CANCELLED,
        SubagentStatus.INTERRUPTED,
    }),
    SubagentStatus.RUNNING: frozenset({
        SubagentStatus.COMPLETED,
        SubagentStatus.FAILED,
        SubagentStatus.CANCEL_REQUESTED,
        SubagentStatus.CANCELLED,
        SubagentStatus.INTERRUPTED,
    }),
    SubagentStatus.CANCEL_REQUESTED: frozenset({
        SubagentStatus.CANCELLED,
        SubagentStatus.COMPLETED,
        SubagentStatus.FAILED,
        SubagentStatus.INTERRUPTED,
    }),
    SubagentStatus.COMPLETED: frozenset(),
    SubagentStatus.FAILED: frozenset(),
    SubagentStatus.CANCELLED: frozenset(),
    SubagentStatus.INTERRUPTED: frozenset(),
}
```

Duplicate identical terminal events are idempotent; conflicting terminal events
raise `ValueError`. Progress and HIL events update only the matching record.

- [ ] **Step 4: Verify GREEN and repository replay**

Run: `uv run pytest tests/runtime/test_state_reducer_subagents.py tests/runtime/test_repository.py -q`
Expected: all selected tests pass and a repository rebuilt from events contains the same subagent record.

- [ ] **Step 5: Commit and sync main**

```bash
git add backend/app/runtime/state.py backend/tests/runtime
git commit -m "feat: project subagents from durable events"
git fetch origin main
git rebase origin/main
```

### Task 3: Supervisor concurrency, waiting, timeout, and cancellation

**Files:**
- Create: `backend/app/subagents/__init__.py`
- Create: `backend/app/subagents/supervisor.py`
- Test: `backend/tests/subagents/test_supervisor.py`

**Interfaces:**
- Produces: `SubagentRunner` protocol
- Produces: `SubagentEventSink` protocol
- Produces: `SubagentSupervisor.start_batch`, `wait`, `cancel`, `cancel_run`, `shutdown`
- Consumes: contracts from Task 1

- [ ] **Step 1: Write failing concurrency tests**

```python
@pytest.mark.asyncio
async def test_supervisor_enforces_per_run_and_global_limits() -> None:
    runner = BlockingRunner()
    sink = RecordingSink()
    supervisor = SubagentSupervisor(global_limit=4, per_run_limit=3)
    await supervisor.start_batch(
        task_id="task_1",
        run_id="run_1",
        parent_tool_call_id="call_1",
        requests=[_request(index) for index in range(8)],
        runner=runner,
        sink=sink,
    )
    await runner.wait_until_started(3)
    assert runner.active_for_run("run_1") == 3
    assert runner.max_active_total <= 4
    await supervisor.cancel_run("task_1", "run_1", reason="test cleanup")
    await supervisor.shutdown()


@pytest.mark.asyncio
async def test_supervisor_rejects_more_than_eight_requests() -> None:
    supervisor = SubagentSupervisor()
    with pytest.raises(ValueError, match="at most 8"):
        await supervisor.start_batch(
            task_id="task_1",
            run_id="run_1",
            parent_tool_call_id="call_1",
            requests=[_request(index) for index in range(9)],
            runner=ImmediateRunner(),
            sink=RecordingSink(),
        )
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/subagents/test_supervisor.py -q`
Expected: collection fails because `app.subagents.supervisor` is absent.

- [ ] **Step 3: Implement the minimal supervisor**

Define these exact protocols:

```python
class SubagentEventSink(Protocol):
    async def emit(
        self,
        *,
        task_id: str,
        run_id: str,
        subagent_id: str,
        parent_tool_call_id: str,
        payload: EventPayload,
    ) -> None: ...


class SubagentRunner(Protocol):
    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult: ...
```

Use one global `asyncio.Semaphore`, one per-run semaphore, and tracked
`asyncio.Task[SubagentResult]` objects. Wrap runner execution with
`asyncio.timeout(900)`. Emit queued before scheduling, started after both
semaphores are acquired, and exactly one terminal event in `finally`-safe
control flow.

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/subagents/test_supervisor.py -q`
Expected: batch, global/per-run concurrency, timeout, individual cancel,
run cancel, and shutdown tests all pass without pending-task warnings.

- [ ] **Step 5: Commit and sync main**

```bash
git add backend/app/subagents backend/tests/subagents
git commit -m "feat: add managed subagent supervisor"
git fetch origin main
git rebase origin/main
```

### Task 4: Keyed subagent HIL broker and REST cancellation

**Files:**
- Create: `backend/app/subagents/input_broker.py`
- Modify: `backend/app/subagents/supervisor.py`
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/api/routes.py`
- Test: `backend/tests/subagents/test_input_broker.py`
- Test: `backend/tests/api/test_rest_control.py`
- Test: `backend/tests/runtime/test_manager.py`

**Interfaces:**
- Produces: `SubagentInputBroker.request`, `resume`, `cancel_subagent`, `cancel_run`
- Produces: `TaskManager.cancel_subagent`
- Extends: `TaskManager.resume_run` request-id routing
- Produces: `POST /tasks/{task_id}/runs/{run_id}/subagents/{subagent_id}/cancel`

- [ ] **Step 1: Write failing broker and API tests**

```python
@pytest.mark.asyncio
async def test_resume_targets_only_matching_subagent_request() -> None:
    broker = SubagentInputBroker()
    first = asyncio.create_task(broker.request(_input_request("request_1", "sub_1")))
    second = asyncio.create_task(broker.request(_input_request("request_2", "sub_2")))
    await broker.resume("request_1", decision="approve", detail={"confirmed": True})
    assert (await first).decision == "approve"
    assert not second.done()
    await broker.cancel_subagent("sub_2")


async def test_cancel_subagent_endpoint(client, running_subagent) -> None:
    response = await client.post(
        f"/api/v1/tasks/{running_subagent.task_id}/runs/"
        f"{running_subagent.run_id}/subagents/{running_subagent.subagent_id}/cancel"
    )
    assert response.status_code == 202
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/subagents/test_input_broker.py tests/api/test_rest_control.py -q`
Expected: fail because broker and route do not exist.

- [ ] **Step 3: Implement keyed routing**

Keep a `dict[str, PendingSubagentInput]` guarded by `asyncio.Lock`. `request`
rejects duplicate request IDs; `resume` atomically removes and resolves exactly
one Future; cancel methods resolve matching Futures with `CancelledError`.
`TaskManager.resume_run` first calls `broker.try_resume(request_id, ...)`; only a
false return continues to the existing executor resume channel.

- [ ] **Step 4: Verify GREEN and sibling progress**

Run: `uv run pytest tests/subagents/test_input_broker.py tests/api/test_rest_control.py tests/runtime/test_manager.py -q`
Expected: all selected tests pass; one waiting child does not change the parent
Run status and does not prevent a sibling from completing.

- [ ] **Step 5: Commit and sync main**

```bash
git add backend/app/subagents backend/app/runtime/manager.py backend/app/api/routes.py backend/tests
git commit -m "feat: add subagent control and input routing"
git fetch origin main
git rebase origin/main
```

### Task 5: Lifespan ownership, durable sink, and restart interruption

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/runtime/repository.py`
- Create: `backend/app/subagents/event_sink.py`
- Test: `backend/tests/subagents/test_event_sink.py`
- Test: `backend/tests/runtime/test_manager.py`
- Create: `backend/tests/api/test_app_lifespan.py`

**Interfaces:**
- Produces: `DurableSubagentEventSink`
- Makes: `app.state.subagent_supervisor` and `app.state.subagent_input_broker`
- Consumes: repository atomic append/reducer path and Supervisor from Task 3

- [ ] **Step 1: Write failing persistence and recovery tests**

```python
@pytest.mark.asyncio
async def test_durable_sink_appends_and_publishes_one_event(repository, hub) -> None:
    sink = DurableSubagentEventSink(repository=repository, hub=hub)
    await sink.emit(
        task_id="task_1",
        run_id="run_1",
        subagent_id="sub_1",
        parent_tool_call_id="call_1",
        payload=_queued_payload(),
    )
    snapshot = await repository.get_snapshot("task_1")
    assert snapshot.subagents[0].subagent_id == "sub_1"
    assert snapshot.task.latest_sequence == 2


@pytest.mark.asyncio
async def test_startup_interrupts_nonterminal_subagents(runtime_factory) -> None:
    runtime = await runtime_factory(snapshot=_snapshot_with_running_subagent())
    await runtime.start()
    snapshot = await runtime.repository.get_snapshot("task_1")
    assert snapshot.subagents[0].status == SubagentStatus.INTERRUPTED
```

- [ ] **Step 2: Verify RED**

Run: `uv run pytest tests/subagents/test_event_sink.py tests/api/test_app_lifespan.py -q`
Expected: fail because durable sink and lifespan state are absent.

- [ ] **Step 3: Implement ownership and recovery**

Construct broker, sink, and supervisor in `create_app` lifespan after repository,
hub, and manager. Attach Supervisor to TaskManager. On shutdown, cancel active
children before stopping TaskManager. During recovery, append
`subagent_interrupted` for every nonterminal record after the parent Run
interruption event, preserving Task-local sequence order.

- [ ] **Step 4: Run runtime foundation gates**

Run: `uv run pytest tests/contracts tests/subagents tests/runtime tests/api/test_rest_control.py tests/api/test_app_lifespan.py -q`
Expected: all selected tests pass with no asyncio resource warnings.

Run: `uv run ruff check app/ tests/`
Expected: zero warnings.

- [ ] **Step 5: Commit and sync main**

```bash
git add backend/app backend/tests
git commit -m "feat: integrate durable subagent runtime"
git fetch origin main
git rebase origin/main
```
