# REVIEW — Phase 4b 空表语义（NO_DATA + supporting）

日期：2026-08-07
分支：`feat/phase4b-empty-table`
结论：**TODO Phase 4 的 P0-1（删除 metadata-only 主表占位路径）全部落地并有测试**。
T1–T6 实现完毕，T6 全量验证通过（后端 2267 passed、前端 645 passed、冒烟 ok、
ruff 全量门零告警）。

## 1. 交付内容

对应 `docs/TODO.md` Phase 4 P0-1 与 Design §16 Phase 4 验收
（设计文档：`docs/archive/superpowers/specs/2026-08-07-phase4b-empty-table-semantics-design.md`；
权威设计：`docs/BioMed-QAgent_Architecture_Decisions_and_Lessons.md` §13 ADR-011）：

| spec 目标 | 交付 | 对应任务 |
| --- | --- | --- |
| 删除 metadata-only 主表占位路径（GEO 无表达矩阵不再生成占位表达行） | `_build_minimal_parsed_dataset` 删除；无表达 → `parsed_datasets=[]` + `no_primary_reason`，samples 保留供辅助表 | T1 |
| 无主数据 → NO_DATA（空表不能以 SUCCEEDED 发布） | `_compute_build_result` NO_DATA + `valid_row_count=0`；`BuildResult.validate_state` 下 NO_DATA 不携带 publication_id | T4 |
| 样本元数据留在辅助表（`sample_metadata.csv` 独立发布） | NO_DATA 包：supporting/audit 产物（sample_metadata.csv、source 系列、field 系列、cleaning_report、processing_log、warnings、download_log、literature），不写 `main_data.csv` | T2 |
| Validation 不再豁免（显式 NO_DATA 验证路径，非"验证通过"伪装） | `check_no_primary_data` 决策 check + 授权绑定（`ArtifactBuildOutput.no_primary_reason`）；不一致形态拒绝；普通模式 check_id 序列字节级不变 | T3 |
| BuildResult 注入 valid_row_count（4a deviation #4） | `_compute_build_result(primary_row_count=...)` 从 processing 输出注入；SUCCEEDED > 0、NO_DATA = 0 | T4 |
| 保留 no_expression_data warning（明确原因与下一步） | `warn_no_expression_data` 新文案（含 reason）；NO_DATA 专用 warning（正常包不触发） | T2 |
| 前端 NO_DATA 展示（无 primary artifact 列表/预览空安全） | ResultsViewer NO_DATA banner + 预览消息属权门控；supporting/audit 正常列出预览 | T5 |
| 回归 + 文档（D5 去豁免、无表达 E2E、REVIEW、TODO 同步） | lineage/main_data 占位豁免删除；fixture 级无表达 E2E；EOFError 截断 gzip 修复；本文档 | T6 |

测试：后端覆盖于 `tests/pipeline/`（processing、artifact_build、validation、runner）、
`tests/runtime/test_fixture_executor.py`（manager → FixtureRunExecutor 全链）、
`tests/agent_loop/test_execution.py`（publication_id 语义）；前端 `tests/` 覆盖
NO_DATA 渲染与 SUCCEEDED 回归。全量门见 §4。

## 2. 实现事实

### 2.1 T1 processing 无主数据输出（commit 6d33d94 → a500220 → 38ab802 → 5c5d7ce）

- `app/pipeline/stages/processing.py`：删除 `_build_minimal_parsed_dataset`；
  `_try_series_matrix_expression_or_minimal` 返回 `(parsed | None, reason)`，原因串诚实区分
  块空/无 supplementary/有 supplementary 但空/解析失败/样本不可用/tximport 失败；
  `run_processing` 无主分支 → `parsed_datasets=[]` + `no_primary_reason` + samples 保留 +
  `_no_primary_digest`（reason + 规范化样本记录 sha256，确定性）。
- `app/pipeline/stages/base.py`：`ProcessingOutput.no_primary_reason: str | None = None`（向后兼容）。
- `app/pipeline/processing/geo_tximport.py`：series_matrix/supplementary 解析 0 行时清理
  schema-only 文件；tximport 中途失败清理部分文件（`<dataset>_tximport_long.csv` 永不残留）。
- 真实拓扑修复：live tximport 失败从 family SOFT 恢复 samples + `skip_series_matrix=True`
  （counts 文件绝不按 series-matrix 解析）。

### 2.2 T2 artifact build NO_DATA 分支（commit 35fea1f → 9cc49fd）

- `app/pipeline/stages/artifact_build/builder.py`：删除 `_is_metadata_only`；签名 `*` 后
  keyword-only（调用方本就全用关键字）；`parsed_dataset: ParsedDataset | None = None` +
  `no_primary_reason`；NO_DATA 分支不写 `main_data.csv`，staging supporting/audit 包；
  `warn_no_expression_data` 新文案（`未找到可发布的表达数据（原因: <reason>）；产物仅含
  样本元数据与审计报告；如需表达数据请更换数据集或检查数据集相关性`）；processing_log 合成
  `no_primary` step row（warnings 折叠，保持 `warnings_metrics_consistency`）。
- `app/pipeline/stages/base.py`：`ArtifactBuildOutput.no_primary_reason`（non-None iff NO_DATA，
  缺省归一化为 `"no_expression_data"`）。
- `samples.py` / `catalog.py` / `field_mapping.py`：parsed 缺失安全（sample_metadata 仅来自
  recovered samples；field 表 header-only；catalog sample_count 回退 geo.sample_count）。

### 2.3 T3 验证门 NO_DATA 模式（commit ffe18ce → 3ca797e → 293ff82）

- `checks_common.py`：`ValidationContext.no_primary`；main/pathway 双缺 → `main_rows=[]` 不崩溃。
- `package.py`：`validate_package` NO_DATA 分支——跳过主表系 checks，新增 `check_no_primary_data`
  决策 check；**授权绑定**：仅当 `no_primary_reason`（可信上游信号，来自
  `ArtifactBuildOutput`）非空且 staging 确无主文件时进入 NO_DATA 分支；不一致形态
  （reason+primary 存在 / 无 reason+primary 缺失）拒绝；无授权时走普通分支（主表系 checks 照跑）。
- `validation/runner.py`：`run_validation` 透传 `no_primary_reason` 到 `validate_package`。
- 普通模式 check_id 序列字节级不变（`test_validation_split.py` golden 列表未动）。

### 2.4 T4 runner 接线 + valid_row_count（commit 5538e09）

- `app/pipeline/runner.py`：ARTIFACT_BUILD 接线 `parsed_datasets[0] if parsed_datasets else None`
  （消除 IndexError）+ `no_primary_reason` 透传；`_compute_build_result(primary_row_count=...)`
  由 `_finalize_completed` 从 PROCESSING 输出注入（`merged_dataset.row_count` 优先，否则
  `parsed_datasets[0].row_count` = processing_log 的 rows_after）。
- **latent 4a bug 修复**：`commit_agent_artifacts` / `commit_fixture_completion` 对 NO_DATA
  BuildResult 不再 stamp `publication_id`（`BuildResult.validate_state` 禁止）；
  NO_DATA 审计 Publication 照常发布（`PublicationCreatedPayload` 自带 publication_id）。

### 2.5 T5 前端（commit d055573 → … → 150398b）

- `frontend/src/components/ResultsViewer.tsx`：NO_DATA banner（`user_summary` +
  `recommended_next_action`，sky 色）仅在最新 run 自有产物存在时渲染（属权门控：
  `available_artifact_roles.length > 0 && artifacts.length > 0`）；预览空态消息同属权门控；
  零产物空态保持原 `user_message` 标题。SUCCEEDED 路径字节级不变。

### 2.6 T6 回归（本次 commit）

- **lineage 去豁免（D5）**：`checks/lineage.py` 删除 `measurement_type == "sample_metadata"`
  skip + `sampled_skipped` 计数器 + `high_skip_ratio` 标志；details 字段收敛为
  `{total_rows, sampled}`；`checked_count = total_sampled`。**细化**：删除后发现 GDC
  clinical 行（`processing/gdc.py:315` 仍产出 `measurement_type="sample_metadata"` 真实行）
  依赖该 skip 免于 `float()` 崩溃——改为行内容守卫：无 `expression_value` 的行（GDC clinical）
  做 locator-only 验证（`source_raw_value` 复现），有表达值的行全量验证；占位形状行
  在索引前被 locator 守卫拒绝（`line_number <= 0` 或 `column_index < 0` 直接判失败，
  列 0 合法——GDC clinical 的 sample_id 位于列 0），杜绝行 0 减 1 负索引包装到末行时
  `source_raw_value` 恰好等于包裹单元格而误通过（T6 review 修复，回归测试 pin）。
- **core_data_existence 去豁免（D5）**：`checks/main_data.py` 删除 `is_metadata_only` 分支
  （`value_semantics == "metadata_only"` 全行豁免）+ 陈旧 docstring 注释（"download failure
  masked by geo_minimal_placeholder"）；check 现统一应用于所有 main_data。
- **EOFError/截断 gzip（T1 caveat 关闭；final review FIX 1 补齐最后一处）**：
  `processing.py` 共 6 处截断 gzip 边界捕获 `EOFError`——T6 加入的 5 处表达恢复元组
  （series-matrix 块解析、supplementary 解析、fixture tximport、live tximport、live SOFT
  恢复）加上样本恢复 helper `_recover_samples_from_series_matrix`（原仅捕获
  `(ValueError, OSError)`，截断 series_matrix gzip 的 `EOFError` 会逃逸并中断管线，
  final review FIX 1 补入）。已核实 app/ 内无其他路径依赖 EOFError 传播
  （`geo_annotation.parse_platform_annotation` 的元组仍无 EOFError，但其调用链
  `_load_geo_gene_map` 以 `except Exception` 兜底为 `annotation_unavailable`，不构成逃逸）。
  回归测试：`test_recover_samples_truncated_series_matrix_gzip_returns_empty`（直接 helper）+
  `test_run_processing_truncated_series_matrix_gzip_lands_no_primary`（no-primary 路径）。
- **无表达 E2E**：`tests/runtime/test_fixture_executor.py` 新增 fixture 级无表达全链测试
  （真实 acquisition → run_processing，无 monkeypatch）：复制 fixture 目录并损坏
  `tximport_counts_slice.tsv`（无 12 个 counts 列）→ processing no-primary → builder NO_DATA 包
  → validation 授权 valid → manifest 无 PRIMARY_DATASET → BuildResult NO_DATA →
  `RunCompletedPayload` NO_DATA（publication_id None）+ `PublicationCreatedPayload`，无 FAILED。
- **EOFError red test**：`test_run_processing_live_tximport_truncated_gzip_lands_no_primary`
  （截断 gzip 的 counts 文件，修复前 EOFError 逃逸崩溃，修复后诚实 no-primary）。

## 3. 与规格的偏差

1. **schema.json legacy-pipeline deviation（T2 review MUST-FIX 2）**：旧管线（legacy）的
   NO_DATA 与正常表达 Publication 均**不产 schema.json**（schema.json 是 V2-chain 产物，
   Phase 5/7 范围）；spec §2 的 "schema.json（如适用）" 不适用，未新增 writer。
2. **valid_row_count 数据来源（T4 决策 option b）**：从 PROCESSING 输出的
   `ParsedDataset.row_count`（rows_after）注入，而非 finalize 时重读 staged `main_data.csv`；
   `RunManifest`/`ArtifactManifestEntry` 未加行数字段（避免前端 parser 契约涟漪）。
3. **(b) ResultsViewer override 契约风险（T5 复评，final review FIX 3 修复）**：
   `ResultsViewer` 的 `latestRun`/`buildResult` 曾始终从 active store task
   （`selectActiveTask`）推导，即使 `taskId`/`artifacts` props 被调用方覆盖
   （如 ArtifactSheet 单产物覆盖）——NO_DATA banner/预览消息会描述 active task 的最新 run
   而非覆盖目标 task。修复：store 按 task_id 保存所有已加载任务，覆盖存在时 run 摘要从
   `tasksById[taskId]` 解析（同覆盖目标 task）；覆盖目标不在 store 时完全抑制
   NO_DATA banner/预览消息而非错误归属。无覆盖路径字节级不变。
   回归测试：`scopes the NO_DATA summary to the overridden task, not the active task` +
   `suppresses the NO_DATA summary when the override target task is not in the store`。
4. **(c) task-wide artifact list（T5 三轮注记，文档化）**：store 的 artifact 列表是任务级
   聚合，合法 NO_DATA publication 的 banner/消息在列表同时含早期 run 产物时可能渲染其上。
   现有属权门控（最新 run 的 `available_artifact_roles` 非空 + 列表非空）已降低误渲染面，
   但**无法**按 artifact 归属精确过滤——已知 UI 局限，接受（产物归属元数据尚未进前端 store）。
5. **T4 latent-4a-bug fix**：NO_DATA BuildResult 不再 stamp `publication_id`
   （`BuildResult.validate_state` 禁止；4a 无条件 stamp 的潜在缺陷在 4b 暴露并修复，
   两处 `commit_*` 站点仅 SUCCEEDED/PARTIAL_SUCCESS 保留 stamping）。
6. **D5 细化（T6）**：`measurement_type == "sample_metadata"` skip 的删除需按行内容守卫
   收敛——GDC clinical 行（`gdc.py:315`）仍真实产出该 measurement_type；占位专用 skip
   删除后这些行做 locator-only 验证（非跳过、非计数 flag）。占位形状行被 locator 守卫
   拒绝：`line_number <= 0` / `column_index < 0` 在索引前即判失败——行 0 减 1 的负索引
   会包装到源表末行，`source_raw_value` 恰好等于该包裹单元格时原实现会误通过（T6 review
   修复）；列 0 不拒绝（GDC clinical sample_id 零基位于列 0）。
7. **EOFError caveat 关闭方式**：加入 6 处 except 元组（含 fixture 路径、helper 内部与
   样本恢复 helper，final review FIX 1 补齐）——而非仅 live 路径——同类截断 gzip 崩溃在
   fallback 链任何节点都不应存活。
8. **fixture 级无表达 E2E 的可执行性**：fixture 模式 acquisition 硬编码 pin 唯一数据集
   （`_run_acquisition_fixture` 对非 GSE178352 raise），无法新增独立"无表达"fixture 数据集；
   采用**复制 fixture 目录 + 损坏 counts 资产**建模（轻量、不触碰共享 fixture 资产，
   真实 processing 路径全链覆盖）。共享 fixture（GSE178352 有表达）行为不变。

## 4. 验证结果（T6）

| 门 | 结果 |
| --- | --- |
| 后端 pytest（全量） | `2267 passed, 2 skipped, 28 deselected`（T3 基线 2258 + T4 +7 + T6 +2） |
| 后端 ruff（全量 `app/ tests/ launcher.py`） | `All checks passed!`（零告警） |
| `python -c "import app.main"` | OK |
| uvicorn 冒烟（port 8129，timeout 起停） | `GET /api/v1/health` → `{"status":"ok","version":"1.0.0","arch":"agent_loop"}` |
| 前端 test | `645 passed`（T5 终态 645，T6 无新增） |
| 前端 lint | 0 errors（`eslint . --max-warnings 0`） |
| 前端 build | `pnpm build`（tsc -b + vite）成功 |

后端新增测试明细（T6）：`test_run_processing_live_tximport_truncated_gzip_lands_no_primary`、
`test_fixture_no_expression_assets_emit_completed_no_data`；改写：
`test_validation_no_longer_skips_lineage_for_sample_metadata_rows`（原
`test_validation_skips_lineage_for_sample_metadata_rows`，断言 skip 不存在、占位形状行失败）、
`test_core_data_existence_rejects_blank_expression_rows_uniformly`（原
`test_core_data_existence_accepts_metadata_only_rows`，断言豁免删除后 metadata_only 声明行失败）。

## 5. 遗留

- **Phase 5**：GEO provider/adapter 拆分（spec 不在 4b 范围）。
- **4c（Phase 4 P2）**：`request_human_correction` function_tool + UserInputDialog
  `data_correction` 分支 + 超时退化 `corrections_todo.csv`（HIL）。
- **Phase 8 清理**：`run_research_pipeline` 旧参数面、固定 `_STAGES`/`StageName` 业务依赖、
  22 列缓存硬编码接口、遗留死代码（`tools/parse_pdb.py` 等）。
- 前端 artifact 归属元数据进 store（§3-4 的精确过滤依赖）；`list_artifacts` API 暴露 role
  并迁移消费方（4a 遗留）。
