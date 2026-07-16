import { useEffect, useMemo } from "react";

import { AgentEventTransport } from "@/runtime/transport";
import { useAgentStore } from "@/stores/agentStore";

export function useAgentStream(): AgentEventTransport {
  const transport = useMemo(
    () =>
      new AgentEventTransport({
        socketFactory: (url) => new WebSocket(url),
        getLastSequence: (taskId) =>
          useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0,
        applyEvent: (event) => useAgentStore.getState().applyEvent(event),
        setConnectionStatus: (status) =>
          useAgentStore.getState().setConnectionStatus(status),
      }),
    [],
  );

  useEffect(() => () => transport.disconnect(), [transport]);

  return transport;
}
