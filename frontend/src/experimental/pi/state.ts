import type { EventEnvelope, ExperimentalPiRunAccepted } from "@biomed/contracts";

import type { ExperimentalPiConnection } from "./transport";

export interface ExperimentalToolState {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | null;
  output: string | null;
  status: "running" | "completed" | "error";
}

export interface ExperimentalDatasetBuildState {
  status: "succeeded" | "spec_rejected";
  buildId: string | null;
  publicationId: string | null;
  manifestId: string | null;
  artifactId: string | null;
  reasonCodes: string[];
}

export interface ExperimentalRunState {
  runId: string;
  input: string;
  assistant: string;
  reasoning: string;
  tools: ExperimentalToolState[];
  status: "running" | "cancel_requested" | "completed" | "failed" | "cancelled";
  error: string | null;
  datasetBuild: ExperimentalDatasetBuildState | null;
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
        datasetBuild: null,
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

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function datasetBuildFromTool(
  toolName: string,
  output: string | null | undefined,
  isError: boolean,
): ExperimentalDatasetBuildState | null {
  if (output === null || output === undefined) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(output) as unknown);
  } catch {
    return null;
  }
  if (toolName === "execute_dataset_build" && !isError && parsed.code === "ok") {
    const data = object(parsed.data);
    return {
      status: "succeeded",
      buildId: stringOrNull(data.build_id),
      publicationId: stringOrNull(data.publication_id),
      manifestId: stringOrNull(object(data.manifest).manifest_id),
      artifactId: null,
      reasonCodes: [],
    };
  }
  if (toolName === "validate_dataset_build" && parsed.code === "spec_rejected") {
    return {
      status: "spec_rejected",
      buildId: null,
      publicationId: null,
      manifestId: null,
      artifactId: null,
      reasonCodes: Array.isArray(parsed.reason_codes)
        ? parsed.reason_codes.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
  return null;
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
        return {
          ...run,
          assistant: run.assistant + payload.delta,
          datasetBuild: run.datasetBuild?.status === "succeeded" &&
            run.datasetBuild.artifactId === null
            ? {
                ...run.datasetBuild,
                artifactId: /\bArtifact ([A-Za-z0-9._-]+)/.exec(
                  run.assistant + payload.delta,
                )?.[1]?.replace(/\.$/, "") ?? null,
              }
            : run.datasetBuild,
        };
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
        {
          const datasetBuild = datasetBuildFromTool(
            payload.tool_name,
            payload.output,
            payload.is_error,
          );
        return {
          ...run,
          datasetBuild: datasetBuild ?? run.datasetBuild,
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
        }
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
