import { useCallback, useRef } from "react";
import { useAgentStore, type WSEvent } from "../stores/agentStore";

/** WebSocket hook — 连接后端 Agent loop，收发事件。 */
export function useAgentStream() {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    addMessage,
    appendAssistantText,
    addTrace,
    setConnected,
    setRunning,
  } = useAgentStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/v1/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setRunning(false);
    };
    ws.onerror = () => {
      setConnected(false);
      setRunning(false);
    };
    ws.onmessage = (e) => {
      try {
        const event: WSEvent = JSON.parse(e.data);
        handleEvent(event);
      } catch {
        // 忽略非 JSON
      }
    };
  }, [addMessage, appendAssistantText, addTrace, setConnected, setRunning]);

  const handleEvent = useCallback(
    (event: WSEvent) => {
      switch (event.type) {
        case "text":
          if (event.delta) appendAssistantText(event.delta);
          break;
        case "tool_call":
          addTrace({
            kind: "tool_call",
            name: event.name,
            arguments: event.arguments,
          });
          break;
        case "tool_output":
          addTrace({
            kind: "tool_output",
            output: event.output,
          });
          break;
        case "done":
          setRunning(false);
          if (event.final_output && event.final_output.trim()) {
            // 如果之前没有流式 text 事件，用 final_output 兜底
            const msgs = useAgentStore.getState().messages;
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant" || last.content.length === 0) {
              addMessage("assistant", event.final_output);
            }
          }
          break;
        case "error":
          setRunning(false);
          addTrace({ kind: "error", message: event.message });
          break;
      }
    },
    [addMessage, appendAssistantText, addTrace, setRunning]
  );

  const send = useCallback(
    (input: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      addMessage("user", input);
      setRunning(true);
      // 清空上一轮 assistant 消息占位（由 appendAssistantText 重建）
      ws.send(JSON.stringify({ type: "run", input }));
    },
    [addMessage, setRunning]
  );

  return { connect, send };
}
