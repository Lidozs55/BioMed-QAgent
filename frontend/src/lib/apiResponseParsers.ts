/* ------------------------------------------------------------------ */
/*  Runtime response parsers for non-settings API endpoints            */
/*  Each parser field-level-checks its declared return type.           */
/* ------------------------------------------------------------------ */

import { APIError } from "@/api/errors";
import {
  assertString,
  assertNumber,
  assertBoolean,
  assertObject,
  assertArray,
  assertStringOrNull,
  assertOptionalNull,
  assertFinite,
  optSchemaVersion,
  assertHex64,
  assertNonNegativeInt,
  assertPositiveInt,
  assertJsonRecord,
  ERROR_CODES,
  MESSAGE_ROLES,
  RUN_STATUSES,
  STAGE_NAMES,
  TASK_MODES,
} from "@biomed/contracts";
import type {
  PublicationDetail,
  PublicationPage,
  DatasetManifestV1,
  DatasetManifestV2,
  DatasetPublication,
  DownloadResumeAccepted,
  EventPage,
  ManifestArtifactEntry,
  MessagePage,
  PublicationCandidateRef,
  TaskPublicationSummary,
  RelationDefinition,
  RunSummary,
  SubagentErrorCode,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
  TableDefinition,
  VersionedDatasetManifest,
} from "@/runtime/contracts";
import { parseEventPayload } from "@/lib/eventParsers";
import { formalHILLinkageMatches } from "@/lib/eventParsersPipeline";
import type { QuarantineReceipt } from "@/api/quarantine";

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ---- EventEnvelope invariant helpers ---- */

const STAGE_EVENT_TYPES = new Set(["stage_started", "stage_completed", "stage_failed", "stage_skipped"]);
const RUNTIME_EVENT_TYPES = new Set([
  "run_queued", "run_steered", "run_started", "run_finalizing", "run_completed", "run_failed",
  "run_cancel_requested", "run_cancelled", "run_interrupted", "publication_created",
  "assistant_delta", "assistant_reasoning_delta", "tool_started", "context_usage", "conversation_compacted",
  "conversation_compaction_started", "conversation_compaction_failed",
  "operation_started", "operation_progress", "operation_completed", "operation_failed",
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
  return assertFinite(v, path, RUN_STATUSES);
}

export function assertTaskMode(v: unknown, path: string): "agent" | "fixture" | "import" {
  return assertFinite(v, path, TASK_MODES);
}

export function assertMessageRole(v: unknown, path: string): "system" | "user" | "assistant" | "tool" {
  return assertFinite(v, path, MESSAGE_ROLES);
}

function assertEventSchemaVersion(v: unknown, path: string): "1.0" | "2.0" {
  if (v === "1.0") return "1.0";
  if (v === "2.0") return "2.0";
  throw new APIError(502, `Expected "1.0"|"2.0" at ${path}, got ${String(v)}`);
}

export function assertEventType(v: unknown, path: string): "task_created" | "plan_ready" | "user_input_required" | "user_input_resumed" | "stage_started" | "stage_completed" | "stage_failed" | "stage_skipped" | "stage_progress" | "tool_called" | "tool_completed" | "tool_started" | "warning" | "artifact_produced" | "task_cancel_requested" | "task_cancelled" | "task_recovered" | "task_completed" | "task_failed" | "run_queued" | "run_steered" | "run_started" | "run_finalizing" | "run_completed" | "run_failed" | "run_cancel_requested" | "run_cancelled" | "run_interrupted" | "publication_created" | "assistant_delta" | "assistant_reasoning_delta" | "context_usage" | "conversation_compacted" | "conversation_compaction_started" | "conversation_compaction_failed" | "permission_requested" | "permission_resolved" | "operation_started" | "operation_progress" | "operation_completed" | "operation_failed" | "subagent_queued" | "subagent_started" | "subagent_progress" | "subagent_completed" | "subagent_failed" | "subagent_cancel_requested" | "subagent_cancelled" | "subagent_interrupted" | "subagent_input_required" | "subagent_input_resumed" {
  if (typeof v !== "string") throw new APIError(502, `Expected event type string at ${path}, got ${typeof v}`);
  switch (v) {
    case "task_created": case "plan_ready": case "user_input_required": case "user_input_resumed":
    case "stage_started": case "stage_completed": case "stage_failed": case "stage_skipped": case "stage_progress":
    case "tool_called": case "tool_completed": case "tool_started": case "warning": case "artifact_produced":
    case "task_cancel_requested": case "task_cancelled": case "task_recovered": case "task_completed": case "task_failed":
    case "run_queued": case "run_steered": case "run_started": case "run_finalizing": case "run_completed": case "run_failed":
    case "run_cancel_requested": case "run_cancelled": case "run_interrupted": case "publication_created":
    case "assistant_delta": case "assistant_reasoning_delta": case "context_usage": case "conversation_compacted":
    case "conversation_compaction_started": case "conversation_compaction_failed":
    case "permission_requested": case "permission_resolved":
    case "operation_started": case "operation_progress": case "operation_completed": case "operation_failed":
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

export function parseDownloadResumeAccepted(json: unknown): DownloadResumeAccepted {
  const obj = assertObject(json, "DownloadResumeAccepted");
  return {
    task_id: assertString(Reflect.get(obj, "task_id"), "task_id"),
    run_id: assertString(Reflect.get(obj, "run_id"), "run_id"),
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
    summary: assertOptionalNull(
      Reflect.get(obj, "summary"),
      `runs[${idx}].summary`,
      (value, path) => parseRunSummary(value, path),
    ),
  };
}

function parseRunSummary(json: unknown, path: string): RunSummary {
  const obj = assertObject(json, path);
  return {
    run_status: assertRunStatus(Reflect.get(obj, "run_status"), `${path}.run_status`),
    error_code: assertOptionalNull(Reflect.get(obj, "error_code"), `${path}.error_code`, (value, p) => assertFinite(value, p, ERROR_CODES)),
    cancelled_at_stage: assertOptionalNull(Reflect.get(obj, "cancelled_at_stage"), `${path}.cancelled_at_stage`, (value, p) => assertFinite(value, p, STAGE_NAMES)),
    user_message: assertStringOrNull(Reflect.get(obj, "user_message"), `${path}.user_message`),
  };
}

function parseTaskPublicationSummary(json: unknown, idx: number): TaskPublicationSummary {
  const path = `publications[${idx}]`;
  const obj = assertObject(json, path);
  return {
    publication_id: assertNonEmptyId(Reflect.get(obj, "publication_id"), `${path}.publication_id`),
    manifest_sha256: assertHex64(Reflect.get(obj, "manifest_sha256"), `${path}.manifest_sha256`),
    supersedes_publication_id: assertStringOrNull(Reflect.get(obj, "supersedes_publication_id"), `${path}.supersedes_publication_id`),
    published_at: assertString(Reflect.get(obj, "published_at"), `${path}.published_at`),
  };
}

function parseMessageRecord(json: unknown, idx: number): TaskSnapshot["messages"][number] {
  const obj = assertObject(json, `messages[${idx}]`);
  const rawSequence = Reflect.get(obj, "sequence");
  return {
    schema_version: optSchemaVersion(Reflect.get(obj, "schema_version"), `messages[${idx}].schema_version`),
    message_id: assertString(Reflect.get(obj, "message_id"), `messages[${idx}].message_id`),
    task_id: assertString(Reflect.get(obj, "task_id"), `messages[${idx}].task_id`),
    run_id: assertStringOrNull(Reflect.get(obj, "run_id"), `messages[${idx}].run_id`),
    ordinal: assertNumber(Reflect.get(obj, "ordinal"), `messages[${idx}].ordinal`),
    role: assertMessageRole(Reflect.get(obj, "role"), `messages[${idx}].role`),
    content: assertString(Reflect.get(obj, "content"), `messages[${idx}].content`),
    created_at: assertString(Reflect.get(obj, "created_at"), `messages[${idx}].created_at`),
    ...(rawSequence === undefined
      ? {}
      : { sequence: assertPositiveInt(rawSequence, `messages[${idx}].sequence`) }),
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
  const rawPublications = Reflect.get(obj, "publications");
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
    current_publication_id: assertStringOrNull(Reflect.get(obj, "current_publication_id"), "current_publication_id"),
    publications: rawPublications === undefined
      ? []
      : assertArray(rawPublications, "publications", parseTaskPublicationSummary),
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
  if (!formalHILLinkageMatches(payload, taskId, runId)) {
    throw new APIError(
      502,
      `Formal HIL payload linkage must match its event envelope at events[${idx}]`,
    );
  }

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

/* ---- V2 builds (Phase 7 T1 backend contract) ---- */

function parseArtifactRole(
  v: unknown,
  path: string,
): ManifestArtifactEntry["role"] {
  if (typeof v !== "string") throw new APIError(502, `Expected ArtifactRole string at ${path}, got ${typeof v}`);
  switch (v) {
    case "primary_dataset":
    case "supporting_dataset":
    case "schema":
    case "provenance":
    case "audit_report":
      return v;
    default:
      throw new APIError(502, `Invalid ArtifactRole "${v}" at ${path}`);
  }
}

function parseManifestArtifactEntry(
  json: unknown,
  path: string,
): ManifestArtifactEntry {
  const obj = assertObject(json, path);
  return {
    artifact_id: assertString(Reflect.get(obj, "artifact_id"), `${path}.artifact_id`, true),
    role: parseArtifactRole(Reflect.get(obj, "role"), `${path}.role`),
    relative_path: assertString(Reflect.get(obj, "relative_path"), `${path}.relative_path`, true),
    media_type: assertString(Reflect.get(obj, "media_type"), `${path}.media_type`, true),
    size_bytes: assertNonNegativeInt(Reflect.get(obj, "size_bytes"), `${path}.size_bytes`),
    sha256: assertString(Reflect.get(obj, "sha256"), `${path}.sha256`, true),
  };
}

function assertUniqueTopologyIds(
  values: readonly string[],
  path: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new APIError(502, `Duplicate ${label} "${value}" at ${path}`);
    }
    seen.add(value);
  }
}

function parseDatasetManifestV1Fields(json: unknown, path: string): DatasetManifestV1 {
  const obj = assertObject(json, path);
  return {
    manifest_id: assertString(Reflect.get(obj, "manifest_id"), `${path}.manifest_id`, true),
    task_id: assertString(Reflect.get(obj, "task_id"), `${path}.task_id`, true),
    requirement_id: assertString(Reflect.get(obj, "requirement_id"), `${path}.requirement_id`, true),
    dataset_family: assertString(Reflect.get(obj, "dataset_family"), `${path}.dataset_family`, true),
    row_granularity: assertString(Reflect.get(obj, "row_granularity"), `${path}.row_granularity`, true),
    schema_ref: assertString(Reflect.get(obj, "schema_ref"), `${path}.schema_ref`, true),
    primary_key: assertArray(Reflect.get(obj, "primary_key"), `${path}.primary_key`, (value, index) => assertString(value, `${path}.primary_key[${index}]`)),
    row_count: assertNonNegativeInt(Reflect.get(obj, "row_count"), `${path}.row_count`),
    sha256: assertString(Reflect.get(obj, "sha256"), `${path}.sha256`, true),
    artifacts: assertArray(Reflect.get(obj, "artifacts"), `${path}.artifacts`, (value, index) => parseManifestArtifactEntry(value, `${path}.artifacts[${index}]`)),
    source_summary: assertJsonRecord(Reflect.get(obj, "source_summary"), `${path}.source_summary`),
    validation_summary: assertJsonRecord(Reflect.get(obj, "validation_summary"), `${path}.validation_summary`),
    confidence_summary: assertJsonRecord(Reflect.get(obj, "confidence_summary"), `${path}.confidence_summary`),
    provenance_summary: assertJsonRecord(Reflect.get(obj, "provenance_summary"), `${path}.provenance_summary`),
  };
}

const TABLE_ROLES = ["primary", "supporting", "derived"] as const;
const RELATION_CARDINALITIES = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"] as const;
const RELATION_MISSING_POLICIES = ["reject", "allow_empty", "allow_missing", "profile_defined"] as const;

function parseStringArray(value: unknown, path: string, nonEmpty: boolean): string[] {
  const values = assertArray(value, path, (entry, index) => assertString(entry, `${path}[${index}]`, true));
  if (nonEmpty && values.length === 0) {
    throw new APIError(502, `Expected non-empty array at ${path}`);
  }
  return values;
}

function parseTableDefinition(json: unknown, path: string): TableDefinition {
  const obj = assertObject(json, path);
  const primaryKey = parseStringArray(Reflect.get(obj, "primary_key"), `${path}.primary_key`, true);
  const fieldNames = parseStringArray(Reflect.get(obj, "field_names"), `${path}.field_names`, true);
  assertUniqueTopologyIds(fieldNames, `${path}.field_names`, "field name");
  assertUniqueTopologyIds(primaryKey, `${path}.primary_key`, "primary key field");
  if (primaryKey.some((field) => !fieldNames.includes(field))) {
    throw new APIError(502, `Primary key at ${path}.primary_key references an undeclared field`);
  }
  return {
    table_id: assertString(Reflect.get(obj, "table_id"), `${path}.table_id`, true),
    schema_ref: assertString(Reflect.get(obj, "schema_ref"), `${path}.schema_ref`, true),
    role: assertFinite(Reflect.get(obj, "role"), `${path}.role`, TABLE_ROLES),
    required: assertBoolean(Reflect.get(obj, "required"), `${path}.required`),
    allow_empty: assertBoolean(Reflect.get(obj, "allow_empty"), `${path}.allow_empty`),
    primary_key: primaryKey,
    field_names: fieldNames,
  };
}

function parseRelationDefinition(json: unknown, path: string): RelationDefinition {
  const obj = assertObject(json, path);
  const fromFields = parseStringArray(Reflect.get(obj, "from_fields"), `${path}.from_fields`, true);
  const toFields = parseStringArray(Reflect.get(obj, "to_fields"), `${path}.to_fields`, true);
  assertUniqueTopologyIds(fromFields, `${path}.from_fields`, "relation source field");
  assertUniqueTopologyIds(toFields, `${path}.to_fields`, "relation target field");
  if (fromFields.length !== toFields.length) {
    throw new APIError(502, `Relation field pairs at ${path} must have equal lengths`);
  }
  return {
    relation_id: assertString(Reflect.get(obj, "relation_id"), `${path}.relation_id`, true),
    from_table_id: assertString(Reflect.get(obj, "from_table_id"), `${path}.from_table_id`, true),
    from_fields: fromFields,
    to_table_id: assertString(Reflect.get(obj, "to_table_id"), `${path}.to_table_id`, true),
    to_fields: toFields,
    cardinality: assertFinite(Reflect.get(obj, "cardinality"), `${path}.cardinality`, RELATION_CARDINALITIES),
    missing_policy: assertFinite(Reflect.get(obj, "missing_policy"), `${path}.missing_policy`, RELATION_MISSING_POLICIES),
  };
}

function parsePublicationCandidateRef(json: unknown, path: string): PublicationCandidateRef {
  const obj = assertObject(json, path);
  const tableIds = parseStringArray(Reflect.get(obj, "table_ids"), `${path}.table_ids`, true);
  const relationIds = parseStringArray(Reflect.get(obj, "relation_ids"), `${path}.relation_ids`, false);
  const provenanceRefs = parseStringArray(Reflect.get(obj, "provenance_refs"), `${path}.provenance_refs`, false);
  const confidenceRefs = parseStringArray(Reflect.get(obj, "confidence_refs"), `${path}.confidence_refs`, false);
  const auditRefs = parseStringArray(Reflect.get(obj, "audit_refs"), `${path}.audit_refs`, false);
  assertUniqueTopologyIds(tableIds, `${path}.table_ids`, "candidate table reference");
  assertUniqueTopologyIds(relationIds, `${path}.relation_ids`, "candidate relation reference");
  assertUniqueTopologyIds(provenanceRefs, `${path}.provenance_refs`, "candidate provenance reference");
  assertUniqueTopologyIds(confidenceRefs, `${path}.confidence_refs`, "candidate confidence reference");
  assertUniqueTopologyIds(auditRefs, `${path}.audit_refs`, "candidate audit reference");
  return {
    candidate_id: assertString(Reflect.get(obj, "candidate_id"), `${path}.candidate_id`, true),
    table_ids: tableIds,
    relation_ids: relationIds,
    provenance_refs: provenanceRefs,
    confidence_refs: confidenceRefs,
    audit_refs: auditRefs,
  };
}

function validateTopologyReferences(
  tables: readonly TableDefinition[],
  relations: readonly RelationDefinition[],
  candidateRefs: readonly PublicationCandidateRef[],
  path: string,
): void {
  assertUniqueTopologyIds(tables.map((table) => table.table_id), `${path}.tables`, "table ID");
  assertUniqueTopologyIds(relations.map((relation) => relation.relation_id), `${path}.relations`, "relation ID");
  assertUniqueTopologyIds(candidateRefs.map((candidate) => candidate.candidate_id), `${path}.candidate_refs`, "candidate ID");

  const tablesById = new Map(tables.map((table) => [table.table_id, table]));
  const relationsById = new Map(relations.map((relation) => [relation.relation_id, relation]));
  for (const relation of relations) {
    const fromTable = tablesById.get(relation.from_table_id);
    const toTable = tablesById.get(relation.to_table_id);
    if (fromTable === undefined || toTable === undefined) {
      throw new APIError(502, `Relation "${relation.relation_id}" references an unknown table at ${path}.relations`);
    }
    if (relation.from_fields.length !== relation.to_fields.length) {
      throw new APIError(502, `Relation "${relation.relation_id}" has unequal field-pair lengths at ${path}.relations`);
    }
    if (relation.from_fields.some((field) => !fromTable.field_names.includes(field))) {
      throw new APIError(502, `Relation "${relation.relation_id}" references a missing source field at ${path}.relations`);
    }
    if (relation.to_fields.some((field) => !toTable.field_names.includes(field))) {
      throw new APIError(502, `Relation "${relation.relation_id}" references a missing target field at ${path}.relations`);
    }
  }
  for (const candidate of candidateRefs) {
    if (candidate.table_ids.some((tableId) => !tablesById.has(tableId))) {
      throw new APIError(502, `Candidate "${candidate.candidate_id}" references an unknown table at ${path}.candidate_refs`);
    }
    if (candidate.relation_ids.some((relationId) => !relationsById.has(relationId))) {
      throw new APIError(502, `Candidate "${candidate.candidate_id}" references an unknown relation at ${path}.candidate_refs`);
    }
  }
}

function parseVersionedDatasetManifest(json: unknown, path: string): VersionedDatasetManifest {
  const object = assertObject(json, path);
  const common = parseDatasetManifestV1Fields(object, path);
  const schemaVersion = Reflect.get(object, "schema_version");
  if (schemaVersion !== undefined && schemaVersion !== "1.0" && schemaVersion !== "2.0") {
    throw new APIError(502, `Expected "1.0"|"2.0" or absent at ${path}.schema_version, got ${String(schemaVersion)}`);
  }
  if (schemaVersion !== "2.0") {
    return schemaVersion === "1.0" ? { ...common, schema_version: "1.0" } : common;
  }

  const tables = assertArray(Reflect.get(object, "tables"), `${path}.tables`, (value, index) =>
    parseTableDefinition(value, `${path}.tables[${index}]`),
  );
  const relations = assertArray(Reflect.get(object, "relations"), `${path}.relations`, (value, index) =>
    parseRelationDefinition(value, `${path}.relations[${index}]`),
  );
  const candidateRefs = assertArray(Reflect.get(object, "candidate_refs"), `${path}.candidate_refs`, (value, index) =>
    parsePublicationCandidateRef(value, `${path}.candidate_refs[${index}]`),
  );
  if (tables.length === 0) {
    throw new APIError(502, `DatasetManifest.tables must be a non-empty array at ${path}.tables`);
  }
  if (!tables.some((table) => table.role === "primary")) {
    throw new APIError(502, `DatasetManifest must declare a primary table at ${path}.tables`);
  }
  if (candidateRefs.length === 0) {
    throw new APIError(502, `DatasetManifest.candidate_refs must be a non-empty array at ${path}.candidate_refs`);
  }
  validateTopologyReferences(tables, relations, candidateRefs, path);
  return {
    ...common,
    schema_version: "2.0",
    tables,
    relations,
    candidate_refs: candidateRefs,
  } satisfies DatasetManifestV2;
}

function parseDatasetPublication(
  json: unknown,
  path: string,
): DatasetPublication {
  const obj = assertObject(json, path);
  if (Reflect.get(obj, "schema_version") !== "1.1") {
    throw new TypeError(`${path}.schema_version must be 1.1`);
  }
  return {
    schema_version: "1.1",
    publication_id: assertString(Reflect.get(obj, "publication_id"), `${path}.publication_id`, true),
    manifest_ref: assertString(Reflect.get(obj, "manifest_ref"), `${path}.manifest_ref`, true),
    manifest_sha256: assertString(Reflect.get(obj, "manifest_sha256"), `${path}.manifest_sha256`, true),
    validation_result_ref: assertString(Reflect.get(obj, "validation_result_ref"), `${path}.validation_result_ref`, true),
    published_at: assertString(Reflect.get(obj, "published_at"), `${path}.published_at`, true),
    supersedes_publication_id: assertStringOrNull(Reflect.get(obj, "supersedes_publication_id"), `${path}.supersedes_publication_id`),
  };
}

function parsePublicationSummary(json: unknown, path: string): PublicationPage["items"][number] {
  const obj = assertObject(json, path);
  return {
    requirement_id: assertString(Reflect.get(obj, "requirement_id"), `${path}.requirement_id`, true),
    task_id: assertString(Reflect.get(obj, "task_id"), `${path}.task_id`, true),
    dataset_family: assertString(Reflect.get(obj, "dataset_family"), `${path}.dataset_family`, true),
    row_granularity: assertString(Reflect.get(obj, "row_granularity"), `${path}.row_granularity`, true),
    schema_ref: assertString(Reflect.get(obj, "schema_ref"), `${path}.schema_ref`, true),
    row_count: assertNonNegativeInt(Reflect.get(obj, "row_count"), `${path}.row_count`),
    publication_id: assertString(Reflect.get(obj, "publication_id"), `${path}.publication_id`, true),
    manifest_ref: assertString(Reflect.get(obj, "manifest_ref"), `${path}.manifest_ref`, true),
    manifest_sha256: assertString(Reflect.get(obj, "manifest_sha256"), `${path}.manifest_sha256`, true),
    published_at: assertString(Reflect.get(obj, "published_at"), `${path}.published_at`, true),
    run_id: assertString(Reflect.get(obj, "run_id"), `${path}.run_id`, true),
  };
}

export function parsePublicationPage(json: unknown): PublicationPage {
  const obj = assertObject(json, "publications response");
  return {
    items: assertArray(Reflect.get(obj, "items"), "publications response.items", (value, index) => parsePublicationSummary(value, `publications response.items[${index}]`)),
    next_cursor: assertStringOrNull(Reflect.get(obj, "next_cursor"), "publications response.next_cursor"),
  };
}

export function parsePublicationDetail(json: unknown): PublicationDetail {
  const obj = assertObject(json, "publication response");
  return {
    publication_id: assertString(Reflect.get(obj, "publication_id"), "publication response.publication_id", true),
    requirement_id: assertString(Reflect.get(obj, "requirement_id"), "publication response.requirement_id", true),
    run_id: assertString(Reflect.get(obj, "run_id"), "publication response.run_id", true),
    task_id: assertString(Reflect.get(obj, "task_id"), "publication response.task_id", true),
    manifest_ref: assertString(Reflect.get(obj, "manifest_ref"), "publication response.manifest_ref", true),
    manifest: parseVersionedDatasetManifest(Reflect.get(obj, "manifest"), "publication response.manifest"),
    publication: parseDatasetPublication(Reflect.get(obj, "publication"), "publication response.publication"),
    artifacts: assertArray(Reflect.get(obj, "artifacts"), "publication response.artifacts", (value, index) => parseManifestArtifactEntry(value, `publication response.artifacts[${index}]`)),
  };
}

function parseQuarantineCoverageStatus(value: unknown, path: string): QuarantineReceipt["coverage_status"] {
  return assertFinite(value, path, ["complete", "partial", "unknown"] as const);
}

function parseQuarantineScope(value: unknown, path: string): string[] {
  return assertArray(value, path, (entry, index) => assertString(entry, `${path}[${index}]`));
}

export function parseQuarantineReceipt(json: unknown): QuarantineReceipt {
  const obj = assertObject(json, "quarantine receipt");
  if (Reflect.get(obj, "schema_version") !== "1.0") {
    throw new APIError(502, "quarantine receipt.schema_version must be 1.0");
  }
  if (Reflect.get(obj, "authoritative") !== false) {
    throw new APIError(502, "quarantine receipt.authoritative must be false");
  }
  if (Reflect.get(obj, "trust") !== "untrusted") {
    throw new APIError(502, "quarantine receipt.trust must be untrusted");
  }
  return {
    schema_version: "1.0",
    submission_id: assertString(Reflect.get(obj, "submission_id"), "quarantine receipt.submission_id", true),
    task_id: assertString(Reflect.get(obj, "task_id"), "quarantine receipt.task_id", true),
    name: assertString(Reflect.get(obj, "name"), "quarantine receipt.name", true),
    media_type: assertString(Reflect.get(obj, "media_type"), "quarantine receipt.media_type", true),
    source_note: assertStringOrNull(Reflect.get(obj, "source_note"), "quarantine receipt.source_note"),
    coverage_status: parseQuarantineCoverageStatus(Reflect.get(obj, "coverage_status"), "quarantine receipt.coverage_status"),
    covered_scope: parseQuarantineScope(Reflect.get(obj, "covered_scope"), "quarantine receipt.covered_scope"),
    missing_scope: parseQuarantineScope(Reflect.get(obj, "missing_scope"), "quarantine receipt.missing_scope"),
    size_bytes: assertNonNegativeInt(Reflect.get(obj, "size_bytes"), "quarantine receipt.size_bytes"),
    sha256: assertHex64(Reflect.get(obj, "sha256"), "quarantine receipt.sha256"),
    submitted_at: assertString(Reflect.get(obj, "submitted_at"), "quarantine receipt.submitted_at", true),
    authoritative: false,
    trust: "untrusted",
  };
}

export function parseQuarantineReceiptPage(json: unknown): { items: QuarantineReceipt[] } {
  const obj = assertObject(json, "quarantine response");
  return {
    items: assertArray(Reflect.get(obj, "items"), "quarantine response.items", (value) => parseQuarantineReceipt(value)),
  };
}
