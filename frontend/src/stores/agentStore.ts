import { create } from "zustand";

/** WS 事件类型 */
export interface WSEvent {
  type: "text" | "tool_call" | "tool_output" | "done" | "error";
  delta?: string;
  name?: string;
  arguments?: string;
  output?: string;
  final_output?: string;
  message?: string;
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

interface AgentState {
  messages: ChatMessage[];
  traces: TraceItem[];
  isConnected: boolean;
  isRunning: boolean;

  addMessage: (role: "user" | "assistant", content: string) => void;
  appendAssistantText: (delta: string) => void;
  addTrace: (item: Omit<TraceItem, "id">) => void;
  setConnected: (v: boolean) => void;
  setRunning: (v: boolean) => void;
  reset: () => void;
}

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

export const useAgentStore = create<AgentState>((set) => ({
  messages: [],
  traces: [],
  isConnected: false,
  isRunning: false,

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
  reset: () => set({ messages: [], traces: [], isRunning: false }),
}));
