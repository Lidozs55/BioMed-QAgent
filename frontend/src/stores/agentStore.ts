import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  ArtifactRecord,
  DatabaseRecord,
  EventEnvelope,
  TaskMode,
  TaskPage,
  TaskSnapshot,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  hydrateTaskSnapshot as projectTaskSnapshot,
  mergeTaskPage as projectTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";
import type {
  AgentRuntimeData,
  ConnectionStatus,
} from "@/runtime/types";

export const AGENT_STORE_NAME = "biomed-sessions";
export const AGENT_STORE_VERSION = 2;

interface PersistedAgentState {
  draftPreferences: {
    selectedDatabaseIds: string[];
  };
}

export interface AgentStore extends AgentRuntimeData {
  mergeTaskPage: (page: TaskPage, append: boolean) => void;
  hydrateTaskSnapshot: (snapshot: TaskSnapshot) => void;
  applyEvent: (event: EventEnvelope) => void;
  setActiveTaskId: (taskId: string | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDatabases: (databases: DatabaseRecord[]) => void;
  setDraftInput: (input: string) => void;
  setDraftSelectedDatabaseIds: (databaseIds: string[]) => void;
  setDraftMode: (mode: TaskMode) => void;
  setDraftError: (error: string | null) => void;
  showNewDraft: () => void;
}

export function mergeTaskArtifacts(
  state: AgentRuntimeData,
  taskId: string,
  artifacts: ArtifactRecord[],
): AgentRuntimeData {
  const task = state.tasksById[taskId];
  if (task === undefined) return state;
  const artifactsById = { ...task.artifactsById };
  const artifactOrder: string[] = [];
  for (const artifact of artifacts) {
    artifactsById[artifact.artifact_id] = {
      ...artifact,
      taskId,
      generatedByStepId:
        artifactsById[artifact.artifact_id]?.generatedByStepId ?? null,
    };
    artifactOrder.push(artifact.artifact_id);
  }
  return {
    ...state,
    tasksById: {
      ...state.tasksById,
      [taskId]: { ...task, artifactsById, artifactOrder },
    },
  };
}

export function addAcceptedTask(
  state: AgentRuntimeData,
  accepted: { taskId: string; runId: string; requestId: string },
  input: string,
  databases: string[],
  mode: TaskMode,
): AgentRuntimeData {
  if (state.tasksById[accepted.taskId] !== undefined) return state;
  const timestamp = new Date(0).toISOString();
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
      [accepted.runId]: {
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
      },
    },
    runOrder: [accepted.runId],
    messages: [
      {
        messageId: `live:${accepted.runId}:user`,
        taskId: accepted.taskId,
        runId: accepted.runId,
        ordinal: null,
        role: "user" as const,
        content: input,
        createdAt: timestamp,
        sequence: null,
      },
    ],
    olderMessagesCursor: null,
    activitiesById: {},
    activityOrder: [],
    artifactsById: {},
    artifactOrder: [],
    fixtureStages: {},
    lastSequence: 0,
    hydration: "accepted" as const,
  };
  return {
    ...state,
    tasksById: { ...state.tasksById, [accepted.taskId]: projection },
    activeItems: state.activeItems.includes(accepted.taskId)
      ? state.activeItems
      : [accepted.taskId, ...state.activeItems],
    activeTaskId: accepted.taskId,
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

      mergeTaskPage: (page, append) =>
        set((state) => projectTaskPage(state, page, append)),

      hydrateTaskSnapshot: (snapshot) =>
        set((state) => projectTaskSnapshot(state, snapshot)),

      applyEvent: (event) =>
        set((state) => reduceRuntimeEvent(state, event)),

      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),

      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

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
