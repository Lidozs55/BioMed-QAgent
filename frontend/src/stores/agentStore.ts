import { create } from "zustand";
import { persist } from "zustand/middleware";

/** WS 事件类型 */
export interface WSEvent {
  type:
    | "task_started"
    | "text"
    | "tool_call"
    | "tool_output"
    | "done"
    | "error"
    | "skill_loaded"
    | "artifact_produced"
    | "file_downloaded"
    | "confirm"
    | "cancel_ack";
  delta?: string;
  name?: string;
  arguments?: string;
  output?: string;
  /** tool_output: whether the output was truncated to fit the WS frame. */
  truncated?: boolean;
  final_output?: string;
  message?: string;
  /** error: machine-readable error code (e.g. "configuration_error"). */
  code?: string;
  confirm_message?: string;
  category?: string;
  path?: string;
  size?: number;
  task_id?: string;
  artifact_id?: string;
  /** cancel_ack: whether the cancellation was accepted. */
  cancelled?: boolean;
  /** cancel_ack: task state when cancellation was not accepted (already terminal). */
  status?: string;
}

/** 工具调用轨迹项 */
export interface TraceItem {
  id: string;
  kind: "tool_call" | "tool_output" | "error";
  name?: string;
  arguments?: string;
  output?: string;
  /** tool_output: whether the output was truncated. */
  truncated?: boolean;
  message?: string;
  /** error: machine-readable error code. */
  code?: string;
}

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  taskId: string;
  topic: string;
  databases: string[];
  createdAt: number;
  messageCount: number;
  messages: ChatMessage[];
  traces: TraceItem[];
  artifacts: { artifactId: string; name: string; size: number }[];
  pipelineStage: PipelineStage;
}

export type PipelineStage =
  | "idle"
  | "setup"
  | "discovery"
  | "acquisition"
  | "processing"
  | "analysis"
  | "done"
  | "error";

interface AgentState {
  messages: ChatMessage[];
  traces: TraceItem[];
  isConnected: boolean;
  isRunning: boolean;

  /** New state fields */
  databases: { id: string; name: string; category: string; description: string }[];
  selectedDatabases: string[];
  artifacts: { artifactId: string; name: string; size: number }[];
  taskId: string | null;
  fixtureError: string | null;

  /** Session sidebar */
  sessions: Session[];
  currentSessionId: string | null;

  /** Pipeline progress */
  pipelineStage: PipelineStage;

  /** Existing actions */
  addMessage: (role: "user" | "assistant", content: string) => void;
  appendAssistantText: (delta: string) => void;
  addTrace: (item: Omit<TraceItem, "id">) => void;
  setConnected: (v: boolean) => void;
  setRunning: (v: boolean) => void;
  reset: () => void;

  /** New actions */
  setDatabases: (dbs: { id: string; name: string; category: string; description: string }[]) => void;
  setSelectedDatabases: (ids: string[]) => void;
  addArtifact: (artifactId: string, name: string, size: number) => void;
  setArtifacts: (artifacts: { artifactId: string; name: string; size: number }[]) => void;
  setTaskId: (id: string) => void;
  setFixtureError: (message: string | null) => void;
  prepareNewTask: (databases: string[]) => void;

  /** Session actions */
  addSession: (taskId: string, topic: string, databases: string[]) => void;
  setCurrentSession: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  saveCurrentSession: () => void;
  loadSession: (taskId: string) => void;
  deleteSession: (taskId: string) => void;

  /** Pipeline actions */
  setPipelineStage: (stage: PipelineStage) => void;
}

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

export function migratePersistedAgentState(persistedState: unknown) {
  const state = (persistedState ?? {}) as { sessions?: Session[] };
  return {
    ...state,
    sessions: (state.sessions ?? []).map((session) => ({
      ...session,
      artifacts: (session.artifacts ?? []).filter(
        (artifact) => typeof artifact.artifactId === "string",
      ),
    })),
  };
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      messages: [],
      traces: [],
      isConnected: false,
      isRunning: false,
      databases: [],
      selectedDatabases: [],
      artifacts: [],
      taskId: null,
      fixtureError: null,
      sessions: [],
      currentSessionId: null,
      pipelineStage: "idle",

      addMessage: (role, content) =>
        set((s) => ({
          messages: [...s.messages, { id: nextId(), role, content }],
        })),

      appendAssistantText: (delta) =>
        set((s) => {
          const last = s.messages[s.messages.length - 1];
          if (last && last.role === "assistant") {
            const updated = { ...last, content: last.content + delta };
            return { messages: [...s.messages.slice(0, -1), updated] };
          }
          return {
            messages: [
              ...s.messages,
              { id: nextId(), role: "assistant", content: delta },
            ],
          };
        }),

      addTrace: (item) =>
        set((s) => ({
          traces: [...s.traces, { ...item, id: nextId() }],
        })),

      setConnected: (v) => set({ isConnected: v }),

      setRunning: (v) => {
        if (!v) {
          get().saveCurrentSession();
        }
        set({ isRunning: v });
      },

      prepareNewTask: (databases) => {
        if (get().taskId) {
          get().saveCurrentSession();
        }
        set({
          messages: [],
          traces: [],
          artifacts: [],
          isRunning: false,
          selectedDatabases: databases,
          taskId: null,
          fixtureError: null,
          pipelineStage: "idle" as PipelineStage,
          currentSessionId: null,
        });
      },

      reset: () => get().prepareNewTask([]),

      setDatabases: (dbs) => set({ databases: dbs }),
      setSelectedDatabases: (ids) => set({ selectedDatabases: ids }),
      addArtifact: (artifactId, name, size) =>
        set((s) => ({
          artifacts: s.artifacts.some((item) => item.artifactId === artifactId)
            ? s.artifacts
            : [...s.artifacts, { artifactId, name, size }],
        })),
      setArtifacts: (artifacts) => set({ artifacts }),
      setTaskId: (id) => set({ taskId: id }),
      setFixtureError: (message) => set({ fixtureError: message }),

      /** Save current state into sessions array */
      saveCurrentSession: () => {
        const state = get();
        if (!state.taskId) return;

        const firstUserMsg = state.messages.find((m) => m.role === "user");
        const existingSession = state.sessions.find(
          (s) => s.taskId === state.taskId
        );
        const topic = firstUserMsg
          ? firstUserMsg.content.slice(0, 80)
          : (existingSession?.topic || state.taskId);

        const session: Session = {
          taskId: state.taskId,
          topic,
          databases: state.selectedDatabases,
          createdAt: existingSession?.createdAt || Date.now(),
          messageCount: state.messages.length,
          messages: state.messages,
          traces: state.traces,
          artifacts: state.artifacts,
          pipelineStage: state.pipelineStage,
        };

        set((s) => {
          const existingIdx = s.sessions.findIndex(
            (se) => se.taskId === state.taskId
          );
          if (existingIdx >= 0) {
            const updated = [...s.sessions];
            updated[existingIdx] = session;
            return { sessions: updated, currentSessionId: state.taskId };
          }
          return {
            sessions: [...s.sessions, session],
            currentSessionId: state.taskId,
          };
        });
      },

      /** Restore a previously saved session */
      loadSession: (taskId) => {
        const session = get().sessions.find((s) => s.taskId === taskId);
        if (!session) return;

        set({
          messages: session.messages,
          traces: session.traces,
          artifacts: session.artifacts,
          selectedDatabases: session.databases,
          taskId: session.taskId,
          pipelineStage: session.pipelineStage,
          currentSessionId: taskId,
          fixtureError: null,
        });
      },

      /** Delete a session from state and localStorage */
      deleteSession: (taskId) =>
        set((s) => {
          const sessions = s.sessions.filter((se) => se.taskId !== taskId);
          if (s.taskId !== taskId) {
            return {
              sessions,
              currentSessionId:
                s.currentSessionId === taskId ? null : s.currentSessionId,
            };
          }
          return {
            sessions,
            currentSessionId: null,
            taskId: null,
            messages: [],
            traces: [],
            artifacts: [],
            selectedDatabases: [],
            pipelineStage: "idle" as PipelineStage,
            isRunning: false,
            fixtureError: null,
          };
        }),

      addSession: (taskId, topic, databases) => {
        get().saveCurrentSession();
        set((s) => {
          const session: Session = {
            taskId,
            topic,
            databases,
            createdAt: Date.now(),
            messageCount: 0,
            messages: [],
            traces: [],
            artifacts: [],
            pipelineStage: "idle",
          };
          return {
            sessions: [...s.sessions, session],
            currentSessionId: taskId,
          };
        });
      },

      setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),

      removeSession: (sessionId) =>
        set((s) => ({
          sessions: s.sessions.filter((se) => se.taskId !== sessionId),
          currentSessionId:
            s.currentSessionId === sessionId ? null : s.currentSessionId,
        })),

      setPipelineStage: (stage) => set({ pipelineStage: stage }),
    }),
    {
      name: "biomed-sessions",
      version: 1,
      migrate: migratePersistedAgentState,
      partialize: (state) => ({ sessions: state.sessions }),
    }
  )
);
