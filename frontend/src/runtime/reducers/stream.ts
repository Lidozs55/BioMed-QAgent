import type {
  AssistantDeltaPayload,
  AssistantStreamFrame,
  EventEnvelope,
  EventPayload,
} from "../contracts";
import type {
  AgentRuntimeData,
  AssistantStreamProjection,
  ProjectedMessage,
  StageProjection,
  TaskProjection,
} from "../types";
import { upsertActivity, upsertItem, upsertMessage } from "./shared";

function isRunAssistantStreamActive(
  task: TaskProjection,
  runId: string,
): boolean {
  const stream = task.assistantStreamsByRunId[runId];
  if (stream === undefined) return false;
  return Object.values(stream.streamsById).some((segment) => segment.active);
}

export function deactivateRunStreamingItems(
  task: TaskProjection,
  runId: string,
): TaskProjection {
  let changed = false;
  const items = task.items.map((item) => {
    if (item.runId !== runId) return item;
    if (item.kind === "reasoning" && item.isStreaming) {
      changed = true;
      return { ...item, isStreaming: false };
    }
    if (item.kind === "assistant_segment" && item.isStreaming) {
      changed = true;
      return { ...item, isStreaming: false };
    }
    return item;
  });
  if (!changed) return task;
  return { ...task, items };
}

/**
 * Detect and strip a trailing tool-arguments JSON object from assistant text.
 *
 * Qwen LLM 在 function_call 前会把参数 JSON 作为 text_delta 输出，导致 JSON
 * 被渲染为 assistant_segment 内容。此函数检测并剥离尾部的 JSON 对象。
 *
 * Returns:
 * - 剥离后的内容（可能为空字符串）若尾部检测到匹配的工具参数 JSON。
 * - null 表示无需剥离（未检测到尾部 JSON 或键不匹配）。
 */
function stripTrailingToolArgsJson(
  content: string,
  toolArguments: Record<string, unknown> | null,
): string | null {
  const trimmed = content.trimEnd();
  if (!trimmed.endsWith("}")) return null;

  // 从末尾向前扫描，找到匹配 '{' 的位置（处理嵌套大括号）。
  let depth = 0;
  let jsonStart = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) {
        jsonStart = i;
        break;
      }
    }
  }
  if (jsonStart < 0) return null;

  const jsonText = trimmed.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const parsedObj = parsed as Record<string, unknown>;
  const parsedKeys = Object.keys(parsedObj);
  if (parsedKeys.length === 0) return null;

  // 若有工具参数，按键集合校验：parsed 的键必须是 toolArguments 键的子集，
  // 且至少有一个键匹配（防止空交集的误判）。
  if (toolArguments !== null) {
    const toolKeys = Object.keys(toolArguments);
    if (toolKeys.length === 0) return null;
    const toolKeySet = new Set(toolKeys);
    let hasMatch = false;
    for (const key of parsedKeys) {
      if (!toolKeySet.has(key)) return null;
      hasMatch = true;
    }
    if (!hasMatch) return null;
  } else {
    // 无工具参数时，仅当所有值都是原始类型时才剥离（保守启发式）。
    for (const key of parsedKeys) {
      const value = parsedObj[key];
      if (typeof value === "object" && value !== null) return null;
    }
  }

  // 剥离尾部 JSON 及其前面的空白/换行。
  return trimmed.slice(0, jsonStart).trimEnd();
}

/**
 * 在 tool_started 时检查同一 runId 的最后一个 assistant_segment，
 * 剥离其尾部被 LLM 泄露的工具参数 JSON。若剥离后内容为空则移除该 item。
 */
function stripLastAssistantSegmentToolArgs(
  task: TaskProjection,
  runId: string,
  toolArguments: Record<string, unknown> | null,
): TaskProjection {
  // 从末尾向前查找最后一个属于该 runId 的 assistant_segment。
  let lastIndex = -1;
  for (let i = task.items.length - 1; i >= 0; i--) {
    const item = task.items[i];
    if (item.runId !== runId) continue;
    if (item.kind === "assistant_segment") {
      lastIndex = i;
      break;
    }
    // 遇到 tool_call 等非 assistant 项就停止向前查找，
    // 避免误剥离去往工具调用之后的 segment。
    if (item.kind === "tool_call" || item.kind === "user_message") break;
  }
  if (lastIndex < 0) return task;

  const segment = task.items[lastIndex];
  if (segment.kind !== "assistant_segment") return task;

  const stripped = stripTrailingToolArgsJson(segment.content, toolArguments);
  if (stripped === null) return task;

  const items = [...task.items];
  if (stripped.length === 0) {
    items.splice(lastIndex, 1);
  } else {
    items[lastIndex] = { ...segment, content: stripped };
  }
  return { ...task, items };
}

function assistantMessage(
  task: TaskProjection,
  runId: string,
): ProjectedMessage | undefined {
  return task.messages.find(
    (message) => message.runId === runId && message.role === "assistant",
  );
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const MAX_ASSISTANT_STREAM_CONFLICTS = 32;

function renderAssistantStream(stream: AssistantStreamProjection): string {
  const parts = [stream.durableText];
  for (const streamId of stream.liveStreamOrder) {
    const segment = stream.streamsById[streamId];
    if (segment === undefined) continue;
    let index = segment.confirmedThroughChunkIndex + 1;
    while (hasOwn(segment.pendingChunks, index)) {
      parts.push(segment.pendingChunks[index]);
      index += 1;
    }
  }
  return parts.join("");
}

function withAssistantStream(
  task: TaskProjection,
  runId: string,
  stream: AssistantStreamProjection,
  messageSequence: number | null,
  createdAt: string,
): TaskProjection {
  const projected = upsertMessage(task, {
    messageId: `live:${runId}:assistant`,
    taskId: task.summary.task_id,
    runId,
    ordinal: null,
    role: "assistant",
    content: renderAssistantStream(stream),
    createdAt,
    sequence: messageSequence,
  });
  return {
    ...projected,
    assistantStreamsByRunId: {
      ...projected.assistantStreamsByRunId,
      [runId]: stream,
    },
  };
}

function createAssistantStreamProjection(durableText: string): AssistantStreamProjection {
  return {
    durableText,
    liveStreamOrder: [],
    streamsById: {},
    conflicts: [],
  };
}

function addAssistantStreamConflict(
  stream: AssistantStreamProjection,
  taskId: string,
  runId: string,
  streamId: string,
  chunkIndex: number,
): void {
  const existing = stream.conflicts.find(
    (conflict) =>
      conflict.streamId === streamId && conflict.chunkIndex === chunkIndex,
  );
  if (existing !== undefined) {
    stream.conflicts = stream.conflicts.map((conflict) =>
      conflict === existing ? { ...conflict, count: conflict.count + 1 } : conflict,
    );
    return;
  }
  if (stream.conflicts.length >= MAX_ASSISTANT_STREAM_CONFLICTS) return;
  stream.conflicts = [
    ...stream.conflicts,
    { taskId, runId, streamId, chunkIndex, count: 1 },
  ];
}

export function reduceAssistantStreamFrames(
  state: AgentRuntimeData,
  frames: readonly AssistantStreamFrame[],
): AgentRuntimeData {
  const framesByTask = new Map<string, AssistantStreamFrame[]>();
  for (const frame of frames) {
    const taskFrames = framesByTask.get(frame.task_id) ?? [];
    taskFrames.push(frame);
    framesByTask.set(frame.task_id, taskFrames);
  }

  let tasksById = state.tasksById;
  for (const [taskId, taskFrames] of framesByTask) {
    const task = state.tasksById[taskId];
    if (task === undefined) continue;
    const streamsByRunId = { ...task.assistantStreamsByRunId };
    const mutableRuns = new Set<string>();
    const changedRuns = new Set<string>();

    const mutableRun = (runId: string): AssistantStreamProjection => {
      let stream = streamsByRunId[runId];
      if (stream === undefined) {
        stream = createAssistantStreamProjection(
          assistantMessage(task, runId)?.content ?? "",
        );
        streamsByRunId[runId] = stream;
        mutableRuns.add(runId);
      } else if (!mutableRuns.has(runId)) {
        stream = {
          ...stream,
          liveStreamOrder: [...stream.liveStreamOrder],
          streamsById: { ...stream.streamsById },
          conflicts: [...stream.conflicts],
        };
        streamsByRunId[runId] = stream;
        mutableRuns.add(runId);
      }
      return stream;
    };

    for (const frame of taskFrames) {
      const aggregate = mutableRun(frame.run_id);
      let segment = aggregate.streamsById[frame.stream_id];
      if (frame.type === "assistant_stream_end") {
        if (segment === undefined) {
          const anotherActive = Object.values(aggregate.streamsById).some(
            (candidate) => candidate.active,
          );
          if (anotherActive) continue;
          segment = {
            streamId: frame.stream_id,
            pendingChunks: {},
            confirmedThroughChunkIndex: -1,
            active: false,
            durableSeen: false,
            finishReason: frame.finish_reason,
          };
          aggregate.streamsById[frame.stream_id] = segment;
          aggregate.liveStreamOrder.push(frame.stream_id);
          changedRuns.add(frame.run_id);
        } else if (segment.active || segment.finishReason === null) {
          aggregate.streamsById[frame.stream_id] = {
            ...segment,
            active: false,
            finishReason: frame.finish_reason,
          };
          changedRuns.add(frame.run_id);
        }
        continue;
      }

      if (segment === undefined) {
        const anotherActive = Object.values(aggregate.streamsById).some(
          (candidate) => candidate.active,
        );
        if (anotherActive) continue;
        segment = {
          streamId: frame.stream_id,
          pendingChunks: {},
          confirmedThroughChunkIndex: -1,
          active: false,
          durableSeen: false,
          finishReason: null,
        };
        aggregate.streamsById[frame.stream_id] = segment;
        aggregate.liveStreamOrder.push(frame.stream_id);
      }
      if (frame.chunk_index <= segment.confirmedThroughChunkIndex) continue;
      if (hasOwn(segment.pendingChunks, frame.chunk_index)) {
        if (segment.pendingChunks[frame.chunk_index] !== frame.delta) {
          addAssistantStreamConflict(
            aggregate,
            taskId,
            frame.run_id,
            frame.stream_id,
            frame.chunk_index,
          );
          changedRuns.add(frame.run_id);
        }
        continue;
      }
      aggregate.streamsById[frame.stream_id] = {
        ...segment,
        pendingChunks: {
          ...segment.pendingChunks,
          [frame.chunk_index]: frame.delta,
        },
        active: true,
      };
      changedRuns.add(frame.run_id);
    }

    if (changedRuns.size === 0) continue;
    let messages = task.messages;
    for (const runId of changedRuns) {
      const aggregate = streamsByRunId[runId];
      const currentMessage = assistantMessage(task, runId);
      const message: ProjectedMessage = {
        messageId: `live:${runId}:assistant`,
        taskId,
        runId,
        ordinal: null,
        role: "assistant",
        content: renderAssistantStream(aggregate),
        createdAt: currentMessage?.createdAt ?? task.summary.updated_at,
        sequence: currentMessage?.sequence ?? null,
      };
      const index = messages.findIndex(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (messages === task.messages) messages = [...messages];
      if (index < 0) messages.push(message);
      else messages[index] = message;
    }
    if (tasksById === state.tasksById) tasksById = { ...tasksById };
    // Propagate finishReason from segments to existing assistant_segment items.
    // This lets ChatPanel show "正在调用工具" when finishReason === "tool_call_pending".
    let items = task.items;
    for (const runId of mutableRuns) {
      const aggregate = streamsByRunId[runId];
      if (aggregate === undefined) continue;
      for (const segment of Object.values(aggregate.streamsById)) {
        if (segment.finishReason === null) continue;
        const itemId = `assistant:${segment.streamId}`;
        const existing = items.find((i) => i.itemId === itemId);
        if (
          existing?.kind === "assistant_segment" &&
          existing.finishReason !== segment.finishReason
        ) {
          if (items === task.items) items = [...items];
          const itemIndex = items.indexOf(existing);
          items[itemIndex] = {
            ...existing,
            finishReason: segment.finishReason,
          };
        }
      }
    }
    tasksById[taskId] = {
      ...task,
      messages,
      items,
      assistantStreamsByRunId: streamsByRunId,
    };
  }
  return tasksById === state.tasksById ? state : { ...state, tasksById };
}

export function deactivateRunAssistantStream(
  task: TaskProjection,
  runId: string,
): TaskProjection {
  const stream = task.assistantStreamsByRunId[runId];
  if (
    stream === undefined ||
    !Object.values(stream.streamsById).some((segment) => segment.active)
  ) {
    return task;
  }
  const streamsById = Object.fromEntries(
    Object.entries(stream.streamsById).map(([streamId, segment]) => [
      streamId,
      segment.active ? { ...segment, active: false } : segment,
    ]),
  );
  return {
    ...task,
    assistantStreamsByRunId: {
      ...task.assistantStreamsByRunId,
      [runId]: { ...stream, streamsById },
    },
  };
}

export function deactivateAssistantStreams(
  state: AgentRuntimeData,
  taskId?: string,
): AgentRuntimeData {
  let tasksById = state.tasksById;
  for (const [candidateTaskId, task] of Object.entries(state.tasksById)) {
    if (taskId !== undefined && candidateTaskId !== taskId) continue;
    let changed = false;
    const streamsByRunId = Object.fromEntries(
      Object.entries(task.assistantStreamsByRunId).map(([runId, stream]) => {
        const streamsById = Object.fromEntries(
          Object.entries(stream.streamsById).map(([streamId, segment]) => {
            if (!segment.active && Object.keys(segment.pendingChunks).length === 0) {
              return [streamId, segment];
            }
            changed = true;
            return [streamId, { ...segment, pendingChunks: {}, active: false }];
          }),
        );
        return [runId, { ...stream, streamsById }];
      }),
    );
    if (!changed) continue;
    const messages = task.messages.flatMap((message) => {
      if (message.messageId !== `live:${message.runId}:assistant`) return [message];
      const stream =
        message.runId === null ? undefined : streamsByRunId[message.runId];
      if (stream === undefined) return [message];
      return stream.durableText.length === 0
        ? []
        : [{ ...message, content: stream.durableText }];
    });
    const nextTask = { ...task, messages, assistantStreamsByRunId: streamsByRunId };
    if (nextTask === task) continue;
    if (tasksById === state.tasksById) tasksById = { ...tasksById };
    tasksById[candidateTaskId] = nextTask;
  }
  return tasksById === state.tasksById ? state : { ...state, tasksById };
}

function hasAssistantChunkRange(
  payload: AssistantDeltaPayload,
): payload is Extract<AssistantDeltaPayload, { stream_id: string }> {
  return typeof payload.stream_id === "string";
}

function applyDurableAssistantDeltaCore(
  task: TaskProjection,
  runId: string,
  payload: AssistantDeltaPayload,
  envelope: EventEnvelope,
): TaskProjection {
  const currentMessage = assistantMessage(task, runId);
  if (!hasAssistantChunkRange(payload)) {
    const stream = task.assistantStreamsByRunId[runId];
    const durableText = `${stream?.durableText ?? currentMessage?.content ?? ""}${payload.delta}`;
    const nextTask = upsertMessage(task, {
      messageId: `live:${runId}:assistant`,
      taskId: envelope.task_id,
      runId,
      ordinal: null,
      role: "assistant",
      content: durableText,
      createdAt: currentMessage?.createdAt ?? envelope.timestamp,
      sequence: envelope.sequence,
    });
    if (stream === undefined) return nextTask;
    return {
      ...nextTask,
      assistantStreamsByRunId: {
        ...nextTask.assistantStreamsByRunId,
        [runId]: createAssistantStreamProjection(durableText),
      },
    };
  }

  const currentStream =
    task.assistantStreamsByRunId[runId] ??
    createAssistantStreamProjection(currentMessage?.content ?? "");
  const existingSegment = currentStream.streamsById[payload.stream_id];
  if (
    existingSegment !== undefined &&
    payload.through_chunk_index <= existingSegment.confirmedThroughChunkIndex
  ) {
    return task;
  }
  let streamsById = currentStream.streamsById;
  let liveStreamOrder = currentStream.liveStreamOrder;
  if (existingSegment === undefined) {
    streamsById = Object.fromEntries(
      Object.entries(streamsById).filter(([, segment]) => segment.durableSeen),
    );
    liveStreamOrder = liveStreamOrder.filter(
      (streamId) => streamsById[streamId] !== undefined,
    );
  }
  const segment = streamsById[payload.stream_id] ?? {
    streamId: payload.stream_id,
    pendingChunks: {},
    confirmedThroughChunkIndex: -1,
    active: false,
    durableSeen: false,
    finishReason: null,
  };
  const pendingChunks = Object.fromEntries(
    Object.entries(segment.pendingChunks).filter(
      ([index]) => Number(index) > payload.through_chunk_index,
    ),
  );
  const nextStream: AssistantStreamProjection = {
    ...currentStream,
    durableText: `${currentStream.durableText}${payload.delta}`,
    liveStreamOrder: liveStreamOrder.includes(payload.stream_id)
      ? liveStreamOrder
      : [...liveStreamOrder, payload.stream_id],
    streamsById: {
      ...streamsById,
      [payload.stream_id]: {
        ...segment,
        pendingChunks,
        confirmedThroughChunkIndex: payload.through_chunk_index,
        durableSeen: true,
      },
    },
  };
  return withAssistantStream(
    task,
    runId,
    nextStream,
    envelope.sequence,
    currentMessage?.createdAt ?? envelope.timestamp,
  );
}

function applyDurableAssistantDelta(
  task: TaskProjection,
  runId: string,
  payload: AssistantDeltaPayload,
  envelope: EventEnvelope,
): TaskProjection {
  const reconciledTask = withoutHydratedAssistantItems(task, runId);
  const nextTask = applyDurableAssistantDeltaCore(
    reconciledTask,
    runId,
    payload,
    envelope,
  );
  if (nextTask === reconciledTask) return reconciledTask;
  const streamId = hasAssistantChunkRange(payload)
    ? payload.stream_id
    : `live:${runId}:0`;
  const itemId = `assistant:${streamId}`;
  const existing = nextTask.items.find((i) => i.itemId === itemId);
  const prevContent =
    existing?.kind === "assistant_segment" ? existing.content : "";
  const isStreaming = isRunAssistantStreamActive(nextTask, runId);
  // Preserve finishReason from the live segment (set by assistant_stream_end
  // frame) or from the existing item. This prevents durable deltas from
  // overwriting finishReason="tool_call_pending" with null.
  const segment = nextTask.assistantStreamsByRunId[runId]?.streamsById[streamId];
  const finishReason =
    segment?.finishReason ??
    (existing?.kind === "assistant_segment" ? existing.finishReason : null) ??
    null;
  return upsertItem(nextTask, {
    kind: "assistant_segment",
    itemId,
    runId,
    sequence: envelope.sequence,
    createdAt: existing?.createdAt ?? envelope.timestamp,
    streamId,
    content: `${prevContent}${payload.delta}`,
    isStreaming,
    finishReason,
  });
}

function withoutHydratedAssistantItems(
  task: TaskProjection,
  runId: string,
): TaskProjection {
  const items = task.items.filter(
    (item) =>
      !(
        item.kind === "assistant_segment" &&
        item.runId === runId &&
        item.streamId.startsWith("hydrate:")
      ),
  );
  return items.length === task.items.length ? task : { ...task, items };
}

export function applyAssistantEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "assistant_delta" }
    | { type: "assistant_reasoning_delta" }
  >,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  if (payload.type === "assistant_delta") {
    return applyDurableAssistantDelta(task, runId, payload, envelope);
  }
  const activityId = envelope.subagent_id == null
    ? `reasoning:${runId}`
    : `subagent_reasoning:${envelope.subagent_id}:${runId}`;
  const existing = task.activitiesById[activityId];
  let next = upsertActivity(task, {
    activityId,
    taskId: envelope.task_id,
    runId,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    kind: "reasoning",
    subagentId: envelope.subagent_id ?? null,
    status: "started",
    name: null,
    input: null,
    output: `${existing?.output ?? ""}${payload.delta}`,
    isError: false,
    code: null,
    message: null,
  });
  if (envelope.subagent_id != null) return next;
  const segmentIndex = next.currentReasoningSegmentByRun[runId] ?? 0;
  if (!(runId in next.currentReasoningSegmentByRun)) {
    next = {
      ...next,
      currentReasoningSegmentByRun: {
        ...next.currentReasoningSegmentByRun,
        [runId]: segmentIndex,
      },
    };
  }
  const reasoningItemId = `reasoning:${runId}:${segmentIndex}`;
  const existingReasoningItem = next.items.find(
    (i) => i.itemId === reasoningItemId,
  );
  const prevReasoningContent =
    existingReasoningItem?.kind === "reasoning"
      ? existingReasoningItem.content
      : "";
  return upsertItem(next, {
    kind: "reasoning",
    itemId: reasoningItemId,
    runId,
    sequence: envelope.sequence,
    createdAt: existingReasoningItem?.createdAt ?? envelope.timestamp,
    content: `${prevReasoningContent}${payload.delta}`,
    isStreaming: true,
  });
}

export function applyToolStartedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "tool_started" }>,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  const toolArgs = (payload.arguments ?? null) as Record<
    string,
    unknown
  > | null;
  let next = task;
  if (envelope.subagent_id == null) {
    next = deactivateRunAssistantStream(next, runId);
    next = deactivateRunStreamingItems(next, runId);
    // Qwen LLM 在 function_call 前会把参数 JSON 作为 text_delta 输出，
    // 导致前一个 assistant_segment 尾部出现工具参数 JSON。此处剥离该 JSON，
    // 避免前端对话流展示原始 JSON。详见 docs/REVIEW_2026-07-20-llm-output-hygiene.md。
    next = stripLastAssistantSegmentToolArgs(next, runId, toolArgs);
  }
  next = upsertActivity(next, {
    activityId: envelope.subagent_id === null || envelope.subagent_id === undefined
      ? `tool:${runId}:${payload.tool_call_id}`
      : `subagent_tool:${envelope.subagent_id}:${runId}:${payload.tool_call_id}`,
    taskId: envelope.task_id,
    runId,
    subagentId: envelope.subagent_id ?? null,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    kind: "tool",
    status: "started",
    name: payload.tool_name,
    input: null,
    output: null,
    isError: false,
    code: null,
    message: null,
  });
  if (envelope.subagent_id == null) {
    const toolItemId = `tool:${runId}:${payload.tool_call_id}`;
    const existingToolItem = next.items.find(
      (i) => i.itemId === toolItemId,
    );
    next = upsertItem(next, {
      kind: "tool_call",
      itemId: toolItemId,
      runId,
      sequence: envelope.sequence,
      createdAt: existingToolItem?.createdAt ?? envelope.timestamp,
      toolCallId: payload.tool_call_id,
      toolName: payload.tool_name,
      arguments: toolArgs,
      status: "running",
      output: null,
      completedSequence: null,
    });
    next = {
      ...next,
      currentReasoningSegmentByRun: {
        ...next.currentReasoningSegmentByRun,
        [runId]: (next.currentReasoningSegmentByRun[runId] ?? 0) + 1,
      },
    };
  }
  return next;
}

export function applyToolCompletedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "tool_completed" }>,
): TaskProjection {
  const toolCallId = payload.tool_call_id ?? null;
  const runId = envelope.run_id;
  if (runId !== null && toolCallId !== null) {
    const activityId = envelope.subagent_id === null || envelope.subagent_id === undefined
      ? `tool:${runId}:${toolCallId}`
      : `subagent_tool:${envelope.subagent_id}:${runId}:${toolCallId}`;
    const existing = task.activitiesById[activityId];
    let next = upsertActivity(task, {
      activityId,
      taskId: envelope.task_id,
      runId,
      subagentId: envelope.subagent_id ?? null,
      sequence: envelope.sequence,
      timestamp: envelope.timestamp,
      kind: "tool",
      status: "completed",
      name: payload.tool_name,
      input: existing?.input ?? null,
      output: payload.output ?? null,
      isError: payload.is_error,
      code: null,
      message: null,
    });
    if (envelope.subagent_id == null) {
      const toolItemId = `tool:${runId}:${toolCallId}`;
      const existingToolItem = next.items.find(
        (i) => i.itemId === toolItemId,
      );
      const toolArguments =
        existingToolItem?.kind === "tool_call"
          ? existingToolItem.arguments
          : null;
      next = upsertItem(next, {
        kind: "tool_call",
        itemId: toolItemId,
        runId,
        sequence: envelope.sequence,
        createdAt: existingToolItem?.createdAt ?? envelope.timestamp,
        toolCallId,
        toolName: payload.tool_name,
        arguments: toolArguments,
        status: payload.is_error ? "error" : "completed",
        output: payload.output ?? null,
        completedSequence: envelope.sequence,
      });
    }
    return next;
  }
  return upsertActivity(task, {
    activityId: `event:${envelope.sequence}`,
    taskId: envelope.task_id,
    runId,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    kind: "fixture_event",
    status: "completed",
    name: payload.tool_name,
    input: null,
    output: payload.output_digest ?? null,
    isError: payload.is_error,
    code: null,
    message: null,
  });
}

export function applyToolCalledEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "tool_called" }>,
): TaskProjection {
  return upsertActivity(task, {
    activityId: `event:${envelope.sequence}`,
    taskId: envelope.task_id,
    runId: envelope.run_id,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    kind: "fixture_event",
    status: "started",
    name: payload.tool_name,
    input: payload.arguments_digest,
    output: null,
    isError: false,
    code: null,
    message: null,
  });
}

export function applyStageProgressEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "stage_progress" }>,
): TaskProjection {
  // Agent 模式下 Skills 发射 progress（无 stage_attempt_id），
  // Pipeline 模式下 stages 发射 progress（有 stage_attempt_id）。
  // 两种模式都投射到 task.stages，让前端展示"找到 N 篇论文"等中间数字。
  // See docs/REVIEW_2026-07-18.md §4.
  const existing = task.stages[payload.stage];
  const stageAttemptId =
    envelope.stage_attempt_id ?? existing?.stageAttemptId ?? `pending:${payload.stage}`;
  if (
    existing !== undefined &&
    existing.stageAttemptId !== stageAttemptId &&
    envelope.stage_attempt_id !== null
  ) {
    return task;
  }
  const progress = {
    kind: payload.kind,
    current: payload.current,
    total: payload.total,
    detail: payload.detail as Record<string, unknown>,
    updatedAt: envelope.timestamp,
  };
  // `existing ?? {...}` 的右分支中 existing 被 TS 收窄为 never,
  // 导致 existing?.attempt 等访问报 TS2339。改为显式 if/else。
  const stage: StageProjection = existing !== undefined
    ? existing
    : {
        stage: payload.stage,
        stageAttemptId,
        attempt: 1,
        status: "running",
        startedAt: envelope.timestamp,
        finishedAt: null,
        outputDigest: null,
        error: null,
        skipReason: null,
        reusedStageAttemptId: null,
        progress,
      };
  let next: TaskProjection = {
    ...task,
    stages: {
      ...task.stages,
      [payload.stage]: { ...stage, progress },
    },
  };
  const runId = envelope.run_id;
  if (runId !== null) {
    next = upsertActivity(next, {
      activityId: `progress:${runId}:${payload.stage}:${payload.kind}`,
      taskId: envelope.task_id,
      runId,
      sequence: envelope.sequence,
      timestamp: envelope.timestamp,
      kind: "progress",
      status: "recorded",
      name: null,
      input: null,
      output: null,
      isError: false,
      code: null,
      message: null,
      progress: {
        stage: payload.stage,
        kind: payload.kind,
        current: payload.current,
        total: payload.total,
      },
    });
    const progressItemId = `progress:${runId}:${payload.stage}:${payload.kind}`;
    const existingProgressItem = next.items.find(
      (i) => i.itemId === progressItemId,
    );
    next = upsertItem(next, {
      kind: "progress",
      itemId: progressItemId,
      runId,
      sequence: envelope.sequence,
      createdAt: existingProgressItem?.createdAt ?? envelope.timestamp,
      stage: payload.stage,
      progressKind: payload.kind,
      current: payload.current,
      total: payload.total,
    });
  }
  return next;
}
