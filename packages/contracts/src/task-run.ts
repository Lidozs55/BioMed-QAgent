import type { JsonValue } from "./json.js";

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

export type ErrorCode =
  | "configuration_error"
  | "context_budget_exhausted"
  | "network_error"
  | "timeout"
  | "download_incomplete"
  | "checksum_mismatch"
  | "parse_error"
  | "validation_error"
  | "cancelled"
  | "internal_error";

export interface RunSummary {
  run_status: RunStatus;
  error_code: ErrorCode | null;
  cancelled_at_stage: StageName | null;
  user_message: string | null;
}

export interface TaskPublicationSummary {
  publication_id: string;
  manifest_sha256: string;
  supersedes_publication_id: string | null;
  published_at: string;
}

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

export const STAGE_NAMES: readonly StageName[] = [
  "discovery",
  "acquisition",
  "processing",
  "artifact_build",
  "validation",
];

export const ERROR_CODES: readonly ErrorCode[] = [
  "configuration_error",
  "network_error",
  "timeout",
  "download_incomplete",
  "checksum_mismatch",
  "parse_error",
  "validation_error",
  "cancelled",
  "internal_error",
];

export const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
  "awaiting_user_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export const TASK_MODES: readonly TaskMode[] = ["agent", "fixture", "import"];

export const MESSAGE_ROLES: readonly MessageRole[] = ["system", "user", "assistant", "tool"];

export const SUBAGENT_TYPES: readonly SubagentType[] = ["source_research", "skill_builder"];

export const SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "interrupted",
];

export const SUBAGENT_ERROR_CODES: readonly SubagentErrorCode[] = [
  "not_found",
  "capability_gap",
  "extraction_failed",
  "auth_required",
  "captcha_required",
  "credential_required",
  "payment_required",
  "policy_denied",
  "rate_limited",
  "timed_out",
  "cancelled",
  "internal_error",
];

export const SUBAGENT_PROMPT_KINDS: readonly SubagentPromptKind[] = [
  "authentication",
  "captcha",
  "api_key_or_credential",
  "payment",
  "terms_approval",
  "confirmation",
];

export interface DatabaseRecord {
  id: string;
  name: string;
  category: string;
  description: string;
  available?: boolean;
  origin?: "builtin" | "package";
  version?: string;
  pipeline_supported?: boolean;
  /** Phase 2: per-database enabled toggle from the thin database store. */
  enabled?: boolean;
  /** Phase 2: pipeline_supported | research_only | pending classification. */
  capability?: string;
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
  /** Number of validated artifacts produced by the task (absent in older snapshots). */
  artifact_count?: number;
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
  /** Server-generated per-run outcome summary (absent in older snapshots). */
  summary?: RunSummary | null;
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
  current_publication_id?: string | null;
  publications?: TaskPublicationSummary[];
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
