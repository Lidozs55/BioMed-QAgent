import type { EventEnvelope, ExperimentalPiRunAccepted } from "@biomed/contracts";

import type { ExperimentalPiConnection } from "./transport";

export interface ExperimentalToolState {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;
  output: string | null;
  status: "running" | "completed" | "error";
}

export interface ExperimentalRunState {
  runId: string;
  input: string;
  assistant: string;
  reasoning: string;
  tools: ExperimentalToolState[];
  status: "running" | "cancel_requested" | "completed" | "failed" | "cancelled";
  error: string | null;
}

export interface ExperimentalPiState {
  connection: ExperimentalPiConnection;
  taskId: string | null;
  sessionId: string | null;
  runs: ExperimentalRunState[];
  lastSequence: number;
  liveGap: boolean;
}

export function createExperimentalPiState(): ExperimentalPiState {
  return {
    connection: "disconnected",
    taskId: null,
    sessionId: null,
    runs: [],
    lastSequence: 0,
    liveGap: false,
  };
}

export function setExperimentalConnection(
  state: ExperimentalPiState,
  connection: ExperimentalPiConnection,
): ExperimentalPiState {
  return { ...state, connection };
}

export function markExperimentalDisconnected(
  state: ExperimentalPiState,
): ExperimentalPiState {
  return { ...state, connection: "disconnected", liveGap: state.taskId !== null };
}

export function recordAcceptedRun(
  state: ExperimentalPiState,
  accepted: ExperimentalPiRunAccepted,
  input: string,
): ExperimentalPiState {
  return {
    ...state,
    taskId: accepted.task_id,
    sessionId: accepted.session_id,
    runs: [
      ...state.runs,
      {
        runId: accepted.run_id,
        input,
        assistant: "",
        reasoning: "",
        tools: [],
        status: "running",
        error: null,
      },
    ],
  };
}

export function markExperimentalCancelRequested(
  state: ExperimentalPiState,
  runId: string,
): ExperimentalPiState {
  return updateRun(state, runId, (run) => ({ ...run, status: "cancel_requested" }));
}

function updateRun(
  state: ExperimentalPiState,
  runId: string,
  update: (run: ExperimentalRunState) => ExperimentalRunState,
): ExperimentalPiState {
  return {
    ...state,
    runs: state.runs.map((run) => (run.runId === runId ? update(run) : run)),
  };
}

export function applyExperimentalEvent(
  state: ExperimentalPiState,
  event: EventEnvelope,
): ExperimentalPiState {
  if (state.taskId !== null && event.task_id !== state.taskId) return state;
  if (event.sequence <= state.lastSequence) return state;
  const liveGap =
    state.lastSequence > 0 && event.sequence !== state.lastSequence + 1
      ? true
      : state.liveGap;
  const cursor = { ...state, lastSequence: event.sequence, liveGap };
  const runId = event.run_id;
  if (runId === null) return cursor;
  return updateRun(cursor, runId, (run) => {
    const payload = event.payload;
    switch (payload.type) {
      case "assistant_delta":
        return { ...run, assistant: run.assistant + payload.delta };
      case "assistant_reasoning_delta":
        return { ...run, reasoning: run.reasoning + payload.delta };
      case "tool_started":
        return {
          ...run,
          tools: [
            ...run.tools,
            {
              toolCallId: payload.tool_call_id,
              toolName: payload.tool_name,
              arguments: (payload.arguments as Record<string, unknown> | null | undefined) ?? null,
              output: null,
              status: "running",
            },
          ],
        };
      case "tool_completed":
        return {
          ...run,
          tools: run.tools.map((tool) =>
            tool.toolCallId === payload.tool_call_id
              ? {
                  ...tool,
                  output: payload.output ?? null,
                  status: payload.is_error ? "error" : "completed",
                }
              : tool,
          ),
        };
      case "run_cancel_requested":
        return { ...run, status: "cancel_requested" };
      case "run_cancelled":
        return { ...run, status: "cancelled" };
      case "run_completed":
        return { ...run, status: "completed" };
      case "run_failed":
        return { ...run, status: "failed", error: payload.error };
      default:
        return run;
    }
  });
}
