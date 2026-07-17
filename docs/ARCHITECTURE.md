# BioMed-QAgent 架构

> 本文描述当前批准的目标架构。详细数据契约与验收条件见
> [Backend Data Closure Design](superpowers/specs/2026-07-12-backend-data-closure-design.md)。

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
- 失败时保证终态事件，不使用 mock 伪装成功。

### 2.3 Skill 和 Tool 的职责

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

Discovery 不生成最终科研数据行。

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

成功文件进入 `data/cache/blobs/sha256/` 内容寻址缓存；规范化 URL/accession/请求
参数映射到缓存元数据，关键词不作为资产身份。任务目录使用硬链接或校验后复制。

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
|-- source_assets/# 不可变来源文件
|-- download_tmp/ # 不完整下载
|-- parsed/       # 解析结果
|-- normalized/   # 清洗和字段对齐结果
|-- staging/      # 按 run_id 隔离的候选产物
|-- artifacts/    # 已通过验证的交付物
|-- state/        # 任务锁和恢复状态
`-- logs/         # stage attempts、事件、验证和诊断记录
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

## 8. API 与事件

FastAPI 提供：

- `POST /api/v1/tasks`
- `GET /api/v1/tasks/{task_id}`
- `GET /api/v1/tasks/{task_id}/artifacts`
- `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}`

确定性 Pipeline 已将事件按统一 envelope 写入 `logs/events.jsonl`：

```json
{
  "schema_version": "1.0",
  "event_id": "event-...",
  "type": "stage_started",
  "task_id": "task-...",
  "stage_attempt_id": "stage-attempt-...",
  "sequence": 1,
  "timestamp": "2026-07-12T00:00:00Z",
  "payload": {}
}
```

当前 fixture Pipeline 保证 sequence 在单任务内严格递增，各 payload 使用判别联合
Pydantic schema。同一 envelope 已通过 WebSocket 推送给订阅客户端
（`app/api/ws_events.py:_run_event_session`），支持按 `after_sequence` 续读、
任务取消与进程恢复重放；前端 `runtime/transport.ts` 负责自动重连并在重连后用
`after_sequence` 补齐缺失事件。任务暂停-恢复（人在回路）仍为后续工作，参见
[TODO.md](TODO.md) §4.2.1。

## 9. 前端目标架构

前端在后端契约稳定后重写为任务工作台，而不是聊天窗口加日志：

```text
任务创建
    -> 计划确认
    -> 阶段 Timeline
    -> 结果 Tabs
         |-- 主数据
         |-- 文献与数据集
         |-- 来源与下载
         |-- 处理记录
         `-- 警告与质量
```

使用 shadcn 的 Form、Card、Tabs、Table、Badge、Progress、Dialog、Sheet 和
Toast。全局只保留一个任务/Event client，避免连接与发送属于不同实例。

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
- SiteRecipe DSL；
- Agent 或 learned Skill 绕过 Validation Gate；
- 将 mock 产物当作正式案例；
- 自动生成缺乏数据依据的科研或临床结论；
- 后端事件和 Artifact 契约稳定前重写前端。

## 12. 当前实现证据（2026-07-17）

- 默认离线后端测试：`770 passed`；默认不访问网络。
- live 验收：PMID 34180400、GSE178352 元数据和官方
  `GSE178352_tximportCounts.txt.gz`（4,597,797 bytes，SHA-256
  `71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55`）。
- fixture 闭环：48 条 gene + sample 记录（4 genes × 12 samples），全部通过精确
  SourceLocator 回溯，生成 14 个正式文件。
- API：显式 `mode=fixture` 创建任务，任务状态和 Artifact 均使用类型化契约，下载
  只接受 manifest 注册的 `artifact_id`。
- Agent：OpenAI Agents SDK 保留为 Runtime，正式产物通过单一
  `run_research_pipeline` Function Tool 进入确定性 Pipeline。
- 前端：保留用户提交的 shadcn 工作台，引入确定性 fixture 入口和 Artifact 下载；
  Vitest、TypeScript、ESLint、production build 与真实浏览器主流程已通过。
- Durable runtime：`TaskManager` 已实现任务锁（per-task `asyncio.Lock`）、运行取消
  （`cancel_run` + `RunStatus.CANCEL_REQUESTED → CANCELLED`）、统一 WebSocket
  `EventEnvelope` 推送与按 `sequence` 续读
  （`app/api/ws_events.py` + `frontend/src/runtime/transport.ts` 自动重连重放）。

未完成能力继续以 [TODO.md](TODO.md) 中未勾选条目为准，尤其是 §4.2.1 人在回路
暂停-恢复（统一 `AWAITING_USER_INPUT` 子状态 + `POST /resume` API）、
§1 系列硬编码解除、第二个真实案例和 GDC/PDB/Xena live 验收。
