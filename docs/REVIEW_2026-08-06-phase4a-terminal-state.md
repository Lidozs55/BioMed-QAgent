# REVIEW — Phase 4a 终态语义核心（BuildResult / Publication / RunSummary）

日期：2026-08-06
分支：`feat/phase4a-terminal-state`
结论：**TODO Phase 4 的 P0-2/3/4/5 + P1 全部落地并有测试**；P0-1（空表语义）属
Phase 4b、P2（HIL）属 Phase 4c，均不在 4a 范围。T1–T10 实现完毕，
T11 全量验证通过（后端 2183 passed、前端 619 passed、冒烟 ok、ruff 全量门零告警）。

## 1. 交付内容

对应 `docs/TODO.md` Phase 4 条目与 Design（已归档
`docs/archive/superpowers/specs/2026-08-06-phase4a-terminal-state-design.md`）：

| TODO 条目 | 交付 | 对应任务 |
| --- | --- | --- |
| P0-2 引入 `BuildResult`；`RunStatus` 不再由 artifact 数量推导 | `BuildResult`/`BuildResultStatus` 契约 + `RunManifest.build_result` + `_compute_build_result`（finalize 处计算）+ manager 终态不再按 artifact 计数判 FAILED | T1/T3/T4/T6 |
| P0-3 不可变 Publication 与 `current_publication_id`；新版本不修改旧版本 | `PublicationCreatedPayload` 事件 + `PublicationSummary` 聚合 + reducer 只 append 不修改 + 发布前禁写 staging manifest（deferred publication） | T2/T5/T7 |
| P0-4 服务端始终生成 `RunSummary`：COMPLETED 附 BuildResult、FAILED 附稳定错误分类、CANCELLED 附取消点 | `RunSummary` 契约 + 终态事件携带 `build_result`/`error_code`/`cancelled_at_stage` + reducer 投影 `run.summary`；Agent 文本不再是唯一输出 | T1/T2/T5/T7 |
| P0-5 前端直接展示 NO_DATA / PARTIAL_SUCCESS / SPEC_REJECTED，删除错误字符串猜测 | 前端四态 outcome 渲染（NO_DATA / PARTIAL_SUCCESS / SPEC_REJECTED / SUCCEEDED）+ `taskOutcome` 字符串猜测删除 + `cancelled_at_stage` 渲染 | T9/T10 |
| P1 审计产物通过 `audit_report` Artifact Role 发布 | `ArtifactManifestEntry.role` 必填 + `role_for_filename` 分类 + 审计产物标注 `AUDIT_REPORT` + 旧数据 mode="before" 容错 | T8 |
| （4a 隐含）反模式删除 | `no_artifact_failure` 字符串回扫/字段/SQL 列全量删除 + 旧快照 pop 容错 | T6/T7 |

测试：后端新增/修改覆盖于 `tests/contracts/`、`tests/pipeline/`、`tests/runtime/`、
`tests/agent_loop/`（终态事件负载、BuildResult 计算、Publication 链、reducer 聚合、
role 分类、旧事件重放兼容）；前端 `tests/` 覆盖四态渲染与 reducer。全量门见 §3。

## 2. 实现事实

### 2.1 契约层（`backend/app/domain/contracts/`）

- `runtime.py`：`RunSummary`（status / build_result / error_code / `cancelled_at_stage`
  等）；`TaskSnapshot.current_publication_id` + `TaskSnapshot.publications`。
- `events.py`：`PublicationCreatedPayload`（publication_id=`pub-<run_id>`、run_id、
  manifest_sha256、supersedes_publication_id）；`RunCompletedPayload` 携带
  `build_result`；`RunFailedPayload` 携带 `error_code`（结构化枚举）；`RunCancelledPayload`
  携带 `cancelled_at_stage`。全部向后兼容（默认 None/空）。
- `dataset_state.py`：`BuildResult` / `BuildResultStatus`（SUCCEEDED / NO_DATA /
  SPEC_REJECTED / PARTIAL_SUCCESS）/ `ArtifactRole`（primary / supporting_dataset /
  schema / provenance / audit_report）——因 import 环从 `app/datasets/contracts.py` 迁入（见 §3 偏差 1）。
- `pipeline.py`：`RunManifest.build_result` + `error_code`；`ArtifactManifestEntry.role`
  必填 + mode="before" 旧数据注入 `AUDIT_REPORT`。

### 2.2 Runner / Manager / 事件溯源

- `pipeline/runner.py`：finalize 处 `_compute_build_result(manifest)`（保守两分支：
  primary 存在→SUCCEEDED，否则 NO_DATA + `no_primary_data`）。
- `agent_loop/runner.py`：`execution.set_build_result(...)` 灌入执行器；commit 时以
  `pub-<run_id>` 覆盖占位 `publication_id` 并发射 `PublicationCreatedPayload`；
  `commit_agent_artifacts` 作为 deferred publication 原子落盘（重放期不写 staging
  manifest）。
- `runtime/manager.py`：终态判定删除 artifact 计数反模式——无产物不再判 FAILED，
  而是 COMPLETED + NO_DATA；失败路径输出稳定 `error_code`；取消路径携带
  `cancelled_at_stage`（4a 内固定 None，见 §3 偏差 2）。
- 事件溯源：reducer（`app/runtime/state.py` + 前端 `runtime/reducer.ts`）从
  `publication_created` 聚合 `publication_summaries`、从终态事件投影 `run.summary`；
  `repository.py`/`index.py` 加载前 pop 旧快照中的 `no_artifact_failure`。

### 2.3 前端（`frontend/src/`）

- 契约镜像：`run.summary`、`publications`、终态事件负载解析（含 run_id 一致性校验）。
- 组件：四态 outcome 展示（Badge/颜色区分 SUCCEEDED / NO_DATA / PARTIAL_SUCCESS /
  SPEC_REJECTED），`taskOutcome` 字符串猜测逻辑删除，`cancelled_at_stage` 渲染。

## 3. 与规格的偏差

1. BuildResult/BuildResultStatus/ArtifactRole 因 import 环迁至 `app/domain/contracts/dataset_state.py`，`app/datasets/contracts.py` re-export 保持原路径可用（环源于 `app/datasets/__init__` → schema_registry → pipeline → domain.contracts 包）。
2. `cancelled_at_stage` 字段 + 前端渲染就位，4a 内 manager 取消路径固定传 None（用户取消时 manager 无活动 stage 信息；fixture 路径可确定时再填充）。
3. PARTIAL_SUCCESS / manifest_unchanged 在 4a 不产生：`_compute_build_result` 保守两分支（main_data.csv 存在→SUCCEEDED，否则 NO_DATA+no_primary_data）；V1 finalize 处无来源级统计注入点，4b 接入 V2 统计后启用。
4. `valid_row_count` 暂为 0（SUCCEEDED 亦为 0），4b 注入真实行数统计。
5. SUCCEEDED 的 `publication_id` 在 staging `RunManifest.build_result` 中为确定性占位 `pub-<task_id>`（BuildResult.validate_state 要求；published `run_manifest.json` 可能不含 enriched build_result）；权威发布身份在 `PublicationCreatedPayload` 事件（`pub-<run_id>`）+ run.summary，占位值明确非权威（dataset_state.py docstring 已注）。
6. `no_artifact_failure` 全量删除（字段/SQL 列/回扫/backfill），旧持久化快照含该键时在 repository/index 加载前 pop 容错。
7. `ArtifactManifestEntry.role` 必填 + mode="before" 旧数据容错（缺失注入 AUDIT_REPORT），保证旧 events.jsonl/run_manifest.json 重放。
8. `list_artifacts` API 未暴露 role（前端按文件名消费现状保留），spec §5 的消费方迁移留待后续。
9. manager 测试断言在事件日志层（RunCompletedPayload.build_result / RunFailedPayload.error_code），run.summary 属 reducer 投影（T7）。
10. phase4a 自身的 import 排序问题：`app/agent_loop/runner.py` 与
    `tests/agent_loop/test_execution.py` 的 2 处 I001 已在 T11 commit 最小修复
    （import 重排，零行为变更），全量 CI ruff 门 `uv run ruff check app/ tests/ launcher.py`
    现为零告警。此前报告的 compaction*.py I001 为环境假阳性——
    `backend/app/{agents,llm,models,provenance,storage,utils}` 六个未跟踪空目录
    （历史遗留）使 ruff 将第三方 `agents` 导入误判为 first-party，干净 worktree
    验证中这些文件全部通过。`pnpm tsc -b` 脚本为坏 no-op（真实门在 pnpm build 内）
    与示例 manifest backend/data/examples/gse178352/run_manifest.json 陈旧两项保持
    未触碰（与验收范围无关）。
11. `PublicationCreatedPayload` 发射时 `supersedes_publication_id=None`：链链接由
    reducer 在投影时从任务先前的 `current_publication_id` 推导（与已归档规格的
    "reducer derives from chain head" 设计一致；EVENT 负载不携带前序 id）。

## 4. 验证结果（T11）

| 门 | 结果 |
| --- | --- |
| 后端 pytest | `2183 passed, 2 skipped, 28 deselected` |
| 后端 ruff（全量 `app/ tests/ launcher.py`） | 0 errors（`All checks passed!`） |
| 反模式残留扫描（backend + frontend/src） | 0 matches |
| 冒烟 | `GET /api/v1/health` → `{"status":"ok","version":"1.0.0","arch":"agent_loop"}` |
| 前端 lint | 0 errors（`eslint . --max-warnings 0`） |
| 前端 build | `pnpm build`（tsc -b + vite）成功 |
| 前端 test | `619 passed (40 files)` |

## 5. 后续（4b / 后续阶段）

- **4b**：空表语义（P0-1，删除 metadata-only 占位）、PARTIAL_SUCCESS / manifest_unchanged
  判定、`valid_row_count` 真实行数注入（V2 链统计接线后启用）。
- **4c**：`request_human_correction` function_tool + UserInputDialog `data_correction`
  分支 + 超时退化为 `corrections_todo.csv`（P2 HIL）。
- **后续**：`list_artifacts` API 暴露 role 并迁移消费方（spec §5）；manager 取消路径在
  fixture 路径可确定时填充 `cancelled_at_stage`。
