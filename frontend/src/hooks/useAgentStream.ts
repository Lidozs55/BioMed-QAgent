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
    const { addMessage, appendAssistantText, addTrace, setRunning, addArtifact } =
      storeRef.current;

    switch (event.type) {
      case "task_started":
        if (event.task_id) storeRef.current.setTaskId(event.task_id);
        break;
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
        storeRef.current.setPipelineStage("done");
        setRunning(false);
        break;
      }
      case "error":
        addTrace({ kind: "error", message: event.message });
        storeRef.current.setPipelineStage("error");
        setRunning(false);
        break;
      case "skill_loaded":
        addTrace({
          kind: "tool_call",
          name: `Skill: ${event.name}`,
          arguments: `category: ${event.category || ""}`,
        });
        break;
      case "artifact_produced":
        if (event.name) {
          addArtifact(
            event.artifact_id || event.name,
            event.name,
            event.size || 0,
          );
        }
        break;
      case "file_downloaded":
        break;
      case "confirm":
        addMessage("assistant", event.confirm_message || event.message || "");
        break;
    }
  }, []);

  // 保持 handleEvent ref 最新，供 WebSocket 回调使用
  const handleEventRef = useRef(handleEvent);
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

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
    (input: string, databases?: string[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const selectedDatabases = databases ?? storeRef.current.selectedDatabases;
      storeRef.current.prepareNewTask(selectedDatabases);
      storeRef.current.addMessage("user", input);
      storeRef.current.setPipelineStage("setup");
      storeRef.current.setRunning(true);
      const payload: Record<string, unknown> = { type: "run", input };
      if (selectedDatabases.length > 0) payload.databases = selectedDatabases;
      ws.send(JSON.stringify(payload));
    },
    []
  );

  return { connect, disconnect, send };
}
