/** WebSocket Hook — 订阅任务实时进度 */
import { useEffect, useRef, useCallback } from 'react';
import { api } from '@/api/client';
import { useTaskStore } from '@/stores/taskStore';
import type { WSMessage } from '@/api/types';

export function useTaskWebSocket(taskId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const handleWSMessage = useTaskStore(s => s.handleWSMessage);
  const reconnectTimer = useRef<number>();

  const connect = useCallback((id: string) => {
    // 关闭旧连接
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const url = api.wsUrl(id);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      useTaskStore.setState({ wsConnected: true });
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch {
        // 忽略解析失败
      }
    };

    ws.onclose = () => {
      useTaskStore.setState({ wsConnected: false });
      // 自动重连（如果任务还在运行）
      const task = useTaskStore.getState().selectedTask;
      if (task && task.status !== 'completed' && task.status !== 'failed' && id === useTaskStore.getState().selectedTaskId) {
        reconnectTimer.current = window.setTimeout(() => connect(id), 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [handleWSMessage]);

  useEffect(() => {
    if (taskId) {
      connect(taskId);
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [taskId, connect]);

  // 心跳
  useEffect(() => {
    if (!taskId) return;
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('ping');
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [taskId]);

  return wsRef;
}
