import type { AgentStore } from "./agentStore";
import type {
  ActivityProjection,
  ArtifactProjection,
  ProjectedMessage,
  RunProjection,
  TaskProjection,
} from "@/runtime/types";

const EMPTY_MESSAGES: readonly ProjectedMessage[] = [];
const EMPTY_RUNS: readonly RunProjection[] = [];
const EMPTY_ACTIVITIES: readonly ActivityProjection[] = [];
const EMPTY_ARTIFACTS: readonly ArtifactProjection[] = [];

export const selectActiveTask = (state: AgentStore): TaskProjection | undefined =>
  state.activeTaskId === null ? undefined : state.tasksById[state.activeTaskId];

export const selectActiveMessages = (
  state: AgentStore,
): readonly ProjectedMessage[] => selectActiveTask(state)?.messages ?? EMPTY_MESSAGES;

export const selectActiveRuns = (state: AgentStore): readonly RunProjection[] => {
  const task = selectActiveTask(state);
  return task?.runOrder.map((runId) => task.runsById[runId]) ?? EMPTY_RUNS;
};

export const selectActiveActivities = (
  state: AgentStore,
): readonly ActivityProjection[] => {
  const task = selectActiveTask(state);
  return (
    task?.activityOrder.map((activityId) => task.activitiesById[activityId]) ??
    EMPTY_ACTIVITIES
  );
};

export const selectActiveArtifacts = (
  state: AgentStore,
): readonly ArtifactProjection[] => {
  const task = selectActiveTask(state);
  return (
    task?.artifactOrder.map((artifactId) => task.artifactsById[artifactId]) ??
    EMPTY_ARTIFACTS
  );
};

export const selectConnectionIsConnected = (state: AgentStore): boolean =>
  state.connectionStatus === "connected";

export const selectDraftSelectedDatabaseIds = (state: AgentStore) =>
  state.draft.selectedDatabaseIds;

export const selectDraftError = (state: AgentStore) => state.draft.error;
