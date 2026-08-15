
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
  GDC/Xena、ChEMBL/UniProt/PDB/PubChem/Reactome、浏览器与网页截图、PDF/VLM、
  统计绘图、local cache 等），经 `createBusinessToolBundle` 一次性注册进 Pi
  Session（无 find_skill/invoke_skill 网关）。
- **四个类别**：discovery / acquisition / processing / analysis。
- 不变式不变：download 记录 `DownloadAttempt`，成功校验后才返回
  `SourceAsset`；processing 只接受成功的本地 `SourceAsset` 或受控
  `DataBatch`；任何 Skill 都不能绕过 Dataset Runtime、Compatibility Gate 和
  Validation Gate。

### 16.2 Main Agent 工具集

Main Agent 直接持有全部业务工具（`search_pubmed`、`search_geo`、
`describe_geo`、`download_geo`、…），加上：

- `validate_dataset_build_spec` / `execute_dataset_build`：校验并提交自包含
  `DatasetBuildSpec`（唯一正式产物入口）；
- 文件读写工具（`read_file` / `read_file_head` / `search_file` / `write_file` /
  `list_files`）；
- `compress_query_log` / `review_query_strategy`；
- `delegate_research` / `get_subagent_results` / `cancel_subagent`。

数据库 store 中被禁用的数据库（enable toggle）会从 Agent 工具集中移除
（`disabled_databases`）。用户选择的数据库是 `preferred_sources`：Main Agent
优先使用这些来源，但也可以探索公开、免登录且不需要私密凭据的其他来源。登录、
CAPTCHA、付费、凭据和服务条款边界仍必须进入 HIL。

Agent 只负责形成 `DatasetBuildSpec` 和必要的来源证据；不能写入发布阈值、不能把
Agent-only 数据源或子 Agent 的自然语言结果作为正式数据，也不能绕过 Spec
Validator、Compatibility Gate、Validation Profile 或 Publisher。

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
  -> 生产 DatasetBuild 可发现和执行
REJECTED
  -> 永不执行
```

生产 Build 只自动发现 `PROMOTED` Recipe；`VERIFIED` 只能在明确受限试用或 HIL
确认后引用。消费链为：

```text
WorkflowRecipe（PROMOTED）
  -> WorkflowRecipeSourceFetcher -> RecipeExecutor
  -> Workspace validation -> SourceAsset -> SourceAdapter
```

`WorkflowRecipe` 不得产生 Canonical DataBatch、声明跨来源依赖、执行集成、选择
Validation Profile、决定发布，或包含 Python / JavaScript / Shell 等任意代码字段。

**Agent ↔ Dataset Runtime 边界**：Main Agent 使用子 Agent 的结构化结果形成
`DatasetBuildSpec.source_bindings`。正式获取必须由内置 Acquisition Provider 或
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

### 17.2 对话流（Coding Agent 风格）

对话主流使用"按时间顺序交错的步骤流"，所有事件类型统一投影到 `ConversationItem`
列表，按 `sequence` 升序渲染。

| kind | 来源事件 | 渲染组件 | 默认状态 |
| --- | --- | --- | --- |
| `user_message` | `MessageRecord(role=user)` hydrate | `UserMessageBubble` | 右对齐气泡 |
| `assistant_segment` | `assistant_delta`（按 `stream_id` 分段） | `AssistantSegment` | 展开，流式时末尾光标 |
| `reasoning` | `assistant_reasoning_delta`（按 tool call 分段） | `ReasoningBlock` | 折叠；流式时展开 |
| `tool_call` | `tool_started` + `tool_completed` | `ToolCallStep` | 折叠；running Spinner |
| `operation` | `operation_started/completed/failed`；迁移期兼容 `stage_*` | `OperationStep` | 展开（紧凑单行） |
| `progress` | `operation_progress`；迁移期兼容 `stage_progress` | `ProgressStep` | 展开（同 operation 原位更新） |
| `warning` | `warning` | `WarningStep` | 展开（黄色） |
| `artifact` | `artifact_produced` | `ArtifactStep` | 展开（含大小 Badge） |

`itemId` 规则保证按工具调用分段、同 operation 共用项、同 kind progress 原位更新。
`run_queued` / `user_input_required` / `user_input_resumed` /
`conversation_compacted` / `plan_ready` / Run 终态事件**不创建 item**，分别由
ChatPanel 草稿态、`pendingUserInput` + UserInputDialog、状态条分隔符处理。

`toolLabels` 映射 `toolName + arguments` → `{ verb, target, details? }` 三元组，
状态条与 ToolCallStep 复用同一映射。

### 17.3 结果展示

`ResultsViewer.tsx` 动态读取 CSV 头与行（`Papa.parse`，预览前 100 行），
**不硬编码 22 列 Schema**；`BuildResultsViewer` 读取 `BuildResult` 与
`dataset_manifest.json`（含 `dataset_family`），识别主数据与辅助表并按数据族
选择结果 Tab 与列渲染策略。界面必须显式展示 family、row granularity、有效行数、
来源覆盖、Validation 状态、confidence 分布、provenance 覆盖率，以及
`PARTIAL_SUCCESS` / `NO_DATA` 的原因。

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
