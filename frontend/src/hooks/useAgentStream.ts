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
        applyAssistantStreamFrames: (frames) =>
          useAgentStore.getState().applyAssistantStreamFrames(frames),
        deactivateAssistantStreams: (taskId) =>
          useAgentStore.getState().deactivateAssistantStreams(taskId),
        setConnectionStatus: (status) =>
          useAgentStore.getState().setConnectionStatus(status),
        shouldSubscribe: (taskId) =>
          useAgentStore.getState().activeItems.includes(taskId),
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
