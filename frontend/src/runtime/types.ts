import type {
  ArtifactRecord,
  AttemptStatus,
  DatabaseRecord,
  MessageRole,
  RunStatus,
  StageName,
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

export interface AssistantStreamSegmentProjection {
  streamId: string;
  pendingChunks: Record<number, string>;
  confirmedThroughChunkIndex: number;
  active: boolean;
  durableSeen: boolean;
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

export interface TaskProjection {
  summary: TaskSummary;
  runsById: Record<string, RunProjection>;
  runOrder: string[];
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
  lastSequence: number;
  hydration: "summary" | "snapshot" | "accepted";
}

export interface AgentRuntimeData {
  tasksById: Record<string, TaskProjection>;
  taskOrder: string[];
  activeTaskId: string | null;
  activeItems: string[];
  nextCursor: string | null;
  connectionStatus: ConnectionStatus;
  historyStatus: HistoryStatus;
  historyError: string | null;
  draft: DraftState;
  databases: DatabaseRecord[];
}
