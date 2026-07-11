# BioMed QAgent 核心架构基础设计

## 1. 目标

本阶段把当前“主 Agent 直接持有全部 SDK Tool”的演示骨架，改造成可测试、可恢复、可替换运行时的应用基础。系统仍使用 Qwen 与 OpenAI Agents SDK，但 SDK 只存在于基础设施层；任务状态、事件、数据契约、文件安全与持久化由应用自身控制。

本阶段不实现真实文献、GEO、浏览器采集、复杂清洗或图表解析。它交付后，这些能力可以通过稳定契约并行开发。

## 2. 产品边界

- 用户只需要提供一个非空研究主题；其他过滤条件均可选。
- 系统输出数据覆盖、来源、处理过程、质量问题和限制，不生成科研或临床结论。
- 主产物是结构化数据与 provenance，而不是 Markdown 研究报告。
- 数据源只能从批准的 Source Catalog 中选择；未知来源发现后只能形成候选。
- 浏览器是受控获取后端，不是可以绕过访问控制的通用上网能力。

## 3. 架构边界

```text
API / WebSocket
      ↓
TaskService + TaskStateMachine
      ↓
AgentRuntime port ─────→ infrastructure/openai_agents
      ↓
SkillExecutor（后续阶段）
      ↓
普通 Python Tool / Service
      ↓
SourceAdapter / Repository / ArtifactStore
```

依赖规则：

1. `domain/` 不依赖 FastAPI、OpenAI、Agents SDK、SQLite 或文件系统。
2. `application/` 只依赖 `domain/` 和 `ports/`。
3. `ports/` 只定义 Protocol 和运行时无关 DTO。
4. 只有 `infrastructure/openai_agents/` 可以导入 `agents` 或 `openai`。
5. WebSocket 只发送版本化内部 `AgentEvent`，不暴露 SDK 事件对象。
6. Tool 保持普通 Python 方法；在 composition root 才包装成 SDK FunctionTool。

## 4. 核心模型

### TaskRequest

- `topic: str`：唯一必填业务字段，去除首尾空白后不能为空。
- `preferred_sources: list[str]`：用户选择的数据源。
- `keywords: list[str]`、`target_fields: list[str]`：可选约束。

### TaskStatus

允许的主路径：

```text
created → planning → running → reviewing → exporting → completed
              └──────────────→ waiting_for_user
任意非终态 → failed / cancelled
waiting_for_user → running / cancelled
```

非法迁移必须抛出领域异常，不能静默修正。

### AgentEvent

所有对外事件包含：

- `schema_version`
- `event_id`
- `task_id`
- `run_id`
- `sequence`
- `timestamp`
- `event_type`
- `payload`

首批事件：`task.created`、`task.status_changed`、`agent.message.delta`、`tool.started`、`tool.completed`、`approval.required`、`task.completed`、`task.failed`。

### RuntimeEvent

SDK 适配器只产生未封装的 `RuntimeEvent(event_type, payload)`。`TaskService` 负责生成全局递增 sequence 和 `AgentEvent` envelope，避免 SDK 运行事件与应用事件序号冲突。

## 5. AgentRuntime

`AgentRuntime` 是应用层唯一可见的 Agent 运行接口：

```python
class AgentRuntime(Protocol):
    def stream(self, request: AgentRunRequest) -> AsyncIterator[RuntimeEvent]: ...
```

`AgentRunRequest` 只包含 `task_id`、`run_id`、`user_input` 和运行限制。SDK 的 Agent、Runner、Session、RunState、stream event 均不得越过该接口。

SDK 事件映射必须：

- 仅将 `ResponseTextDeltaEvent` 映射为 `agent.message.delta`；
- 将 `RunItemStreamEvent.name == tool_called` 映射为 `tool.started`；
- 将 `RunItemStreamEvent.name == tool_output` 映射为 `tool.completed`；
- 忽略工具参数增量等非文本 raw event；
- 将异常转成受控 `task.failed`，同时保留内部日志。

## 6. 任务持久化

本阶段使用 SQLite 保存任务元数据：`task_id`、`status`、`request_json`、`plan_json`、`created_at`、`updated_at`、`error_message`。Repository 使用标准 `sqlite3`，不引入 ORM。

任务 ID 只能是 1–64 位 ASCII 字母、数字、下划线或短横线；未提供时由服务端生成 UUID。持久化对话历史、RunState、provenance 和 Artifact 索引属于后续阶段。

## 7. 文件 Tool 安全

文件操作由普通 `WorkspaceService` 实现：

- 只允许相对于任务 workspace 的路径；
- 拒绝绝对路径、`..` 逃逸、目录读取和 workspace 外符号链接；
- UTF-8 文本读写；
- 写入后返回相对路径，不向模型暴露宿主机绝对路径。

SDK Tool 只负责参数 schema 和调用 `WorkspaceService`，不直接处理路径。

## 8. 前端协议

WebSocket 连接必须只有一个所有者。`useAgentStream` 的同一实例负责 `connect` 与 `send`，组件卸载时关闭连接。前端消费 `AgentEvent` envelope，并根据 `event_type` 更新消息、状态和 Tool Trace。

必须修复 TypeScript 配置与被忽略的 `src/lib/utils.ts`，保证干净克隆后可构建。

## 9. 测试与验收

- 领域模型测试：主题校验、任务 ID、状态迁移、事件序号。
- Repository 测试：创建、读取、更新、失败记录。
- SDK 合约测试：文本、工具调用、工具结果、非文本 delta。
- 文件安全测试：绝对路径、路径穿越、workspace 外访问。
- 架构测试：除 `infrastructure/openai_agents` 外禁止导入 `agents/openai`。
- 前端测试：同一客户端连接与发送；内部事件正确进入 store。
- 完整验证：Backend pytest、Frontend Vitest、TypeScript check、Vite build。

## 10. 非目标

- 不实现 Skill 自迭代、向量缓存或未知网站自动学习。
- 不实现多 Agent handoff。
- 不实现真实数据源、PDF/图表解析或科研分析。
- 不承诺跨进程 WebSocket 事件恢复；本阶段只建立后续扩展所需接口。

