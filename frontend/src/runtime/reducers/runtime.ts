import type {
  EventEnvelope,
  EventPayload,
  PublicationSummary,
  RunStatus,
  RunSummary,
  StageName,
} from "../contracts";
import type {
  SubagentProjection,
  TaskProjection,
} from "../types";
import {
  upsertActivity,
  upsertItem,
  upsertMessage,
  upsertRun,
  upsertSubagent,
} from "./shared";
import {
  deactivateRunAssistantStream,
  deactivateRunStreamingItems,
} from "./stream";

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

/**
 * Project a per-run outcome summary from a terminal event payload.
 * Mirrors backend ``app.runtime.state._run_summary_for``: partial projection
 * is legal, so legacy events missing ``build_result`` / ``error_code`` /
 * ``cancelled_at_stage`` still produce a summary.
 */
function summaryForTerminalPayload(
  payload: Extract<
    EventPayload,
    | { type: "run_completed" }
    | { type: "run_failed" }
    | { type: "run_cancelled" }
    | { type: "run_interrupted" }
  >,
  status: RunStatus,
): RunSummary {
  switch (payload.type) {
    case "run_completed":
      return {
        run_status: status,
        build_result: payload.build_result ?? null,
        error_code: null,
        cancelled_at_stage: null,
        user_message: payload.build_result?.user_summary ?? null,
      };
    case "run_failed":
      return {
        run_status: status,
        build_result: null,
        error_code: payload.error_code ?? null,
        cancelled_at_stage: null,
        user_message: payload.error,
      };
    case "run_cancelled":
      return {
        run_status: status,
        build_result: null,
        error_code: null,
        cancelled_at_stage: payload.cancelled_at_stage ?? null,
        user_message: payload.reason,
      };
    case "run_interrupted":
      return {
        run_status: status,
        build_result: null,
        error_code: null,
        cancelled_at_stage: null,
        user_message: payload.reason,
      };
  }
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

/**
 * Run-scoped safety net for operation items (V2 lifecycle, Design §15.1):
 * when the run reaches a terminal state, any operation still ``running`` is
 * finalized so the timeline never shows a spinner past the run end. This
 * covers progress-only operations (tool queries before the lifecycle fix,
 * ``tool:discovery:*`` aggregation) and error paths where a query started
 * but never reported completion.
 */
function terminalizeRunningOperations(
  task: TaskProjection,
  runId: string,
  status: "completed" | "failed" | "cancelled",
): TaskProjection {
  const items = task.items.map((item) =>
    item.kind === "operation" && item.runId === runId && item.status === "running"
      ? { ...item, status }
      : item,
  );
  const changed = items.some((item, index) => item !== task.items[index]);
  return changed ? { ...task, items } : task;
}

function addQueuedSubagent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "subagent_queued" }>,
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

export function applySubagentEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "subagent_queued" }>,
): TaskProjection {
  return addQueuedSubagent(task, envelope, payload);
}

export function applySubagentStatusEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "subagent_started" }
    | { type: "subagent_progress" }
    | { type: "subagent_completed" }
    | { type: "subagent_failed" }
    | { type: "subagent_cancelled" }
    | { type: "subagent_interrupted" }
    | { type: "subagent_input_required" }
    | { type: "subagent_input_resumed" }
    | { type: "subagent_cancel_requested" }
  >,
): TaskProjection {
  switch (payload.type) {
    case "subagent_started":
      return upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        status: "running",
        startedAt: subagent.startedAt ?? envelope.timestamp,
      }));
    case "subagent_progress":
      return upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        progressCurrent: payload.current,
        progressTotal: payload.total,
        progressMessage: payload.message,
      }));
    case "subagent_completed":
    case "subagent_failed":
    case "subagent_cancelled":
    case "subagent_interrupted":
      return upsertSubagent(task, payload.subagent_id, (subagent) => ({
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
    case "subagent_input_required":
      return upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        pendingRequestId: payload.request_id,
      }));
    case "subagent_input_resumed":
      return upsertSubagent(task, payload.subagent_id, (subagent) =>
        subagent.pendingRequestId === payload.request_id
          ? { ...subagent, pendingRequestId: null }
          : subagent,
      );
    case "subagent_cancel_requested":
      return upsertSubagent(task, payload.subagent_id, (subagent) => ({
        ...subagent,
        status: "cancel_requested",
        errorMessage: payload.reason,
      }));
  }
}

export function applyRunQueuedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "run_queued" }>,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  let next = upsertRun(
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
  next = upsertMessage(next, {
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
  next = upsertItem(next, {
    kind: "user_message",
    itemId: `user:${runId}`,
    runId,
    sequence: envelope.sequence,
    createdAt: envelope.timestamp,
    content: payload.input,
  });
  return {
    ...next,
    summary: {
      ...next.summary,
      status: "queued",
      active_run_id: runId,
    },
    pendingUserInput: null,
  };
}

export function applyRunTransitionEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "run_started" }
    | { type: "run_finalizing" }
    | { type: "run_cancel_requested" }
  >,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  const status: RunStatus =
    payload.type === "run_started"
      ? "running"
      : payload.type === "run_finalizing"
        ? "finalizing"
        : "cancel_requested";
  let next = upsertRun(
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
  next = {
    ...next,
    summary: { ...next.summary, status, active_run_id: runId },
  };
  if (payload.type === "run_cancel_requested") {
    // A cancelled run is no longer awaiting user input: clear its prompt so
    // the blocking dialog does not stay open (or race) while the
    // cancellation settles.
    if (next.pendingUserInput?.runId === runId) {
      next = { ...next, pendingUserInput: null };
    }
    if (next.pendingPermission?.runId === runId) {
      next = { ...next, pendingPermission: null };
    }
    next = deactivateRunAssistantStream(next, runId);
    next = deactivateRunStreamingItems(next, runId);
  }
  if (payload.type === "run_finalizing") {
    next = deactivateRunAssistantStream(next, runId);
    next = deactivateRunStreamingItems(next, runId);
  }
  return next;
}

export function applyRunTerminalEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "run_completed" }
    | { type: "run_failed" }
    | { type: "run_cancelled" }
    | { type: "run_interrupted" }
  >,
): TaskProjection {
  const runId = envelope.run_id;
  if (runId === null) return task;
  const status = terminalStatus(payload.type);
  if (status === null) return task;
  const error =
    payload.type === "run_failed"
      ? payload.error
      : payload.type === "run_interrupted"
        ? payload.reason
        : payload.type === "run_cancelled"
          ? payload.reason
          : null;
  let next = upsertRun(
    task,
    runId,
    (run) => ({
      ...run,
      status,
      updatedAt: envelope.timestamp,
      finishedAt: envelope.timestamp,
      error,
      summary: summaryForTerminalPayload(payload, status),
    }),
    status,
    envelope.timestamp,
  );
  if (next.summary.active_run_id === runId) {
    next = {
      ...next,
      summary: { ...next.summary, status, active_run_id: null },
    };
  }
  if (next.pendingUserInput?.runId === runId) {
    next = { ...next, pendingUserInput: null };
  }
  if (next.pendingPermission?.runId === runId) {
    next = { ...next, pendingPermission: null };
  }
  if (payload.type !== "run_completed") {
    next = terminalizeRunningFixtureStages(
      next,
      payload.type === "run_failed" ? "failed" : "cancelled",
      envelope.timestamp,
      error,
    );
  }
  // Operations without a terminal event of their own (tool query ops whose
  // completed/failed event was never emitted, aggregation ops like
  // ``tool:discovery:discovered_records`` that have no natural end signal)
  // must not linger "running" after the run ends.
  next = terminalizeRunningOperations(
    next,
    runId,
    payload.type === "run_completed"
      ? "completed"
      : payload.type === "run_failed"
        ? "failed"
        : "cancelled",
  );
  next = deactivateRunAssistantStream(next, runId);
  next = deactivateRunStreamingItems(next, runId);
  if (payload.type === "run_completed") {
    const buildId = payload.build_result?.build_id;
    if (buildId !== undefined && buildId !== null) {
      next = upsertItem(next, {
        kind: "build_report",
        itemId: `report:${runId}`,
        runId,
        sequence: envelope.sequence,
        createdAt: envelope.timestamp,
        taskId: envelope.task_id,
        buildId,
      });
    }
  }
  return next;

}
export function applyPublicationCreatedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "publication_created" }>,
): TaskProjection {
  // Mirror the backend reducer (raise, don't skip): publication events
  // require an envelope run_id and the payload run_id must match it. A
  // malformed event must not be silently consumed — skipping would advance
  // lastSequence and make it unreplayable on reconnect. A re-delivered
  // publication_id is a no-op so duplicate entries never accumulate.
  if (envelope.run_id === null) {
    throw new Error("publication events require run_id");
  }
  if (payload.run_id !== envelope.run_id) {
    throw new Error("payload run_id must match envelope run_id");
  }
  if (
    task.publications.some(
      (publication) => publication.publication_id === payload.publication_id,
    )
  ) {
    return task;
  }
  const previous = task.currentPublicationId;
  const publication: PublicationSummary = {
    publication_id: payload.publication_id,
    manifest_sha256: payload.manifest_sha256,
    supersedes_publication_id: payload.supersedes_publication_id ?? previous,
    published_at: payload.published_at,
  };
  return {
    ...task,
    currentPublicationId: payload.publication_id,
    publications: [...task.publications, publication],
  };
}

export function applyWarningEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "warning" }>,
): TaskProjection {
  const warning = payload.warning ?? null;
  const next = upsertActivity(task, {
    activityId: `event:${envelope.sequence}`,
    taskId: envelope.task_id,
    runId: envelope.run_id,
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
  return upsertItem(next, {
    kind: "warning",
    itemId: warningItemId,
    runId: envelope.run_id ?? "",
    sequence: envelope.sequence,
    createdAt: envelope.timestamp,
    code: payload.code ?? warning?.code ?? "",
    message: payload.message ?? warning?.message ?? "",
  });
}

export function applyConversationCompactedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "conversation_compacted" }>,
): TaskProjection {
  const next = upsertActivity(task, {
    activityId: `event:${envelope.sequence}`,
    taskId: envelope.task_id,
    runId: envelope.run_id,
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
  return {
    ...next,
    compacting: false,
    contextTokensUsed: undefined,
    contextTokensSource: undefined,
    contextCompactionSequence: envelope.sequence,
  };
}

export function applyContextUsageEvent(
  task: TaskProjection,
  payload: Extract<EventPayload, { type: "context_usage" }>,
): TaskProjection {
  return {
    ...task,
    contextWindow: payload.context_window,
    contextTokensUsed: payload.tokens ?? undefined,
    contextTokensSource: payload.tokens === null ? undefined : "runtime",
    compacting: false,
  };
}

export function applyFixtureEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "plan_ready" }
    | { type: "task_created" }
    | { type: "task_recovered" }
    | { type: "task_cancel_requested" }
    | { type: "task_cancelled" }
    | { type: "task_completed" }
    | { type: "task_failed" }
  >,
): TaskProjection {
  if (payload.type === "plan_ready") {
    return upsertActivity(task, {
      activityId: `event:${envelope.sequence}`,
      taskId: envelope.task_id,
      runId: envelope.run_id,
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
  }
  if (payload.type === "task_created" || payload.type === "task_recovered") {
    if (task.summary.mode !== "fixture") return task;
    return upsertActivity(task, {
      activityId: `event:${envelope.sequence}`,
      taskId: envelope.task_id,
      runId: envelope.run_id,
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
  }
  if (task.summary.mode !== "fixture") return task;
  const output =
    payload.type === "task_completed"
      ? payload.validation.status
      : payload.type === "task_failed"
        ? payload.error.message
        : payload.reason;
  return upsertActivity(task, {
    activityId: `event:${envelope.sequence}`,
    taskId: envelope.task_id,
    runId: envelope.run_id,
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
}
