# P1 后端运行时实施计划（B1 / C1a / C5c / C5d / C5e）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成后端运行时四个缺口：B1（P0）版本化 TaskSpecification 随 Run 持久化；C1a（Important）publication finalize 原子提交；C5c reducer 对迟到事件硬化；C5d/C5e 强键字典清理与分页约束。

**Architecture:** 契约层扩展（`RunQueuedPayload` + `RunRecord` 携带可选 `specification`，向后兼容 None）→ 管理面接受并持久化 → 快照投影。finalize 路径把发布提交与 `RunCompletedPayload` 收敛到同一锁内原子提交，崩溃窗口由现有 `.runtime-publication.json` marker 恢复逻辑闭合（manager.py:1440 已有恢复，本计划补上提交顺序与注入测试）。reducer 对 terminal 后到达的"可容忍迟到"事件（operation/tool/进度类）改为忽略并计数告警，仅对权威状态事件保留严格性。

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 / pytest（asyncio strict，warnings-as-errors）。

## Global Constraints

- 契约字段一律向后兼容：新字段必须 `| None = None` 或带默认值；旧 `events.jsonl` 重放不破坏。
- 每个 Task：先写失败测试 → 确认红 → 实现 → 绿 → 提交（`fix: ...` / `feat: ...`）。
- 质量门（每个 Task 后跑）：`cd backend && source .venv/bin/activate && ruff check app/ tests/ launcher.py && pytest -q`。
- 更新 `docs/archive/LEFTOVERS-2026-08-09.md` 对应条目：✅ 已修 + commit hash。

---

### Task 1: B1a — 契约层：Run 事件链携带版本化 TaskSpecification

**Files:**
- Modify: `backend/app/domain/contracts/events.py:214`（`RunQueuedPayload`）
- Modify: `backend/app/domain/contracts/runtime.py:47`（`RunRecord`）
- Modify: `backend/app/runtime/state.py`（reducer 投影 `run_queued` → `RunRecord`）
- Test: `backend/tests/contracts/test_runtime_contracts.py`、`backend/tests/runtime/test_task_snapshot.py`（找现有 reducer 测试文件，若无则建 `backend/tests/runtime/test_run_specification.py`）

**Interfaces:**
- Consumes: `app.domain.contracts.task.TaskSpecification`（已存在，ContractModel，含 `schema_version: Literal["1.0"]`）
- Produces:
  - `RunQueuedPayload.specification: TaskSpecification | None = None`
  - `RunRecord.specification: TaskSpecification | None = None`
  - reducer：`run_queued` 事件携带 spec 时投影到 `RunRecord.specification`；缺失时保持 None

- [ ] **Step 1: 写失败测试**

```python
# tests/contracts/test_runtime_contracts.py（追加）
def test_run_queued_payload_carries_versioned_specification():
    spec = TaskSpecification(topic="TP53 表达差异")
    payload = RunQueuedPayload(
        request_id="req_1", input="开始", request_fingerprint="0" * 64,
        specification=spec,
    )
    assert payload.specification == spec
    assert payload.specification.schema_version == "1.0"
    # 向后兼容：旧载荷无 specification
    legacy = RunQueuedPayload.model_validate_json(
        '{"type":"run_queued","request_id":"r","input":"x",'
        '"request_fingerprint":"' + "0" * 64 + '"}'
    )
    assert legacy.specification is None
```

reducer 投影测试（新文件 `tests/runtime/test_run_specification.py`，风格对齐 `tests/runtime/test_state_reducer.py`）：

```python
from app.runtime.state import reduce_task_event

# 复用 test_state_reducer.py 的 empty_snapshot()/build_event() 构造风格
async def test_reducer_projects_specification_onto_run_record():
    spec = TaskSpecification(topic="TP53 表达差异")
    snapshot = reduce_task_event(
        empty_snapshot(),
        build_event(
            task_id="task_spec", run_id="run_1", sequence=1,
            timestamp=NOW, payload=RunQueuedPayload(
                request_id="req_1", input="开始", specification=spec,
            ),
        ),
    )
    assert snapshot.runs[0].specification == spec
    assert snapshot.runs[0].specification.schema_version == "1.0"
```

（`build_event`/`empty_snapshot` 的定义从 `tests/runtime/test_state_reducer.py` 头部复制——计划不重复粘贴现有 helper，执行时直接 import 或复制该文件内的同名 helper。）

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/contracts/test_runtime_contracts.py tests/runtime/test_run_specification.py -q`
Expected: FAIL（`RunQueuedPayload` 无 `specification` 字段 / 投影缺失；若 `test_run_specification.py` 的 helper 缺失也会红——先复制 `test_state_reducer.py` 的 `empty_snapshot`/`build_event`）

- [ ] **Step 3: 实现契约字段**

```python
# events.py RunQueuedPayload
class RunQueuedPayload(ContractModel):
    type: Literal[PipelineEventType.RUN_QUEUED] = PipelineEventType.RUN_QUEUED
    request_id: str = Field(min_length=1)
    input: str = Field(min_length=1)
    request_fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    specification: TaskSpecification | None = None  # B1: 新 Run 携带版本化 spec
```

```python
# runtime.py RunRecord（追加字段）
    error: str | None = Field(default=None, min_length=1)
    summary: RunSummary | None = Field(default=None)
    specification: TaskSpecification | None = None
```

reducer：在 `app/runtime/state.py` 的 `run_queued` 分支（`reduce_task_event` 内）追加投影——读现有分支后添加：

```python
    specification=payload.specification,
```

（以现有 RunRecord 构造处为准，只加一行字段透传。）

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/contracts/test_runtime_contracts.py tests/runtime/test_run_specification.py -q`
Expected: PASS；随后 `ruff check app/domain/contracts/ app/runtime/state.py`

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(B1a): RunQueuedPayload/RunRecord 携带版本化 TaskSpecification（向后兼容）"
```

---

### Task 2: B1b — POST /tasks 接受 specification 并持久化

**Files:**
- Modify: `backend/app/api/routes.py`（`create_task` 请求体 ~:526 起，找 `TaskCreateRequest`/等价模型）
- Modify: `backend/app/runtime/manager.py:1040-1060`（`enqueue_run` 把 spec 写入 `RunQueuedPayload`）
- Test: `backend/tests/api/test_task_api.py`（找现有创建任务测试）

**Interfaces:**
- Consumes: `RunQueuedPayload.specification`（Task 1 产出）
- Produces: 创建任务请求体可选字段 `specification: TaskSpecification | None = None`；`manager.enqueue_run` 透传到 `RunQueuedPayload`

- [ ] **Step 1: 写失败测试**

```python
async def test_create_task_with_specification_persists_on_run():
    async with api_client(tmp_path) as (app, client):
        response = await client.post("/api/v1/tasks", json={
            "mode": "agent",
            "topic": "TP53 表达差异",
            "specification": {"topic": "TP53 表达差异"},
        })
        assert response.status_code == 202
        task_id = response.json()["task_id"]
        events = (await client.get(f"/api/v1/tasks/{task_id}/events")).json()["events"]
        queued = next(e for e in events if e["payload"]["type"] == "run_queued")
        assert queued["payload"]["specification"]["topic"] == "TP53 表达差异"
        snapshot = (await client.get(f"/api/v1/tasks/{task_id}")).json()
        assert snapshot["runs"][0]["specification"]["schema_version"] == "1.0"
```

（`api_client` fixture 与字段名以 `tests/api/test_task_api.py` 现有约定为准。）

- [ ] **Step 2: 运行确认失败** — `pytest tests/api/test_task_api.py -q`，Expected: FAIL（请求体无 specification 字段）

- [ ] **Step 3: 实现** — 请求模型加字段 + 创建路径透传 + `manager.enqueue_run` 或等价入口把 `specification` 放进 `RunQueuedPayload`（读 routes.py 的创建→manager 调用链，最小改两处）

- [ ] **Step 4: 运行确认通过** — 上述测试 PASS + 全量 `pytest tests/api/ -q` 回归

- [ ] **Step 5: 提交**

```bash
git commit -am "feat(B1b): POST /tasks 接受版本化 specification 并持久化到 run"
```

---

### Task 3: C1a — finalize 原子提交（publication + run_completed 同锁收敛）

**Files:**
- Modify: `backend/app/runtime/manager.py`（finalize 路径，`PublicationCreatedPayload` emit :1521、`RunCompletedPayload` emit :1879-1886 的汇聚点）
- Modify: `backend/app/datasets/build/expression_runner.py`（发布提交侧，如需要）
- Test: `backend/tests/runtime/test_finalize_atomicity.py`（新建）

**Interfaces:**
- Consumes: 现有 `.runtime-publication.json` marker 机制与 `_recover` 恢复逻辑（manager.py:1440，保留）
- Produces: 一个 `finalize_run_atomically(task_id, run_id, publication, build_result)` 内部协程（或等价收敛函数），在同一 task 锁内完成：发布目录落盘 → marker 落盘 → `PublicationCreatedPayload` + `RunCompletedPayload` 追加 → 快照刷新。任意一步失败 → 不产生部分终态（已落盘的 marker 由恢复逻辑闭合）。

- [ ] **Step 1: 写失败测试（崩溃注入）**

```python
async def test_finalize_crash_window_leaves_no_orphan_publication():
    # 构造：monkeypatch finalize 中间步骤（marker 落盘后、事件追加前）抛异常
    async with api_client(tmp_path) as (app, client):
        repo = app.state.task_repository
        # 用现有 fixture 种子一个 V2 构建完成的任务（参考 tests/api/test_artifact_api.py 的 seed）
        # 然后 monkeypatch manager 的 finalize 汇聚点，使其在事件追加前 raise
        # When: 触发 finalize
        # Then:
        #   1) 任务最终状态为 FAILED（或 COMPLETED 但带恢复标记），绝不出现
        #      "已发布 + run 非成功" 的孤立产物
        #   2) 恢复路径（重新构造 manager）能把 marker 闭合为合法终态
        snapshot = await repo.get_snapshot(task_id)
        assert snapshot is not None
        runs = [r for r in snapshot.runs if r.run_id == run_id]
        assert runs and runs[0].status in (RunStatus.COMPLETED, RunStatus.FAILED)
```

（测试以现有 `tests/runtime/test_fixture_executor.py` / `test_compaction_atomicity.py` 的注入风格为准——先读这两个文件再写。）

- [ ] **Step 2: 运行确认失败** — 新测试 FAIL（当前窗口存在：marker 已落盘但事件缺失时，manager 恢复逻辑可能把 run 标 COMPLETED 而 publication 事件缺席——断言体现"无孤立"）

- [ ] **Step 3: 实现** — 读 `manager.py` 的 `_finalize`（或等价函数，:1440-1540 区域）与 expression_runner 的发布提交点，收敛为单一原子提交；保持 marker 写盘为 write-ahead，事件追加为最后一步；异常路径统一走现有 `_recover`

- [ ] **Step 4: 运行确认通过** — 新测试 PASS + `pytest -q tests/runtime/ tests/api/ -q` 全绿

- [ ] **Step 5: 提交**

```bash
git commit -am "fix(C1a): finalize 原子提交 — publication 落盘与 run_completed 事件同锁收敛，崩溃窗口由 marker 恢复闭合"
```

---

### Task 4: C5c — reducer 对 terminal 后迟到事件硬化

**Files:**
- Modify: `backend/app/runtime/state.py:278,392`（`terminal run is immutable` 抛错点）
- Test: `backend/tests/runtime/test_task_snapshot.py`（或 state 现有测试文件）

**Interfaces:**
- Consumes: `reduce_task_event` 现有签名（`app/runtime/state.py:185`）
- Produces: 迟到事件分类表：**可容忍**（`operation_*`、`tool_*`、`assistant_*`、`stage_progress`、`warning` 等非权威事件）→ 忽略并累计 `dropped_late_events` 计数（snapshot 可查）；**权威**（`run_completed`/`run_failed`/`publication_created` 等）→ 保留抛错（防静默覆盖）。

- [ ] **Step 1: 写失败测试**

```python
async def test_late_operation_event_after_terminal_run_is_tolerated():
    snapshot = ...  # 构造一个 COMPLETED 的 run（用现有 fixture）
    reduced = reduce_task_event(
        snapshot,
        OperationStartedPayload(operation_id="op_1", label="检索", category="discovery"),
    )
    # 不抛错；计数可见
    assert reduced.runs[0].dropped_late_events >= 1
```

```python
async def test_late_authoritative_event_still_rejected():
    with pytest.raises(ValueError, match="terminal run is immutable"):
        reduce_task_event(snapshot, RunCompletedPayload(run_id=..., build_result=...))
```

- [ ] **Step 2: 运行确认失败** — `pytest tests/runtime/test_task_snapshot.py -q`（当前第一用例抛 ValueError）

- [ ] **Step 3: 实现** — 在 :278/:392 的抛错分支前，按事件类型分流：可容忍事件 → `return snapshot`（或带计数的新快照）；权威事件 → 维持 raise

- [ ] **Step 4: 运行确认通过** — 新用例 PASS + 全量 `pytest tests/runtime/ -q` 回归（现有测试可能断言抛错——如 `test_compaction`/replay 测试，检查并只更新"前提即 bug"的断言）

- [ ] **Step 5: 提交**

```bash
git commit -am "fix(C5c): reducer 对 terminal 后迟到事件硬化 — 可容忍事件忽略计数，权威事件保持严格"
```

---

### Task 5: C5d/C5e — 强键字典清理 + list_tasks 分页约束

**Files:**
- Modify: `backend/app/runtime/manager.py`（`_task_locks`）、`backend/app/runtime/repository.py`（`_task_locks`）、`backend/app/runtime/event_store.py`（`_checkpoints`）
- Modify: `backend/app/runtime/index.py:188`（`list_tasks`）
- Test: `backend/tests/runtime/test_task_manager.py`（或现有 manager/index 测试）

**Interfaces:**
- Consumes: 任务删除路径（`DELETE /tasks/{id}`）与终态路径
- Produces: `_task_locks`/`_checkpoints` 在任务删除与终态收尾时 `del`；`TaskIndex.list_tasks(limit=...)` 的 active 列表按 limit 截断（cursor 分页语义保持）

- [ ] **Step 1: 写失败测试**

```python
async def test_task_locks_cleared_after_terminal_or_delete():
    manager = ...  # 现有 fixture
    await manager.enqueue_run(...)  # 让 task 进入活跃态，锁被创建
    assert task_id in manager._task_locks
    await manager.delete_task(task_id)  # 或驱动终态
    assert task_id not in manager._task_locks
```

```python
async def test_list_tasks_active_respects_limit():
    index = ...  # 现有 fixture，seed 多个活跃任务
    page = await index.list_tasks(limit=3)
    assert len(page.items) <= 3
```

- [ ] **Step 2: 运行确认失败** — 两用例 FAIL（当前锁不清理 / active 不限）

- [ ] **Step 3: 实现** — 删除路径加 `self._task_locks.pop(task_id, None)`；EventStore 同任务清理 `_checkpoints`；`list_tasks` 的 active 聚合查询加 limit（读 index.py:412 的 SQL 聚合处，`LIMIT ?` 绑定）

- [ ] **Step 4: 运行确认通过** — 新用例 PASS + `pytest tests/runtime/ tests/api/ -q` 回归

- [ ] **Step 5: 提交**

```bash
git commit -am "fix(C5d/e): 强键字典随任务终态清理 + list_tasks active 分页约束"
```

---

### Task 6: C1c — 重启丢弃 pending HIL prompt 显式化

**Files:**
- Modify: `backend/app/runtime/manager.py`（`_recover`，:1380-1440 区域，AWAITING_USER_INPUT run 的恢复分支）
- Modify: `backend/app/domain/contracts/events.py`（新增 `PromptInvalidatedPayload`，或复用现有 warning 事件——以 contracts 现有事件表为准，grep `prompt_invalidated`/`user_input` 先确认）
- Test: `backend/tests/runtime/test_state_reducer_user_input.py`（追加）

**Interfaces:**
- Consumes: `_recover` 现有恢复逻辑（已对 RUNNING/AWAITING_USER_INPUT 重放 input）；`UserInputRequiredPayload` 契约
- Produces: 重启后对无法恢复的 pending HIL 请求发射 `prompt_invalidated`（或等价显式事件），前端可展示"该请求已失效"；不静默丢弃

- [ ] **Step 1: 写失败测试** — 构造：run 处于 AWAITING_USER_INPUT 且 broker 未持久化（重启前无 resume 通道）→ 重建 manager 触发 `_recover` → 断言 emit 了 `prompt_invalidated` 事件（当前静默）
- [ ] **Step 2: 运行确认失败** — `pytest tests/runtime/test_state_reducer_user_input.py -q`
- [ ] **Step 3: 实现** — `_recover` 的 AWAITING_USER_INPUT 分支：若 resume 通道不可恢复（无 live execution），emit 显式失效事件并把 run 置回可继续状态（或标记），保留现有重放 input 行为
- [ ] **Step 4: 运行确认通过** — 新用例 + `pytest tests/runtime/ tests/api/ -q` 全绿
- [ ] **Step 5: 提交** — `fix(C1c): 重启后 pending HIL 请求显式 prompt_invalidated，不静默丢弃`

---

## P1 收尾

- [ ] 全量回归：`pytest -q`（基线 2257 → 2257+）与 `ruff check app/ tests/ launcher.py`（0 warning）
- [ ] 更新 `docs/archive/LEFTOVERS-2026-08-09.md`：B1 → ✅（P0 完成 + commit）、C1a → ✅、C5c → ✅、C5d/C5e → ✅；`docs/TODO.md:63` 勾选
- [ ] 合并 `feat/leftovers-p1` 到 main（质量门全过后），推送
