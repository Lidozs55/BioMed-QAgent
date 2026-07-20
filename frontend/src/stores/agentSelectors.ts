import type { AgentStore } from "./agentStore";
import type {
  ActivityProjection,
  ArtifactProjection,
  ConversationItem,
  RunProjection,
  TaskProjection,
} from "@/runtime/types";

const EMPTY_RUNS: readonly RunProjection[] = [];
const EMPTY_ACTIVITIES: readonly ActivityProjection[] = [];
const EMPTY_ARTIFACTS: readonly ArtifactProjection[] = [];
const EMPTY_ITEMS: readonly ConversationItem[] = [];

export const selectActiveTask = (state: AgentStore): TaskProjection | undefined =>
  state.activeTaskId === null ? undefined : state.tasksById[state.activeTaskId];

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

export const selectActiveItems = (
  state: AgentStore,
): readonly ConversationItem[] => selectActiveTask(state)?.items ?? EMPTY_ITEMS;

export const selectActiveItem = (
  state: AgentStore,
): ConversationItem | undefined => {
  const items = selectActiveItems(state);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "assistant_segment" && item.isStreaming) return item;
    if (item.kind === "tool_call" && item.status === "running") return item;
    if (item.kind === "reasoning" && item.isStreaming) return item;
  }
  return undefined;
};

export const selectConnectionIsConnected = (state: AgentStore): boolean =>
  state.connectionStatus === "connected";

export const selectDraftSelectedDatabaseIds = (state: AgentStore) =>
  state.draft.selectedDatabaseIds;

export const selectDraftError = (state: AgentStore) => state.draft.error;
