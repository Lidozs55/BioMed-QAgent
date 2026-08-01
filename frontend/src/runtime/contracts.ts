export type TaskMode = "agent" | "fixture" | "import";

export type RunStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "cancel_requested"
  | "awaiting_user_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type StageName =
  | "discovery"
  | "acquisition"
  | "processing"
  | "artifact_build"
  | "validation";

export type AttemptStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type SubagentType = "source_research" | "skill_builder";

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "interrupted";

export type SubagentErrorCode =
  | "not_found"
  | "capability_gap"
  | "extraction_failed"
  | "auth_required"
  | "captcha_required"
  | "credential_required"
  | "payment_required"
  | "policy_denied"
  | "rate_limited"
  | "timed_out"
  | "cancelled"
  | "internal_error";

export type SubagentPromptKind =
  | "authentication"
  | "captcha"
  | "api_key_or_credential"
  | "payment"
  | "terms_approval"
  | "confirmation";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DatabaseRecord {
  id: string;
  name: string;
  category: string;
  description: string;
  available?: boolean;
  origin?: "builtin" | "package";
  version?: string;
  pipeline_supported?: boolean;
}

export interface TaskSummary {
  schema_version?: "1.0";
  task_id: string;
  mode: TaskMode;
  databases: string[];
  title: string;
  status: RunStatus;
  active_run_id: string | null;
  created_at: string;
  updated_at: string;
  latest_sequence: number;
}

export interface RunRecord {
  schema_version?: "1.0";
  run_id: string;
  task_id: string;
  request_id: string;
  status: RunStatus;
  input: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface MessageRecord {
  schema_version?: "1.0";
  message_id: string;
  task_id: string;
  run_id: string | null;
  ordinal: number;
  role: MessageRole;
  content: string;
  created_at: string;
}

export interface SubagentRequest {
  agent_type: SubagentType;
  objective: string;
  target_source: string | null;
  domain: string;
  capability: string;
  inputs: Record<string, JsonValue>;
}

export interface SubagentResult {
  subagent_id: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  summary: string;
  source_asset_ids: string[];
  recipe_id: string | null;
  warnings: string[];
  error_code: SubagentErrorCode | null;
  error_message: string | null;
}

export interface SubagentRecord {
  subagent_id: string;
  task_id: string;
  run_id: string;
  agent_type: SubagentType;
  objective: string;
  target_source: string | null;
  status: SubagentStatus;
  parent_tool_call_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress_current: number;
  progress_total: number | null;
  progress_message: string | null;
  result_summary: string | null;
  source_asset_ids: string[];
  recipe_id: string | null;
  error_code: SubagentErrorCode | null;
  error_message: string | null;
  pending_request_id: string | null;
}

export interface TaskSnapshot {
  schema_version?: "1.0";
  task: TaskSummary;
  runs: RunRecord[];
  messages: MessageRecord[];
  subagents?: SubagentRecord[];
  older_messages_cursor: string | null;
}

export interface TaskPage {
  schema_version?: "1.0";
  active_items: TaskSummary[];
  items: TaskSummary[];
  next_cursor: string | null;
}

export interface MessagePage {
  schema_version?: "1.0";
  messages: MessageRecord[];
  next_cursor: string | null;
}

export interface TaskRunAccepted {
  schema_version?: "1.0";
  request_id: string;
  task_id: string;
  run_id: string;
  status: "queued";
}

export interface StartTaskInput {
  input: string;
  databases: string[];
  mode: TaskMode;
}

export interface ContinueTaskInput {
  input: string;
}

export interface ResumeRunInput {
  request_id: string;
  decision: UserInputDecision;
  detail: Record<string, JsonValue>;
}

export interface ArtifactRecord {
  artifact_id: string;
  name: string;
  size: number;
  sha256: string;
  media_type: string;
}

export interface ArtifactManifestEntry {
  schema_version?: "1.0";
  artifact_id: string;
  name: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  generated_by_step_id: string;
}

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
  | "no_progress";

export type UserInputDecision = "approve" | "reject";

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
    }
  | {
      type: "user_input_resumed";
      request_id: string;
      decision: UserInputDecision;
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
  | { type: "tool_called"; tool_name: string; arguments_digest: string }
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
  | { type: "run_queued"; request_id: string; input: string }
  | { type: "run_started" }
  | { type: "run_finalizing" }
  | { type: "run_completed" }
  | { type: "run_failed"; error: string }
  | { type: "run_cancel_requested"; reason: string | null }
  | { type: "run_cancelled"; reason: string | null }
  | { type: "run_interrupted"; reason: string }
  | AssistantDeltaPayload
  | AssistantReasoningDeltaPayload
  | {
      type: "tool_started";
      tool_call_id: string;
      tool_name: string;
      arguments?: Record<string, JsonValue> | null;
    }
  | {
      type: "conversation_compacted";
      covered_through_run_id: string;
      summary_digest: string;
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
    };

export interface EventEnvelope {
  schema_version: "1.0" | "2.0";
  event_id: string;
  type: EventPayload["type"];
  task_id: string;
  run_id: string | null;
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

export type WebSocketCommand =
  | { type: "subscribe"; task_id: string; after_sequence: number }
  | { type: "unsubscribe"; task_id: string }
  | { type: "ping" };

export type WebSocketControlFrame =
  | { type: "pong" }
  | { type: "error"; code: string; message: string; task_id?: string };

export interface AssistantStreamDeltaFrame {
  type: "assistant_stream_delta";
  task_id: string;
  run_id: string;
  stream_id: string;
  chunk_index: number;
  delta: string;
}

export interface AssistantStreamEndFrame {
  type: "assistant_stream_end";
  task_id: string;
  run_id: string;
  stream_id: string;
  last_chunk_index: number | null;
  finish_reason: string;
}

export type AssistantStreamFrame =
  | AssistantStreamDeltaFrame
  | AssistantStreamEndFrame;
