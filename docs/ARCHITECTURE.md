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

**视觉证据采集（web_visual_capture）**：
`acquisition/web_visual_capture.py` 提供 `capture_web_page` 与
`capture_page_section` 两个 function_tool，使用 Playwright Chromium 截图，
产物为内容寻址的 PNG（`source_assets/figures/fig_<sha256[:12]>.png`）并附
`_meta.json` sidecar。该 skill **不** 走 `acquire_source()` 的 HTTPS 白名单
+ httpx 下载链路（因为白名单仅含 NCBI/GDC/PDB/PubChem/Reactome/Xena，且
httpx 不支持截图），而是复用 `browser_fallback` 的轻量 provenance 模式
（`SourceRecord(database=BROWSER)` + `add_raw_asset()`）。HTTP 行为（真实
浏览器 UA、Referer、stealth、2s 限速、route guard）由统一的
`app/tools/crawler.py:playwright_screenshot` 提供，确保与其它 acquisition
skill 的反爬行为一致。该 skill 不出现在 `GET /databases` 列表中，由 Agent
按需调用。详见 `docs/separateweb_capture_integration_plan.md`。

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

## 9. 前端实现架构

前端已按后端 durable 契约实现为任务工作台，而不是聊天窗口加日志：

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

启动时并发加载数据库、第一分页后端历史（全部 active Task + 默认 30 条 inactive
history）和 WebSocket，但保持 `activeTaskId=null`，展示独立的新研究草稿；后续
历史通过 cursor 加载并按不可变 `(created_at DESC, task_id DESC)` 排序去重。

`tasksById` 中每个 Task 都有独立的 Run、message、activity、artifact、fixture
stage 和 `lastSequence` 投影。HIL prompt 同时绑定 `task_id + run_id + request_id`；
`UserInputDialog` 使用该 Run 提交，并用 prompt key 与 submission attempt ID 隔离
A → B → A 切换中的旧 Promise settlement。resume 事件只清理匹配 Run 与 request
的 prompt，terminal 事件按所属 Run 清理，新 Run admission 则清理上一轮 prompt。
侧栏把 `awaiting_user_input` 计入“运行中 N / 4”，与后端 slot 占用一致。

Assistant 文本采用 realtime/durable 双投影：实时 chunk 按 `(run_id, stream_id,
chunk_index)` 进入 pending，durable `assistant_delta` 的 chunk 范围推进 confirmed
watermark 并移除已确认 pending。durable 先到、实时帧迟到或重放重复时都会按该
watermark 去重，因此在线文本与断线重放后的最终文本收敛一致；无 sequence 的实时
帧不会推进 `lastSequence`。Transport 在 WebSocket 收帧后立即排队，并在下一次
`requestAnimationFrame` 合并更新；消息区继续复用 `MessageScroller` 自动跟随。
仅当对应 stream 实际生成文本且仍为 active 时，Markdown 末尾显示装饰性闪烁光标，
stream end、工具开始、Run finalizing/终态、断连或取消订阅后关闭，并遵循
`prefers-reduced-motion`。

Chat 主流中的 `ExecutionSummary` 只展示安全的结构化执行摘要：工具状态、阶段与
progress 数量（检索、下载、清洗等）、验证状态和警告；同一 Run/阶段/progress kind
原位更新，运行中默认展开。工具事件中已有的 output、digest 和诊断详情保留在
`ToolTrace` 中；`ExecutionSummary` 不渲染任意 `detail`、reasoning-like keys 或
隐藏提示词。系统不主动传输模型 CoT。

R5 前端修复还补齐了非聊天区域的有界滚动、刷新竞态下的稳定 Task 排序、后台
通知“查看”失败反馈，以及 Bubble 中多行 assistant 文本的换行保留。

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

## 12. 当前实现证据（2026-07-19）

- 默认离线后端测试：**`1025 passed, 1 skipped, 26 deselected`**（86 个测试文件）；
  Ruff `app/ tests/ launcher.py` 为 `All checks passed!`，默认不访问网络。
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
  chips。前端 Vitest 为 **15 文件 / 200+ tests passed**；ESLint 0 warning、
  TypeScript typecheck 和 production build 均通过。
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
- 安全模型：`save_learned_skill` / `load_learned_skill` 实施路径白名单
  （`^[a-z][a-z0-9_]*$`）+ AST 白名单双重安全校验，拒绝
  `exec/eval/compile/open/__import__/globals/locals/vars/breakpoint` 与 dunder
  访问；`tests/test_skill_self_evolution.py` 11 项安全测试覆盖路径穿越、RCE、
  篡改检测。
- 浏览器 QA 已在当前分支重新执行：启动时保留新研究草稿并加载后端历史，fixture
  完整运行并展示 14 个产物；1440×900 与 390×844 下结果列表可滚动至最后产物，
  390×520 压缩高度下设置提交控件仍可达，长标题截断且不遮挡状态/删除控件。

未完成能力继续以 [TODO.md](TODO.md) 中未勾选条目为准，尤其是 §4.2.3 数据修正
实例、§1 系列硬编码解除（processing live 模式 fixture SOFT / `len(samples) != 12`
硬校验 / `staging_run("run_pinned_fixture")` 硬编码 / `field_descriptions`
placeholder / `source_relations` / `processing_log` 硬编码）、§1.5 PubMed
`download_supplementary` 合规化、§1.7 CSV UTF-8 BOM / `run_manifest.json`
`model_name=None` / `warnings.csv` 恒空 / `MetricsTracker` 接入 / Pipeline 全链路
结构化日志、§8.3 数据源硬门控解除、§8.4 Agent INSTRUCTIONS follow-up 策略与
ReviewerAgent、§8.6 BrowserPool、§8.7 structlog 与错误吞掉点修复。
