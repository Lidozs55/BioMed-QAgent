# Phase 4a 终态语义核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 V1 的 artifact-count→FAILED 反模式与错误字符串猜测，落地 BuildResult、事件溯源 Publication 版本链、服务端 RunSummary，前端四态直接展示。

**Architecture:** 运行时终态由四类正交状态表达（ARCHITECTURE §9）：`RunStatus`（执行）+ `BuildResult`（数据结果，仅 COMPLETED 产生）+ `ValidationResult`（Profile 判定）+ `DatasetPublication`（不可变版本）。PipelineRunner 在 `_finalize_completed` 计算 BuildResult 随 RunManifest 返回；agent_loop 将 manifest 的 build_result 灌入 `AgentRunExecutor` 并在发布成功后发射 `PublicationCreatedPayload` 事件；TaskManager 终态事件携带结构化负载（build_result / error_code / cancelled_at_stage）写入 `events.jsonl`；`TaskSnapshot` 由纯 reducer 聚合出 `current_publication_id`、版本链与每 run 的 `RunSummary`，`GET /tasks/{id}` 直接返回；前端删除 `taskOutcome` 字符串猜测，四态直接消费 `run.summary`。所有新事件负载字段 optional 以保证旧 `events.jsonl` 重放兼容。

**Tech Stack:** Python 3.12+ / Pydantic v2 / FastAPI / asyncio；TypeScript / React 19 / vitest。

## Global Constraints

- 后端所有命令在 `backend/` 目录执行（`uv run pytest`、`uv run ruff check`）。
- 前端所有命令在 `frontend/` 目录执行（`pnpm lint && pnpm tsc && pnpm build`）。
- pytest 配置 `asyncio_mode = "strict"`，warnings 视为错误；测试不得触发 ResourceWarning。
- 新事件字段必须向后兼容：旧 `events.jsonl`（无 `build_result`/`error_code`/`cancelled_at_stage`）必须能正常重放，**因此所有新增事件字段一律 optional + 默认 None**。
- 类型注解全量强制（PEP 8 + 全签名注解）；禁止 `asyncio`、`@ts-ignore` 等类型抑制。
- `app.datasets.contracts` 只放 V2 数据集契约：`BuildResult`/`BuildResultStatus`/`ArtifactRole` 留在原地；`domain.contracts` 可以 import 它（无循环：`datasets/contracts.py` 只 import `domain.contracts.base` 与 `domain.contracts.source`）。
- 每次 commit 前必须通过该任务指定的测试；任务间通过 `git commit` 保持边界。
- 依赖方向：`pipeline.py` / `events.py` / `runtime.py` 均可 `from app.datasets.contracts import BuildResult, ArtifactRole`（已确认无循环导入）。

---

### Task 1: 契约模型 — RunSummary / PublicationSummary / TaskSnapshot 扩展

**Files:**
- Modify: `backend/app/domain/contracts/runtime.py`
- Test: `backend/tests/contracts/test_runtime_contracts.py`

**Interfaces:**
- Consumes: `BuildResult` / `ArtifactRole` from `app.datasets.contracts`（已存在，无需改动）
- Produces: `RunSummary`, `PublicationSummary`, `RunRecord.summary`, `TaskSnapshot.current_publication_id` + `publications`；`TaskSummary.no_artifact_failure` 删除

- [ ] **Step 1: 写失败测试**（追加到 `tests/contracts/test_runtime_contracts.py` 末尾）

```python
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts.enums import ErrorCode, StageName
from app.domain.contracts.runtime import (
    PublicationSummary,
    RunRecord,
    RunSummary,
    TaskSnapshot,
)


def test_run_summary_partial_projection_allowed() -> None:
    # 旧事件重放：COMPLETED 无 build_result / FAILED 无 error_code 均合法（投影可部分）。
    assert RunSummary(run_status="completed").build_result is None
    assert RunSummary(run_status="failed").error_code is None
    summary = RunSummary(
        run_status="completed",
        build_result=BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            reason_codes=["no_primary_data"],
        ),
        user_message="任务完成但未产出可发布的主数据。",
    )
    assert summary.build_result.reason_codes == ["no_primary_data"]


def test_publication_summary_chain_links() -> None:
    first = PublicationSummary(
        publication_id="pub-run_1", manifest_sha256="a" * 64, published_at=datetime.now(UTC)
    )
    second = PublicationSummary(
        publication_id="pub-run_2",
        manifest_sha256="b" * 64,
        supersedes_publication_id=first.publication_id,
        published_at=datetime.now(UTC),
    )
    assert second.supersedes_publication_id == "pub-run_1"


def test_run_record_summary_and_snapshot_publications() -> None:
    run = RunRecord(
        run_id="run_1", task_id="task_1", request_id="req_1", status="completed",
        input="topic", created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
        summary=RunSummary(run_status="completed"),
    )
    assert run.summary is not None
    snapshot = TaskSnapshot(
        task_id="task_1",  # 其余字段用 fixture；仅验证新字段存在且默认
        runs=[run],
        current_publication_id="pub-run_1",
        publications=[
            PublicationSummary(
                publication_id="pub-run_1",
                manifest_sha256="a" * 64,
                published_at=datetime.now(UTC),
            )
        ],
    )
    assert snapshot.current_publication_id == "pub-run_1"
    assert snapshot.publications[0].manifest_sha256 == "a" * 64


def test_task_summary_has_no_no_artifact_failure_field() -> None:
    from app.domain.contracts.runtime import TaskSummary

    task = TaskSummary(
        task_id="task_1", mode="agent", databases=[], title="t",
        status="completed", created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    assert not hasattr(task, "no_artifact_failure")
```

> 测试里 `TaskSnapshot(task_id=..., runs=..., ...)` 若该模型字段较多，按现有构造 fixture 方式补全必填字段（读 `tests/runtime/test_state_reducer.py` 里的 TaskSnapshot fixture 参考）。

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/contracts/test_runtime_contracts.py -k "run_summary or publication_summary or task_summary" -v`，预期：`ModuleNotFoundError`/`ImportError`（类型不存在）。

- [ ] **Step 3: 实现**

在 `runtime.py` 顶部 import 区追加：

```python
from app.datasets.contracts import BuildResult
```

新增（放在 `RunRecord` 之前）：

```python
class RunSummary(ContractModel):
    """Server-generated per-run outcome (ARCHITECTURE §9.2/9.4).

    Partial projection is legal: legacy events may lack ``build_result``
    or ``error_code``; the frontend renders only present fields.
    """

    run_status: RunStatus
    build_result: BuildResult | None = None
    error_code: ErrorCode | None = None
    cancelled_at_stage: StageName | None = None
    user_message: str | None = Field(default=None, min_length=1)


class PublicationSummary(ContractModel):
    """Immutable publication record aggregated from publication_created events."""

    publication_id: str = Field(min_length=1)
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    supersedes_publication_id: str | None = Field(default=None, min_length=1)
    published_at: datetime
```

- `RunRecord` 增加字段：`summary: RunSummary | None = Field(default=None)`
- `TaskSummary` **删除** `no_artifact_failure: bool = Field(default=False)`
- `TaskSnapshot` 增加字段：

```python
    current_publication_id: str | None = Field(default=None, min_length=1)
    publications: list[PublicationSummary] = Field(default_factory=list)
```

（imports：确认 `runtime.py` 已 import `datetime`、`Field`、`ContractModel`、`RunStatus`、`ErrorCode`、`StageName`；缺哪个补哪个，`StageName`/`ErrorCode` 来自 `app.domain.contracts.enums`。）

- [ ] **Step 4: 运行通过** — 同 Step 2 命令，预期 PASS（`task_summary` 用例可能因旧 fixture 里出现 `no_artifact_failure` 赋值而失败——见 Step 5）。

- [ ] **Step 5: 修复旧引用**

```bash
cd backend && grep -rn "no_artifact_failure" app/ tests/ | grep -v ".pyc"
```

把每个残留引用改为"删除该布尔及其读取分支"（`state.py`/`repository.py` 的改动在 Task 7；`manager.py` 若无直接引用则跳过）。若测试 fixture 构造 `TaskSummary(..., no_artifact_failure=...)`，删除该参数。

- [ ] **Step 6: 回归** — `uv run pytest tests/contracts/test_runtime_contracts.py tests/runtime/test_state_reducer.py -q`，预期全绿（若 `test_state_reducer` 因字段删除失败，先记录、由 Task 7 一并处理，本任务内确保 contracts 测试绿）。

- [ ] **Step 7: Commit** — `git add backend/app/domain/contracts/runtime.py backend/tests/contracts/test_runtime_contracts.py && git commit -m "feat(phase4a): RunSummary + PublicationSummary contracts, drop no_artifact_failure"`

---

### Task 2: 事件负载 — PublicationCreatedPayload 与终态事件扩展

**Files:**
- Modify: `backend/app/domain/contracts/events.py`
- Test: `backend/tests/contracts/test_event_contracts.py`

**Interfaces:**
- Consumes: `BuildResult`（datasets.contracts）、`ErrorCode`/`StageName`（enums）
- Produces: `RuntimeEventType.PUBLICATION_CREATED`, `PublicationCreatedPayload`, `RunCompletedPayload.build_result`, `RunFailedPayload.error_code`, `RunCancelledPayload.cancelled_at_stage`, `TaskCompletedPayload.build_result`

- [ ] **Step 1: 写失败测试**（追加到 `tests/contracts/test_event_contracts.py`）

```python
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts.events import (
    PublicationCreatedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
)
from app.domain.contracts.enums import ErrorCode, StageName


def test_terminal_event_payloads_carry_structured_state() -> None:
    completed = RunCompletedPayload(
        build_result=BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            reason_codes=["no_primary_data"],
        )
    )
    assert completed.build_result.status is BuildResultStatus.NO_DATA
    # 旧事件重放兼容：字段缺省合法
    assert RunCompletedPayload().build_result is None
    failed = RunFailedPayload(error="boom", error_code=ErrorCode.TIMEOUT)
    assert failed.error_code is ErrorCode.TIMEOUT
    assert RunFailedPayload(error="boom").error_code is None
    cancelled = RunCancelledPayload(
        reason="user", cancelled_at_stage=StageName.PROCESSING
    )
    assert cancelled.cancelled_at_stage is StageName.PROCESSING
    assert RunCancelledPayload().cancelled_at_stage is None


def test_publication_created_payload() -> None:
    payload = PublicationCreatedPayload(
        publication_id="pub-run_1",
        run_id="run_1",
        manifest_sha256="a" * 64,
        published_at=datetime.now(UTC),
    )
    assert payload.type == "publication_created"
    assert payload.supersedes_publication_id is None
```

（`RunFailedPayload` 现在必填 `error`——保持必填，只加 optional `error_code`。）

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/contracts/test_event_contracts.py -k "structured_state or publication_created" -v`，预期 FAIL（字段不存在）。

- [ ] **Step 3: 实现**（`events.py`）

1. `RuntimeEventType` 追加：`PUBLICATION_CREATED = "publication_created"`
2. import 追加：`from app.datasets.contracts import BuildResult`（若 ruff F401 提示未使用，先加后会用）
3. `RunCompletedPayload` 改为：

```python
class RunCompletedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_COMPLETED] = RuntimeEventType.RUN_COMPLETED
    build_result: BuildResult | None = Field(default=None)
```

4. `RunFailedPayload` 改为：

```python
class RunFailedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_FAILED] = RuntimeEventType.RUN_FAILED
    error: str = Field(min_length=1)
    error_code: ErrorCode | None = Field(default=None)
```

5. `RunCancelledPayload` 改为：

```python
class RunCancelledPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_CANCELLED] = RuntimeEventType.RUN_CANCELLED
    reason: str | None = Field(default=None, min_length=1)
    cancelled_at_stage: StageName | None = Field(default=None)
```

6. `TaskCompletedPayload` 改为：

```python
class TaskCompletedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_COMPLETED] = PipelineEventType.TASK_COMPLETED
    validation: ValidationSummary
    build_result: BuildResult | None = Field(default=None)
```

7. 新增（放在 `RunInterruptedPayload` 之后）：

```python
class PublicationCreatedPayload(ContractModel):
    """Immutable publication record appended to the event log (ARCHITECTURE §9.3).

    ``supersedes_publication_id`` is optional: the reducer derives the chain
    head from the task's prior ``current_publication_id`` when the field is
    absent, so the emit path never needs the current snapshot.
    """

    type: Literal[RuntimeEventType.PUBLICATION_CREATED] = (
        RuntimeEventType.PUBLICATION_CREATED
    )
    publication_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    supersedes_publication_id: str | None = Field(default=None, min_length=1)
    published_at: datetime
```

8. `EventPayload` 联合类型追加 `| PublicationCreatedPayload`（在 `RunInterruptedPayload` 之后）

- [ ] **Step 4: 运行通过** — 同 Step 2 命令，预期 PASS；随后 `uv run ruff check app/domain/contracts/events.py` 零告警。

- [ ] **Step 5: 回归** — `uv run pytest tests/contracts/test_event_contracts.py tests/contracts/test_pipeline_contracts.py -q` 全绿（若旧测试构造 `RunCompletedPayload()` 且断言字段精确等于，检查无破坏）。

- [ ] **Step 6: Commit** — `git add backend/app/domain/contracts/events.py backend/tests/contracts/test_event_contracts.py && git commit -m "feat(phase4a): terminal events carry build_result/error_code/cancelled_at_stage; publication_created event"`

---

### Task 3: RunManifest 携带 build_result 与 error_code

**Files:**
- Modify: `backend/app/domain/contracts/pipeline.py`
- Test: `backend/tests/contracts/test_pipeline_contracts.py`

**Interfaces:**
- Consumes: `BuildResult`（datasets.contracts）、`ErrorCode`（enums）
- Produces: `RunManifest.build_result: BuildResult | None`, `RunManifest.error_code: ErrorCode | None`

- [ ] **Step 1: 写失败测试**（追加到 `tests/contracts/test_pipeline_contracts.py`）

```python
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts.enums import ErrorCode


def test_run_manifest_carries_build_result_and_error_code() -> None:
    manifest = _valid_manifest()  # 复用文件内现有 RunManifest 构造 helper
    assert manifest.build_result is None
    assert manifest.error_code is None
    manifest = manifest.model_copy(
        update={
            "build_result": BuildResult(
                status=BuildResultStatus.NO_DATA,
                valid_row_count=0,
                reason_codes=["no_primary_data"],
            ),
            "error_code": ErrorCode.PARSE_ERROR,
        }
    )
    assert manifest.build_result.status is BuildResultStatus.NO_DATA
    assert manifest.error_code is ErrorCode.PARSE_ERROR
```

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/contracts/test_pipeline_contracts.py -k run_manifest_carries -v`，预期 FAIL。

- [ ] **Step 3: 实现**（`pipeline.py`）

1. import 追加：`from app.datasets.contracts import BuildResult`（确认与现有 `from app.domain.contracts.enums import ...` 合并风格一致）
2. `RunManifest` 增加两字段（放在 `finished_at` 之后）：

```python
    build_result: BuildResult | None = Field(default=None)
    error_code: ErrorCode | None = Field(default=None)
```

（`ErrorCode` 已在 `pipeline.py` 的 enums import 中或补上；检查现有 import，若无则加。）

- [ ] **Step 4: 运行通过** — 同 Step 2，预期 PASS；`uv run ruff check app/domain/contracts/pipeline.py` 零告警。

- [ ] **Step 5: Commit** — `git add backend/app/domain/contracts/pipeline.py backend/tests/contracts/test_pipeline_contracts.py && git commit -m "feat(phase4a): RunManifest carries build_result + error_code"`

---

### Task 4: PipelineRunner 计算 BuildResult（含最小 manifest 路径）

**Files:**
- Modify: `backend/app/pipeline/runner.py`
- Test: `backend/tests/pipeline/test_build_result.py`（新建）

**Interfaces:**
- Consumes: `RunManifest.build_result/error_code`（Task 3）、`_finalize_completed/_finalize_failed/_finalize_cancelled`（现签名）
- Produces: `_compute_build_result(manifest: RunManifest) -> BuildResult`；`_finalize_completed` 返回的 manifest 带 `build_result`；`_finalize_failed` 返回的 manifest 带 `error_code`；`TaskCompletedPayload(build_result=...)`

- [ ] **Step 1: 写失败测试**（新建 `tests/pipeline/test_build_result.py`；构造 manifest 的 fixture 复用 `tests/pipeline/test_mode_marking.py` 或 `test_pipeline_runner_recovery.py` 中的现成 helper，若没有则用 `RunManifest.model_validate` 从最小 JSON 构造）

```python
from app.datasets.contracts import BuildResultStatus
from app.domain.contracts.enums import ErrorCode
from app.domain.contracts.pipeline import RunManifest
from app.pipeline.runner import _compute_build_result


def _manifest_with_artifacts(names: list[str]) -> RunManifest:
    # 复用项目现有 manifest fixture 构造器；artifacts 为 ArtifactManifestEntry 列表，
    # 其中 name 含 "main_data.csv" 代表存在 primary。
    ...


def test_completed_with_primary_is_succeeded() -> None:
    manifest = _manifest_with_artifacts(["main_data.csv", "source_list.csv"])
    result = _compute_build_result(manifest)
    assert result.status is BuildResultStatus.SUCCEEDED
    assert result.valid_row_count >= 0


def test_completed_without_primary_is_no_data() -> None:
    manifest = _manifest_with_artifacts(["source_list.csv"])
    result = _compute_build_result(manifest)
    assert result.status is BuildResultStatus.NO_DATA
    assert "no_primary_data" in result.reason_codes
    assert result.valid_row_count == 0


def test_completed_with_partial_sources_is_partial_success() -> None:
    # manifest.source_ids 非空且 artifact 无 primary → 视为部分来源失败场景
    # （4a 的保守判定：有 artifact 但无 primary 一律 NO_DATA；PARTIAL_SUCCESS
    #  仅在 manifest 显式携带部分成功标记时产生——4a 内判定见 Step 3 注释）
    ...
```

> **4a 的 BuildResult 判定（保守版，后续 4b 细化）**：`_compute_build_result` 仅按一个事实判定：`manifest.artifacts` 中是否存在 name == "main_data.csv" 的条目。
> - 有 → `SUCCEEDED`（publication_id 由发布路径填充；`successful_sources` 取 `manifest.source_ids`；`valid_row_count` 由调用方传入或默认 0——**实现时从 artifact_build 阶段的 primary 行数统计注入**，若无现成统计则置 0 并在 docstring 注明 4b 补全）
> - 无 → `NO_DATA` + `reason_codes=["no_primary_data"]` + `valid_row_count=0`
> - `user_summary`：`"完成：主数据已发布（N 行）。"` / `"任务完成，但未产出可发布的主数据。"`（服务端中文摘要）
> - `PARTIAL_SUCCESS` 在 4a 不产生（无来源级失败统计注入点；4b 接入 V2 统计后启用）——**spec §4.1 判定表按本注收敛**，测试仅覆盖 SUCCEEDED / NO_DATA 两分支。

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/pipeline/test_build_result.py -v`，预期 FAIL（`_compute_build_result` 不存在）。

- [ ] **Step 3: 实现**（`runner.py`）

1. import 追加：`from app.datasets.contracts import BuildResult, BuildResultStatus`（确认 `ArtifactManifestEntry` 已在 imports）
2. 新增模块级函数（放在 `_build_specification_for_plan` 附近）：

```python
_PRIMARY_ARTIFACT_NAME = "main_data.csv"


def _compute_build_result(manifest: RunManifest) -> BuildResult:
    """Conservative 4a BuildResult from a completed manifest.

    Only the presence of a primary dataset artifact is considered. Source-level
    partial-success statistics and accurate row counts arrive with 4b when the
    V2 chain statistics are wired in.
    """

    has_primary = any(
        entry.name == _PRIMARY_ARTIFACT_NAME for entry in manifest.artifacts
    )
    if has_primary:
        return BuildResult(
            status=BuildResultStatus.SUCCEEDED,
            valid_row_count=0,
            successful_sources=list(manifest.source_ids),
            reason_codes=[],
            user_summary="完成：主数据已发布。",
            recommended_next_action="可在产物区查看主表与审计报告。",
        )
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        reason_codes=["no_primary_data"],
        user_summary="任务完成，但未产出可发布的主数据。",
        recommended_next_action="检查数据源可用性或调整查询后重试。",
    )
```

3. `_finalize_completed`（约 `:1502`）：在构造 `manifest` 处注入

```python
    manifest = RunManifest(
        ...,
        build_result=_compute_build_result(manifest),
    )
```

（若 `_finalize_completed` 内部先构造局部 manifest 再赋值 `self.manifest`，在该局部变量上加字段。）

4. `_finalize_failed`（约 `:1422`，签名 `(self, exc, error_code: ErrorCode = ErrorCode.INTERNAL_ERROR)`）：其返回的 `RunManifest`（含 `_minimal_failed_manifest` 路径 `:1764`）加 `error_code=error_code`。`_minimal_failed_manifest` 函数签名增加 `error_code` 参数并透传。
5. `_finalize_cancelled`（约 `:1464`）：`_minimal_cancelled_manifest`（`:1797`）无需新字段（cancelled 由 RunStatus 表达）。
6. `:1514` 处 `TaskCompletedPayload(validation=manifest.validation)` 改为 `TaskCompletedPayload(validation=manifest.validation, build_result=manifest.build_result)`。

- [ ] **Step 4: 运行通过** — `uv run pytest tests/pipeline/test_build_result.py -v` PASS；随后 `uv run pytest tests/pipeline/test_mode_marking.py tests/pipeline/test_pipeline_runner_recovery.py -q` 无回归（manifest 新增 optional 字段不应破坏）。

- [ ] **Step 5: Commit** — `git add backend/app/pipeline/runner.py backend/tests/pipeline/test_build_result.py && git commit -m "feat(phase4a): runner computes BuildResult (SUCCEEDED/NO_DATA) at finalize"`

---

### Task 5: agent_loop 接线 — build_result 灌入执行器 + 发布事件发射

**Files:**
- Modify: `backend/app/agent_loop/runner.py`
- Test: `backend/tests/agent_loop/test_execution.py`、`backend/tests/agent_loop/test_silent_completion.py`

**Interfaces:**
- Consumes: `RunManifest.build_result`（Task 3）、`PendingPublication`（现签名）
- Produces: `AgentRunExecutor.build_result` + `set_build_result()`；`commit_agent_artifacts` 返回事件列表末尾追加 `PublicationCreatedPayload`；`publication_id = f"pub-{run_id}"`

- [ ] **Step 1: 写失败测试**（追加到 `tests/agent_loop/test_execution.py`）

```python
from app.datasets.contracts import BuildResult, BuildResultStatus


def test_executor_carries_build_result() -> None:
    execution = _execution_fixture()  # 复用文件内现有 fixture
    assert execution.build_result is None
    execution.set_build_result(
        BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            reason_codes=["no_primary_data"],
        )
    )
    assert execution.build_result.status is BuildResultStatus.NO_DATA


def test_commit_artifacts_emits_publication_event() -> None:
    # 复用现有 commit_agent_artifacts 集成测试结构；断言返回的事件列表中
    # 最后一个 payload 是 PublicationCreatedPayload 且 publication_id == "pub-" + run_id。
    ...
```

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/agent_loop/test_execution.py -k "carries_build_result or emits_publication" -v`，预期 FAIL。

- [ ] **Step 3: 实现**（`agent_loop/runner.py`）

1. import 追加：

```python
from app.domain.contracts.events import PublicationCreatedPayload
from app.datasets.contracts import BuildResult
```

2. `AgentRunExecutor`（`:620`）加字段与方法：

```python
    build_result: BuildResult | None = None

    def set_build_result(self, build_result: BuildResult | None) -> None:
        self.build_result = build_result
```

（若 `AgentRunExecutor` 是 dataclass，`build_result: BuildResult | None = None` 作为类字段；若是普通类加 `self.build_result = None` 于 `__init__`。）

3. `_take_pending_publication`（约 `:1260`，`pending` 非空分支）在构造 completion ops 前追加：

```python
        execution.set_build_result(pending.manifest.build_result)
```

4. `commit_agent_artifacts`（约 `:1290`）改为：

```python
            async def commit_agent_artifacts() -> list[EventEnvelope]:
                await _run_sync_operation(pending.publish)
                manifest_digest = hashlib.sha256(
                    pending.manifest.model_dump_json().encode("utf-8")
                ).hexdigest()
                publication_id = f"pub-{execution.run_id}"
                if execution.build_result is not None:
                    execution.set_build_result(
                        execution.build_result.model_copy(
                            update={"publication_id": publication_id}
                        )
                    )
                publication_event = build_event(
                    task_id=execution.task_id,
                    run_id=execution.run_id,
                    sequence=len(payloads) + 1,
                    payload=PublicationCreatedPayload(
                        publication_id=publication_id,
                        run_id=execution.run_id,
                        manifest_sha256=manifest_digest,
                        supersedes_publication_id=None,
                        published_at=datetime.now(UTC),
                    ),
                )
                return [
                    build_event(
                        task_id=execution.task_id,
                        run_id=execution.run_id,
                        sequence=index,
                        payload=payload,
                    )
                    for index, payload in enumerate(payloads, start=1)
                ] + [publication_event]
```

（`hashlib`/`datetime(UTC)` 确认已 import；`build_event` 签名以现有调用为准——本文件已用它。）

5. fixture 路径（约 `:1417`，`manifest = await _run_pipeline_with_cancellation(...)` 之后、`set_completion_operations` 之前）追加：

```python
            execution.set_build_result(manifest.build_result)
```

- [ ] **Step 4: 运行通过** — Step 2 命令 PASS；`uv run pytest tests/agent_loop/ -q` 全绿（`test_silent_completion.py` 若断言"零产物 → run_failed"会在 Task 6 改造后失效——本任务内先跑，若红则记录并留给 Task 6）。

- [ ] **Step 5: Commit** — `git add backend/app/agent_loop/runner.py backend/tests/agent_loop/test_execution.py && git commit -m "feat(phase4a): thread build_result into executor; emit publication_created on commit"`

---

### Task 6: TaskManager 终态改造 — 删除 artifact-count 反模式

**Files:**
- Modify: `backend/app/runtime/manager.py`
- Test: `backend/tests/agent_loop/test_silent_completion.py`（改写）、`backend/tests/runtime/test_manager.py`（追加）

**Interfaces:**
- Consumes: `AgentRunExecutor.build_result`（Task 5）、`RunCompletedPayload.build_result`/`RunFailedPayload.error_code`（Task 2）
- Produces: 零产物完成 → COMPLETED + `BuildResult(NO_DATA)`；错误路径 → `RunFailedPayload(error_code=...)`；取消路径 → `RunCancelledPayload(cancelled_at_stage=...)`

- [ ] **Step 1: 写失败测试**（先改 `tests/agent_loop/test_silent_completion.py` 的核心断言：把"静默完成 → run_failed"改为"静默完成 → run_completed + build_result.status == NO_DATA"；再在 `tests/runtime/test_manager.py` 追加）

```python
# tests/runtime/test_manager.py 追加
from app.datasets.contracts import BuildResultStatus
from app.domain.contracts.enums import ErrorCode


def test_completed_run_emits_build_result_no_data() -> None:
    # 复用现有 manager 集成测试 fixture：agent_executed=True、零 completion_events。
    # 断言最终 run.status == completed 且 run.summary.build_result.status 为 NO_DATA。
    ...


def test_failed_run_emits_structured_error_code() -> None:
    # 复用现有"dispatch 异常 → run_failed"测试；断言
    # run.summary.error_code in (ErrorCode.TIMEOUT, ErrorCode.INTERNAL_ERROR)。
    ...
```

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/agent_loop/test_silent_completion.py -q` 预期 FAIL（新语义断言 vs 旧行为）；`uv run pytest tests/runtime/test_manager.py -k "build_result or structured_error_code" -v` 预期 FAIL。

- [ ] **Step 3: 实现**（`manager.py`）

1. import 追加：

```python
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts.enums import ErrorCode
```

2. 模块级 helper：

```python
_NO_DATA_SUMMARY = "任务完成，但未产出可发布的主数据。"


def _no_data_build_result() -> BuildResult:
    return BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        reason_codes=["no_primary_data"],
        user_summary=_NO_DATA_SUMMARY,
        recommended_next_action="检查数据源可用性或调整查询后重试。",
    )


def _classify_error(error: BaseException) -> ErrorCode:
    if isinstance(error, asyncio.TimeoutError) or "timed out" in str(error).lower():
        return ErrorCode.TIMEOUT
    return ErrorCode.INTERNAL_ERROR
```

3. **删除 `:1679-1690` 反模式块**（`if execution.mode is TaskMode.AGENT and execution.agent_executed and not completion_events ...` 整块 `RunFailedPayload(...)` 分支），替换为：

```python
                if (
                    execution.mode is TaskMode.AGENT
                    and execution.agent_executed
                    and not completion_events
                    and not execution.context.cancellation_requested.is_set()
                ):
                    await self._append_completion_status(
                        accepted,
                        RunCompletedPayload(build_result=_no_data_build_result()),
                    )
                    outcome.completion_durable = True
                    execution.discard_completion()
                    return
```

并把块后的 `await self._append_completion_status(accepted, RunCompletedPayload())` 改为：

```python
                await self._append_completion_status(
                    accepted,
                    RunCompletedPayload(
                        build_result=execution.build_result
                        or _no_data_build_result()
                    ),
                )
```

4. 三处 dispatch 错误路径 + 一处 completion 错误路径（约 `:1476`、`:1564`、`:1628`，形如 `RunFailedPayload(error=str(error) or type(error).__name__)`）改为带 `error_code=_classify_error(error)`：

```python
                    RunFailedPayload(
                        error=str(error) or type(error).__name__,
                        error_code=_classify_error(error),
                    ),
```

5. 取消路径（`RunCancelledPayload(reason=...)` 各调用点，约 `:1100/:1138/:1163`）：加 `cancelled_at_stage=None` 显式参数（结构化字段就位；可确定阶段时传值，4a 内固定 None）。

- [ ] **Step 4: 运行通过** — `uv run pytest tests/agent_loop/test_silent_completion.py tests/runtime/test_manager.py -q` PASS（`test_silent_completion.py` 其余用例若断言旧字符串 markers 行为，同步改写为断言 `build_result.status`）。

- [ ] **Step 5: 回归** — `uv run pytest tests/runtime/ -q` 全绿。

- [ ] **Step 6: Commit** — `git add backend/app/runtime/manager.py backend/tests/agent_loop/test_silent_completion.py backend/tests/runtime/test_manager.py && git commit -m "feat(phase4a): manager emits COMPLETED+NO_DATA instead of artifact-count FAILED; structured error_code"`

---

### Task 7: reducer 聚合 — Publication 链 + run.summary；删除字符串回扫

**Files:**
- Modify: `backend/app/runtime/state.py`、`backend/app/runtime/repository.py`
- Test: `backend/tests/runtime/test_state_reducer.py`、`backend/tests/runtime/test_repository.py`

**Interfaces:**
- Consumes: `PublicationCreatedPayload`/`RunCompletedPayload` 等（Task 2）、`RunSummary`/`PublicationSummary`（Task 1）
- Produces: reducer 聚合 `task.current_publication_id` + `task.publications`（supersedes 从链头推导）+ `run.summary`；`no_artifact_failure` 全量移除

- [ ] **Step 1: 写失败测试**（追加到 `tests/runtime/test_state_reducer.py`）

```python
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts.events import (
    PublicationCreatedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
)
from app.domain.contracts.enums import ErrorCode, StageName


def _envelope(payload, sequence, run_id="run_1", task_id="task_1"):
    return EventEnvelope(
        event_id=f"evt-{sequence}", type=payload.type, task_id=task_id,
        run_id=run_id, sequence=sequence, timestamp=datetime.now(UTC),
        payload=payload,
    )


def test_publication_events_build_chain() -> None:
    snapshot = _snapshot_fixture()  # 复用现有 fixture：单 run 已 COMPLETED
    first = reduce_task_event(
        snapshot,
        _envelope(
            PublicationCreatedPayload(
                publication_id="pub-run_1", run_id="run_1",
                manifest_sha256="a" * 64, published_at=datetime.now(UTC),
            ),
            sequence=2,
        ),
    )
    assert first.current_publication_id == "pub-run_1"
    assert first.publications[0].supersedes_publication_id is None
    second = reduce_task_event(
        first,
        _envelope(
            PublicationCreatedPayload(
                publication_id="pub-run_2", run_id="run_2",
                manifest_sha256="b" * 64, published_at=datetime.now(UTC),
            ),
            sequence=3,
            run_id="run_2",
        ),
    )
    assert second.current_publication_id == "pub-run_2"
    assert second.publications[1].supersedes_publication_id == "pub-run_1"


def test_terminal_events_populate_run_summary() -> None:
    snapshot = _snapshot_fixture()
    snapshot = reduce_task_event(
        snapshot,
        _envelope(
            RunCompletedPayload(
                build_result=BuildResult(
                    status=BuildResultStatus.NO_DATA, valid_row_count=0,
                    reason_codes=["no_primary_data"],
                )
            ),
            sequence=2,
        ),
    )
    run = next(r for r in snapshot.runs if r.run_id == "run_1")
    assert run.summary is not None
    assert run.summary.build_result.status is BuildResultStatus.NO_DATA
    # FAILED / CANCELLED 同理各一例
```

（`_snapshot_fixture` 若文件内没有，从 `tests/runtime/test_state_reducer_user_input.py` 或 `test_manager.py` 拷贝现成 fixture 结构。）

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/runtime/test_state_reducer.py -k "publication_events or populate_run_summary" -v`，预期 FAIL。

- [ ] **Step 3: 实现**（`state.py`）

1. import 追加：`PublicationCreatedPayload`（events）、`RunSummary`/`PublicationSummary`（runtime）
2. `reduce_task_event` 的 `elif` 链中，**在 `elif type(payload) in _STATUS_PAYLOADS:` 之前**插入：

```python
    elif isinstance(payload, PublicationCreatedPayload):
        if event.run_id is None:
            raise ValueError("publication events require run_id")
        _run_index(snapshot, event.run_id)
        publications = list(snapshot.publications)
        previous = snapshot.current_publication_id
        publications.append(
            PublicationSummary(
                publication_id=payload.publication_id,
                manifest_sha256=payload.manifest_sha256,
                supersedes_publication_id=(
                    payload.supersedes_publication_id or previous
                ),
                published_at=payload.published_at,
            )
        )
        status = snapshot.task.status
```

3. `_STATUS_PAYLOADS` 分支内，`updates` 构造处追加终态 summary：

```python
        if status in _TERMINAL_STATUSES:
            updates["finished_at"] = event.timestamp
        summary = _run_summary_for(payload, status, event.timestamp)
        if summary is not None:
            updates["summary"] = summary
```

并在文件底部新增 helper：

```python
def _run_summary_for(
    payload: object, status: RunStatus, timestamp: datetime
) -> RunSummary | None:
    if isinstance(payload, RunCompletedPayload):
        return RunSummary(
            run_status=status,
            build_result=payload.build_result,
            user_message=(
                payload.build_result.user_summary
                if payload.build_result is not None
                else None
            ),
        )
    if isinstance(payload, RunFailedPayload):
        return RunSummary(
            run_status=status,
            error_code=payload.error_code,
            user_message=payload.error,
        )
    if isinstance(payload, RunCancelledPayload):
        return RunSummary(
            run_status=status,
            cancelled_at_stage=payload.cancelled_at_stage,
            user_message=payload.reason,
        )
    if isinstance(payload, RunInterruptedPayload):
        return RunSummary(run_status=status, user_message=payload.reason)
    return None
```

4. **删除字符串回扫**：
   - 删除 `NO_ARTIFACT_FAILURE_MARKERS`（`:56`）
   - 删除 `no_artifact_failure_from_runs`（`:369`）及其在 `reduce_task_event` 中的调用（`:348` 与 `:361` 的 `"no_artifact_failure"` update）
   - `task.model_copy(update={...})` 中移除 `"no_artifact_failure": no_artifact_failure,`
5. `repository.py`（约 `:597-640`）：删除 `legacy_no_artifact_failure` 变量、`no_artifact_failure_from_runs` 调用及 `snapshot.task.model_copy(update={"no_artifact_failure": True})` 分支；`legacy` 判定只保留 `"artifact_count" not in ...`（`no_artifact_failure` 不再参与）。
6. 确认 `repository.py`/`state.py` 对 `TaskSummary` 的 `no_artifact_failure` 引用清零（`grep -rn "no_artifact_failure" backend/app/ backend/tests/`）。

- [ ] **Step 4: 运行通过** — `uv run pytest tests/runtime/test_state_reducer.py tests/runtime/test_repository.py tests/runtime/test_manager.py tests/contracts/test_runtime_contracts.py -q` 全绿。

- [ ] **Step 5: 旧事件重放兼容测试**（追加 `tests/runtime/test_repository.py`）

```python
def test_legacy_events_replay_without_string_scan() -> None:
    # 构造一份"旧式" events.jsonl：run_failed 只有 error 字段、run_completed 无负载、
    # 无 publication 事件。重放后断言：
    # - 快照构建成功（无校验异常）
    # - run.summary 为 None 或部分投影（error_code/build_result 为 None）
    # - current_publication_id is None
    ...
```

- [ ] **Step 6: Commit** — `git add backend/app/runtime/state.py backend/app/runtime/repository.py backend/tests/runtime/ && git commit -m "feat(phase4a): reducer aggregates publications + run.summary; drop no_artifact_failure string scan"`

---

### Task 8: P1 — Artifact Role 标注

**Files:**
- Modify: `backend/app/domain/contracts/pipeline.py`（`ArtifactManifestEntry`）、`backend/app/pipeline/stages/validation/runner.py`、`backend/app/pipeline/runner.py`（pending run_manifest 条目）
- Test: `backend/tests/pipeline/test_manifest_roles.py`（新建）

**Interfaces:**
- Consumes: `ArtifactRole`（datasets.contracts）
- Produces: `ArtifactManifestEntry.role: ArtifactRole`（required）；validation runner 按文件名映射 role；`run_manifest.json` 条目 role=`SCHEMA`

- [ ] **Step 1: 写失败测试**（新建 `tests/pipeline/test_manifest_roles.py`）

```python
from app.datasets.contracts import ArtifactRole
from app.domain.contracts.pipeline import ArtifactManifestEntry


def test_artifact_role_for_filename() -> None:
    from app.pipeline.stages.validation.runner import role_for_filename

    assert role_for_filename("main_data.csv") is ArtifactRole.PRIMARY_DATASET
    assert role_for_filename("schema.json") is ArtifactRole.SCHEMA
    assert role_for_filename("source_list.csv") is ArtifactRole.AUDIT_REPORT
    assert role_for_filename("field_mapping.csv") is ArtifactRole.PROVENANCE
    assert role_for_filename("run_manifest.json") is ArtifactRole.SCHEMA


def test_manifest_entry_requires_role() -> None:
    with pytest.raises(ValueError):
        ArtifactManifestEntry(
            artifact_id="a", name="main_data.csv", relative_path="artifacts/main_data.csv",
            media_type="text/csv", size_bytes=1, sha256="a" * 64,
            generated_by_step_id="s",
        )  # 缺 role 必须报错
```

- [ ] **Step 2: 运行确认失败** — `uv run pytest tests/pipeline/test_manifest_roles.py -v`，预期 FAIL。

- [ ] **Step 3: 实现**

1. `pipeline.py`：`ArtifactManifestEntry` 增加 `role: ArtifactRole`（required，放在 `artifact_id` 之后）；import `from app.datasets.contracts import ArtifactRole, BuildResult`（Task 3 已加 BuildResult import，合并）。
2. `backend/app/pipeline/stages/validation/runner.py`：新增模块级映射函数并应用到 entries 构造（`:103`）：

```python
_ROLE_BY_FILENAME = {
    "main_data.csv": ArtifactRole.PRIMARY_DATASET,
    "sample_metadata.csv": ArtifactRole.SUPPORTING_DATASET,
    "schema.json": ArtifactRole.SCHEMA,
    "field_descriptions.csv": ArtifactRole.SCHEMA,
    "field_mapping.csv": ArtifactRole.PROVENANCE,
    "cleaning_report.csv": ArtifactRole.AUDIT_REPORT,
    "source_list.csv": ArtifactRole.AUDIT_REPORT,
    "source_relations.csv": ArtifactRole.AUDIT_REPORT,
    "source_assets.csv": ArtifactRole.AUDIT_REPORT,
    "quality_report.csv": ArtifactRole.AUDIT_REPORT,
}


def role_for_filename(name: str) -> ArtifactRole:
    return _ROLE_BY_FILENAME.get(name, ArtifactRole.AUDIT_REPORT)
```

（未知文件名兜底 `AUDIT_REPORT`——审计类未知产物；entries 构造处加 `role=role_for_filename(path.name)`。）
3. `runner.py` `pending_publication`（`:305`）的 `ArtifactManifestEntry(...)` 加 `role=ArtifactRole.SCHEMA`。
4. 同步检查 `backend/app/pipeline/` 下其余 `ArtifactManifestEntry(` 构造点（`grep -rn "ArtifactManifestEntry(" backend/app/pipeline/`），全部补 `role`。

- [ ] **Step 4: 运行通过** — `uv run pytest tests/pipeline/test_manifest_roles.py tests/pipeline/test_mode_marking.py tests/pipeline/test_pipeline_runner_recovery.py -q` PASS；`uv run ruff check backend/app/pipeline/` 零告警。

- [ ] **Step 5: 消费方核对** — `backend/app/api/routes.py:824` `list_artifacts` 返回条目已含 `role`（无需改逻辑）；在 `tests/runtime` 或现有 routes 测试中加一条断言（`list_artifacts` 返回条目带 role 字段），若无可直接断言 manifest 序列化含 role。

- [ ] **Step 6: Commit** — `git add backend/app/domain/contracts/pipeline.py backend/app/pipeline/stages/validation/runner.py backend/app/pipeline/runner.py backend/tests/pipeline/test_manifest_roles.py && git commit -m "feat(phase4a): ArtifactManifestEntry role classification (P1 audit_report)"`

---

### Task 9: 前端契约与 reducer

**Files:**
- Modify: `frontend/src/runtime/contracts.ts`、`frontend/src/runtime/types.ts`、`frontend/src/runtime/reducers/runtime.ts`
- Test: `frontend/src/test/task-outcome.test.ts`（改写为 reducer/投影测试）或新增 `frontend/src/runtime/__tests__/terminal-state.test.ts`

**Interfaces:**
- Consumes: 后端 `TaskSnapshot` 新字段（`runs[].summary`、`current_publication_id`、`publications`）
- Produces: `RunProjection.summary`、`TaskProjection.currentPublicationId/publications`；reducer 从终态事件聚合 `run.summary`；`TaskSummary` 去掉 `no_artifact_failure`

- [ ] **Step 1: 写失败测试**（新建 `frontend/src/runtime/__tests__/terminal-state.test.ts`，参照现有 reducer 测试风格）

```ts
import { describe, expect, it } from "vitest";
import { buildInitialTask, applyEvent } from "@/runtime/reducer"; // 以实际导出为准
import type { EventEnvelope } from "@/runtime/contracts";

function completedEnvelope(overrides?: object): EventEnvelope {
  return {
    type: "run_completed",
    run_id: "run_1",
    sequence: 2,
    timestamp: "2026-08-06T00:00:00Z",
    payload: { type: "run_completed", build_result: null },
    ...overrides,
  } as EventEnvelope;
}

describe("terminal state projection", () => {
  it("aggregates run.summary from run_completed build_result", () => {
    const task = applyEvent(
      buildInitialTask("task_1"),
      completedEnvelope({
        payload: {
          type: "run_completed",
          build_result: {
            status: "no_data",
            valid_row_count: 0,
            reason_codes: ["no_primary_data"],
            user_summary: "任务完成，但未产出可发布的主数据。",
          },
        },
      }),
    );
    const run = task.runsById["run_1"];
    expect(run.summary?.build_result?.status).toBe("no_data");
  });

  it("tracks current_publication_id from publication_created", () => {
    // envelope.type === "publication_created" 分支 → task.currentPublicationId
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd frontend && pnpm test -- terminal-state` 预期 FAIL。

- [ ] **Step 3: 实现**

1. `contracts.ts` 追加类型：

```ts
export type BuildResultStatus =
  | "succeeded"
  | "partial_success"
  | "no_data"
  | "spec_rejected";

export type ErrorCode =
  | "configuration_error"
  | "network_error"
  | "timeout"
  | "download_incomplete"
  | "checksum_mismatch"
  | "parse_error"
  | "validation_error"
  | "cancelled"
  | "internal_error";

export interface BuildResult {
  status: BuildResultStatus;
  valid_row_count: number;
  successful_sources: string[];
  rejected_sources: string[];
  available_artifact_roles: string[];
  publication_id: string | null;
  reason_codes: string[];
  user_summary: string;
  recommended_next_action: string;
}

export interface RunSummary {
  run_status: RunStatus;
  build_result: BuildResult | null;
  error_code: ErrorCode | null;
  cancelled_at_stage: StageName | null;
  user_message: string | null;
}

export interface PublicationSummary {
  publication_id: string;
  manifest_sha256: string;
  supersedes_publication_id: string | null;
  published_at: string;
}
```

2. `types.ts`：`RunProjection` 加 `summary: RunSummary | null`；`TaskProjection` 加 `currentPublicationId: string | null` + `publications: PublicationSummary[]`；`TaskSummary` 删 `no_artifact_failure`（`contracts.ts:83`）。
3. `reducers/runtime.ts`：
   - `applyRunTerminalEvent` 的 `upsertRun` 更新对象加 `summary` 构造（从 payload 建 RunSummary，镜像后端 `_run_summary_for`）；
   - `run_failed` 时 `error` 仍取 `payload.error`，`summary.error_code` 取 `payload.error_code`；
   - 新增 `publication_created` 事件分支（在顶层 reducer 事件分派处）：更新 `currentPublicationId` + append `publications`（supersedes 用旧 current 补缺）。
   - 全仓 `grep -rn "no_artifact_failure" frontend/src` 清零（reducer/类型/组件）。

- [ ] **Step 4: 运行通过** — `pnpm test -- terminal-state` PASS；`pnpm tsc` 零错误（旧 `task-outcome.test.ts` 若引用已删类型会报错——Task 10 删除该文件，本任务先 `pnpm tsc` 允许其报错则跳过，或一并删）。

- [ ] **Step 5: Commit** — `git add frontend/src/runtime/ && git commit -m "feat(phase4a): frontend contracts + reducer for run.summary and publications"`

---

### Task 10: 前端组件 — 四态展示，删除字符串猜测

**Files:**
- Delete: `frontend/src/components/taskOutcome.ts`、`frontend/src/test/task-outcome.test.ts`
- Modify: `frontend/src/components/taskStatus.tsx`、`frontend/src/components/SessionSidebar.tsx`、`frontend/src/components/ChatPanel.tsx`、`frontend/src/components/ResultsViewer.tsx`
- Test: `frontend/src/test/session-sidebar.test.tsx`（追加）、`frontend/src/test/chat-panel.test.tsx`（追加）

**Interfaces:**
- Consumes: `RunProjection.summary`（Task 9）
- Produces: 四态图标/标签（`succeeded/partial_success/no_data/spec_rejected`）；`ResultsViewer` NO_DATA 展示 `user_message`

- [ ] **Step 1: 写失败测试**（追加 `frontend/src/test/session-sidebar.test.tsx`）

```tsx
it("renders four-state outcome from run.summary.build_result", () => {
  // 构造 status="completed"、run.summary.build_result.status="no_data" 的 task，
  // 断言侧栏图标为 Info 风格（sky 色 class 或 InfoIcon 存在）。
});
```

- [ ] **Step 2: 运行确认失败** — `cd frontend && pnpm test -- session-sidebar` 预期 FAIL（组件仍用 `taskOutcome`）。

- [ ] **Step 3: 实现**

1. **删除** `components/taskOutcome.ts` 与 `test/task-outcome.test.ts`。
2. `taskStatus.tsx`：删除 `TaskOutcome` import；新签名：

```tsx
export function TaskStatusIcon({
  status,
  buildStatus,
  className,
}: {
  status: RunStatus;
  buildStatus?: BuildResultStatus;
  className?: string;
}) {
  // completed: buildStatus === "no_data" ? InfoIcon : CheckCircleIcon
  //   （spec_rejected 用 ProhibitIcon；partial_success 用 CheckCircleIcon）
  // failed/cancelled/interrupted 维持现逻辑（failed 不再映射 no_data）
}
```

3. `SessionSidebar.tsx`（`:108`）：`const outcome = taskOutcome(task)` 删除；改为读 `latestRun.summary`：

```tsx
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  const latestRun = latestRunId === undefined ? null : task.runsById[latestRunId] ?? null;
  const buildStatus = latestRun?.summary?.build_result?.status ?? null;
  const statusIconClass = active
    ? "text-primary"
    : buildStatus === "no_data"
      ? "text-sky-600 dark:text-sky-400"
      : buildStatus === "spec_rejected"
        ? "text-amber-600 dark:text-amber-400"
        : summary.status === "failed" || summary.status === "cancelled" || summary.status === "interrupted"
          ? "text-destructive"
          : undefined;
```

4. `ChatPanel.tsx`（`:85`）：`STATUS_LABELS` 增加 build 结果标签映射：

```ts
const BUILD_LABELS: Record<BuildResultStatus, string> = {
  succeeded: "构建成功",
  partial_success: "部分成功",
  no_data: "无数据",
  spec_rejected: "规格被拒",
};
```

在状态徽章渲染处（completed 时）若 `latestRun.summary?.build_result?.status` 存在则显示 `BUILD_LABELS[status]`，否则回退 `STATUS_LABELS.completed`。
5. `ResultsViewer.tsx`（`:164-169`）：`state.data === null || state.data.headers.length === 0` 分支改为：

```tsx
  if (state.data === null || state.data.headers.length === 0) {
    const noDataMessage = task.summaryLatestBuildMessage ?? "无数据";
    return (
      <Empty className="border-0 py-4">
        <EmptyHeader><EmptyTitle>{noDataMessage}</EmptyTitle></EmptyHeader>
      </Empty>
    );
  }
```

（`summaryLatestBuildMessage` 由组件 props 或 `useTaskProjection` 从最新 run 的 `summary.user_message` 取；若无上下文则先展示静态"无数据"，组件签名按现有数据流扩展。）
6. `grep -rn "taskOutcome\|isNoArtifactFailure\|taskHasArtifacts" frontend/src` 应零结果。

- [ ] **Step 4: 运行通过** — `pnpm test` 全绿；`pnpm lint && pnpm tsc && pnpm build` 零错误。

- [ ] **Step 5: Commit** — `git add -A frontend/src && git commit -m "feat(phase4a): four-state outcome display; remove taskOutcome string guessing"`

---

### Task 11: 全量验证与文档

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-phase4a-terminal-state-design.md`（实现后归档到 `docs/archive/superpowers/specs/`）、`docs/REVIEW_2026-08-06-phase3-expression-demo.md` 或新建 `docs/REVIEW_2026-08-06-phase4a-terminal-state.md`

- [ ] **Step 1: 后端全量** — `cd backend && uv run pytest -q` 全绿；`uv run ruff check app/ tests/` 相对基线零新增告警。

- [ ] **Step 2: 反模式残留检查** — `grep -rn "NO_ARTIFACT_FAILURE_MARKERS\|without producing any artifacts\|no_artifact_failure" backend/ frontend/src/` 应零结果（除归档文档历史引用）。

- [ ] **Step 3: 冒烟** — `uv run uvicorn app.main:app --port 8126 &` 启动；`curl http://127.0.0.1:8126/api/v1/health` 返回 ok；清理进程。

- [ ] **Step 4: 前端门** — `cd frontend && pnpm lint && pnpm tsc && pnpm build` 零错误。

- [ ] **Step 5: 文档** — 规格文件归档到 `docs/archive/superpowers/specs/`（原路径留说明或删除）；REVIEW 文档记录实现事实、与规格的偏差（如：`cancelled_at_stage` 4a 内固定 None、`PARTIAL_SUCCESS` 判定收敛为保守两分支、`valid_row_count` 暂为 0 待 4b 注入）。

- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs(phase4a): archive spec + review notes; verification gates green"`

---

## Self-Review

- **Spec 覆盖**：§3.1 RunSummary→T1；§3.2 事件负载→T2；§3.3 BuildResult 核对→T1/T4；§3.4 TaskSnapshot→T1；§4.1 BuildResult 计算→T4；§4.2 manager→T5/T6；§4.3 Publication 链→T5/T7；§4.4 字符串回扫删除→T6/T7；§5 P1 role→T8；§6 前端→T9/T10；§7 测试→各任务内嵌 + T11；§8 兼容→T7 旧事件重放 + T2 optional 字段。唯一收敛：spec §4.1 的 PARTIAL_SUCCESS/manifest_unchanged 判定在 4a 无注入点，已在 T4 注明收敛为保守两分支（SUCCEEDED/NO_DATA），文档任务同步记录。
- **占位符扫描**：所有 Step 均含具体代码或"复用现有 fixture 结构"的精确指引；`...` 仅出现在需复用项目内现有构造 helper 的测试代码处（标注了参照文件）。
- **类型一致性**：`publication_id = f"pub-{run_id}"` 在 T5 定义、T7 测试引用一致；`RunSummary`/`PublicationSummary` 字段名在 T1 定义、T7 聚合、T9 前端镜像一致；`_compute_build_result` 在 T4 定义、T6 manager 走 `execution.build_result` 兜底 `_no_data_build_result()` 一致；`role_for_filename` T8 定义并被 T8 测试引用一致。
