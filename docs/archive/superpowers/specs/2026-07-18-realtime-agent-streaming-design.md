# 实时 Agent 文本流设计

**日期：** 2026-07-18
**状态：** 已批准设计，待实现
**范围：** 在既有 durable task event WebSocket 上增加仅用于即时显示的 Agent 文本流；不改变任务事件日志、重放或任务状态机的权威性。

## 1. 目标与非目标

用户应在模型生成助手文本时立即看到逐段输出，同时仍可通过现有
[durable runtime 架构](../../ARCHITECTURE.md#8-durable-api控制面与事件面)可靠地恢复、重放和审计任务。

本设计不传输或展示模型的原始思维链（CoT）。界面中的执行摘要只能由已经持久化的工具、阶段、进度和 warning 事件派生。文本流也不用于传送工具参数、密钥或任何未脱敏的内部推理。

## 2. 权威事件与即时帧

`EventEnvelope`、`events.jsonl`、任务级 `sequence`、REST `/events` 重放以及现有 WebSocket durable event fan-out 继续是唯一的权威事实来源。所有 durable 事件仍须先持久化、后发布，并可按 `sequence` 重放；新增能力不得改变该顺序或降低断线恢复能力。

同一 WebSocket 可以额外发送下列**非 durable**帧。这些帧不写入 `events.jsonl`，不进入 `TaskSnapshot`，没有 `sequence`、`event_id` 或 `timestamp`，不能被 REST 重放，也不能驱动任务状态转换。

### 2.1 `assistant_stream_delta`

```json
{
  "type": "assistant_stream_delta",
  "task_id": "task_…",
  "run_id": "run_…",
  "stream_id": "stream_…",
  "chunk_index": 0,
  "delta": "正在检索文献…"
}
```

字段契约：

| 字段 | 规则 |
| --- | --- |
| `type` | 固定为 `assistant_stream_delta`。 |
| `task_id` | 非空任务标识。 |
| `run_id` | 非空 Run 标识；必须属于该任务。 |
| `stream_id` | 非空文本流标识；在同一 Run 内唯一，生命周期由对应 end 帧界定。 |
| `chunk_index` | 非负整数，从 0 开始；同一 `(task_id, run_id, stream_id)` 中严格单调递增且不重复。 |
| `delta` | 非空 UTF-8 文本片段。 |

### 2.2 `assistant_stream_end`

```json
{
  "type": "assistant_stream_end",
  "task_id": "task_…",
  "run_id": "run_…",
  "stream_id": "stream_…",
  "last_chunk_index": 18,
  "finish_reason": "stop"
}
```

字段 `type`、`task_id`、`run_id`、`stream_id` 的约束与 delta 帧相同。`last_chunk_index` 为最后一个已发布 delta 的索引；从未生成文本时为 `null`。`finish_reason` 是非空、面向协议的结束原因（例如 `stop`、`tool_call`、`length`、`cancelled`、`error`），供 UI 表示流已结束，不能单独决定 Run 成功或失败。

服务端只在已订阅该 `task_id` 的连接发送即时帧。连接、订阅或发送失败不会阻止模型执行、durable 批量落盘或终态处理。

## 3. 后端生产与持久化策略

每一段上游模型文本到达后，后端按以下顺序处理：

1. 分配或取得本段所属 `stream_id` 与下一个 `chunk_index`。
2. 先向该任务的订阅者发送 `assistant_stream_delta`。
3. 将同一文本追加到既有 durable `assistant_delta` 的 100 ms / 1 KB 批处理缓冲区。
4. 到达任一阈值时持久化一条批量事件；向 durable `EventHub` 发布仍遵循“先持久化、后发布”。

为使两条通道可以精确对账，`AssistantDeltaPayload` 新增三个可选字段，且必须**全有或全无**：

| 字段 | 规则 |
| --- | --- |
| `stream_id` | 对应实时流标识。 |
| `from_chunk_index` | 本 durable 文本批次覆盖的第一个实时 chunk 索引。 |
| `through_chunk_index` | 本 durable 文本批次覆盖的最后一个实时 chunk 索引，且不小于 `from_chunk_index`。 |

这三个字段均不存在时，事件保持现有 `assistant_delta` 语义；历史日志和旧客户端完全兼容。新实现不得产生仅带其中一部分范围字段的 payload。每个带范围的 durable delta 的文本，必须恰好由该闭区间内实时 chunk 的拼接构成。

在工具调用开始或结束、Run 终态（completed/failed/cancelled/interrupted）、上游错误及取消请求边界之前，必须先强制 flush 未持久化的文本批次；随后发送 `assistant_stream_end`（若已有流）。因此边界前已经展示的文本总能在 durable 日志中得到覆盖，即使连接在 end 帧前中断。

`finish_reason="length"`、上游异常或取消仍按既有 Run 状态与 warning/error 事件处理；end 帧只是显示通道的收尾通知，不能掩盖失败或改变现有终态语义。

## 4. 前端合并、渲染与重连

前端以 `(task_id, run_id, stream_id)` 建立临时流缓冲区，记录已见 `chunk_index`、其文本及已被 durable 范围确认的索引。收到即时 delta 时：

- 仅接受合法且未见过的 `chunk_index`；重复帧、倒退帧或与已缓存内容冲突的帧不得重复渲染，冲突记录为诊断信息；
- 将文本加入临时显示层，但**绝不**修改 `lastSequence` 或任何任务的 durable sequence watermark；
- 将 UI 刷新合并为每个动画帧至多一次（`requestAnimationFrame`）；在 `prefers-reduced-motion: reduce` 下仍即时呈现文本，但不使用闪烁/逐字动画。

收到带完整三字段范围的 durable `assistant_delta` 时，前端以 `stream_id` 和闭区间确认已经显示的 chunk。已由实时层显示的范围只标记为 durable-confirmed，不再追加一次文本；缺失实时 chunk、重连期间丢失的 chunk、以及旧式无范围 durable delta 则由 durable 事件直接追加。这样同一段文本无论先到哪条通道都只显示一次。

收到 `assistant_stream_end` 时，前端停止该流的光标并保留尚未由 durable 事件确认的文本，等待相应 durable 批次、终态或重连重放。若 WebSocket 断线、订阅切换或页面恢复，丢弃所有未确认的即时缓冲，并完全依赖既有 `/events?after_sequence=N` 与 subscribe 重放重新建立显示；实时帧从不参与 replay cursor。

旧服务端只发送 durable `assistant_delta` 时，客户端按现有方式渲染。旧客户端不识别新帧时应安全忽略它们，继续消费 durable envelope。服务端和客户端均必须校验帧形状，未知实时帧不得影响 durable 协议处理。

## 5. 可审计执行摘要与交互

聊天/任务界面在助手消息旁显示可展开的“执行摘要”。摘要仅投影以下 durable 事件：`tool_started` / `tool_completed`、stage 事件、`stage_progress` 与 `warning`。它可以展示工具名称、成功/错误状态、公开的结果摘要、阶段进度和警告，但不展示原始 CoT、模型内部消息或被工具输出中判定为敏感的数据。

仅当存在当前 Run 的活动 `assistant_stream_delta`，且尚未收到其 `assistant_stream_end` 或相应工具/终态边界时，助手文本末尾显示光标。光标在 reduced-motion 下采用静态、非动画替代样式；流结束、断线或任务不再处于活动文本输出时立即隐藏。

## 6. 故障、慢消费者与安全

- **上游失败或取消：** 先 flush durable 缓冲，再发送带相应 `finish_reason` 的 end 帧；Run 的失败/取消仍由 durable 事件表达。
- **重连：** 即时帧不可恢复，客户端放弃未确认显示并以 durable sequence 重放为准；不会因为实时帧缺失而跳过或推进 durable sequence。
- **慢消费者：** 保持现有 durable 订阅溢出策略（关闭并要求重连重放）。实时帧必须使用有界、可丢弃的发送路径；拥塞时丢弃实时帧而非阻塞 durable 持久化、事件发布或其他订阅者。丢失的内容由后续 durable delta 恢复。
- **兼容性：** 新 range 字段为 all-or-none optional；没有它们的历史/旧事件不改变含义。实时帧不能伪装为 `EventEnvelope`。
- **安全：** `task_id` 订阅授权和既有连接隔离同样适用于实时帧；发送前按现有输出安全策略过滤敏感内容。服务端不得接受客户端伪造的实时 delta/end 帧，客户端不得把其持久化或作为状态转换输入。

## 7. 验收测试

实现必须覆盖以下行为：

1. 一段模型输出先产生连续、零起始的实时 delta，随后在不超过 100 ms 或 1 KB 时产生带正确闭区间的 durable `assistant_delta`；前端只显示一次。
2. 低流量缓冲在工具、终态、错误和取消边界前被 flush，随后产生正确的 end 帧；无文本流的 `last_chunk_index` 为 `null`。
3. 断线/重连或慢消费者丢失实时帧后，仅用 durable replay 恢复完整文本；任务 sequence/watermark 不会因实时帧变化。
4. 重复、乱序、未知或格式不合法的实时帧不会造成重复文本、任务状态变化或协议崩溃。
5. 旧日志、旧客户端和仅有无范围 `assistant_delta` 的服务端保持可用；新客户端可同时处理旧式和带范围事件。
6. 执行摘要只来自 durable 工具/阶段/进度/warning 事件，不包含 CoT；活动流才显示光标，且 reduced-motion 下无动画。
7. 安全测试确认客户端不能注入实时帧、未订阅任务不会接收帧、敏感字段不进入实时显示；拥塞不会阻塞 durable 事件或 Run 收尾。
