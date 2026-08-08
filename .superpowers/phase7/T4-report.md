# Phase 7 T4 — Manifest-driven ResultsViewer + Tabs 分离（frontend）

**Branch**: `feat/phase7-t4-results-viewer` (worktree `/tmp/pi-agent-1e1a94c6-edb6-455-275e4699`)
**Base**: `8fb8c32` (main) + Phase 7 T1/T3 already merged
**Status**: DONE — full suite green (698 passed / 43 files; baseline 687 / 42), `pnpm lint` 0 warnings, `pnpm tsc` clean, `pnpm build` OK.

---

## 1. 契约对接（Phase 7 T1 builds API，backend 已合并）

T1 新增三个端点（`backend/app/api/routes.py`，均未改动）：

- `GET /api/v1/builds?limit=&cursor=` → `BuildPage`（newest-first；每项含 BuildResult + family/grain/schema/row_count/status）
- `GET /api/v1/builds/{build_id}` → `BuildDetail`（BuildResult + `DatasetManifest` 摘要 + `DatasetPublication` + manifest artifact inventory）
- `GET /api/v1/builds/{build_id}/artifacts/{artifact_id}` → 下载 manifest 注册的产物（sha/size 校验）

前端新增对应契约与解析器：

- `src/runtime/contracts.ts`：`ArtifactRole`、`ManifestArtifactEntry`、`DatasetManifest`、
  `DatasetPublication`、`BuildSummary`、`BuildPage`、`BuildDetail`（字段镜像 backend
  ContractModel；`source_summary`/`validation_summary`/`confidence_summary`/
  `provenance_summary` 为 `Record<string, JsonValue>`，与既有 `JsonValue` 复用）。
- `src/lib/apiResponseParsers.ts`：`parseBuildPage` / `parseBuildDetail`
  （field-level 校验，风格对齐既有 parser；`build_result` 可空，`publication` 可空）。
- `src/hooks/useAPI.ts`：`fetchBuilds` / `fetchBuild` / `getBuildArtifactUrl`
  （`APIClient` 接口 + 实现，URL encode 与既有端点一致）。

## 2. 新组件 `BuildResultsViewer`（manifest-driven）

`src/components/BuildResultsViewer.tsx`，props `{ buildId, taskId? }`，`fetchBuild` 驱动。

- **摘要头部**：family / row grain / Schema badges、有效行数（`build_result.valid_row_count`，
  兜底 `manifest.row_count`）、来源成功/被拒数、Validation status（passed/failed +
  checked/failed 计数）、置信度（`confidence_summary.detected_anomaly_count`）、
  溯源覆盖率（`provenance_summary.coverage.coverage_ratio` → 百分比）。
- **状态横幅**（`data-status` 属性 + 无红样式）：
  - `no_data` → 信息蓝（sky，同 legacy NO_DATA banner 风格），显示 `user_summary` +
    `recommended_next_action` + `reason_codes` badges —— 绝不渲染成红色内部错误；
  - `partial_success` / `spec_rejected` → 琥珀色 + 原因；
  - `succeeded` → 无横幅。
- **四个 Tabs**（shadcn Tabs）：
  - 主数据：`primary_dataset` artifact 的 CSV 预览（复用 `CsvPreview`）+ 下载；
  - 来源：溯源覆盖详情（traced/untraced/ratio/source_count/mapping/dedup/conflict）+
    `provenance.json` / `schema.json` 产物卡；
  - 处理：校验摘要（profile_ref/status/计数）+ 置信度（异常数、报告文件）+
    所有 `audit_report` 产物 CSV 预览/下载；
  - 警告：文件名匹配 `/warning/i`（如 `warnings.csv`）的产物预览；无则平静空态「无警告」。
- 加载中 / 错误（含重试按钮）；`key={buildId}` 重挂载，避免跨 build 残留 stale detail。

## 3. build_id 推导与挂载接线

前端 run summary 只有 `build_result`，没有 `build_id`（T1 后端以目录关联）。新增
`src/hooks/useTaskBuild.ts`：`useTaskBuildId(taskId)` —— 任务的 latest run
`build_result != null` 时才请求 `GET /builds?limit=50` 并按 `task_id` 匹配，返回
newest build id；无信号/无 build 的任务零网络请求。结果按 `(taskId, hasBuildResult)`
键控、状态派生，effect 内无同步 setState（lint 规则合规）。

- `ResultsViewer`：新增可选 `buildId` prop。给定 `buildId` → 直接渲染
  `BuildResultsViewer`；未给定且无 artifact/activity override（完整任务视图）→
  `useTaskBuildId` 推导 → 命中则渲染 manifest 视图，否则 legacy 路径逐字节不变。
- `ArtifactFab`：新增 `buildId` prop + 内部推导；`artifacts.length > 0 || buildId != null`
  时显示（无 artifacts 时按钮文案「结果」/ aria-label「查看构建结果」），并把 buildId
  传给 Sheet —— V2 build 产物不在 legacy artifact store（T1 设计），此前 FAB 永不出现。
- `ArtifactSheet`：新增 `buildId` prop；非空时整个 Sheet 渲染 `BuildResultsViewer`
  （V2 数据构建结果），legacy 文件列表/预览/「保存全部」仅在 buildId 为空时保留。

## 4. 测试（TDD red → green，+11）

`src/test/build-results-viewer.test.tsx`（新，10 个）：

1. 渲染 manifest 摘要字段（family/grain/schema/42 行/来源覆盖/Validation/置信度/95.24%）；
2. NO_DATA 横幅显示原因且**非红色**（`data-status="no_data"` 无 destructive/red class）；
3. 四 Tab 切换（主数据 CSV → 来源溯源详情 → 处理 quality_report → 警告无警告）；
4. warnings.csv 产物渲染警告 Tab 内容（per-artifact CSV stub 消除跨 Tab 文本歧义）；
5. partial_success 横幅显示原因；6. 404 错误态 + 重试入口；
7. ResultsViewer 给定 buildId 渲染 manifest 视图；8. 从 latest run 经 builds API 推导；
9. legacy（无 build）仍渲染旧 artifact 视图 + CSV 预览；10. 无 build_result 任务保持旧空态。

`src/test/api.test.ts`（+1）：`fetchBuilds` / `fetchBuild` / `getBuildArtifactUrl`
URL 与解析正确性。

其余改动为 mock API client 补齐新方法（`runtime-controller` / `hil-data-correction-e2e` /
`background-task-notifications`），保证 `tsc -b`（含测试）编译通过。

## 5. 验证结果（worktree `frontend/`）

| Gate | Result |
| --- | --- |
| `pnpm lint` | 0 errors, 0 warnings |
| `pnpm tsc` | clean |
| `pnpm build` | OK（chunk-size 警告为既有） |
| `pnpm test` | **698 passed / 43 files**（基线 687 / 42 → +11） |

## 6. 边界与注意事项（Concerns）

- **build_id 无全局索引**：前端按 `task_id` 在 builds 列表中匹配 newest build；同 task
  多 build 时取列表第一项（T1 文档化的 newest-first 语义）。列表 limit=50，极端多 build
  场景可能漏匹配（可后续用 cursor 翻页）。
- **ArtifactSheet 预览语义**：buildId 非空时 Sheet 整体切换为 manifest 视图，legacy
  单文件预览 Tab 不出现（V2 build 本来就没有 legacy artifacts，无行为回退）。
- **派生请求**：`useTaskBuildId` 对「有 completed run 且 build_result 非空」的任务
  每次挂载发一次 `GET /builds`（legacy 任务返回空 → 走旧路径），成本可控。
- **警告 Tab 匹配规则**：文件名 `/warning/i`（覆盖 `warnings.csv`）；V2 当前无固定
  warnings 产物，未来若有其他命名（如 confidence_report.csv 携带警告）可扩展匹配。
- **未实现**（T5/T6 范围，刻意排除）：operation-events 渲染、toolLabels/search-box。
- **未动 backend**；`docs/TODO.md` 未勾选（沿用 T1/T3 惯例：阶段条目由维护者在整组
  前后端完成后统一标记；且本会话未连接 Commonly，board 同步留待主会话）。
