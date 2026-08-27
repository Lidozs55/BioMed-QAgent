import { useAgentStore } from "@/stores/agentStore";

export interface TaskPublicationState {
  status: "idle" | "ready";
  publicationId: string | null;
}

/** Read the current immutable Publication directly from the task projection. */
export function useTaskPublicationId(taskId: string | null): TaskPublicationState {
  const publicationId = useAgentStore((state) =>
    taskId === null ? null : state.tasksById[taskId]?.currentPublicationId ?? null,
  );
  if (taskId === null || publicationId === null) {
    return { status: "idle", publicationId: null };
  }
  return { status: "ready", publicationId };
}
