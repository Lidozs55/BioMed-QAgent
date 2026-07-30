import type {
  AssistantDeltaPayload,
  AssistantStreamFrame,
  EventEnvelope,
  MessagePage,
  MessageRecord,
  RunRecord,
  RunStatus,
  StageName,
  SubagentRecord,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "./contracts";
import type {
  ActivityProjection,
  AssistantSegmentItem,
  AssistantStreamProjection,
  AgentRuntimeData,
  ArtifactProjection,
  ConversationItem,
  ProjectedMessage,
  RunProjection,
  StageProjection,
  SubagentProjection,
  TaskProjection,
} from "./types";

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
  "awaiting_user_input",
]);

export function isActiveStatus(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function createInitialRuntimeState(): AgentRuntimeData {
  return {
    tasksById: {},
    taskOrder: [],
    activeTaskId: null,
    activeItems: [],
    nextCursor: null,
    connectionStatus: "idle",
    historyStatus: "idle",
    historyError: null,
    draft: {
      input: "",
      selectedDatabaseIds: [],
      mode: "agent",
      error: null,
    },
    databases: [],
  };
}

export function createTaskProjection(summary: TaskSummary): TaskProjection {
  return {
    summary: { ...summary, databases: [...summary.databases] },
    runsById: {},
    runOrder: [],
    subagentsById: {},
    subagentOrder: [],
    messages: [],
    olderMessagesCursor: null,
    activitiesById: {},
    activityOrder: [],
    artifactsById: {},
    artifactOrder: [],
    artifactEventSequences: {},
    artifactManifestSequence: null,
    stages: {},
    assistantStreamsByRunId: {},
    pendingUserInput: null,
    lastSequence: summary.latest_sequence,
    hydration: "summary",
    items: [],
    itemSequences: {},
    currentReasoningSegmentByRun: {},
  };
}

export function compareTaskIds(
  tasksById: Record<string, TaskProjection>,
  left: string,
  right: string,
): number {
  const leftTask = tasksById[left].summary;
  const rightTask = tasksById[right].summary;
  const byCreatedAt = rightTask.created_at.localeCompare(leftTask.created_at);
  return byCreatedAt || rightTask.task_id.localeCompare(leftTask.task_id);
}

function mergeSummary(
  existing: TaskProjection | undefined,
  incoming: TaskSummary,
): TaskProjection {
  if (existing === undefined) {
    return createTaskProjection(incoming);
  }
  if (incoming.latest_sequence < existing.lastSequence) {
    return existing;
  }
  return {
    ...existing,
    summary: { ...incoming, databases: [...incoming.databases] },
  };
}

export function mergeTaskPage(
  state: AgentRuntimeData,
  page: TaskPage,
  append: boolean,
  preserveTaskIds?: ReadonlySet<string>,
): AgentRuntimeData {
  const tasksById = { ...state.tasksById };
  for (const item of [...page.active_items, ...page.items]) {
    tasksById[item.task_id] = mergeSummary(tasksById[item.task_id], item);
  }

  const pageActive = page.active_items
    .map((item) => item.task_id)
    .filter((taskId) => isActiveStatus(tasksById[taskId].summary.status));
  const preservedActive = state.activeItems.filter(
    (taskId) =>
      !pageActive.includes(taskId) &&
      tasksById[taskId] !== undefined &&
      isActiveStatus(tasksById[taskId].summary.status),
  );
  const activeItems = [...new Set([...pageActive, ...preservedActive])].sort(
    (left, right) => compareTaskIds(tasksById, left, right),
  );

  const incomingHistory = [...page.active_items, ...page.items]
    .map((item) => item.task_id)
    .filter((taskId) => !isActiveStatus(tasksById[taskId].summary.status));
  const preservedHistory = append
    ? []
    : state.taskOrder.filter((taskId) => preserveTaskIds?.has(taskId));
  const history = append
    ? [...state.taskOrder, ...incomingHistory]
    : [...preservedHistory, ...incomingHistory];
  const taskOrder = [...new Set(history)]
    .filter((taskId) => !activeItems.includes(taskId))
    .sort((left, right) => compareTaskIds(tasksById, left, right));

  return {
    ...state,
    tasksById,
    activeItems,
    taskOrder,
    nextCursor: page.next_cursor,
  };
}

function projectRun(record: RunRecord): RunProjection {
  return {
    runId: record.run_id,
    taskId: record.task_id,
    requestId: record.request_id,
    status: record.status,
    input: record.input,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    error: record.error,
  };
}

function projectSubagent(record: SubagentRecord): SubagentProjection {
  return {
    subagentId: record.subagent_id,
    taskId: record.task_id,
    runId: record.run_id,
    agentType: record.agent_type,
    objective: record.objective,
    targetSource: record.target_source,
    status: record.status,
    parentToolCallId: record.parent_tool_call_id,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    progressCurrent: record.progress_current,
    progressTotal: record.progress_total,
    progressMessage: record.progress_message,
    resultSummary: record.result_summary,
    warnings: [],
    sourceAssetIds: [...record.source_asset_ids],
    recipeId: record.recipe_id,
    errorCode: record.error_code,
    errorMessage: record.error_message,
    pendingRequestId: record.pending_request_id,
  };
}

function projectMessage(record: MessageRecord): ProjectedMessage {
  return {
    messageId: record.message_id,
    taskId: record.task_id,
    runId: record.run_id,
    ordinal: record.ordinal,
    role: record.role,
    content: record.content,
    createdAt: record.created_at,
    sequence: null,
  };
}

function messageSlot(message: ProjectedMessage): string | null {
  if (
    message.runId === null ||
    (message.role !== "user" && message.role !== "assistant")
  ) {
    return null;
  }
  return `${message.runId}:${message.role}`;
}

function sortProjectedMessages(
  messages: ProjectedMessage[],
): ProjectedMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftOrdinal = left.message.ordinal;
      const rightOrdinal = right.message.ordinal;
      if (leftOrdinal !== null && rightOrdinal !== null) {
        return leftOrdinal - rightOrdinal || left.index - right.index;
      }
      if (leftOrdinal !== null) return -1;
      if (rightOrdinal !== null) return 1;
      return left.index - right.index;
    })
    .map(({ message }) => message);
}

function mergeProjectedMessages(
  existing: ProjectedMessage[],
  incoming: ProjectedMessage[],
): ProjectedMessage[] {
  const incomingById = new Map(
    incoming.map((message) => [message.messageId, message]),
  );
  const durableIncomingSlots = new Set(
    [...incomingById.values()]
      .filter((message) => message.ordinal !== null)
      .map(messageSlot)
      .filter((slot): slot is string => slot !== null),
  );
  const seenExistingIds = new Set<string>();
  const retainedExisting = existing.filter((message) => {
    if (
      incomingById.has(message.messageId) ||
      seenExistingIds.has(message.messageId)
    ) {
      return false;
    }
    seenExistingIds.add(message.messageId);
    const slot = messageSlot(message);
    return !(
      message.ordinal === null &&
      slot !== null &&
      durableIncomingSlots.has(slot)
    );
  });
  return sortProjectedMessages([
    ...retainedExisting,
    ...incomingById.values(),
  ]);
}

function snapshotConnectsToExistingHistory(
  base: TaskProjection,
  snapshotMessages: ProjectedMessage[],
): boolean {
  const existingOrdinals = base.messages
    .map((message) => message.ordinal)
    .filter((ordinal): ordinal is number => ordinal !== null);
  const snapshotOrdinals = snapshotMessages
    .map((message) => message.ordinal)
    .filter((ordinal): ordinal is number => ordinal !== null);
  if (existingOrdinals.length === 0 || snapshotOrdinals.length === 0) {
    return false;
  }
  let existingMaximum = existingOrdinals[0];
  for (const ordinal of existingOrdinals.slice(1)) {
    existingMaximum = Math.max(existingMaximum, ordinal);
  }
  let snapshotMinimum = snapshotOrdinals[0];
  for (const ordinal of snapshotOrdinals.slice(1)) {
    snapshotMinimum = Math.min(snapshotMinimum, ordinal);
  }
  return snapshotMinimum <= existingMaximum + 1;
}

function mergeSnapshotMessages(
  base: TaskProjection,
  snapshotMessages: ProjectedMessage[],
): ProjectedMessage[] {
  return mergeProjectedMessages(base.messages, snapshotMessages);
}

export function mergeOlderMessagePage(
  state: AgentRuntimeData,
  taskId: string,
  requestedCursor: string,
  page: MessagePage,
): AgentRuntimeData {
  const task = state.tasksById[taskId];
  if (
    task === undefined ||
    task.olderMessagesCursor !== requestedCursor
  ) {
    return state;
  }
  const incoming = page.messages
    .filter((message) => message.task_id === taskId)
    .map(projectMessage);
  const mergedTask: TaskProjection = {
    ...task,
    messages: mergeProjectedMessages(task.messages, incoming),
    olderMessagesCursor: page.next_cursor,
  };
  const taskWithItems = mergeMessagesIntoItems(mergedTask);
  return {
    ...state,
    tasksById: {
      ...state.tasksById,
      [taskId]: taskWithItems,
    },
  };
}

export function hydrateTaskSnapshot(
  state: AgentRuntimeData,
  snapshot: TaskSnapshot,
): AgentRuntimeData {
  const existing = state.tasksById[snapshot.task.task_id];
  if (
    existing !== undefined &&
    snapshot.task.latest_sequence < existing.lastSequence
  ) {
    return state;
  }
  const base = existing ?? createTaskProjection(snapshot.task);
  const runs = snapshot.runs.map(projectRun);
  const subagents = (snapshot.subagents ?? []).map(projectSubagent);
  const pendingRun =
    base.pendingUserInput === null
      ? undefined
      : runs.find((run) => run.runId === base.pendingUserInput?.runId);
  const snapshotMessages = snapshot.messages.map(projectMessage);
  const durableAssistantRunIds = new Set(
    snapshotMessages
      .filter(
        (message): message is ProjectedMessage & { runId: string } =>
          message.role === "assistant" &&
          message.ordinal !== null &&
          message.runId !== null,
      )
      .map((message) => message.runId),
  );
  const assistantStreamsByRunId = Object.fromEntries(
    Object.entries(base.assistantStreamsByRunId).filter(
      ([runId]) => !durableAssistantRunIds.has(runId),
    ),
  );
  const snapshotRunIds = new Set(runs.map((run) => run.runId));
  const runOrder = [
    ...runs.map((run) => run.runId),
    ...base.runOrder.filter((runId) => !snapshotRunIds.has(runId)),
  ];
  const runsById = {
    ...base.runsById,
    ...Object.fromEntries(runs.map((run) => [run.runId, run])),
  };
  const snapshotSubagentIds = new Set(
    subagents.map((subagent) => subagent.subagentId),
  );
  const subagentOrder = [
    ...subagents.map((subagent) => subagent.subagentId),
    ...base.subagentOrder.filter(
      (subagentId) => !snapshotSubagentIds.has(subagentId),
    ),
  ];
  const subagentsById = {
    ...base.subagentsById,
    ...Object.fromEntries(
      subagents.map((subagent) => [
        subagent.subagentId,
        {
          ...subagent,
          warnings:
            subagent.warnings.length > 0
              ? subagent.warnings
              : (base.subagentsById[subagent.subagentId]?.warnings ?? []),
        },
      ]),
    ),
  };
  const task: TaskProjection = mergeMessagesIntoItems({
    ...base,
    summary: { ...snapshot.task, databases: [...snapshot.task.databases] },
    runsById,
    runOrder,
    subagentsById,
    subagentOrder,
    messages: mergeSnapshotMessages(base, snapshotMessages),
    assistantStreamsByRunId,
    pendingUserInput:
      base.pendingUserInput !== null &&
      snapshot.task.active_run_id === base.pendingUserInput.runId &&
      pendingRun?.status === "awaiting_user_input"
        ? base.pendingUserInput
        : null,
    olderMessagesCursor:
      existing?.hydration === "snapshot" &&
      snapshotConnectsToExistingHistory(base, snapshotMessages)
        ? base.olderMessagesCursor
        : snapshot.older_messages_cursor,
    lastSequence: snapshot.task.latest_sequence,
    hydration: "snapshot",
  });
  const classification = updateClassification(state, task);
  return {
    ...state,
    tasksById: { ...state.tasksById, [snapshot.task.task_id]: task },
    ...classification,
  };
}

export function prepareTaskSnapshotReplay(
  state: AgentRuntimeData,
  snapshot: TaskSnapshot,
): AgentRuntimeData {
  const existing = state.tasksById[snapshot.task.task_id];
  if (existing === undefined || existing.hydration !== "summary") {
    return state;
  }
  const replayBase = {
    ...createTaskProjection(snapshot.task),
    lastSequence: 0,
  };
  const hydrated = hydrateTaskSnapshot(
    {
      ...state,
      tasksById: {
        ...state.tasksById,
        [snapshot.task.task_id]: replayBase,
      },
    },
    snapshot,
  );
  return {
    ...hydrated,
    tasksById: {
      ...hydrated.tasksById,
      [snapshot.task.task_id]: {
        ...hydrated.tasksById[snapshot.task.task_id],
        lastSequence: 0,
        hydration: "summary",
      },
    },
  };
}

function placeholderRun(
  taskId: string,
  runId: string,
  status: RunStatus,
  timestamp: string,
): RunProjection {
  return {
    runId,
    taskId,
    requestId: null,
    status,
    input: null,
    createdAt: null,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

function terminalizeRunningFixtureStages(
  task: TaskProjection,
  status: "failed" | "cancelled",
  timestamp: string,
  error: string | null,
): TaskProjection {
  if (task.summary.mode !== "fixture") return task;
  const stages = { ...task.stages };
  let changed = false;
  for (const stage of Object.keys(stages) as StageName[]) {
    const projection = stages[stage];
    if (projection?.status !== "running") continue;
    stages[stage] = {
      ...projection,
      status,
      finishedAt: timestamp,
      error,
    };
    changed = true;
  }
  return changed ? { ...task, stages } : task;
}

function upsertRun(
  task: TaskProjection,
  runId: string,
  updater: (run: RunProjection) => RunProjection,
  status: RunStatus,
  timestamp: string,
): TaskProjection {
  const existing =
    task.runsById[runId] ?? placeholderRun(task.summary.task_id, runId, status, timestamp);
  return {
    ...task,
    runsById: { ...task.runsById, [runId]: updater(existing) },
    runOrder: task.runOrder.includes(runId)
      ? task.runOrder
      : [...task.runOrder, runId],
  };
}

function upsertSubagent(
  task: TaskProjection,
  subagentId: string,
  updater: (subagent: SubagentProjection) => SubagentProjection,
): TaskProjection {
  const existing = task.subagentsById[subagentId];
  if (existing === undefined) return task;
  return {
    ...task,
    subagentsById: {
      ...task.subagentsById,
      [subagentId]: updater(existing),
    },
  };
}

function addQueuedSubagent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventEnvelope["payload"], { type: "subagent_queued" }>,
): TaskProjection {
  const runId = envelope.run_id;
  const parentToolCallId = envelope.parent_tool_call_id;
  if (runId === null || parentToolCallId == null) return task;
  const existing = task.subagentsById[payload.subagent_id];
  const subagent: SubagentProjection = {
    subagentId: payload.subagent_id,
    taskId: envelope.task_id,
    runId,
    agentType: payload.request.agent_type,
    objective: payload.request.objective,
    targetSource: payload.request.target_source,
    status: "queued",
    parentToolCallId,
    createdAt: existing?.createdAt ?? envelope.timestamp,
    startedAt: existing?.startedAt ?? null,
    finishedAt: existing?.finishedAt ?? null,
    progressCurrent: existing?.progressCurrent ?? 0,
    progressTotal: existing?.progressTotal ?? null,
    progressMessage: existing?.progressMessage ?? null,
    resultSummary: existing?.resultSummary ?? null,
    warnings: existing?.warnings ?? [],
    sourceAssetIds: existing?.sourceAssetIds ?? [],
    recipeId: existing?.recipeId ?? null,
    errorCode: existing?.errorCode ?? null,
    errorMessage: existing?.errorMessage ?? null,
    pendingRequestId: existing?.pendingRequestId ?? null,
  };
  return {
    ...task,
    subagentsById: { ...task.subagentsById, [subagent.subagentId]: subagent },
    subagentOrder: task.subagentOrder.includes(subagent.subagentId)
      ? task.subagentOrder
      : [...task.subagentOrder, subagent.subagentId],
  };
}

function upsertMessage(
  task: TaskProjection,
  message: ProjectedMessage,
): TaskProjection {
  const index = task.messages.findIndex(
    (candidate) => candidate.messageId === message.messageId,
  );
  if (index < 0) {
    return { ...task, messages: [...task.messages, message] };
  }
  const messages = [...task.messages];
  messages[index] = message;
  return { ...task, messages };
}

function upsertItem(
  task: TaskProjection,
  item: ConversationItem,
): TaskProjection {
  const existingIdx = task.items.findIndex((i) => i.itemId === item.itemId);
  let items: ConversationItem[];
  if (existingIdx >= 0) {
    const existing = task.items[existingIdx];
    const createdAt = existing.createdAt;
    items = [...task.items];
    items[existingIdx] = { ...existing, ...item, createdAt } as ConversationItem;
  } else {
    items = [...task.items, item];
  }
  items.sort((a, b) => a.sequence - b.sequence);
  return {
    ...task,
    items,
    itemSequences: {
      ...task.itemSequences,
      [item.itemId]: item.sequence,
    },
  };
}

function isRunAssistantStreamActive(
  task: TaskProjection,
  runId: string,
): boolean {
  const stream = task.assistantStreamsByRunId[runId];
  if (stream === undefined) return false;
  return Object.values(stream.streamsById).some((segment) => segment.active);
}

function deactivateRunStreamingItems(
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

function projectMessageToItem(
  message: ProjectedMessage,
): ConversationItem | null {
  const runId = message.runId ?? "";
  const sequence = message.sequence ?? message.ordinal ?? 0;
  if (message.role === "user") {
    return {
      kind: "user_message",
      itemId:
        message.runId === null
          ? `msg:${message.messageId}`
          : `user:${message.runId}`,
      runId,
      sequence,
      createdAt: message.createdAt,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    return {
      kind: "assistant_segment",
      itemId: `msg:${message.messageId}`,
      runId,
      sequence,
      createdAt: message.createdAt,
      streamId: `hydrate:${message.messageId}`,
      content: message.content,
      isStreaming: false,
      finishReason: null,
    };
  }
  return null;
}

function mergeMessagesIntoItems(
  task: TaskProjection,
): TaskProjection {
  const userRunIds = new Set(
    task.messages
      .filter(
        (message): message is ProjectedMessage & { runId: string } =>
          message.role === "user" && message.runId !== null,
      )
      .map((message) => message.runId),
  );
  const eventAssistantRunIds = new Set(
    task.items
      .filter(
        (item): item is AssistantSegmentItem =>
          item.kind === "assistant_segment" &&
          !item.streamId.startsWith("hydrate:"),
      )
      .map((item) => item.runId),
  );
  const items = task.items.filter((item) => {
    if (item.kind === "user_message" && userRunIds.has(item.runId)) {
      return false;
    }
    return !(
      item.kind === "assistant_segment" &&
      item.streamId.startsWith("hydrate:")
    );
  });
  let next = items.length === task.items.length ? task : { ...task, items };
  const projectedUserRunIds = new Set<string>();

  for (const message of task.messages) {
    if (message.role === "user" && message.runId !== null) {
      if (projectedUserRunIds.has(message.runId)) continue;
      projectedUserRunIds.add(message.runId);
    }
    if (
      message.role === "assistant" &&
      message.runId !== null &&
      eventAssistantRunIds.has(message.runId)
    ) {
      continue;
    }
    const item = projectMessageToItem(message);
    if (item === null) continue;
    next = upsertItem(next, item);
  }
  return next;
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

function deactivateRunAssistantStream(
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

function upsertActivity(
  task: TaskProjection,
  activity: Omit<ActivityProjection, "subagentId"> & {
    subagentId?: string | null;
  },
): TaskProjection {
  const projectedActivity: ActivityProjection = {
    ...activity,
    subagentId: activity.subagentId ?? null,
  };
  return {
    ...task,
    activitiesById: {
      ...task.activitiesById,
      [projectedActivity.activityId]: projectedActivity,
    },
    activityOrder: task.activityOrder.includes(projectedActivity.activityId)
      ? task.activityOrder
      : [...task.activityOrder, projectedActivity.activityId],
  };
}

function terminalStatus(type: EventEnvelope["type"]): RunStatus | null {
  switch (type) {
    case "run_completed":
      return "completed";
    case "run_failed":
      return "failed";
    case "run_cancelled":
      return "cancelled";
    case "run_interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function updateClassification(
  state: AgentRuntimeData,
  task: TaskProjection,
): Pick<AgentRuntimeData, "activeItems" | "taskOrder"> {
  const taskId = task.summary.task_id;
  if (isActiveStatus(task.summary.status)) {
    return {
      activeItems: state.activeItems.includes(taskId)
        ? state.activeItems
        : [...state.activeItems, taskId],
      taskOrder: state.taskOrder.filter((candidate) => candidate !== taskId),
    };
  }
  const tasksById = { ...state.tasksById, [taskId]: task };
  return {
    activeItems: state.activeItems.filter((candidate) => candidate !== taskId),
    taskOrder: [...new Set([...state.taskOrder, taskId])].sort((left, right) =>
      compareTaskIds(tasksById, left, right),
    ),
  };
}

export function reduceRuntimeEvent(
  state: AgentRuntimeData,
  envelope: EventEnvelope,
): AgentRuntimeData {
  const current = state.tasksById[envelope.task_id];
  if (current === undefined || envelope.sequence <= current.lastSequence) {
    return state;
  }

  const runId = envelope.run_id;
  const payload = envelope.payload;
  let task = current;

  switch (payload.type) {
    case "subagent_queued": {
      task = addQueuedSubagent(task, envelope, payload);
      break;
    }
    case "subagent_started": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        status: "running",
        startedAt: subagent.startedAt ?? envelope.timestamp,
      }));
      break;
    }
    case "subagent_progress": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        progressCurrent: payload.current,
        progressTotal: payload.total,
        progressMessage: payload.message,
      }));
      break;
    }
    case "subagent_completed":
    case "subagent_failed":
    case "subagent_cancelled":
    case "subagent_interrupted": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        status: payload.result.status,
        finishedAt: envelope.timestamp,
        resultSummary: payload.result.summary,
        warnings: [...payload.result.warnings],
        sourceAssetIds: [...payload.result.source_asset_ids],
        recipeId: payload.result.recipe_id,
        errorCode: payload.result.error_code,
        errorMessage: payload.result.error_message,
        pendingRequestId: null,
      }));
      break;
    }
    case "subagent_cancel_requested": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        status: "cancel_requested",
        errorMessage: payload.reason,
      }));
      break;
    }
    case "subagent_input_required": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        pendingRequestId: payload.request_id,
      }));
      break;
    }
    case "subagent_input_resumed": {
      task = upsertSubagent(task, payload.subagent_id, (subagent) =>
        subagent.pendingRequestId === payload.request_id
          ? { ...subagent, pendingRequestId: null }
          : subagent,
      );
      break;
    }
    case "run_queued": {
      if (runId === null) break;
      task = upsertRun(
        task,
        runId,
        (run) => ({
          ...run,
          requestId: payload.request_id,
          status: "queued",
          input: payload.input,
          createdAt: run.createdAt ?? envelope.timestamp,
          updatedAt: envelope.timestamp,
          finishedAt: null,
          error: null,
        }),
        "queued",
        envelope.timestamp,
      );
      task = upsertMessage(task, {
        messageId: `live:${runId}:user`,
        taskId: envelope.task_id,
        runId,
        ordinal: null,
        role: "user",
        content: payload.input,
        createdAt: envelope.timestamp,
        sequence: envelope.sequence,
      });
      // 同步投影到 items：用户输入后立即在对话区显示自己的消息，
      // 避免在 LLM 思考期（尚无 assistant_delta）items 为空导致
      // "该任务暂时没有消息" 与 "正在思考..." 同时出现。
      // itemId=`user:${runId}` 与 hydrate 的真实 user message 一致，
      // upsertItem 自动覆盖，不会重复。
      task = upsertItem(task, {
        kind: "user_message",
        itemId: `user:${runId}`,
        runId,
        sequence: envelope.sequence,
        createdAt: envelope.timestamp,
        content: payload.input,
      });
      task = {
        ...task,
        summary: {
          ...task.summary,
          status: "queued",
          active_run_id: runId,
        },
        pendingUserInput: null,
      };
      break;
    }
    case "run_started":
    case "run_finalizing":
    case "run_cancel_requested": {
      if (runId === null) break;
      const status: RunStatus =
        payload.type === "run_started"
          ? "running"
          : payload.type === "run_finalizing"
            ? "finalizing"
            : "cancel_requested";
      task = upsertRun(
        task,
        runId,
        (run) => ({
          ...run,
          status,
          updatedAt: envelope.timestamp,
          startedAt:
            payload.type === "run_started"
              ? (run.startedAt ?? envelope.timestamp)
              : run.startedAt,
        }),
        status,
        envelope.timestamp,
      );
      task = {
        ...task,
        summary: { ...task.summary, status, active_run_id: runId },
      };
      if (
        payload.type === "run_finalizing" ||
        payload.type === "run_cancel_requested"
      ) {
        task = deactivateRunAssistantStream(task, runId);
        task = deactivateRunStreamingItems(task, runId);
      }
      break;
    }
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
    case "run_interrupted": {
      if (runId === null) break;
      const status = terminalStatus(payload.type);
      if (status === null) break;
      const error =
        payload.type === "run_failed"
          ? payload.error
          : payload.type === "run_interrupted"
            ? payload.reason
            : payload.type === "run_cancelled"
              ? payload.reason
              : null;
      task = upsertRun(
        task,
        runId,
        (run) => ({
          ...run,
          status,
          updatedAt: envelope.timestamp,
          finishedAt: envelope.timestamp,
          error,
        }),
        status,
        envelope.timestamp,
      );
      if (task.summary.active_run_id === runId) {
        task = {
          ...task,
          summary: { ...task.summary, status, active_run_id: null },
        };
      }
      if (task.pendingUserInput?.runId === runId) {
        task = { ...task, pendingUserInput: null };
      }
      if (payload.type !== "run_completed") {
        task = terminalizeRunningFixtureStages(
          task,
          payload.type === "run_failed" ? "failed" : "cancelled",
          envelope.timestamp,
          error,
        );
      }
      task = deactivateRunAssistantStream(task, runId);
      task = deactivateRunStreamingItems(task, runId);
      break;
    }
    case "user_input_required": {
      if (runId === null) break;
      task = upsertRun(
        task,
        runId,
        (run) => ({
          ...run,
          status: "awaiting_user_input",
          updatedAt: envelope.timestamp,
        }),
        "awaiting_user_input",
        envelope.timestamp,
      );
      task = {
        ...task,
        summary: {
          ...task.summary,
          status: "awaiting_user_input",
          active_run_id: runId,
        },
        pendingUserInput: {
          runId,
          requestId: payload.request_id,
          promptKind: payload.prompt_kind,
          summary: payload.summary,
          expiresAt: payload.expires_at,
          fixtureExempt: payload.fixture_exempt,
          detail: payload.detail,
          sequence: envelope.sequence,
          timestamp: envelope.timestamp,
        },
      };
      break;
    }
    case "user_input_resumed": {
      if (runId === null) break;
      task = upsertRun(
        task,
        runId,
        (run) => ({
          ...run,
          status: "running",
          updatedAt: envelope.timestamp,
        }),
        "running",
        envelope.timestamp,
      );
      task = {
        ...task,
        summary: {
          ...task.summary,
          status: "running",
          active_run_id: runId,
        },
        pendingUserInput:
          task.pendingUserInput?.runId === runId &&
          task.pendingUserInput.requestId === payload.request_id
            ? null
            : task.pendingUserInput,
      };
      break;
    }
    case "plan_ready": {
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
        kind: "fixture_event",
        status: "completed",
        name: "plan_ready",
        input: null,
        output: JSON.stringify(payload.specification),
        isError: false,
        code: null,
        message: null,
      });
      break;
    }
    case "task_created":
    case "task_recovered": {
      if (task.summary.mode !== "fixture") break;
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
        kind: "fixture_event",
        status: "completed",
        name: payload.type,
        input: null,
        output:
          payload.type === "task_created" ? payload.topic : null,
        isError: false,
        code: null,
        message: null,
      });
      break;
    }
    case "assistant_delta": {
      if (runId === null) break;
      task = applyDurableAssistantDelta(task, runId, payload, envelope);
      break;
    }
    case "assistant_reasoning_delta": {
      if (runId === null) break;
      const activityId = envelope.subagent_id == null
        ? `reasoning:${runId}`
        : `subagent_reasoning:${envelope.subagent_id}:${runId}`;
      const existing = task.activitiesById[activityId];
      task = upsertActivity(task, {
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
      if (envelope.subagent_id != null) break;
      const segmentIndex = task.currentReasoningSegmentByRun[runId] ?? 0;
      if (!(runId in task.currentReasoningSegmentByRun)) {
        task = {
          ...task,
          currentReasoningSegmentByRun: {
            ...task.currentReasoningSegmentByRun,
            [runId]: segmentIndex,
          },
        };
      }
      const reasoningItemId = `reasoning:${runId}:${segmentIndex}`;
      const existingReasoningItem = task.items.find(
        (i) => i.itemId === reasoningItemId,
      );
      const prevReasoningContent =
        existingReasoningItem?.kind === "reasoning"
          ? existingReasoningItem.content
          : "";
      task = upsertItem(task, {
        kind: "reasoning",
        itemId: reasoningItemId,
        runId,
        sequence: envelope.sequence,
        createdAt: existingReasoningItem?.createdAt ?? envelope.timestamp,
        content: `${prevReasoningContent}${payload.delta}`,
        isStreaming: true,
      });
      break;
    }
    case "tool_started": {
      if (runId === null) break;
      const toolArgs = (payload.arguments ?? null) as Record<
        string,
        unknown
      > | null;
      if (envelope.subagent_id == null) {
        task = deactivateRunAssistantStream(task, runId);
        task = deactivateRunStreamingItems(task, runId);
        // Qwen LLM 在 function_call 前会把参数 JSON 作为 text_delta 输出，
        // 导致前一个 assistant_segment 尾部出现工具参数 JSON。此处剥离该 JSON，
        // 避免前端对话流展示原始 JSON。详见 docs/REVIEW_2026-07-20-llm-output-hygiene.md。
        task = stripLastAssistantSegmentToolArgs(task, runId, toolArgs);
      }
      task = upsertActivity(task, {
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
        const existingToolItem = task.items.find(
          (i) => i.itemId === toolItemId,
        );
        task = upsertItem(task, {
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
        task = {
          ...task,
          currentReasoningSegmentByRun: {
            ...task.currentReasoningSegmentByRun,
            [runId]: (task.currentReasoningSegmentByRun[runId] ?? 0) + 1,
          },
        };
      }
      break;
    }
    case "tool_completed": {
      const toolCallId = payload.tool_call_id ?? null;
      if (runId !== null && toolCallId !== null) {
        const activityId = envelope.subagent_id === null || envelope.subagent_id === undefined
          ? `tool:${runId}:${toolCallId}`
          : `subagent_tool:${envelope.subagent_id}:${runId}:${toolCallId}`;
        const existing = task.activitiesById[activityId];
        task = upsertActivity(task, {
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
          const existingToolItem = task.items.find(
            (i) => i.itemId === toolItemId,
          );
          const toolArguments =
            existingToolItem?.kind === "tool_call"
              ? existingToolItem.arguments
              : null;
          task = upsertItem(task, {
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
      } else {
        task = upsertActivity(task, {
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
      break;
    }
    case "tool_called": {
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
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
      break;
    }
    case "warning": {
      const warning = payload.warning ?? null;
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
        kind: "warning",
        status: "warning",
        name: null,
        input: null,
        output: null,
        isError: warning?.severity === "error",
        code: payload.code ?? warning?.code ?? null,
        message: payload.message ?? warning?.message ?? null,
      });
      const warningItemId = `warning:${envelope.sequence}`;
      task = upsertItem(task, {
        kind: "warning",
        itemId: warningItemId,
        runId: runId ?? "",
        sequence: envelope.sequence,
        createdAt: envelope.timestamp,
        code: payload.code ?? warning?.code ?? "",
        message: payload.message ?? warning?.message ?? "",
      });
      break;
    }
    case "conversation_compacted": {
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
        kind: "conversation_compacted",
        status: "recorded",
        name: null,
        input: payload.covered_through_run_id,
        output: payload.summary_digest,
        isError: false,
        code: null,
        message: null,
      });
      task = { ...task, compacting: false };
      break;
    }
    case "artifact_produced": {
      const artifact: ArtifactProjection = {
        artifact_id: payload.artifact.artifact_id,
        name: payload.artifact.name,
        size: payload.artifact.size_bytes,
        sha256: payload.artifact.sha256,
        media_type: payload.artifact.media_type,
        taskId: envelope.task_id,
        generatedByStepId: payload.artifact.generated_by_step_id,
      };
      const startsManifestGeneration = artifact.artifact_id === "run_manifest";
      const artifactsById = startsManifestGeneration
        ? { [artifact.artifact_id]: artifact }
        : { ...task.artifactsById, [artifact.artifact_id]: artifact };
      const artifactOrder = startsManifestGeneration
        ? [artifact.artifact_id]
        : task.artifactOrder.includes(artifact.artifact_id)
          ? task.artifactOrder
          : [...task.artifactOrder, artifact.artifact_id];
      task = {
        ...task,
        artifactsById,
        artifactOrder,
        artifactEventSequences: startsManifestGeneration
          ? { [artifact.artifact_id]: envelope.sequence }
          : {
              ...task.artifactEventSequences,
              [artifact.artifact_id]: envelope.sequence,
            },
        artifactManifestSequence: startsManifestGeneration
          ? envelope.sequence
          : task.artifactManifestSequence,
      };
      const artifactItemId = `artifact:${runId ?? "task"}:${artifact.artifact_id}`;
      const existingArtifactItem = task.items.find(
        (i) => i.itemId === artifactItemId,
      );
      task = upsertItem(task, {
        kind: "artifact",
        itemId: artifactItemId,
        runId: runId ?? "",
        sequence: envelope.sequence,
        createdAt: existingArtifactItem?.createdAt ?? envelope.timestamp,
        artifactId: artifact.artifact_id,
        name: artifact.name,
        sizeBytes: artifact.size,
        mediaType: artifact.media_type,
      });
      break;
    }
    case "stage_started":
    case "stage_completed":
    case "stage_failed":
    case "stage_skipped": {
      if (envelope.stage_attempt_id === null) break;
      const existing = task.stages[payload.stage];
      if (
        payload.type !== "stage_started" &&
        existing !== undefined &&
        existing.stageAttemptId !== envelope.stage_attempt_id
      ) {
        break;
      }
      const status =
        payload.type === "stage_started" ? "running" : payload.status;
      const stage: StageProjection = {
        stage: payload.stage,
        stageAttemptId: envelope.stage_attempt_id,
        attempt:
          payload.type === "stage_started" ? payload.attempt : existing?.attempt ?? 1,
        status,
        startedAt:
          payload.type === "stage_started"
            ? envelope.timestamp
            : existing?.startedAt ?? null,
        finishedAt:
          payload.type === "stage_started" ? null : envelope.timestamp,
        outputDigest:
          payload.type === "stage_completed" ? payload.output_digest : null,
        error: payload.type === "stage_failed" ? payload.error.message : null,
        skipReason: payload.type === "stage_skipped" ? payload.reason : null,
        reusedStageAttemptId:
          payload.type === "stage_skipped"
            ? payload.reused_stage_attempt_id
            : null,
        progress: existing?.progress ?? null,
      };
      task = {
        ...task,
        stages: { ...task.stages, [payload.stage]: stage },
      };
      if (runId !== null) {
        task = upsertActivity(task, {
          activityId: `stage:${runId}:${payload.stage}`,
          taskId: envelope.task_id,
          runId,
          sequence: envelope.sequence,
          timestamp: envelope.timestamp,
          kind: "stage",
          status:
            payload.type === "stage_started"
              ? "started"
              : payload.type === "stage_completed"
                ? "completed"
                : payload.type === "stage_failed"
                  ? "failed"
                  : "skipped",
          name: null,
          input: null,
          output: null,
          isError: payload.type === "stage_failed",
          code: null,
          message: null,
          stage: payload.stage,
        });
        const stageItemId = `stage:${runId}:${payload.stage}`;
        const existingStageItem = task.items.find(
          (i) => i.itemId === stageItemId,
        );
        task = upsertItem(task, {
          kind: "stage",
          itemId: stageItemId,
          runId,
          sequence: envelope.sequence,
          createdAt: existingStageItem?.createdAt ?? envelope.timestamp,
          stage: payload.stage,
          status:
            payload.type === "stage_started"
              ? "running"
              : payload.type === "stage_completed"
                ? "completed"
                : payload.type === "stage_failed"
                  ? "failed"
                  : "skipped",
          attempt: stage.attempt,
          error:
            payload.type === "stage_failed" ? payload.error.message : null,
        });
      }
      break;
    }
    case "stage_progress": {
      // Agent 模式�?Skills 发射 progress（无 stage_attempt_id），
      // Pipeline 模式�?stages 发射 progress（有 stage_attempt_id）�?
      // 两种模式都投射到 task.stages，让前端展示"找到 N 篇论�?等中间数字�?
      // See docs/REVIEW_2026-07-18.md §4.
      const existing = task.stages[payload.stage];
      const stageAttemptId =
        envelope.stage_attempt_id ?? existing?.stageAttemptId ?? `pending:${payload.stage}`;
      if (
        existing !== undefined &&
        existing.stageAttemptId !== stageAttemptId &&
        envelope.stage_attempt_id !== null
      ) {
        break;
      }
      const progress = {
        kind: payload.kind,
        current: payload.current,
        total: payload.total,
        detail: payload.detail as Record<string, unknown>,
        updatedAt: envelope.timestamp,
      };
      // `existing ?? {...}` 的右分支�?existing �?TS 收窄�?never,
      // 导致 existing?.attempt 等访问报 TS2339。改为显�?if/else�?
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
      task = {
        ...task,
        stages: {
          ...task.stages,
          [payload.stage]: { ...stage, progress },
        },
      };
      if (runId !== null) {
        task = upsertActivity(task, {
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
        const existingProgressItem = task.items.find(
          (i) => i.itemId === progressItemId,
        );
        task = upsertItem(task, {
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
      break;
    }
    case "task_cancel_requested":
    case "task_cancelled":
    case "task_completed":
    case "task_failed": {
      if (task.summary.mode !== "fixture") break;
      const output =
        payload.type === "task_completed"
          ? payload.validation.status
          : payload.type === "task_failed"
            ? payload.error.message
            : payload.reason;
      task = upsertActivity(task, {
        activityId: `event:${envelope.sequence}`,
        taskId: envelope.task_id,
        runId,
        sequence: envelope.sequence,
        timestamp: envelope.timestamp,
        kind: "fixture_event",
        status:
          payload.type === "task_cancel_requested" ? "started" : "completed",
        name: payload.type,
        input: null,
        output,
        isError: payload.type === "task_failed",
        code: payload.type === "task_failed" ? payload.error.code : null,
        message: payload.type === "task_failed" ? payload.error.message : null,
      });
      break;
    }
    default:
      break;
  }

  task = {
    ...task,
    lastSequence: envelope.sequence,
    summary: {
      ...task.summary,
      updated_at: envelope.timestamp,
      latest_sequence: envelope.sequence,
    },
  };
  const classification = updateClassification(state, task);
  return {
    ...state,
    tasksById: { ...state.tasksById, [envelope.task_id]: task },
    ...classification,
  };
}
