# Phase 7 — Cache、前端与 API 完整迁移 — 实施计划

分支：`feat/phase7-cache-ui-api`（base main @ 8fb8c32）
Spec：Design §16 Phase 7 + TODO Phase 7（10 条目，P0×4/P1×3/P2×3）
流程：Phase 5 模式——每任务 TDD 红→绿、隔离 worktree、报告至 `.superpowers/phase7/`、全门后合并、最终 review loop。

## 任务分解

| # | 条目 | 内容 | 依赖 |
| --- | --- | --- | --- |
| T1 | P0 API 状态分离 + builds 端点 | RunStatus/BuildResult/ValidationResult/Publication 分别返回；新增 builds 端点（BuildResult + manifest 产物）；durable `execution.build_result` from `execute_dataset_build`（Phase 4 bug-sweep 延后项）；**F4** probe-primary publication 发射 `PlatformRecord`（Phase 5 REVIEW §3 accepted deviation） | — |
| T2 | P0/P1 Cache API + 双读双写 | cache 检索/列表 HTTP 端点（core `DatasetCacheV2` 已落地）；旧 artifact API 双读双写迁移；`main_data.csv` 包装为 `gene_expression.long.legacy.v1` | T1（routes.py 顺序） |
| T3 | P0 operation events | `operation_id`/`label`/`category` 替代固定 StageName union（兼容期保留 `stage_*`） | — |
| T4 | P0/P1 前端 ResultsViewer | Manifest-driven：读 `dataset_manifest.json` 展示 family/grain/schema/rows/coverage/validation/confidence/provenance/partial-NO_DATA 原因；Tabs 分离主数据/来源/处理/警告（§3.1） | T1 API 契约 |
| T5 | P1 前端 operation 渲染 + 折叠 | 通用 operation events 渲染（§3.4 归组）；对话流任务节点以 `tool_completed` 自动折叠 | T3 契约 |
| T6 | P2 前端杂项 | `toolLabels` invoke_skill/find_skill（§3.2）；模型搜索框恢复 + `LEGACY_MODELS` 清理（§3.3）；通用 UI 改进（§3.5：command/menubar、缓存导出按钮、对话路由） | T4/T5 后 |

## 波次

- 波 1（并行 2）：T1（后端）、T3（后端）— 文件区完全不相交（routes/contracts vs events）
- 波 2（并行 2）：T2（后端，基于 T1 后 routes.py）、T4（前端，依赖 T1 契约）
- 波 3（1 前端）：T5 + T6（同一 worker 顺序做，共享前端组件区）
- 波 4：最终 review loop（前后端全门）→ 合并 main

## 全门

- 后端：`pytest -q`（baseline 2658）、`ruff check app/ tests/ launcher.py`、`import app.main`
- 前端：`pnpm lint && pnpm tsc && pnpm build && pnpm test`（vitest 687 基线）
- 无 live 网络测试
