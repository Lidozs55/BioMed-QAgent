import type { BuildResult, DatasetBuildSpec } from "./dataset-build.js";
import type { JsonValue } from "./json.js";

export type DurableBuildStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "partial_success"
  | "no_data"
  | "spec_rejected"
  | "failed"
  | "cancelled";

export type DurableBuildTerminalStatus = Extract<
  DurableBuildStatus,
  | "succeeded"
  | "partial_success"
  | "no_data"
  | "spec_rejected"
  | "failed"
  | "cancelled"
>;

export type DurableBuildBusinessTerminalStatus = BuildResult["status"];

export const DURABLE_BUILD_STATUSES: readonly DurableBuildStatus[] = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "partial_success",
  "no_data",
  "spec_rejected",
  "failed",
  "cancelled",
];

export const DURABLE_BUILD_TERMINAL_STATUSES: readonly DurableBuildTerminalStatus[] = [
  "succeeded",
  "partial_success",
  "no_data",
  "spec_rejected",
  "failed",
  "cancelled",
];

/** Exact lifecycle edges. Lease recovery does not change Build status. */
export const DURABLE_BUILD_TRANSITIONS: Readonly<
  Record<DurableBuildStatus, readonly DurableBuildStatus[]>
> = {
  queued: ["running", "cancel_requested", "spec_rejected", "failed"],
  running: [
    "cancel_requested",
    "succeeded",
    "partial_success",
    "no_data",
    "spec_rejected",
    "failed",
  ],
  cancel_requested: ["cancelled", "failed"],
  succeeded: [],
  partial_success: [],
  no_data: [],
  spec_rejected: [],
  failed: [],
  cancelled: [],
};

export function isDurableBuildTerminalStatus(
  status: DurableBuildStatus,
): status is DurableBuildTerminalStatus {
  return DURABLE_BUILD_TERMINAL_STATUSES.includes(status as DurableBuildTerminalStatus);
}

export function canTransitionDurableBuildStatus(
  from: DurableBuildStatus,
  to: DurableBuildStatus,
): boolean {
  return DURABLE_BUILD_TRANSITIONS[from].includes(to);
}

export interface StartDatasetBuildRequest {
  schema_version: "1.0";
  idempotency_key: string;
  task_id: string;
  run_id: string;
  spec: DatasetBuildSpec;
}

export interface StartDatasetBuildResponse {
  schema_version: "1.0";
  idempotent_replay: boolean;
  build: DurableBuildRecord;
}

export interface GetDatasetBuildResponse {
  schema_version: "1.0";
  build: DurableBuildRecord;
}

export interface CancelDatasetBuildRequest {
  schema_version: "1.0";
  request_id: string;
  task_id: string;
  run_id: string;
  reason: string | null;
}

export type DurableBuildCancelDisposition =
  | "accepted"
  | "already_requested"
  | "already_terminal";

export interface CancelDatasetBuildResponse {
  schema_version: "1.0";
  request_id: string;
  task_id: string;
  run_id: string;
  build_id: string;
  disposition: DurableBuildCancelDisposition;
  status: DurableBuildStatus;
  terminal: boolean;
  cancel_requested_event: DurableBuildEventRef | null;
  terminal_event: DurableBuildEventRef | null;
}

export type DurableBuildApiErrorCode =
  | "build_not_found"
  | "invalid_build_request"
  | "idempotency_key_reused"
  | "build_identity_mismatch"
  | "build_not_cancellable"
  | "invalid_build_transition";

export interface DurableBuildApiError {
  schema_version: "1.0";
  code: DurableBuildApiErrorCode;
  message: string;
  retryable: boolean;
  task_id: string | null;
  run_id: string | null;
  build_id: string | null;
  current_status: DurableBuildStatus | null;
  details: Record<string, JsonValue>;
}

export type DurableBuildFailureCode =
  | "core_execution_error"
  | "lease_lost"
  | "recovery_exhausted"
  | "cancellation_failed"
  | "internal_error";

export interface DurableBuildFailure {
  schema_version: "1.0";
  code: DurableBuildFailureCode;
  message: string;
  retryable: boolean;
  details: Record<string, JsonValue>;
}

export interface DurableBuildLease {
  schema_version: "1.0";
  lease_id: string;
  owner_id: string;
  attempt: number;
  acquired_at: string;
  expires_at: string;
}

export type DurableBuildEventType =
  | "build_queued"
  | "build_started"
  | "build_recovered"
  | "build_cancel_requested"
  | "build_completed"
  | "build_failed"
  | "build_cancelled";

export interface DurableBuildEventRef {
  schema_version: "1.0";
  event_id: string;
  type: DurableBuildEventType;
  task_id: string;
  run_id: string;
  build_id: string;
  sequence: number;
  timestamp: string;
}

export interface DurableBuildEventRefs {
  schema_version: "1.0";
  queued: DurableBuildEventRef;
  latest: DurableBuildEventRef;
  terminal: DurableBuildEventRef | null;
}

export interface DurableBuildCancellation {
  schema_version: "1.0";
  request_id: string;
  reason: string | null;
  requested_at: string;
  event_ref: DurableBuildEventRef;
}

export interface DurableBuildRecord {
  schema_version: "1.0";
  task_id: string;
  run_id: string;
  build_id: string;
  idempotency_key: string;
  request_digest: string;
  spec: DatasetBuildSpec;
  status: DurableBuildStatus;
  attempt: number;
  lease: DurableBuildLease | null;
  cancellation: DurableBuildCancellation | null;
  terminal_result: BuildResult | null;
  failure: DurableBuildFailure | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  event_refs: DurableBuildEventRefs;
}

export interface DurableBuildEventEnvelope {
  schema_version: "2.0";
  event_id: string;
  type: DurableBuildEventType;
  task_id: string;
  run_id: string;
  build_id: string;
  stage_attempt_id: null;
  sequence: number;
  timestamp: string;
  payload: DurableBuildEventPayload;
}

export type DurableBuildEventPayload =
  | {
      type: "build_queued";
      idempotency_key: string;
      request_digest: string;
    }
  | {
      type: "build_started";
      attempt: number;
      lease_id: string;
    }
  | {
      type: "build_recovered";
      attempt: number;
      previous_lease_id: string;
      lease_id: string;
    }
  | {
      type: "build_cancel_requested";
      request_id: string;
      reason: string | null;
    }
  | {
      type: "build_completed";
      result: BuildResult;
    }
  | {
      type: "build_failed";
      failure: DurableBuildFailure;
    }
  | {
      type: "build_cancelled";
      request_id: string;
      reason: string | null;
    };
