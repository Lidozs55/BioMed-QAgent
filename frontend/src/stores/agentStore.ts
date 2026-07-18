import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  ArtifactRecord,
  DatabaseRecord,
  AssistantStreamFrame,
  EventEnvelope,
  MessagePage,
  TaskMode,
  TaskPage,
  TaskSnapshot,
} from "@/runtime/contracts";
import {
  compareTaskIds,
  createInitialRuntimeState,
  createTaskProjection,
  hydrateTaskSnapshot as projectTaskSnapshot,
  mergeOlderMessagePage as projectOlderMessagePage,
  mergeTaskPage as projectTaskPage,
  prepareTaskSnapshotReplay as projectTaskSnapshotReplay,
  deactivateAssistantStreams as projectDeactivateAssistantStreams,
  reduceAssistantStreamFrames,
  reduceRuntimeEvent,
} from "@/runtime/reducer";
import type {
  AgentRuntimeData,
  ConnectionStatus,
  HistoryStatus,
  TaskProjection,
} from "@/runtime/types";

export const AGENT_STORE_NAME = "biomed-sessions";
export const AGENT_STORE_VERSION = 2;

interface PersistedAgentState {
  draftPreferences: {
    selectedDatabaseIds: string[];
  };
}

export interface AgentStore extends AgentRuntimeData {
  mergeTaskPage: (
    page: TaskPage,
    append: boolean,
    preserveTaskIds?: ReadonlySet<string>,
  ) => void;
  hydrateTaskSnapshot: (snapshot: TaskSnapshot) => void;
  prepareTaskSnapshotReplay: (snapshot: TaskSnapshot) => void;
  mergeOlderMessagePage: (
    taskId: string,
    requestedCursor: string,
    page: MessagePage,
  ) => void;
  applyEvent: (event: EventEnvelope) => void;
  applyAssistantStreamFrames: (frames: readonly AssistantStreamFrame[]) => void;
  deactivateAssistantStreams: (taskId?: string) => void;
  setActiveTaskId: (taskId: string | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setHistoryState: (status: HistoryStatus, error?: string | null) => void;
  setDatabases: (databases: DatabaseRecord[]) => void;
  setDraftInput: (input: string) => void;
  setDraftSelectedDatabaseIds: (databaseIds: string[]) => void;
  setDraftMode: (mode: TaskMode) => void;
  setDraftError: (error: string | null) => void;
  showNewDraft: () => void;
  removeTask: (taskId: string) => void;
}

export function mergeTaskArtifacts(
  state: AgentRuntimeData,
  taskId: string,
  artifacts: ArtifactRecord[],
  requestSequence: number,
): AgentRuntimeData {
  const task = state.tasksById[taskId];
  if (task === undefined) return state;
  if (
    task.artifactManifestSequence !== null &&
    task.artifactManifestSequence > requestSequence
  ) {
    return state;
  }
  const liveArtifactIds = task.artifactOrder.filter(
    (artifactId) =>
      (task.artifactEventSequences[artifactId] ?? 0) > requestSequence,
  );
  const liveArtifactIdSet = new Set(liveArtifactIds);
  const artifactsById = Object.fromEntries(
    liveArtifactIds.map((artifactId) => [
      artifactId,
      task.artifactsById[artifactId],
    ]),
  );
  const artifactOrder = [...liveArtifactIds];
  const orderedArtifactIds = new Set(liveArtifactIds);
  for (const artifact of artifacts) {
    if (liveArtifactIdSet.has(artifact.artifact_id)) continue;
    artifactsById[artifact.artifact_id] = {
      ...artifact,
      taskId,
      generatedByStepId:
        task.artifactsById[artifact.artifact_id]?.generatedByStepId ?? null,
    };
    if (!orderedArtifactIds.has(artifact.artifact_id)) {
      artifactOrder.push(artifact.artifact_id);
      orderedArtifactIds.add(artifact.artifact_id);
    }
  }
  return {
    ...state,
    tasksById: {
      ...state.tasksById,
      [taskId]: { ...task, artifactsById, artifactOrder },
    },
  };
}

function admitExistingTask(
  state: AgentRuntimeData,
  projection: TaskProjection,
  activate: boolean,
): AgentRuntimeData {
  const taskId = projection.summary.task_id;
  const tasksById = { ...state.tasksById, [taskId]: projection };
  return {
    ...state,
    tasksById,
    activeItems: [...new Set([...state.activeItems, taskId])].sort((left, right) =>
      compareTaskIds(tasksById, left, right),
    ),
    taskOrder: state.taskOrder.filter((candidate) => candidate !== taskId),
    activeTaskId: activate ? taskId : state.activeTaskId,
  };
}

export function addAcceptedTask(
  state: AgentRuntimeData,
  accepted: { taskId: string; runId: string; requestId: string },
  input: string,
  databases: string[],
  mode: TaskMode,
  activate = true,
): AgentRuntimeData {
  const timestamp = new Date(0).toISOString();
  const acceptedRun = {
    runId: accepted.runId,
    taskId: accepted.taskId,
    requestId: accepted.requestId,
    status: "queued" as const,
    input,
    createdAt: null,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  const acceptedMessage = {
    messageId: `live:${accepted.runId}:user`,
    taskId: accepted.taskId,
    runId: accepted.runId,
    ordinal: null,
    role: "user" as const,
    content: input,
    createdAt: timestamp,
    sequence: null,
  };
  const existing = state.tasksById[accepted.taskId];
  if (existing !== undefined) {
    if (existing.runsById[accepted.runId] !== undefined) {
      const admitted = activate
        ? { ...state, activeTaskId: accepted.taskId }
        : state;
      if (!admitted.activeItems.includes(accepted.taskId)) return admitted;
      return {
        ...admitted,
        activeItems: [...admitted.activeItems].sort((left, right) =>
          compareTaskIds(admitted.tasksById, left, right),
        ),
      };
    }
    if (existing.hydration !== "summary") {
      const projection = {
        ...existing,
        summary: {
          ...existing.summary,
          status: "queued" as const,
          active_run_id: accepted.runId,
        },
        runsById: {
          ...existing.runsById,
          [accepted.runId]: acceptedRun,
        },
        runOrder: [...existing.runOrder, accepted.runId],
        messages: [...existing.messages, acceptedMessage],
        pendingUserInput: null,
      };
      return admitExistingTask(state, projection, activate);
    }
    const summaryProjection = createTaskProjection(existing.summary);
    const projection = {
      ...summaryProjection,
      summary: {
        ...summaryProjection.summary,
        status: "queued" as const,
        active_run_id: accepted.runId,
      },
      runsById: { [accepted.runId]: acceptedRun },
      runOrder: [accepted.runId],
      messages: [acceptedMessage],
      lastSequence: 0,
      hydration: "accepted" as const,
    };
    return admitExistingTask(state, projection, activate);
  }
  const summary = {
    task_id: accepted.taskId,
    mode,
    databases: [...databases],
    title: input,
    status: "queued" as const,
    active_run_id: accepted.runId,
    created_at: timestamp,
    updated_at: timestamp,
    latest_sequence: 0,
  };
  const projection = {
    summary,
    runsById: {
      [accepted.runId]: acceptedRun,
    },
    runOrder: [accepted.runId],
    messages: [acceptedMessage],
    olderMessagesCursor: null,
    activitiesById: {},
    activityOrder: [],
    artifactsById: {},
    artifactOrder: [],
    artifactEventSequences: {},
    artifactManifestSequence: null,
    stages: {},
    assistantStreamsByRunId: {},
    pendingUserInput: null,
    lastSequence: 0,
    hydration: "accepted" as const,
  };
  return {
    ...state,
    tasksById: { ...state.tasksById, [accepted.taskId]: projection },
    activeItems: state.activeItems.includes(accepted.taskId)
      ? state.activeItems
      : [accepted.taskId, ...state.activeItems],
    activeTaskId: activate ? accepted.taskId : state.activeTaskId,
  };
}

function selectedDatabaseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item, index, values): item is string =>
      typeof item === "string" && item.length > 0 && values.indexOf(item) === index,
  );
}

export function migratePersistedAgentState(
  persistedState: unknown,
  version: number,
): PersistedAgentState {
  if (version < AGENT_STORE_VERSION) {
    return { draftPreferences: { selectedDatabaseIds: [] } };
  }
  if (typeof persistedState !== "object" || persistedState === null) {
    return { draftPreferences: { selectedDatabaseIds: [] } };
  }
  const preferences = Reflect.get(persistedState, "draftPreferences");
  const ids =
    typeof preferences === "object" && preferences !== null
      ? Reflect.get(preferences, "selectedDatabaseIds")
      : undefined;
  return {
    draftPreferences: { selectedDatabaseIds: selectedDatabaseIds(ids) },
  };
}

function persistedState(state: AgentStore): PersistedAgentState {
  return {
    draftPreferences: {
      selectedDatabaseIds: [...state.draft.selectedDatabaseIds],
    },
  };
}

const initialState = createInitialRuntimeState();

export const useAgentStore = create<AgentStore>()(
  persist<AgentStore, [], [], PersistedAgentState>(
    (set) => ({
      ...initialState,

      mergeTaskPage: (page, append, preserveTaskIds) =>
        set((state) =>
          projectTaskPage(state, page, append, preserveTaskIds),
        ),

      hydrateTaskSnapshot: (snapshot) =>
        set((state) => projectTaskSnapshot(state, snapshot)),

      prepareTaskSnapshotReplay: (snapshot) =>
        set((state) => projectTaskSnapshotReplay(state, snapshot)),

      mergeOlderMessagePage: (taskId, requestedCursor, page) =>
        set((state) =>
          projectOlderMessagePage(state, taskId, requestedCursor, page),
        ),

      applyEvent: (event) =>
        set((state) => reduceRuntimeEvent(state, event)),

      applyAssistantStreamFrames: (frames) =>
        set((state) => reduceAssistantStreamFrames(state, frames)),

      deactivateAssistantStreams: (taskId) =>
        set((state) => projectDeactivateAssistantStreams(state, taskId)),

      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),

      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

      setHistoryState: (historyStatus, historyError = null) =>
        set({ historyStatus, historyError }),

      setDatabases: (databases) => set({ databases: [...databases] }),

      setDraftInput: (input) =>
        set((state) => ({ draft: { ...state.draft, input } })),

      setDraftSelectedDatabaseIds: (databaseIds) =>
        set((state) => ({
          draft: {
            ...state.draft,
            selectedDatabaseIds: [...databaseIds],
          },
        })),

      setDraftMode: (mode) =>
        set((state) => ({ draft: { ...state.draft, mode } })),

      setDraftError: (error) =>
        set((state) => ({ draft: { ...state.draft, error } })),

      showNewDraft: () =>
        set((state) => ({
          activeTaskId: null,
          draft: {
            ...state.draft,
            input: "",
            mode: "agent",
            error: null,
          },
        })),

      removeTask: (taskId) =>
        set((state) => {
          const tasksById = { ...state.tasksById };
          delete tasksById[taskId];
          return {
            tasksById,
            activeItems: state.activeItems.filter(
              (candidate) => candidate !== taskId,
            ),
            taskOrder: state.taskOrder.filter(
              (candidate) => candidate !== taskId,
            ),
            activeTaskId:
              state.activeTaskId === taskId ? null : state.activeTaskId,
          };
        }),
    }),
    {
      name: AGENT_STORE_NAME,
      version: AGENT_STORE_VERSION,
      partialize: persistedState,
      migrate: migratePersistedAgentState,
      merge: (persisted, current) => {
        const migrated = migratePersistedAgentState(
          persisted,
          AGENT_STORE_VERSION,
        );
        return {
          ...current,
          draft: {
            ...current.draft,
            selectedDatabaseIds:
              migrated.draftPreferences.selectedDatabaseIds,
          },
        };
      },
    },
  ),
);
