# BioMed-QAgent 开发 TODO

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）。
> 目标：完成本 TODO 后可作为初步赛题成果提交。
> 上一版本归档于 git history（2026-07-23 之前）。
> 状态核对：2026-07-31 并行审计全部条目（对照 main 分支代码），已按审计结果更新勾选状态。

---

## 1. 管道核心能力（P0）

> 确定性 Pipeline 清洗、对齐、验证能力的完整性。

### 1.1 清洗能力接入 Pipeline

- [x] **P0** `pipeline/stages/processing.py` 按当前文件型 `ParsedDataset` 契约执行清洗并产出 `CleaningReportModel`
- [x] **P0** 生成 `cleaning_report.csv` artifact
- [x] **P0** 将 `CleaningReportModel.anomaly_flags` 写入 `warnings.csv`
- [x] **P0** `validation.py` 增加 cleaning_report 存在性与异常计数一致性校验

### 1.2 字段对齐能力接入

> 当前 Processing 对单数据集只生成字段规范化映射；多数据集分支虽然调用
> `alignment.align_fields`，但 Runner 尚未传入多个 ParsedDataset，且未调用
> `alignment.merge_datasets`，所以尚未形成真实多源合并。

- [x] **P0** Pipeline 在多源数据路径中调用 `alignment.align_fields`——2026-07-31 执行：`run_processing` 新增多数据集分支（`_run_multi_dataset_processing`），当 spec 选择 ≥2 个数据型数据集（GDC/Xena）时逐个解析，`_build_field_alignment` 多数据集分支真实调用 `align_fields`；`merge_parsed_datasets` 公开函数直接调用 `align_fields` 构建映射
- [x] **P0** Pipeline 中调用 `alignment.merge_datasets`（多源数据合并）——2026-07-31 执行：`merge_parsed_datasets` 通过旧模型适配器（`_to_legacy_parsed_datasets`）调用 `merge_datasets` 垂向合并，写入 `parsed/{id}_merged.csv` 并返回 `ParsedDataset`；`ProcessingOutput` 新增 `merged_dataset` 字段，Runner 将全部 `parsed_datasets` + `merged_dataset` 传入 artifact_build
- [x] **P0** 生成 `field_mapping.csv` 的真实映射关系（当前部分硬编码）——2026-07-31 执行：`_build_field_mapping_rows` 对多数据集输出每个 dataset 一组真实映射（每 slot 对应一个 ParsedDataset 的 source_id/dataset_id），notes 标记 `alignment:align_fields`；`test_multisource_merge.py` 锁定 2 源合并发布（main_data.csv 行数、_source 列、双 source field_mapping、merge 步骤进入 processing_log）

### 1.3 清洗测试

- [x] **P0** 新增 `tests/pipeline/test_processing_cleaning.py`，验证缺失/重复/类型异常被正确标记到 warnings.csv

### 1.4 数据源能力边界

> Agent 可使用的数据库不等于 Pipeline 已验收支持的数据源。必须显式区分
> `pipeline_supported` 与 Agent-only 能力，不能通过解除硬门控把未完成的来源伪装成
> Pipeline 支持。

- [x] **P0** `/databases` 已返回 `pipeline_supported`
- [x] **P0** 补齐 `TaskSpecification` / Pipeline 输入级别的能力声明，Agent-only 来源标记为 research-only/pending，只能作为调研或待接入来源——2026-07-31 执行：新增 `SourceCapability` 枚举与 `SOURCE_CAPABILITIES` 单一事实表（pubmed/geo/gdc/ucsc_xena/reactome = pipeline_supported；pdb/pubchem/browser = research_only），`TaskSpecification.declare_sources` 为每个选中来源生成 `SourceCapabilityDeclaration`（含 identifier/capability/note），未知来源标记 pending；`run_research_pipeline` 按能力表拒绝非 pipeline-supported 来源并返回 `capabilities` 明细；skill catalog 的 `pipeline_supported` 从能力表派生，`/databases` 响应新增 `capability` 字段；新增 `tests/pipeline/test_source_capabilities.py` 契约测试锁定能力边界
- [x] **P0** Pipeline 当前不会按 `databases` 路由，仍固定执行 PubMed/GEO；`run_research_pipeline` 现在对未支持来源返回 `status=unsupported_databases`、`retryable=false`，不产生伪成功 Artifact
- [ ] **P1** `pipeline/stages/acquisition.py` 为 PubMed 补充材料等正式来源产出合规 `SourceAsset`
- [ ] **P2** 按验收标准新增 EuropePMC/Unpaywall/UniProt/ChEMBL 等能力；未通过 search、metadata、download 测试前不得标记为 Pipeline 支持

### 1.5 Pipeline 数据库完整性

> Pipeline 已覆盖 PubMed/GEO 主路径，以及 GDC、Xena、Reactome 的首期显式单源路径；
> 其它数据库仍为 Agent-only 或待接入。Reactome 仅接受显式单个 pathway，且必须单独作为
> 来源运行；Reactome 与其它数据库或多个 pathway 选择会被拒绝。多源合并、mutation/CNV
> 以及 Reactome 更广泛的数据类型和查询扩展仍未完成。
> 1. 用户选择尚未接入的数据库时，Pipeline 不产出伪成功 artifact
> 2. Agent-only 工具获取的数据尚未自动进入 Pipeline CSV（数据孤岛）
> 3. `source_list.csv` 和 `source_relations.csv` 的完整多源覆盖仍待实现
> 4. `field_mapping.csv` 的真实多源映射和确定性合并仍未完成

#### 1.5.1 Discovery 扩展（P0）

> 当前 `TaskSpecification` 虽然能表达通用 `QuerySpecification` / `DatasetSelection`，
> 但 DiscoveryOutput 和 `run_discovery()` 实现仍固定要求 PubMed + GEO 的
> `LiteratureRecord` / `GeoSeriesRecord`，不会按任意数据库查询路由。

- [x] **P0** Pipeline Discovery 支持从 Agent 传入的 `TaskSpecification` 中解析 Xena gene-expression、GDC project/data_type 与 Reactome 显式单 pathway 查询；Reactome 不支持多 pathway 或混合来源
- [x] **P0** Discovery 阶段对 Xena gene-expression、GDC fixture/显式选择及 Reactome 显式单 pathway 产出统一 `SourceRecord`；Reactome 与其它数据库或多个 pathway 选择明确拒绝
- [x] **P0** `source_list.csv` 覆盖 Pipeline 实际查询过的所有数据库——2026-07-31 核对：各路由分支均已覆盖——pubmed+geo 双 source；GDC/Xena/Reactome 单源各产出唯一 SourceRecord（artifact_build 写入全部 `discovery.sources`）；pubmed-only 时 GEO 作为隐式数据集来源保留。新增 `tests/pipeline/test_discovery_source_coverage.py` 契约测试锁定各分支 source 数据库集合
- [x] **P1** Discovery 产出统一的多源 `QuerySpecification` 列表（而非当前隐式假设 PubMed+GEO）——2026-07-31 执行：`_digest_discovery` 纳入规范化多源 queries/datasets（按 order 排序），查询变化必然改变 discovery digest，checkpoint 复用不再误判；契约测试覆盖 query/主题变化

#### 1.5.2 Acquisition 扩展（P0）

> 当前 Pipeline Acquisition 只解析 GEO accession 并下载 GEO counts/series matrix；其它
> 数据库 Skill 的下载结果尚未成为 Pipeline 的 `AcquisitionOutput`。

- [x] **P0** Acquisition 阶段支持 GDC 显式 project_id/data_type 下载（files API → `acquire_source()` → `source_assets/`；首期 TSV/TSV.GZ）
- [x] **P0** Acquisition 阶段支持 Xena fixture 与 live hub 下载适配（TSV/TSV.GZ → `source_assets/`，统一产出 `SourceAsset`/`DownloadAttempt`）；live 输入契约测试已覆盖
- [x] **P1** Acquisition 阶段支持 Reactome 单 pathway 参与者导出（ContentService JSON/fixture → `source_assets/`，fixture/live acquisition 已有协议测试）；多 pathway/多源下载仍未实现
- [x] **P1** `download_log.csv` 记录非 GEO 下载的 attempt 与结果——2026-07-31 执行：`_try_acquire` 不再丢弃失败 attempt（返回 FAILED attempt + asset=None）；GEO live 回退链（counts 404 → series matrix）两条 attempt 全部进入 download_log；artifact_build 透传 error_code/error_message（原先硬编码空串）；测试 `test_acquisition_download_log.py` 覆盖
- [ ] **P2** `acquire_source()` 抽象为协议，各数据库实现各自的下载策略

#### 1.5.3 Processing 扩展（P0）

> 当前 `run_processing()` 只接收一个 `SourceAsset`，并在 live 模式跳过 tximport
> 表达解析；Runner 和 Artifact Build 也只消费第一个资产/解析数据集。

- [x] **P0** Processing 阶段按资产类型路由解析器（已覆盖 Xena、GDC gene-expression/clinical 与 Reactome 单 pathway participants；通用多源路由仍待扩展）
- [x] **P0** 新增 GDC 数据解析器（首期严格支持 fixture 契约的 gene-expression/clinical TSV/TSV.GZ；mutation/CNV/多源合并未实现）
- [x] **P0** 新增 Xena gene-expression 解析器（TSV/TSV.GZ 表达矩阵 → 带 source locator 的长格式 CSV）；clinical/mutation/CNV 等类型仍未支持
- [x] **P1** 新增 Reactome 单 pathway 通路数据解析器（participants → `pathway_members.csv` artifact）；Reactome 扩展数据类型仍未完成
- [x] **P1** `field_mapping.csv` 扩展为多源映射（每个 SourceAsset 独立一组映射记录）——2026-07-31 执行：`field_mapping.csv` 新增 `source_id` 列，`_build_field_mapping_rows` 按 source 分组；schema 就绪，多源合并（§1.2）时每组记录独立

#### 1.5.4 Artifact 完整性（P1）

- [ ] **P1** `artifact_build` 按传入的 `SourceAsset` 类型决定产出哪些 artifact（当前固定 13 个 GEO 侧写）
- [x] **P1** 多源数据合并时生成 `multi_source_manifest.csv`（数据集 ID → 来源数据库 → 行数）——2026-08-01 执行：`_build_multi_source_manifest_rows` 按 `specification.datasets` 匹配 database/accession，每个输入 dataset 一行（含 row_count）；仅 `is_merged` 时写入，单源 artifact 集合不变；`test_artifact_build_publishes_merged_dataset_as_main_data` 断言 manifest 内容
- [x] **P1** `dataset_catalog.csv` 支持非 GEO 条目（当前硬编码 GEO accession 字段）——2026-08-01 执行：`_build_dataset_catalog_rows` 多源分支每输入 dataset 一行（dataset_id/source_id/database/accession/experiment_type/sample_count），保证 merged `main_data.csv` 的 dataset_id 外键闭合
- [ ] **P1** 中间结果与最终结果使用独立的 run/version 标识，旧版已验证 Artifact 不被新 Run 覆盖
- [x] **P1** 合并结果必须重新经过 Artifact Build + Validation Gate，不能由 Agent 直接写入正式 `artifacts/`——2026-08-01 执行：合并包闭环通过完整 Validation Gate——`download_log.csv` 记录全部 attempt（原只写首个）、`sample_metadata.csv` fallback 按行聚合 dataset_id/source_id、lineage 校验（`source_value_lineage`）按行 asset_id 路由到各自源文件（`_lines_for` + 缓存）；新增 `test_merged_package_passes_validation_gate` 端到端锁定 status=valid

#### 1.5.5 Agent ↔ Pipeline 数据桥接与确定性合并（P1）

> Agent 负责发现、选择和补充数据；Pipeline 负责统一处理、合并、验证和发布。
> Agent-only 工具输出不能直接等同于正式科研数据，也不能直接拼装最终 CSV。

- [ ] **P1** 将 Agent 查询、选择理由、进度判定和提取记录持久化为可重放的任务记录；当前仅保存在 `RunContext.query_log` / `sources` / `raw_assets` 内存字段
- [ ] **P1** Agent 获取的原始文件统一注册为 Pydantic `SourceRecord` / `SourceAsset`；当前多数 Skill 仅通过 `add_source` / `add_raw_asset` 记录路径，未统一生成 DownloadAttempt、checksum 和媒体类型契约
- [ ] **P1** Agent 解析结果统一产出 `ParsedDataset`，不得绕过清洗、字段对齐和 Validation Gate；当前 chart extraction 等 Skill 直接写 parsed CSV 或 artifact，尚未接入 Pipeline Processing/Validation
- [ ] **P1** 实现确定性多源合并：主键、去重、字段映射、单位和冲突策略均结构化记录
- [ ] **P1** 每条合并后的 source-derived 记录保留 `SourceLocator`，冲突和未映射数据写入 warning/quality report
- [ ] **P1** “Pipeline 无新进展”必须依据新增来源、资产、记录和质量指标等结构化证据，不由 LLM 主观结论单独决定
- [ ] **P2** 任务目录可增加 `agent_results/` 保存 Agent 决策和查询日志；大型原始数据仍只进入 `source_assets/`
- [ ] **P2** 与 §1.5.1 联动：Agent 发现的 accession 可生成新的 `TaskSpecification`，通过新的 durable Run 触发完整或受控重跑

### 1.6 Agent 编排与 Pipeline 重跑闭环（P1/P2）

> 反复调用通过新的 durable Run 实现，不在同一 Agent Run 内重复占用 Pipeline
> publication slot。完整重跑可复用 digest 一致的已验证阶段输出；参数、来源或处理
> 规则变化必须生成新的 run/version，不覆盖旧 Artifact。

- [ ] **P1** 新 Run 支持携带版本化 `TaskSpecification`，并记录输入、来源和参数摘要；当前 `TaskSpecification` 已有基础模型，但新 Run API 仍只接收字符串 input，未接入该契约
- [ ] **P1** 完整重跑完成新版本 Artifact 的原子发布和旧版本保留；当前 Pipeline 有新的 `run_id` staging 和原子发布，但 `artifacts/` 发布会替换当前目录，不提供历史版本保留/API 选择
- [ ] **P2** 受控局部重跑增加 `rerun_from`，服务端按阶段依赖闭包决定实际重跑范围
- [ ] **P2** 局部重跑覆盖 Discovery → Acquisition → Processing → Artifact Build → Validation 的依赖一致性测试
- [ ] **P2** 禁止 Agent 任意指定 `skip_stages`，禁止下游阶段消费与输入 digest 不匹配的上游输出
- [ ] **P2** 将 Pipeline 结果分类为 `validated_intermediate` / `validated_final`，避免第一轮结果被误认为最终结果；当前 `RunManifest` 只有 `task_state` 和 validation 状态，没有结果阶段语义

### 1.7 人在回路：数据修正闭环

> 依赖 §1.1 清洗能力接入。（共享暂停原语已在 §A.10 完成）

- [ ] **P2** 新增 `request_human_correction` function_tool，包装 `CleaningReport.anomaly_flags` 为 `UserInputRequiredPayload(prompt_kind="data_correction")`
- [ ] **P2** `UserInputDialog` 增加 `data_correction` 分支渲染（异常条目表格 + 修正输入）
- [ ] **P2** 超时退化为批处理：生成 `corrections_todo.csv` 供离线修正

---

## 2. 数据源完备性（P0/P1）

> 多源数据接入、合规化与契约统一。

### 2.1 Acquisition Skills 合规化（接入 crawler.py）

- [x] **P1** GDC skill 接入 `crawler.py`（受管控 Run 使用绑定 facade；隔离 legacy fixture 保留 `urllib` 回退）
- [x] **P1** PDB skill 接入 `crawler.py`（GET/POST API 和下载均使用绑定 facade）
- [x] **P1** Xena skill 接入 `crawler.py` + 使用绑定 facade（S3 XML listing 保留原解析器；隔离 legacy fixture 保留 `urllib` 回退）

### 2.2 Xena 403 修复

- [x] **P1** 切换 download host 到 `toil.xenabrowser.net` 或加 browser fallback——2026-08-01 核对：`download_xena` 已切换 S3 hub（`toil-xena-hub.s3.us-east-1.amazonaws.com/download/{dataset_id}.gz`），URL 构造回归测试（`test_download_xena_url_uses_gz_not_tsv_gz`）锁定
- [x] **P1** 更新 `integrations/acquisition.py:_ALLOWED_HOSTS` 域名白名单——2026-08-01 核对：已含 `toil-xena-hub.s3.us-east-1.amazonaws.com`
- [x] **P1** 更新 `test_skill_xena.py` 的 URL 硬断言——2026-08-01 核对：403/URL 构造断言均使用 toil hub
- [ ] **P1** 移除 `test_all_data_sources_live.py:200-208` 的 xfail（live 网络验证，需真实外网可达后移除）

### 2.3 补全 download 工具

- [x] **P1** PubChem 增加 `download_pubchem`（SDF/MOL，走 `acquire_source()` → `SourceAsset`）——2026-08-01 执行：`download_pubchem` 经 PUG-REST `record/SDF|MOL?record_type=2d` 下载；managed 子代理经 crawler facade 提交 `SourceAsset`，主代理写入 task raw 目录，均记录 `SourceRecord`；URL/格式校验/错误路径契约测试覆盖
- [x] **P1** Reactome 增加独立 `download_reactome` skill（participants TSV / SBGN，走 `acquire_source()` → `SourceAsset`）；Pipeline 显式 pathway participants 已完成——2026-08-01 执行：`download_reactome` 经 ContentService exporter（`participants/{id}.tsv` / `diagram/{id}.sbgn`）下载；managed 子代理提交 `SourceAsset`，主代理写入 raw 目录；TSV/SBGN/错误路径/子代理 SourceAsset 测试覆盖；抽取共享 `_download_io.download_file_for_run`（复用 xena/pdb 模式，避免第 3/4 份重复）

### 2.4 统一 SourceAsset 契约

- [ ] **P1** GDC/PDB/Xena/browser 下载路径走 `acquire_source()`（当前只有 GEO 走完整 verified streaming）
- [ ] **P1** 所有 acquisition skill 产出合规 `SourceAsset`

### 2.5 PubMed XML 注册为 SourceAsset + download_log 完整性

- [ ] **P1** `download_supplementary` 改为走 `acquire_source()` 产出 `SourceAsset`
- [ ] **P1** `acquire_source` 返回所有 attempt（含失败），当前只返回最终一次
- [ ] **P1** `download_log.csv` 记录失败 attempt 与 reason（完整回退链路可见）
- [ ] **P1** 大文件下载增加 progress 事件（>100MB 当前无反馈）

### 2.6 删除旧 domain 模型（dataclass）

> 旧 `app.domain/output.py` 已删除；`processing.py` 的 `ParsedDataset` 仍被 `tools/` 引用（MVP 遗留，待后续清理）。

- [x] **P1** 迁移 `tools/export.py` 到新 Pydantic 契约——2026-07-31 执行：`export.py` 生产零引用（仅被 `demo_workflow.py` 脚本与 `test_output.py` 引用），与 `app/domain/output.py` 旧 dataclass 整链删除
- [x] **P1** 迁移或删除 `scripts/demo_workflow.py` 旧 `SourceRecord(...)` 实例化——2026-07-31 执行：删除 MVP 遗留端到端演示脚本（功能已被 durable Run + Pipeline 替代）
- [x] **P1** 删除 `app/domain/output.py` 的旧 `SourceRecord` dataclass——2026-07-31 执行：整链删除（SourceRecord/DataRecord/OutputBundle 等 6 个 dataclass 全部移除）
- [x] **P1** 清理 `app/domain/__init__.py` 顶层导出——2026-07-31 执行：移除 output 相关导出，docstring 同步更新
- [x] **P1** 同步更新 `tests/test_output.py`——2026-07-31 执行：连同 `test_demo_workflow.py` 删除；后端 README 目录树同步

### 2.7 赛题加分项

#### 2.7.1 图表数据提取

- [ ] **P2** `validation.py` 新增 `chart_data` 完整性校验（每行有 source_asset_id，每个 point 有 chart_id）

#### 2.7.2 单位不一致检测

- [ ] **P2** `cleaning.py` 新增 `detect_unit_inconsistencies`
- [ ] **P2** 单位冲突写入 `warnings.csv`

#### 2.7.3 OCR 能力

- [ ] **P2** `extract_tables.py` 增加 `ocr_fallback`（pytesseract 可选依赖）
- [ ] **P2** 中文支持 `lang='chi_sim+eng'`

#### 2.7.4 DE 分析 FDR 校正

- [ ] **P2** `stats.py:run_differential_expression` 增加 BH FDR 校正
- [ ] **P2** 火山图增加 `padj` 阈值线
- [ ] **P2** 输出 `padj` 字段
- [ ] **P2** 移除 `stats.py:638` 的 `# type: ignore[arg-type]`

#### 2.7.5 extract_tables 测试覆盖

- [ ] **P2** `tests/test_skill_extract_tables.py` 增加真实 pdfplumber 路径测试
- [ ] **P2** 在 `tests/fixtures/` 放置最小真实 PDF（1 页 1 表）

#### 2.7.6 视觉采集与 VLM 联调

- [ ] **P2** `web_visual_capture` 与 `extract_chart_data_vlm` 联调（集成测试：capture → VLM → CSV）
- [ ] **P2** BrowserPool 接入 `crawler.py`（切换为 `pool.acquire_context()`）

### 2.8 GEO 主产物数据恢复

> 现有 live Acquisition 可能下载 tximport counts，但 Processing 将其按 series matrix
> 解析，无法恢复样本时会生成零行占位数据。Validation Gate 已拒绝零行
> `main_data.csv`，但真实表达数据恢复仍需修正 acquisition/processing 契约。

- [x] **P0** Acquisition 在 live tximport counts 成功后同步获取对应 `family.soft.gz`；Processing 使用实际下载的 SOFT 解析样本并生成真实表达记录；已有 live 回归测试覆盖 counts + SOFT 路径

---

## 3. 前端体验与呈现（P1/P2）

### 3.1 产物/结果展示

- [ ] **P1** `ResultsViewer` 增加 `field_descriptions.csv` 专门视图（表格：field_name / data_type / description / unit / nullable / example）
- [ ] **P1** `ResultsViewer` 增加 `source_list.csv` / `source_relations.csv` 专门视图
- [ ] **P1** `ResultsViewer` 用 Tabs 分离主数据/来源/处理/警告（14 个 artifact 当前平铺）
- [ ] **P2** `SettingsPanel` Tab 移至左侧垂直布局（当前水平排列 Model/Databases/Skills）

### 3.2 invoke_skill / find_skill 前端呈现

> 当前 `invoke_skill` 统一显示为"调用 invoke_skill"，无法体现实操；输出 JSON 纯单行无换行滚动。

- [ ] **P2** `toolLabels.ts` 新增 `invoke_skill` formatter：从 `args.operation`（如 `search_xena`）读取技能名，按前缀推测 verb（`search_*` → "检索"）
- [ ] **P2** `toolLabels.ts` 新增 `find_skill` formatter：从 `args.intent` 显示意图
- [ ] **P2** `ToolCallStep` 紧凑化：缩小 padding、完成态图标调灰（`text-muted-foreground`）、字体降级
- [ ] **P2** `ToolCallStep` 输出区域改造：自动换行 + 垂直滚动 + 隐藏滚动条（超 200px 时 `max-h-48 overflow-y-auto [scrollbar-width:none]`）+ JSON 自动格式化

### 3.3 模型搜索框恢复

> 当前受 `hasApiKey && sortedModels.length > 0` 守卫控制；降级分支无搜索。

- [ ] **P1** 排查 `hasApiKey` / `sortedModels` 不满足条件的原因，修复上游传值
- [ ] **P2** 降级分支（旧 `DropdownMenu`）也加入搜索输入框
- [ ] **P2** 清理 `LEGACY_MODELS` 硬编码列表，改为从 API 动态获取

### 3.4 对话流任务节点自动折叠

> 详见 `docs/REVIEW_2026-07-20-llm-output-hygiene.md` §3。参考 TRAE SOLO 模式。

- [ ] **P1** 节点边界：以 `tool_completed` 到达为界，`[assistant_segment, tool_call]` 归组为"任务节点"
- [ ] **P1** 自动折叠：节点完成后折叠为单行摘要（`✓ <工具标签> · <一句话结论>`）；活跃节点保持展开；可点击展开
- [ ] **P1** 前端实现：`types.ts` 新增 `TaskNode` 投影；`reducer.ts` 归组逻辑；`TaskNodeItem.tsx` 新组件
- [ ] **P1** 摘要生成：工具标签来自 `formatToolCall()`；结论来自后续 `assistant_segment` 首句 / 工具 output `summary` 字段
- [ ] **P1** 降级：归组失败时保持逐项展示

### 3.5 通用 UI 改进

- [ ] **P2** 引入 shadcn command / context-menu / menubar 组件
- [ ] **P2** 优化思维链呈现 / 产物呈现
- [ ] **P2** 引入对话路由（便于调试 & 厘清页面关系）
- [ ] **P2** 缓存导出按钮放到设置页面
- [ ] **P2** 优化边栏底部（当前信息过于杂乱）

---

## 4. 可靠性与可观测性（P0/P1）

### 4.1 静默吞错修复

- [x] **P0** `runtime/manager.py:331-334` `_commit_task` 失败增加 logger.error（当前 `except Exception: pass`）——2026-07-31 重构核对：`_abort_completion_once` 已带 `logger.error`（manager.py:340-344）
- [x] **P0** `agent_loop/runner.py:324` 限制 `except BaseException` 范围到 `except Exception`——2026-07-31 重构执行（现 337 行 `emit_task.result()` 静默吞错收敛；其余 `except BaseException` 均为 abort 回退 + re-raise 模式，保留）

### 4.2 Pipeline artifact 降级路径

- [x] **P1** 指纹未变（digest 命中 checkpoint 复用）时仍发射 `artifact_produced`，前端 HTTP 拉取路径可用——2026-07-31 核对：`pipeline/runner.py:_finalize_completed` 无条件为每个 artifact 发射 `artifact_produced`，原指纹跳过逻辑已移除
- [x] **P1** `routes.py:548-549` `.runtime-publication.json` 缺失时回退到 manifest 文件本身（加 `degraded=true` 标记）——2026-07-31 执行：`_load_validated_manifest` 返回 `(manifest, artifacts_dir, degraded)`，marker 缺失且存在 ≥1 个 COMPLETED run 时降级返回；`list_artifacts` 响应新增 `degraded` 字段，`get_artifact_file` 忽略标记

### 4.3 错误日志增强

- [x] **P1** `pipeline/state.py:228` `load_stage_output` 异常返回 None 时增加 `logger.warning`——2026-07-31 执行
- [x] **P1** `pipeline/runner.py:617` `_collect_stage_output_files` 异常时增加警告日志——2026-07-31 执行（恢复路径 658 行 `logger.warning`，含 stage/attempt 上下文）
- [x] **P1** `api/ws_events.py:362, 375, 381` WebSocket 错误路径增加 WARN 日志——2026-07-31 执行（`_send_internal_error_and_close` 错误帧发送/关闭失败；`_close_websocket` best-effort 关闭保持静默避免正常 shutdown 噪音）

### 4.4 结构化日志

- [ ] **P1** `main.py` 引入 structlog 或 python-json-logger，所有日志带 `task_id`/`run_id`/`stage` 上下文
- [ ] **P2** 新增 `docs/observability.md`

### 4.5 Agent max_turns 后续

- [ ] **P2** INSTRUCTIONS 新增"达到 max_turns 后应输出 `[MAX_TURNS_REACHED]` 标记"指导
- [x] **P1** 实施轮次限制移除方案（轮次参数化 + token 预算门控 + 无进展检测器；子代理默认超时 1h）——见 docs/REVIEW_2026-07-31-agent-turn-limits.md（已实施并合并 4adaade）

---

## 5. 工程基础设施（P1/P2）

### 5.1 消除死代码与重复

- [x] **P1** 删除 `api/settings_router.py`（仅被 `test_settings_api.py` 引用，已迁移后可移除）——2026-07-31 重构执行：安全测试迁移至 `test_model_preview_security.py`/`test_network_safety.py` 后删除
- [x] **P1** 前端删除 `agentSelectors.ts` 未使用导出（`selectActiveRuns` 等）——2026-07-31 重构执行
- [x] **P1** 提取共享 `_write_csv` 到 `tools/io.py`（`artifact_build.py` + `validation.py` 各一份）——2026-07-31 重构执行：合并为 `pipeline/stages/base.py:write_csv`（两文件均已导入 base，未引入新依赖）
- [x] **P2** 前端提取 `errorDescription` 到 `lib/utils.ts`（5 处重复）——2026-07-31 重构执行：`utils.ts:errorMessage`，7 处调用点统一
- [x] **P2** 前端统一 `formatSize` 到 `fileUtils.ts`（3 份不一致的变体）——2026-07-31 核对：`fileUtils.ts:formatSize` 已统一，`ArtifactSheet.tsx`/`ResultsViewer.tsx` 已迁移；本次将 `AgentComposer.tsx` 残留本地 `formatFileSize`（KiB/MiB 变体）一并迁移至 `formatSize`
- [x] **P2** 修正 `tools/io.py` → `agent_loop/context.py` 循环依赖——2026-07-31 核对：`context.py` 仅依赖 `tools/workdir`，与 `tools/io` 无反向引用，循环不存在；移除 `io.py` 末尾延迟导入 hack，`RunContext` 改顶部 import

### 5.2 并发与资源管理

- [x] **P1** `crawler.py` 引入 BrowserPool（`tools/browser_pool.py`，lifespan 持有，单浏览器 ≤4 context 并发共享）
- [ ] **P2** 监控并发 Chromium 实例数，超阈值时排队

### 5.3 配置硬编码治理

- [ ] **P2** `config.py` 扩展配置项（`crawler_ua` / `crawler_rate_limit_seconds` / `compaction_*` / `stage_timeouts` / `max_download_bytes`）
- [ ] **P2** 启动时校验 `DASHSCOPE_API_KEY` 非空（fail fast）
- [ ] **P2** `OUTPUT_DIR` 改为绝对路径默认值（当前相对路径 cwd 依赖）

---

## 6. 托管式 Subagent 与自主数据源探索（P0）

> 对应 Commonly TASK-030。完整设计见
> `docs/superpowers/specs/2026-07-28-managed-subagent-research-design.md`。

### 6.1 运行时与事件契约

- [x] **P0** 新增 `SubagentSupervisor`、子 Agent 状态机和父 Task durable event 投影
- [x] **P0** 支持单 Run 3 路、全局 4 路子 Agent 并发，以及父子取消和重启中断
- [x] **P0** 新增独立 `subagent_input_required` HIL 路由，兄弟任务保持运行

### 6.2 WorkflowRecipe 与采集

- [x] **P0** 用户数据源选择改为偏好，公开免登录来源允许自动探索
- [x] **P0** 新增不可执行 WorkflowRecipe Store 与内部 `create_skill` Skill
- [x] **P0** 强制 API → HTML → Browser 三级回退，并记录可审计尝试
- [x] **P0** 子 Agent 仅提交已验证 SourceAsset，Validation Gate 继续独占产物发布
- [x] **P1** Crawler 接入 lifespan-owned BrowserPool 和 per-host limiter
- [x] **P1** 封闭旧 `self_evolution` 任意 Python 写入 `learned/` 的路径

### 6.3 前端

- [x] **P0** 右侧 `ResizablePanel` 改为 subagent 工作区，移动端使用 Sheet
- [x] **P0** 产物入口迁移到聊天输入区左下角 FAB，并支持预览/保存全部
- [x] **P0** reducer 支持 subagent snapshot/event 投影及旧事件回放

### 6.4 验证

- [x] **P0** 覆盖并发、取消、重启、HIL、Recipe、安全边界和三级回退测试
- [x] **P0** 完成多子 Agent → SourceAsset → Pipeline → Validation Gate 端到端测试
