import type {
  EventEnvelope,
  MessageRecord,
  RunRecord,
  RunStatus,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "./contracts";
import type {
  ActivityProjection,
  AgentRuntimeData,
  ArtifactProjection,
  FixtureStageProjection,
  ProjectedMessage,
  RunProjection,
  TaskProjection,
} from "./types";

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
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
    messages: [],
    olderMessagesCursor: null,
    activitiesById: {},
    activityOrder: [],
    artifactsById: {},
    artifactOrder: [],
    fixtureStages: {},
    lastSequence: summary.latest_sequence,
    hydration: "summary",
  };
}

function compareTaskIds(
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
  const activeItems = [...pageActive, ...preservedActive];

  const incomingHistory = page.items
    .map((item) => item.task_id)
    .filter((taskId) => !isActiveStatus(tasksById[taskId].summary.status));
  const history = append
    ? [...state.taskOrder, ...incomingHistory]
    : incomingHistory;
  const taskOrder = [...new Set(history)]
    .filter((taskId) => !activeItems.includes(taskId));

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
  const snapshotMessages = snapshot.messages.map(projectMessage);
  const messages =
    snapshotMessages.length === 0 && base.hydration === "accepted"
      ? base.messages
      : snapshotMessages;
  const task: TaskProjection = {
    ...base,
    summary: { ...snapshot.task, databases: [...snapshot.task.databases] },
    runsById: Object.fromEntries(runs.map((run) => [run.runId, run])),
    runOrder: runs.map((run) => run.runId),
    messages,
    olderMessagesCursor: snapshot.older_messages_cursor,
    lastSequence: snapshot.task.latest_sequence,
    hydration: "snapshot",
  };
  return {
    ...state,
    tasksById: { ...state.tasksById, [snapshot.task.task_id]: task },
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

function upsertActivity(
  task: TaskProjection,
  activity: ActivityProjection,
): TaskProjection {
  return {
    ...task,
    activitiesById: {
      ...task.activitiesById,
      [activity.activityId]: activity,
    },
    activityOrder: task.activityOrder.includes(activity.activityId)
      ? task.activityOrder
      : [...task.activityOrder, activity.activityId],
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
      task = {
        ...task,
        summary: {
          ...task.summary,
          status: "queued",
          active_run_id: runId,
        },
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
      break;
    }
    case "assistant_delta": {
      if (runId === null) break;
      const messageId = `live:${runId}:assistant`;
      const existing = task.messages.find(
        (message) => message.messageId === messageId,
      );
      task = upsertMessage(task, {
        messageId,
        taskId: envelope.task_id,
        runId,
        ordinal: null,
        role: "assistant",
        content: `${existing?.content ?? ""}${payload.delta}`,
        createdAt: existing?.createdAt ?? envelope.timestamp,
        sequence: envelope.sequence,
      });
      break;
    }
    case "tool_started": {
      if (runId === null) break;
      task = upsertActivity(task, {
        activityId: `tool:${runId}:${payload.tool_call_id}`,
        taskId: envelope.task_id,
        runId,
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
      break;
    }
    case "tool_completed": {
      const toolCallId = payload.tool_call_id ?? null;
      if (runId !== null && toolCallId !== null) {
        const activityId = `tool:${runId}:${toolCallId}`;
        const existing = task.activitiesById[activityId];
        task = upsertActivity(task, {
          activityId,
          taskId: envelope.task_id,
          runId,
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
      task = {
        ...task,
        artifactsById: {
          ...task.artifactsById,
          [artifact.artifact_id]: artifact,
        },
        artifactOrder: task.artifactOrder.includes(artifact.artifact_id)
          ? task.artifactOrder
          : [...task.artifactOrder, artifact.artifact_id],
      };
      break;
    }
    case "stage_started":
    case "stage_completed":
    case "stage_failed":
    case "stage_skipped": {
      if (envelope.stage_attempt_id === null) break;
      const existing = task.fixtureStages[payload.stage];
      if (
        payload.type !== "stage_started" &&
        existing !== undefined &&
        existing.stageAttemptId !== envelope.stage_attempt_id
      ) {
        break;
      }
      const status =
        payload.type === "stage_started" ? "running" : payload.status;
      const stage: FixtureStageProjection = {
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
      };
      task = {
        ...task,
        fixtureStages: { ...task.fixtureStages, [payload.stage]: stage },
      };
      break;
    }
    case "task_cancel_requested":
    case "task_cancelled":
    case "task_completed":
    case "task_failed": {
      if (task.summary.mode !== "fixture") break;
      const status: RunStatus =
        payload.type === "task_cancel_requested"
          ? "cancel_requested"
          : payload.type === "task_cancelled"
            ? "cancelled"
            : payload.type === "task_completed"
              ? "completed"
              : "failed";
      task = {
        ...task,
        summary: {
          ...task.summary,
          status,
          active_run_id: isActiveStatus(status)
            ? task.summary.active_run_id
            : null,
        },
      };
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
