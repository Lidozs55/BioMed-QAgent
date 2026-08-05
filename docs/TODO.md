# BioMed-QAgent 开发 TODO

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）。
> 本文件仅保留**未完成**待办；已完成项的根因、实现说明与结论见
> `docs/REVIEW_*.md`、`docs/RESEARCH_SYSTEM_REVIEW_2026-08-03.md` 与 git 历史。

---

## 1. 管道核心能力（P0）

### 1.4 数据源能力边界

> Agent 可使用的数据库不等于 Pipeline 已验收支持的数据源。

- [ ] **P1** Acquisition 为 PubMed 补充材料等正式来源产出合规 `SourceAsset`
- [ ] **P2** 新增 UniProt/ChEMBL 等能力（仍 Agent-only，未接入 pipeline）

### 1.5 Pipeline 数据库完整性

> Pipeline 已覆盖 PubMed/GEO 主路径，GDC、Xena、Reactome 的单源路径，
> 以及 GDC + Xena 的确定性合并路径。其它数据库仍为 Agent-only 或待接入。

#### 1.5.2 Acquisition 扩展

- [ ] **P2** `acquire_source()` 抽象为协议

#### 1.5.3 Processing 扩展

- [ ] **P1** 基因符号映射：先确权 namespace 分布（`ensembl_gene`/`geo_probe` 为主；0804 suppl 解析器已产出 `gene_symbol`）；优先本地映射（避免 mygene 在线依赖），定义多对一聚合策略；`main_data.csv` 增加 `gene_symbol` 列（0805 复核修正，REVIEW §9.6）

#### 1.5.4 Artifact 完整性

- [ ] **P1** `artifact_build` 按资产类型决定产出哪些 artifact
- [ ] **P1** 中间结果与最终结果使用独立的 run/version 标识

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

#### 1.5.8 0805 task_db204f6b 审查（REVIEW_2026-08-05-task-db204f6b）

> 0805 审查结论：probe→gene 映射、主产物体积治理、TCGA 引导、plan 超时自动批准
> 均已落地；剩余项为样本分组结构化。

- [ ] **P2** `sample_metadata` 结构化 tumor/normal 分组与配对 ID（REVIEW §2.4）

### 1.6 Agent 编排与 Pipeline 重跑闭环

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

### 2.2 Xena 403 修复

- [ ] **P1** 移除 `test_all_data_sources_live.py` 的 xfail

### 2.4 统一 SourceAsset 契约

- [ ] **P1** PDB / browser 下载路径走 `acquire_source()`（仍待办）
- [ ] **P1** 所有 acquisition skill 产出合规 `SourceAsset`

### 2.5 PubMed XML 注册为 SourceAsset + download_log 完整性

- [ ] **P1** `download_supplementary` 改为走 `acquire_source()`
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

### 4.4 结构化日志

- [ ] **P2** `main.py` 引入 structlog 或 python-json-logger
- [ ] **P2** 新增 `docs/observability.md`

### 4.5 Agent max_turns 后续

- [ ] **P2** INSTRUCTIONS 新增"达到 max_turns 后输出 `[MAX_TURNS_REACHED]`"指导

---

## 5. 工程基础设施（P1/P2）

### 5.2 并发与资源管理

- [ ] **P2** 监控并发 Chromium 实例数，超阈值时排队

### 5.3 配置硬编码治理

- [ ] **P2** `config.py` 扩展配置项（crawler_ua / rate_limit / stage_timeouts 等）
- [ ] **P2** 启动时校验 `DASHSCOPE_API_KEY` 非空
- [ ] **P2** `OUTPUT_DIR` 改为绝对路径默认值

---

## 6. 数据置信度与非 pipeline 数据准入（SURVEY_2026-08-05-data-confidence）

> 调研与设计见 `docs/SURVEY_2026-08-05-data-confidence.md`。§6.1 为先决条件；
> §6.2 依赖 §6.1，将 §1.5.5 / §1.4 / §2.4 中"Agent 数据入产物"相关 TODO
> 统一重构为"来源分级与准入"主线。

### 6.1 数据置信度（先决条件）

- [ ] **P1** `app/pipeline/processing/confidence.py` 确定性统计检测器：
      `benford_distance` / `last_digit_chi2` / `detect_constant_column` /
      `detect_arithmetic_progression` / `aggregate_confidence_metrics`
      （纯函数 + 单元测试，含 `is_benford_applicable` 前置判定防误报）
- [ ] **P1** processing 接入检测器：异常写 `anomaly_flags` + `warnings.csv`
      （code=`statistical_anomaly_*`）
- [ ] **P1** 产出 `confidence_report.csv` artifact（每数据集置信度画像
      `overall_score` 0-1）
- [ ] **P1** validation 增加 `data_confidence` 补充检查：低分 →
      `valid_with_warnings`（不阻断发布但强制显式标记）
- [ ] **P2** 前端 `ResultsViewer` 展示置信度画像

### 6.2 非 pipeline 数据进入最终成果（依赖 §6.1，需重新设计）

> 原则：**进入 `artifacts/` 的每条记录必须有 source-of-record**；非 pipeline
> 数据必须过置信度评估并携带 provenance 等级，防止 LLM 内容冒充产物的
> "伪成功通道"（agent.py 铁律 2 边界澄清）。

- [ ] **P1** `SourceRecord` / `SourceAsset` 契约扩展到 Agent 手动来源
      （强制 `source_id` = URL/DOI/文件路径 + 获取时间戳）
- [ ] **P1** 新增 `provenance_level`（`pipeline_validated` /
      `agent_research_annotated`）；validation gate 对 annotated 记录强制
      source_id 校验，缺失即拒绝
- [ ] **P1** 非 pipeline 数据产出 `confidence_report.csv` 条目（沿用 §6.1 Phase 2）
- [ ] **P2** Agent 决策日志持久化（`agent_results/`，吸收 §1.5.5 部分条目）
