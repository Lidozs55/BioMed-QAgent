
# BioMed-QAgent 架构 — Skill 仓库与前端

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §16-§17），
> 章节编号与主文件保持一致。

---

## 16. Skill 仓库与 Subagent

> 自制 Skill 运行时与 learned skill 概念已退役：SOP 知识统一放在
> `.pi/skills/<name>/SKILL.md`，业务工具为 TS 直接实现（见 §16.1）；用户扩展仅
> 保留声明式数据库。

### 16.1 Skill 内容与直接工具

- **Skill 知识**：`.pi/skills/<name>/SKILL.md`（frontmatter name/description +
  SOP 正文），由 Pi 资源加载器按任务注入；Pi 侧经 `pi-adapter.ts` 的 skill
  roots 加载，缺失时优雅降级不崩溃。
- **稳定映射**：`server/src/agent/skills/skill-tool-map.ts` 是 Skill ↔ Tool
  名称的单一事实源；`server/tests/skill-manifests.test.ts` 钉住，禁止漂移。
- **直接工具实现**：业务工具在 `server/src/agent/tools/`（PubMed/NCBI、GEO、
  GDC/Xena、GWAS Catalog、ChEMBL/UniProt/PDB/PubChem/Reactome、浏览器与网页截图、PDF/VLM、
  统计绘图、local cache 等），经 `createBusinessToolBundle` 注册进 Pi Session。
  生产首轮只激活只读 `inspect_dataset_execution_routes`、Dataset Core 执行工具和
  `activate_agent_tools` 入口；其他工具
  通过入口按需激活，并在同一 Session 内累计保留，避免把完整 JSON Schema 一次性
  发送给模型或让后续激活意外移除已用工具。工具仍受同一权限、Core 和发布门禁约束，
  激活不改变能力边界。首轮 system context 同时注入当前 Session 完整但有界的
  Skill↔Tool map：每项含简短功能、route/trust boundary、可用工具名及 schema 是否
  已激活；因此 Agent 在正式工作前即可规划路径，而非等到工具调用后才收到知识。
  未激活工具仍只在调用 `activate_agent_tools` 后的下一轮注入完整 schema。这不是恢复
  已退役的 `find_skill` / `invoke_skill` 动态发现协议。
- **GWAS Catalog 路由**：`lookup_gwas_catalog` 通过官方 EMBL-EBI HAL API 将 PMID
  解析为 GCST study，或按 GCST/rsID 返回有界 association 证据；缺失的总数和字段
  保持 `null`。该工具只负责 discovery，正式 Dynamic Family 输入仍由 Core provider
  `gwas-catalog.associations.v1` 重新获取。`inspect_dataset_execution_routes` 从生产 static
  Registry 和统一 provider catalog 实时投影 route facts：该 provider 属于可直接绑定的
  dynamic input；GWAS Catalog 不在 static family/schema 枚举中不表示 provider 不可用，
  也不要求先新增 static GWAS family。该事实只证明 acquisition/输入解码已接线，不证明
  FamilySpec、Projection、transform、源站可达性或 publication 已闭环。
- **四个类别**：discovery / acquisition / processing / analysis。
- 不变式不变：download 记录 `DownloadAttempt`，成功校验后才返回
  `SourceAsset`；processing 只接受成功的本地 `SourceAsset` 或受控
  `DataBatch`；任何 Skill 都不能绕过 Dataset Runtime、Compatibility Gate 和
  Validation Gate。

### 16.2 Main Agent 工具集

Main Agent 直接持有全部业务工具（`search_pubmed`、`search_geo`、
`describe_geo`、`download_geo`、…），加上：

- `inspect_dataset_execution_routes`：无参数、无网络、无持久状态的 capability view；
  从 production static family Registry 与 Core provider catalog 生成 exact static matches、
  Dynamic Family 可直接绑定输入，以及仍需 provenance-bound extraction 的 acquisition-only
  carrier。它不解释 topic，也不验证或发布 requirement；
- `validate_dataset_execution` / `execute_dataset_execution`：校验并提交自包含
  `DatasetExecutionSpec`（静态 family 的正式执行入口）。`execute_dataset_execution` 的
  `source_files`、`mapping_files`、`metadata_files` 都按 binding_id 映射；source
  缺失时由 registered Core acquisition 补齐，mapping/metadata 缺失表示该
  adapter 不需要额外载体。Host 在 acquisition 前拒绝未知 binding key；
- 文件读写工具（`read_file` / `read_file_head` / `search_file` / `write_file` /
  `list_files`）；
- `compress_query_log` / `review_query_strategy`；
- `delegate_research` / `get_subagent_results` / `cancel_subagent`。

数据库 store 中被禁用的数据库（enable toggle）会从 Agent 工具集中移除
（`disabled_databases`）。用户选择的数据库是 `preferred_sources`：Main Agent
优先使用这些来源，但也可以探索公开、免登录且不需要私密凭据的其他来源。登录、
CAPTCHA、付费、凭据和服务条款边界仍必须进入 HIL。

Agent 只负责形成 `DatasetExecutionSpec` 和必要的来源证据；不能写入发布阈值、不能把
Agent-only 数据源或子 Agent 的自然语言结果作为正式数据，也不能绕过 Spec
Validator、Compatibility Gate、Validation Profile 或 Publisher。Agent-facing 工具必须
保留确定性内核返回的失败语义：进程非零退出是失败，Dataset Core 的 `retryable`
不得在工具适配层丢失；相同输入只能在明确可重试且外部条件可能已变化时重试。
Agent 对自身工作记录也必须 evidence-bound：只能按当前 Run 的 tool result/event 声明
调用、验证、覆盖率、OperationResult、ProductAssessment、Publication 和完成状态；抽样成功不能写成全量验证，
计划、workspace 文件或 intended next step 不能写成已完成动作。主 Prompt 将规则组织为
显式 dataset completion contract：是否属于 dataset-producing task 由“查找、整合或输出
数据产品”的任务语义决定，不由 CSV/表格/原始溯源等输出格式决定；每个请求的语义
产品都必须有当前 Run/requirement 的可发布 ProductAssessment 和 immutable Publication 才能声明正式完成。缺少
Core provider/formal carrier 时不得在首次受阻后立即降级；应先尝试适用的 static/dynamic
Core 路径、纠正输入、仅重试可重试失败并寻找独立真实来源。合理路径耗尽后可交付明确
标注为 provisional/staging 的 workspace CSV，但必须同步报告 blocked/NO_DATA、缺失来源或
覆盖范围，并请求完成正式 publication 所需的具体帮助；不得称其为已验证、已发布、正式
完成或 Dataset Core Publication。该 Prompt 约束是模型侧局部缓解，只约束正式产物
声明；它不构成 `run_completed(build_result=null)` 的终态门禁。
Run 完成不要求一定产生 Publication；非数据汇报可以只由 RunSummary 完成。数据产品是否正式完成由
ProductAssessment 与 Publication 证明，而不是由独立中间生命周期门禁证明。
工具返回给模型的 `content` 必须是有界且合法的结构化摘要；完整内核响应保留在
`details`/durable evidence 中，不能通过字符切片破坏 JSON 或丢失 publication 状态。

每次 LLM 调用前，Pi 的 `context` hook 会追加一个不可见、非持久的 Run progress
custom message。该状态块固定四行且不超过 520 字符，只投影当前 Run 的工作阶段、
工具成功/失败/进行中计数、最近工具结果、当前 OperationResult/ProductAssessment/Publication，以及一条
failure-aware 后续动作。工具结果只记录名称与状态，不复制参数、返回正文或敏感内容；
新 Run 启动时计数清零，compaction continuation 不清零。状态块仅提供注意力提示，
不写 durable event，不改变 reducer，也不阻止或生成 `run_completed`。
业务工具的共享失败形状为 `{ error, code, retryable, status_code? }`；只有底层错误
明确携带 `retryable` 时才允许透传 true，普通参数/解析异常默认不可重试。
权限或 evidence-bound HIL 挂起的可信调用必须等待原调用恢复，不能以 workspace
脚本产物替代。

Static 与 Dynamic 工具是互斥的两条规格入口，不是串行探测步骤。dataset-producing
请求先调用 `inspect_dataset_execution_routes`：只有 family、schema、source 和 topology 有
exact static match 时才走 `validate -> execute`；否则仅在各输入被列为 dynamic-bindable
或已有 task-owned Core asset 时走 `prepare -> submit`。Static validator 的拒绝或枚举缺项
只描述 static registry，不能用于判断 dynamic provider 是否接线。Dynamic 工具的
`acquisition_requests` schema 仍是具体提交的执行契约，但 route capability view 来自同一
`provider-catalog.ts`；handler/descriptor、route view/schema 均通过派生/闭包测试防止漂移。
binary archive 即使已有 Core acquisition handler，也会显示为 acquisition-only，不能误报为
Dynamic transform 已可直接消费。

### 16.3 用户扩展（声明式数据库）

用户扩展仅支持声明式 JSON/YAML HTTP 数据库：manifest 与启停状态由
`database/bridge.py` 持久化，内置目录在 `server/src/product/builtin-databases.ts`；
`GET/POST/PUT/DELETE /api/v1/databases` + `enable/disable`。声明式 operation 由
`DeclarativeHttpToolBuilder` 构造成直接 SDK 工具；带 `auth` 的操作保留子 Agent
上下文的 HIL 审批门。内置数据库（pubmed/geo/gdc/xena/pdb/pubchem/reactome/chembl/
uniprot）默认启用、可持久禁用。**Python ZIP Skill 包、`/api/v1/skills*` 管理面与
设置页"技能"分区已退役**；设置页 Model / Databases 两个区段使用对应 REST API
管理状态。

### 16.4 托管式 Subagent 与 WorkflowRecipe 闭环

Main Agent 可以在一个父 Run 内并行委派子 Agent；子 Agent 的编排由 Pi 自身
管理，其 queued / running / progress / HIL / cancel / terminal 事件经
`server/src/agent/event-adapter.ts` 写入父 Task 的同一 durable event log：

- **SourceResearchAgent**：bounded source-research child agent，只能使用
  DISCOVERY + ACQUISITION 直接工具，产出来源候选、accession 和经过校验的
  `source_asset_ids`；不能递归委派、调用 Dataset Runtime 或写入正式
  `artifacts/`。失败时返回 `EXTRACTION_FAILED`。
- **SkillBuilderAgent 已删除**（learned skill 概念退役）：skill_builder
  请求被拒绝（`unsupported subagent type`）。

子 Agent 使用独立 SDK Session，`global_limit=4`、`per_run_limit=3`、
`batch_limit=8`、`timeout=3600s`。

子 Agent 的网络或 Recipe 采集只能写 `staging/subagents/<subagent_id>/`。
`SubagentStagingWorkspace` 校验路径、大小、摘要和元数据后，才把文件原子提交为
不可变 `SourceAsset`，并通过 `SubagentResult.source_asset_ids` 向 Main Agent
暴露轻量引用。

**WorkflowRecipe Acquisition 闭环**：

```text
DRAFT
  -> controlled validation
VERIFIED
  -> 受限试用或 HIL 确认
PROMOTED
  -> 生产 requirement 可发现和执行
REJECTED
  -> 永不执行
```

生产执行只自动发现 `PROMOTED` Recipe；`VERIFIED` 只能在明确受限试用或 HIL
确认后引用。消费链为：

```text
WorkflowRecipe（PROMOTED）
  -> WorkflowRecipeSourceFetcher -> RecipeExecutor
  -> Workspace validation -> SourceAsset -> SourceAdapter
```

`WorkflowRecipe` 不得产生 Canonical DataBatch、声明跨来源依赖、执行集成、选择
Validation Profile、决定发布，或包含 Python / JavaScript / Shell 等任意代码字段。

**Agent ↔ Dataset Runtime 边界**：Main Agent 使用子 Agent 的结构化结果形成
`DatasetExecutionSpec.source_bindings`。正式获取必须由内置 Acquisition Provider 或
受控 WorkflowRecipe 完成；SourceResearchAgent 的资产若要进入正式流程，仍需经过
SourceBinding、SourceAsset 校验和 Adapter 能力检查。正式 DatasetPublication 只
能由 Validation Gate 和 Publisher 产生，子 Agent 完成事件、自然语言结果或
SourceAsset ID 本身不构成发布证据。

### 16.6 视觉证据与图表提取

**视觉证据采集（`web_visual_capture` skill）**：`capture_web_page` 与
`capture_page_section` 调用 RunContext 中由 lifespan 注入的 `CrawlerFacade`，
由共享 `BrowserPool` 完成 Chromium 截图；PNG 和 metadata sidecar 均先进入
`SubagentStagingWorkspace`，通过大小、摘要、路径和链接检查后再 commit 到任务
`source_assets/<asset_id>/`。该 Skill 不允许自行启动 Chromium、创建 HTTP client
或直接写最终截图路径。不出现在 `GET /databases` 列表中，由 Agent 按需调用。

BrowserPool 只保有一个 Chromium，最多同时打开 4 个隔离 BrowserContext。每个
Context 强制 `service_workers="block"`，并使用独立凭据访问 loopback-only HTTPS
CONNECT 代理。代理在实际 CONNECT 层仅解析一次目标域名、拒绝非公网地址并直连该
固定 IP；Playwright route 继续负责 Recipe / source host allowlist。HTTP API /
HTML 请求同样逐 hop 固定 IP、保留原始 Host/SNI、禁用自动重定向并为每次请求使用
独立 transport，避免 DNS rebinding、跨 SNI 连接池复用和私网重定向。

**视觉模型图表数据提取（`extract_chart_data_vlm` skill）**：接受任意获取渠道的
论文产物（PNG/JPG/WEBP/GIF 图片或 PDF 文件）。单一工具入口
`extract_chart_data_vlm(source_path, hint="")` 内部按 MIME 分派：图片直接
base64 送 Qwen-VL；PDF 先用 `server/src/processing/vlm/pdf-images.ts` 提取嵌入
图片（每文件上限 10 张），再逐图送 VLM。VLM 客户端在
`server/src/processing/vlm/vlm-client.ts`，与聊天模型客户端相互独立。

**三级降级链**（L1→L2→L3，全部失败抛 `ChartExtractionError`，禁止静默空数据
降级）：

- L1 — Qwen-VL：主路径，要求 `DASHSCOPE_API_KEY`；返回严格 JSON
  `{chart_type, axes, data_points, legend}`；
- L2 — PDF 表格提取：仅 PDF 触发，用 pdfjs-dist（`server/src/processing/pdf/`）
  提取矢量 PDF 表格数据；
- L3 — caption 文本：兜底，正则提取 `Figure N.` / `Table N.` captions，写入
  `chart_type="caption_only"` 行并发出 `warning`。

产物 `parsed/chart_data/chart_data.csv` + `chart_data_points.csv`（UTF-8 BOM，
Excel 兼容）。每行 `source_asset_id` 将 chart 追溯到原始图片 / PDF。超过 VLM
尺寸/字节上限的图片不自动降采样，工具返回明确错误提示以更清晰的分辨率重新截图。

> 决策依据：ADR-003（保留可信内核）、ADR-007（Agent 不决定数据值）。

---

## 17. 前端架构

前端已按后端 durable 契约实现为任务工作台，而不是聊天窗口加日志。技术栈：
React 19 + Vite + Tailwind CSS v4 + shadcn/ui，包管理器 pnpm（**never npm**）。

### 17.1 双通道运行时

`frontend/src/runtime/` 实现双通道设计：

- `transport.ts`：`AgentEventTransport` 处理 WebSocket 收帧、rAF 批量刷新、自动
  重连携带 durable watermark；
- `controller.ts`：`RuntimeController` 拥有 transport 生命周期，在 snapshot /
  accepted-Task handoff 时使用 REST `/events` 重放；
- `reducer.ts` 与 `reducers/`：纯 reducer 把事件投影到 store；
- `types.ts`：`ConversationItem` 联合类型等。

| 通道 | 帧类型 | 处理 |
| --- | --- | --- |
| Durable events | `EventEnvelope`（schema 1.0/2.0，单调 `sequence`） | `applyEvent` |
| Realtime assistant stream | `assistant_stream_delta` / `assistant_stream_end` | `applyAssistantStreamFrames` |

Pending stream 帧上限 `MAX_PENDING_ASSISTANT_STREAM_FRAMES = 2048`，rAF 批量
flush；`tool_started` / `run_finalizing` / Run 终态等边界事件强制 flush。

Pi 上游常以 1–2 个字符为粒度发送 text/thinking delta。`pi-adapter.ts` 在不改变
事件顺序的前提下合并连续同类 delta：最长等待 32 ms、单事件最多 4096 字符；
类型切换、工具/compaction 事件与 Run 终态前强制 flush。这样避免每个字符都触发
一次 `events.jsonl` fsync、WS 帧与前端投影，同时保持最终 durable 文本完全一致。

REST 冷回放仍以 1000 条为一页，但每页通过 `AgentStore.applyEvents()` 在一次 Zustand
transaction 中顺序 reduce；sequence gap 语义不变，React 只收到一次页面级通知。

### 17.2 对话流（Coding Agent 风格）

对话主流使用"按时间顺序交错的步骤流"，所有事件类型统一投影到 `ConversationItem`
列表，按 `sequence` 升序渲染。

| kind | 来源事件 | 渲染组件 | 默认状态 |
| --- | --- | --- | --- |
| `user_message` | `run_queued` / `run_steered`，以及 `MessageRecord(role=user)` hydrate | `UserMessageBubble` | 右对齐气泡 |
| `assistant_segment` | `assistant_delta`（按 `stream_id` 分段） | `AssistantSegment` | 展开，流式时末尾光标 |
| `reasoning` | `assistant_reasoning_delta`（按 tool call 分段） | `ReasoningBlock` | 折叠；流式时展开 |
| `tool_call` | `tool_started` + `tool_completed` | `ToolCallStep` | 折叠；running Spinner |
| `operation` | `operation_started/completed/failed`；迁移期兼容 `stage_*` | `OperationStep` | 展开（紧凑单行） |
| `progress` | `operation_progress`；迁移期兼容 `stage_progress` | `ProgressStep` | 展开（同 operation 原位更新） |
| `warning` | `warning` | `WarningStep` | 展开（黄色） |
| `artifact` | `artifact_produced` | `ArtifactStep` | 展开（含大小 Badge） |

`itemId` 规则保证按工具调用分段、同 operation 共用项、同 kind progress 原位更新。
`user_input_required` / `user_input_resumed` /
`conversation_compacted` / `plan_ready` / Run 终态事件**不创建 item**，分别由
ChatPanel 草稿态、`pendingUserInput` + UserInputQuestionnaire、状态条分隔符处理。

`run_steered` 是 active Run 内的 durable 用户消息边界：它先结束当前 Assistant
流式段，再按事件 `sequence` 插入调整方向气泡，并让后续 `assistant_delta` 开启新段。
HTTP `/inject-context` 的响应不直接生成本地气泡，因此回放、刷新和实时显示使用同一
顺序来源。

**`sequence` 是不可变的首次进入时间线位置**：`upsertItem` 更新已有 item 时保留
原 `sequence` 与 `createdAt`，只有新增才写入序列；后续更新（如
`tool_completed`、`stage_progress`）不得把 item 拖到时间线更靠后的位置。需要
"最后更新时间"语义时用专用字段（如 `ToolCallItem.completedSequence`），不复用
`sequence`。`itemSequences` 记录每项的稳定首入序列，供 `capTaskItems` 对齐裁剪。

对话滚动由 shadcn `MessageScroller` 独占。实时状态默认跟随 live edge；用户主动滚轮、
触摸或键盘上滚后停止跟随，并由 `MessageScrollerButton` 返回最新内容。普通用户消息
不设置 `scrollAnchor`，否则新回合会进入 `anchored-to-message` 并在流式内容增高时
持续把提问钉回视口，表现为列表从底部反弹到中间。加载更早历史仍由 viewport 的
prepend preservation 保持当前位置。conversation row 在 `MessageScrollerItem` 边界
memoize，未变化的历史 Markdown 不随 live row 增长重复解析。

durable `assistant_delta` 无 `stream_id`（Pi adapter 路径）时，`stream.ts` 用
`currentReasoningSegmentByRun[runId]` 作为会话 epoch 生成
`live:<run>:<epoch>` 分段 ID（`tool_started` 每次递增该计数），因此工具调用
前后的正文落在不同的 `assistant_segment`，而不是合并进同一个 item。

任务长时间无新事件（`summary.updated_at` 不前进，默认 2 分钟）时，ChatPanel
显示"可能已挂起"提示并给出取消入口（`STALL_THRESHOLD_MS`）。下载类工具会
周期性上报 `operation_progress`（downloaded_bytes），因此正常大文件下载不会误报。

Agent 任务处于 `running` / `finalizing` 时，顶部任务状态条常驻"停止生成"按钮；
点击后立即切换为"正在取消…"并调用
`POST /api/v1/tasks/{task_id}/runs/{run_id}/cancel`，不会强制等待完整回复生成。
该入口与 2 分钟无事件提示共用同一个取消处理：后端经 Pi `abort()` 结束当前模型调用，
通过 `run_cancel_requested` / `run_cancelled` 更新任务状态；前端保留已经流式生成的
正文，用户可随后重新提问。

**下载进度与直接续传**（P5-D3 part 文件 + 独立端点）：字节级下载进度只渲染在
`tool_call` 气泡内（`DownloadProgress`），operation 行只保留状态徽章，避免时间线
出现两条重复进度条。`pipeline.ts` 把 `downloaded_bytes` 进度绑定到所属工具调用：
优先匹配 `detail.accession` 与工具 `arguments` 相等的 running tool_call，否则回退
到该 run 最近启动的 running tool_call（防止绑定到错误的工具气泡）。所有采集工具
（geo/gdc/xena/pubmed）共用 `tool-hooks.ts` 的 `createDownloadProgressReporter` 上报
节流进度（intervalMs/bytesStep），保证 payload 结构一致（`detail.accession` 扁平
可匹配）。**终态 100% tick 由 downloader 统一发出**：`acquireSource` 的 progress 回调
是鸭子类型 `AcquisitionProgress`（普通回调 + 可选 `finalize`），它在两条成功路径
（缓存命中、流式下载）返回前各调用一次 `finalize(最终字节, 最终字节)`，不受节流
限制，工具层不再手工补终态事件——UI 必然到达 100% 而不是冻结在最后一个节流 tick。

下载是**任务级实体**，独立于 AI run：一个下载任务（source+accession）从首次发起
到完成始终是同一个实体，进度绑定到承载它的 tool_call 气泡。前端"恢复下载"调用
`POST /api/v1/tasks/{taskId}/downloads/resume`，请求携带**原 run 的 `run_id` +
原始 `tool_call_id`** + `tool_name` + `arguments`。后端**不创建新 run**：重建/复用
工作区（服务器重启后重建轻量工作区，只拿工具箱不启动 AI 会话）直接执行下载工具，
并把合成的 `tool_started`（复用原始 tool_call_id，挂原 runId）、
`operation_progress`、`tool_completed` 事件回放到**原 run 事件流**。前端 reducer
按原 runId + tool_call_id upsert 原始气泡（status→running、progress 保留），因此
每个下载任务始终只有一个操控组件——无新 run、无新消息、无重复气泡。取消走独立的
`POST /api/v1/tasks/{taskId}/downloads/cancel`（abort 在途下载，`cancelRun` 不碰
下载）；abort 后不发终态事件，前端 stall 检测把气泡翻回"恢复下载"。下载完成后由
用户输入"继续"再发起 AI run 继续分析。

`toolLabels` 映射 `toolName + arguments` → `{ verb, target, details? }` 三元组，
状态条与 ToolCallStep 复用同一映射。

### 17.3 结果展示

`ResultsViewer.tsx` 动态读取 CSV 头与行（`Papa.parse`，预览前 100 行），
**不硬编码 22 列 Schema**；`PublicationResultsViewer` 读取 Publication 与
`dataset_manifest.json`（含 `dataset_family`），识别主数据与辅助表并按数据族
选择结果 Tab 与列渲染策略。界面必须显式展示 family、row granularity、有效行数、
Validation 状态、confidence 分布、逐行 provenance 覆盖率（traced/untraced 行数与
覆盖率），以及 `PARTIAL_SUCCESS` / `NO_DATA` 的原因。结果页展示的“覆盖”是
逐行溯源覆盖，不等同于完整 SourceCoverage 语义报告：后者（universe scope、query
plan、采集行数记账等）以 manifest 的 `audit_report` 角色交付，结果页完整语义报告的
复现仍是待办。

正式 HIL 由 shadcn `Dialog` 中的批量审核卡片承载：一个 blocking 请求可展示多个
review item，数据审核提供接受/结构化修正/拒绝/跳过，凭据授权严格只提供授权/拒绝。
提交必须回传原 `request_id + evidence_digest`。结果页展示 high/medium/low 分布、
human review states、主要 reasons，并提供 `confidence_records.json` 与 provenance
artifact 的下钻入口；人工接受不能在 UI 上显示为置信度升级。
V1 的 action 作用于整个审核批次，逐项修正通过 mapping/point keyed JSON 表达；按钮
明确标注“整个审核批次”，切换 `request_id` 会重置 action 与 correction 草稿。前端
wire parser 同时校验 nested request/task/run identity 与外层 event envelope 一致。
统计 anomaly 在结果页标为“统计异常”，不得称为证据置信度异常。

启动时并发加载数据库、后端历史分页和 WebSocket，但保持 `activeTaskId=null`，
展示独立的新研究草稿；后续历史通过 cursor 加载并按不可变
`(created_at DESC, task_id DESC)` 排序去重。

`tasksById` 中每个 Task 都有独立的 Run、message、activity、artifact、fixture
stage、`subagentsById`、`subagentOrder` 和 `lastSequence` 投影。桌面端右侧
`ResizablePanel` 展示子 Agent 工作区，移动端复用 Sheet；产物入口位于聊天输入区
FAB。

Assistant 文本采用 realtime / durable 双投影：实时 chunk 按
`(run_id, stream_id, chunk_index)` 进入 pending，durable `assistant_delta` 的
chunk 范围推进 confirmed watermark 并移除已确认 pending。durable 先到、实时帧迟
到或重放重复时都按该 watermark 去重，因此在线文本与断线重放后的最终文本收敛
一致。

> 决策依据：ADR-005（Manifest 驱动）、ADR §21.10（测试锁定不变量而非顺序）。
