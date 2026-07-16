# BioMed-QAgent 开发 TODO — 赛题提交版

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）重新生成。
> 目标：完成本 TODO 后可作为初步赛题成果提交。
> 上一版本归档于 git history（2026-07-17 之前）。

## 0. 赛题提交就绪度检查清单

### 0.1 最终提交材料（PROBLEM.md §五）

| 材料 | 状态 | 备注 |
|---|---|---|
| 可调用测试 API | ✅ 就绪 | 11 HTTP + 1 WS，含 health/databases/tasks CRUD/runs/messages/events/artifacts |
| 可交互前端页面 | ⚠️ 需补 | 任务创建/进度/结果/下载已就绪；缺赛题呈现区块（案例/字段说明/来源清单） |
| 代表性测试案例 | ❌ 缺失 | 后端有 GSE178352 fixture，但前端无专区展示，且用户输入被 pipeline 忽略 |
| 结构化输出样例 | ⚠️ partial | 14 个 artifact 结构完整；field_descriptions 是 placeholder |
| 技术报告 | ❌ 未生成 | 需撰写 ≤20 页 PPT/PDF |
| 完整源码 | ✅ 就绪 | 已有完整 backend + frontend |
| 演示视频（非必选） | ❌ 未录制 | ≤10 分钟，加分项 |

### 0.2 初赛评价四维度（PROBLEM.md §四）

| 维度 | 现状 | 阻塞项 |
|---|---|---|
| 数据查找完备性 | ⚠️ | pipeline 硬编码 GSE178352，无视用户 topic；前端只允许选 pubmed+geo |
| 来源可追溯性 | ✅ | SourceRecord/SourceAsset/DownloadAttempt/SourceLocator 完整 |
| 清洗整合可靠性 | ⚠️ | cleaning.py/alignment.py 已实现但未接入确定性 pipeline |
| 输出格式可用性 | ⚠️ | 14 个 artifact 结构完整；field_descriptions 是 placeholder |

### 0.3 七项核心能力（PROBLEM.md §三-A）

| 能力 | 现状 |
|---|---|
| 1. 数据查找 | 5 个真实数据库接入（GEO/GDC/PDB/PubChem/Reactome），但 pipeline 硬编码 |
| 2. 数据解析 | PDF 表格、GEO/PDB/Excel 解析真实；无 OCR |
| 3. 数据清洗 | cleaning.py 真实但未接入 pipeline |
| 4. 字段对齐 | alignment.py 真实但未接入 pipeline |
| 5. 来源标注 | source_list.csv/source_assets.csv/download_log.csv 完整 |
| 6. 结构化输出 | 14 个 CSV artifact 结构完整 |
| 7. 图表数据处理 | ❌ 未实现（仅提取 caption 文本） |

### 0.4 加分项（PROBLEM.md §三-A）

| 加分项 | 现状 |
|---|---|
| 自动识别缺失数据 | ✅ cleaning.py 实现，未接入 pipeline |
| 自动识别重复数据 | ✅ cleaning.py 实现，未接入 pipeline |
| 自动识别单位不一致 | ❌ 完全未实现 |
| 图表坐标轴/图例解析 | ❌ 完全未实现 |
| 修正能力（人在回路） | ⚠️ 仅标记不闭环 |

---

## 1. P0：核心真实性修复（让 pipeline 真正按用户输入工作）

> **背景**：当前 `_build_specification_for_plan`（runner.py:737-781）完全硬编码
> GSE178352 + PMID 34180400，`source_id="src_placeholder"` 是显式占位符。
> discovery/acquisition/processing 阶段均硬编码常量，无视用户 topic。
> 这是赛题"数据查找完备性"维度的根本性阻塞。

### 1.1 解除 pipeline 硬编码

- [ ] **P0** 让 `run_research_pipeline` Function Tool 从 Agent 接收 `TaskSpecification`
      （含用户 topic 驱动的 query / dataset 选择），而不是无视 Agent 决策
      （`backend/app/pipeline/tool.py`）
- [ ] **P0** 修复 `_build_specification_for_plan` 硬编码
      （`backend/app/pipeline/runner.py:737-781`，`source_id="src_placeholder"`）
- [ ] **P0** 修复 discovery 阶段 `_PMID = "34180400"` / `_GSE = "GSE178352"` 硬编码
      （`backend/app/pipeline/stages/discovery.py:22-23`）
      —— 阶段应从 `TaskSpecification.queries` / `datasets` 读取目标
- [ ] **P0** 修复 acquisition 阶段 `_DOWNLOAD_URL` 硬编码
      （`backend/app/pipeline/stages/acquisition.py:30-34`）
- [ ] **P0** 修复 processing 阶段 live 模式仍读 fixture SOFT
      （`backend/app/pipeline/stages/processing.py:28,32`）
      —— live 模式应使用 acquisition 阶段下载的真实 SOFT
- [ ] **P0** 修复 `parse_geo_soft_samples` 的 `len(samples) != 12` 硬校验
      （`backend/app/pipeline/processing/geo_tximport.py:63`）
      —— 应泛化为从 SOFT 动态读取样本数
- [ ] **P0** 修复 `staging_run("run_pinned_fixture")` 硬编码标识符
      （`backend/app/pipeline/stages/artifact_build.py:102`）

### 1.2 修复 field_descriptions placeholder

> **背景**：当前 `description = field.replace("_", " ")`（artifact_build.py:172），
> 例如 `gene_id_namespace` 的描述就是 `"gene id namespace"`。
> 这是赛题"结构化输出样例：字段说明"的直接评分点。

- [ ] **P0** 为所有字段编写真实语义说明
      （`backend/app/pipeline/stages/artifact_build.py:168-179`）
      —— 至少覆盖：record_id / dataset_id / source_id / asset_id / gene_id /
      gene_id_namespace / sample_id / expression_value / source_line_number /
      source_column_index / source_raw_value / source_logical_file
- [ ] **P0** 提供字段 `example` 值（当前恒为空字符串）
- [ ] **P0** 完善 `unit` 字段（除 expression_value 的 "estimated_count" 外）

### 1.3 修复 source_relations 硬编码

- [ ] **P0** 让 `relation_id` 从 discovery 阶段动态派生
      （当前硬编码 `"rel_pmid34180400_gse178352"`，`artifact_build.py`）
- [ ] **P0** 让 `processing_log.rows_before` 从真实解析结果统计
      （当前硬编码 `4`）

### 1.4 解除数据库选择硬编码

- [ ] **P0** 修复 `routes.py:157` 的 `skill.name in {"pubmed", "geo"}` 限制
      —— 应展示所有已注册的真实数据库 skill（GEO/GDC/PDB/PubChem/Reactome/Xena）

### 1.5 PubMed download_supplementary 合规化

> **背景**：`download_supplementary` 绕过统一 `NcbiEutilsClient`，直接用
> Biopython Entrez + urllib，无重试/无限速/无 api_key。

- [ ] **P0** 改造 `download_supplementary` 复用 `NcbiEutilsClient`
      （`backend/app/skills/builtin/discovery/pubmed.py:283-433`）
      —— 将 `Entrez.efetch` 替换为 `services.eutils.efetch`
      —— 将 PMC HTML/文件下载改为 `httpx.AsyncClient` + 限速/重试
- [ ] **P0** 补全 Biopython Entrez 的 `tool` / `api_key` 参数
      （若保留 Biopython 调用）
- [ ] **P0** 删除 `pubmed.py:35-115` 的 dead code `_parse_pubmed_record`

### 1.6 配置完整性

- [ ] **P0** 补充 `.env.example` 的 NCBI 配置项
      （`NCBI_EMAIL` / `NCBI_TOOL` / `NCBI_API_KEY` / `NCBI_USER_AGENT`）

---

## 2. P0：赛题核心能力补全（清洗整合可靠性）

> **背景**：`cleaning.py` 与 `alignment.py` 已是真实实现，但
> `pipeline/stages/processing.py` 仅 36 行，只调用 `process_geo_tximport_counts`，
> 完全未调用 cleaning/alignment。确定性 pipeline 产出的 `parsed/` 数据
> 未经过任何缺失/重复/类型检查。

### 2.1 清洗能力接入确定性 pipeline

- [ ] **P0** 在 `pipeline/stages/processing.py` 中调用 `cleaning.clean_dataset`
      —— 对 `ParsedDataset` 产出 `CleaningReport`
- [ ] **P0** 生成 `cleaning_report.csv` artifact
- [ ] **P0** 将 `CleaningReport.anomaly_flags` 写入 `warnings.csv`
- [ ] **P0** 更新 `validation.py` 增加 cleaning_report 完整性校验

### 2.2 字段对齐能力接入

- [ ] **P0** 在 pipeline 中调用 `alignment.align_fields`（多源数据合并时）
- [ ] **P0** 在 pipeline 中调用 `alignment.merge_datasets`（多源数据合并）
- [ ] **P0** 生成 `field_mapping.csv` 的真实映射关系（当前部分硬编码）

### 2.3 清洗测试

- [ ] **P0** 新增 `tests/pipeline/test_processing_cleaning.py`
      —— 验证缺失/重复/类型异常被正确标记到 warnings.csv

---

## 3. P1：多源数据完备性

> **背景**：5 个真实数据库已接入（GEO/GDC/PDB/PubChem/Reactome），但
> GDC/PDB/Xena 绕过 `crawler.py`（违反 project_memory L11 硬约束），
> PubChem/Reactome 缺 download 工具，
> 只有 GEO 走 `acquire_source()` 产出合规 `SourceAsset`。

### 3.1 Acquisition skills 合规化

- [ ] **P1** GDC skill 接入 `crawler.py`
      —— 将 `urllib.request.urlopen` 替换为 `api_fetch` / `httpx_fetch`
      —— 获得 2s 限速 + BROWSER_UA + Referer
      （`backend/app/skills/builtin/acquisition/gdc.py`）
- [ ] **P1** PDB skill 接入 `crawler.py`
      （`backend/app/skills/builtin/acquisition/pdb.py`）
- [ ] **P1** Xena skill 接入 `crawler.py` + 改用 `BROWSER_UA`
      —— 删除 `_USER_AGENT = "BioMed-QAgent/0.1"`
      （`backend/app/skills/builtin/acquisition/xena.py`）

### 3.2 Xena 403 修复

- [ ] **P1** Xena 403 修复：切换 download host 到 `toil.xenabrowser.net`
      或加 browser fallback
- [ ] **P1** 更新 `integrations/acquisition.py:_ALLOWED_HOSTS` 域名白名单
- [ ] **P1** 更新 `test_skill_xena.py` 的 URL 硬断言
- [ ] **P1** 移除 `test_all_data_sources_live.py:200-208` 的 xfail

### 3.3 补全 download 工具

- [ ] **P1** PubChem 增加 `download_pubchem`（SDF/MOL 下载）
      —— 调用 PUG-REST `/compound/cid/{cid}/record/SDF?format=sdf`
      —— 走 `acquire_source()` 产出 `SourceAsset`
- [ ] **P1** Reactome 增加 `download_reactome`（participants TSV / SBGN 图）
      —— 走 `acquire_source()` 产出 `SourceAsset`

### 3.4 统一 SourceAsset 契约

- [ ] **P1** GDC/PDB/Xena/browser 下载路径走 `acquire_source()`
      —— 当前只有 GEO 走完整 verified streaming + sha256 + 原子发布 + 缓存
      —— 其他 skill 只产 `SourceRecord`，不产 `SourceAsset`
- [ ] **P1** 所有 acquisition skill 产出合规 `SourceAsset`

### 3.5 删除旧 SourceRecord dataclass（原 TODO §4.1）

> **背景**：实际阻塞面远小于原 TODO §4.4 表格暗示——Pipeline 和所有
> acquisition/discovery skill 已完全用新契约，真正需改动的只有 5 个文件。

- [ ] **P1** 迁移 `tools/export.py` 到新契约
      —— `export_source_list_csv` 当前访问 `s.local_files / s.checksum /
      s.mime_type / s.format_hint / s.warnings`，这些字段在新 SourceRecord 不存在
- [ ] **P1** 迁移或删除 `scripts/demo_workflow.py` 的 mock pipeline
      —— 3 处 `SourceRecord(...)` 实例化使用旧字段
- [ ] **P1** 删除 `app/domain/output.py` 的旧 `SourceRecord` dataclass
- [ ] **P1** 清理 `app/domain/__init__.py` 顶层导出
- [ ] **P1** 同步更新 `tests/test_output.py`

---

## 4. P1：前端赛题呈现

> **背景**：前端任务创建/进度/结果/下载已就绪，但缺赛题明确要求的
> "代表性测试案例"与"结构化输出样例（字段说明 + 来源清单）"专门视图。

### 4.1 代表性测试案例展示

- [ ] **P1** 新增"代表性测试案例"专区（setup Tab 或独立 Tab）
      —— 展示 1-2 个预设案例（输入文本 + 预期输出 artifacts 预览）
      —— 至少覆盖：GSE178352 乳腺癌 Hsp70 抑制案例
- [ ] **P1** fixture 模式在 UI 上明确标注为"离线 demo"
      —— 当前"运行固定验收案例"按钮未说明这是离线固定数据

### 4.2 字段说明与来源清单视图

- [ ] **P1** ResultsViewer 增加 `field_descriptions.csv` 专门视图
      —— 渲染为表格：field_name / data_type / description / unit / nullable / example
- [ ] **P1** ResultsViewer 增加 `source_list.csv` / `source_relations.csv` 专门视图
      —— 渲染来源清单与来源关系图
- [ ] **P1** ResultsViewer 用 Tabs 分离主数据/来源/处理/警告
      —— 14 个 artifact 当前平铺为列表，用户难以定位
      —— shadcn/ui Tabs 组件已存在于 `frontend/src/components/ui/tabs.tsx`
      —— 分类：主数据(main_data/literature/dataset_catalog/sample_metadata) /
      来源(source_list/source_relations/source_assets/download_log) /
      处理(field_descriptions/field_mapping/processing_log) /
      警告(warnings/quality_report)

### 4.3 计划确认 Card/Dialog（原 TODO §12）

> **背景**：后端 `plan_ready` 事件已发但 Pipeline 无暂停语义，
> 前端 reducer 静默丢弃。需先落架构设计 spec。

- [ ] **P1** 后端引入 `plan_pending` 运行状态（Run 生命周期子态）
- [ ] **P1** 新增 `POST /api/v1/tasks/{task_id}/plan/confirm` API
- [ ] **P1** PipelineRunner 在 `PlanReadyPayload` 后等待确认信号
- [ ] **P1** 前端 `reducer.ts` 接入 `plan_ready` 事件
- [ ] **P1** 新增 `PlanConfirmCard` 组件（复用 shadcn Dialog）
- [ ] **P1** fixture 模式可豁免确认（spec 是 pinned）

---

## 5. P2：赛题加分项

> **背景**：PROBLEM.md §三-A 加分项，当前 2 项已实现未接入、3 项完全缺失。

### 5.1 单位不一致检测

- [ ] **P2** `cleaning.py` 新增 `detect_unit_inconsistencies(datasets, field_mapping)`
      —— 对 `alignment.align_fields` 输出的同名跨数据集字段，
      检查 `FieldDescription.unit` 是否一致
- [ ] **P2** 将单位冲突写入 `warnings.csv`
      —— 如 "字段 'expression_value' 在 GEO 与 PubMed 中单位分别为
      estimated_count 与 log2_ratio"

### 5.2 图表数据提取（高加分项）

- [ ] **P2** 新增 `extract_chart_data` 工具
      —— 依赖 `pdf2image` + `opencv` + `pytesseract`
- [ ] **P2** 检测坐标轴与刻度
- [ ] **P2** 折线图/柱状图数据点采样 + 坐标反变换
- [ ] **P2** MVP 版本：仅折线图、固定坐标系

### 5.3 OCR 能力

- [ ] **P2** `extract_tables.py` 增加 `ocr_fallback` 第四级后端
      —— 当 pdfplumber 与 PyPDF2 均未提取到表格时调用
- [ ] **P2** `pytesseract` 集成（作为可选依赖）
      —— `pyproject.toml` 的 `[project.optional-dependencies]` 加 `ocr`
- [ ] **P2** 中文支持 `lang='chi_sim+eng'`

### 5.4 人在回路修正闭环

- [ ] **P2** 新增 `request_human_correction` function_tool
      —— 将 `CleaningReport` 异常条目推送给前端
- [ ] **P2** 前端 corrections UI（复用 shadcn Dialog）
- [ ] **P2** WebSocket 推送修正请求 + 接收修正指令
- [ ] **P2** 退化为批处理模式：生成 `corrections_todo.csv` 供人工离线修正

### 5.5 DE 分析 FDR 校正

- [ ] **P2** `stats.py:run_differential_expression` 增加 BH FDR 校正
      —— `statsmodels.stats.multitest.multipletests`
- [ ] **P2** 火山图增加 `padj` 阈值线
- [ ] **P2** 输出 `padj` 字段

### 5.6 extract_tables 测试覆盖

- [ ] **P2** `tests/test_skill_extract_tables.py` 增加真实 pdfplumber 路径测试
      —— 当前全部 mock `_extract_raw_tables`
- [ ] **P2** 在 `tests/fixtures/` 放置最小真实 PDF（1 页 1 表）

---

## 6. P2：技术报告与演示

### 6.1 技术报告（必选）

- [ ] **P2** 撰写 `docs/TECHNICAL_REPORT.md`（≤20 页 PPT/PDF 源）
      —— 包含：架构图、数据流、案例演示、字段说明、来源追溯、清洗逻辑
- [ ] **P2** 导出为 PDF
- [ ] **P2** 包含代表性测试案例的输入/输出对照截图

### 6.2 演示视频（非必选，加分）

- [ ] **P2** 录制 ≤10 分钟演示视频
      —— 覆盖：任务创建 → 进度 → 结果 → 字段说明 → 来源清单 → 下载 全流程
- [ ] **P2** 至少演示 2 个案例（GSE178352 + 另一主题）

---

## 7. 已批准架构决策（保留自原 TODO §2）

- [x] **P0** 保留 OpenAI Agents SDK 作为 Agent Runtime
- [x] **P0** 保留一个 Main Agent 和按需 Skill 加载
- [x] **P0** 保留 builtin/learned 统一 Skill 仓库
- [x] **P0** Skill 按 discovery、acquisition、processing、analysis 分类
- [x] **P0** 一个网站对应多个 Tool，不强制一个网站一个 Skill
- [x] **P0** 下载与解析严格分离
- [x] **P0** 新增确定性 Pipeline Runner
- [x] **P0** Agent 只生成 TaskSpecification，不直接拼装产物
- [x] **P0** 产物必须通过 Validation Gate 才能进入 artifacts/
- [x] **P0** 固定真实案例采用 GSE178352 + PMID 34180400
- [x] **P0** 默认 CI 使用真实数据 fixture，live 测试下载完整官方文件
- [x] **P1** 后端契约稳定后使用 shadcn 重写前端任务工作台

---

## 8. 归档：Phase 1 已完成项

> 以下项已在 2026-07-13 至 2026-07-17 期间完成，保留作为历史归档。
> 完整验收证据见 git history 与 `docs/ARCHITECTURE.md`。

### 8.1 契约与目录（原 §4）

- [x] 定义全部领域契约（TaskRequest/TaskSpecification/QuerySpecification/
      DatasetSelection/SourceRecord/SourceRelation/DownloadAttempt/
      FileAsset/SourceAsset/DataLevel/SourceLocator/ParsedDataset/
      StageAttempt/ArtifactManifestEntry/RunManifest/Warning/Error）
- [x] 统一工作目录 `data/output/tasks/<task_id>/`
- [x] 任务级锁 + SHA-256 内容寻址 blob cache
- [x] TDD 验收覆盖空 topic、非法 task_id、未知字段、路径逃逸

### 8.2 固定真实数据（原 §5）

- [x] GSE178352 fixture（含官方 URL、SHA-256、提取命令）
- [x] PubMed PMID 34180400 真实响应 fixture
- [x] GEO GSE178352 真实元数据 fixture
- [x] PubMed skill 真实接入 NCBI E-utilities（3/10 req/s 限速 + 429/5xx 重试）
- [x] GEO skill 真实接入 E-utilities + ftp 下载

### 8.3 Processing（原 §6）

- [x] Counts Parser（gzipped TSV → 长格式 CSV，含 SourceLocator）
- [x] 标准化（gene + sample 粒度，稳定 record_id）
- [x] 清洗与字段映射（cleaning.py/alignment.py 真实实现）

### 8.4 Artifact Builder（原 §7）

- [x] 生成 14 个必需 CSV artifact
- [x] 所有 Artifact 记录大小与 SHA-256
- [x] Artifact 输出顺序稳定

### 8.5 Validation Gate（原 §8）

- [x] 6 项校验（foreign_keys/sample_foreign_keys/source_asset_integrity/
      field_descriptions/source_value_lineage/warnings_metrics_consistency）
- [x] 原子发布（TaskLock + fsync + rename + publish_completed.json marker）

### 8.6 Pipeline Runner（原 §9）

- [x] 固定阶段状态机与 append-only StageAttempt
- [x] 阶段操作幂等，重试生成新 attempt
- [x] 进程重启后从最近成功阶段恢复
- [x] 网络、模型、解析和完整任务独立超时
- [x] 支持 fixture/live/mock 模式

### 8.7 测试（原 §10）

- [x] 默认 pytest 无真实 Key 通过（770 passed, 2026-07-17）
- [x] Live 测试覆盖 PubMed + GEO + 完整 counts 校验
- [x] 前端 Vitest + TypeScript + ESLint + build 门禁（145 passed）

### 8.8 Agent 与 API（原 §11）

- [x] Pipeline 暴露为单一 SDK Function Tool
- [x] 数据库过滤不加载未选择 acquisition Tool
- [x] TaskRequest API 校验
- [x] Artifact API 只列出 manifest 中已验证文件
- [x] 统一 WebSocket event envelope
- [x] 事件先持久化再推送，支持按 sequence 续读

### 8.9 前端（原 §12）

- [x] shadcn Form 创建任务
- [x] 阶段 Timeline/Progress
- [x] 使用 Table 展示紧凑预览
- [x] Artifact 下载列表
- [x] 单一 task/event client
- [x] 自动重连和任务恢复
- [x] 真实浏览器覆盖 fixture 创建、执行、结果展示和下载流程

### 8.10 Review 修复（2026-07-17）

- [x] 修复 live 模式 artifact_build source_path 硬编码 bug
- [x] 修复 summarizer 静默 fallback 违反硬约束
- [x] compaction 增加 logger 可观测性
- [x] launcher 移除类型抑制
- [x] 前端 fileUtils 共享模块消除 DRY 违反
- [x] 前端接入 WS error 帧 toast
- [x] 删除前端死代码
- [x] 修复 AGENTS.md subscribe 命令文档漂移
