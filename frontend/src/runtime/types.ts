import type {
  ArtifactRecord,
  AttemptStatus,
  DatabaseRecord,
  MessageRole,
  PublicationSummary,
  RunStatus,
  RunSummary,
  StageName,
  SubagentErrorCode,
  SubagentStatus,
  SubagentType,
  TaskMode,
  TaskSummary,
  UserInputPromptKind,
} from "./contracts";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

export interface DraftState {
  input: string;
  selectedDatabaseIds: string[];
  mode: TaskMode;
  error: string | null;
}

export interface RunProjection {
  runId: string;
  taskId: string;
  requestId: string | null;
  status: RunStatus;
  input: string | null;
  createdAt: string | null;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Server-generated per-run outcome summary (null until the run terminalizes). */
  summary: RunSummary | null;
}

export interface SubagentProjection {
  subagentId: string;
  taskId: string;
  runId: string;
  agentType: SubagentType;
  objective: string;
  targetSource: string | null;
  status: SubagentStatus;
  parentToolCallId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progressCurrent: number;
  progressTotal: number | null;
  progressMessage: string | null;
  resultSummary: string | null;
  warnings: string[];
  sourceAssetIds: string[];
  recipeId: string | null;
  errorCode: SubagentErrorCode | null;
  errorMessage: string | null;
  pendingRequestId: string | null;
}

export interface ProjectedMessage {
  messageId: string;
  taskId: string;
  runId: string | null;
  ordinal: number | null;
  role: MessageRole;
  content: string;
  createdAt: string;
  sequence: number | null;
}

export type ActivityKind =
  | "tool"
  | "reasoning"
  | "stage"
  | "progress"
  | "warning"
  | "conversation_compacted"
  | "fixture_event";

export interface ActivityProjection {
  activityId: string;
  taskId: string;
  runId: string | null;
  subagentId: string | null;
  sequence: number;
  timestamp: string;
  kind: ActivityKind;
  status:
    | "started"
    | "completed"
    | "failed"
    | "skipped"
    | "warning"
    | "recorded";
  name: string | null;
  input: string | null;
  output: string | null;
  isError: boolean;
  code: string | null;
  message: string | null;
  stage?: StageName;
  progress?: {
    stage: StageName;
    kind: string;
    current: number;
    total: number | null;
  };
}

export interface ArtifactProjection extends ArtifactRecord {
  taskId: string;
  generatedByStepId: string | null;
}

export interface StageProgressProjection {
  kind: string;
  current: number;
  total: number | null;
  detail: Record<string, unknown>;
  updatedAt: string;
}

export interface StageProjection {
  stage: StageName;
  stageAttemptId: string;
  attempt: number;
  status: AttemptStatus;
  startedAt: string | null;
  finishedAt: string | null;
  outputDigest: string | null;
  error: string | null;
  skipReason: string | null;
  reusedStageAttemptId: string | null;
  progress: StageProgressProjection | null;
}

export interface PendingUserInput {
  runId: string;
  requestId: string;
  promptKind: UserInputPromptKind;
  summary: string;
  expiresAt: string | null;
  fixtureExempt: boolean;
  detail: Record<string, unknown>;
  sequence: number;
  timestamp: string;
}

export interface PendingPermission {
  runId: string;
  requestId: string;
  capability: "fs.read" | "fs.write" | "fs.edit" | "process.exec";
  scope: "workspace" | "task_output" | "framework_internal" | "project" | "external";
  resource: string | null;
  command: string | null;
  cwd: string | null;
  summary: string;
  sequence: number;
  timestamp: string;
}

export interface AssistantStreamSegmentProjection {
  streamId: string;
  pendingChunks: Record<number, string>;
  confirmedThroughChunkIndex: number;
  active: boolean;
  durableSeen: boolean;
  /**
   * ``finish_reason`` from the ``assistant_stream_end`` frame.
   * ``null`` before the end frame arrives; ``"tool_call_pending"`` when the
   * backend enters JSON buffer mode (signals frontend to keep showing
   * "正在调用工具" placeholder).
   */
  finishReason: string | null;
}

export interface AssistantStreamConflictDiagnostic {
  taskId: string;
  runId: string;
  streamId: string;
  chunkIndex: number;
  count: number;
}

export interface AssistantStreamProjection {
  durableText: string;
  liveStreamOrder: string[];
  streamsById: Record<string, AssistantStreamSegmentProjection>;
  conflicts: AssistantStreamConflictDiagnostic[];
}

export interface ConversationItemBase {
  itemId: string;
  runId: string;
  sequence: number;
  createdAt: string;
}

export interface UserMessageItem extends ConversationItemBase {
  kind: "user_message";
  content: string;
}

export interface AssistantSegmentItem extends ConversationItemBase {
  kind: "assistant_segment";
  streamId: string;
  content: string;
  isStreaming: boolean;
  finishReason: string | null;
}

export interface ReasoningItem extends ConversationItemBase {
  kind: "reasoning";
  content: string;
  isStreaming: boolean;
}

export interface ToolCallItem extends ConversationItemBase {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;
  status: "running" | "completed" | "error";
  output: string | null;
  completedSequence: number | null;
  /** Download/operation progress bound to this tool call (see pipeline reducer). */
  progress?: DownloadProgressProjection | null;
}

export interface StageItem extends ConversationItemBase {
  kind: "stage";
  stage: StageName;
  status: "running" | "completed" | "failed" | "skipped";
  attempt: number;
  error: string | null;
}

export interface OperationItem extends ConversationItemBase {
  kind: "operation";
  operationId: string;
  /** Display label from the wire event (may be empty); fallbacks applied at render. */
  label: string | null;
  category: string | null;
  status: "running" | "completed" | "failed" | "skipped" | "cancelled";
  progress: DownloadProgressProjection | null;
  error: string | null;
}

/** Live byte-level progress carried by downloads (kind "downloaded_bytes"). */
export interface DownloadProgressProjection {
  kind: string;
  current: number;
  total: number | null;
  /** Wire-level operation_progress detail (e.g. source/accession/filename). */
  detail: Record<string, unknown> | null;
  /** Envelope timestamp of the latest progress event, for stall detection. */
  updatedAt: string;
}

/**
 * Pause/resume controls for a long-running acquisition (download). The
 * operation item renders a pause button while the download is advancing and
 * switches to a resume button once it stops (terminal run or stale progress).
 */
/** Tool invocation identity needed to resume an interrupted download directly. */
export interface DownloadResumeRequest {
  toolName: string;
  arguments: Record<string, unknown> | null;
}

export interface DownloadControl {
  taskId: string;
  onPause: (taskId: string, runId: string) => Promise<void> | void;
  /** Resumes the download directly (no AI pass); the user sends "继续" afterwards. */
  onResume: (
    taskId: string,
    runId: string,
    resume: DownloadResumeRequest,
  ) => Promise<void> | void;
}

export interface ProgressItem extends ConversationItemBase {
  kind: "progress";
  stage: StageName;
  progressKind: string;
  current: number;
  total: number | null;
}

export interface WarningItem extends ConversationItemBase {
  kind: "warning";
  code: string;
  message: string;
}

export interface ArtifactItem extends ConversationItemBase {
  kind: "artifact";
  artifactId: string;
  name: string;
  sizeBytes: number;
  mediaType: string;
}
export interface BuildReportItem extends ConversationItemBase {
  kind: "build_report";
  taskId: string;
  buildId: string;
}

export type ConversationItem =
  | UserMessageItem
  | AssistantSegmentItem
  | ReasoningItem
  | ToolCallItem
  | StageItem
  | OperationItem
  | ProgressItem
  | WarningItem
  | ArtifactItem
  | BuildReportItem;

export interface SequenceGapMarker {
  expected: number;
  received: number;
}

export interface TaskProjection {
  summary: TaskSummary;
  runsById: Record<string, RunProjection>;
  runOrder: string[];
  subagentsById: Record<string, SubagentProjection>;
  subagentOrder: string[];
  messages: ProjectedMessage[];
  olderMessagesCursor: string | null;
  activitiesById: Record<string, ActivityProjection>;
  activityOrder: string[];
  artifactsById: Record<string, ArtifactProjection>;
  artifactOrder: string[];
  artifactEventSequences: Record<string, number>;
  artifactManifestSequence: number | null;
  stages: Partial<Record<StageName, StageProjection>>;
  assistantStreamsByRunId: Record<string, AssistantStreamProjection>;
  pendingUserInput: PendingUserInput | null;
  /** Suspended permission request awaiting a user decision (plan §30). */
  pendingPermission: PendingPermission | null;
  lastSequence: number;
  hydration: "summary" | "snapshot" | "accepted";
  items: ConversationItem[];
  itemSequences: Record<string, number>;
  currentReasoningSegmentByRun: Record<string, number>;
  /** Total context window capacity in tokens (from model settings). */
  contextWindow?: number;
  /** Estimated tokens currently used in the conversation. */
  contextTokensUsed?: number;
  /** Whether a context compaction is currently in progress. */
  compacting?: boolean;
  /** ID of the latest publication for this task (null when none was produced). */
  currentPublicationId: string | null;
  /** Immutable publication records in creation order. */
  publications: PublicationSummary[];
  /**
   * Recoverable sequence gap: set when an event with
   * ``sequence > lastSequence + 1`` was rejected without advancing the
   * cursor. Cleared once the missing frame is replayed and applied.
   */
  sequenceGap: SequenceGapMarker | null;
}

export interface AgentRuntimeData {
  tasksById: Record<string, TaskProjection>;
  taskOrder: string[];
  activeTaskId: string | null;
  /** Task whose selection hydration is still in flight (drives the loading screen). */
  hydratingTaskId: string | null;
  activeItems: string[];
  nextCursor: string | null;
  connectionStatus: ConnectionStatus;
  historyStatus: HistoryStatus;
  historyError: string | null;
  draft: DraftState;
  databases: DatabaseRecord[];
}
