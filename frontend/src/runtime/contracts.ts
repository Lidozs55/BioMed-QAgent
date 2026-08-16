import type {
  HILDecision,
  JsonValue,
  TaskMode,
  UserInputDecision,
} from "@biomed/contracts";

export type * from "@biomed/contracts";

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
  evidence_digest?: string;
  decision: HILDecision | UserInputDecision;
  reason?: string | null;
  detail?: Record<string, JsonValue>;
}

/**
 * Response of the standalone download-resume endpoint. The download replays
 * onto the original (host) run, so ``run_id`` is that host run — no new run
 * is created.
 */
export interface DownloadResumeAccepted {
  task_id: string;
  run_id: string;
}
