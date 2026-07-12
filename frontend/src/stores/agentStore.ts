import { create } from "zustand";
import { persist } from "zustand/middleware";

/** WS 事件类型 */
export interface WSEvent {
  type:
    | "text"
    | "tool_call"
    | "tool_output"
    | "done"
    | "error"
    | "skill_loaded"
    | "artifact_produced"
    | "file_downloaded"
    | "confirm";
  delta?: string;
  name?: string;
  arguments?: string;
  output?: string;
  final_output?: string;
  message?: string;
  confirm_message?: string;
  category?: string;
  path?: string;
  size?: number;
}

/** 工具调用轨迹项 */
export interface TraceItem {
  id: string;
  kind: "tool_call" | "tool_output" | "error";
  name?: string;
  arguments?: string;
  output?: string;
  message?: string;
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
  artifacts: { name: string; path: string; size: number }[];
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
  artifacts: { name: string; path: string; size: number }[];
  taskId: string | null;

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
  addArtifact: (name: string, path: string, size: number) => void;
  setTaskId: (id: string) => void;

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

      reset: () => {
        if (get().taskId) {
          get().saveCurrentSession();
        }
        set({
          messages: [],
          traces: [],
          artifacts: [],
          isRunning: false,
          selectedDatabases: [],
          taskId: null,
          pipelineStage: "idle" as PipelineStage,
          currentSessionId: null,
        });
      },

      setDatabases: (dbs) => set({ databases: dbs }),
      setSelectedDatabases: (ids) => set({ selectedDatabases: ids }),
      addArtifact: (name, path, size) =>
        set((s) => ({
          artifacts: [...s.artifacts, { name, path, size }],
        })),
      setTaskId: (id) => set({ taskId: id }),

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
            return { sessions: updated };
          }
          return { sessions: [...s.sessions, session] };
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
        });
      },

      /** Delete a session from state and localStorage */
      deleteSession: (taskId) =>
        set((s) => ({
          sessions: s.sessions.filter((se) => se.taskId !== taskId),
          currentSessionId:
            s.currentSessionId === taskId ? null : s.currentSessionId,
        })),

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
      partialize: (state) => ({ sessions: state.sessions }),
    }
  )
);
