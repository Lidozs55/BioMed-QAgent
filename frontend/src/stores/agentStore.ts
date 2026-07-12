import { create } from "zustand";

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

  /** Pipeline actions */
  setPipelineStage: (stage: PipelineStage) => void;
}

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

export const useAgentStore = create<AgentState>((set) => ({
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
        messages: [...s.messages, { id: nextId(), role: "assistant", content: delta }],
      };
    }),

  addTrace: (item) =>
    set((s) => ({
      traces: [...s.traces, { ...item, id: nextId() }],
    })),

  setConnected: (v) => set({ isConnected: v }),
  setRunning: (v) => set({ isRunning: v }),

  reset: () =>
    set((s) => ({
      messages: [],
      traces: [],
      artifacts: [],
      isRunning: false,
      taskId: s.taskId,
      pipelineStage: "idle",
    })),

  setDatabases: (dbs) => set({ databases: dbs }),
  setSelectedDatabases: (ids) => set({ selectedDatabases: ids }),
  addArtifact: (name, path, size) =>
    set((s) => ({
      artifacts: [...s.artifacts, { name, path, size }],
    })),
  setTaskId: (id) => set({ taskId: id }),

  addSession: (taskId, topic, databases) =>
    set((s) => {
      const session: Session = { taskId, topic, databases, createdAt: Date.now(), messageCount: 0 };
      return { sessions: [...s.sessions, session], currentSessionId: taskId };
    }),

  setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),

  removeSession: (sessionId) =>
    set((s) => ({
      sessions: s.sessions.filter((se) => se.taskId !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
    })),

  setPipelineStage: (stage) => set({ pipelineStage: stage }),
}));
