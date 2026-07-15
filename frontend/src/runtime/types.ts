import type {
  ArtifactRecord,
  AttemptStatus,
  DatabaseRecord,
  MessageRole,
  RunStatus,
  StageName,
  TaskMode,
  TaskSummary,
} from "./contracts";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

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
  status: "started" | "completed" | "warning" | "recorded";
  name: string | null;
  input: string | null;
  output: string | null;
  isError: boolean;
  code: string | null;
  message: string | null;
}

export interface ArtifactProjection extends ArtifactRecord {
  taskId: string;
  generatedByStepId: string | null;
}

export interface FixtureStageProjection {
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
  fixtureStages: Partial<Record<StageName, FixtureStageProjection>>;
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
  draft: DraftState;
  databases: DatabaseRecord[];
}
