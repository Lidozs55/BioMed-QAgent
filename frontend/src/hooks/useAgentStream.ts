import { useEffect, useMemo } from "react";
import { toast } from "sonner";

import { AgentEventTransport } from "@/runtime/transport";
import { useAgentStore } from "@/stores/agentStore";

export function useAgentStream(
  onPermanentGap?: (taskId: string) => void,
): AgentEventTransport {
  const transport = useMemo(
    () =>
      new AgentEventTransport({
        socketFactory: (url) => new WebSocket(url),
        getLastSequence: (taskId) =>
          useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0,
        applyEvent: (event) => useAgentStore.getState().applyEvent(event),
        markContiguous: (taskId) =>
          useAgentStore.getState().markContiguous(taskId),
        applyAssistantStreamFrames: (frames) =>
          useAgentStore.getState().applyAssistantStreamFrames(frames),
        deactivateAssistantStreams: (taskId) =>
          useAgentStore.getState().deactivateAssistantStreams(taskId),
        setConnectionStatus: (status) =>
          useAgentStore.getState().setConnectionStatus(status),
        shouldSubscribe: (taskId) => {
          const state = useAgentStore.getState();
          if (state.activeItems.includes(taskId)) return true;
          // A task-level download resume (no AI run) leaves the task's
          // summary terminal, so the task drops out of activeItems — but the
          // resume replays tool_started/progress/completed onto the original
          // tool call and must keep the WS subscription alive until that
          // tool call finishes. Without this, reconcileSubscription drops
          // the subscription on the first replayed event and the resumed
          // download freezes on the frontend. The bubble flips to
          // completed/failed when the resume ends, which makes this check
          // return false again and lets the subscription be cleaned up.
          const task = state.tasksById[taskId];
          if (task === undefined) return false;
          return task.items.some(
            (item) => item.kind === "tool_call" && item.status === "running",
          );
        },
        onPermanentGap,
        onControlError: (frame) => {
          // Recovery-path errors (task_not_found during resubscribe) are
          // already surfaced via transport internals; only surface generic
          // protocol/internal errors here so users see server-side issues.
          if (frame.code === "task_not_found") return;
          toast.error(`WebSocket 错误: ${frame.code}`, {
            description: frame.message,
          });
        },
      }),
    [onPermanentGap],
  );

  useEffect(() => () => transport.disconnect(), [transport]);

  return transport;
}
