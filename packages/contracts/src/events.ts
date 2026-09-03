import type { ArtifactManifestEntry } from "./artifacts.js";
import type { JsonValue } from "./json.js";
import type { HILDecision, HILRequest } from "./hil.js";
import type {
  StageName,
  SubagentPromptKind,
  SubagentRequest,
  SubagentResult,
} from "./task-run.js";
import type { TaskExecutionContext } from "./task-execution-context.js";

export interface ErrorDetail {
  schema_version?: "1.0";
  code: string;
  message: string;
  retryable: boolean;
  stage: StageName | null;
  details: Record<string, JsonValue>;
}

export interface WarningRecord {
  schema_version?: "1.0";
  warning_id: string;
  severity: "info" | "warning" | "error";
  stage: StageName;
  code: string;
  message: string;
  source_id: string | null;
  asset_id: string | null;
  record_id: string | null;
  created_at: string;
}

export type UserInputPromptKind =
  | "plan_confirmation"
  | "data_correction"
  | "max_turns_reached"
  | "no_progress"
  | "api_key_or_credential";

export type UserInputDecision = "approve" | "reject";

export type PermissionCapability =
  | "fs.read"
  | "fs.write"
  | "fs.edit"
  | "process.exec";

export type PermissionScope =
  | "workspace"
  | "task_output"
  | "framework_internal"
  | "sensitive"
  | "project"
  | "external";

export type PermissionGrantScope =
  | "once"
  | "run"
  | "task"
  | "persistent";

export type PermissionDecision = "allow" | "deny";

export type AssistantDeltaPayload =
  | {
      type: "assistant_delta";
      delta: string;
      stream_id?: undefined;
      from_chunk_index?: undefined;
      through_chunk_index?: undefined;
    }
  | {
      type: "assistant_delta";
      delta: string;
      stream_id: null;
      from_chunk_index: null;
      through_chunk_index: null;
    }
  | {
      type: "assistant_delta";
      delta: string;
      stream_id: string;
      from_chunk_index: number;
      through_chunk_index: number;
    };

export type AssistantReasoningDeltaPayload = {
  type: "assistant_reasoning_delta";
  delta: string;
};

/** Provider-reported token usage for the model call that just completed. */
export interface ModelCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  /** Subset of output_tokens; present only when the provider reports the split. */
  reasoning_tokens?: number;
}

export type ContextUsagePayload = {
  type: "context_usage";
  /** Runtime-reported context tokens; null means Pi has no trustworthy value yet. */
  tokens: number | null;
  context_window: number;
  percent: number | null;
  source: "runtime";
  /** Exact provider usage of the triggering call; absent when upstream reported none. */
  usage?: ModelCallUsage;
};

/** One web-search hit reported by a provider-side search (Bailian 联网搜索). */
export interface ProviderSearchResult {
  site_name: string;
  url: string;
  title?: string;
  icon?: string;
}

export type ProviderSearchInfoPayload = {
  type: "provider_search_info";
  /**
   * Bounded results captured from one model call's provider-side search
   * (≤20 entries, fields ≤200 chars). Display metadata only — never
   * formal evidence.
   */
  results: ProviderSearchResult[];
};

export type EventPayload =
  | { type: "task_created"; topic: string }
  | { type: "plan_ready"; specification: Record<string, JsonValue> }
  | {
      type: "user_input_required";
      request_id: string;
      prompt_kind: UserInputPromptKind;
      summary: string;
      expires_at: string | null;
      fixture_exempt: boolean;
      detail: Record<string, JsonValue>;
      hil_request?: HILRequest | null;
    }
  | {
      type: "user_input_resumed";
      request_id: string;
      decision: HILDecision | UserInputDecision;
      detail: Record<string, JsonValue>;
    }
  | { type: "stage_started"; stage: StageName; attempt: number }
  | {
      type: "stage_completed";
      stage: StageName;
      status: "succeeded";
      output_digest: string;
    }
  | {
      type: "stage_failed";
      stage: StageName;
      status: "failed";
      error: ErrorDetail;
    }
  | {
      type: "stage_skipped";
      stage: StageName;
      status: "skipped";
      reason: string;
      reused_stage_attempt_id: string | null;
    }
  | {
      type: "stage_progress";
      stage: StageName;
      kind: string;
      current: number;
      total: number | null;
      detail: Record<string, JsonValue>;
    }
  | {
      type: "tool_called";
      tool_name: string;
      arguments_digest: string;
      arguments?: Record<string, JsonValue> | null;
    }
  | {
      type: "tool_completed";
      tool_name: string;
      output_digest?: string | null;
      tool_call_id?: string | null;
      output?: string | null;
      is_error: boolean;
    }
  | {
      type: "warning";
      warning?: WarningRecord | null;
      message?: string | null;
      code?: string | null;
    }
  | { type: "artifact_produced"; artifact: ArtifactManifestEntry }
  | { type: "task_cancel_requested"; reason: string | null }
  | { type: "task_cancelled"; reason: string }
  | { type: "task_recovered"; recovered_from_sequence: number }
  | {
      type: "task_completed";
      validation: {
        schema_version?: "1.0";
        status: "valid" | "invalid";
        checked_count: number;
        failed_count: number;
        report_path: string;
      };
    }
  | { type: "task_failed"; error: ErrorDetail }
  | {
      type: "run_queued";
      request_id: string;
      input: string;
      /** Frozen evaluation contract the run was admitted under; absent/null on events persisted before the field existed. */
      execution_context?: TaskExecutionContext | null;
    }
  | { type: "run_steered"; input: string }
  | { type: "run_started" }
  | { type: "run_finalizing" }
  | { type: "run_completed" }
  | {
      type: "run_failed";
      error: string;
      error_code?: import("./task-run.js").ErrorCode | null;
    }
  | { type: "run_cancel_requested"; reason: string | null }
  | {
      type: "run_cancelled";
      reason: string | null;
      cancelled_at_stage?: StageName | null;
    }
  | { type: "run_interrupted"; reason: string }
  | {
      type: "publication_created";
      publication_id: string;
      run_id: string;
      manifest_sha256: string;
      supersedes_publication_id: string | null;
      published_at: string;
    }
  | AssistantDeltaPayload
  | AssistantReasoningDeltaPayload
  | ContextUsagePayload
  | ProviderSearchInfoPayload
  | {
      type: "tool_started";
      tool_call_id: string;
      tool_name: string;
      arguments?: Record<string, JsonValue> | null;
    }
  | {
      type: "conversation_compacted";
      compaction_id: string;
      covered_through_run_id: string;
      summary_digest: string;
      reason?: "manual" | "threshold" | "overflow";
      tokens_before?: number;
      estimated_tokens_after?: number;
      target_tokens?: number;
      summary_tokens?: number;
    }
  | {
      type: "conversation_compaction_started";
      compaction_id: string;
      covered_through_run_id: string;
    }
  | {
      type: "conversation_compaction_failed";
      compaction_id: string;
      covered_through_run_id: string;
      reason: "no_content" | "error";
      message?: string | null;
    }
  // V2 build-execution lifecycle (Design §15.1). Informational: the reducer
  // advances the cursor without changing state.
  | {
      type: "operation_started";
      operation_id: string;
      label?: string;
      category?: string;
      attempt?: number;
    }
  | {
      type: "operation_progress";
      operation_id: string;
      kind: string;
      current: number;
      total?: number | null;
      detail?: Record<string, JsonValue>;
    }
  | {
      type: "operation_completed";
      operation_id: string;
      status?: "succeeded" | "skipped";
      output_digest?: string;
      reused_operation_attempt_id?: string | null;
    }
  | {
      type: "operation_failed";
      operation_id: string;
      status?: "failed" | "cancelled";
      error?: ErrorDetail | null;
    }
  | { type: "subagent_queued"; subagent_id: string; request: SubagentRequest }
  | { type: "subagent_started"; subagent_id: string }
  | {
      type: "subagent_progress";
      subagent_id: string;
      current: number;
      total: number | null;
      message: string | null;
    }
  | {
      type: "subagent_completed";
      subagent_id: string;
      result: SubagentResult;
    }
  | { type: "subagent_failed"; subagent_id: string; result: SubagentResult }
  | {
      type: "subagent_cancel_requested";
      subagent_id: string;
      reason: string | null;
    }
  | {
      type: "subagent_cancelled";
      subagent_id: string;
      result: SubagentResult;
    }
  | {
      type: "subagent_interrupted";
      subagent_id: string;
      result: SubagentResult;
    }
  | {
      type: "subagent_input_required";
      subagent_id: string;
      request_id: string;
      summary: string;
      prompt_kind: SubagentPromptKind;
      expires_at: string | null;
      detail: Record<string, JsonValue>;
    }
  | {
      type: "subagent_input_resumed";
      subagent_id: string;
      request_id: string;
      decision: UserInputDecision;
      detail: Record<string, JsonValue>;
    }
  // Permission control plane (Agent Workspace refactor, plan §30).
  // Independent from business HIL: a permission request suspends exactly one
  // tool call and resumes it with the same tool call — it must not restart
  // the business run.
  | {
      type: "permission_requested";
      request_id: string;
      capability: PermissionCapability;
      scope: PermissionScope;
      resource: string | null;
      canonical_resource: string | null;
      command: string | null;
      cwd: string | null;
      summary: string;
    }
  | {
      type: "permission_resolved";
      request_id: string;
      decision: PermissionDecision;
      grant_scope: PermissionGrantScope | null;
    };

export interface EventEnvelope {
  schema_version: "1.0" | "2.0";
  event_id: string;
  type: EventPayload["type"];
  task_id: string;
  run_id: string | null;
  /** Present for DatasetExecution lifecycle events; never inferred from run_id. */
  requirement_id?: string | null;
  stage_attempt_id: string | null;
  subagent_id?: string | null;
  parent_tool_call_id?: string | null;
  sequence: number;
  timestamp: string;
  payload: EventPayload;
}

export interface EventPage {
  events: EventEnvelope[];
}
