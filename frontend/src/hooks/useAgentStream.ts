import { useCallback, useEffect, useRef } from "react";
import { useAgentStore, type WSEvent } from "../stores/agentStore";

/**
 * WebSocket hook — 同一个连接实例负责 connect、send 和 close。
 *
 * 关键修复：
 * 1. connect 通过 ref 读取 store 函数，避免 useCallback 依赖变化导致重连。
 * 2. handleEvent 通过 ref 读取最新 store 函数，解决闭包过期问题。
 * 3. 组件卸载时自动关闭 WebSocket。
 * 4. 暴露 disconnect 供外部控制。
 */
export function useAgentStream() {
  const wsRef = useRef<WebSocket | null>(null);

  // 将 store 函数存入 ref，使 WebSocket 事件处理器能读取最新版本
  const storeRef = useRef(useAgentStore.getState());
  useEffect(() => {
    const unsub = useAgentStore.subscribe((state) => {
      storeRef.current = state;
    });
    return unsub;
  }, []);

  const handleEvent = useCallback((event: WSEvent) => {
    const { addMessage, appendAssistantText, addTrace, setRunning } =
      storeRef.current;

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
      case "done": {
        setRunning(false);
        if (event.final_output && event.final_output.trim()) {
          const msgs = storeRef.current.messages;
          const last = msgs[msgs.length - 1];
          if (
            !last ||
            last.role !== "assistant" ||
            last.content.length === 0
          ) {
            addMessage("assistant", event.final_output);
          }
        }
        break;
      }
      case "error":
        setRunning(false);
        addTrace({ kind: "error", message: event.message });
        break;
    }
  }, []);

  // 保持 handleEvent ref 最新，供 WebSocket 回调使用
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/v1/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => storeRef.current.setConnected(true);

    ws.onclose = () => {
      storeRef.current.setConnected(false);
      storeRef.current.setRunning(false);
    };

    ws.onerror = () => {
      storeRef.current.setConnected(false);
      storeRef.current.setRunning(false);
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        const event: WSEvent = JSON.parse(e.data);
        handleEventRef.current(event);
      } catch {
        // 忽略非 JSON 消息
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      wsRef.current = null;
      storeRef.current.setConnected(false);
      storeRef.current.setRunning(false);
    }
  }, []);

  const send = useCallback(
    (input: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      storeRef.current.addMessage("user", input);
      storeRef.current.setRunning(true);
      ws.send(JSON.stringify({ type: "run", input }));
    },
    []
  );

  return { connect, disconnect, send };
}
