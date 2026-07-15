import type { ActivityProjection } from "@/runtime/types";
import type { AgentStore } from "./agentStore";
import { selectActiveActivities } from "./agentSelectors";

export interface CompatTaskRow {
  taskId: string;
  topic: string;
  status: string;
}

export interface CompatTraceItem {
  id: string;
  kind: "tool_call" | "tool_output" | "warning" | "error" | "info";
  name?: string;
  arguments?: string;
  output?: string;
  message?: string;
}

export function selectCompatTaskRows(state: AgentStore): readonly CompatTaskRow[] {
  return [...state.activeItems, ...state.taskOrder]
    .map((taskId) => state.tasksById[taskId])
    .filter((task) => task !== undefined)
    .map((task) => ({
      taskId: task.summary.task_id,
      topic: task.summary.title,
      status: task.summary.status,
    }));
}

function traceKind(activity: ActivityProjection): CompatTraceItem["kind"] {
  if (activity.kind === "warning") {
    return activity.isError ? "error" : "warning";
  }
  if (activity.kind === "tool") {
    return activity.status === "started" ? "tool_call" : "tool_output";
  }
  return "info";
}

export function selectCompatTraceItems(
  state: AgentStore,
): readonly CompatTraceItem[] {
  return selectActiveActivities(state).map((activity) => ({
    id: activity.activityId,
    kind: traceKind(activity),
    name: activity.name ?? undefined,
    arguments: activity.input ?? undefined,
    output: activity.output ?? undefined,
    message: activity.message ?? undefined,
  }));
}
