# BioMed-QAgent 开发 TODO

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）。

---

## 1. 管道核心能力（P0）

### 1.1 清洗能力接入 Pipeline

- [x] **P0** Processing 阶段执行清洗并产出 `CleaningReportModel`
- [x] **P0** 生成 `cleaning_report.csv` artifact
- [x] **P0** 将 `anomaly_flags` 写入 `warnings.csv`
- [x] **P0** Validation 增加 cleaning_report 存在性与异常计数一致性校验

### 1.2 字段对齐能力接入

- [x] **P0** 多源数据路径中调用 `alignment.align_fields`
- [x] **P0** 调用 `alignment.merge_datasets` 垂向合并
- [x] **P0** 生成 `field_mapping.csv` 的真实映射关系

### 1.3 清洗测试

- [x] **P0** `tests/pipeline/test_processing_cleaning.py` 验证缺失/重复/类型异常

### 1.4 数据源能力边界

> Agent 可使用的数据库不等于 Pipeline 已验收支持的数据源。

- [x] **P0** `/databases` 返回 `pipeline_supported`
- [x] **P0** `SOURCE_CAPABILITIES` 单一事实表区分 `pipeline_supported` 与 `research_only`
- [x] **P0** 未支持来源返回 `status=unsupported_databases`，不产生伪成功 artifact
- [ ] **P1** Acquisition 为 PubMed 补充材料等正式来源产出合规 `SourceAsset`
- [x] **P2** EuropePMC / Unpaywall 能力（pdf_url → Unpaywall → EPMC fullTextXML 三级回退，0804 已实现，`acquire_publication_with_fallback`）
- [ ] **P2** 新增 UniProt/ChEMBL 等能力（仍 Agent-only，未接入 pipeline）

### 1.5 Pipeline 数据库完整性

> Pipeline 已覆盖 PubMed/GEO 主路径，GDC、Xena、Reactome 的单源路径，
> 以及 GDC + Xena 的确定性合并路径。其它数据库仍为 Agent-only 或待接入。

#### 1.5.1 Discovery 扩展

- [x] **P0** Discovery 支持从 `TaskSpecification` 解析 Xena/GDC/Reactome 查询
- [x] **P0** Discovery 产出统一 `SourceRecord`；Reactome 拒绝多 pathway 或混合来源
- [x] **P0** `source_list.csv` 覆盖 Pipeline 实际查询的所有数据库
- [x] **P1** Discovery 产出统一的多源 `QuerySpecification` 列表

#### 1.5.2 Acquisition 扩展

- [x] **P0** Acquisition 支持 GDC 显式 project_id/gene-expression 下载
- [x] **P0** Acquisition 支持 Xena fixture 与 live hub 下载
- [x] **P0** GDC + Xena 按规格顺序保留两份资产和两条 attempt
- [x] **P1** Acquisition 支持 Reactome 单 pathway 参与者导出
- [x] **P1** `download_log.csv` 记录所有 attempt（含失败）
- [ ] **P2** `acquire_source()` 抽象为协议

#### 1.5.3 Processing 扩展

- [x] **P0** Processing 按资产类型路由解析器（Xena、GDC、Reactome）
- [x] **P0** GDC 数据解析器（gene-expression/clinical）
- [x] **P0** Xena gene-expression 解析器
- [x] **P1** Reactome 单 pathway 通路数据解析器
- [x] **P1** `field_mapping.csv` 扩展为多源映射
- [ ] **P1** 基因符号映射：先确权 namespace 分布（`ensembl_gene`/`geo_probe` 为主；0804 suppl 解析器已产出 `gene_symbol`）；优先本地映射（避免 mygene 在线依赖），定义多对一聚合策略；`main_data.csv` 增加 `gene_symbol` 列（0805 复核修正，REVIEW §9.6）

#### 1.5.4 Artifact 完整性

- [ ] **P1** `artifact_build` 按资产类型决定产出哪些 artifact
- [x] **P1** 多源合并时生成 `multi_source_manifest.csv`
- [x] **P1** `dataset_catalog.csv` 支持非 GEO 条目
- [ ] **P1** 中间结果与最终结果使用独立的 run/version 标识
- [x] **P1** 合并结果经过完整 Validation Gate

#### 1.5.5 Agent ↔ Pipeline 数据桥接与确定性合并

> Agent 负责发现、选择和补充数据；Pipeline 负责统一处理、合并、验证和发布。

- [ ] **P1** Agent 查询、选择理由、进度判定持久化为可重放的任务记录
- [ ] **P1** Agent 获取的原始文件统一注册为 `SourceRecord` / `SourceAsset`
- [ ] **P1** Agent 解析结果统一产出 `ParsedDataset`，不绕过 Validation Gate
- [ ] **P1** 实现确定性多源合并：主键、去重、字段映射、冲突策略结构化记录
- [ ] **P1** 每条合并后记录保留 `SourceLocator`
- [ ] **P1** "Pipeline 无新进展"依据结构化证据，非 LLM 主观结论
- [ ] **P2** 任务目录增加 `agent_results/` 保存 Agent 决策日志
- [ ] **P2** Agent 发现的 accession 可生成新 `TaskSpecification` 触发重跑

#### 1.5.6 GEO 多数据集支持（0805 复核修正，REVIEW §9.5）

> 共病/比对类主题刚需（0804 实测 4 个 GSE 被静默丢弃 3 个）。设计先于实现。

- [ ] **P1** 消除 `_resolve_gse` 静默截断：多 GSE 全部保留（`dataset_catalog` / `source_list`）
- [ ] **P1** 多 GSE **各数据集独立发布**（不做表达值行级合并——跨数据集合并引入 batch effect，非当前 pipeline 范围）；每 GSE 独立走 acquisition→processing→artifact 链，`source_relations` 记录双侧关系

#### 1.5.7 0805 实测修复：GEO 前缀目录与 GDC data_type 一致性

> 0805 对 task_662b8435 全流程失败的真实网络验证结论（GEO 反复失败的根因，已修复）。

- [x] **P0** GEO FTP 系列目录前缀规则：`GSE{编号去掉后3位}nnn`（GSE15471→GSE15nnn、GSE178352→GSE178nnn）。此前 `acquisition.py` 用 `gse[:6]` 只对 6 位编号（fixture GSE178352）碰巧正确，5 位编号全部 404。已修复为 `_geo_series_dir`，与 skill 层 `geo.py` 的 `accession[:-3] + "nnn"` 约定一致
- [x] **P0** GDC `data_type` 双路径必须一致：`acquisition._gdc_live_data_type` 接受官方标签 `Gene Expression Quantification`，`processing.parse_gdc_table` 必须接受同一值（已加 `"gene expression quantification"`），否则下载成功的数据集在 processing 被拒
- [x] **P1** GDC 未知 `data_type`（如 `transcriptome_profiling`，是 experimental_strategy 而非 data_type）错误信息列出全部合法值，帮助 Agent 自纠错

#### 1.5.8 0805 task_db204f6b 审查：probe→gene 映射与单基因分析可用性（REVIEW_2026-08-05-task-db204f6b）

> 0805 对 task_db204f6b（METTL5 胰腺癌 tumor vs normal，GSE102238）的产物审查 + 自主调研实证：
> 数据集（50 对配对 PDAC）选择合理、溯源完整、验证通过，但 950MB probe 级主产物无法定位 METTL5——
> GPL19072 平台注释（GEO 侧）所有基因映射列均为空，probe→gene 无法构建。单基因分析应优先 TCGA 基因级矩阵。

- [x] **P0** processing 增加平台注释解析：GEO 注释可下载时构建 probe→gene 映射；不可用时 artifact build 注入 `geo_probe_unmapped` 显式 warning（REVIEW §3.1）
  - 实现：`app/pipeline/processing/geo_annotation.py`（FTP `suppl/*.txt.gz` / `annot/*.annot.gz` 目录发现 + SOFT `!platform_table_begin/end` 解析 + ContentCache 缓存；GPL19072 实测 unmapped）；`process_geo_series_matrix_expression` 命中映射写 `gene_id_namespace="gene_symbol"`；`builder.py` 对 `probe_gene_mapping` ∈ {unmapped, no_gene_annotation, annotation_unavailable} 注入 warning
- [x] **P0** 主产物体积治理：probe 级全基因组长格式提供按目标基因过滤输出，避免 950MB 单文件（REVIEW §2.3）
  - 实现：`builder.py` 从 `ctx.topic` 提取基因 token，`main_data.csv` 中按 `gene_id`/`gene_id_raw` 过滤生成 `{gene}_expression.csv` 副产物（无匹配则不出文件）
- [x] **P1** discovery/plan 引导：单基因差异分析优先 GDC/Xena 基因级矩阵（TCGA-PAAD 178 tumor+4 normal 实证可用），微阵列作验证（REVIEW §3.2）
  - 实现：`agent.py` INSTRUCTIONS 局部重构——第 1 步策略列表新增"单基因/靶基因差异分析"；第 2 步数据源参考新增"优先 GDC/Xena 基因级 RNA-seq 矩阵（gene symbol 直接可用、无需 probe→gene 注释映射）、GEO 微阵列作配对样本/交叉验证"；`core_data_existence` 失败场景由"一律优先 microarray"修正为"单基因目标优先 GDC/Xena 基因级矩阵，GEO 内才优先 microarray"；`run_research_pipeline` 工具描述补充同款引导（`xena_dataset_id`/`gdc_project_id` 参数）
- [x] **P1** plan 确认（`user_input_required`）超时策略：自动批准并打标而非失败，run 不因未确认 plan 作废（REVIEW §3.3）
  - 实现：`runner._await_user_input` 中 `plan_confirmation` 超时不再 raise，构造 `decision="approve"` 且 `detail.auto_approved=True / auto_approve_reason=plan_confirmation_timeout` 的 resume 事件后继续执行；其他 prompt_kind（data_correction 等）保持超时失败
- [ ] **P2** `sample_metadata` 结构化 tumor/normal 分组与配对 ID（REVIEW §2.4）

### 1.6 Agent 编排与 Pipeline 重跑闭环

- [x] **P0** checkpoint `parameter_digest` 覆盖排序后的数据库集合与完整 `TaskSpecification`
- [ ] **P1** `run_research_pipeline` 前对每个候选 GSE 强制调用 `describe_geo`（prompt gate），解决数据集相关性 vetting 的执行纪律问题——0804 选错数据集（mitophagy 聚焦阵列做共病机制）根因是未 vetting 即提交，工具已存在（0805 复核，REVIEW §7.2）
- [ ] **P1** 新 Run 支持携带版本化 `TaskSpecification`
- [ ] **P1** 完整重跑完成新版本 Artifact 的原子发布和旧版本保留
- [ ] **P2** 受控局部重跑增加 `rerun_from`
- [ ] **P2** 局部重跑覆盖依赖一致性测试
- [ ] **P2** 禁止 Agent 任意指定 `skip_stages`
- [ ] **P2** Pipeline 结果分类为 `validated_intermediate` / `validated_final`

### 1.7 人在回路：数据修正闭环

> 0805 复核：`request_human_correction` 是 **Agent 层**工具（Agent 主动请求用户修正数据）。
> pipeline 内"下载失败时自动触发 `user_input_required`"的 HIL **已否决**——会阻塞自动化场景，
> Agent 收到失败详情后已有决策权（REVIEW §9.2）。

- [ ] **P2** 新增 `request_human_correction` function_tool
- [ ] **P2** `UserInputDialog` 增加 `data_correction` 分支渲染
- [ ] **P2** 超时退化为批处理：生成 `corrections_todo.csv`

---

## 2. 数据源完备性（P0/P1）

### 2.1 Acquisition Skills 合规化

- [x] **P1** GDC skill 接入 `crawler.py`
- [x] **P1** PDB skill 接入 `crawler.py`
- [x] **P1** Xena skill 接入 `crawler.py`

### 2.2 Xena 403 修复

- [x] **P1** 切换 download host 到 `toil.xenabrowser.net`
- [x] **P1** 更新 `_ALLOWED_HOSTS` 域名白名单
- [x] **P1** 更新 URL 硬断言测试
- [ ] **P1** 移除 `test_all_data_sources_live.py` 的 xfail

### 2.3 补全 download 工具

- [x] **P1** PubChem 增加 `download_pubchem`（SDF/MOL）
- [x] **P1** Reactome 增加独立 `download_reactome` skill

### 2.4 统一 SourceAsset 契约

- [x] **P1** GDC / Xena 下载路径走 `acquire_source()`（0804 已实现，live acquisition 均经 `acquire_source`）
- [ ] **P1** PDB / browser 下载路径走 `acquire_source()`（仍待办）
- [ ] **P1** 所有 acquisition skill 产出合规 `SourceAsset`

### 2.5 PubMed XML 注册为 SourceAsset + download_log 完整性

- [ ] **P1** `download_supplementary` 改为走 `acquire_source()`
- [x] **P1** `acquire_source` 返回所有 attempt（含失败）（0804 已实现，见 §1.5.2 与 `test_acquisition_download_log.py`）
- [x] **P1** `download_log.csv` 记录失败 attempt 与 reason（0804 已实现）
- [ ] **P1** 大文件下载增加 progress 事件

### 2.7 赛题加分项

#### 2.7.1 图表数据提取

- [ ] **P2** `validation.py` 新增 `chart_data` 完整性校验

#### 2.7.2 单位不一致检测

- [ ] **P2** `cleaning.py` 新增 `detect_unit_inconsistencies`
- [ ] **P2** 单位冲突写入 `warnings.csv`

#### 2.7.3 OCR 能力

- [ ] **P2** `extract_tables.py` 增加 `ocr_fallback`
- [ ] **P2** 中文支持 `lang='chi_sim+eng'`

#### 2.7.4 DE 分析 FDR 校正

- [ ] **P2** `stats.py:run_differential_expression` 增加 BH FDR 校正
- [ ] **P2** 火山图增加 `padj` 阈值线
- [ ] **P2** 输出 `padj` 字段

#### 2.7.5 extract_tables 测试覆盖

- [ ] **P2** 增加真实 pdfplumber 路径测试
- [ ] **P2** 放置最小真实 PDF fixture

#### 2.7.6 视觉采集与 VLM 联调

- [ ] **P2** `web_visual_capture` 与 `extract_chart_data_vlm` 联调
- [x] **P2** BrowserPool 接入 `crawler.py`（已由 §5.2 完成）

### 2.8 GEO 主产物数据恢复

- [x] **P0** Live tximport counts 成功后同步获取 `family.soft.gz`
- [x] **P0** Processing 回退解析 series_matrix 表达矩阵块；空块回退到 sample_metadata
- [x] **P0** 下载失败回退 + retryable 信号（`DownloadError` → `NETWORK_ERROR`）
- [x] **P0** series_matrix 表达块为空时自动下载并解析 supplementary 表达矩阵

---

## 3. 前端体验与呈现（P1/P2）

### 3.1 产物/结果展示

- [ ] **P1** `ResultsViewer` 增加 `field_descriptions.csv` 专门视图
- [ ] **P1** `ResultsViewer` 增加 `source_list.csv` / `source_relations.csv` 视图
- [ ] **P1** `ResultsViewer` 用 Tabs 分离主数据/来源/处理/警告
- [ ] **P2** `SettingsPanel` Tab 移至左侧垂直布局

### 3.2 invoke_skill / find_skill 前端呈现

- [ ] **P2** `toolLabels.ts` 新增 `invoke_skill` / `find_skill` formatter
- [ ] **P2** `ToolCallStep` 紧凑化 + 输出区域改造

### 3.3 模型搜索框恢复

- [ ] **P1** 排查 `hasApiKey` / `sortedModels` 不满足条件的原因
- [ ] **P2** 降级分支也加入搜索输入框
- [ ] **P2** 清理 `LEGACY_MODELS` 硬编码列表

### 3.4 对话流任务节点自动折叠

- [ ] **P1** 以 `tool_completed` 为界归组"任务节点"
- [ ] **P1** 节点完成后折叠为单行摘要
- [ ] **P1** 前端实现 `TaskNode` 投影与 `TaskNodeItem` 组件
- [ ] **P1** 摘要生成：工具标签 + 一句话结论
- [ ] **P1** 降级：归组失败时保持逐项展示

### 3.5 通用 UI 改进

- [ ] **P2** 引入 shadcn command / context-menu / menubar
- [ ] **P2** 优化思维链呈现 / 产物呈现
- [ ] **P2** 引入对话路由
- [ ] **P2** 缓存导出按钮放到设置页面
- [ ] **P2** 优化边栏底部

---

## 4. 可靠性与可观测性（P0/P1）

### 4.1 静默吞错修复

- [x] **P0** `_commit_task` 失败增加 `logger.error`
- [x] **P0** 限制 `except BaseException` 范围到 `except Exception`

### 4.2 Pipeline artifact 降级路径

- [x] **P1** 指纹命中 checkpoint 复用时仍发射 `artifact_produced`
- [x] **P1** `.runtime-publication.json` 缺失时降级返回 manifest

### 4.3 错误日志增强

- [x] **P1** `load_stage_output` 异常返回 None 时增加 `logger.warning`
- [x] **P1** `_collect_stage_output_files` 异常时增加警告日志
- [x] **P1** WebSocket 错误路径增加 WARN 日志

### 4.4 结构化日志

- [x] **P1** PipelineRunner 关键事件输出人类可读摘要日志
- [x] **P1** pipeline.jsonl 加 filter 防止子 logger 文本污染
- [ ] **P2** `main.py` 引入 structlog 或 python-json-logger
- [ ] **P2** 新增 `docs/observability.md`

### 4.5 Agent max_turns 后续

- [x] **P1** 轮次限制移除方案（token 预算门控 + 无进展检测器）
- [ ] **P2** INSTRUCTIONS 新增"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"指导

### 4.6 覆盖率确定性统计（0805 复核新增，REVIEW §7.1）

> ReviewerAgent 现为纯 LLM 统计 query_log（大数统计是 LLM 幻觉高发区）。
> 确定性聚合应作为 reviewer 的前置数据供给，而非独立工具。

- [ ] **P1** query_log 按 source 确定性聚合（success / not_found / failed / 记录数），喂给 `review_query_strategy` 前注入

---

## 5. 工程基础设施（P1/P2）

### 5.1 消除死代码与重复

- [x] **P1** 删除 `api/settings_router.py`
- [x] **P1** 前端删除 `agentSelectors.ts` 未使用导出
- [x] **P1** 提取共享 `write_csv` 到 `pipeline/stages/base.py`
- [x] **P2** 前端提取 `errorDescription` 到 `lib/utils.ts`
- [x] **P2** 前端统一 `formatSize` 到 `fileUtils.ts`
- [x] **P2** 修正 `tools/io.py` → `agent_loop/context.py` 循环依赖

### 5.2 并发与资源管理

- [x] **P1** `crawler.py` 引入 BrowserPool
- [ ] **P2** 监控并发 Chromium 实例数，超阈值时排队

### 5.3 配置硬编码治理

- [x] **P0** 模型跨端点预览不得隐式携带已保存 API Key
- [x] **P0** Live Pipeline 的 checkpoint 参数摘要不读取 `tests/fixtures`
- [ ] **P2** `config.py` 扩展配置项（crawler_ua / rate_limit / stage_timeouts 等）
- [ ] **P2** 启动时校验 `DASHSCOPE_API_KEY` 非空
- [ ] **P2** `OUTPUT_DIR` 改为绝对路径默认值
