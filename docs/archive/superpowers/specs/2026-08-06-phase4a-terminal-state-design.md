# Phase 4a 设计：终态语义核心（BuildResult / Publication / RunSummary）

> 日期：2026-08-06 ｜ 状态：已批准，待实施 ｜ 对应 `docs/TODO.md` Phase 4 P0-2/3/4/5 + P1
> 推进顺序：4a（本文档）→ 4b（空表语义，P0-1）→ 4c（HIL，P2）
> 权威设计：`docs/ARCHITECTURE.md` §9（四类正交状态）、§9.2/9.3/9.4/9.5/9.6、§10

## 1. 背景与目标

V1 生产路径（Agent 驱动的 `pipeline/runner.py` + `runtime/manager.py`）存在三处
反模式，Phase 4 目标即消灭它们：

1. **Artifact 数量推导成功**：`runtime/manager.py:1679-1690` 在 AGENT 模式下，
   `execution.agent_executed and not completion_events`（零 ArtifactProduced 事件）
   时把 run 置为 `RunFailedPayload("agent completed without producing any
   artifacts (manifest missing or unchanged)")`。随后 `runtime/state.py:56-57`
   与 `repository.py:597-640` 用**错误字符串 markers** 回扫还原 `no_artifact_failure`，
   前端 `taskOutcome.ts:5-7` 再次复制同一组字符串做猜测。违反 ARCHITECTURE §9.6。
2. **错误分类丢失**：runner 已用 `ErrorCode` 枚举（`enums.py:198`，9 类）打标
   （`_finalize_failed`），但沿 runner→agent_loop→manager 只传递自由文本 `error`，
   `RunFailedPayload.error: str` 不含结构化分类。前端只能看文本。
3. **Publication 无对象形态**：发布是文件系统原子 swap + `.runtime-publication.json`
   标记，无不可变 `DatasetPublication` 记录、无 `current_publication_id`、无版本链
   （`supersedes` 从不填充）。`TaskSnapshot` 无 artifacts 字段，只有
   `artifact_count`/`no_artifact_failure` 计数。违反 ARCHITECTURE §5.3/§9.3。

**4a 范围**（TODO Phase 4）：

- P0-2 引入 `BuildResult`；`RunStatus` 不再由 artifact 数量推导
- P0-3 不可变 `DatasetPublication` 与 `current_publication_id`；新版本不修改旧版本
- P0-4 服务端始终生成 `RunSummary`：COMPLETED 附 BuildResult、FAILED 附稳定
  error_code、CANCELLED 附取消点；Agent 文本不再是唯一输出
- P0-5 前端直接展示 NO_DATA / PARTIAL_SUCCESS / SPEC_REJECTED，删除错误字符串猜测
- P1 审计产物通过 `audit_report` Artifact Role 发布，不在架构层固定文件名

**不在 4a 范围**：

- P0-1 空表/NO_DATA 语义（删除 metadata-only 占位）→ **4b**（依赖 4a 的 BuildResult）
- P2 HIL `request_human_correction` → **4c**（独立）
- SPEC_REJECTED 的产生点：V1 无 spec 校验路径，模型 + 前端支持先行，产生点随
  V2 chain 接入自然出现（`datasets/build/chain.py` + `spec_validator.py` 已具备）
- `GET /tasks/{id}/builds` 系列端点（ARCHITECTURE §17 API 表 🚧）：留待 V2 接线
- V2 `execute_dataset_build` 工具接线、`BuildChainResult` → `BuildResult` 映射

## 2. 已确认的设计决策（与用户逐项确认）

| # | 决策 | 选择 |
|---|---|---|
| 1 | 推进顺序 | 4a → 4b → 4c |
| 2 | BuildResult 产生位置 | **V1 runner 改造**：`_finalize_completed` 计算，manager 消费；模型共享 `datasets/contracts.py` |
| 3 | Publication 持久化 | **事件溯源**：`PublicationCreatedPayload` → `events.jsonl` → reducer 聚合 `current_publication_id`；文件系统 swap 保留为 artifact 提升机制 |
| 4 | RunSummary 载体 | **终态事件携带结构化负载**：`run_completed` 带 BuildResult、`run_failed` 带 `error_code`、`run_cancelled` 带取消点；快照聚合，`GET /tasks/{id}` 返回 |
| 5 | 前端展示 | **四态视觉 + 轻量摘要**：删除 `taskOutcome` 两态猜测，直接消费 `run.summary` |

## 3. 契约层（`backend/app/domain/contracts/`）

### 3.1 RunSummary（新，`runtime.py`）

`RunSummary` 是运行时/API 概念，放 `runtime.py`；引用 `datasets.contracts.BuildResult`
（V2 共享模型，AGENTS.md 规定 `app.datasets.contracts` 只放 V2 数据集契约，runtime
是上层可引用）。

```python
class RunSummary(ContractModel):
    run_status: RunStatus
    build_result: BuildResult | None = None      # COMPLETED 时非空
    error_code: ErrorCode | None = None          # FAILED 时非空
    cancelled_at_stage: StageName | None = None  # CANCELLED 时可能非空
    user_message: str | None = None              # 服务端生成的用户摘要
```

- `RunStatus`/`ErrorCode`/`StageName` 均已在 `enums.py`（`ErrorCode` 9 类已存在，
  直接复用，不新增）
- 取消点直接复用 `StageName`（`DISCOVERY/ACQUISITION/PROCESSING/ARTIFACT_BUILD/
  VALIDATION`，`enums.py:169` 已存在），不另造枚举

### 3.2 事件负载扩展（`events.py`，向后兼容）

| 事件 | 现负载 | 4a 扩展 |
|---|---|---|
| `run_completed` | 空 | `build_result: BuildResult`（required，COMPLETED 必有）|
| `run_failed` | `error: str` | `error_code: ErrorCode`（required）|
| `run_cancelled` | `reason: str\|None` | `cancelled_at_stage: StageName\|None`（optional）|
| `publication_created`（**新事件类型**）| — | `publication_id, run_id, manifest_sha256, supersedes_publication_id\|None, published_at` |

- 旧 `events.jsonl` 重放：`run_failed` 无 `error_code` 时 reducer 回填
  `ErrorCode.INTERNAL_ERROR`（或从已知 markers 映射，见 §4.4——倾向不回扫，
  直接 INTERNAL_ERROR，避免新的字符串猜测）；`run_completed` 无 `build_result`
  时回填 `BuildResult(status=NO_DATA, reason_codes=["legacy_event"])` 或 None——
  **决策：回填 None，前端把无 build_result 的旧 run 视为"完成但无结构化结果"**。
- `publication_created` 加入 `RuntimeEventType` 枚举与 `EventEnvelope` 允许类型。

### 3.3 BuildResult 补充（`datasets/contracts.py`）

现有 `BuildResult`（`:237`）已含 `status/reason_codes/user_summary/valid_row_count/
successful_sources/rejected_sources/available_artifact_roles/publication_id`。
4a 需要的调整：

- 检查 `validate_state`（`:256-276`）：`NO_DATA ⇒ valid_row_count == 0`；
  `publication_id` 仅 SUCCEEDED/PARTIAL_SUCCESS——确认与 §9.2 一致（NO_DATA 可有
  审计型 Publication，见 §9.4，若有需要放宽为 NO_DATA 也可带 publication_id；
  **决策：保持 NO_DATA 无 publication_id，审计型 Publication 属 4b 审计交付**）
- 不新增字段，除非实现时发现缺口（YAGNI）

### 3.4 TaskSnapshot 扩展（`runtime.py`）

```python
class PublicationSummary(ContractModel):
    publication_id: str
    manifest_sha256: str
    supersedes_publication_id: str | None = None
    published_at: datetime

class TaskSnapshot:  # 增加
    current_publication_id: str | None = None
    publications: list[PublicationSummary] = Field(default_factory=list)
    # runs 增加 summary 字段：runs[].summary: RunSummary | None
```

- `TaskSummary.no_artifact_failure` 标记废弃（删除或保留为 deprecated——**决策：删除**
  `artifact_count` 保留；前端不再依赖该布尔）

## 4. Runner / Manager 接线

### 4.1 BuildResult 计算（`pipeline/runner.py`）

`_finalize_completed`（`:1502`）在构造最终 `RunManifest` 时计算 `BuildResult`：

| 条件 | BuildResult |
|---|---|
| 无 primary dataset 产物（manifest.artifacts 无主数据条目） | `NO_DATA` + `reason_codes=["no_primary_data"]` |
| manifest 未变（`publish` 判定 unchanged，见 §4.3） | `NO_DATA` + `reason_codes=["manifest_unchanged"]` |
| 有 primary 且 validation 通过 | `SUCCEEDED`（publication_id 待发布后填充） |
| 有 primary 但部分来源 fetch/parse 失败（dataset 级） | `PARTIAL_SUCCESS` + reason_codes（列出失败来源） |
| validation 失败 | 保持 `FAILED`（RunStatus），`error_code=VALIDATION_ERROR`（§9.2：validation 失败不产生 BuildResult） |

- `valid_row_count` 从 primary 产物行数取（runner 已有统计或从 manifest 读取；
  实现时确定精确来源）
- `successful_sources` / `rejected_sources` 从 stage 统计取（discovery/acquisition
  stage 已有来源记录）
- `available_artifact_roles`：`[PRIMARY_DATASET, SCHEMA, PROVENANCE, AUDIT_REPORT]`
  子集（§5 role 标注后可用）
- `user_summary`：服务端生成的中文摘要（如"完成，主表 N 行；M 个来源被拒绝"；
  这也是 P0-4"Agent 文本不再是唯一输出"的用户可见面）
- `RunManifest` 增加 `build_result: BuildResult | None` 与 `error_code: ErrorCode |
  None` 字段（失败/取消路径的 minimal manifest 一并携带）

### 4.2 Manager 改造（`runtime/manager.py`）

- **删除 `:1679-1690` artifact-count→FAILED 逻辑**：AGENT 完成但零产物 →
  `RunCompletedPayload(build_result=BuildResult(NO_DATA, ["no_primary_data"]))`，
  RunStatus=COMPLETED（§9.4：无主数据不必然触发失败）
- `RunFailedPayload` 携带结构化 `error_code`：从 runner 返回的 `RunManifest.error_code`
  或 dispatch 异常映射表取；自由文本 `error` 保留为人类可读信息
- `RunCancelledPayload` 携带 `cancelled_at_stage`：从取消发生处的 stage 名取
- 发布路径：`PipelineRunner.publish(run_id)` 是 deferred 的（AGENT 模式），实际提交在
  `agent_loop/runner.py:commit_agent_artifacts`（先 emit `ArtifactProducedPayload` 再
  调 `pending.publish`）。`PublicationCreatedPayload` 由同一提交路径在 `publish`
  成功后 emit（与 `ArtifactProducedPayload` 同处，机制一致；若直连模式需要，
  `PipelineRunner.publish` 内同步调用后在拥有事件发射器的调用点补发）

### 4.3 Publication 链（事件溯源）

- `publish(run_id)` 原子 swap 成功后（现逻辑不变），构造
  `PublicationCreatedPayload`：`publication_id = f"pub-{uuid7-hex}"` 或复用
  manifest digest 派生；`supersedes_publication_id` = 当时 task 的
  `current_publication_id`（从 snapshot 读）
- reducer（`runtime/state.py`）：`publication_created` → 追加
  `task.publications` + 更新 `current_publication_id`；**旧 publication 记录永不修改**
  （不可变性由事件追加实现）
- `.runtime-publication.json` 标记保留（文件系统提升证据），但消费方优先读
  `TaskSnapshot.current_publication_id`

### 4.4 字符串回扫删除

- `state.py:56-57` `NO_ARTIFACT_FAILURE_MARKERS` + `:369-377`
  `no_artifact_failure_from_runs` → 删除；`task.no_artifact_failure` 字段删除
- `repository.py:597-640` 同逻辑回扫 → 删除（旧 events 重放不再回扫字符串；
  旧 `no_artifact_failure` 状态自然消失）
- 前端 `taskOutcome.ts` markers → 删除（见 §6）

## 5. P1：审计产物 Artifact Role（`pipeline/`）

- `ArtifactManifestEntry`（`pipeline.py:115`）增加 `role: ArtifactRole`（required，
  `datasets/contracts.py:35` 枚举：`PRIMARY_DATASET / SCHEMA / PROVENANCE /
  AUDIT_REPORT` 等）
- `artifact_build/builder.py` 注册产物时全量标注：

| 产物 | role |
|---|---|
| `main_data.csv`（primary） | `PRIMARY_DATASET` |
| schema / field_descriptions | `SCHEMA` |
| `source_list.csv` / `source_relations.csv` / `source_assets.csv` / `cleaning_report.csv` / quality | `AUDIT_REPORT` |
| `field_mapping.csv` / provenance | `PROVENANCE` |

- 消费方（`api/routes.py:824` `list_artifacts`、前端 ResultsViewer 分类展示）按
  `role` 而非固定文件名；架构层不再出现 `"source_list.csv"` 之类的审计文件名特判

## 6. 前端（`frontend/src/`）

- `runtime/contracts.ts`：镜像 `RunSummary / BuildResult / BuildResultStatus /
  PublicationSummary / ErrorCode`
- `runtime/reducers/runtime.ts`：`run_completed/run_failed/run_cancelled` 负载 →
  `run.summary`；`publication_created` → `task.current_publication_id` +
  `publications`
- **删除 `components/taskOutcome.ts`**（两态猜测 + markers）；`taskStatus.tsx` /
  `SessionSidebar.tsx` / `ChatPanel.tsx` 改为消费 `run.summary.build_result.status`
  与 `run.summary.error_code`：
  - 四态中文标签：`SUCCEEDED→成功` / `PARTIAL_SUCCESS→部分成功` /
    `NO_DATA→无数据` / `SPEC_REJECTED→规格被拒`（`ChatPanel.STATUS_LABELS` 扩展）
  - 图标/颜色映射沿用现有 emerald/sky/destructive 风格，四态各配
  - `isNoArtifactFailure` / `taskHasArtifacts` 字符串与计数逻辑删除
- `ResultsViewer.tsx:164-169`：删除"无数据"的 CSV 头部猜测；NO_DATA 时直接展示
  `run.summary.user_message`（服务端文本）
- 取消点展示：`run_cancelled` 时若带 `cancelled_at_stage`，摘要行显示"取消于
  {stage}"（可选，跟随 P0-4）

## 7. 测试

后端（pytest，`asyncio_mode=strict`）：

- 契约单测：`RunSummary` 构造约束、事件负载扩展（新字段默认值/required）、
  `PublicationSummary` reducer 聚合、`current_publication_id` 链式更新
- runner 集成：`_finalize_completed` 各分支（NO_DATA/manifest_unchanged/SUCCEEDED/
  PARTIAL_SUCCESS）；`publish` 后 `PublicationCreatedPayload` 的 supersedes 链
- manager 回归：**artifact-count 逻辑删除后**，零产物 run → COMPLETED + NO_DATA
  （替换现 `test_*no_artifact*` 类测试）；`RunFailedPayload.error_code` 传递
- 旧 events.jsonl 重放兼容：无 `error_code`/`build_result` 的旧事件 → snapshot
  正确回填（None/INTERNAL_ERROR），不抛错
- role 标注：builder 产物全部带合法 role；`list_artifacts` 按 role 分类

前端（vitest + jsdom）：

- reducer 单测：终态事件 → `run.summary` / `current_publication_id`
- 组件：四态标签渲染、NO_DATA 展示 `user_message`、无 `taskOutcome` 依赖
- 契约类型镜像测试（`contracts.ts` 与后端枚举一致）

## 8. 兼容性与迁移

- 事件 schema 向后兼容（新字段 optional 或 required-with-default 视字段而定；
  `run_completed.build_result` required 但旧事件重放时 reducer 容错）
- `TaskSnapshot` 字段全部新增，无删除（除 `no_artifact_failure`，前端不再用）
- 旧任务重放：`publications` 从零重建（旧任务无 publication 事件 →
  `current_publication_id=None`，`.runtime-publication.json` 仍可人工核对，不进快照）
- API 无破坏性变更；`GET /tasks/{id}` 响应只增字段

## 9. 验证清单（完成定义）

- [ ] 后端全量 `uv run pytest` 通过（含替换 artifact-count 逻辑的回归测试）
- [ ] 前端 `pnpm lint && pnpm tsc && pnpm build` 通过
- [ ] uvicorn 干净启动；`GET /tasks/{id}` 返回 `current_publication_id` +
  `runs[].summary`
- [ ] 旧事件重放无异常、无字符串回扫残留（grep `NO_ARTIFACT_FAILURE_MARKERS`
  应无结果）
- [ ] ruff 零告警（新增文件）
- [ ] docs 记录：本设计 → `docs/archive/superpowers/specs/`（实施后归档）、
  REVIEW 文档按需补充
