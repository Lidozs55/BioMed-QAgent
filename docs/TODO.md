# BioMed-QAgent 开发 TODO

> 基于 PROBLEM.md 赛题要求（XH-202619 赛道二方向1 选题A）重新生成。
> 目标：完成本 TODO 后可作为初步赛题成果提交。
> 上一版本归档于 git history（2026-07-17 之前）。

## 1. P0：核心真实性修复（让 pipeline 真正按用户输入工作）

> **背景**：当前 `_build_specification_for_plan`（runner.py:737-781）完全硬编码
> GSE178352 + PMID 34180400，`source_id="src_placeholder"` 是显式占位符。
> discovery/acquisition/processing 阶段均硬编码常量，无视用户 topic。
> 此外 `pipeline/tool.py:30` 对 `databases == {"pubmed","geo"}` 做二次硬编码校验，
> 即使 routes.py 解除限制，Agent 传 `[gdc, pdb]` 仍被拒绝。
> 这是赛题"数据查找完备性"维度的根本性阻塞。

### 1.1 解除 pipeline 硬编码

- [ ] **P0** 让 `run_research_pipeline` Function Tool 从 Agent 接收 `TaskSpecification`

      （含用户 topic 驱动的 query / dataset 选择），而不是无视 Agent 决策
      （`backend/app/pipeline/tool.py`）
      —— 同时移除 `tool.py:29-31` 的 `databases == {"pubmed","geo"}` 二次硬编码校验

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

- [ ] **P0** 修复 `data_type` 全部硬编码为 `"string"`（artifact_build.py:171）

### 1.3 修复 source_relations / processing_log 硬编码

- [ ] **P0** 让 `relation_id` 从 discovery 阶段动态派生

      （当前硬编码 `"rel_pmid34180400_gse178352"`，`artifact_build.py`）

- [ ] **P0** 让 `source_relations.csv` 包含多条关系

      （当前仅单条硬编码关系，无法体现多源数据整合）

- [ ] **P0** 让 `processing_log.rows_before` 从真实解析结果统计

      （当前硬编码 `4`）

- [ ] **P0** 修复 `processing_log` 的 `output_refs` 与 `input_refs` 相同错误

      （`artifact_build.py:238-239`）—— output_refs 应指向产出 artifact，input_refs 指向源数据

- [ ] **P0** 修复 `processing_log.parameters` 硬编码 `{"measurement": "counts"}`

      （`artifact_build.py:243`）—— 应从解析结果动态填充

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

- [ ] **P0** 补全 `pyproject.toml` 运行时依赖

      —— 缺 `pdfplumber` / `PyPDF2` / `openpyxl`（当前 `uv sync` 后 ImportError）
      —— 新增 `[project.optional-dependencies]` 分区：`ocr`（pytesseract）/ `chart`（pdf2image+opencv）
      —— 修正 `description` 模板默认值
      —— 同步 `requirements.txt`（当前仅 6 个依赖，与 pyproject.toml 严重不一致）

### 1.7 P0：产物元数据与可观测性

> **背景**：第二轮审查发现 14 个 CSV 缺 UTF-8 BOM（Excel 中文乱码），
> `run_manifest.json` 的 `model_name=None` 破坏复现性，
> `warnings.csv` 恒为空（cell-line 修正未记入），
> Pipeline 全链路零结构化日志，`MetricsTracker` 已实现但未接入。

- [ ] **P0** 所有 CSV 写入改用 `utf-8-sig`（带 BOM）

      （`artifact_build.py:77` / `validation.py:43` 等共 14 处）

- [ ] **P0** 修复 `run_manifest.json` 的 `model_name=None`

      （`validation.py:342`）—— 应从 ctx 或环境变量读取实际 Qwen 模型名

- [ ] **P0** 修复 `warnings.csv` 恒空，cell-line 修正未记入

      （`processing/geo_tximport.py:34-37,81-83`）—— 将 MD-MBA-231 → MDA-MB-231 修正写入 warnings

- [ ] **P0** 修复 `artifact_build.py:78` 的 `extrasaction="ignore"` 静默丢字段

      —— 应在写入前断言所有 row 字段都在 fieldnames 中

- [ ] **P0** Pipeline 全链路接入结构化日志

      （`logging.getLogger("app.pipeline")` + JSON handler）
      —— 至少覆盖 stage_started / stage_completed / artifact_produced / validation_failed

- [ ] **P0** `MetricsTracker` 接入 Pipeline（已实现但未调用）

      （`backend/app/core/metrics.py`）—— 在 PipelineRunner 中初始化并随 stage 更新

### 1.8 P0：query_log 状态枚举统一

> **背景**：8 个 skill 用 6 种同义词表示同一状态
> （`completed` / `succeeded` / `ok` / `failed` / `error` / `not_found`），
> 评委审计 query_log 时难以聚合统计。

- [ ] **P0** 定义 `QueryStatus` 枚举（`app/domain/contracts.py`）

      —— `success` / `not_found` / `failed` / `skipped` 四态

- [ ] **P0** 8 个 skill 统一使用 `QueryStatus` 枚举

      （discovery/pubmed, acquisition/{geo,gdc,pdb,pubchem,reactome,xena}）

- [ ] **P0** 新增 `tests/test_query_log_status_consistency.py`

      —— 遍历所有 skill 的 query_log 输出，断言 status ∈ QueryStatus

### 1.9 P0：工程基础修复（文档/源码一致性）

> **背景**：第二轮审查发现 backend/README、frontend/README、ARCHITECTURE.md
> 与实际代码严重漂移；`backend/data/.gitignore` 排除所有 artifact 样例，
> 评委克隆仓库后无法直接查看任何产物；Agent INSTRUCTIONS 缺"主题→数据库"决策表。

- [ ] **P0** 同步 `backend/README.md`

      —— 修正：测试文件数（12→50+）、API 端点数（5→11）、项目结构、Skill 数量

- [ ] **P0** 同步 `frontend/README.md`

      —— 修正：shadcn 组件清单（26→31）、测试覆盖（1→13）、新增 `runtime/` 目录说明

- [ ] **P0** 修复 `docs/ARCHITECTURE.md` §8 与 §12 自相矛盾

      —— §8 说 WebSocket "暂时保留旧流式事件，不能宣称已完成"
      —— §12 说 "统一 WebSocket event envelope 已完成" —— 二者冲突
      —— §12 日期 2026-07-13 过时，"235 passed" 是旧值（当前 770）

- [ ] **P0** 提交 1-2 个 artifact 样例到版本控制

      —— 修改 `backend/data/.gitignore`（当前 `*\n!.gitignore` 全部排除）
      —— 至少提交 GSE178352 fixture 的一次完整 artifacts/ 输出样例到 `backend/data/examples/`
      —— 让评委克隆仓库即可查看真实产物

- [ ] **P0** 完善 `agent_loop/agent.py` 的 INSTRUCTIONS

      （`backend/app/agent_loop/agent.py:24-63`）
      —— 新增"主题→数据库"决策表（如：癌症表达谱→GEO+PubMed；蛋白结构→PDB；通路→Reactome）
      —— 新增"找不到数据"处理策略（标记 not_found，不重试，进 warnings）
      —— 新增 fixture vs live 模式选择指导（fixture 用于 demo，live 用于真实查询）

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
> PubMed XML 全文虽由 EUtils 取回，但未注册为 `SourceAsset`，破坏来源可追溯性。

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

### 3.5 PubMed XML 注册为 SourceAsset + download_log 完整性

> **背景**：第二轮审查发现 PubMed download_supplementary 取回 XML 全文，
> 但未走 `acquire_source()`，未产 `SourceAsset`；
> `integrations/acquisition.py` 的 `acquire_source` 仅返回最终一次 `DownloadAttempt`，
> 中间失败 attempt 不可见，破坏"来源可追溯性"评分。

- [ ] **P1** PubMed XML 全文注册为 `SourceAsset`

      —— `download_supplementary` 改为走 `acquire_source()` 产出 `SourceAsset`

- [ ] **P1** `acquire_source` 返回所有 attempt（含失败）

      （`backend/app/integrations/acquisition.py:288-299`）—— 当前只返回最终一次

- [ ] **P1** `download_log.csv` 记录失败 attempt 与 reason

      —— 评委可看到"曾尝试 URL-A 失败 → 回退 URL-B 成功"完整链路

- [ ] **P1** 大文件下载增加进度事件

      （`integrations/acquisition.py`）—— 当前 >100MB 文件下载无 progress 事件，前端无反馈

### 3.6 删除旧 SourceRecord dataclass

> **背景**：Pipeline 和所有 acquisition/discovery skill 已完全用新契约，真正需改动的只有 5 个文件。

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
> "结构化输出样例（字段说明 + 来源清单）"专门视图。

### 4.1 字段说明与来源清单视图

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

### 4.2 人在回路暂停-恢复（计划确认 + 数据修正统一架构）

> **背景**：原 §4.2 计划确认 与原 §5.4 人在回路修正闭环 本质是同一架构模式：
> Pipeline 运行到某点 → 发射"请求用户输入"事件 → 前端展示 Dialog →
> 用户提交决策 → Pipeline 恢复执行。两者必须共享同一底层原语，而非各自独立实现。
>
> **现状**（2026-07-17 review）：
> - `PlanReadyPayload` 已存在但是"发射即继续"，无暂停语义
>   ([runner.py:289](backend/app/pipeline/runner.py#L289))
> - 前端 `reducer.ts` 的 `reduceRuntimeEvent` switch 完全没有 `plan_ready` /
>   `task_created` / `task_recovered` case，被 `default: break` 静默丢弃
>   ([reducer.ts:450-796](frontend/src/runtime/reducer.ts#L450))
> - 运行时无 `awaiting_user_input` 子状态、无 resume API、无统一前端 Dialog
> - `RunStatus` 状态机无 pause-resume 转换
>   ([state.py:37-59](backend/app/runtime/state.py#L37))
>
> **统一架构原则**：4.2.1 共享底层必须先于 4.2.2 / 4.2.3 完成，避免两个实例
> 各自实现一套 pause-resume 机制造成不可复用。

#### 4.2.1 共享底层架构（P1，必须先于 4.2.2/4.2.3 完成）

- [x] **P1** 新增 `RunStatus.AWAITING_USER_INPUT` 运行子状态

      （`backend/app/domain/contracts/runtime.py` + `app/runtime/state.py`）
      —— 合法转换：`RUNNING → AWAITING_USER_INPUT → RUNNING | CANCEL_REQUESTED | FAILED`
      —— `TaskManager` 暂停 Run worker（不释放 semaphore slot，避免被新任务抢占）

- [x] **P1** 新增统一 `UserInputRequiredPayload` 事件

      （`backend/app/domain/contracts/events.py`）
      —— 字段：`request_id` / `prompt_kind`（判别联合：`plan_confirmation` | `data_correction`）/
      `summary` / `expires_at` / `fixture_exempt`
      —— 将 `PlanReadyPayload` 重构为 `UserInputRequiredPayload` 的
      `prompt_kind="plan_confirmation"` 子类型的别名（保持向后兼容）

- [x] **P1** PipelineRunner 新增 `_await_user_input(request)` 暂停原语

      （`backend/app/pipeline/runner.py`）
      —— 发射事件 → 设置 Run 为 AWAITING_USER_INPUT → 阻塞 `asyncio.Event`
      —— fixture 模式自动批准（`fixture_exempt=True`，仅发射事件不阻塞）
      —— 超时后转 FAILED（与 stage timeout 一致）

- [x] **P1** 新增 `POST /api/v1/tasks/{task_id}/runs/{run_id}/resume` API

      （`backend/app/api/routes.py`）
      —— Body：`{request_id, decision: "approve"|"reject", payload?: object}`
      —— 校验 `request_id` 匹配当前等待中的请求
      —— 触发 Run 恢复，将 decision 传给 `_await_user_input`

- [x] **P1** 前端 `reducer.ts` 接入 `user_input_required` / `plan_ready` /
      `task_created` / `task_recovered`

      （`frontend/src/runtime/reducer.ts` + `contracts.ts`）
      —— 当前上述事件被 `default: break` 静默丢弃
      —— 新增 `TaskProjection.pendingUserInput: UserInputRequest | null`
      —— 在 `RunStatus` 类型增加 `"awaiting_user_input"`

- [x] **P1** 新增统一 `UserInputDialog` 组件（复用 shadcn Dialog）

      （`frontend/src/components/UserInputDialog.tsx`）
      —— 由 `prompt_kind` 判别渲染不同表单（plan / corrections）
      —— 提交时调用 `POST /runs/{run_id}/resume`

- [x] **P1** AGENTS.md §2 HTTP 路由表补充 `/resume` 端点
  （保持文档与代码同步）

#### 4.2.2 实例 A：计划确认（原 §4.2）

- [x] **P1** PipelineRunner 在 `PlanReadyPayload` 后调用 `_await_user_input`

      —— fixture 模式豁免（`fixture_exempt=True`，自动批准）
      —— agent 模式真正阻塞，等待 `POST /resume`

- [x] **P1** `PlanConfirmCard` 视图作为 `UserInputDialog` 的
      `prompt_kind="plan_confirmation"` 渲染

      —— 展示 `TaskSpecification` 摘要（queries / datasets / requested_outputs）

#### 4.2.3 实例 B：数据修正闭环（原 §5.4）

> **依赖**：需先完成 TODO §2.1（cleaning.py 接入 pipeline + 迁移到
> `contracts.ParsedDataset`，详见 §2.1 中关于类型不一致的说明）

- [ ] **P2** 新增 `request_human_correction` function_tool

      —— 将 `CleaningReport.anomaly_flags` 包装为
      `UserInputRequiredPayload(prompt_kind="data_correction")`
      —— 走 `_await_user_input` 暂停原语，复用 §4.2.1 底层

- [ ] **P2** `CorrectionsDialog` 视图作为 `UserInputDialog` 的
      `prompt_kind="data_correction"` 渲染

      —— 展示异常条目表格 + 修正输入

- [ ] **P2** 退化为批处理模式：生成 `corrections_todo.csv` 供人工离线修正

      —— 当 `awaiting_user_input` 超时或用户选择"延迟修正"时走此路径

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

### 5.2 图表数据提取（视觉模型降级方案）

> **背景**：原方案依赖 `pdf2image + opencv + pytesseract` 传统 CV，
> 实现复杂且对论文图表（矢量图、多子图、对数轴）识别率低。
> 改为采用 **Qwen-VL 视觉模型降级**方案：项目已用 DashScope，
> 只需新增 `model_name="qwen-vl-max"` 第二个模型实例。
> v0 已有可参考实现：`scripts/viz/extract_chart_data.py`
> （base64 编码 + Qwen-VL API + 严格 JSON 提示词，见 `docs/legacy_skill_reference.md:74,217`）。
>
> **降级链**：Qwen-VL（主）→ pdfplumber 表格 OCR（次）→ 仅保留 caption 文本（兜底）。
> **原始图片数据保留**：所有提取过的图表图片必须保存到 `source_assets/figures/`，
> 作为复现/审计依据，并写入 `source_assets.csv`。

- [ ] **P1** 新增 `extract_chart_data_vlm` 工具

      —— 输入：PDF 中的图片（pdfplumber.page.images 提取）或独立图片文件
      —— 调用 DashScope `qwen-vl-max`（OpenAI 兼容端点）
      —— 提示词要求严格 JSON 输出：`{chart_type, axes:{x:{label,unit,scale},y:{...}}, data_points:[{x,y,label}], legend:[...]}`
      —— 参考 `docs/legacy_skill_reference.md` §21 的 base64 编码方式

- [ ] **P1** 保留原始图片数据到 `source_assets/figures/`

      —— 图片命名：`fig_<sha256[:12]>.<ext>`
      —— 走 `acquire_source()` 注册为 `SourceAsset`（mime_type=image/png 或 image/jpeg）
      —— 在 `source_assets.csv` 中标注 `asset_type=figure`
      —— 在 `download_log.csv` 记录提取来源（PDF 页码 / 源 URL）

- [ ] **P1** 新增 `chart_data.csv` artifact

      —— 列：chart_id / source_asset_id / chart_type / x_label / x_unit / x_scale /
      y_label / y_unit / y_scale / data_point_count / extracted_at / model_name

- [ ] **P1** 新增 `chart_data_points.csv` artifact

      —— 列：point_id / chart_id / x_value / y_value / series_label / confidence

- [ ] **P2** 三级降级链实现

      —— L1: Qwen-VL（主路径，要求 DASHSCOPE_API_KEY 可用）
      —— L2: pdfplumber 表格 OCR（无 VL 模型时降级，仅提取表格非图表）
      —— L3: 仅保留 caption 文本（兜底，写入 warnings.csv 标记 `chart_unextracted`）

- [ ] **P2** 降级时在 `warnings.csv` 标记降级原因

      —— 如 `model_unavailable` / `image_corrupted` / `unsupported_chart_type`

- [ ] **P2** `validation.py` 新增 `chart_data` 完整性校验

      —— 每条 chart_data 必须有对应 source_asset_id
      —— 每条 chart_data_points 必须有对应 chart_id

### 5.3 OCR 能力

- [ ] **P2** `extract_tables.py` 增加 `ocr_fallback` 第四级后端

      —— 当 pdfplumber 与 PyPDF2 均未提取到表格时调用

- [ ] **P2** `pytesseract` 集成（作为可选依赖）

      —— `pyproject.toml` 的 `[project.optional-dependencies]` 加 `ocr`

- [ ] **P2** 中文支持 `lang='chi_sim+eng'`

### 5.4 DE 分析 FDR 校正

- [ ] **P2** `stats.py:run_differential_expression` 增加 BH FDR 校正

      —— `statsmodels.stats.multitest.multipletests`

- [ ] **P2** 火山图增加 `padj` 阈值线

- [ ] **P2** 输出 `padj` 字段

- [ ] **P2** 移除 `stats.py:638` 的 `# type: ignore[arg-type]`（生产代码违规）

### 5.5 extract_tables 测试覆盖

- [ ] **P2** `tests/test_skill_extract_tables.py` 增加真实 pdfplumber 路径测试

      —— 当前全部 mock `_extract_raw_tables`

- [ ] **P2** 在 `tests/fixtures/` 放置最小真实 PDF（1 页 1 表）

---

## 6. 已批准架构决策（保留自原 TODO §2）

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

## 7. 归档：Phase 1 已完成项

> 以下项已在 2026-07-13 至 2026-07-17 期间完成，保留作为历史归档。
> 完整验收证据见 git history 与 `docs/ARCHITECTURE.md`。

### 7.1 契约与目录（原 §4）

- [x] 定义全部领域契约（TaskRequest/TaskSpecification/QuerySpecification/

      DatasetSelection/SourceRecord/SourceRelation/DownloadAttempt/
      FileAsset/SourceAsset/DataLevel/SourceLocator/ParsedDataset/
      StageAttempt/ArtifactManifestEntry/RunManifest/Warning/Error）

- [x] 统一工作目录 `data/output/tasks/<task_id>/`

- [x] 任务级锁 + SHA-256 内容寻址 blob cache

- [x] TDD 验收覆盖空 topic、非法 task_id、未知字段、路径逃逸

### 7.2 固定真实数据（原 §5）

- [x] GSE178352 fixture（含官方 URL、SHA-256、提取命令）
- [x] PubMed PMID 34180400 真实响应 fixture
- [x] GEO GSE178352 真实元数据 fixture
- [x] PubMed skill 真实接入 NCBI E-utilities（3/10 req/s 限速 + 429/5xx 重试）
- [x] GEO skill 真实接入 E-utilities + ftp 下载

### 7.3 Processing（原 §6）

- [x] Counts Parser（gzipped TSV → 长格式 CSV，含 SourceLocator）
- [x] 标准化（gene + sample 粒度，稳定 record_id）
- [x] 清洗与字段映射（cleaning.py/alignment.py 真实实现）

### 7.4 Artifact Builder（原 §7）

- [x] 生成 14 个必需 CSV artifact
- [x] 所有 Artifact 记录大小与 SHA-256
- [x] Artifact 输出顺序稳定

### 7.5 Validation Gate（原 §8）

- [x] 6 项校验（foreign_keys/sample_foreign_keys/source_asset_integrity/

      field_descriptions/source_value_lineage/warnings_metrics_consistency）

- [x] 原子发布（TaskLock + fsync + rename + publish_completed.json marker）

### 7.6 Pipeline Runner（原 §9）

- [x] 固定阶段状态机与 append-only StageAttempt
- [x] 阶段操作幂等，重试生成新 attempt
- [x] 进程重启后从最近成功阶段恢复
- [x] 网络、模型、解析和完整任务独立超时
- [x] 支持 fixture/live/mock 模式

### 7.7 测试（原 §10）

- [x] 默认 pytest 无真实 Key 通过（770 passed, 2026-07-17）
- [x] Live 测试覆盖 PubMed + GEO + 完整 counts 校验
- [x] 前端 Vitest + TypeScript + ESLint + build 门禁（145 passed）

### 7.8 Agent 与 API（原 §11）

- [x] Pipeline 暴露为单一 SDK Function Tool
- [x] 数据库过滤不加载未选择 acquisition Tool
- [x] TaskRequest API 校验
- [x] Artifact API 只列出 manifest 中已验证文件
- [x] 统一 WebSocket event envelope
- [x] 事件先持久化再推送，支持按 sequence 续读

### 7.9 前端（原 §12）

- [x] shadcn Form 创建任务
- [x] 阶段 Timeline/Progress
- [x] 使用 Table 展示紧凑预览
- [x] Artifact 下载列表
- [x] 单一 task/event client
- [x] 自动重连和任务恢复
- [x] 真实浏览器覆盖 fixture 创建、执行、结果展示和下载流程

### 7.10 Review 修复（2026-07-17）

- [x] 修复 live 模式 artifact_build source_path 硬编码 bug
- [x] 修复 summarizer 静默 fallback 违反硬约束
- [x] compaction 增加 logger 可观测性
- [x] launcher 移除类型抑制
- [x] 前端 fileUtils 共享模块消除 DRY 违反
- [x] 前端接入 WS error 帧 toast
- [x] 删除前端死代码
- [x] 修复 AGENTS.md subscribe 命令文档漂移
