/* ------------------------------------------------------------------ */
/*  Runtime response parsers for non-settings API endpoints            */
/*  Each parser field-level-checks its declared return type.           */
/* ------------------------------------------------------------------ */

import { APIError } from "@/hooks/settingsContracts";
import type {
  EventPage,
  MessagePage,
  SubagentErrorCode,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "@/runtime/contracts";
import { parseEventPayload } from "@/lib/eventParsers";
import {
  assertString, assertNumber, assertObject, assertArray, assertStringOrNull, assertOptionalNull, assertFinite, optSchemaVersion,
} from "@/lib/eventValidatorHelpers";

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ---- EventEnvelope invariant helpers ---- */

const STAGE_EVENT_TYPES = new Set(["stage_started", "stage_completed", "stage_failed", "stage_skipped"]);
const RUNTIME_EVENT_TYPES = new Set([
  "run_queued", "run_started", "run_finalizing", "run_completed", "run_failed",
  "run_cancel_requested", "run_cancelled", "run_interrupted",
  "assistant_delta", "assistant_reasoning_delta", "tool_started", "conversation_compacted",
  "subagent_queued", "subagent_started", "subagent_progress", "subagent_completed",
  "subagent_failed", "subagent_cancel_requested", "subagent_cancelled",
  "subagent_interrupted", "subagent_input_required", "subagent_input_resumed",
]);
const SUBAGENT_EVENT_TYPES = new Set([
  "subagent_queued", "subagent_started", "subagent_progress", "subagent_completed",
  "subagent_failed", "subagent_cancel_requested", "subagent_cancelled",
  "subagent_interrupted", "subagent_input_required", "subagent_input_resumed",
]);

/* ---- finite/discriminated value validators (explicit switch, no as cast) ---- */

export function assertRunStatus(v: unknown, path: string): "queued" | "running" | "finalizing" | "cancel_requested" | "awaiting_user_input" | "completed" | "failed" | "cancelled" | "interrupted" {
  if (typeof v !== "string") throw new APIError(502, `Expected RunStatus string at ${path}, got ${typeof v}`);
  switch (v) {
    case "queued": case "running": case "finalizing": case "cancel_requested": case "awaiting_user_input":
    case "completed": case "failed": case "cancelled": case "interrupted":
      return v;
    default:
      throw new APIError(502, `Invalid RunStatus "${v}" at ${path}`);
  }
}

export function assertTaskMode(v: unknown, path: string): "agent" | "fixture" | "import" {
  if (typeof v !== "string") throw new APIError(502, `Expected TaskMode string at ${path}, got ${typeof v}`);
  switch (v) {
    case "agent": case "fixture": case "import": return v;
    default: throw new APIError(502, `Invalid TaskMode "${v}" at ${path}`);
  }
}

export function assertMessageRole(v: unknown, path: string): "system" | "user" | "assistant" | "tool" {
  if (typeof v !== "string") throw new APIError(502, `Expected MessageRole string at ${path}, got ${typeof v}`);
  switch (v) {
    case "system": case "user": case "assistant": case "tool": return v;
    default: throw new APIError(502, `Invalid MessageRole "${v}" at ${path}`);
  }
}

function assertEventSchemaVersion(v: unknown, path: string): "1.0" | "2.0" {
  if (v === "1.0") return "1.0";
  if (v === "2.0") return "2.0";
  throw new APIError(502, `Expected "1.0"|"2.0" at ${path}, got ${String(v)}`);
}

export function assertEventType(v: unknown, path: string): "task_created" | "plan_ready" | "user_input_required" | "user_input_resumed" | "stage_started" | "stage_completed" | "stage_failed" | "stage_skipped" | "stage_progress" | "tool_called" | "tool_completed" | "tool_started" | "warning" | "artifact_produced" | "task_cancel_requested" | "task_cancelled" | "task_recovered" | "task_completed" | "task_failed" | "run_queued" | "run_started" | "run_finalizing" | "run_completed" | "run_failed" | "run_cancel_requested" | "run_cancelled" | "run_interrupted" | "assistant_delta" | "assistant_reasoning_delta" | "conversation_compacted" | "subagent_queued" | "subagent_started" | "subagent_progress" | "subagent_completed" | "subagent_failed" | "subagent_cancel_requested" | "subagent_cancelled" | "subagent_interrupted" | "subagent_input_required" | "subagent_input_resumed" {
  if (typeof v !== "string") throw new APIError(502, `Expected event type string at ${path}, got ${typeof v}`);
  switch (v) {
    case "task_created": case "plan_ready": case "user_input_required": case "user_input_resumed":
    case "stage_started": case "stage_completed": case "stage_failed": case "stage_skipped": case "stage_progress":
    case "tool_called": case "tool_completed": case "tool_started": case "warning": case "artifact_produced":
    case "task_cancel_requested": case "task_cancelled": case "task_recovered": case "task_completed": case "task_failed":
    case "run_queued": case "run_started": case "run_finalizing": case "run_completed": case "run_failed":
    case "run_cancel_requested": case "run_cancelled": case "run_interrupted":
    case "assistant_delta": case "assistant_reasoning_delta": case "conversation_compacted":
    case "subagent_queued": case "subagent_started": case "subagent_progress": case "subagent_completed":
    case "subagent_failed": case "subagent_cancel_requested": case "subagent_cancelled":
    case "subagent_interrupted": case "subagent_input_required": case "subagent_input_resumed":
      return v;
    default:
      throw new APIError(502, `Unknown event type "${v}" at ${path}`);
  }
}

/* ---- Endpoint parsers ---- */

export function parseTaskRunAccepted(json: unknown): TaskRunAccepted {
  const obj = assertObject(json, "TaskRunAccepted");
  const status = assertString(Reflect.get(obj, "status"), "status");
  if (status !== "queued") throw new APIError(502, `Expected status "queued" for TaskRunAccepted, got "${status}"`);
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), "schema_version"),
    request_id: assertString(Reflect.get(obj, "request_id"), "request_id"),
    task_id: assertString(Reflect.get(obj, "task_id"), "task_id"),
    run_id: assertString(Reflect.get(obj, "run_id"), "run_id"),
    status: "queued",
  };
}

function parseRunRecord(json: unknown, idx: number): TaskSnapshot["runs"][number] {
  const obj = assertObject(json, `runs[${idx}]`);
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), `runs[${idx}].schema_version`),
    run_id: assertString(Reflect.get(obj, "run_id"), `runs[${idx}].run_id`),
    task_id: assertString(Reflect.get(obj, "task_id"), `runs[${idx}].task_id`),
    request_id: assertString(Reflect.get(obj, "request_id"), `runs[${idx}].request_id`),
    status: assertRunStatus(Reflect.get(obj, "status"), `runs[${idx}].status`),
    input: assertString(Reflect.get(obj, "input"), `runs[${idx}].input`),
    created_at: assertString(Reflect.get(obj, "created_at"), `runs[${idx}].created_at`),
    updated_at: assertString(Reflect.get(obj, "updated_at"), `runs[${idx}].updated_at`),
    started_at: assertStringOrNull(Reflect.get(obj, "started_at"), `runs[${idx}].started_at`),
    finished_at: assertStringOrNull(Reflect.get(obj, "finished_at"), `runs[${idx}].finished_at`),
    error: assertStringOrNull(Reflect.get(obj, "error"), `runs[${idx}].error`),
  };
}

function parseMessageRecord(json: unknown, idx: number): TaskSnapshot["messages"][number] {
  const obj = assertObject(json, `messages[${idx}]`);
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), `messages[${idx}].schema_version`),
    message_id: assertString(Reflect.get(obj, "message_id"), `messages[${idx}].message_id`),
    task_id: assertString(Reflect.get(obj, "task_id"), `messages[${idx}].task_id`),
    run_id: assertStringOrNull(Reflect.get(obj, "run_id"), `messages[${idx}].run_id`),
    ordinal: assertNumber(Reflect.get(obj, "ordinal"), `messages[${idx}].ordinal`),
    role: assertMessageRole(Reflect.get(obj, "role"), `messages[${idx}].role`),
    content: assertString(Reflect.get(obj, "content"), `messages[${idx}].content`),
    created_at: assertString(Reflect.get(obj, "created_at"), `messages[${idx}].created_at`),
  };
}

function parseSubagentRecord(
  json: unknown,
  idx: number,
): NonNullable<TaskSnapshot["subagents"]>[number] {
  const obj = assertObject(json, `subagents[${idx}]`);
  return {
    subagent_id: assertString(Reflect.get(obj, "subagent_id"), `subagents[${idx}].subagent_id`),
    task_id: assertString(Reflect.get(obj, "task_id"), `subagents[${idx}].task_id`),
    run_id: assertString(Reflect.get(obj, "run_id"), `subagents[${idx}].run_id`),
    agent_type: assertFinite(Reflect.get(obj, "agent_type"), `subagents[${idx}].agent_type`, ["source_research", "skill_builder"]),
    objective: assertString(Reflect.get(obj, "objective"), `subagents[${idx}].objective`),
    target_source: assertStringOrNull(Reflect.get(obj, "target_source"), `subagents[${idx}].target_source`),
    status: assertFinite(Reflect.get(obj, "status"), `subagents[${idx}].status`, ["queued", "running", "completed", "failed", "cancel_requested", "cancelled", "interrupted"]),
    parent_tool_call_id: assertString(Reflect.get(obj, "parent_tool_call_id"), `subagents[${idx}].parent_tool_call_id`),
    created_at: assertString(Reflect.get(obj, "created_at"), `subagents[${idx}].created_at`),
    started_at: assertStringOrNull(Reflect.get(obj, "started_at"), `subagents[${idx}].started_at`),
    finished_at: assertStringOrNull(Reflect.get(obj, "finished_at"), `subagents[${idx}].finished_at`),
    progress_current: assertNumber(Reflect.get(obj, "progress_current"), `subagents[${idx}].progress_current`),
    progress_total: assertOptionalNull(
      Reflect.get(obj, "progress_total"),
      `subagents[${idx}].progress_total`,
      assertNumber,
    ),
    progress_message: assertStringOrNull(Reflect.get(obj, "progress_message"), `subagents[${idx}].progress_message`),
    result_summary: assertStringOrNull(Reflect.get(obj, "result_summary"), `subagents[${idx}].result_summary`),
    source_asset_ids: assertArray(Reflect.get(obj, "source_asset_ids"), `subagents[${idx}].source_asset_ids`, (value, sourceIndex) => assertString(value, `subagents[${idx}].source_asset_ids[${sourceIndex}]`)),
    recipe_id: assertStringOrNull(Reflect.get(obj, "recipe_id"), `subagents[${idx}].recipe_id`),
    error_code: assertFiniteOrNull(Reflect.get(obj, "error_code"), `subagents[${idx}].error_code`),
    error_message: assertStringOrNull(Reflect.get(obj, "error_message"), `subagents[${idx}].error_message`),
    pending_request_id: assertStringOrNull(Reflect.get(obj, "pending_request_id"), `subagents[${idx}].pending_request_id`),
  };
}

function assertFiniteOrNull(
  value: unknown,
  path: string,
): SubagentErrorCode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new APIError(502, `Invalid subagent error code at ${path}`);
  }
  switch (value) {
    case "not_found":
    case "capability_gap":
    case "extraction_failed":
    case "auth_required":
    case "captcha_required":
    case "credential_required":
    case "payment_required":
    case "policy_denied":
    case "rate_limited":
    case "timed_out":
    case "cancelled":
    case "internal_error":
      return value;
    default:
      throw new APIError(502, `Invalid subagent error code at ${path}`);
  }
}

export function parseTaskSnapshot(json: unknown): TaskSnapshot {
  const obj = assertObject(json, "TaskSnapshot");
  const task = assertObject(Reflect.get(obj, "task"), "task");
  const rawSubagents = Reflect.get(obj, "subagents");
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), "schema_version"),
    task: {
      schema_version: optSchemaVersion(Reflect.get(task, "schema_version"), "task.schema_version"),
      task_id: assertString(Reflect.get(task, "task_id"), "task.task_id"),
      mode: assertTaskMode(Reflect.get(task, "mode"), "task.mode"),
      databases: assertArray(Reflect.get(task, "databases"), "task.databases", (v) => assertString(v, "databases[]")),
      title: assertString(Reflect.get(task, "title"), "task.title"),
      status: assertRunStatus(Reflect.get(task, "status"), "task.status"),
      active_run_id: assertStringOrNull(Reflect.get(task, "active_run_id"), "task.active_run_id"),
      created_at: assertString(Reflect.get(task, "created_at"), "task.created_at"),
      updated_at: assertString(Reflect.get(task, "updated_at"), "task.updated_at"),
      latest_sequence: assertNumber(Reflect.get(task, "latest_sequence"), "task.latest_sequence"),
      artifact_count: optionalNumber(Reflect.get(task, "artifact_count")),
    },
    runs: assertArray(Reflect.get(obj, "runs"), "runs", parseRunRecord),
    messages: assertArray(Reflect.get(obj, "messages"), "messages", parseMessageRecord),
    subagents: rawSubagents === undefined
      ? []
      : assertArray(rawSubagents, "subagents", parseSubagentRecord),
    older_messages_cursor: assertStringOrNull(Reflect.get(obj, "older_messages_cursor"), "older_messages_cursor"),
  };
}

export function parseTaskPage(json: unknown): TaskPage {
  const obj = assertObject(json, "TaskPage");
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), "schema_version"),
    active_items: assertArray(Reflect.get(obj, "active_items"), "active_items", (item, i) => parseTaskSummary(item, `active_items[${i}]`)),
    items: assertArray(Reflect.get(obj, "items"), "items", (item, i) => parseTaskSummary(item, `items[${i}]`)),
    next_cursor: assertStringOrNull(Reflect.get(obj, "next_cursor"), "next_cursor"),
  };
}

function parseTaskSummary(json: unknown, path: string): TaskPage["active_items"][number] {
  const obj = assertObject(json, path);
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), `${path}.schema_version`),
    task_id: assertString(Reflect.get(obj, "task_id"), `${path}.task_id`),
    mode: assertTaskMode(Reflect.get(obj, "mode"), `${path}.mode`),
    databases: assertArray(Reflect.get(obj, "databases"), `${path}.databases`, (v) => assertString(v, `${path}.databases[]`)),
    title: assertString(Reflect.get(obj, "title"), `${path}.title`),
    status: assertRunStatus(Reflect.get(obj, "status"), `${path}.status`),
    active_run_id: assertStringOrNull(Reflect.get(obj, "active_run_id"), `${path}.active_run_id`),
    created_at: assertString(Reflect.get(obj, "created_at"), `${path}.created_at`),
    updated_at: assertString(Reflect.get(obj, "updated_at"), `${path}.updated_at`),
    latest_sequence: assertNumber(Reflect.get(obj, "latest_sequence"), `${path}.latest_sequence`),
    artifact_count: optionalNumber(Reflect.get(obj, "artifact_count")),
  };
}

export function parseMessagePage(json: unknown): MessagePage {
  const obj = assertObject(json, "MessagePage");
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), "schema_version"),
    messages: assertArray(Reflect.get(obj, "messages"), "messages", (item, i) => parseMessageRecord(item, i)),
    next_cursor: assertStringOrNull(Reflect.get(obj, "next_cursor"), "next_cursor"),
  };
}

export function parseEventPage(json: unknown): EventPage {
  const obj = assertObject(json, "EventPage");
  return {
    events: assertArray(Reflect.get(obj, "events"), "events", (item, i) => parseEventEnvelope(item, i)),
  };
}

function assertNonEmptyId(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (s.length === 0) throw new APIError(502, `Expected non-empty ID at ${path}`);
  return s;
}

function assertStringOrNullNonEmpty(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  const s = assertString(v, path);
  if (s.length === 0) throw new APIError(502, `Expected non-empty string|null at ${path}`);
  return s;
}

function assertPositiveSequence(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (n < 1 || !Number.isInteger(n)) throw new APIError(502, `Expected positive integer >= 1 at ${path}, got ${n}`);
  return n;
}

function isRuntimeEventType(t: string): boolean {
  return RUNTIME_EVENT_TYPES.has(t);
}

function parseEventEnvelope(json: unknown, idx: number): EventPage["events"][number] {
  const obj = assertObject(json, `events[${idx}]`);
  const schemaVersion = assertEventSchemaVersion(Reflect.get(obj, "schema_version"), `events[${idx}].schema_version`);
  const eventId = assertNonEmptyId(Reflect.get(obj, "event_id"), `events[${idx}].event_id`);
  const eventType = assertEventType(Reflect.get(obj, "type"), `events[${idx}].type`);
  const taskId = assertNonEmptyId(Reflect.get(obj, "task_id"), `events[${idx}].task_id`);
  const runId = assertStringOrNullNonEmpty(Reflect.get(obj, "run_id"), `events[${idx}].run_id`);
  const stageAttemptId = assertStringOrNullNonEmpty(Reflect.get(obj, "stage_attempt_id"), `events[${idx}].stage_attempt_id`);
  const subagentId = assertStringOrNullNonEmpty(Reflect.get(obj, "subagent_id"), `events[${idx}].subagent_id`);
  const parentToolCallId = assertStringOrNullNonEmpty(Reflect.get(obj, "parent_tool_call_id"), `events[${idx}].parent_tool_call_id`);
  const sequence = assertPositiveSequence(Reflect.get(obj, "sequence"), `events[${idx}].sequence`);

  /* Parse payload first to determine runtime scope from content */
  const payloadObj = assertObject(Reflect.get(obj, "payload"), `events[${idx}].payload`);
  const payload = parseEventPayload(payloadObj, eventType, `events[${idx}].payload`);

  /* Backend EventEnvelope.validate_envelope() invariants:
     runtime_scoped = isinstance(type, RuntimeEventType)
       or (isinstance(payload, ToolCompletedPayload) and payload.tool_call_id is not None)
       or (isinstance(payload, WarningPayload) and payload.warning is None)
  */
  if (STAGE_EVENT_TYPES.has(eventType) && stageAttemptId === null) {
    throw new APIError(502, `Stage event type "${eventType}" requires non-null stage_attempt_id at events[${idx}]`);
  }
  const runtimeByType = isRuntimeEventType(eventType);
  const runtimeByContent = (payload.type === "tool_completed" && payload.tool_call_id != null)
    || (payload.type === "warning" && payload.warning == null);
  const runtimeScoped = runtimeByType || runtimeByContent;
  if ((runId !== null || runtimeScoped) && schemaVersion !== "2.0") {
    throw new APIError(502, `Run-linked/runtime events require schema_version "2.0" at events[${idx}]`);
  }
  if (runtimeScoped && runId === null) {
    throw new APIError(502, `Runtime-scoped event type "${eventType}" requires non-null run_id at events[${idx}]`);
  }
  if ((subagentId !== null || parentToolCallId !== null) && runId === null) {
    throw new APIError(502, `Subagent linkage requires non-null run_id at events[${idx}]`);
  }
  if (SUBAGENT_EVENT_TYPES.has(eventType)) {
    if (subagentId === null || parentToolCallId === null) {
      throw new APIError(502, `Subagent event type "${eventType}" requires envelope linkage at events[${idx}]`);
    }
    if (
      !("subagent_id" in payload) ||
      payload.subagent_id !== subagentId
    ) {
      throw new APIError(502, `Subagent payload linkage must match envelope at events[${idx}]`);
    }
  }

  return {
    schema_version: schemaVersion,
    event_id: eventId,
    type: eventType,
    task_id: taskId,
    run_id: runId,
    stage_attempt_id: stageAttemptId,
    subagent_id: subagentId,
    parent_tool_call_id: parentToolCallId,
    sequence: sequence,
    timestamp: assertString(Reflect.get(obj, "timestamp"), `events[${idx}].timestamp`),
    payload,
  };
}
