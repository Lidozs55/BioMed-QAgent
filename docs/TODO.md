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

- [x] **P0** 让 `run_research_pipeline` Function Tool 从 Agent 接收 `TaskSpecification`

      （含用户 topic 驱动的 query / dataset 选择），而不是无视 Agent 决策
      （`backend/app/pipeline/tool.py`）
      —— 同时移除 `tool.py:29-31` 的 `databases == {"pubmed","geo"}` 二次硬编码校验

- [x] **P0** 修复 `_build_specification_for_plan` 硬编码

      （`backend/app/pipeline/runner.py:737-781`，`source_id="src_placeholder"`）

- [x] **P0** 修复 discovery 阶段 `_PMID = "34180400"` / `_GSE = "GSE178352"` 硬编码

      （`backend/app/pipeline/stages/discovery.py:22-23`）
      —— 阶段应从 `TaskSpecification.queries` / `datasets` 读取目标

- [x] **P0** 修复 acquisition 阶段 `_DOWNLOAD_URL` 硬编码

      （`backend/app/pipeline/stages/acquisition.py:30-34`）

- [x] **P0** 修复 processing 阶段 live 模式仍读 fixture SOFT

      （`backend/app/pipeline/stages/processing.py`，2026-07-19）
      —— `run_processing` 现在按 `ctx.mode` 分支：fixture 模式保持原
      `process_geo_tximport_counts` 调用（用 fixture SOFT），live 模式
      直接走 `_recover_samples_from_series_matrix` 路径，**不再读
      fixture SOFT**。
      —— 架构限制：acquisition 阶段不下载 SOFT 文件，所以 live 模式
      无法用 `process_geo_tximport_counts` 真正解析表达式矩阵；当前
      live 模式仅产出 `measurement_type="sample_metadata"` 行。未来
      完整修复方向见 docstring 中的 Architectural note（让 soft_gzip
      可选 / 扩展 acquisition 下载 SOFT）。
      —— 配套 TDD：`tests/pipeline/test_geo_tximport_processing.py::test_run_processing_live_mode_does_not_read_fixture_soft`
      + `test_run_processing_fixture_mode_still_uses_fixture_soft`

- [x] **P0** 修复 `parse_geo_soft_samples` 的 `len(samples) != 12` 硬校验

      （`backend/app/pipeline/processing/geo_tximport.py`，2026-07-19）
      —— 改为 `not samples` 抛 ValueError + `len(set(aliases)) != len(samples)`
      抛 ValueError。样本数动态从 SOFT 读取，不再硬编码 12。样本数通过
      `ParsedDataset.processing_parameters["sample_count"]` 上报（TODO §1.3）。
      —— 配套 TDD：`test_parse_geo_soft_samples_accepts_non_twelve_sample_count`
      + `test_parse_geo_soft_samples_rejects_zero_samples`
      + `test_parse_geo_soft_samples_rejects_duplicate_aliases`

- [x] **P0** 修复 `staging_run("run_pinned_fixture")` 硬编码标识符

      （`backend/app/pipeline/stages/artifact_build.py:327`，2026-07-19
      发现已修复）—— 当前实现已使用 `ctx.workdir.staging_run(ctx.run_id)`，
      不存在硬编码字符串。`run_pinned_fixture` 仅在 `test_pipeline_runner_resilience.py:533`
      的断言中以负向形式出现（`assert not (task_root / "staging" / "run_pinned_fixture").exists()`）。
      TODO 描述过时，直接标记为完成。

### 1.2 修复 field_descriptions placeholder

> **背景**：当前 `description = field.replace("_", " ")`（artifact_build.py:172），
> 例如 `gene_id_namespace` 的描述就是 `"gene id namespace"`。
> 这是赛题"结构化输出样例：字段说明"的直接评分点。

- [x] **P0** 为所有字段编写真实语义说明

      （`backend/app/pipeline/stages/artifact_build.py`，2026-07-19）
      —— 已新增 `_FIELD_DESCRIPTIONS` 字典覆盖全部 22 个 `main_data.csv` 字段：
      record_id / dataset_id / source_id / asset_id / gene_id / gene_id_raw /
      gene_id_namespace / gene_id_version / sample_id / source_sample_alias /
      measurement_type / value_semantics / value_scale / is_normalized /
      is_integer_expected / expression_value / expression_unit /
      source_logical_file / source_line_number / source_column_index /
      source_column_name / source_raw_value。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_field_descriptions_have_real_semantics`

- [x] **P0** 提供字段 `example` 值（当前恒为空字符串）

      （`_FIELD_DESCRIPTIONS` 元组第 5 位即 `example`，例如 `record_id` →
      `rec_gse178352_ENSG00000000003_GSM8117703`）

- [x] **P0** 完善 `unit` 字段（除 expression_value 的 "estimated_count" 外）

      （`_FIELD_DESCRIPTIONS` 元组第 3 位即 `unit`，按字段语义填充：
      `expression_value` → `estimated_count`，`expression_unit` → `count_unit`，
      `source_line_number` / `source_column_index` → 空串，其余字段语义无单位者留空）

- [x] **P0** 修复 `data_type` 全部硬编码为 `"string"`（artifact_build.py:171）

      （`_FIELD_DESCRIPTIONS` 元组第 1 位即 `data_type`，按字段实际类型填充：
      `string` / `float` / `integer` / `boolean`）

### 1.3 修复 source_relations / processing_log 硬编码

- [x] **P0** 让 `relation_id` 从 discovery 阶段动态派生

      （`artifact_build.py:_build_source_relations`，2026-07-19）
      —— 改为 `f"rel_pmid{literature.pmid}_{geo.accession.lower()}"`，
      从 discovery 实际产出派生而非硬编码 `"rel_pmid34180400_gse178352"`。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_source_relations_relation_id_derived_from_pmid_and_gse`

- [x] **P0** 让 `source_relations.csv` 包含多条关系

      （`artifact_build.py:_build_source_relations`，2026-07-19）
      —— 新增 `_build_source_relations()` 函数：主关系（PubMed→GEO,
      `article_describes_dataset`）+ `geo.pubmed_ids` 中其他 PMID 各生成
      一条 `geo_references_pubmed` 关系（`to_source_id="ext:pubmed:<pmid>"`）。
      —— 配套 TDD：`test_source_relations_supports_multiple_pubmed_ids`
      + `test_source_relations_returns_empty_when_sources_missing`

- [x] **P0** 让 `processing_log.rows_before` 从真实解析结果统计

      （`artifact_build.py` + `processing/geo_tximport.py` + `domain/contracts/pipeline.py`，2026-07-19）
      —— 在 `ParsedDataset` 新增 `source_row_count: int` 字段，
      `process_geo_tximport_counts` 在解析时统计源文件 gene-row 数并填充。
      `artifact_build.py` 读取 `parsed_dataset.source_row_count` 写入
      `processing_log.rows_before`，替代硬编码 `4`。
      —— 配套 TDD：`test_processing_log_rows_before_reflects_real_source_row_count`
      + `test_parsed_dataset_carries_source_row_count_and_parameters`

- [x] **P0** 修复 `processing_log` 的 `output_refs` 与 `input_refs` 相同错误

      （`artifact_build.py`，2026-07-19）—— `input_refs` 指向
      `source_asset.asset_id`（源数据），`output_refs` 指向
      `parsed_dataset.file_asset.asset_id`（产出 artifact）。
      —— 配套 TDD：`test_processing_log_output_refs_differs_from_input_refs`

- [x] **P0** 修复 `processing_log.parameters` 硬编码 `{"measurement": "counts"}`

      （`artifact_build.py` + `processing/geo_tximport.py` + `domain/contracts/pipeline.py`，2026-07-19）
      —— 在 `ParsedDataset` 新增 `processing_parameters: dict[str, JsonValue]`
      字段，parser 填充 `measurement_type` / `value_semantics` / `value_scale`
      / `is_normalized` / `sample_count` / `source_logical_file` /
      `gene_id_namespace`。`artifact_build.py` 直接序列化该字段写入
      `processing_log.parameters`。
      —— 配套 TDD：`test_processing_log_parameters_reflects_real_processing_config`

### 1.4 解除数据库选择硬编码

- [x] **P0** 修复 `routes.py:157` 的 `skill.name in {"pubmed", "geo"}` 限制

      —— 应展示所有已注册的真实数据库 skill（GEO/GDC/PDB/PubChem/Reactome/Xena）

### 1.5 PubMed download_supplementary 合规化

> **背景**：`download_supplementary` 绕过统一 `NcbiEutilsClient`，直接用
> Biopython Entrez + urllib，无重试/无限速/无 api_key。

- [x] **P0** 改造 `download_supplementary` 复用 `NcbiEutilsClient`

      （`backend/app/skills/builtin/discovery/pubmed.py`）
      —— 将 `Entrez.efetch` 替换为 `services.eutils.efetch`
      —— 将 PMC HTML/文件下载改为 `httpx.AsyncClient` + 限速/重试
      —— 通过 adapter + `@function_tool` wrapper 模式（与 `download_geo` 对齐），
         `services.eutils` 提供 3/10 req/s 限速 + 429/5xx 重试 + tool/email/api_key，
         `services.http` + `BROWSER_HEADERS` 提供 PMC HTML/文件下载（满足
         project_memory L11 真实浏览器 UA 约束）。

- [x] **P0** 补全 Biopython Entrez 的 `tool` / `api_key` 参数

      ~~（若保留 Biopython 调用）~~ —— 已彻底移除 Biopython 依赖：
      `from Bio import Entrez`、`Entrez.email` 全局配置全部删除。
      合规参数由 `NcbiEutilsClient` 在内部统一注入，无需在调用方补全。

- [x] **P0** 删除 `pubmed.py:35-115` 的 dead code `_parse_pubmed_record`

      已删除；回归守卫 `test_pubmed_module_does_not_define_parse_pubmed_record`
      防止未来回归。同时移除 `urllib.request` / `urllib.error` 依赖（由
      `test_pubmed_module_does_not_use_urllib_for_http` 守卫）。

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

- [x] **P0** 所有 CSV 写入改用 `utf-8-sig`（带 BOM）

      （`artifact_build.py:_write_csv` / `validation.py:_write_csv` /
      `processing.py:_build_minimal_parsed_dataset` /
      `processing/geo_tximport.py:process_geo_tximport_counts`，2026-07-19）
      —— 所有产物 CSV 均以 `b"\xef\xbb\xbf"` BOM 开头，Excel 可直接打开中文不乱码。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_all_artifact_csvs_have_utf8_bom`
      —— 同步更新所有读取端用 `utf-8-sig` 解码以透明剥离 BOM：
      `validation.py:_read_csv` / `runner.py` warnings.csv 读取 /
      3 处测试 helper。

- [x] **P0** 修复 `run_manifest.json` 的 `model_name=None`

      （`validation.py`，2026-07-19）—— 改为 `settings.model_name`，
      从 `app.config.settings` 注入实际 Qwen 模型名。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_run_manifest_model_name_not_none`

- [x] **P0** 修复 `warnings.csv` 恒空，cell-line 修正未记入

      （`artifact_build.py:_build_cell_line_warnings`，2026-07-19）
      —— 新增 `_build_cell_line_warnings()` 遍历 samples，
      对 `cell_line_raw != cell_line_canonical` 的样本输出 warning 行
      （`code=cell_line_normalized`，`severity=info`）。
      —— 同步序列化到 `processing_log.csv` 的 `warnings` JSON 数组，
      确保 `warnings_metrics_consistency` 校验通过。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_warnings_csv_records_cell_line_corrections`
      —— 配套事件：`tests/pipeline/test_event_coverage.py::test_warning_events_emitted_for_cell_line_corrections`

- [x] **P0** 修复 `artifact_build.py:78` 的 `extrasaction="ignore"` 静默丢字段

      （`artifact_build.py:_write_csv` / `validation.py:_write_csv`，2026-07-19）
      —— 改为 `extrasaction="raise"`，typo 的 row key 会立即抛 `ValueError`。
      —— 配套 TDD：`tests/pipeline/test_artifact_metadata_correctness.py::test_write_csv_rejects_extra_fields`

- [ ] **P0** Pipeline 全链路接入结构化日志

      （`logging.getLogger("app.pipeline")` + JSON handler）
      —— 至少覆盖 stage_started / stage_completed / artifact_produced / validation_failed

- [ ] **P0** `MetricsTracker` 接入 Pipeline（已实现但未调用）

      （`backend/app/core/metrics.py`）—— 在 PipelineRunner 中初始化并随 stage 更新

### 1.8 P0：query_log 状态枚举统一

> **背景**：8 个 skill 用 6 种同义词表示同一状态
> （`completed` / `succeeded` / `ok` / `failed` / `error` / `not_found`），
> 评委审计 query_log 时难以聚合统计。

- [x] **P0** 定义 `QueryStatus` 枚举（`app/domain/contracts.py`）

      —— `success` / `not_found` / `failed` / `skipped` 四态
      —— 实现：`backend/app/domain/contracts/enums.py:112-134` `QueryStatus(StrEnum)`
      含 5 态：SUCCESS / NOT_FOUND / FAILED / SKIPPED / PAGE_FALLBACK（page_fallback
      对应 project_memory 硬约束"page fallback 必须 status=page_fallback code=0"）

- [x] **P0** 8 个 skill 统一使用 `QueryStatus` 枚举

      （discovery/pubmed, acquisition/{geo,gdc,pdb,pubchem,reactome,xena}）
      —— 实现：`backend/app/agent_loop/context.py:277-300` `log_query()` 接受
      `QueryStatus | str`；11 个 skill 文件 42 处 `log_query()` 调用全部迁移
      到 `QueryStatus.X`

- [x] **P0** 新增 `tests/test_query_log_status_consistency.py`

      —— 遍历所有 skill 的 query_log 输出，断言 status ∈ QueryStatus
      —— 实现：`backend/tests/test_query_log_status_consistency.py`
      （AST 静态扫描 + import 完整性 + 枚举值稳定性，30 个测试用例）

### 1.9 P0：工程基础修复（文档/源码一致性）

> **背景**：第二轮审查发现 backend/README、frontend/README、ARCHITECTURE.md
> 与实际代码严重漂移；`backend/data/.gitignore` 排除所有 artifact 样例，
> 评委克隆仓库后无法直接查看任何产物；Agent INSTRUCTIONS 缺"主题→数据库"决策表。

- [x] **P0** 同步 `backend/README.md`

      —— 修正：测试文件数（12→86）、API 端点数（5→11+WS）、项目结构（agent_loop/runtime/pipeline/integrations/domain/contracts）、Skill 数量（9→14）
      —— 实现：2026-07-19 完成，含 NCBI 配置项、PDF 三级 fallback 链、QueryStatus 枚举、安全模型 AST 白名单、Qwen 400 重试说明

- [x] **P0** 同步 `frontend/README.md`

      —— 修正：shadcn 组件清单（28→36）、测试覆盖（1→15 文件 / 200+ 测试）、新增 `runtime/` 目录说明
      —— 实现：2026-07-19 完成，含 AgentComposer / AgentProgress / ArtifactWorkspace / UserInputDialog / BackgroundTaskNotifications 等新组件说明，Zustand Store 结构改为 `tasksById/activitiesById/artifactsById` 投影

- [x] **P0** 同步 `docs/ARCHITECTURE.md` §8、§9 与 §12

      —— 已记录完整 durable REST/WS/HIL/并发契约、前端 Run 隔离与
      2026-07-17 最新后端/前端验证证据

- [ ] **P0** 提交 1-2 个 artifact 样例到版本控制

      —— 修改 `backend/data/.gitignore`（当前 `*\n!.gitignore` 全部排除）
      —— 至少提交 GSE178352 fixture 的一次完整 artifacts/ 输出样例到 `backend/data/examples/`
      —— 让评委克隆仓库即可查看真实产物

- [x] **P0** 完善 `agent_loop/agent.py` 的 INSTRUCTIONS

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
> **现状**（2026-07-17 implemented + reviewed）：
> - §4.2.1 共享暂停原语与 §4.2.2 计划确认已完成；`user_input_required` /
>   `user_input_resumed` 会进入后端 durable event log，并驱动
>   `AWAITING_USER_INPUT → RUNNING | CANCEL_REQUESTED | FAILED | INTERRUPTED`。
> - 真实 Agent Function Tool 已接入 Run-owned event/resume bridge；resume 使用
>   exact one-shot request identity，reject/HIL timeout 会失败权威 Run，paused
>   cancellation 会立即唤醒 Pipeline，fixture 会记录自动批准审计事件。
> - 前端 prompt 按 Run 保存，Dialog 按 `task_id + run_id + request_id` 提交，并以
>   submission attempt 隔离 A → B → A 切换中的旧异步结果；paused Run 计入 4 个
>   并发 slot。
> - §4.2.3 数据修正实例仍未实现，继续复用同一底层原语，不另建 pause-resume
>   机制。
>
> **统一架构原则**：§4.2.3 必须复用已完成的 §4.2.1 共享底层，不能再实现一套
> 独立 pause-resume 机制。

#### 4.2.1 共享底层架构（P1，已完成，供 4.2.2/4.2.3 复用）

- [x] **P1** 新增 `RunStatus.AWAITING_USER_INPUT` 运行子状态

      （`backend/app/domain/contracts/runtime.py` + `app/runtime/state.py`）
      —— 合法转换：`RUNNING → AWAITING_USER_INPUT → RUNNING |
      CANCEL_REQUESTED | FAILED | INTERRUPTED`
      —— `TaskManager` 暂停 Run worker（不释放 semaphore slot，避免被新任务抢占）

- [x] **P1** 新增统一 `UserInputRequiredPayload` 事件

      （`backend/app/domain/contracts/events.py`）
      —— 字段：`request_id` / `prompt_kind`（判别联合：`plan_confirmation` | `data_correction`）/
      `summary` / `expires_at` / `fixture_exempt` / `detail`
      —— 保留 `PlanReadyPayload` 作为计划摘要/兼容审计事件，真正暂停语义由
      `UserInputRequiredPayload(prompt_kind="plan_confirmation")` 承担

- [x] **P1** PipelineRunner 新增 `_await_user_input(request)` 暂停原语

      （`backend/app/pipeline/runner.py`）
      —— 发射事件 → 设置 Run 为 AWAITING_USER_INPUT → 阻塞 `asyncio.Event`
      —— fixture 模式自动批准（`fixture_exempt=True`，发射 required/resumed
      审计事件但不阻塞）
      —— HIL timeout 独立于 stage/total timeout；等待期间暂停 total budget，超时以
      `PipelineUserInputTimeoutError` 转 FAILED

- [x] **P1** 新增 `POST /api/v1/tasks/{task_id}/runs/{run_id}/resume` API

      （`backend/app/api/routes.py`）
      —— Body：`{request_id, decision: "approve"|"reject", detail?: object}`
      —— 校验 `request_id` 匹配当前等待中的请求
      —— 触发 Run 恢复，将 decision 传给 `_await_user_input`

- [x] **P1** 前端 `reducer.ts` 接入 `user_input_required` / `plan_ready` /
      `task_created` / `task_recovered`

      （`frontend/src/runtime/reducer.ts` + `contracts.ts`）
      —— 上述事件均进入 Task/Run-scoped reducer 投影
      —— 新增 `TaskProjection.pendingUserInput: PendingUserInput | null`，包含
      authoritative `runId` / `requestId`
      —— 在 `RunStatus` 类型增加 `"awaiting_user_input"`

- [x] **P1** 新增统一 `UserInputDialog` 组件（复用 shadcn Dialog）

      （`frontend/src/components/UserInputDialog.tsx`）
      —— 当前按 `prompt_kind="plan_confirmation"` 渲染计划确认；
      `data_correction` 表单由 §4.2.3 补充
      —— 提交时调用 `POST /runs/{run_id}/resume`

- [x] **P1** AGENTS.md §2 HTTP 路由表补充 `/resume` 端点
  （保持文档与代码同步）

#### 4.2.2 实例 A：计划确认（原 §4.2）

- [x] **P1** PipelineRunner 在 `PlanReadyPayload` 后调用 `_await_user_input`

      —— fixture 模式豁免（`fixture_exempt=True`，自动批准）
      —— agent 模式真正阻塞，等待 `POST /resume`

- [x] **P1** `UserInputDialog` 的 `prompt_kind="plan_confirmation"` 分支渲染

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

- [x] **P1** 新增 `extract_chart_data_vlm` 工具

      —— 输入：PDF 中的图片（pdfplumber.page.images 提取）或独立图片文件
      —— 调用 DashScope `qwen-vl-max`（OpenAI 兼容端点）
      —— 提示词要求严格 JSON 输出：`{chart_type, axes:{x:{label,unit,scale},y:{...}}, data_points:[{x,y,label}], legend:[...]}`
      —— 参考 `docs/legacy_skill_reference.md` §21 的 base64 编码方式
      —— 实现：[backend/app/skills/builtin/processing/extract_chart_data_vlm.py](../backend/app/skills/builtin/processing/extract_chart_data_vlm.py)
      —— VLM 客户端：[backend/app/agent_loop/vl_model.py](../backend/app/agent_loop/vl_model.py)
      —— 多源输入：PNG/JPG/WEBP/GIF/PDF 统一分派；外部图片自动复制到 `source_assets/figures/`
      —— 大图降采样：>10MB 图片 Pillow LANCZOS 重采样到 1920px 最长边
      —— JSON 解析容错：剥离 markdown fence + 截断尾部 prose + 必需键校验
      —— hint 参数：可选提示词增强（如 "scatter plot, log scale"）
      —— 单元测试：[backend/tests/test_skill_extract_chart_data_vlm.py](../backend/tests/test_skill_extract_chart_data_vlm.py)（24 项）
      —— live 测试：[backend/tests/live/test_extract_chart_data_vlm_live.py](../backend/tests/live/test_extract_chart_data_vlm_live.py)（PNG + PMC PDF 端到端）

- [x] **P1** 保留原始图片数据到 `source_assets/figures/`

      —— 图片命名：`fig_<sha256[:12]>.<ext>`
      —— 走 `acquire_source()` 注册为 `SourceAsset`（mime_type=image/png 或 image/jpeg）
      —— 在 `source_assets.csv` 中标注 `asset_type=figure`
      —— 在 `download_log.csv` 记录提取来源（PDF 页码 / 源 URL）
      —— 实现：`_ensure_image_in_figures()` 在 `extract_chart_data_vlm.py` 中，
        外部图片通过 `shutil.copy2` 保留到 `figures/`；已在 figures/ 内的不复制。
        `was_copied=True` 时调用 `run_ctx.add_raw_asset()` 注册 provenance。

- [x] **P1** 新增 `chart_data.csv` artifact

      —— 列：chart_id / source_asset_id / chart_type / x_label / x_unit / x_scale /
        y_label / y_unit / y_scale / data_point_count / legend /
        extracted_at / model_name / source_label
      —— UTF-8 BOM 编码（`utf-8-sig`）兼容 Excel（TODO §1.7）

- [x] **P1** 新增 `chart_data_points.csv` artifact

      —— 列：point_id / chart_id / x_value / y_value / series_label / confidence
      —— UTF-8 BOM 编码

- [x] **P2** 三级降级链实现

      —— L1: Qwen-VL（主路径，要求 DASHSCOPE_API_KEY 可用）
      —— L2: pdfplumber 表格 OCR（无 VL 模型时降级，仅提取表格非图表）
      —— L3: 仅保留 caption 文本（兜底，写入 warnings.csv 标记 `chart_unextracted`）
      —— 实现：`_extract_from_pdf()` 按 L1→L2→L3 顺序，全部失败抛
        `ChartExtractionError`（project_memory L1：禁止静默空数据降级）

- [x] **P2** 降级时在 `warnings.csv` 标记降级原因

      —— 如 `model_unavailable` / `image_corrupted` / `unsupported_chart_type`
      —— 实现：通过 `run_ctx.add_warning()` 记录每层失败的 source/severity/message，
        响应 JSON 中 `degradation` 字段列出使用的 tier。

- [ ] **P2** `validation.py` 新增 `chart_data` 完整性校验

      —— 每条 chart_data 必须有对应 source_asset_id
      —— 每条 chart_data_points 必须有对应 chart_id
      —— 待办：`validation.py` 暂未纳入 chart_data 校验，下个迭代实现

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

### 5.6 网页视觉证据采集（SeparateWeb Capture 集成）

> **背景**：上游 `separateweb-capture` skill（Node.js + Playwright + Sharp）
> 已复制到仓库根目录，但其 `scripts/` 目录缺失无法运行，且违反 Python-only
> 后端约定。改为新增 Python 原生 `web_visual_capture` skill，复用 `crawler.py`
> 的 Playwright Python 绑定，作为 §5.2 视觉模型降级链的输入采集通道。
>
> **完整规划**：[docs/separateweb_capture_integration_plan.md](separateweb_capture_integration_plan.md)
> **独立性核验**：上述规划文档 §14（移除上游 skill 后 Python 后端可独立运行）

- [x] **P1** 阶段 1：新增 `web_visual_capture` skill MVP

      —— 文件：`backend/app/skills/builtin/acquisition/web_visual_capture.py`
      —— 工具：`capture_web_page(url, full_page, viewport, wait_until, label)` + `capture_page_section(url, selector, viewport, wait_until, label)`
      —— 复用 `crawler.py` 的 `playwright_screenshot()`（Playwright + stealth + 2s 限速 + 真实 UA）
      —— 轻量 provenance：`SourceRecord(database=BROWSER)` + `add_raw_asset()`（不走 `acquire_source()` 白名单）
      —— 落地路径：`source_assets/figures/fig_<sha256[:12]>.png` + `_meta.json` sidecar
      —— 在 `_registry.py` 的 `BUILTIN_SKILL_MODULES` 追加模块
      —— 在 `agent.py` 的 `INSTRUCTIONS` 增补"视觉证据采集策略"段落
      —— `routes.py:/databases` 过滤排除（与 `browser_fallback` 同等处理）

- [x] **P1** 阶段 1：单元测试 + live 测试

      —— `tests/test_skill_web_visual_capture.py`：22 项单元测试（mock `playwright_screenshot` 验证完整链路 + provenance + dedup + label 校验）
      —— `tests/live/test_web_visual_capture_live.py`：3 项 live 测试（example.com 全页 + h1 元素 + dedup）
      —— 质量门禁：`uv run pytest` + `uv run ruff check` + uvicorn 启动

- [x] **P2** 阶段 2：DOM 选择器裁剪（`selector` 参数）

      —— `capture_page_section` 工具用 `page.locator(selector).screenshot()` 精确截取论文图表区域
      —— 单元测试覆盖 selector 转发与失败路径
      —— （未引入 Pillow，因为截图直接由 Playwright 产出，无需后处理）

- [ ] **P2** 阶段 3：与 `extract_chart_data_vlm` 联调（依赖 §5.2）

      —— `extract_chart_data_vlm` 接受 `capture_web_page` 返回的 `image_path`
      —— 集成测试：capture → VLM → CSV 完整链路

- [ ] **P2** 阶段 4：BrowserPool 接入（依赖 §8.6）

      —— 随 `crawler.py` 的 `BrowserPool` 落地，切换为 `pool.acquire_context()`

- [x] **P2** 移除上游 `separateweb-capture/` 目录

      —— 阶段 1 落地后执行：删除 `separateweb-capture/` 目录
      —— 同步清理 `skills-lock.json` 中相关条目（如有）
      —— 验证后端独立启动 + `web_visual_capture` skill 可用

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

- [x] 默认 pytest 无真实 Key 通过（867 passed, 18 deselected, 2026-07-17）
- [x] Live 测试覆盖 PubMed + GEO + 完整 counts 校验
- [x] 前端 Vitest（14 files / 191 tests）+ TypeScript + ESLint + build 门禁

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
- [x] Agent HIL bridge 权威化：exact one-shot resume identity、reject/timeout
      failure、paused cancellation 与 fixture auto-approval audit
- [x] 前端 HIL prompt/提交 attempt 按 Run 隔离，修复 A → B → A 异步串扰并将
      paused Run 计入并发 slot
- [x] R5 UX 修复：App 视口边界 + 非聊天页有界滚动、稳定 Task 排序、通知 View
      失败反馈与多行 Bubble；桌面/移动浏览器复验通过

---

## 8. P0/P1：2026-07-18 流程审查发现的新问题

> **背景**：2026-07-18 前后端完整启动测试 + 多轮深度审查发现 12 类问题，
> 完整分析见 [`docs/REVIEW_2026-07-18.md`](REVIEW_2026-07-18.md)。
> 本节为 TODO 跟踪入口，与审查报告双向同步。
> 核心架构性缺陷：`TaskManager._execute`（`runtime/manager.py:1209`）的
> "成功证据校验"完全缺失——`commit_completion()` 返回 `[]` 时仍无条件发射
> `RunCompletedPayload`，导致"LLM 完成但无 artifact"与"LLM 截断"都静默 completed。

### 8.1 P0：核心真实性修复（无证据完成 + LLM 截断静默）

> 详见审查报告 §1、§2、§0。

- [x] **P0** `manager.py:1209` AGENT 模式增加"成功证据校验"

      —— `completion_events` 为空且无 cancellation 时转 `RunFailedPayload`，
      错误信息"agent 完成但未产出 artifact"
      —— 同时解决"结果未显示"与"LLM 截断静默完成"两个症状
      （`backend/app/runtime/manager.py:1201-1212`）
      —— 实现：`manager.py:1237-1252` `agent_executed` 标记 + 空事件转 RunFailed

- [x] **P0** `runner.py:284` 空 payloads 发 warning 事件

      —— `_load_artifact_payloads` 返回 `[]` 时发射
      `WarningPayload(code="artifact_manifest_missing" | "artifact_unchanged")`
      —— 前端 reducer 已支持 warning 展示分支
      （`backend/app/agent_loop/runner.py:104-133, 284-305`）
      —— 实现：`runner.py:473-478` `artifact_manifest_missing` warning

- [x] **P0** `runner.py:440-459` `_extract_text_delta` 读取 `finish_reason`

      —— 在 `finish_reason="length"` 时发射
      `WarningPayload(code="llm_output_truncated")`
      —— 当前完全忽略 `finish_reason` 字段
      —— 实现：`runner.py:167-184` + `_extract_finish_reason` (line 741-755)

- [x] **P0** `runner.py:271` `_consume_events` 后校验 `result.final_output`

      —— 若为 None 或空字符串则 `raise RuntimeError("agent returned empty final_output")`
      —— 参考 `summarizer.py:50-55` 的现有校验模式
      —— 实现：`runner.py:370-385`

- [x] **P0** 新增回归测试 `tests/agent_loop/test_silent_completion.py`

      —— 验证：LLM 不调 tool / final_output 为空 / manifest 缺失时必须 RunFailed

- [x] **P0** 新增回归测试 `tests/agent_loop/test_llm_truncation.py`

      —— 模拟 `finish_reason="length"`，验证 warning 事件 + 不静默 completed

- [x] **P0** 新增 Agent 模式 e2e 测试 `tests/agent_loop/test_agent_run_e2e.py`

      —— 用 Mock LLM 走完 AgentRunExecutor 完整链路
      —— 验证 `artifact_produced` + `RunCompletedPayload` 配对
      —— 当前 `test_execution.py` 全部用 `NoopCompactor` + Mock SDK，不验证真实交互

- [ ] **P1** `runner.py:115` 指纹未变不应静默返回 `[]`

      —— 应仍发射 `artifact_produced`（让前端至少能 hydration）
      —— 或显式标记 `artifact_unchanged` 让前端走 HTTP 拉取

- [ ] **P1** `routes.py:548-549` `_load_validated_manifest` 降级回退

      —— `.runtime-publication.json` 缺失时回退到 manifest 文件本身
      —— 响应中加 `degraded=true` 标记

### 8.2 P0：前端 Agent 动态可见性

> 用户反馈："工具调用（目前有但是更新少）、工具调用结果（找到了多少篇论文、
> 多少调数据、清洗剩余多少条数据），现在能看到的消息太少"。详见审查报告 §4。

- [x] **P0** 新增 `StageProgressPayload` 事件类型

      —— 字段：`stage` / `kind` / `current` / `total` / `detail: dict`
      —— 挂到 `EventPayload` 联合（`backend/app/domain/contracts/events.py`）

- [x] **P0** Skills 在 `log_query` 后发射 progress 事件

      —— `pubmed.py` / `geo.py` 的 `search_*_adapter` 发射
      `kind="discovered_records", current=len(records), total=result.total_count`
      —— 通过 `RunContext` 注入的 emit 回调（`backend/app/skills/builtin/`）

- [x] **P0** Acquisition / Processing 阶段发射 progress 事件

      —— `acquisition.py:158-164` 在 `SourceAsset` 创建后发射
      `kind="downloaded_bytes"` / `kind="downloaded_records"`
      —— `processing.py` 在 `process_geo_tximport_counts` 返回后发射
      `kind="cleaned_rows", current=parsed.row_count`

- [x] **P0** Pipeline runner 新增 `_emit_progress_event`

      —— 走 `_publish_event` 通道
      （`backend/app/pipeline/runner.py`）

- [x] **P0** 前端删除 stage 事件 Agent 模式丢弃守卫

      —— `reducer.ts:915-957` 当前 `if (task.summary.mode !== "fixture") break;`
      —— Agent 模式任务调用 `run_research_pipeline` 时所有 stage 事件被丢弃
      —— 改为跨模式 stage 投影（类似 `fixtureStages`）

- [x] **P0** `AgentProgress.tsx` agent 模式增加 stage/进度区段

      —— 目前 fixture 模式才有 stage 卡片，agent 模式仅显示单行"当前工具名"
      （`frontend/src/components/AgentProgress.tsx:40-86`）

- [x] **P1** `ChatPanel.tsx` 新增 `ExecutionSummary` 执行摘要

      —— 按 Run 读取 tool / stage / progress / warning 活动，同一阶段同一
      progress kind 原位更新，运行中默认展开
      —— Chat 主流只展示工具状态、阶段进度、验证结果和警告等安全结构化摘要
      —— 工具事件中已有的 output、digest 和诊断详情保留在 `ToolTrace.tsx`；
      `ExecutionSummary` 不渲染任意 detail、reasoning-like keys 或隐藏提示词，系统
      不主动传输模型 CoT

### 8.3 P0：数据源硬门控解除

> 详见审查报告 §3。当前 Pipeline 通过两道硬门控强制只用 PubMed+GEO。

- [ ] **P0** `tool.py:30-31` + `runtime.py:112-119` 解除硬门控

      —— 若要扩展 Pipeline 支持其他数据库，需先解除这两道硬门控
      —— 若维持现状，`/databases` 响应加 `pipeline_supported: bool` 字段
      标明哪些走 Pipeline、哪些是 Agent 直调

- [ ] **P1** `acquisition.py:113-207` 为 PubMed 新增 SourceAsset 产出

      —— 复用 `discovery/pubmed.py` 中已有的 `download_supplementary` 工具
      —— 产出 PubMed 全文/附件 `SourceAsset`，使其进入
      `source_assets.csv` / `download_log.csv`
      —— 当前 PubMed 只进 `literature.csv` / `source_list.csv` /
      `source_relations.csv`，不进"数据条目"类产物

- [ ] **P2** 新增 EuropePMC/Unpaywall/UniProt/ChEMBL 等 skill

      —— 用户提到的 10 个数据库需新增 skill 文件 + 枚举值 + fixture
      —— **工作量很大**，建议先核对 `PROBLEM.md` 确认是必选还是规划中

### 8.4 P0：Follow-up Loop + PDF Fallback + Compaction（与 project_memory 硬约束冲突）

> 详见审查报告 §5、§6、§7。这三项在代码库中完全缺失。

- [x] **P0** 定义 `QueryStatus` 枚举（`success` / `not_found` / `failed` / `skipped` / `page_fallback`）

      —— 所有 skill 统一使用，替代当前 "ok"/"failed"/"error"/"succeeded"/"completed" 不一致状态
      （`backend/app/domain/contracts/` + `backend/app/agent_loop/context.py:229-240`）
      —— 实现：`backend/app/domain/contracts/enums.py:111-133` `QueryStatus(StrEnum)`
      —— `context.py:277-300` `log_query()` 接受 `QueryStatus | str`
      —— 11 个 skill 文件 42 处 `log_query()` 调用全部迁移到 `QueryStatus.X`

- [ ] **P0** Agent INSTRUCTIONS 新增 follow-up 策略

      —— 最多 3 轮，失败查询标记 `not_found` 不重试
      —— `IterationDecisionAgent` 已被 project_memory 硬约束要求"完全移除"
      （`backend/app/agent_loop/agent.py`）

- [x] **P0** 新增 `tests/test_query_log_status_consistency.py`

      —— 遍历所有 skill 的 query_log 输出，断言 status ∈ QueryStatus
      —— 实现：`backend/tests/test_query_log_status_consistency.py`（AST 静态扫描 +
        import 完整性 + 枚举值稳定性，30 个测试用例）

- [x] **P0** 新增 `integrations/unpaywall.py` DOI 查询客户端

      —— 5s timeout，返回 pdf_url
      —— 实现 project_memory 硬约束的"pdf_url → Unpaywall → EPMC"三级 fallback
      —— 实现：`backend/app/integrations/unpaywall.py` `lookup_pdf_url(doi, *, email, timeout=5.0)`

- [x] **P0** 新增 `integrations/europepmc.py` PMCID → fullTextXML 客户端

      —— 实现：`backend/app/integrations/europepmc.py` `fetch_full_text_xml(pmcid, *, timeout=30.0)`

- [x] **P0** `acquisition.py` 实现 PDF 三级 fallback 链

      —— `pdf_url`（直接链接）→ Unpaywall（DOI，5s 快失败）→
      EPMC fullTextXML（PMCID，国内可用）
      —— 实现：`backend/app/integrations/acquisition.py:400-568`
      `acquire_publication_with_fallback(...)`（Tier 1 `acquire_source()` →
      Tier 2 Unpaywall DOI 解析 + `acquire_source()` → Tier 3 EPMC XML 直存）

- [x] **P0** `integrations/acquisition.py:30-49` `_ALLOWED_HOSTS` 新增域名

      —— `api.unpaywall.org` / `www.ebi.ac.uk`
      —— 实现：`backend/app/integrations/acquisition.py:48-52`

- [x] **P0** `compaction.py:216-244` summarizer 显式校验 `finish_reason`

      —— `length` 时抛异常而非降级
      —— 与 project_memory 硬约束"LLM 失败必须抛异常"一致
      —— 实现：`backend/app/runtime/compaction.py:55-80` `ConversationSummarizerTruncatedError`
        + `_extract_finish_reason()`；`_summarize_with_model()` 切换到 `Runner.run_streamed()`
        在 `finish_reason="length"` 时抛异常；`prepare()` 新增
        `except ConversationSummarizerTruncatedError: raise` 短路 `_fallback()`

- [ ] **P0** 实现 ReviewerAgent

      —— project_memory 硬约束"压缩前完整传递 query log 给 ReviewerAgent"完全未实现
      —— 当前 `query_log_summary` 仅 task-local（`summarizer.py:254-260`）

- [x] **P1** 新增 `tests/test_pdf_fallback_chain.py` 验证三级 fallback 各分支

      —— 实现：`backend/tests/test_pdf_fallback_chain.py`（9 个测试：Tier 1 直链成功 /
        Tier 1 跳过（landing page）/ Tier 2 Unpaywall 成功 / Tier 2 跳过（无 DOI）/
        Tier 3 EPMC 成功 / Tier 3 sha256 校验 / 全部失败 / 无 DOI 无 PMCID /
        Tier 1 失败回退 Tier 2）

- [ ] **P1** `runner.py` Agent loop 增加 turn counter

      —— 达到 3 轮 follow-up 后强制停止并标记 `max_followup_reached`

### 8.5 P1：Agent max_turns 谨慎设置 + 用户"继续工作"按钮

> 用户明确要求：达到 max_turns 后要提供按钮让用户可以选择继续工作。
> 详见审查报告 §11。**不能简单设置一个较小值了事**。

- [x] **P1** `agent.py:112-117` 设置 `max_turns=15`

      —— 覆盖正常 4-8 轮 + followup 3 轮 + 余量
      —— summarizer 保持 `max_turns=1`
      —— 当前使用 SDK 默认值（约 10），无硬约束

- [x] **P1** `runner.py:271` 检测 max_turns 用尽后走 `_await_user_input`

      —— **不直接转 FAILED**，而是发射
      `UserInputRequiredPayload(prompt_kind="max_turns_reached")`
      —— 暂停 Run，进入 `AWAITING_USER_INPUT` 状态
      —— **复用 §4.2.1 已完成的 pause-resume 底层架构**，不另建机制

- [x] **P1** `events.py` `PromptKind` 联合新增 `"max_turns_reached"`

- [x] **P1** `UserInputDialog.tsx` 新增 `max_turns_reached` 渲染分支

      —— 展示"Agent 已达到最大轮次，是否继续？"
      —— [继续] 按钮 → `POST /api/v1/tasks/{task_id}/runs/{run_id}/resume`
      —— [停止] 按钮 → 转 CANCELLED

- [ ] **P2** `agent.py` INSTRUCTIONS 新增"达到 max_turns 后应输出 `[MAX_TURNS_REACHED]` 标记"指导

### 8.6 P1：并发与资源管理

> 详见审查报告 §8。

- [ ] **P1** `crawler.py:206-225` 引入 BrowserPool

      —— 单例 Chromium + 多 context
      —— 4 并发 task 共享一个 browser，每个 task 用 `browser.new_context()` 隔离
      —— 当前每次调用新建 browser，4 并发可同时启动 4 个 Chromium，内存峰值高

- [ ] **P2** `crawler.py` 监控并发 Chromium 实例数，超阈值时排队

### 8.7 P1：错误处理与可观测性

> 详见审查报告 §9。与 §1.7 "Pipeline 全链路接入结构化日志"协同。

- [ ] **P1** `main.py:25-28` 引入 structlog 或 python-json-logger

      —— 所有日志带 `task_id` / `run_id` / `stage` 上下文
      —— 当前仅 `logging.basicConfig` 无 JSON formatter、无 task_id 关联

- [ ] **P1** 修复关键错误吞掉点

      —— `pipeline/state.py:228` `load_stage_output` 异常返回 None 无日志
      —— `pipeline/runner.py:617` `_collect_stage_output_files` 异常无日志
      —— `api/ws_events.py:362, 375, 381` WebSocket 错误静默吞掉

- [ ] **P2** 新增 `docs/observability.md` 文档化可观测性策略

### 8.8 P2：配置硬编码

> 详见审查报告 §12。

- [ ] **P2** `config.py` 扩展配置项

      —— `crawler_ua` / `crawler_rate_limit_seconds` / `compaction_*` /
      `stage_timeouts` / `max_download_bytes`
      —— 当前 `crawler.py:35-39, 58` / `compaction.py:27-29` /
      `runner.py:81-89` / `acquisition.py:34` 均硬编码

- [ ] **P2** `config.py` 启动时校验 `DASHSCOPE_API_KEY` 非空

      —— 否则 fail fast，避免延迟失败掩盖配置问题

- [ ] **P2** `config.py` `OUTPUT_DIR` 改为绝对路径默认值

      —— 当前默认 `data/output`（相对路径）cwd 依赖，生产环境风险

## 9. 前端 UI 改进

- [ ] 引入 <https://ui.shadcn.com/docs/components/base/command>
            <https://ui.shadcn.com/docs/components/base/context-menu>
            <https://ui.shadcn.com/docs/components/base/menubar>
- [ ] 修改当前对话界面，优化思维链呈现/产物呈现
- [ ] 引入对话路由，便于调试 & 厘清页面关系
