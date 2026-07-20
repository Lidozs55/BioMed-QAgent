# 前端对话流重构设计 — Coding Agent 风格

- **日期**：2026-07-20
- **状态**：已批准，待实施
- **分支**：`feat/conversation-redesign`
- **范围**：前后端跨层重构，单分支完整交付
- **目标**：把前端对话展示从"聚合消息 + 折叠执行摘要"重构为 coding agent 风格的"按时间顺序交错的步骤流"，让用户输入、思维链、工具调用、阶段进度、产物、警告、总结汇报都以独立项的形式内联展示在对话主流中

---

## 1. 背景与问题

### 1.1 当前前端展示问题（用户反馈 + 调研确认）

1. **消息覆盖感**：单 run 内所有 LLM 文本被聚合到 **一个** messageId（`live:${runId}:assistant`），工具调用被剥离到 `activitiesById` 列表。LLM 在工具调用之间产出的多段文本被拼接成一大段，中间过程视觉上消失。
2. **思维链不可见**：`assistant_reasoning_delta` 虽然被 reducer 收集到 `reasoning:${runId}` activity，但只在 `ExecutionSummary` 折叠面板里以整段灰文本展示，没有逐 token 流式光标，也没有按时间顺序插入到对话流中。
3. **步骤被隐藏**：tool / stage / progress / warning 全部被收集到独立的 `activitiesById`，只在 assistant 消息下方的折叠 Accordion 和右侧 `ToolTrace` 抽屉里平铺展示 —— 不符合 coding agent 风格。
4. **关键元数据缺失**：`ToolStartedPayload` 只有 `tool_call_id` + `tool_name`，**没有 arguments**，所以前端无法显示"阅读 <论文名>"中的论文名、"检索 <数据库>"中的查询串等。

### 1.2 后端事件系统现状（已具备）

- 事件类型齐全：`assistant_delta`（durable，攒批落盘）、`assistant_reasoning_delta`（独立 reasoning 通道，每 chunk 立即落盘）、`tool_started`/`tool_completed`、`stage_started/completed/progress`、`artifact_produced`、`warning`、`user_input_required/resumed` 等。
- `assistant_delta` 是双层架构：durable `AssistantDeltaPayload`（攒批 1KB / 100ms 落盘）+ ephemeral `AssistantStreamDeltaFrame`（每 chunk 立即推 WS，不落盘）。
- `AssistantDeltaPayload` 携带 `stream_id`（如 `assistant:<run_id>:<segment_index>`），被工具调用打断后 segment_index 递增 —— **前端可据此按段拆分**。
- `ToolStartedPayload` 缺 arguments；`ToolCompletedPayload` 已有 `output`（字符串化）但无大小限制。

### 1.3 关键决策（用户已确认）

| 决策点 | 选择 |
|---|---|
| assistant 文本拆分粒度 | **按 tool call 分段成独立项**（Claude Code/Cursor 标准做法） |
| tool arguments 大小限制 | **深度限制 + 大字符串截断**（depth=3, str=200, list=20） |
| reasoning 显示位置 | **每个 tool call 之前独立折叠块**（默认折叠，流式时展开） |
| 废弃组件处理 | **全部删除**（ExecutionSummary / ToolTrace / AgentProgress / ResearchPipeline） |
| 文档更新 | AGENTS.md 仅小量更新；主要更新到 ARCHITECTURE.md / README |

---

## 2. 后端 Schema 改动（最小化）

### 2.1 `ToolStartedPayload` 新增 `arguments` 字段

**文件**：`backend/app/domain/contracts/events.py:299-302`

```python
class ToolStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.TOOL_STARTED] = ...
    tool_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    arguments: dict[str, JsonValue] | None = Field(default=None)  # 新增
```

- `arguments` 为可选字段，向后兼容旧 `events.jsonl`。
- 值为已截断的 dict（见 2.3），可能为 `None`（解析失败或无 arguments）。

### 2.2 发射点注入 arguments

**文件**：`backend/app/agent_loop/runner.py:331-341`（`tool_called` RunItem 处理）

新增 helper：

```python
def _extract_tool_arguments(raw_item: object) -> dict[str, JsonValue] | None:
    """从 SDK raw_item.arguments（JSON 字符串）解析并截断。"""
    args_json = _value(raw_item, "arguments", None)
    if not args_json:
        return None
    try:
        parsed = json.loads(args_json)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return _truncate_for_event(parsed)
```

在 `ToolStartedPayload` 构造处传入：

```python
ToolStartedPayload(
    tool_call_id=call_id,
    tool_name=resolved_name,
    arguments=_extract_tool_arguments(event.item.raw_item),
)
```

### 2.3 截断 helper `_truncate_for_event`

**文件**：`backend/app/agent_loop/runner.py`（新增模块级函数）

```python
def _truncate_for_event(
    value: object,
    *,
    depth: int = 3,
    str_limit: int = 200,
    list_limit: int = 20,
) -> JsonValue:
    """递归截断事件 payload 中的大对象，防止 events.jsonl 膨胀。"""
    if isinstance(value, str):
        return value[:str_limit] + "...[truncated]" if len(value) > str_limit else value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        if depth <= 0:
            return f"[list:{len(value)}]"
        truncated = value[:list_limit]
        return [_truncate_for_event(v, depth=depth - 1, str_limit=str_limit, list_limit=list_limit) for v in truncated]
    if isinstance(value, dict):
        if depth <= 0:
            return f"[dict:{len(value)}]"
        return {
            k: _truncate_for_event(v, depth=depth - 1, str_limit=str_limit, list_limit=list_limit)
            for k, v in value.items()
        }
    return str(value)[:str_limit]
```

### 2.4 `ToolCompletedPayload.output` 截断

**文件**：`backend/app/agent_loop/runner.py:342-359`

在字符串化 output 后应用截断（4KB 上限）：

```python
output_str = str(_value(event.item, "output", ""))
if len(output_str) > 4096:
    output_str = output_str[:4096] + "...[truncated]"
ToolCompletedPayload(
    tool_call_id=call_id,
    tool_name=tool_name or tool_names.get(call_id, "unknown"),
    output=output_str,
    is_error=is_error,
)
```

### 2.5 向后兼容性

- `arguments` 是可选字段（`default=None`），旧 `events.jsonl` 无此字段可正常反序列化。
- 前端 hydrate 旧任务时 `arguments=null`，渲染降级为"调用 {toolName}"。
- 无需数据迁移脚本。

### 2.6 后端测试

**文件**：`backend/tests/agent_loop/test_event_arguments.py`（新增）

覆盖：
1. `arguments` 字段成功注入（mock raw_item.arguments 为合法 JSON）
2. 深度截断：嵌套 dict 超过 depth=3 被替换为 `[dict:N]`
3. 字符串截断：超过 200 字符的字符串被截断
4. 列表截断：超过 20 项的列表被截断
5. 解析失败返回 `None`（malformed JSON）
6. 向后兼容：旧 `events.jsonl`（无 arguments 字段）可正常 load
7. `output` 截断到 4KB

**回归测试**：现有 `tests/agent_loop/test_execution.py` 等不应受影响（arguments 为可选字段）。

---

## 3. 前端数据模型重构

### 3.1 新增 `ConversationItem` 联合类型

**文件**：`frontend/src/runtime/types.ts`

替换原 `ProjectedMessage`：

```typescript
type ConversationItem =
  | UserMessageItem
  | AssistantSegmentItem
  | ReasoningItem
  | ToolCallItem
  | StageItem
  | ProgressItem
  | WarningItem
  | ArtifactItem;

interface ConversationItemBase {
  itemId: string;
  runId: string;
  sequence: number;       // EventEnvelope.sequence，用于排序
  createdAt: string;      // ISO timestamp
}

interface UserMessageItem extends ConversationItemBase {
  kind: "user_message";
  content: string;
}

interface AssistantSegmentItem extends ConversationItemBase {
  kind: "assistant_segment";
  streamId: string;       // assistant:<run_id>:<segment_index>
  content: string;        // 累积的 durableText
  isStreaming: boolean;   // 当前是否有活跃 stream
  finishReason: string | null;
}

interface ReasoningItem extends ConversationItemBase {
  kind: "reasoning";
  content: string;
  isStreaming: boolean;
}

interface ToolCallItem extends ConversationItemBase {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;  // 后端截断后的 args
  status: "running" | "completed" | "error";
  output: string | null;                       // 后端截断到 4KB
  completedSequence: number | null;
}

interface StageItem extends ConversationItemBase {
  kind: "stage";
  stage: StageName;
  status: "running" | "completed" | "failed" | "skipped";
  attempt: number;
  error: string | null;
}

interface ProgressItem extends ConversationItemBase {
  kind: "progress";
  stage: StageName;
  progressKind: string;   // e.g. "records_discovered"
  current: number;
  total: number | null;
}

interface WarningItem extends ConversationItemBase {
  kind: "warning";
  code: string;
  message: string;
}

interface ArtifactItem extends ConversationItemBase {
  kind: "artifact";
  artifactId: string;
  name: string;
  sizeBytes: number;
  mediaType: string;
}
```

### 3.2 `TaskProjection` 字段变更

**文件**：`frontend/src/runtime/types.ts:153-170`

```typescript
interface TaskProjection {
  // ... 保留其他字段 ...
  items: ConversationItem[];              // 替换原 messages: ProjectedMessage[]
  itemSequences: Record<string, number>;  // itemId → latest sequence（去重用）
  // 移除：messages, olderMessagesCursor（保留以支持分页）
  olderMessagesCursor: string | null;     // 保留：分页加载更早消息
  // 移除：activitiesById, activityOrder（已合并到 items）
  // 移除：assistantStreamsByRunId（流式状态内嵌到 item.isStreaming）
  // ...
}
```

**注意**：`assistantStreamsByRunId` 的流式帧处理逻辑保留在 reducer 内部，但对外暴露为 item 的 `isStreaming` 字段。

### 3.3 Reducer 重构

**文件**：`frontend/src/runtime/reducer.ts`

**核心变更**：所有事件处理器从"upsertActivity / upsertMessage"改为"upsertItem"。

#### 3.3.1 新增 `upsertItem` helper

```typescript
function upsertItem(
  task: TaskProjection,
  item: ConversationItem,
): void {
  const existingIdx = task.items.findIndex(i => i.itemId === item.itemId);
  if (existingIdx >= 0) {
    // 保留 createdAt，更新其他字段
    task.items[existingIdx] = { ...task.items[existingIdx], ...item, createdAt: task.items[existingIdx].createdAt };
  } else {
    task.items.push(item);
  }
  task.itemSequences[item.itemId] = item.sequence;
  // 保持按 sequence 升序
  task.items.sort((a, b) => a.sequence - b.sequence);
}
```

#### 3.3.2 各事件处理映射

| 事件 | itemId 生成规则 | item kind |
|---|---|---|
| `run_queued` | 不创建 item（user 消息由 MessageRecord hydrate + ChatPanel 草稿态处理，避免重复） | — |
| `assistant_delta` | `assistant:${streamId}`（streamId 来自 payload） | AssistantSegmentItem |
| `assistant_reasoning_delta` | `reasoning:${runId}:${segmentIndex}`（segmentIndex 由 tool_call 边界分隔） | ReasoningItem |
| `tool_started` | `tool:${runId}:${toolCallId}` | ToolCallItem（status=running） |
| `tool_completed` | 同 tool_started | ToolCallItem（status=completed/error） |
| `stage_started` | `stage:${runId}:${stage}` | StageItem（status=running） |
| `stage_completed` | 同 stage_started | StageItem（status=completed） |
| `stage_failed` | 同 stage_started | StageItem（status=failed） |
| `stage_skipped` | 同 stage_started | StageItem（status=skipped） |
| `stage_progress` | `progress:${runId}:${stage}:${kind}` | ProgressItem（同 kind 原位更新） |
| `warning` | `warning:${sequence}` | WarningItem |
| `artifact_produced` | `artifact:${runId}:${artifactId}` | ArtifactItem |
| `user_input_required` | 不创建 item（仍由 `pendingUserInput` + UserInputDialog 处理） | — |
| `user_input_resumed` | 不创建 item | — |
| `conversation_compacted` | 不创建 item（内部状态） | — |
| `plan_ready` | 不创建 item（由 pendingUserInput.detail 渲染） | — |
| Run 终态（completed/failed/cancelled/interrupted） | 不创建 item（由 ChatPanel 渲染分隔符） | — |

#### 3.3.3 `assistant_delta` 段拆分逻辑

`AssistantDeltaPayload.stream_id` 形如 `assistant:<run_id>` 或 `assistant:<run_id>:<segment_index>`。

- 同一 `stream_id` 的 delta 累积到同一 `AssistantSegmentItem.content`。
- 不同 `stream_id`（工具调用打断后新开段）创建新的 `AssistantSegmentItem`。
- `isStreaming` 由 `AssistantStreamProjection` 是否活跃决定（保留原 transport 层逻辑）。

#### 3.3.4 `assistant_reasoning_delta` 段拆分逻辑

reasoning 没有 stream_id，需要前端自行分隔：
- 在 `TaskProjection` 中维护 `currentReasoningSegmentByRun: Record<string, number>`（runId → 当前段索引），初始空。
- 收到 `assistant_reasoning_delta` 时：若该 run 无记录，初始化为 0；`itemId = reasoning:${runId}:${currentReasoningSegmentByRun[runId]}`。
- 收到 `tool_started` 时：`currentReasoningSegmentByRun[runId]++`，下一段 reasoning 进新 item。
- run 终态时：可清理该 run 的记录（可选，YAGNI）。

#### 3.3.5 Hydrate 兼容

`MessageRecord` 映射：
- `role=user` → `UserMessageItem`（itemId=`msg:${messageId}`, sequence=0 或 message.sequence）
- `role=assistant` → `AssistantSegmentItem`（itemId=`msg:${messageId}`, streamId=`hydrate:${messageId}`）
- 其他 role 忽略

事件回放时，如果 `itemId` 冲突（hydrate 已创建 + 事件回放又创建），以事件回放为准（覆盖）。

### 3.4 Selector 重构

**文件**：`frontend/src/stores/agentSelectors.ts`

- `selectTaskMessages` → `selectTaskItems`：返回 `ConversationItem[]`
- 移除 `selectTaskActivities`（已合并）
- 新增 `selectActiveItem`：返回当前 `isStreaming=true` 或 `status=running` 的 item

### 3.5 前端测试

**文件**：
- 重写 `frontend/src/runtime/__tests__/reducer.test.ts`：覆盖所有 item 类型的创建、更新、去重、排序
- 新增 `frontend/src/runtime/__tests__/items-ordering.test.ts`：sequence 排序、跨 run 顺序
- 新增 `frontend/src/runtime/__tests__/hydrate-compat.test.ts`：MessageRecord → item 映射、事件回放覆盖

---

## 4. 前端组件结构

### 4.1 新增 `conversation/` 目录

**目录**：`frontend/src/components/conversation/`

```
conversation/
├── ConversationList.tsx       # 列表渲染器
├── ConversationStep.tsx       # kind 分发器
├── UserMessageBubble.tsx
├── AssistantSegment.tsx
├── ReasoningBlock.tsx
├── ToolCallStep.tsx
├── StageStep.tsx
├── ProgressStep.tsx
├── WarningStep.tsx
├── ArtifactStep.tsx
├── toolLabels.ts              # toolName + args → 显示标签映射
└── __tests__/
    ├── ConversationStep.test.tsx
    ├── ToolCallStep.test.tsx
    ├── ReasoningBlock.test.tsx
    └── toolLabels.test.ts
```

### 4.2 `ConversationList.tsx`

```typescript
interface ConversationListProps {
  items: ConversationItem[];
  activeRunId: string | null;
}

export function ConversationList({ items, activeRunId }: ConversationListProps) {
  return (
    <MessageScrollerContent>
      {items.map(item => (
        <ConversationStep
          key={item.itemId}
          item={item}
          isActive={item.runId === activeRunId}
        />
      ))}
    </MessageScrollerContent>
  );
}
```

### 4.3 `ConversationStep.tsx`（分发器）

```typescript
export function ConversationStep({ item, isActive }: { item: ConversationItem; isActive: boolean }) {
  switch (item.kind) {
    case "user_message": return <UserMessageBubble item={item} />;
    case "assistant_segment": return <AssistantSegment item={item} />;
    case "reasoning": return <ReasoningBlock item={item} />;
    case "tool_call": return <ToolCallStep item={item} />;
    case "stage": return <StageStep item={item} />;
    case "progress": return <ProgressStep item={item} />;
    case "warning": return <WarningStep item={item} />;
    case "artifact": return <ArtifactStep item={item} />;
    default: return null;
  }
}
```

### 4.4 `toolLabels.ts`（显示标签映射）

```typescript
interface ToolLabel {
  verb: string;       // 动词，如"检索"、"阅读"、"下载"
  target: string;     // 目标，如"PubMed"、"GEO 数据集 GSE178352"
  details?: string;   // 补充详情，如查询串、页码
}

const TOOL_LABEL_MAP: Record<string, (args: Record<string, unknown> | null) => ToolLabel> = {
  search_pubmed_adapter: args => ({
    verb: "检索",
    target: "PubMed",
    details: args?.query ? `查询: "${String(args.query)}"` : undefined,
  }),
  download_supplementary: args => ({
    verb: "阅读",
    target: args?.pmid ? `论文 PMID ${args.pmid}` : "论文",
    details: args?.suppl_kind ? `附件类型: ${args.suppl_kind}` : undefined,
  }),
  download_geo: args => ({
    verb: "下载",
    target: args?.accession ? `GEO 数据集 ${args.accession}` : "GEO 数据集",
  }),
  parse_excel: args => ({ verb: "解析", target: "Excel 文件", details: args?.file_path ? String(args.file_path) : undefined }),
  parse_pdf: args => ({ verb: "解析", target: "PDF 文件", details: args?.file_path ? String(args.file_path) : undefined }),
  parse_cache_export_zip: args => ({ verb: "解析", target: "缓存包 ZIP" }),
  run_research_pipeline: () => ({ verb: "启动", target: "研究流水线" }),
  review_query_strategy: () => ({ verb: "审查", target: "查询策略" }),
  commit_to_cache: () => ({ verb: "导入", target: "缓存" }),
  extract_chart_data_vlm: args => ({ verb: "提取", target: "图表数据", details: args?.image_path ? String(args.image_path) : undefined }),
  capture_web_page: args => ({ verb: "采集", target: "网页截图", details: args?.url ? String(args.url) : undefined }),
  capture_page_section: args => ({ verb: "采集", target: "网页区域截图", details: args?.url ? String(args.url) : undefined }),
  // 兜底
};

export function formatToolCall(toolName: string, args: Record<string, unknown> | null): ToolLabel {
  const formatter = TOOL_LABEL_MAP[toolName];
  if (formatter) return formatter(args);
  return { verb: "调用", target: toolName };
}
```

**兜底策略**：未在映射表中的工具显示"调用 {toolName}"。映射表可渐进式完善，初版覆盖现有 ~14 个工具。

### 4.5 `ToolCallStep.tsx`

```typescript
export function ToolCallStep({ item }: { item: ToolCallItem }) {
  const label = formatToolCall(item.toolName, item.arguments);
  const [expanded, setExpanded] = useState(false);
  const isRunning = item.status === "running";

  return (
    <Message align="start">
      <Bubble variant="ghost" className="gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          {isRunning ? <Spinner /> : item.status === "error" ? <ErrorIcon /> : <CheckIcon />}
          <span className="font-medium">{label.verb} {label.target}</span>
          {label.details && <span className="text-muted-foreground text-sm">{label.details}</span>}
          <ChevronIcon className={expanded ? "rotate-180" : ""} />
        </button>
        {expanded && (
          <div className="mt-2 space-y-2 text-sm">
            {item.arguments && (
              <details>
                <summary>输入参数</summary>
                <pre className="text-xs bg-muted/50 p-2 rounded">{JSON.stringify(item.arguments, null, 2)}</pre>
              </details>
            )}
            {item.output && (
              <details>
                <summary>输出{item.status === "error" ? "（错误）" : ""}</summary>
                <pre className={`text-xs p-2 rounded ${item.status === "error" ? "bg-destructive/10" : "bg-muted/50"}`}>
                  {item.output}
                </pre>
              </details>
            )}
          </div>
        )}
      </Bubble>
    </Message>
  );
}
```

### 4.6 `ReasoningBlock.tsx`

```typescript
export function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? item.isStreaming;  // 流式时默认展开，否则默认折叠

  return (
    <div className="my-1">
      <button
        onClick={() => setUserToggled(!expanded)}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {item.isStreaming ? <ShimmerDot /> : <BrainIcon />}
        <span>{item.isStreaming ? "思考中..." : "思维链"}</span>
        <ChevronIcon className={expanded ? "rotate-180" : ""} />
      </button>
      {expanded && (
        <div className="mt-1 pl-6 border-l-2 border-muted whitespace-pre-wrap text-sm text-muted-foreground">
          {item.content}
          {item.isStreaming && <span className="animate-pulse">▋</span>}
        </div>
      )}
    </div>
  );
}
```

**自动折叠**：流式结束时（`isStreaming` 从 true→false），若用户未手动操作（`userToggled === null`），500ms 后自动折叠（用 `useEffect` + setTimeout）。

### 4.7 `AssistantSegment.tsx`

```typescript
export function AssistantSegment({ item }: { item: AssistantSegmentItem }) {
  return (
    <Message align="start">
      <Bubble variant="ghost">
        <MarkdownContent content={item.content} streaming={item.isStreaming} />
        {item.isStreaming && <span className="animate-pulse">▋</span>}
      </Bubble>
    </Message>
  );
}
```

### 4.8 `StageStep.tsx` / `ProgressStep.tsx` / `WarningStep.tsx` / `ArtifactStep.tsx`

紧凑单行展示，不可折叠：

```typescript
// StageStep
<Message align="start">
  <Bubble variant="ghost" className="text-sm gap-2">
    {statusIcon}
    <span>阶段：{STAGE_LABELS[stage]}</span>
    <Badge>{statusLabel}</Badge>
  </Bubble>
</Message>

// ProgressStep
<Message align="start">
  <Bubble variant="ghost" className="text-sm gap-2">
    <ProgressIcon />
    <span>{PROGRESS_LABELS[kind] ?? kind}：{current}{total ? ` / ${total}` : ""}</span>
  </Bubble>
</Message>

// WarningStep
<Message align="start">
  <Bubble variant="ghost" className="text-sm gap-2 text-yellow-700 dark:text-yellow-400">
    <WarningIcon />
    <span>{message}</span>
    <Badge variant="outline">{code}</Badge>
  </Bubble>
</Message>

// ArtifactStep
<Message align="start">
  <Bubble variant="ghost" className="text-sm gap-2">
    <FileIcon />
    <span>生成产物：{name}</span>
    <Badge variant="secondary">{formatBytes(sizeBytes)}</Badge>
  </Bubble>
</Message>
```

### 4.9 `ChatPanel.tsx` 重构

**文件**：`frontend/src/components/ChatPanel.tsx`

主要变更：
1. 移除 `messages.map` 渲染，替换为 `<ConversationList items={items} activeRunId={activeRunId} />`
2. 移除 `ExecutionSummary` 嵌套
3. 移除 `assistantStreamsByRunId` 查询（改为 selector `selectActiveItem`）
4. 状态条简化：显示当前活跃 item 的简述（如"[检索 PubMed] 正在搜索 'lung cancer'..."）
5. 保留：断连告警、加载更早消息按钮、完成分隔符、失败告警、UserInputDialog、底部 AgentComposer

**状态条简化逻辑**：

```typescript
const activeItem = useAgentStore(selectActiveItem);
const statusText = activeItem
  ? formatActiveItemStatus(activeItem)  // 如"检索 PubMed · 查询: 'lung cancer'"
  : STATUS_LABELS[task.summary.status];
```

### 4.10 删除文件

- `frontend/src/components/ExecutionSummary.tsx`
- `frontend/src/components/ToolTrace.tsx`
- `frontend/src/components/AgentProgress.tsx`
- `frontend/src/components/ResearchPipeline.tsx`
- 对应测试文件：
  - `frontend/src/components/__tests__/ExecutionSummary.test.tsx`（如存在）
  - `frontend/src/components/__tests__/ToolTrace.test.tsx`（如存在）
  - `frontend/src/components/__tests__/agent-progress.test.tsx`
  - `frontend/src/components/__tests__/research-pipeline.test.tsx`

### 4.11 App.tsx 调整

**文件**：`frontend/src/components/App.tsx`

移除 `ToolTrace` 相关代码（Sheet 触发按钮、Sheet 组件引用）。

### 4.12 前端测试

- `ConversationStep.test.tsx`：每种 kind 渲染快照
- `ToolCallStep.test.tsx`：running/completed/error 三态、展开/折叠、arguments/output 渲染
- `ReasoningBlock.test.tsx`：默认折叠、流式时展开、流式结束自动折叠、用户手动操作覆盖自动行为
- `toolLabels.test.ts`：映射覆盖、兜底
- 修复 `ChatPanel.test.tsx`（如存在）以适配新渲染

---

## 5. 视觉与交互细节

### 5.1 默认折叠策略

| 组件 | 默认状态 | 流式时 | 流式结束后 |
|---|---|---|---|
| ReasoningBlock | 折叠 | 自动展开 + "思考中..." | 500ms 后自动折叠（若用户未手动操作） |
| ToolCallStep | 折叠（仅显示标签行） | 不适用（tool 不流式） | 不适用 |
| AssistantSegment | 展开 | 展开 + 光标 | 展开 |
| StageStep/ProgressStep/WarningStep/ArtifactStep | 展开（紧凑单行） | 不适用 | 不适用 |

### 5.2 活跃指示

- `ToolCallItem.status === "running"`：显示 Spinner + 标签
- `AssistantSegmentItem.isStreaming === true`：显示 `▋` 闪烁光标（CSS `animate-pulse`）
- `ReasoningItem.isStreaming === true`：显示"思考中..."shimmer 动画

### 5.3 状态条（ChatPanel 顶部）

- 有活跃 item 时：显示 `[动词 目标] 详情...`，如"[检索 PubMed] 查询: 'lung cancer'"
- 无活跃 item 时：显示 run 状态文案（如"任务已完成"/"等待执行"）
- 复用 `formatToolCall` 生成活跃 tool call 的简述

### 5.4 完成分隔符

保留现有行为：run 终态时显示"任务完成"/"任务失败"分隔符（`Marker variant="separator"`）。

### 5.5 滚动行为

复用现有 `MessageScroller` 的 `autoScroll` 行为：新 item 到达时自动滚动到底部（若用户已在底部）。

---

## 6. 实施顺序与质量门禁

### 6.1 实施顺序（单分支 `feat/conversation-redesign`）

1. **后端 schema + arguments 注入 + 截断 + 测试**
   - 修改 `events.py`：`ToolStartedPayload.arguments`
   - 修改 `runner.py`：`_extract_tool_arguments` + `_truncate_for_event` + output 截断
   - 新增 `tests/agent_loop/test_event_arguments.py`
   - **验证**：`uv run pytest` 通过

2. **前端类型 + reducer 重构 + 测试**
   - 修改 `types.ts`：`ConversationItem` 联合 + `TaskProjection.items`
   - 重写 `reducer.ts`：`upsertItem` + 各事件处理
   - 修改 `agentSelectors.ts`：`selectTaskItems` + `selectActiveItem`
   - 重写 `reducer.test.ts`；新增 `items-ordering.test.ts` + `hydrate-compat.test.ts`
   - **验证**：`pnpm tsc` + `pnpm test` 通过

3. **前端组件实现 + 测试**
   - 新建 `conversation/` 目录及所有子组件
   - 实现 `toolLabels.ts` 映射表
   - 新增组件测试
   - **验证**：`pnpm test` 通过

4. **ChatPanel 重构 + 删除废弃组件**
   - 修改 `ChatPanel.tsx`：接入 `ConversationList`
   - 修改 `App.tsx`：移除 ToolTrace
   - 删除 4 个废弃组件 + 测试
   - **验证**：`pnpm lint && pnpm tsc && pnpm build` 通过

5. **状态条 + 流式光标**
   - 实现 `selectActiveItem` + 状态条简化
   - 实现 `▋` 光标动画 + ReasoningBlock 自动折叠
   - **验证**：`pnpm test` 通过

6. **e2e 手动验证**
   - 启动后端：`uv run uvicorn app.main:app --reload`（cwd: `backend/`）
   - 启动前端：`pnpm dev`（cwd: `frontend/`）
   - 跑一个真实研究任务（fixture 模式优先，避免耗网络）
   - 观察对话流：用户输入 → reasoning → tool call → progress → assistant segment → artifact → 完成
   - 验证流式光标、自动折叠、展开详情

7. **文档更新**
   - **AGENTS.md**（小量）：§2 事件类型列表补全（`assistant_reasoning_delta` / `stage_progress` / `conversation_compacted` / `stage_failed` / `stage_skipped` / `run_finalizing` / `run_interrupted` / `run_cancel_requested` / `task_created` / `task_cancel_requested` / `task_recovered` / `task_completed` / `task_failed`）；`ToolStartedPayload` 增补 `arguments` 字段说明
   - **docs/ARCHITECTURE.md**（主要）：新增"前端对话流展示"章节，描述 ConversationItem 模型、toolLabels 映射、折叠策略
   - **frontend/README.md**（主要）：更新组件清单（移除 ExecutionSummary/ToolTrace，新增 conversation/ 目录）；更新 store 结构说明
   - **backend/README.md**（小量）：事件 schema 变更说明

### 6.2 质量门禁（合并前必须全过）

- **后端**：
  - `uv run pytest` 全绿
  - `uv run ruff check app/ tests/ launcher.py` 零警告
  - 清 `__pycache__` 后 `uv run uvicorn app.main:app --reload` 正常启动
- **前端**：
  - `pnpm lint` 零警告
  - `pnpm tsc` 零错误
  - `pnpm build` 成功
  - `pnpm test` 全绿
- **手动 e2e**：研究任务全流程对话流正常显示

### 6.3 风险与缓解

| 风险 | 缓解 |
|---|---|
| reducer 重构影响面大 | 先写新 reducer 单元测试覆盖所有事件类型，再切换；保留 `olderMessagesCursor` 分页逻辑 |
| arguments 可能泄露敏感信息 | 深度限制 + 字符串 200 字符截断；后端统一应用截断 |
| items 列表可能很长 | 当前 MessageScroller 已有分页；先观察，如需虚拟滚动后续优化（YAGNI） |
| hydrate 与事件回放 items 重建不一致 | MessageRecord 映射规则明确（3.3.5）；事件回放幂等（upsertItem 按 itemId 去重） |
| 旧 `events.jsonl` 无 arguments 字段 | 可选字段 + 前端兜底"调用 {toolName}"，无需数据迁移 |
| 删除废弃组件可能漏改引用 | 删除前全局 grep 确认无引用；tsc + lint 守卫 |

---

## 7. 范围边界（YAGNI）

### 7.1 本次不做

- 不引入虚拟滚动（先观察 items 列表长度）
- 不做"复制 tool call 输出"按钮
- 不做 tool call 耗时显示（后端事件无 timestamp 差字段；前端可后续用 sequence 差值估算）
- 不修改后端 `MessageRecord` schema（hydrate 兼容靠前端映射）
- 不做"折叠/展开所有"批量操作
- 不引入新 shadcn 组件（复用现有 Accordion/Card/Badge/Spinner）
- 不修改 WebSocket 传输层（事件流不变）
- 不修改 `UserInputDialog`（plan_confirmation / max_turns_reached / data_correction 仍走模态框）
- 不为 `ToolCalledPayload`（流水线侧）增加 arguments（流水线侧只有 arguments_digest，无原始 args）
- 不做 tool call 的嵌套层级（如"在 Stage Y 中调用了 Tool X"）—— 平铺按 sequence 排序即可

### 7.2 未来可扩展

- tool call 耗时显示（需后端事件增补 timestamp 或前端估算）
- 虚拟滚动（若 items 列表超过 500 项）
- tool call 嵌套层级（需引入 parent_item_id 字段）
- 更多 tool 的 toolLabels 映射（新工具上线时补充）

---

## 8. 验收清单

### 8.1 后端

- [ ] `ToolStartedPayload.arguments` 字段定义
- [ ] `_extract_tool_arguments` + `_truncate_for_event` 实现
- [ ] `ToolCompletedPayload.output` 截断到 4KB
- [ ] `tests/agent_loop/test_event_arguments.py` 7 个用例全绿
- [ ] `uv run pytest` 全绿
- [ ] `uv run ruff check` 零警告
- [ ] uvicorn 启动正常

### 8.2 前端类型与 reducer

- [ ] `ConversationItem` 联合类型定义
- [ ] `TaskProjection.items` 字段替换 `messages` + `activitiesById`
- [ ] `upsertItem` helper 实现
- [ ] 各事件处理映射到 item kind
- [ ] `assistant_delta` 段拆分（按 streamId）
- [ ] `assistant_reasoning_delta` 段拆分（按 tool_call 边界）
- [ ] Hydrate 兼容（MessageRecord → item）
- [ ] `agentSelectors.ts` 更新
- [ ] reducer 单元测试全绿
- [ ] `pnpm tsc` 零错误

### 8.3 前端组件

- [ ] `conversation/` 目录及 11 个子组件
- [ ] `toolLabels.ts` 映射表覆盖 ~14 个工具
- [ ] `ToolCallStep` 三态（running/completed/error）+ 展开/折叠
- [ ] `ReasoningBlock` 默认折叠 + 流式展开 + 结束自动折叠
- [ ] `AssistantSegment` 流式光标
- [ ] `StageStep`/`ProgressStep`/`WarningStep`/`ArtifactStep` 紧凑单行
- [ ] 组件测试全绿

### 8.4 ChatPanel 重构

- [ ] `ChatPanel.tsx` 接入 `ConversationList`
- [ ] 状态条简化（活跃 item 简述）
- [ ] 移除 `ExecutionSummary` 嵌套
- [ ] `App.tsx` 移除 `ToolTrace`
- [ ] 删除 4 个废弃组件 + 测试
- [ ] `pnpm lint && pnpm tsc && pnpm build` 通过

### 8.5 文档

- [ ] AGENTS.md §2 事件列表补全 + `arguments` 字段说明
- [ ] docs/ARCHITECTURE.md 新增"前端对话流展示"章节
- [ ] frontend/README.md 组件清单 + store 结构更新
- [ ] backend/README.md 事件 schema 变更说明

### 8.6 e2e 验证

- [ ] 后端 + 前端启动正常
- [ ] fixture 模式研究任务对话流正常
- [ ] 流式光标、自动折叠、展开详情交互正常
- [ ] 无控制台错误

---

## 9. Commonly 协作（如连接）

按 AGENTS.md Part II：
- 开工前：`[TASK] 前端对话流重构（coding agent 风格），分支 feat/conversation-redesign`
- 完工后：`[DONE] 前端对话流重构完成，已合并到 main`（含变更摘要 + 分支名）

---

## 10. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| assistant 文本拆分 | 按 tool call 分段成独立项 | Claude Code/Cursor 标准做法，视觉最清晰 |
| arguments 大小限制 | 深度限制 + 字符串截断 | 最通用，无需维护白名单 |
| reasoning 显示 | 每个 tool call 之前独立折叠块 | 符合 coding agent 习惯，按时间顺序 |
| 废弃组件 | 全部删除 | 新 UI 完全替代，避免代码冗余 |
| arguments 注入位置 | agent_loop/runner.py 统一注入 | 无需逐个修改 skill |
| 文档主要更新位置 | ARCHITECTURE.md / README | AGENTS.md 保持精简 |
