# Phase 7 T3 — 通用 operation events 后端契约与 emission（backed half）

**Branch**: `feat/phase7-t3-operation-events`
**Commit**: `5e33356` (`5e33356642e03c3b73df144fc7af95c3151b22e5`)
**Status**: DONE — full suite green (2668 passed; baseline 2658), ruff clean, `import app.main` OK

---

## 1. 契约选择（Choice + Rationale）

**选择方案 (a)：复用/扩展既有 `operation_*` 事件类型**（`operation_started` /
`operation_progress` / `operation_completed` / `operation_failed`），而不是
(b) 在 `stage_*` payload 上叠加可选 operation 字段。

理由：

1. **事件类型已存在**：`RuntimeEventType` 早已声明 4 个 operation 事件
   （`app/domain/contracts/events.py`），前端 `contracts.ts` 的 `EventPayload`
   联合类型也已声明（label/category 为 optional），V2 dataset executor
   （`app/datasets/runtime/executor.py`）已按此契约发射。T3 只需补上
   pipeline stage 发射侧的镜像，而不是发明新类型。
2. **向后兼容最干净**：新增事件类型 + 可选字段是纯增量。旧 `events.jsonl`
   回放时，缺少 `label`/`category` 的 operation 事件走 pydantic 默认值
   `""`；reducer（`reduce_task_event`）对 operation 事件走通用
   `run_id` 分支（纯游标推进），不改变任何状态语义。`stage_*` 事件
   **保持原样发射**（schema 1.0、无 run_id、顺序不变），前端依赖不受影响。
3. **与 ARCHITECTURE §14.2 / §17.2 一致**：文档已写明 V2 用
   `operation_id`/`label`/`category` 渲染、兼容期与 `stage_*` 并存。

### 契约扩展（最小增量）

- `OperationProgressPayload` / `OperationCompletedPayload` /
  `OperationFailedPayload` 新增可选字段 `label: str = ""`、
  `category: str = ""`（默认空串；旧事件回放合法，V2 executor 现有发射不受影响）。
- 新增共享映射 `stage_operation_spec(stage: StageName) -> (operation_id, label, category)`：
  - `operation_id = f"stage:{stage.value}"`（稳定、UI 可归组，风格对齐 V2 的
    `kind:detail` 稳定 id）
  - `label` 镜像前端 `STAGE_LABELS`（文献/数据发现、数据获取、数据处理、
    产物构建、结果验证），wire label 自包含
  - `category = stage.value`（复用既有 `StageName` 枚举值，
    discovery/acquisition/processing/artifact_build/validation）
- `OperationStartedPayload` 原本就带 `label`/`category`/`attempt`，未改动语义。

## 2. 发射位置（与 stage_* 同源，无 stage_* 事件丢失）

Pipeline runner（`app/pipeline/runner.py`）新增 `_emit_operation_event`
（run-scoped，schema 2.0 + `run_id=self.ctx.run_id`；`_build_event` 增加
可选 `run_id` 参数）。每个 stage_* 发射点之后立即发射配对 operation 事件：

| stage_* 事件 | 配对 operation 事件 |
| --- | --- |
| `stage_started` (`_run_stages_loop`) | `operation_started`（带 attempt） |
| `stage_completed` (`_run_stages_loop`) | `operation_completed`（SUCCEEDED + output_digest） |
| `stage_skipped` (`_try_reuse_stage`) | `operation_completed`（SKIPPED + reused_operation_attempt_id） |
| `stage_failed` (`_finalize_stage_failed`) | `operation_failed`（FAILED + error） |
| `stage_progress` (`_emit_progress_event`) | `operation_progress`（同 kind/current/total/detail） |
| （取消路径 `_finalize_cancelled`，有 inflight） | `operation_failed`（CANCELLED）— 闭合 operation 生命周期，形状对齐 V2 `BuildCancelledError` 路径 |

Agent 模式 skills 进度：`app/agent_loop/runner.py` 的
`bind_progress_emitter` 闭包（`RunContext.emit_progress` 通道）同步镜像
`operation_progress`。两处 progress 镜像都复用 `stage_operation_spec`，
保证同一 stage 的 operation_id 一致。

`FixtureRunExecutor` / `AgentRunExecutor` 的 bridge
（`persist_pipeline_event`）本就转发所有 envelope，operation 事件自动进入
durable 事件日志（repository 以 execution run_id 重建 envelope），
WS 无 allowlist，订阅即转发。**未改任何 `stage_*` 事件的发射内容、顺序或
含义**；仅在其后追加 operation 镜像。

## 3. 测试（TDD：先红后绿，+10 个新测试）

1. `tests/contracts/test_operation_event_contracts.py`（新，5 个）：
   - 4 种 operation payload 带 label/category 的 JSON 序列化 round-trip
   - 旧 payload（无 label/category）构造合法（默认 ""）
   - `stage_operation_spec` 对 5 个 StageName 稳定且 category 映射正确
   - operation 事件强制 run 关联（schema_version 2.0）
   - **旧 events.jsonl 回放**：无 label/category 的 operation 事件经
     `reduce_task_event` 全流程 green
2. `tests/pipeline/test_operation_events.py`（新，4 个）：
   - fixture 全量运行：5 组 stage_started/completed 逐一配对 operation
     事件（id/label/category/attempt/output_digest 一致）
   - fixture 运行中每个 `stage_progress` 配对 `operation_progress`
   - 二次运行（digest 复用）：3 个 `stage_skipped` 配对
     `operation_completed(SKIPPED)`
   - 失败路径（monkeypatch acquisition）：`stage_failed` 配对
     `operation_failed`（同 error）
3. `tests/api/test_websocket_replay.py`（+1）：
   - durable operation 事件经 WS 订阅原样转发（无 allowlist 需扩展，此测试
     锁定"操作事件可达前端"这一行为）
4. `tests/pipeline/test_event_envelope_unified.py`（更新 1 处断言）：
   - runner 自身事件流从"全部 schema 1.0"放宽为 `{"1.0","2.0"}`——
     operation 镜像是 run-scoped RuntimeEventType，必须带 run_id/schema 2.0；
     其余 canonical 字段断言不变。这是唯一需要改动的既有测试。

## 4. 验证结果

- `pytest -q`：**2668 passed, 2 skipped, 28 deselected**（基线 2658 + 10 新）
- `ruff check app/ tests/ launcher.py`：clean
- `python -c "import app.main"`：OK

## 5. 文档同步

- `AGENTS.md` §2 WS 事件类型列表：补 `operation_started/progress/completed/failed`
  并加 T3 说明（stage_* 仍发射且被 operation 镜像，前端按 operation 身份渲染）。
- `docs/ARCHITECTURE.md` §14.2 / §17.2 已预先记录 operation superset，无需改动。

## 6. 边界与注意事项（Concerns）

- **schema 版本混合**：runner 自身 `events` 列表现在同时含 v1 stage 事件与
  v2 operation 事件——这是 operation 事件为 run-scoped 的必然结果；
  `test_event_envelope_unified.py` 已相应放宽。durable 日志由 repository
  统一以 execution run_id 重建，不受影响。
- **progress 镜像的 detail 值**：`OperationProgressPayload.detail` 是
  `dict[str, JsonValue]`；skills/stages 现有 detail 均为 JSON 安全值
  （已核对 7 处 emit_progress 调用点）。
- **取消路径**：`_finalize_cancelled` 在有 inflight attempt 时补发
  `operation_failed(CANCELLED)` 以闭合生命周期；该路径原本没有对应
  stage 终态事件，属于对 operation 生命周期的补全（对齐 V2 行为）。
- **前端**（T5 后续）：`frontend/src/lib/eventParsers.ts` 的
  `RUNTIME_TYPES` 尚未包含 operation_*，且 `eventParsersRuntime.ts` 无
  operation parser——本次为后端契约，前端解析/渲染留待 T5。
- `docs/TODO.md` 中 T3+T5 合并条目未勾选（前端半程未完成），保持待办同步。
