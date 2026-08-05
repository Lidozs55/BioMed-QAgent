# BioMed-QAgent 架构

> 本文描述当前批准的目标架构。详细数据契约与验收条件见
> [Backend Data Closure Design](archive/superpowers/specs/2026-07-12-backend-data-closure-design.md)。

## 1. 产品目标

用户输入一个研究主题，并可限制允许检索的数据库。系统自动完成：

1. 检索和理解相关论文；
2. 识别数据库、accession 和补充材料线索；
3. 下载并校验原始数据；
4. 解析、清洗、字段对齐和整合；
5. 输出可分析、可追溯、可复用的结构化数据包。

核心交付物是经过验证的 CSV、来源清单和处理记录，不是自然语言研究
结论。分析和可视化是可选加分项。

## 2. 当前架构结论

保留 OpenAI Agents SDK，不自研 Agent Runtime，也不推翻统一 Skill 仓库。
新增确定性 Pipeline，解决 Agent 可以跳步骤、遗漏来源或直接生成不可信 CSV
的问题。

```text
React/shadcn Frontend
        |
        | HTTP + WebSocket events
        v
FastAPI Task API
        |
        v
OpenAI Agents SDK Main Agent
        |
        | TaskSpecification
        v
Deterministic Pipeline Runner
        |
        +-- Discovery
        +-- Acquisition
        +-- Processing
        +-- Artifact Builder
        `-- Validation Gate
                 |
                 v
        validated artifacts/
```

### 2.1 Agent 的职责

- 理解用户主题和过滤条件；
- 生成 PubMed、GEO 等检索参数；
- 选择已启用 Skill 和数据库；
- 生成结构化 `TaskSpecification`；
- 调用 Pipeline Function Tool；
- 解释 Pipeline 返回的结构化错误或警告。

Agent 不直接拼装最终 CSV，也不能绕过 Validation Gate。

### 2.2 Pipeline 的职责

- 强制执行完整的数据阶段；
- 校验每个阶段的输入输出契约；
- 固化下载、解析、追溯和导出行为；
- 为模型、网络、解析和完整任务设置独立超时；
- 只发布通过验证的 Artifact；
- 失败时保证终态事件，不使用 mock 伪装成功；
- 接收 Agent 发现或补充的数据，但必须将其转换为统一的
  `SourceRecord` / `SourceAsset` / `ParsedDataset` 契约后再处理；
- 负责确定性合并、最终验证和正式 Artifact 发布，Agent 不直接合并或写入最终 CSV。

### 2.3 目标 Agent 编排工作流

系统采用“Agent 编排 + Pipeline 确定性发布”的迭代流程：

```text
Agent 初步分析与调研
    -> 版本化 TaskSpecification / ResearchPlan
    -> Pipeline Run #1
         -> validated_intermediate artifacts
    -> Agent 根据结构化结果评估进展
         |-- 可修复失败：新的 durable Run，完整或受控局部重跑
         |-- 有明确缺口：检索、浏览器、PDF 或其它数据库补充数据
         `-- 无新增证据：结束补充阶段
    -> Agent 补充数据注册为 SourceRecord / SourceAsset / ParsedDataset
    -> Pipeline 新 Run
         -> 确定性合并 + Validation Gate
         -> validated_final artifacts
```

这不是让 LLM 直接生成最终 CSV。Agent 只负责问题理解、候选发现、工具选择、
补充策略和映射建议；所有正式数据仍必须经过 Pipeline 的处理、追溯和 Validation
Gate。

### 2.4 迭代、重跑与版本决策

- 同一 Agent Run 内只允许一次 Pipeline publication；反复调用通过新的 durable
  Run 实现，避免同一 publication slot 的重入和不可审计覆盖。
- 完整重跑可以复用输入、参数和上游输出 digest 一致的已验证阶段；topic、来源、
  解析规则或字段映射变化必须形成新的 Run/版本。
- 局部重跑不是任意 `skip_stages`。服务端根据阶段依赖闭包从指定阶段重新执行，
  下游阶段不得消费 digest 不匹配的上游输出。
- 第一轮通过验证的结果标记为 `validated_intermediate`；合并 Agent 补充数据后
  重新构建并验证，才标记为 `validated_final`。旧版本 Artifact 保留，不被新 Run
  原地覆盖。
- Agent-only 数据源不自动等同于 Pipeline 支持；`pipeline_supported` 只表示该
  来源已经完成相应的搜索、元数据、下载、解析和验证闭环。来源能力以
  `SOURCE_CAPABILITIES` 单一事实表声明（TODO §1.4）：pubmed/geo/gdc/ucsc_xena/
  reactome 为 `pipeline_supported`，pdb/pubchem/browser 为 `research_only`。
  `TaskSpecification.declare_sources` 为每个选中来源生成输入级能力声明，
  `run_research_pipeline` 按能力表拒绝非 pipeline-supported 来源并返回
  `capabilities` 明细；skill catalog 的 `pipeline_supported` 与 `/databases`
  的 `capability` 字段均从该表派生，避免两套声明漂移。
- GDC Pipeline 首期接受显式 `project_id` + `gene-expression`。Live Acquisition 将
  该内部类型映射为官方 `Gene Expression Quantification`，并通过 `/files` 同时约束
  `data_format=TSV`；Processing 支持 GDC 官方 augmented STAR-counts（优先使用
  `tpm_unstranded`）及兼容 fixture 矩阵。Clinical TSV 仅保留 fixture 回归能力；live
  Clinical Supplement 在 HTTP 请求前 fail-closed，直至 XML 血缘解析器完成。
- 多源确定性合并（TODO §1.2/§1.5.4）：当 `TaskSpecification` 明确选择一个 GDC 与
  一个 Xena 数据集时，Discovery 与 Acquisition 保留两套来源/资产，Processing
  为每个数据集解析独立 `ParsedDataset`，通过
  `alignment.align_fields` 生成真实字段映射、`alignment.merge_datasets` 垂向合并，
  产出 `merged_dataset`（`parsed/{id}_merged.csv`）；Runner 将全部 `parsed_datasets`
  与 `merged_dataset` 传入 Artifact Build，合并结果作为 `main_data.csv` 发布，
  `field_mapping.csv` 按来源各一组真实映射，merge 步骤写入 `processing_log.csv`。
  合并包与单源包一样重新经过 Artifact Build + Validation Gate：`dataset_catalog.csv`
  每个输入数据集一行、`download_log.csv` 记录全部 attempt、`sample_metadata.csv` 按
  来源行聚合、lineage 校验按行 asset_id 路由到各自源文件，并生成
  `multi_source_manifest.csv`（dataset_id → database → row_count）声明合并构成。

### 2.5 Skill 和 Tool 的职责

以下职责是目标边界；当前后端仍有两类实现差距，不能将目标描述当作已完成能力：

- `PipelineRunner` 已覆盖 PubMed/GEO 主路径，GDC、Xena 和 Reactome 的首期显式
  单数据集路径，以及一个 GDC + 一个 Xena 的确定性合并路径。Reactome 仅接受一个
  显式 pathway，必须作为唯一来源运行；通用任意来源组合、mutation/CNV、GDC live
  clinical 与 Reactome 扩展数据类型仍未完成。
- Agent-only Skill 的文件记录仍主要通过 `RunContext.add_source()` /
  `add_raw_asset()` 保存到运行时字段；这些文件尚未统一转换为 Pipeline 的
  Pydantic `SourceRecord` / `SourceAsset` / `ParsedDataset`，因此不能直接作为正式
  Pipeline 数据或最终 CSV 的来源。
- Pipeline 的 `Validation Gate` 只约束 Pipeline 生成的研究数据包；直接由 Agent
  Skill 写入 `artifacts/` 的分析图表或报告属于未纳入正式发布闭环的辅助产物，后续
  必须明确其目录隔离或接入同一验证契约。

统一 Skill 仓库继续按四类组织：

```text
backend/app/skills/
|-- builtin/
|   |-- discovery/
|   |-- acquisition/
|   |-- processing/
|   `-- analysis/
`-- learned/
    |-- discovery/
    |-- acquisition/
    |-- processing/
    `-- analysis/
```

- Skill 是 instructions 与 Tool 的能力包；
- 一个网站可以有多个 Tool，不要求一个网站一个 Skill；
- 网站 Tool 分为 search、describe/metadata、download；
- download 记录 `DownloadAttempt`，成功校验后才返回 `SourceAsset`；
- processing 只接受成功的本地 `SourceAsset` 或 `ParsedDataset`；
- learned Skill 默认禁用，不能绕过 Pipeline 和 Validation Gate。

### 2.6 动态 Skill Catalog 与管理面

业务 Skill 统一由 lifespan 创建的进程级 `SkillCatalog` 管理。Catalog 合并随应用
发布的 builtin Skill 与外部应用数据目录中的用户 Skill，并通过不可变快照和单调
递增 `generation` 原子热更新。正在执行的单次调用固定到解析时的 Skill 版本；
后续调用读取最新快照。

该进程级 Catalog 必须由 lifespan 同时传给 `UserSkillStore` 和
`ModeDispatchRunExecutor`，并继续下传到 Agent 与 Import executor，确保管理面热更新
和后续 Run 使用同一个快照来源。提交 `5008c56` 最初建立了这条链路；合并提交
`2cf9a01` 保留了 `main.py` 中的 catalog-aware 调用，却从其本地父提交 `0110062`
恢复了 `runner.py` 的旧构造器，导致启动时出现 unexpected keyword argument。
`tests/runtime/test_manager.py::test_fastapi_lifespan_owns_runtime_executors_and_manager`
固定此共享实例和启动不变量，防止跨分支合并再次拆断调用方与实现方。

Main Agent 不再直接装载全部业务 Tool 或拼接每个 Skill 的 instructions。Agent 只
持有稳定的 `find_skill` / `invoke_skill` 网关、托管子 Agent 的
`delegate_research` / `get_subagent_results` / `cancel_subagent`，以及 Pipeline、
文件、压缩和 Reviewer 等核心 Tool。用户选择的数据库是 `preferred_sources`：
Main Agent 优先使用这些来源，但也可以探索公开、免登录且不需要私密凭据的其他
来源。登录、CAPTCHA、付费、凭据和服务条款边界仍必须进入 HIL。
`pipeline_supported` 只表示该来源能够进入确定性 Pipeline，普通 Agent-only Skill
和子 Agent 的自然语言结果都不能充当完成证据。

用户扩展支持声明式 JSON/YAML HTTP 数据库包和 Python ZIP Skill 包。用户包保存在
单文件程序之外的可写目录，支持校验、上传、启停、版本回滚和删除。坏包保持
`unavailable/load_error` 管理可见性，不阻断应用启动。设置页的 Model、Databases
和 Skills 三个区段使用对应 REST API 管理这些状态。

### 2.5 托管式 Subagent、WorkflowRecipe 与 Pipeline 边界

`SubagentSupervisor` 是 lifespan-owned 的运行时服务。Main Agent 可以在一个父
Run 内并行委派 `SourceResearchAgent` 和 `SkillBuilderAgent`；子 Agent 使用独立
SDK Session，不能递归委派、调用 Pipeline 或写入正式 `artifacts/`。Supervisor
实施单 Run 3 路、进程全局 4 路并发限制，并把 queued、running、progress、HIL、
cancel 和 terminal 状态写入父 Task 的同一 durable event log。单个子 Agent 的取消
端点为：

```text
POST /api/v1/tasks/{task_id}/runs/{run_id}/subagents/{subagent_id}/cancel
```

子 Agent 的网络或 Recipe 采集只能写
`staging/subagents/<subagent_id>/`。`SubagentStagingWorkspace` 校验路径、大小、
摘要和元数据后，才把文件原子提交为不可变 `SourceAsset`，并通过
`SubagentResult.source_asset_ids` 向 Main Agent 暴露轻量引用。新采集流程保存为
声明式、不可执行的 `WorkflowRecipe`；受控执行器固定采用 API → HTML → Browser
回退，记录每次尝试和回退理由。

当前 Agent ↔ Pipeline 边界不是把子 Agent 文件直接注入 Pipeline。Main Agent 使用
子 Agent 的结构化结果规划后续工作并提取 PMID、GSE 等 accession，随后调用
`run_research_pipeline`；Pipeline 仍从权威来源执行自己的确定性 Acquisition。
当两条路径获得相同字节时，内容寻址 `SourceAsset.asset_id` 相等，证明进入
Processing 和 Validation Gate 的是同一验证输入。正式 Artifact 仍只由 Validation
Gate 发布，子 Agent 的完成事件或 SourceAsset ID 本身不构成发布证据。

**视觉证据采集（web_visual_capture）**：
`acquisition/web_visual_capture.py` 提供 `capture_web_page` 与
`capture_page_section` 两个 function_tool。它只调用 RunContext 中由 lifespan
注入的 `CrawlerFacade`，由共享 `BrowserPool` 完成 Chromium 截图；PNG 和 metadata
sidecar 均先进入 `SubagentStagingWorkspace`，通过大小、摘要、路径和链接检查后再
commit 到任务 `source_assets/<asset_id>/`。该 Skill 不允许自行启动 Chromium、
创建 HTTP client 或直接写最终截图路径。

BrowserPool 只保有一个 Chromium，最多同时打开 4 个隔离 BrowserContext。每个
Context 强制 `service_workers="block"`，并使用独立凭据访问 loopback-only HTTPS
CONNECT 代理。代理在实际 CONNECT 层仅解析一次目标域名、拒绝非公网地址并直连该
固定 IP；Playwright route 继续负责 Recipe/source host allowlist。HTTP API/HTML
请求同样逐跳固定 IP、保留原始 Host/SNI、禁用自动重定向并为每次请求使用独立
transport，避免 DNS rebinding、跨 SNI 连接池复用和私网重定向。浏览器 HTML、
Recipe extract、截图像素和 PNG，以及普通下载均有硬上限。该 Skill 不出现在
`GET /databases` 列表中，由 Agent 按需调用。

**视觉模型图表数据提取（extract_chart_data_vlm）**：
`processing/extract_chart_data_vlm.py` 是 TODO §5.2 视觉模型降级方案的实现。
它接受**任意获取渠道**的论文产物（满足"视觉模型应设法处理任何获得方法的论文"
约束）：

- PNG/JPG/WEBP/GIF 图片 — 来自 `web_visual_capture` 截图、未来 skill 的独立
  下载、或外部用户提供的图片；
- PDF 文件 — 来自 `download_supplementary` 从 PubMed/PMC 下载的开放获取论文。

单一工具入口 `extract_chart_data_vlm(source_path, hint="")` 内部按 MIME 分派：
图片直接 base64 送 Qwen-VL；PDF 先用 `pdfplumber` 提取嵌入图片（每文件上限 10
张），再逐图送 VLM。VLM 客户端在 `app/agent_loop/vl_model.py` 中独立于
`LazyDashScopeModel`（模型名 `qwen-vl-max` vs `qwen-plus`，调用模式为一次性
`chat.completions.create` + `image_url` content part 而非 Agent 轮次）。

**三级降级链**（L1→L2→L3，全部失败抛 `ChartExtractionError`，project_memory
L1 禁止静默空数据降级）：

- L1 — Qwen-VL：主路径，要求 `DASHSCOPE_API_KEY`；返回严格 JSON
  `{chart_type, axes, data_points, legend}`，解析容错剥离 markdown fence 与
  尾部 prose；
- L2 — pdfplumber 表格：仅 PDF 触发，提取矢量 PDF 表格数据（非栅格图表替代）；
- L3 — caption 文本：兜底，正则提取 `Figure N.` / `Table N.` captions，写入
  `chart_type="caption_only"` 行并发出 `warning`。

产物：`parsed/chart_data/chart_data.csv`（每图一行）+
`parsed/chart_data/chart_data_points.csv`（每数据点一行），UTF-8 BOM 编码
（`utf-8-sig`，Excel 兼容，TODO §1.7）。每行 `source_asset_id=asset_<sha256>`
将 chart 追溯到原始图片/PDF。大图（>10MB）由 Pillow LANCZOS 自动降采样到
1920px 最长边以适配 DashScope inline base64 限制。`hint` 参数（如
`"scatter plot, log scale"`）注入 VLM prompt 增强歧义图表识别。

## 3. 核心数据契约

契约使用 Pydantic v2，统一继承 `ContractModel`，显式设置
`ConfigDict(extra="forbid", validate_default=True)`。集合使用
`default_factory`，所有序列化对象包含 `schema_version`。对象只保存路径和轻量
元数据，不把大型表格放入 Context。

### 3.1 TaskRequest

用户提交的需求：

- `topic`：唯一必填业务字段；
- `databases`：默认 `pubmed`、`geo`；
- `keywords`：可选关键词；
- `target_fields`：可选目标字段；
- `time_range`：可选时间范围。

### 3.2 TaskSpecification

Agent 生成的数据需求描述，包含：

- 原始主题；
- `QuerySpecification` 列表，区分用户、Agent 和 Pipeline 查询；
- 候选或固定数据集 accession；
- 请求的输出类型。

它不是任意代码或自由执行步骤。

`DatasetSelection` 明确定义 `dataset_id`、database、accession、source_id 和选择
理由。

### 3.3 SourceRecord 与 SourceRelation

描述论文、数据库记录或下载页面：

- `source_id`
- `database`
- `accession`
- `url`
- `title`
- `retrieved_at`

`SourceRelation` 使用证据字段表示论文到数据集、数据集到 BioProject/SRA 等关系，
不依赖 CSV 内不可验证的 ID 数组。

### 3.4 DownloadAttempt、FileAsset 与 SourceAsset

`DownloadAttempt` 记录每次成功、部分成功或失败下载：

- `attempt_id`
- `source_id`
- `url`
- `status`
- `bytes_received`
- `error_code` / `error_message`
- `started_at` / `finished_at`

只有完整下载并校验成功后才创建不可变 `SourceAsset`：

- `asset_id`
- `source_id`
- `successful_attempt_id`
- `relative_path`
- `sha256`
- `media_type`
- `size_bytes`
- `data_level`

`data_level` 区分 `raw_sequence`、`submitter_processed`、
`repository_processed` 和 `metadata`。GSE178352 tximport counts 属于 repository
processed，不称作原始测序数据。路径必须解析在任务 `source_assets/` 内。

所有阶段文件统一使用 `FileAsset`，记录 kind、路径、SHA-256、大小、media type、
schema version 和生成步骤。

### 3.5 ParsedDataset 与 SourceLocator

描述解析后的本地表格：

- `dataset_id`
- `source_id`
- `asset_id`
- `relative_path`
- `columns`
- `row_count`
- `parser_name`
- `parser_version`

`SourceLocator` 精确定义：

- 解压后的 logical file；
- 以 1 为基准、包含表头/注释/空行的物理文本行号；
- 以 0 为基准的列索引；
- 原始列名与原始 token。

固定案例对全部 source-derived expression value 执行回溯；一般任务验证全部结构
外键，并按配置抽样数值。

### 3.6 StageAttempt、Artifact 与 RunManifest

每次阶段执行创建独立 `StageAttempt`，包含输入摘要、参数摘要、输出摘要、attempt
序号和状态。阶段操作幂等；恢复时只复用摘要一致的成功输出。

描述通过验证的最终文件：

- `artifact_id`
- `name`
- `relative_path`
- `media_type`
- `size_bytes`
- `sha256`
- `generated_by`

`RunManifest`、Warning、Error 和事件 payload 都有正式 Pydantic schema。ID 生成、
枚举、外键和 schema version 在设计规格中固定。

## 4. Pipeline

### 4.1 Discovery

负责 PubMed、GEO 等来源的检索与元数据获取，输出结构化论文记录、数据集
候选、实际查询式、结果顺序和来源 URL。

Discovery 不生成最终科研数据行。对于显式 GDC/Xena gene-expression 数据集与
Reactome pathway participants，Discovery 输出统一的 `SourceRecord` 和数据集选择；
一个 GDC + 一个 Xena 可作为受支持的双来源组合，Reactome 仍仅支持单来源显式
`pathway_id`，其它混合来源不得伪装成 Pipeline 支持。

PubMed 优先使用 NCBI E-utilities，配置 tool、email、User-Agent、全局限速、批量
请求和 429/5xx 有界重试；记录 NCBI term translation 和分页参数。

### 4.2 Acquisition

负责下载和校验：

- 流式下载；
- 协议、大小和超时限制；
- 未完成字节写入 `download_tmp/`；
- 每次尝试记录 DownloadAttempt；
- 保留下载到的官方压缩文件；
- 计算 SHA-256 和字节数；
- 完整成功后创建 SourceAsset；
- 部分或失败文件永不交给 Parser。
- Xena gene-expression live acquisition 将显式数据集 accession 映射到 Xena hub
  `download/{dataset_id}.gz`，复用同一 `acquire_source()`、内容寻址缓存和
  `SourceAsset`/`DownloadAttempt` 契约；临床、突变、CNV 等 Xena 类型尚未纳入该闭环。
- GDC gene-expression live acquisition 使用官方 Files API 类型与 TSV 格式过滤；
  GDC + Xena 组合按规格顺序聚合全部 `SourceAsset`/`DownloadAttempt`。Live 模式的
  checkpoint 参数摘要不读取测试 fixture，因此生产包可以不包含 `tests/fixtures/`。

成功文件进入 `data/cache/blobs/sha256/` 内容寻址缓存；规范化 URL/accession/请求
参数映射到缓存元数据，关键词不作为资产身份。任务目录使用硬链接或校验后复制。

GEO live acquisition 采用两级候选回退：tximport counts → series matrix。当全部
候选下载失败时，acquisition 抛出 `DownloadError`，Pipeline Runner 将其映射为
`ErrorCode.NETWORK_ERROR` 且 `retryable=True`（与 `TIMEOUT` 同为可重试错误）。
Agent 收到 `status=failed`、`failed_stage=acquisition`、`error_code=network_error`、
`retryable=true`，可选择替代 GSE 重试或请求 HIL，而非将下载失败视为不可恢复的
内部错误。GDC/Xena/Reactome 的下载失败同样走此路径。

### 4.3 Processing

只读取成功的 `SourceAsset`：

```text
decompress
    -> parse
    -> validate schema
    -> clean
    -> field mapping
    -> normalize
    -> write ParsedDataset
```

每一步记录输入、输出、工具版本、参数摘要、处理前后行数、警告和时间。样本和
gene ID 规范化同时保留 raw value、canonical value 与规则。

GEO 表达数据的解析采用三级回退链，确保 `main_data.csv` 在 counts 缺失时仍能
携带真实表达值或至少样本元数据：

```text
tximport counts (首选，整型 estimated count)
    |-- 失败/缺失/404
    v
series_matrix 表达矩阵块 (!series_matrix_table_begin/_end)
    |-- 空块 (snRNAseq / RNA-seq 系列常见)
    v
sample_metadata 元数据行 (每样本一行，source_line_number=0)
```

- `process_geo_tximport_counts` 解析 `*_tximportCounts.txt` 长格式表，gene ID
  命名空间为 `ensembl_gene`，`measurement_type=tximport_estimated_count`。
- `process_geo_series_matrix_expression` 解析 series_matrix 表达矩阵块，gene ID
  命名空间为 `geo_id_ref`，`measurement_type=series_matrix_expression`，
  `value_scale=log2`（已归一化）。空块返回 `None`，由调用方继续回退。
- `_build_minimal_parsed_dataset` 写入每样本一行 `sample_metadata` 元数据行，
  `source_line_number`/`source_column_index` 置 `0` 标识"无源行号"；
  Validation Gate 的 `source_value_lineage` 检查跳过这些行（无表达值可校验）。

`_try_series_matrix_expression_or_minimal` 统一 fixture 与 live 两条路径的回退
入口，保证无论 tximport 是否可用，`main_data.csv` 都不会出现零行占位。GDC 官方
STAR-counts 跳过统计汇总行、规范化 Ensembl 版本号并保留原始值与物理行列定位。

### 4.4 Artifact Builder

Builder 在 `staging/` 生成输出包。论文、数据集目录、样本元数据和最终科研
数据必须分表保存。

### 4.5 Validation Gate

以下条件全部满足后才把 staging 原子提升为 `artifacts/`：

- `main_data.csv` 每个 `source_id` 都存在；
- `dataset_id` 和 `sample_id` 外键完整；
- 每个 `asset_id` 都存在于 source asset 记录，并关联成功 DownloadAttempt；
- source asset 存在且 SHA-256 一致；
- 主数据所有字段都有字段说明；
- `main_data.csv` 至少包含一条可回溯到来源文件的核心科研记录；
- 每个源数据派生测量有精确 SourceLocator；
- 固定案例全量回溯表达值；一般任务全量检查结构并默认抽样 100 个值；
- processing log 含完整输入输出和行数；
- CSV 编码和列数稳定；
- warnings 与 metrics 计数一致；
- 所有必需 Artifact 存在且非空。

失败报告写入 `logs/validation_report.json`，无效文件不得出现在 Artifact API。
发布使用任务锁、独立 staging、文件 flush、manifest 验证和同文件系统原子 rename；
发布成功后才产生 artifact 和 completed 事件。

## 5. 任务目录

```text
data/output/tasks/<task_id>/
|-- source_assets/# 不可变来源文件（包括 Agent 补充来源）
|-- download_tmp/ # 不完整下载
|-- parsed/       # 解析结果
|-- normalized/   # 清洗和字段对齐结果
|-- staging/      # 按 run_id 隔离的候选产物
|-- artifacts/    # 已通过验证的当前交付物版本
|-- state/        # 任务锁和恢复状态
`-- logs/         # stage attempts、事件、验证和诊断记录
```

Agent 的查询、选择理由、进度判定和提取记录可以保存在任务级
`agent_results/` 中，但大型原始数据不得重复存放；原始文件统一进入
`source_assets/`，并通过 SourceAsset/ParsedDataset 进入 Pipeline。

```text
agent_results/    # Agent 决策、查询和提取审计记录（可选）
```

API 只公开 `artifacts/`。

## 6. 标准产物包

```text
artifacts/
|-- run_manifest.json
|-- main_data.csv
|-- literature.csv
|-- dataset_catalog.csv
|-- sample_metadata.csv
|-- field_descriptions.csv
|-- field_mapping.csv
|-- source_list.csv
|-- source_relations.csv
|-- source_assets.csv
|-- download_log.csv
|-- processing_log.csv
|-- quality_report.csv
`-- warnings.csv
```

### 6.1 main_data.csv

只能包含一种行粒度。GSE178352 案例中一行表示一个基因在一个样本中的表达
测量：

```text
record_id,dataset_id,source_id,asset_id,gene_id_raw,gene_id,
gene_id_namespace,gene_id_version,sample_id,measurement_type,
value_semantics,value_scale,is_normalized,is_integer_expected,
expression_value,expression_unit,source_logical_file,source_line_number,
source_column_index,source_column_name,source_raw_value
```

论文元数据进入 `literature.csv`，数据集元数据进入 `dataset_catalog.csv`。

### 6.2 追溯文件

- `source_list.csv`：来源与 accession；
- `source_relations.csv`：来源间关系和证据；
- `source_assets.csv`：成功资产、data level、checksum 和成功 attempt；
- `download_log.csv`：每次下载尝试、字节数、状态和错误；
- `field_mapping.csv`：原字段到标准字段的映射；
- `processing_log.csv`：所有处理步骤；
- `quality_report.csv`：验证规则及通过/失败数；
- `run_manifest.json`：输入、计划、版本、时间和 Artifact 列表。

CSV 中的结构化单元格使用有效 JSON，不使用 Python 字典字符串。

## 7. 固定真实验收案例

Phase 1 固定案例：

- Topic：`breast cancer gene expression under Hsp70 inhibition`
- PubMed：PMID `34180400`
- GEO：`GSE178352`
- 样本数：12
- 处理后计数文件：`GSE178352_tximportCounts.txt.gz`
- GEO：`https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352`

默认测试使用记录来源与裁剪范围的真实 fixture；标记为 `live` 的集成测试下载
完整官方文件并验证 checksum、样本标识和解析兼容性。

Mock Demo 仅作为开发烟雾测试，不能满足正式验收，也不能在真实流程失败后自动
转为成功。

## 8. Durable API、控制面与事件面

FastAPI lifespan 初始化唯一的 `TaskManager`、`TaskRepository`、durable `EventHub`、
内存 `AssistantStreamHub` 和 `TaskIndex`。当前 REST surface 如下（统一前缀
`/api/v1`）：

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/databases` | 列出用户可选数据库 |
| GET | `/tasks` | 返回全部 active Task 与 cursor 分页的历史 Task |
| POST | `/tasks` | 创建 durable Task 并排队首个 Run |
| GET | `/tasks/{task_id}` | 返回权威 `TaskSnapshot` |
| DELETE | `/tasks/{task_id}` | 删除 terminal Task 及其历史 |
| POST | `/tasks/{task_id}/runs` | 为 idle Agent Task 排队下一轮 Run |
| POST | `/tasks/{task_id}/runs/{run_id}/cancel` | 取消 queued/running/paused/finalizing/cancel-requested Run |
| POST | `/tasks/{task_id}/runs/{run_id}/resume` | 提交人在回路决策 |
| GET | `/tasks/{task_id}/messages` | cursor 分页读取 durable messages |
| GET | `/tasks/{task_id}/events` | 按 `after_sequence` 重放 durable events |
| GET | `/tasks/{task_id}/artifacts` | 列出 manifest 注册且已验证的 Artifact |
| GET | `/tasks/{task_id}/artifacts/{artifact_id}` | 按 Artifact ID 下载并校验文件 |
| GET | `/settings` | 当前用户模型设置（api_key 掩码返回） |
| POST | `/settings` | 更新并持久化用户模型设置；api_key 省略/掩码=保留，空串=清除，非空=替换 |
| GET | `/vendors` | 列出已知模型供应商 |
| GET | `/models` | 可用模型列表，支持 `?query=` 搜索、`?preview_base_url=` 预览、`?use_current_settings=` 带凭据发现；不安全 URL → 422，供应商失败 → 502 |
| GET | `/models/{model_id}` | 单个模型详情 |

### 8.1 后端权威状态

每个 Task 的 durable runtime 数据都保存在后端：

- `<task_id>/events.jsonl` 是 append-only 事件日志；`EventStore` 强制 sequence 从 1
  开始连续递增，`TaskRepository` 先持久化再向 `EventHub` 发布；
- `<task_id>/state/task_snapshot.json` 是原子写入的权威状态投影；snapshot 落后于
  event log 时，repository 通过纯函数 `reduce_task_event` 补齐投影；
- `<task_id>/state/session_items.jsonl` 保存 OpenAI Agents SDK 的原始 Session 历史，
  `conversation_summary.json` 保存 compaction 摘要；前端不保存会话事实；
- `task_index.sqlite3` 只承担分页和 request-id 幂等查询，可由 snapshot/event 重建，
  不是会话事实来源。

`EventEnvelope` v2 为 managed Run 增加 `run_id`。Run 生命周期、Agent 活动和经
Agent Tool 桥接的 Pipeline 事件都使用 `schema_version="2.0"`；sequence 是
**Task 级单调递增**，不是每个 Run 重新计数。旧 fixture envelope 仍兼容 v1，
可以没有 `run_id`，stage 事件继续校验 `stage_attempt_id`。

### 8.2 WebSocket 重放

WebSocket 端点为 `/api/v1/ws`，只接受三类命令：

- `{"type":"subscribe","task_id":"...","after_sequence":N}`：先重放
  `sequence > N` 的 durable events，再无缝进入 live fan-out；
- `{"type":"unsubscribe","task_id":"..."}`：取消该 Task 的订阅；
- `{"type":"ping"}`：返回 `{"type":"pong"}`。

服务端输出分为两条通道：

- durable 通道发送带 Task sequence 的 `EventEnvelope`，并继续发送 `pong` / `error`
  控制帧；服务端按 Task watermark 去重，若 live sequence 出现间隙，会先从
  repository 补齐；
- realtime 通道发送无 sequence 的 `assistant_stream_delta` 和
  `assistant_stream_end`。它由 lifespan 管理的 `AssistantStreamHub` 提供，仅驻留
  内存、best-effort fan-out，不写入 event log；每个订阅队列有界，慢消费者会以
  可重连状态关闭，Run 的 durable 写入与执行不受影响。

Agent 收到模型文本 chunk 后，先发布 `assistant_stream_delta`，再放入 durable
buffer。buffer 按 100 ms / 1 KB 批量写为 `assistant_delta`，并在工具调用、正常或
截断结束、异常与取消路径上强制结束并 flush。durable payload 可携带
`stream_id + from_chunk_index + through_chunk_index`；三个字段必须同时出现或同时
省略，省略时兼容旧事件。实时帧丢失或断线时，完整文本仍由 durable event log
恢复。

`runtime/transport.ts` 自动重连并携带每个 Task 的 durable watermark 重新
subscribe；`runtime/controller.ts` 在 snapshot/accepted-Task handoff 时使用 REST
`/events` 重放。WebSocket 不接受创建 Run 的命令，也不提供 SSE。

### 8.3 人在回路与并发

Agent 模式的计划确认会持久化 `user_input_required`，纯 reducer 将 Run 投影为
`awaiting_user_input`。`POST /resume` 必须匹配当前 Run 的 exact `request_id`，且
同一请求只消费一次；批准后持久化 `user_input_resumed` 并回到 `running`，拒绝或
独立 HIL timeout 会使权威 Run 失败。取消 paused Run 会唤醒 Pipeline 的协作式
取消等待，不必等到 HIL timeout。fixture 模式仍记录 required/resumed 审计事件，
但以 `fixture_exempt=true` 自动批准且不阻塞。

默认全局有 4 个 active Run slot 和 4 个 worker；不同 Task 可以并行执行，同一
Task 只允许一个 nonterminal Run，后续提交返回冲突。`awaiting_user_input` 期间仍
占用原 slot，避免暂停任务被队列中的新任务抢占。

### 8.4 模型配置 API 与 Run 自有生成设置

五个 REST 端点为前端提供模型配置能力。

**GET/POST /api/v1/settings**

`ModelConfiguration` 存储 `base_url`、`api_key`、`model_name`、输出上限
`max_tokens`、可选输入窗口覆盖 `context_window`、上下文预算比例，以及
`AdvancedParams`（temperature、top_p、repetition_penalty、enable_search、
thinking_mode）。GET 同时返回已解析的窗口来源、保留 token 数和可用输入容量。
空 `api_key` 返回空串，长度不超过 12 的非空 key
返回 `****`，更长的 key 返回前 4 + `...` + 后 4 字符。
POST 合并语义：

- 字段为 `None` 时跳过（保留现有值）。
- `api_key`：省略或等于掩码 → 保留；空串 → 清除；非空 → 替换。
- `context_window`：省略 → 保留当前覆盖；正整数 → 记录用户覆盖；显式 `null` →
  清除覆盖并恢复已知模型的精确目录值（优先模型信息库，其次按命名约定猜测，最终
  回退 512K）。任务是否可运行只取决于解析后是否仍有正的输入容量，与是否显式设置
  窗口无关。
- 完整合并候选必须满足 `0 <= safety_reserve_ratio <= 0.25`、
  `0 < compaction_target_ratio < compaction_trigger_ratio < 1`，且输出上限与安全保留
  之后仍有正的输入容量。校验失败不会修改内存快照或持久化文件。
- 原子持久化到 `data/user_settings.json`。持久化文件中的 `api_key` 字段（包括
  空串）是权威值；只有文件或字段缺失时才从 `DASHSCOPE_API_KEY` 回退，确保显式
  清除在重启后不会被环境变量恢复。其他空字段仍按现有环境变量契约回退。
- 应用入口使用 `TrustedHostMiddleware`，仅接受 `127.0.0.1` 与 `localhost`，阻断
  DNS rebinding 页面通过恶意 Host 访问本地设置控制面。

**GET /api/v1/vendors**

返回静态已知供应商列表，含 `id`、`name`、`base_url`、`description` 和
`recommended` 标记。

**GET /api/v1/models**

查询参数 `query`（搜索过滤）、`preview_base_url`（临时供应商 URL）、
`use_current_settings`（使用已保存凭据进行带凭据发现）：

- 提供 `use_current_settings=true` 或非空 `preview_base_url` 时，服务端向
  供应商 OpenAI 兼容端点发送 `GET /models` 以发现可用模型。
- 已保存 API Key 仅在预览 URL 与已保存 `base_url` 相同时复用；跨端点预览默认
  无凭据，除非请求显式提供本次预览 Key。
- 带凭据发现要求 HTTPS（`http://` + 非空 key 视为不安全）。
- HTTP 客户端**不**跟随重定向（`follow_redirects=False`，10s 超时）。
- 服务端仅解析供应商域名一次，校验所有解析结果均为公网地址后，直接连接已校验
  的 IP；原域名仅通过 `Host` 与 HTTPX `sni_hostname` 传递，以同时保持 TLS
  证书校验并消除 DNS 校验与连接之间的重绑定窗口。
- 不安全供应商 URL 返回 422；供应商网络故障返回 502。
- API 发现的模型优先使用内置目录（含 model_info 信息库回退）补充精确、版本化的
  上下文窗口；未知模型仍可显示，并返回按命名约定猜测的窗口（无匹配时默认 512K），
  前端据此在选中模型时把上下文初值设为该窗口上限。
- 未提供发现 URL 时不发起供应商请求，返回空模型列表；内置目录用于补充已发现
  模型的元数据和单模型详情查询。

**GET /api/v1/models/{model_id}**

返回单个内置模型完整详情，不存在时返回 404。

**Run 自有生成设置**

每个 Run 在构造时捕获不可变 `RunModelSettings` 快照（通过
`run_model_settings_scope` contextvar），将 Agent 与并发的设置变更隔离。
快照包含模型身份与凭据（`base_url`、`api_key`、`model_name`）、六个生成
参数，以及不可变 `ContextBudget`。预算保留精确目录窗口或用户覆盖、窗口来源、
tokenizer 类型、校准余量和本 Run 的触发/目标 token 数；运行期间的设置变更和
新校准只影响后续 Run。

到 OpenAI Agents SDK `ModelSettings` 的映射：

| RunModelSettings 字段 | SDK ModelSettings 字段 | 说明 |
|---|---|---|
| `max_tokens` | `max_tokens` | 直接映射 |
| `temperature` | `temperature` | 直接映射 |
| `top_p` | `top_p` | 直接映射 |
| `repetition_penalty` | `extra_body.repetition_penalty` | 仅 DashScope |
| `enable_search` | `extra_body.enable_search` | 仅 DashScope |
| `thinking_mode` | `extra_body.enable_thinking` | 仅 DashScope |

DashScope 专有字段仅在 `model_name` 以 `qwen`/`qwq` 开头且 `base_url` 的 host
与 path 匹配 `dashscope.aliyuncs.com/compatible-mode/v1` 时发送，否则 `extra_body`
为 `None`。标准字段（max_tokens、temperature、top_p）始终发送。
`false` 值被显式保留发送。

### 8.5 Token 估算、压缩与校准

输入容量按以下公式捕获一次：

```text
safety_reserve_tokens = max(16384, ceil(context_window * safety_reserve_ratio))
input_capacity = context_window - max_tokens - safety_reserve_tokens
trigger_tokens = ceil(input_capacity * compaction_trigger_ratio)
target_tokens = ceil(input_capacity * compaction_target_ratio)
```

默认比例为安全保留 `0.05`、压缩触发 `0.85`、压缩目标 `0.60`。安全保留只从
容量中扣除一次，不重复加入 prompt 估算。完整估算覆盖已解析 instructions、工具
schema 的紧凑排序 JSON、Session items、当前输入、Chat Completions wrapper 与历史
校准余量。

Qwen/QwQ 在安装 `qwen-tokenizer` extra 时尝试使用本地
`dashscope.get_tokenizer(model).encode`；默认安装和不支持的模型使用确定性的 UTF-8
字节上界。运行路径不调用远程 `dashscope.Tokenization.call`，也不把
`o200k_base` 当成 Qwen tokenizer。每次成功请求的最终 provider usage 是权威值；
只保存 `actual_prompt_tokens - estimate_without_margin` 的正残差。校准按标准化
provider origin + model 分组，仅保留最近 20 个正残差，采用最大值并限制在精确窗口
的 10%，不保存 prompt 内容。

`AgentRunExecutor` 在每一次 `Runner.run_streamed` 之前执行预算预检，包括首轮、
获批的 MaxTurns continuation 和 Qwen 非法 function arguments 重试。超过触发值时，
压缩器以完整 Run 为最小单元，先摘要最旧段并保留最新段，再缩短摘要或移除最旧完整
段，直到不高于目标值；固定 instructions、tools、当前输入与输出保留本身已超容量时，
在 provider 调用前抛出类型化配置错误。重复用户输入导致的对齐歧义会保留已验证的
durable summary，把歧义后缀作为不可拆分保守段，并发出降级 warning。原始 SDK
Session 仍 append-only，`conversation_summary.json` 与 durable event 继续按原子提交
和回滚契约持久化。

live 比较位于 `tests/live/test_context_budget_estimator_live.py`。它使用固定双语消息
和最小工具，通过最终 streaming `include_usage` 比较 provider prompt token，并验证
校准残差。默认 pytest 会排除所有 `live` 测试；任意显式 `-m` 表达式完全交给 pytest
处理。运行命令：

```bash
uv run pytest -m live tests/live/test_context_budget_estimator_live.py -v
uv run --extra qwen-tokenizer pytest -m live tests/live/test_context_budget_estimator_live.py -v
```

Agent 文本模型发送凭据前同样要求公网 HTTPS URL。`LazyDashScopeModel` 显式持有
其创建的 `AsyncOpenAI` 客户端，不依赖 Agents SDK delegate 的默认 `close()`；
Run 清理时先解除内部引用，再关闭 delegate 和底层客户端，因此构造失败与重复
`close()` 都不会泄漏或重复关闭连接池。

**VLM 调用语义**

VLM 模块（`app/agent_loop/vl_model.py`）执行一次性 `chat.completions.create`
调用，固定 `model="qwen-vl-max"`、`temperature=0.1`。每次调用：

- 接收显式 `RunModelSettings` 快照（Run 自有凭据和 base URL）。
- 创建全新 `AsyncOpenAI` 客户端。
- 通过 `require_model_credentials` 校验凭据。
- 在 `finally` 中关闭客户端后返回。
- 不同于实现 Agents SDK `Model` 接口的 `LazyDashScopeModel`（对话轮次），
  VLM 不是 Agent 模型。

### 8.5 Agent SDK 动态 instructions 契约

Main Agent 使用动态 instructions，在每轮模型调用前把当前 Run 的已完成检索记录
注入 system prompt。该 callable 必须遵守 OpenAI Agents SDK 的公开二参数契约
`(context, agent)`；即使实现只读取 `context`，也不能省略 `agent` 参数。

2026-07-21 的故障中，提交 `05f32c9` 将该 callable 实现为单参数 `(context)`。
OpenAI Agents SDK 0.18.2 在首轮解析 instructions 时拒绝此签名，因此 durable event
只出现 `run_queued -> run_started -> run_failed`，尚未来得及产生模型或 Tool 事件；
权威错误为：

```text
'instructions' callable must accept exactly 2 arguments (context, agent), but got 1: ['ctx']
```

SDK 日志中的 `Resetting current trace` 是异常后的 trace 清理，不是根因。该故障与
模型凭据、上下文压缩和 `2cf9a01` 的 merge drift 无关。修复保持检索记录注入逻辑
不变，只补齐二参数签名。`tests/test_agent.py::test_dynamic_instructions_resolve_through_sdk`
通过 SDK 的 `Agent.get_system_prompt()` 公共边界解析动态 instructions，防止只检查
callable 存在性而遗漏 SDK 契约回归。

## 9. 前端实现架构

前端已按后端 durable 契约实现为任务工作台，而不是聊天窗口加日志：

```text
任务创建
    -> 计划确认
    -> 对话流（coding agent 风格步骤流）
         |-- 用户输入
         |-- 思维链（reasoning，默认折叠）
         |-- 工具调用（带 arguments 标签，可展开）
         |-- 阶段 / 进度 / 警告 / 产物（紧凑单行）
         `-- Assistant 文本段（按 tool call 分段）
    -> 结果 Tabs
         |-- 主数据
         |-- 文献与数据集
         |-- 来源与下载
         |-- 处理记录
         `-- 警告与质量
```

使用 shadcn 的 Form、Card、Tabs、Table、Badge、Progress、Dialog、Sheet 和
Toast。全局只保留一个任务/Event client，避免连接与发送属于不同实例。

启动时并发加载数据库、第一分页后端历史（全部 active Task + 默认 30 条 inactive
history）和 WebSocket，但保持 `activeTaskId=null`，展示独立的新研究草稿；后续
历史通过 cursor 加载并按不可变 `(created_at DESC, task_id DESC)` 排序去重。

`tasksById` 中每个 Task 都有独立的 Run、message、activity、artifact、fixture
stage、`subagentsById`、`subagentOrder` 和 `lastSequence` 投影。桌面端右侧
`ResizablePanel` 展示子 Agent 工作区，移动端复用 Sheet；产物入口位于聊天输入区
FAB。单子 Agent 取消通过 controller 串行化到 Task handoff，先从当前
`lastSequence` 回放到取消响应 snapshot 的 `latest_sequence`，再 hydrate snapshot，
因此断线重连不会重复或丢失 `subagent_cancel_requested` 状态。HIL prompt 同时绑定
`task_id + run_id + request_id`；
`UserInputDialog` 使用该 Run 提交，并用 prompt key 与 submission attempt ID 隔离
A → B → A 切换中的旧 Promise settlement。resume 事件只清理匹配 Run 与 request
的 prompt，terminal 事件按所属 Run 清理，新 Run admission 则清理上一轮 prompt。
侧栏把 `awaiting_user_input` 计入"运行中 N / 4"，与后端 slot 占用一致。

Assistant 文本采用 realtime/durable 双投影：实时 chunk 按 `(run_id, stream_id,
chunk_index)` 进入 pending，durable `assistant_delta` 的 chunk 范围推进 confirmed
watermark 并移除已确认 pending。durable 先到、实时帧迟到或重放重复时都会按该
watermark 去重，因此在线文本与断线重放后的最终文本收敛一致；无 sequence 的实时
帧不会推进 `lastSequence`。Transport 在 WebSocket 收帧后立即排队，并在下一次
`requestAnimationFrame` 合并更新；消息区继续复用 `MessageScroller` 自动跟随。
仅当对应 stream 实际生成文本且仍为 active 时，Markdown 末尾显示装饰性闪烁光标，
stream end、工具开始、Run finalizing/终态、断连或取消订阅后关闭，并遵循
`prefers-reduced-motion`。

R5 前端修复还补齐了非聊天区域的有界滚动、刷新竞态下的稳定 Task 排序、后台
通知"查看"失败反馈，以及 Bubble 中多行 assistant 文本的换行保留。

### 9.1 对话流展示（Coding Agent 风格）

对话主流使用"按时间顺序交错的步骤流"展示，所有事件类型统一投影到
`ConversationItem` 列表，按 `sequence` 升序渲染。设计目标：让用户输入、思维链、
工具调用、阶段进度、产物、警告、Assistant 总结汇报都以独立项的形式内联展示，
类似 Cursor / Claude Code 的对话体验。

**ConversationItem 联合类型**（`frontend/src/runtime/types.ts`）：

| kind | 来源事件 | 渲染组件 | 默认状态 |
|------|----------|----------|----------|
| `user_message` | `MessageRecord(role=user)` hydrate | `UserMessageBubble` | 右对齐气泡 |
| `assistant_segment` | `assistant_delta`（按 `stream_id` 分段） | `AssistantSegment` | 展开，流式时末尾 `▋` 光标 |
| `reasoning` | `assistant_reasoning_delta`（按 tool call 分段） | `ReasoningBlock` | 折叠；流式时展开；流式结束 500ms 后自动折叠 |
| `tool_call` | `tool_started` + `tool_completed` | `ToolCallStep` | 折叠（仅显示标签行）；running 时 Spinner，error 时 WarningCircle，completed 时 CheckCircle |
| `stage` | `stage_started/completed/failed/skipped` | `StageStep` | 展开（紧凑单行） |
| `progress` | `stage_progress` | `ProgressStep` | 展开（紧凑单行，同 kind 原位更新） |
| `warning` | `warning` | `WarningStep` | 展开（紧凑单行，黄色） |
| `artifact` | `artifact_produced` | `ArtifactStep` | 展开（紧凑单行，含文件大小 Badge） |

**itemId 规则**（reducer 按 itemId 去重 + sequence 排序）：

- `assistant:${streamId}` — 同一 stream_id 的 delta 累积到同一项；工具调用打断后
  segment_index 递增，自动开新段
- `reasoning:${runId}:${segmentIndex}` — 收到 `tool_started` 时 segmentIndex++，
  实现思维链按 tool call 分段
- `tool:${runId}:${toolCallId}` — started/completed 共用同一 itemId
- `stage:${runId}:${stage}` — started/completed/failed/skipped 共用
- `progress:${runId}:${stage}:${kind}` — 同 kind 原位更新
- `warning:${sequence}` / `artifact:${runId}:${artifactId}`
- `msg:${messageId}` — MessageRecord hydrate（user/assistant 旧消息）

`run_queued` / `user_input_required` / `user_input_resumed` /
`conversation_compacted` / `plan_ready` / Run 终态事件**不创建 item**，分别由
ChatPanel 草稿态、`pendingUserInput` + UserInputDialog、状态条分隔符处理，避免与
MessageRecord hydrate 重复。

**toolLabels 映射**（`frontend/src/components/conversation/toolLabels.ts`）：
`toolName + arguments` → `{ verb, target, details? }` 三元组，如
`search_pubmed_adapter + {query: "lung cancer"}` → `{verb: "检索", target: "PubMed",
details: "查询: \"lung cancer\""}`。状态条和 ToolCallStep 标签行复用同一映射，
未在表中的工具兜底显示"调用 {toolName}"。

**状态条简化**：Run running 时，`selectActiveItem` 返回最后一个活跃 item
（`isStreaming=true` 或 `status=running`），ChatPanel 顶部 Marker 显示
`formatActiveItemStatus(item)` 简述（如"检索 PubMed · 查询: 'lung cancer'"）；
无活跃 item 时回退到 `STATUS_LABELS[task.status]`。

**向后兼容**：reducer 仍保留 `messages` / `activitiesById` / `assistantStreamsByRunId`
字段以支持旧事件回放和分页加载（`mergeOlderMessagePage`），但 ChatPanel 渲染只依赖
`items`。`MessageRecord` hydrate 通过 `projectMessageToItem` 投影到 items 列表，
事件回放覆盖 hydrate 项（以事件为准）。

## 10. 开发阶段

### Phase 1：后端真实闭环

PubMed + GEO、数据契约、固定真实案例、Pipeline、Artifact Builder、Validation
Gate、离线和 live 测试。

### Phase 2：Agent 与 API

结构化 TaskSpecification、Pipeline Function Tool、任务 API、统一事件、超时和
取消。

### Phase 3：shadcn 前端重写

任务创建、计划确认、执行状态、结果表格和 Artifact 下载。

### Phase 4：扩展能力

先增加 PDF/补充材料，再按同一契约接入 GDC、PDB、Xena。任何来源只有在
search、metadata、download 的 live 测试通过后才能标记为支持。

## 11. 非目标

- 替换 OpenAI Agents SDK；
- 通用 Workflow Engine；
- 可执行 Recipe 或由模型直接生成 Python Skill；
- Agent 或 learned Skill 绕过 Validation Gate；
- 将 mock 产物当作正式案例；
- 自动生成缺乏数据依据的科研或临床结论；
- 后端事件和 Artifact 契约稳定前重写前端。

## 12. 当前实现证据（2026-07-30）

- 默认离线后端测试以 `uv run pytest` 的当前结果为准；Ruff
  `app/ tests/ launcher.py` 为零告警门禁，默认测试不访问网络。
  `filterwarnings = ["error", ...]` 把所有告警升级为失败，仅显式忽略 Starlette
  TestClient 弃用告警。
- live 验收：PMID 34180400、GSE178352 元数据和官方
  `GSE178352_tximportCounts.txt.gz`（4,597,797 bytes，SHA-256
  `71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55`）。
  多课题 live 验收（阿尔茨海默病 / TP53 / Huntington's）均完整产出 14 个
  artifact。
- fixture 闭环：48 条 gene + sample 记录（4 genes × 12 samples），全部通过精确
  SourceLocator 回溯，生成 14 个正式文件。
- API：完整 task/run/history/messages/events/cancel/resume/artifact 控制面（11 个
  REST 端点 + 1 个 WebSocket 端点）已接入 lifespan-owned durable runtime；下载只
  接受 manifest 注册的 `artifact_id`。
- Agent：OpenAI Agents SDK 保留为 Runtime，正式产物通过单一
  `run_research_pipeline` Function Tool 进入确定性 Pipeline。`AGENT_MAX_TURNS=15`
  常量覆盖正常 4-8 轮 + followup 3 轮 + 余量；达到上限走
  `UserInputRequiredPayload(prompt_kind="max_turns_reached")` 暂停 Run 等待用户
  选择继续或停止（不直接转 FAILED）。`AgentRunExecutor` 在
  `finish_reason="length"` 时发射 `WarningPayload(code="llm_output_truncated")`，
  `final_output` 为空时抛 `RuntimeError` 拒绝静默完成；`max_turns` 用尽或 LLM 不调
  tool 时通过 `agent_executed` 标记 + 空事件转 `RunFailedPayload` 而非
  `RunCompletedPayload`。`QWEN_FUNCTION_ARGS_RETRY_LIMIT=2` 自动重跑 LLM 返回的
  非法 JSON function arguments。
- Durable runtime：`events.jsonl`、snapshot 和 Session 历史均由后端持久化；
  `EventEnvelope` v2、按 Task sequence 续读、4-slot 跨 Task 并发、同 Task 串行、
  queued/running/paused 取消和重启恢复均已实现。`TaskManager._execute` AGENT 模式
  增加"成功证据校验"：`completion_events` 为空且无 cancellation 时转
  `RunFailedPayload`，错误信息 `"agent 完成但未产出 artifact"`。
- HIL：真实 Agent Tool 路径已接入权威 event/resume bridge，覆盖 exact one-shot
  request identity、拒绝/超时失败、paused cancellation 和 fixture 自动批准审计。
  `UserInputRequiredPayload.prompt_kind` 联合覆盖 `plan_confirmation` /
  `max_turns_reached` / `data_correction`。前端 `UserInputDialog` 按 Run 与
  submission attempt ID 隔离 A → B → A 切换中的旧 Promise settlement。
- 前端 Agent 可见性：`StageProgressPayload`（`stage` / `kind` / `current` /
  `total` / `detail`）跨 Agent / Pipeline 模式发射，Skills 在 `log_query` 后发射
  `discovered_records` / `downloaded_bytes` / `cleaned_rows` 进度事件。前端
  删除 stage 事件 Agent 模式丢弃守卫，`AgentProgress.tsx` 增加跨模式 stage/进度
  chips。前端 Vitest、ESLint 零告警、TypeScript typecheck 和 production build
  均为合并门禁；当前模型设置回归同时覆盖读取、保存、取消与乱序 settlement。
- 视觉证据采集：`web_visual_capture` skill（`capture_web_page` +
  `capture_page_section`）使用 Playwright Chromium 截图，产物为内容寻址 PNG
  （`source_assets/figures/fig_<sha256[:12]>.png`）+ `_meta.json` sidecar；不进入
  `GET /databases`，由 Agent 按需调用；22 项单元测试 + 6 项 live 测试。
- 视觉模型图表数据提取：`extract_chart_data_vlm` skill 使用 Qwen-VL
  （`qwen-vl-max`）从论文图表中提取 chart_type / axes / data_points / legend。
  三级降级链 L1 Qwen-VL → L2 pdfplumber 表格 → L3 caption，全部失败抛
  `ChartExtractionError`（project_memory 禁止静默空数据降级）。产物
  `chart_data.csv` + `chart_data_points.csv`（UTF-8 BOM，Excel 兼容），通过
  `source_asset_id` 追溯到原始图片/PDF；24 项单元测试 + 2 项 live 测试。
- QueryStatus 枚举统一：`domain/contracts/enums.py:QueryStatus` 五态枚举
  （`success` / `not_found` / `failed` / `skipped` / `page_fallback`），11 个 skill
  文件 42 处 `log_query()` 调用全部迁移；`tests/test_query_log_status_consistency.py`
  30 项 AST 静态扫描保证迁移完整性。PubChem / Reactome 的 page fallback 不再虚报
  `ok`/1，改为 `page_fallback`/0（project_memory 硬约束）。
- PDF 三级 fallback 链：`integrations/acquisition.py:acquire_publication_with_fallback()`
  实现 `pdf_url` → Unpaywall（DOI，5s timeout）→ EuropePMC fullTextXML（PMCID，国内
  可用）三级 fallback，所有 attempt（含失败）记录到 `download_log.csv`；
  `_ALLOWED_HOSTS` 已新增 `api.unpaywall.org` / `www.ebi.ac.uk`；9 项回归测试。
- Compaction truncation 显式校验：`runtime/compaction.py` 在
  `finish_reason="length"` 时抛 `ConversationSummarizerTruncatedError` 短路
  `_fallback` 静默降级（project_memory 硬约束 "LLM 失败必须抛异常"）；2 项回归测试。
- 托管式研究自学习：builtin Catalog 明确排除旧 `self_evolution`，模型不能生成
  Python 或写入 `skills/learned/`。能力缺口只能通过内部 `create_skill` 生成
  声明式 `WorkflowRecipe`，由受控执行器验证 API → HTML → Browser 流程；Recipe、
  子 Agent staging、SSRF/重定向、BrowserContext 取消清理和 secret redaction
  均有独立回归测试。
- 浏览器 QA 已在当前分支重新执行：启动时保留新研究草稿并加载后端历史，fixture
  完整运行并展示 14 个产物；1440×900 与 390×844 下结果列表可滚动至最后产物，
  390×520 压缩高度下设置提交控件仍可达，长标题截断且不遮挡状态/删除控件。

未完成能力只以 [TODO.md](TODO.md) 中未勾选条目为准；本节不复制任务清单，避免
已完成状态在两处维护后产生漂移。
