
# BioMed-QAgent 架构 — Durable Runtime 与 API 面

> 本文是 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的拆分章节（原 §14-§15），
> 章节编号与主文件保持一致。Durable WebSocket 协议与 `EventEnvelope` schema
> 见 §14 与 `packages/contracts/src/events.ts`。

---

## 14. Durable Runtime

Durable Runtime 提供任务生命周期与事件持久化，唯一实现位于 `server/src/runtime/`。
本节描述权威契约。

### 14.1 任务与 Run 生命周期

默认 TS Host 初始化唯一的 `TaskRepository`、Pi Session registry 与 durable
WebSocket runtime；`<task_id>/events.jsonl` 是事实源，纯 reducer 重建 Task snapshot，
`state/task.json` 保存 Task 元数据，`state/pi-session/` 保存 Pi session 映射。
重启时仍 active 的普通 Run 被确定性投影为 `run_interrupted`；存在未解决 durable
HIL 的 `awaiting_user_input` Run 保持暂停，等待恢复协议继续。

`RunStatus` 生命周期：

```text
QUEUED -> RUNNING -> FINALIZING -> COMPLETED | FAILED | INTERRUPTED
   |         |             |
   |         +-> AWAITING_USER_INPUT -> RUNNING | FAILED | INTERRUPTED
   |         |             |
   `---------+-------------+-> CANCEL_REQUESTED -> CANCELLED | FAILED | INTERRUPTED
```

### 14.2 事件系统

`EventEnvelope` v2 为 managed Run 增加 `run_id`。Run 生命周期、Agent 活动和经
Agent Tool 桥接的 Pipeline / DatasetBuild 事件都使用 `schema_version="2.0"`；
sequence 是 **Task 级单调递增**，不是每个 Run 重新计数。旧 fixture envelope 仍
兼容 v1。

Durable Build lifecycle 另有显式 `build_id`，事件包括 `build_queued` /
`build_started` / `build_recovered` / `build_cancel_requested` /
`build_completed` / `build_failed` / `build_cancelled`。Build status 与 Run status
正交：Run 进入终态不产生 Build 终态；业务终态必须由匹配的 `BuildResult` 和
Build terminal event 证明。`request_digest`、lease attempt、取消 request/event ref
以及 typed failure 均属于 Build record，不从错误文本或 artifact 数量重建
（ADR-037；scheduler/runtime 接线仍属 TASK-C3I）。

事件类型由 `packages/contracts/src/events.ts` 的 `EventPayload` 联合类型统一
定义，覆盖三类：

- Task / Pipeline 类：`task_created`、`plan_ready`、`user_input_required /
  resumed`、`stage_*`（仅回放保留）、`tool_called` / `tool_completed`、
  `warning`、`artifact_produced`、`task_cancel_requested` / `task_cancelled`、
  `task_recovered`、`task_completed` / `task_failed`；Dataset Core 成功响应中的
  Core-owned publication receipt 和 manifest artifact receipts 由 Host 原样投影为
  `publication_created` / `artifact_produced`，不通过扫描 workspace 或猜测文件名；
  reducer 按 publication/artifact ID 幂等去重。
- Run 类：`run_queued` / `run_started` / `run_finalizing` / `run_completed` /
  `run_failed` / `run_cancel_requested` / `run_cancelled` / `run_interrupted`、
  `publication_created`、`assistant_delta` / `assistant_reasoning_delta`、
  `tool_started`、`conversation_compacted`；
- Subagent 类：`subagent_queued` / `subagent_started` / `subagent_progress` /
  `subagent_completed` / `subagent_failed` / `subagent_cancel_requested` /
  `subagent_cancelled` / `subagent_interrupted` / `subagent_input_required` /
  `subagent_input_resumed`。

通用构建事件：`operation_started/progress/completed/failed`（携带
`operation_id` / `label` / `category`，前端据此渲染）。兼容期内
`stage_progress` 仍发射并镜像为 `operation_progress`；`stage_started` /
`completed` / `failed` / `skipped` 已无生产发射方（仅为回放旧 events.jsonl
保留），前端不依赖固定 `StageName` union。

`tool_started` 携带可选 `arguments` dict（深度截断 3、字符串 200 字符、列表 20
项），`tool_completed.output` 截断到 4096 个字符，前端据此渲染"检索 PubMed · 查询:
..."标签而无需回拉。

### 14.3 双通道 WebSocket

WebSocket 端点 `/api/v1/ws` 只接受三类命令：

- `{"type":"subscribe","task_id":"...","after_sequence":N}`：先重放
  `sequence > N` 的 durable events，再无缝进入 live fan-out；
- `{"type":"unsubscribe","task_id":"..."}`：取消该 Task 的订阅；
- `{"type":"ping"}`：返回 `{"type":"pong"}`。

服务端输出分两条通道：

- **durable 通道**：发送带 Task sequence 的 `EventEnvelope`，以及 `pong` /
  `error` 控制帧；按 Task watermark 去重，若 live sequence 出现间隙，会先从
  repository 补齐；
- **realtime 通道**：发送无 sequence 的 `assistant_stream_delta` 和
  `assistant_stream_end`，由 `AssistantStreamHub` 提供，仅驻留内存、best-effort
  fan-out，不写入 event log；每个订阅队列有界，慢消费者以可重连状态关闭，Run
  的 durable 写入与执行不受影响。

Agent 收到模型文本 chunk 后，先发布 `assistant_stream_delta`，再放入 durable
buffer，按时间/大小批量写为 `assistant_delta`，并在工具调用、正常或截断结束、
异常与取消路径上强制 flush。durable payload 可携带 `stream_id +
from_chunk_index + through_chunk_index`；三字段必须同时出现或同时省略，省略时
兼容旧事件。

### 14.4 人在回路与并发

正式 HIL 将 `HILRequest` 持久化在 Task domain storage，并在同一时间线写入
`user_input_required`，纯 reducer 将 Run 投影为 `awaiting_user_input`。请求按
`permission` / `semantic_review` / `data_review` / `conflict_resolution` 分类；数据场景
由稳定的 `review_type` 细分。`POST /resume` 必须同时匹配 exact `request_id` 与
`evidence_digest`，先原子写入不可变 `HumanReviewRecord`，再写
`user_input_resumed`。同值重试幂等，不同值重试冲突。服务重启后不依赖旧 Promise，
而是从未解决请求恢复暂停态与 checkpoint continuation；reconciler 会补齐
request→required-event 与 review→resumed-event 两个崩溃窗口。单 Run 的 resume
commit 与 continuation admission 串行执行，重复请求只产生一个 resumed event。

一个 Run 同时最多一个 blocking HIL，一个请求可批量包含多个 `review_items`。
permission 只接受 `approve/reject`；数据审核接受 `accept/correct/reject/skip`。取消
paused Run 会取消持久化请求并唤醒执行器。计划确认、max-turns 和 no-progress 保留
为非 domain-review 兼容提示，只允许 exact unresolved `request_id` 的两值恢复；
它们没有 checkpoint continuation，Host 重启时会明确投影为 `interrupted`，不会形成
running zombie。non-blocking advisory 只写 domain request + warning，不暂停 Run，
恢复 reconciler 也不会把它升级为 blocking prompt。
fixture 模式仍记录 required/resumed 审计事件，但以 `fixture_exempt=true` 自动批准。

默认全局 4 个 active Run slot 和 4 个 worker；不同 Task 可以并行执行，同一
Task 只允许一个 nonterminal Run，后续提交返回冲突。`awaiting_user_input` 期间
仍占用原 slot，避免暂停任务被队列中的新任务抢占。

`UserInputRequiredPayload.prompt_kind` 联合覆盖 `plan_confirmation` /
`max_turns_reached` / `no_progress` / `data_correction` /
`api_key_or_credential`。正式场景通过 `hil_request.review_type` 扩展，不继续增加
顶层 prompt kind。前端 `UserInputDialog` 按 Run 与
submission attempt ID 隔离 A → B → A 切换中的旧 Promise settlement。

### 14.5 模型配置与 Run 自有生成设置

模型配置 REST 端点见 §15。每个 Run 创建时经
`ModelSettingsService.resolveActiveModel` 捕获不可变模型快照，将 Agent 与并发的
设置变更隔离；快照包含模型身份与凭据、生成参数与 context budget。运行期间的
设置变更只影响后续 Run。

Pi 侧由 `ModelRuntime`（`server/src/agent/pi-adapter.ts`）注册 OpenAI-compatible
provider 并注入凭据；DashScope/Qwen 专属字段（`repetition_penalty`、
`enable_search` 等）按端点条件注入。Token 估算与压缩校准沿用 §14.5 前文定义。

VLM 客户端（`server/src/processing/vlm/vlm-client.ts`）使用注入的独立配置，不是
Agent 模型，不参与对话轮次。

#### 14.5.1 上下文压缩接线（Pi 原生自动压缩）

迁移前 Python 运行时在每次 SDK 调用前做 token preflight 并触发自有压缩引擎；
Phase 8 移除 Python 运行时后该逻辑不复存在，自动压缩一度缺失。当前接线把压缩
整体委托给 Pi 原生能力（"能调用 Pi 的全调用 Pi"）：

- `resolveActiveConfig` 把产品的 `compaction_trigger_ratio` /
  `compaction_target_ratio` 快照进 `BioMedModelConfig`；`pi-adapter.ts` 将其换算为
  Pi `CompactionSettings`：`reserveTokens = round(window × (1 - trigger))`，
  `keepRecentTokens` 则由“最终上下文目标”动态推导，并保持 `enabled=true`。Pi
  `AgentSession` 内建的 threshold / overflow 自动压缩因此沿用产品阈值。
- 产品默认值为 `trigger=0.85`、`target=0.45`：自动压缩在上下文占用约 85% 时触发，
  压缩目标按**当前会话 token × `target`**计算（再钳制到窗口的 5%~60%），而不是把
  `target` 当作窗口的固定比例。最终上下文由“摘要 + 最近轮次”组成：Pi 先为摘要预留
  最多 80%×`reserveTokens` 的空间，剩余预留给最近轮次，因此重复信息多时摘要更短、
  实际压缩更狠；信息密集时摘要会吃满预留预算，最近轮次自动收缩，保住早期核心内容。
  当整个会话已经小于最终目标时，Pi 会保持全部内容并拒绝压缩（对应前端的“没有可压缩
  内容”提示）；`keepRecentTokens ≤ window - reserveTokens` 始终成立，避免小窗口下
  预算互相挤占。
- 每轮 `run()` 与手动压缩前，adapter 都会用 `resolveActiveConfig` 重新解析当前模型；
  若 provider/模型/上下文窗口/压缩比例发生变化，会先在 Pi `ModelRuntime` 重新注册
  新模型并调用 `session.setModel()`，再重算 `CompactionSettings`。这解决了中途切换
  不同上下文窗口模型后，旧会话仍按旧窗口保留大量历史、既触发不了压缩又可能把超窗口
  上下文发给新模型的问题。即使模型未变化，每轮也会读取 Pi 当前上下文用量并重算
  `keepRecentTokens`，让预算跟随实际对话规模而非固定窗口比例。
- 手动 `POST /tasks/{task_id}/compact` 仍直接调用 Pi `session.compact()` 并自行
  持久化 `conversation_compacted`。压缩不再要求任务处于 active run：空闲任务用最近
  一次 run 作为 `covered_through_run_id`，进程内没有会话时按持久化 Pi 会话惰性重建，
  压缩后立即释放临时会话。惰性重建前先检查 `state/pi-session` 是否存在 `.jsonl`
  会话文件；没有可压缩内容时返回 `409 Task has no conversation to compact`，前端将其
  呈现为信息提示而非失败。
- Pi 的 `compaction_end`（成功且带摘要）经 adapter 投影为 BioMed 的
  `context_compacted`，再由 `PiEventAdapter` 持久化为
  `conversation_compacted`（`summary_digest` 为摘要的 sha256）；前端据此在时间线
  记录压缩活动并复位 `compacting`。aborted 或缺失摘要的压缩完成事件不产生
  durable 事件，避免伪记录。
- 模型以 `stopReason=length` 截断时不能把 `session.prompt()` 的正常返回等同于任务
  完成。Pi 边界在其自动压缩结束后发送不可见的 runtime continuation，沿用同一
  Run、Session 与工具状态继续执行；只有后续 assistant 以非 `length` 原因结束，
  adapter 才发出 `turn_completed` / durable `run_completed`。

### 14.6 Agent SDK 动态 instructions 契约

Main Agent 使用动态 instructions，在每轮模型调用前把当前 Run 的上下文注入
system prompt；该能力经 `server/src/agent/pi-adapter.ts` 边界承载，SDK 契约由 Pi
实现，前端与事件模型不感知其细节。

> 决策依据：ADR-003（保留可信内核）。

### 14.7 个性化设置契约（自定义指令 / 回复语气）

个性化设置独立于模型设置，持久化于 `data/settings/personalization.json`
（TS `product-api.ts` 原子写入）：`custom_instructions`（默认空串，上限 20000
字符）与 `personality`（`pragmatic` / `warm` / `rigorous`）。REST 见 §15
（GET/PUT `/personalization`）。自定义指令与语气会进入主 Agent 与子 Agent 的
指令上下文；指令为空时不注入自定义指令段，仅注入语气行，避免无谓占用上下文。

前端设置：编辑器 / 外观 / 偏好类设置存 `localStorage["biomed.preferences"]`
（`stores/preferencesStore.ts`），通过 `documentElement` 的 data-* 属性与 CSS
变量（`--ui-contrast`、`--background` / `--foreground` 等 color-mix 派生值）
即时生效；自定义颜色留空时保持主题默认。

编辑器「跟进处理方式」提供两种策略：加入队列（当前回答结束后自动发送）与
调整方向（取消当前回答，任务回到空闲后立即用新消息重新引导）；发送时按住
Ctrl+⌘ 可对单条消息执行相反操作。半透明侧边栏开启时，在 body 上追加一层极淡
渐变背景作衬托，配合 backdrop blur 呈现毛玻璃效果（桌面侧边栏为 fixed 定位，
内容区并不在其后方，单纯降低透明度看不到效果）。

---

## 15. API 面

统一前缀 `/api/v1`。下表为当前正式 API 面，路由由 TypeScript Host 原生处理
（`server/src/settings/model-registry/routes.ts`、`server/src/product/product-api.ts`、
`server/src/runtime/durable-agent-runtime.ts`），不存在 Python 路由层。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/databases` | 列出内置 + 用户声明式数据库 |
| GET | `/databases/{name}` | 获取单个数据库（含声明式 manifest） |
| POST | `/databases` | 注册声明式数据库 |
| PUT | `/databases/{name}` | 更新用户数据库条目 |
| DELETE | `/databases/{name}` | 删除用户数据库条目 |
| POST | `/databases/{name}/enable` / `/disable` | 启用 / 禁用数据库 |
| GET | `/settings` | 当前模型设置（api_key 掩码） |
| PUT | `/settings` | 更新并持久化模型设置 |
| GET | `/personalization` | 当前自定义指令与回复语气 |
| PUT | `/personalization` | 更新并持久化个性化设置 |
| GET | `/vendors` | 列出已知模型供应商 |
| POST | `/models` | 按 `preview_base_url` / `preview_api_key` 发现可用模型 |
| GET | `/model-registry/providers` | 列出配置的模型供应商（密钥掩码） |
| POST | `/model-registry/providers` | 新建供应商（名称 / Base URL / API Key / 预设） |
| PUT | `/model-registry/providers/{provider_id}` | 更新供应商（api_key 省略不变、空串清除） |
| DELETE | `/model-registry/providers/{provider_id}` | 删除供应商（关联 model 级联删除） |
| POST | `/model-registry/providers/{provider_id}/discover` | 拉取该供应商 `GET /models` 并富化 |
| GET | `/model-registry/providers/{provider_id}/param-specs` | 该供应商可选的参数定义 |
| GET | `/model-registry/models` | 列出维护的模型列表（含 param_specs 与 params） |
| POST | `/model-registry/models` | 添加维护模型 |
| PUT | `/model-registry/models/{model_id}` | 更新模型 / 参数 |
| DELETE | `/model-registry/models/{model_id}` | 删除维护模型 |
| POST | `/model-registry/models/{model_id}/activate` | 切换为当前模型（回写 `/settings` 运行时设置） |
| GET | `/tasks` | 列出 active Task 与 cursor 分页的历史 Task |
| POST | `/tasks` | 创建 durable Task 并排队首个 Run |
| POST | `/import/tasks` | 多部分上传 → 导入任务 |
| GET | `/tasks/{task_id}` | 返回权威 `TaskSnapshot` |
| DELETE | `/tasks/{task_id}` | 删除 terminal Task 及其历史 |
| POST | `/tasks/{task_id}/compact` | 压缩任务会话 |
| POST | `/tasks/{task_id}/runs` | 为 idle Agent Task 排队下一轮 Run |
| POST | `/tasks/{task_id}/runs/{run_id}/cancel` | 取消 queued / running Run |
| POST | `/tasks/{task_id}/runs/{run_id}/resume` | 提交人在回路决策 |
| POST | `/tasks/{task_id}/runs/{run_id}/subagents/{subagent_id}/cancel` | 取消子 Agent |
| GET | `/tasks/{task_id}/messages` | cursor 分页读取 durable messages |
| GET | `/tasks/{task_id}/events` | 按 `after_sequence` 重放 durable events |
| GET | `/tasks/{task_id}/artifacts` | 列出 manifest 注册且已验证的 Artifact |
| GET | `/tasks/{task_id}/artifacts/{artifact_id}` | 按 Artifact ID 下载并校验文件 |
| GET | `/builds` | 列出全局 Build 摘要、RunStatus、BuildResult 与当前 Publication |
| POST | `/builds` | 以 idempotency key 异步启动 Durable Build（TASK-C3I 待接线） |
| GET | `/builds/{build_id}` | Build 的 durable status；终态附 BuildResult/typed failure，兼容现有 Manifest 与 Publication detail |
| POST | `/builds/{build_id}/cancel` | 幂等请求取消 Build，返回 typed cancel disposition/terminal ack（TASK-C3I 待接线） |
| GET | `/builds/{build_id}/artifacts/{artifact_id}` | 下载 Build 的 Artifact |
| GET | `/cache/datasets` | 列出本地缓存数据集 |
| GET | `/cache/datasets/{dataset_id}` | 缓存数据集详情 |
| GET | `/cache/datasets/{dataset_id}/artifacts/{artifact_id}` | 下载缓存数据集 Artifact |
| GET | `/cache/export` | 全量缓存 ZIP 导出 |
| GET | `/skill-iterations/context` | 列出 curated Skill 目标与可选的终态历史范围 |
| POST | `/skill-iterations` | 调用当前模型生成并持久化个性化 Skill 审查候选 |
| WS | `/ws` | durable events + realtime assistant stream |

**API 不变量**：

- 下载只接受 Manifest 注册的 `artifact_id`；
- 客户端不能提交发布阈值或 acceptance policy，只能引用服务端允许的 Profile；
- 主数据通过 `primary_dataset` role 识别，不依赖固定文件名；
- Durable Build 的 start 重试仅在 task/run/build identity 与 canonical request digest
  完全一致时幂等；Run 终态不得替代 Build 终态；
- Build API 与前端只能使用 typed status/result/error code/cancel disposition，不能解析
  error message 推断状态；
- WebSocket 不接受创建 Run 的命令，也不提供 SSE；
- 不安全供应商 URL 返回 422，供应商网络故障返回 502。

> 决策依据：ADR-005（Manifest 驱动产物访问）。
