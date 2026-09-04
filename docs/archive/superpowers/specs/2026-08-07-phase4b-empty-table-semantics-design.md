# Phase 4b 设计：空表语义（删除 metadata-only 占位 → NO_DATA + supporting）

> 日期：2026-08-07 ｜ 状态：已批准，待实施 ｜ 对应 `docs/TODO.md` Phase 4 P0-1 + 4a 遗留 deviation #4
> 推进顺序：4a（已完成，已合并）→ **4b（本文档）** → 4c（HIL，P2，独立）
> 权威设计：`docs/BioMed-QAgent_Architecture_Decisions_and_Lessons.md` §13 ADR-011、
> `docs/BioMed-QAgent_Pipeline_Refactor_Design.md` §16 Phase 4 验收、§10.1、§4.9

## 1. 背景与目标

4a 交付了 `BuildResult` / Publication 版本链 / 服务端 `RunSummary` / 前端四态，
但**空表语义**仍是 4a 之前的状态：GEO 无表达矩阵时，processing 阶段
（`backend/app/pipeline/stages/processing.py:_build_minimal_parsed_dataset`）把
样本元数据写成 `measurement_type="sample_metadata"` 的表达 Schema 占位行
（`parser_name="geo_minimal_placeholder"`），Validation 为这些行跳过表达值与
lineage 检查（`checks/lineage.py:72-74` + `checks/main_data.py` 的 core-data 注释）。
结果：**"结构成功、科研内容为空"**——`main_data.csv` 存在且非空 → 验证门通过 →
以 SUCCEEDED 发布假主表。这正是 ADR-011 禁止的反模式。

**4b 目标**（TODO Phase 4 P0-1 + 4a REVIEW deviation #4 valid_row_count 注入）：

1. **删除 metadata-only 主表占位路径**：GEO 无表达矩阵时不再生成占位表达行；
2. **无主数据 → NO_DATA**：空表不能以 SUCCEEDED 发布；
3. **样本元数据留在辅助表**：`sample_metadata.csv` 作为 `supporting_dataset` 独立发布；
4. **Validation 不再豁免**：删除 sample_metadata 行的跳过逻辑；无主数据走显式
   NO_DATA 验证路径（审计型发布），不是"验证通过"伪装；
5. **BuildResult 注入 valid_row_count**（4a deviation #4："暂 0，4b 注入"）；
6. 保留 no_expression_data warning，让 Agent 看到 NO_DATA 的明确原因与下一步。

**验收**（Design §16 Phase 4）：

- 没有表达数据时无假主表（staging 中无 `main_data.csv`，manifest 无
  `PRIMARY_DATASET` artifact）；
- 会话仍给出明确原因和下一步（BuildResult NO_DATA + user_summary +
  recommended_next_action + warning）；
- 空表不能以 SUCCEEDED 发布（BuildResult.status == NO_DATA）；
- 无主数据时可交付审计型 Publication（schema/provenance/audit_report +
  supporting sample_metadata），Publication 事件链完整（4a 已具备）；
- 有真实主数据时行为不变（SUCCEEDED + valid_row_count > 0）。

**不在 4b 范围**：

- 4c HIL `request_human_correction`（TODO Phase 4 P2）；
- Phase 5 GEO provider/adapter 拆分；Phase 8 清理（`run_research_pipeline`
  旧参数面等）；
- PARTIAL_SUCCESS 的产生点（4a 保守两分支，V2 chain 统计接入后出现）；
- `merge_parsed_datasets` 迁移（Phase 2 P2）。

## 2. 现状代码足迹（4b 改造点）

| 位置 | 现状 | 4b 动作 |
| --- | --- | --- |
| `stages/processing.py` `_build_minimal_parsed_dataset` | 写 sample_metadata 占位行（每样本一行，表达字段留空） | **删除占位行生成**；无表达 → 不产出 parsed primary，恢复的 samples 保留 |
| `stages/processing.py` `_try_series_matrix_expression_or_minimal` | 表达块空 + 无 supplementary → fallback 占位 | fallback 改为"无主数据"输出 + 原因记录 |
| `stages/processing.py` `run_processing` | `parsed_datasets=[parsed]`（占位也算 parsed） | 无主数据 → `parsed_datasets=[]` + `no_primary_reason`；digest 计算空安全 |
| `stages/base.py` `ProcessingOutput` | `parsed_datasets` 非空 | 增加 `no_primary_reason: str | None = None`（可选，向后兼容） |
| `stages/artifact_build/builder.py` `_is_metadata_only` + `warn_no_expression_data` | 按 `parser_name == "geo_minimal_placeholder"` 判断 | 按 `no_primary_reason`/空 parsed 判断；warning 文案更新为 NO_DATA 语义 |
| `stages/artifact_build/builder.py` 主流程 | `primary = parsed_dataset`；`parsed_path` 缺失即 raise；`shutil.copy2 → main_data.csv` | primary=None 分支：**不写 main_data.csv**；构建 supporting/audit 产物（sample_metadata.csv 等） |
| `stages/validation/runner.py` `run_validation` | 从 staging 全部文件构建 manifest entries（`role_for_filename`） | 无 primary 时仍构建 manifest（无 PRIMARY_DATASET entry）；验证门按 NO_DATA 模式 |
| `stages/validation/checks_common.py` `load_validation_context` | `main_path` 缺两个候选即 `read_csv` 抛 FileNotFoundError | no_primary 标志：main 缺失 → `main_rows=[]`（不崩溃）；NO_DATA 包可加载上下文 |
| `stages/validation/package.py` | 11 项 checks 固定序列（`test_validation_split.py` pin） | no_primary 模式：跳过主表依赖 checks，新增 `no_primary_data` 决策 check；**普通模式序列不变** |
| `stages/validation/checks/main_data.py` `check_main_data_nonempty` / `check_core_data_existence` / `check_foreign_keys` | 空 main 即 fail | no_primary 时跳过（主表不存在不是失败，是 NO_DATA 决策） |
| `stages/validation/checks/lineage.py:72-74` | `measurement_type == "sample_metadata"` skip + `high_skip_ratio` flag | **删除**（占位行不再存在；无 main 时空采样自然 pass） |
| `pipeline/runner.py` 阶段编排（~979 `run_artifact_build(parsed_dataset=processing.parsed_datasets[0])`） | `parsed_datasets[0]` 假设非空 | primary=None 安全接线 + `no_primary_reason` 透传 |
| `pipeline/runner.py` `_compute_build_result`（~1664） | SUCCEEDED 时 `valid_row_count=0`（4a 占位）；NO_DATA `no_primary_data` | **valid_row_count 注入**：SUCCEEDED 从 primary 实际行数（processing 参数 `rows_after` 或 builder 统计）；NO_DATA 保持 0 |

## 3. 设计决策

### D1. 无主数据时 processing 的输出形状

无表达矩阵时（表达块空 + 无 supplementary 表达文件）：
- **不产出 parsed primary 文件**（ADR-011：无假主表；空表不发布）；
- samples（若有，从 series_matrix/soft 恢复）保留在 `ProcessingOutput.samples`，
  供 `sample_metadata.csv` supporting 表使用；
- `parsed_datasets=[]`，`no_primary_reason` 记录原因
  （e.g. `"series_matrix_expression_empty_and_no_supplementary"` /
  `"expression_parse_failed"`）；
- 确定性 digest：无 parsed 时用 samples 摘要（`sha256(json(samples))`）或固定
  占位 + 原因串，保证 `output_digest` 稳定且随 samples 变化（实施者选稳定方案）。

### D2. artifact build 的 NO_DATA 分支

`run_artifact_build` 增加 `no_primary_reason: str | None = None` 参数（或从
空 parsed + ctx 推导——以不破坏现有调用面为原则，实施者按最小改法选）。当无主
数据：
- **不写 `main_data.csv`**（Design §10.1："NO_DATA 不发布空主数据集"）；
- 构建 supporting/audit 产物：`sample_metadata.csv`（若有 samples）、
  `cleaning_report.csv`（若有）、`source_list.csv`、`source_assets.csv`、
  `source_relations.csv`、`warnings.csv`（含 `warn_no_expression_data`）、
  `field_descriptions.csv`、`field_mapping.csv`、`schema.json`（如适用）；
- `quality_report.csv` 仍由 validation 阶段写；
- `warn_no_expression_data` 保留并更新文案：
  "未找到可发布的表达数据（原因），产物仅含样本元数据与审计报告；如需表达数据请
  更换数据集或检查相关性"——Agent 据此切换数据集而非重试同一下载。

### D3. 验证门 NO_DATA 模式

`load_validation_context` 增加 `no_primary: bool`（staging 无 `main_data.csv`
且无 `pathway_members.csv` → `main_rows=[]`，不抛异常）。`validate_package` 在
no_primary 时：
- **跳过**（不执行、不进 failed 计数）：`check_main_data_nonempty`、
  `check_core_data_existence`、`check_foreign_keys`（主表侧）、
  `check_source_value_lineage`（无行可验）、`check_reactome`（n/a）；
- **新增** `check_no_primary_data`（`check_id="no_primary_data"`）：断言 staging
  确无主表 + 记录原因（从 warnings.csv 的 `no_expression_data` 或 ctx 读取）→
  状态 passed（这是"已验证为 NO_DATA"的决策记录，不是豁免）；
- 其余 checks 照跑：`check_source_relation_evidence`、`check_sample_foreign_keys`
  （sample→source_list/dataset_catalog 侧）、`check_source_asset_integrity`、
  `check_field_descriptions`、`check_warnings_metrics_consistency`、
  `check_cleaning_report_consistency`（需核实空 main 下这些 check 的空安全性，
  逐一定位并修复任何对 `main_rows[0]` 的裸访问）；
- `test_validation_split.py` pin 的 check_id 序列：**普通模式序列不变**；
  no_primary 模式新增独立序列测试。

### D4. `_compute_build_result` valid_row_count 注入

SUCCEEDED 时 `valid_row_count` 取 primary 的实际合法行数。数据来源：processing
参数 `rows_after`（`_clean_parsed_dataset` 后行数，已有字段）经 builder 写入
manifest 或由 runner 从 processing 输出读取。NO_DATA 保持 0。`user_summary` /
`recommended_next_action` 随 NO_DATA 语义微调（"未找到可发布的表达数据"）。

### D5. lineage/main_data 校验去豁免

- `lineage.py:72-74` 的 `sample_metadata` skip 与 `high_skip_ratio` 标志删除；
- `main_data.py` core-data check 注释更新（占位行不再存在）；
- 无 main 时 `check_main_data_nonempty` 不再出现（D3 跳过）——空表绝不进普通验证。

### D6. 发布链与前端

- NO_DATA Publication 走 4a 既有 `PublicationCreatedPayload` 链（manifest 无
  primary → BuildResult NO_DATA → 发布照常）；`PublicationCreatedPayload` 的
  `manifest_sha256` 用 staged 字节 digest（4a F1 已修，回归确认）；
- 前端：NO_DATA publication 的 artifact 列表（supporting/audit，无 primary）
  在 ResultsViewer/artifact 列表空安全（4a role 分类已支持；补无 primary 场景
  测试，必要时小改预览回退逻辑）；
- `list_artifacts` 已按 role 返回（4a B4）；NO_DATA 包正常返回。

## 4. 任务划分（TDD，每任务先写 repro 测试）

| # | 任务 | 关键改动 | 测试 |
| --- | --- | --- | --- |
| T1 | processing 无主数据输出 | 删除占位行生成；`no_primary_reason`；空 parsed 安全 digest | 占位删除回归；无表达 → `parsed_datasets=[]` + reason + samples 保留 |
| T2 | artifact build NO_DATA 分支 | primary=None 不写 main_data.csv；supporting/audit 构建；warning 重构 | 无主包无 main_data.csv；sample_metadata.csv supporting；warning 文案 |
| T3 | 验证门 NO_DATA 模式 | `no_primary` 上下文；`check_no_primary_data`；check_id 序列 | 普通序列不变；NO_DATA 包验证通过；缺 main 不崩溃 |
| T4 | runner 接线 + valid_row_count | primary=None 安全；`_compute_build_result` 注入行数 | SUCCEEDED 行数 > 0；NO_DATA 0；端到端无主 → NO_DATA publication |
| T5 | 前端 NO_DATA 展示 | 无 primary artifact 列表/预览空安全 | ResultsViewer 无 primary 场景；artifact 列表 supporting/audit |
| T6 | 回归 + 文档 | lineage skip 删除确认；全量门；REVIEW 文档 | 全量 pytest + 前端 + ruff + uvicorn；REVIEW_2026-08-07-phase4b |

**实施顺序**：T1→T2→T3→T4→T5→T6（严格依赖序）。每任务独立子代理，
spec 评审（对照本文档）+ quality 评审（对照任务描述）。

## 5. 风险与注意

- `check_foreign_keys` / `check_sample_foreign_keys` 对空 main 的行为需在 T3
  核实（可能还有 `main_rows[0]` 裸访问点，一并修复）；
- `test_validation_split.py` 是 check_id 序列 pin，T3 必须保持普通模式字节级稳定；
- fixture 模式（GSE178352）有真实表达，不走 NO_DATA 路径——需要新增/改造一个
  "无表达" fixture（如 GSE339404 场景）覆盖 NO_DATA 全链路；
- `run_processing` 无 parsed 时 `_build_field_alignment` / `_clean_parsed_dataset`
  空安全；
- 4a 的 `_compute_build_result` 调用方（agent_loop）不变；`BuildResult.validate_state`
  对 NO_DATA 允许无 publication_id 的约束保持。
