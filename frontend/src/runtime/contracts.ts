import type { JsonValue, TaskMode, UserInputDecision } from "@biomed/contracts";

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
  decision: UserInputDecision;
  detail: Record<string, JsonValue>;
}
