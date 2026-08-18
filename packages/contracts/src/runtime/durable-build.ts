import type {
  CancelDatasetBuildRequest,
  CancelDatasetBuildResponse,
  DurableBuildApiError,
  DurableBuildApiErrorCode,
  DurableBuildCancelDisposition,
  DurableBuildCancellation,
  DurableBuildEventEnvelope,
  DurableBuildEventPayload,
  DurableBuildEventRef,
  DurableBuildEventRefs,
  DurableBuildEventType,
  DurableBuildFailure,
  DurableBuildFailureCode,
  DurableBuildLease,
  DurableBuildRecord,
  DurableBuildStatus,
  GetDatasetBuildResponse,
  StartDatasetBuildRequest,
  StartDatasetBuildResponse,
} from "../durable-build.js";
import {
  DURABLE_BUILD_STATUSES,
  canTransitionDurableBuildStatus,
  isDurableBuildTerminalStatus,
} from "../durable-build.js";
import type {
  DatasetBuildSourceAcquisition,
  DatasetBuildSourceBinding,
  DatasetBuildSpec,
} from "../dataset-build.js";
import { APIError } from "./errors.js";
import { parseBuildResult } from "./dataset-build.js";
import {
  assertArray,
  assertBoolean,
  assertHex64,
  assertJsonRecord,
  assertNonNegativeInt,
  assertNumber,
  assertObject,
  assertOptionalNull,
  assertString,
  assertStringOrNull,
} from "./primitives.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const BUILD_EVENT_TYPES: readonly DurableBuildEventType[] = [
  "build_queued",
  "build_started",
  "build_recovered",
  "build_cancel_requested",
  "build_completed",
  "build_failed",
  "build_cancelled",
];
const CANCEL_DISPOSITIONS: readonly DurableBuildCancelDisposition[] = [
  "accepted",
  "already_requested",
  "already_terminal",
];
const API_ERROR_CODES: readonly DurableBuildApiErrorCode[] = [
  "build_not_found",
  "invalid_build_request",
  "idempotency_key_reused",
  "build_identity_mismatch",
  "build_not_cancellable",
  "invalid_build_transition",
];
const FAILURE_CODES: readonly DurableBuildFailureCode[] = [
  "core_execution_error",
  "lease_lost",
  "recovery_exhausted",
  "cancellation_failed",
  "internal_error",
];

function exactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const extras = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new APIError(502, `Unexpected field(s) at ${path}: ${extras.join(", ")}`);
  }
}

function assertLiteral<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const text = assertString(value, path);
  const match = allowed.find((entry) => entry === text);
  if (match === undefined) {
    throw new APIError(502, `Unexpected value "${text}" at ${path}, expected one of [${allowed.join(",")}]`);
  }
  return match;
}

function assertSafeId(value: unknown, path: string): string {
  const text = assertString(value, path, true);
  if (!SAFE_ID.test(text)) throw new APIError(502, `Expected safe identifier at ${path}`);
  return text;
}

function assertIsoDateTime(value: unknown, path: string): string {
  const text = assertString(value, path, true);
  if (!ISO_DATETIME.test(text) || Number.isNaN(Date.parse(text))) {
    throw new APIError(502, `Expected ISO-8601 datetime at ${path}`);
  }
  return text;
}

function assertPositiveInt(value: unknown, path: string): number {
  const number = assertNumber(value, path);
  if (!Number.isInteger(number) || number < 1) {
    throw new APIError(502, `Expected positive integer at ${path}`);
  }
  return number;
}

function parseSchemaVersion(obj: Record<string, unknown>, path: string): "1.0" {
  if (Reflect.get(obj, "schema_version") !== "1.0") {
    throw new APIError(502, `Expected "1.0" at ${path}.schema_version`);
  }
  return "1.0";
}

function parseStringArrayMap(value: unknown, path: string): Record<string, string[]> {
  const obj = assertObject(value, path);
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(obj)) {
    result[key] = assertArray(Reflect.get(obj, key), `${path}.${key}`, (entry, index) =>
      assertString(entry, `${path}.${key}[${index}]`));
  }
  return result;
}

function parseSourceAcquisition(value: unknown, path: string): DatasetBuildSourceAcquisition {
  const obj = assertObject(value, path);
  exactKeys(obj, ["schema_version", "mode", "provider_id", "recipe_id", "recipe_version"], path);
  if (Reflect.get(obj, "schema_version") !== undefined && Reflect.get(obj, "schema_version") !== "1.0") {
    throw new APIError(502, `Expected "1.0" or absent at ${path}.schema_version`);
  }
  const mode = assertLiteral(Reflect.get(obj, "mode"), `${path}.mode`, ["builtin", "workflow_recipe"] as const);
  const providerId = assertStringOrNull(Reflect.get(obj, "provider_id"), `${path}.provider_id`);
  const recipeId = assertStringOrNull(Reflect.get(obj, "recipe_id"), `${path}.recipe_id`);
  const recipeVersion = assertOptionalNull(
    Reflect.get(obj, "recipe_version"),
    `${path}.recipe_version`,
    assertPositiveInt,
  );
  if (mode === "builtin" && (providerId === null || recipeId !== null || recipeVersion !== null)) {
    throw new APIError(502, `${path} builtin mode requires only provider_id`);
  }
  if (mode === "workflow_recipe" && (providerId !== null || recipeId === null || recipeId === "" || recipeVersion === null)) {
    throw new APIError(502, `${path} workflow_recipe mode requires only recipe_id and recipe_version`);
  }
  return {
    schema_version: Reflect.get(obj, "schema_version") === "1.0" ? "1.0" : undefined,
    mode,
    provider_id: providerId,
    recipe_id: recipeId,
    recipe_version: recipeVersion,
  };
}

function parseSourceBinding(value: unknown, path: string): DatasetBuildSourceBinding {
  const obj = assertObject(value, path);
  exactKeys(obj, [
    "schema_version",
    "binding_id",
    "source",
    "acquisition",
    "adapter_id",
    "accession",
    "parameters",
  ], path);
  if (Reflect.get(obj, "schema_version") !== undefined && Reflect.get(obj, "schema_version") !== "1.0") {
    throw new APIError(502, `Expected "1.0" or absent at ${path}.schema_version`);
  }
  return {
    schema_version: Reflect.get(obj, "schema_version") === "1.0" ? "1.0" : undefined,
    binding_id: assertSafeId(Reflect.get(obj, "binding_id"), `${path}.binding_id`),
    source: assertString(Reflect.get(obj, "source"), `${path}.source`, true),
    acquisition: parseSourceAcquisition(Reflect.get(obj, "acquisition"), `${path}.acquisition`),
    adapter_id: assertString(Reflect.get(obj, "adapter_id"), `${path}.adapter_id`, true),
    accession: assertStringOrNull(Reflect.get(obj, "accession"), `${path}.accession`),
    parameters: Reflect.get(obj, "parameters") === undefined
      ? {}
      : assertJsonRecord(Reflect.get(obj, "parameters"), `${path}.parameters`),
  };
}

export function parseDatasetBuildSpec(value: unknown, path = "build.spec"): DatasetBuildSpec {
  const obj = assertObject(value, path);
  exactKeys(obj, [
    "schema_version",
    "build_id",
    "objective",
    "dataset_family",
    "row_granularity",
    "entities",
    "cohort_filters",
    "required_fields",
    "schema_ref",
    "source_bindings",
    "normalization_profile_ref",
    "merge_strategy",
    "validation_profile_ref",
    "output_format",
    "target_entity_level",
  ], path);
  if (Reflect.get(obj, "schema_version") !== undefined && Reflect.get(obj, "schema_version") !== "1.0") {
    throw new APIError(502, `Expected "1.0" or absent at ${path}.schema_version`);
  }
  const sourceBindings = assertArray(
    Reflect.get(obj, "source_bindings"),
    `${path}.source_bindings`,
    (entry, index) => parseSourceBinding(entry, `${path}.source_bindings[${index}]`),
  );
  if (sourceBindings.length === 0) {
    throw new APIError(502, `Expected non-empty array at ${path}.source_bindings`);
  }
  return {
    schema_version: Reflect.get(obj, "schema_version") === "1.0" ? "1.0" : undefined,
    build_id: assertSafeId(Reflect.get(obj, "build_id"), `${path}.build_id`),
    objective: assertString(Reflect.get(obj, "objective"), `${path}.objective`, true),
    dataset_family: assertString(Reflect.get(obj, "dataset_family"), `${path}.dataset_family`, true),
    row_granularity: assertString(Reflect.get(obj, "row_granularity"), `${path}.row_granularity`, true),
    entities: Reflect.get(obj, "entities") === undefined
      ? {}
      : parseStringArrayMap(Reflect.get(obj, "entities"), `${path}.entities`),
    cohort_filters: Reflect.get(obj, "cohort_filters") === undefined
      ? {}
      : parseStringArrayMap(Reflect.get(obj, "cohort_filters"), `${path}.cohort_filters`),
    required_fields: Reflect.get(obj, "required_fields") === undefined
      ? []
      : assertArray(Reflect.get(obj, "required_fields"), `${path}.required_fields`, (entry, index) =>
        assertString(entry, `${path}.required_fields[${index}]`, true)),
    schema_ref: assertString(Reflect.get(obj, "schema_ref"), `${path}.schema_ref`, true),
    source_bindings: sourceBindings,
    normalization_profile_ref: assertStringOrNull(
      Reflect.get(obj, "normalization_profile_ref"),
      `${path}.normalization_profile_ref`,
    ),
    merge_strategy: Reflect.get(obj, "merge_strategy") === undefined
      ? "append_by_canonical_row"
      : assertString(Reflect.get(obj, "merge_strategy"), `${path}.merge_strategy`, true),
    validation_profile_ref: assertString(
      Reflect.get(obj, "validation_profile_ref"),
      `${path}.validation_profile_ref`,
      true,
    ),
    output_format: Reflect.get(obj, "output_format") === undefined
      ? "csv"
      : assertString(Reflect.get(obj, "output_format"), `${path}.output_format`, true),
    target_entity_level: assertStringOrNull(
      Reflect.get(obj, "target_entity_level"),
      `${path}.target_entity_level`,
    ),
  };
}

export function assertDurableBuildStatus(value: unknown, path: string): DurableBuildStatus {
  return assertLiteral(value, path, DURABLE_BUILD_STATUSES);
}

export function assertDurableBuildTransition(
  from: DurableBuildStatus,
  to: DurableBuildStatus,
): void {
  if (!canTransitionDurableBuildStatus(from, to)) {
    throw new APIError(502, `Invalid durable Build transition ${from} -> ${to}`);
  }
}

export function parseDurableBuildFailure(value: unknown, path: string): DurableBuildFailure {
  const obj = assertObject(value, path);
  exactKeys(obj, ["schema_version", "code", "message", "retryable", "details"], path);
  return {
    schema_version: parseSchemaVersion(obj, path),
    code: assertLiteral(Reflect.get(obj, "code"), `${path}.code`, FAILURE_CODES),
    message: assertString(Reflect.get(obj, "message"), `${path}.message`, true),
    retryable: assertBoolean(Reflect.get(obj, "retryable"), `${path}.retryable`),
    details: assertJsonRecord(Reflect.get(obj, "details"), `${path}.details`),
  };
}

export function parseDurableBuildLease(value: unknown, path: string): DurableBuildLease {
  const obj = assertObject(value, path);
  exactKeys(obj, ["schema_version", "lease_id", "owner_id", "attempt", "acquired_at", "expires_at"], path);
  const acquiredAt = assertIsoDateTime(Reflect.get(obj, "acquired_at"), `${path}.acquired_at`);
  const expiresAt = assertIsoDateTime(Reflect.get(obj, "expires_at"), `${path}.expires_at`);
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    throw new APIError(502, `${path}.expires_at must be later than acquired_at`);
  }
  return {
    schema_version: parseSchemaVersion(obj, path),
    lease_id: assertSafeId(Reflect.get(obj, "lease_id"), `${path}.lease_id`),
    owner_id: assertSafeId(Reflect.get(obj, "owner_id"), `${path}.owner_id`),
    attempt: assertPositiveInt(Reflect.get(obj, "attempt"), `${path}.attempt`),
    acquired_at: acquiredAt,
    expires_at: expiresAt,
  };
}

export function parseDurableBuildEventRef(value: unknown, path: string): DurableBuildEventRef {
  const obj = assertObject(value, path);
  exactKeys(obj, [
    "schema_version",
    "event_id",
    "type",
    "task_id",
    "run_id",
    "build_id",
    "sequence",
    "timestamp",
  ], path);
  return {
    schema_version: parseSchemaVersion(obj, path),
    event_id: assertSafeId(Reflect.get(obj, "event_id"), `${path}.event_id`),
    type: assertLiteral(Reflect.get(obj, "type"), `${path}.type`, BUILD_EVENT_TYPES),
    task_id: assertSafeId(Reflect.get(obj, "task_id"), `${path}.task_id`),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), `${path}.run_id`),
    build_id: assertSafeId(Reflect.get(obj, "build_id"), `${path}.build_id`),
    sequence: assertPositiveInt(Reflect.get(obj, "sequence"), `${path}.sequence`),
    timestamp: assertIsoDateTime(Reflect.get(obj, "timestamp"), `${path}.timestamp`),
  };
}

function parseEventRefs(value: unknown, path: string): DurableBuildEventRefs {
  const obj = assertObject(value, path);
  exactKeys(obj, ["schema_version", "queued", "latest", "terminal"], path);
  return {
    schema_version: parseSchemaVersion(obj, path),
    queued: parseDurableBuildEventRef(Reflect.get(obj, "queued"), `${path}.queued`),
    latest: parseDurableBuildEventRef(Reflect.get(obj, "latest"), `${path}.latest`),
    terminal: assertOptionalNull(Reflect.get(obj, "terminal"), `${path}.terminal`, parseDurableBuildEventRef),
  };
}

function parseCancellation(value: unknown, path: string): DurableBuildCancellation {
  const obj = assertObject(value, path);
  exactKeys(obj, ["schema_version", "request_id", "reason", "requested_at", "event_ref"], path);
  return {
    schema_version: parseSchemaVersion(obj, path),
    request_id: assertSafeId(Reflect.get(obj, "request_id"), `${path}.request_id`),
    reason: assertStringOrNull(Reflect.get(obj, "reason"), `${path}.reason`),
    requested_at: assertIsoDateTime(Reflect.get(obj, "requested_at"), `${path}.requested_at`),
    event_ref: parseDurableBuildEventRef(Reflect.get(obj, "event_ref"), `${path}.event_ref`),
  };
}

function requireMatchingEventIdentity(
  reference: DurableBuildEventRef,
  record: Pick<DurableBuildRecord, "task_id" | "run_id" | "build_id">,
  path: string,
): void {
  if (
    reference.task_id !== record.task_id ||
    reference.run_id !== record.run_id ||
    reference.build_id !== record.build_id
  ) {
    throw new APIError(502, `${path} does not match durable Build identity`);
  }
}

export function parseDurableBuildRecord(value: unknown, path = "build"): DurableBuildRecord {
  const obj = assertObject(value, path);
  exactKeys(obj, [
    "schema_version",
    "task_id",
    "run_id",
    "build_id",
    "idempotency_key",
    "request_digest",
    "spec",
    "status",
    "attempt",
    "lease",
    "cancellation",
    "terminal_result",
    "failure",
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
    "event_refs",
  ], path);
  const spec = parseDatasetBuildSpec(Reflect.get(obj, "spec"), `${path}.spec`);
  const status = assertDurableBuildStatus(Reflect.get(obj, "status"), `${path}.status`);
  const record: DurableBuildRecord = {
    schema_version: parseSchemaVersion(obj, path),
    task_id: assertSafeId(Reflect.get(obj, "task_id"), `${path}.task_id`),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), `${path}.run_id`),
    build_id: assertSafeId(Reflect.get(obj, "build_id"), `${path}.build_id`),
    idempotency_key: assertSafeId(Reflect.get(obj, "idempotency_key"), `${path}.idempotency_key`),
    request_digest: assertHex64(Reflect.get(obj, "request_digest"), `${path}.request_digest`),
    spec,
    status,
    attempt: assertNonNegativeInt(Reflect.get(obj, "attempt"), `${path}.attempt`),
    lease: assertOptionalNull(Reflect.get(obj, "lease"), `${path}.lease`, parseDurableBuildLease),
    cancellation: assertOptionalNull(Reflect.get(obj, "cancellation"), `${path}.cancellation`, parseCancellation),
    terminal_result: assertOptionalNull(
      Reflect.get(obj, "terminal_result"),
      `${path}.terminal_result`,
      parseBuildResult,
    ),
    failure: assertOptionalNull(Reflect.get(obj, "failure"), `${path}.failure`, parseDurableBuildFailure),
    created_at: assertIsoDateTime(Reflect.get(obj, "created_at"), `${path}.created_at`),
    updated_at: assertIsoDateTime(Reflect.get(obj, "updated_at"), `${path}.updated_at`),
    started_at: assertOptionalNull(Reflect.get(obj, "started_at"), `${path}.started_at`, assertIsoDateTime),
    finished_at: assertOptionalNull(Reflect.get(obj, "finished_at"), `${path}.finished_at`, assertIsoDateTime),
    event_refs: parseEventRefs(Reflect.get(obj, "event_refs"), `${path}.event_refs`),
  };
  if (record.spec.build_id !== record.build_id) {
    throw new APIError(502, `${path}.spec.build_id must match ${path}.build_id`);
  }
  if ((record.attempt === 0) !== (record.started_at === null)) {
    throw new APIError(502, `${path}.attempt and started_at are inconsistent`);
  }
  if (record.lease !== null && record.lease.attempt !== record.attempt) {
    throw new APIError(502, `${path}.lease.attempt must match ${path}.attempt`);
  }
  if (record.status === "running" && record.lease === null) {
    throw new APIError(502, `${path}.running requires an active lease`);
  }
  if (record.status !== "running" && record.lease !== null && record.status !== "cancel_requested") {
    throw new APIError(502, `${path}.${record.status} cannot carry an active lease`);
  }
  if (record.cancellation === null && record.status === "cancel_requested") {
    throw new APIError(502, `${path}.cancel_requested requires cancellation metadata`);
  }
  const terminal = isDurableBuildTerminalStatus(record.status);
  if (terminal !== (record.finished_at !== null) || terminal !== (record.event_refs.terminal !== null)) {
    throw new APIError(502, `${path} terminal timestamps/event refs do not match status`);
  }
  const businessTerminal = ["succeeded", "partial_success", "no_data", "spec_rejected"].includes(record.status);
  if (businessTerminal) {
    if (record.terminal_result === null || record.terminal_result.status !== record.status || record.failure !== null) {
      throw new APIError(502, `${path}.${record.status} requires the matching terminal_result only`);
    }
    if (record.terminal_result.build_id !== null && record.terminal_result.build_id !== record.build_id) {
      throw new APIError(502, `${path}.terminal_result.build_id must match ${path}.build_id`);
    }
  } else if (record.terminal_result !== null) {
    throw new APIError(502, `${path}.${record.status} cannot carry terminal_result`);
  }
  if ((record.status === "failed") !== (record.failure !== null)) {
    throw new APIError(502, `${path}.failure must exist exactly for failed status`);
  }
  if (record.status === "cancelled" && record.cancellation === null) {
    throw new APIError(502, `${path}.cancelled requires cancellation metadata`);
  }
  if (!terminal && record.failure !== null) {
    throw new APIError(502, `${path} nonterminal status cannot carry failure`);
  }
  requireMatchingEventIdentity(record.event_refs.queued, record, `${path}.event_refs.queued`);
  requireMatchingEventIdentity(record.event_refs.latest, record, `${path}.event_refs.latest`);
  if (record.event_refs.queued.type !== "build_queued") {
    throw new APIError(502, `${path}.event_refs.queued must reference build_queued`);
  }
  if (record.event_refs.terminal !== null) {
    requireMatchingEventIdentity(record.event_refs.terminal, record, `${path}.event_refs.terminal`);
    const expectedTerminalEvent = record.status === "failed"
      ? "build_failed"
      : record.status === "cancelled"
        ? "build_cancelled"
        : "build_completed";
    if (record.event_refs.terminal.type !== expectedTerminalEvent) {
      throw new APIError(502, `${path}.event_refs.terminal does not match ${record.status} status`);
    }
    if (record.event_refs.latest.event_id !== record.event_refs.terminal.event_id) {
      throw new APIError(502, `${path}.event_refs.latest must equal the terminal event`);
    }
  } else {
    const expectedLatestTypes: readonly DurableBuildEventType[] = record.status === "queued"
      ? ["build_queued"]
      : record.status === "running"
        ? ["build_started", "build_recovered"]
        : ["build_cancel_requested"];
    if (!expectedLatestTypes.includes(record.event_refs.latest.type)) {
      throw new APIError(502, `${path}.event_refs.latest does not match ${record.status} status`);
    }
  }
  if (record.event_refs.latest.sequence < record.event_refs.queued.sequence) {
    throw new APIError(502, `${path}.event_refs.latest sequence precedes queued event`);
  }
  if (record.cancellation !== null) {
    requireMatchingEventIdentity(record.cancellation.event_ref, record, `${path}.cancellation.event_ref`);
    if (record.cancellation.event_ref.type !== "build_cancel_requested") {
      throw new APIError(502, `${path}.cancellation.event_ref must reference build_cancel_requested`);
    }
  }
  return record;
}

export function parseStartDatasetBuildRequest(value: unknown): StartDatasetBuildRequest {
  const obj = assertObject(value, "start build request");
  exactKeys(obj, ["schema_version", "idempotency_key", "task_id", "run_id", "spec"], "start build request");
  return {
    schema_version: parseSchemaVersion(obj, "start build request"),
    idempotency_key: assertSafeId(Reflect.get(obj, "idempotency_key"), "start build request.idempotency_key"),
    task_id: assertSafeId(Reflect.get(obj, "task_id"), "start build request.task_id"),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), "start build request.run_id"),
    spec: parseDatasetBuildSpec(Reflect.get(obj, "spec"), "start build request.spec"),
  };
}

export function matchesDurableBuildStart(
  existing: DurableBuildRecord,
  request: StartDatasetBuildRequest,
  requestDigest: string,
): boolean {
  return existing.idempotency_key === request.idempotency_key &&
    existing.task_id === request.task_id &&
    existing.run_id === request.run_id &&
    existing.build_id === request.spec.build_id &&
    existing.request_digest === requestDigest;
}

export function parseStartDatasetBuildResponse(value: unknown): StartDatasetBuildResponse {
  const obj = assertObject(value, "start build response");
  exactKeys(obj, ["schema_version", "idempotent_replay", "build"], "start build response");
  return {
    schema_version: parseSchemaVersion(obj, "start build response"),
    idempotent_replay: assertBoolean(Reflect.get(obj, "idempotent_replay"), "start build response.idempotent_replay"),
    build: parseDurableBuildRecord(Reflect.get(obj, "build"), "start build response.build"),
  };
}

export function parseGetDatasetBuildResponse(value: unknown): GetDatasetBuildResponse {
  const obj = assertObject(value, "get build response");
  exactKeys(obj, ["schema_version", "build"], "get build response");
  return {
    schema_version: parseSchemaVersion(obj, "get build response"),
    build: parseDurableBuildRecord(Reflect.get(obj, "build"), "get build response.build"),
  };
}

export function parseCancelDatasetBuildRequest(value: unknown): CancelDatasetBuildRequest {
  const obj = assertObject(value, "cancel build request");
  exactKeys(obj, ["schema_version", "request_id", "task_id", "run_id", "reason"], "cancel build request");
  return {
    schema_version: parseSchemaVersion(obj, "cancel build request"),
    request_id: assertSafeId(Reflect.get(obj, "request_id"), "cancel build request.request_id"),
    task_id: assertSafeId(Reflect.get(obj, "task_id"), "cancel build request.task_id"),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), "cancel build request.run_id"),
    reason: assertStringOrNull(Reflect.get(obj, "reason"), "cancel build request.reason"),
  };
}

export function parseCancelDatasetBuildResponse(value: unknown): CancelDatasetBuildResponse {
  const obj = assertObject(value, "cancel build response");
  exactKeys(obj, [
    "schema_version",
    "request_id",
    "task_id",
    "run_id",
    "build_id",
    "disposition",
    "status",
    "terminal",
    "cancel_requested_event",
    "terminal_event",
  ], "cancel build response");
  const status = assertDurableBuildStatus(Reflect.get(obj, "status"), "cancel build response.status");
  const terminal = assertBoolean(Reflect.get(obj, "terminal"), "cancel build response.terminal");
  if (terminal !== isDurableBuildTerminalStatus(status)) {
    throw new APIError(502, "cancel build response.terminal does not match status");
  }
  const response: CancelDatasetBuildResponse = {
    schema_version: parseSchemaVersion(obj, "cancel build response"),
    request_id: assertSafeId(Reflect.get(obj, "request_id"), "cancel build response.request_id"),
    task_id: assertSafeId(Reflect.get(obj, "task_id"), "cancel build response.task_id"),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), "cancel build response.run_id"),
    build_id: assertSafeId(Reflect.get(obj, "build_id"), "cancel build response.build_id"),
    disposition: assertLiteral(
      Reflect.get(obj, "disposition"),
      "cancel build response.disposition",
      CANCEL_DISPOSITIONS,
    ),
    status,
    terminal,
    cancel_requested_event: assertOptionalNull(
      Reflect.get(obj, "cancel_requested_event"),
      "cancel build response.cancel_requested_event",
      parseDurableBuildEventRef,
    ),
    terminal_event: assertOptionalNull(
      Reflect.get(obj, "terminal_event"),
      "cancel build response.terminal_event",
      parseDurableBuildEventRef,
    ),
  };
  if ((response.terminal_event !== null) !== terminal) {
    throw new APIError(502, "cancel build response.terminal_event does not match terminal");
  }
  if (response.disposition === "already_terminal") {
    if (!terminal) {
      throw new APIError(502, "cancel build response.already_terminal requires terminal status");
    }
  } else if (
    terminal ||
    response.status !== "cancel_requested" ||
    response.cancel_requested_event === null
  ) {
    throw new APIError(502, `cancel build response.${response.disposition} requires cancel_requested status/event`);
  }
  for (const [name, reference] of [
    ["cancel_requested_event", response.cancel_requested_event],
    ["terminal_event", response.terminal_event],
  ] as const) {
    if (reference !== null && (
      reference.task_id !== response.task_id ||
      reference.run_id !== response.run_id ||
      reference.build_id !== response.build_id
    )) {
      throw new APIError(502, `cancel build response.${name} does not match Build identity`);
    }
  }
  return response;
}

export function parseDurableBuildApiError(value: unknown): DurableBuildApiError {
  const obj = assertObject(value, "durable build error");
  exactKeys(obj, [
    "schema_version",
    "code",
    "message",
    "retryable",
    "task_id",
    "run_id",
    "build_id",
    "current_status",
    "details",
  ], "durable build error");
  return {
    schema_version: parseSchemaVersion(obj, "durable build error"),
    code: assertLiteral(Reflect.get(obj, "code"), "durable build error.code", API_ERROR_CODES),
    message: assertString(Reflect.get(obj, "message"), "durable build error.message", true),
    retryable: assertBoolean(Reflect.get(obj, "retryable"), "durable build error.retryable"),
    task_id: assertOptionalNull(Reflect.get(obj, "task_id"), "durable build error.task_id", assertSafeId),
    run_id: assertOptionalNull(Reflect.get(obj, "run_id"), "durable build error.run_id", assertSafeId),
    build_id: assertOptionalNull(Reflect.get(obj, "build_id"), "durable build error.build_id", assertSafeId),
    current_status: assertOptionalNull(
      Reflect.get(obj, "current_status"),
      "durable build error.current_status",
      assertDurableBuildStatus,
    ),
    details: assertJsonRecord(Reflect.get(obj, "details"), "durable build error.details"),
  };
}

export function parseDurableBuildEventEnvelope(value: unknown): DurableBuildEventEnvelope {
  const obj = assertObject(value, "durable build event");
  exactKeys(obj, [
    "schema_version",
    "event_id",
    "type",
    "task_id",
    "run_id",
    "build_id",
    "stage_attempt_id",
    "sequence",
    "timestamp",
    "payload",
  ], "durable build event");
  if (Reflect.get(obj, "schema_version") !== "2.0") {
    throw new APIError(502, "Expected \"2.0\" at durable build event.schema_version");
  }
  const type = assertLiteral(Reflect.get(obj, "type"), "durable build event.type", BUILD_EVENT_TYPES);
  const payload = parseDurableBuildEventPayload(Reflect.get(obj, "payload"));
  if (payload.type !== type) {
    throw new APIError(502, "durable build event.type must match payload.type");
  }
  if (Reflect.get(obj, "stage_attempt_id") !== null) {
    throw new APIError(502, "durable build event.stage_attempt_id must be null");
  }
  return {
    schema_version: "2.0",
    event_id: assertSafeId(Reflect.get(obj, "event_id"), "durable build event.event_id"),
    type,
    task_id: assertSafeId(Reflect.get(obj, "task_id"), "durable build event.task_id"),
    run_id: assertSafeId(Reflect.get(obj, "run_id"), "durable build event.run_id"),
    build_id: assertSafeId(Reflect.get(obj, "build_id"), "durable build event.build_id"),
    stage_attempt_id: null,
    sequence: assertPositiveInt(Reflect.get(obj, "sequence"), "durable build event.sequence"),
    timestamp: assertIsoDateTime(Reflect.get(obj, "timestamp"), "durable build event.timestamp"),
    payload,
  };
}

export function parseDurableBuildEventPayload(value: unknown): DurableBuildEventPayload {
  const obj = assertObject(value, "durable build event payload");
  const type = assertLiteral(Reflect.get(obj, "type"), "durable build event payload.type", BUILD_EVENT_TYPES);
  switch (type) {
    case "build_queued":
      exactKeys(obj, ["type", "idempotency_key", "request_digest"], "durable build event payload");
      return {
        type,
        idempotency_key: assertSafeId(Reflect.get(obj, "idempotency_key"), "durable build event payload.idempotency_key"),
        request_digest: assertHex64(Reflect.get(obj, "request_digest"), "durable build event payload.request_digest"),
      };
    case "build_started":
      exactKeys(obj, ["type", "attempt", "lease_id"], "durable build event payload");
      return {
        type,
        attempt: assertPositiveInt(Reflect.get(obj, "attempt"), "durable build event payload.attempt"),
        lease_id: assertSafeId(Reflect.get(obj, "lease_id"), "durable build event payload.lease_id"),
      };
    case "build_recovered":
      exactKeys(obj, ["type", "attempt", "previous_lease_id", "lease_id"], "durable build event payload");
      return {
        type,
        attempt: assertPositiveInt(Reflect.get(obj, "attempt"), "durable build event payload.attempt"),
        previous_lease_id: assertSafeId(Reflect.get(obj, "previous_lease_id"), "durable build event payload.previous_lease_id"),
        lease_id: assertSafeId(Reflect.get(obj, "lease_id"), "durable build event payload.lease_id"),
      };
    case "build_cancel_requested":
      exactKeys(obj, ["type", "request_id", "reason"], "durable build event payload");
      return {
        type,
        request_id: assertSafeId(Reflect.get(obj, "request_id"), "durable build event payload.request_id"),
        reason: assertStringOrNull(Reflect.get(obj, "reason"), "durable build event payload.reason"),
      };
    case "build_completed":
      exactKeys(obj, ["type", "result"], "durable build event payload");
      return { type, result: parseBuildResult(Reflect.get(obj, "result"), "durable build event payload.result") };
    case "build_failed":
      exactKeys(obj, ["type", "failure"], "durable build event payload");
      return { type, failure: parseDurableBuildFailure(Reflect.get(obj, "failure"), "durable build event payload.failure") };
    case "build_cancelled":
      exactKeys(obj, ["type", "request_id", "reason"], "durable build event payload");
      return {
        type,
        request_id: assertSafeId(Reflect.get(obj, "request_id"), "durable build event payload.request_id"),
        reason: assertStringOrNull(Reflect.get(obj, "reason"), "durable build event payload.reason"),
      };
  }
}
