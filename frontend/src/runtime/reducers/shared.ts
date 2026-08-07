import type {
  MessagePage,
  MessageRecord,
  RunRecord,
  RunStatus,
  SubagentRecord,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "../contracts";
import type {
  ActivityProjection,
  AgentRuntimeData,
  AssistantSegmentItem,
  ConversationItem,
  ProjectedMessage,
  RunProjection,
  SubagentProjection,
  TaskProjection,
} from "../types";

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
    currentPublicationId: null,
    publications: [],
    sequenceGap: null,
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
    summary: record.summary ?? null,
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
  // Older message pages load messages from before the replayed event window;
  // they have no run_queued events to align with, so projection must fall
  // back to ordinals (which are strictly increasing across the full session).
  const taskWithItems = mergeMessagesIntoItems(mergedTask, {
    preserveUserSequences: false,
  });
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
    currentPublicationId:
      snapshot.current_publication_id === undefined
        ? base.currentPublicationId
        : snapshot.current_publication_id,
    publications:
      snapshot.publications === undefined
        ? base.publications
        : [...snapshot.publications],
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
    // A snapshot is authoritative: its latest_sequence covers any earlier
    // event-window gap, so the recoverable gap marker is healed.
    sequenceGap: null,
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

export function markTaskContiguous(
  state: AgentRuntimeData,
  taskId: string,
): AgentRuntimeData {
  const task = state.tasksById[taskId];
  if (task === undefined || task.sequenceGap === null) return state;
  return {
    ...state,
    tasksById: {
      ...state.tasksById,
      [taskId]: { ...task, sequenceGap: null },
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
    summary: null,
  };
}

export function upsertRun(
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

export function upsertSubagent(
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

export function upsertMessage(
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

export function upsertItem(
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

function projectMessageToItem(
  message: ProjectedMessage,
  userSequenceByRun?: ReadonlyMap<string, number>,
): ConversationItem | null {
  const runId = message.runId ?? "";
  // User messages are re-projected from snapshot.messages during hydration.
  // Prefer the run_queued event sequence (same clock as event-driven items)
  // so sorting stays chronological; fall back to message.sequence ?? ordinal
  // when the event was not replayed (e.g. truncated event page).
  const userEventSequence =
    message.role === "user" && runId !== ""
      ? userSequenceByRun?.get(runId)
      : undefined;
  const sequence =
    userEventSequence ??
    message.sequence ??
    message.ordinal ??
    0;
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
  options: { preserveUserSequences?: boolean } = {},
): TaskProjection {
  const preserveUserSequences = options.preserveUserSequences ?? true;
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
  const userSequenceByRun = new Map<string, number>();
  const items = task.items.filter((item) => {
    if (item.kind === "user_message" && userRunIds.has(item.runId)) {
      if (preserveUserSequences) {
        userSequenceByRun.set(item.runId, item.sequence);
      }
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
    const item = projectMessageToItem(
      message,
      preserveUserSequences ? userSequenceByRun : undefined,
    );
    if (item === null) continue;
    next = upsertItem(next, item);
  }
  return next;
}

export function upsertActivity(
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

export function updateClassification(
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
