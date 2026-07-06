/** 任务状态管理 — Zustand store */
import { create } from 'zustand';
import { api } from '@/api/client';
import type { TaskSummary, WSMessage, StageInfo } from '@/api/types';

interface TaskStore {
  // 任务列表
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  selectedTask: TaskSummary | null;

  // 实时状态
  wsConnected: boolean;
  wsMessages: WSMessage[];
  currentStage: string;
  stageProgress: number;

  // 加载状态
  loading: boolean;
  error: string | null;

  // 动作
  fetchTasks: () => Promise<void>;
  selectTask: (id: string | null) => Promise<void>;
  createAndStartTask: (goal: string, domainHint?: string) => Promise<string | null>;
  deleteTask: (id: string) => Promise<void>;
  handleWSMessage: (msg: WSMessage) => void;
  clearMessages: () => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  selectedTask: null,
  wsConnected: false,
  wsMessages: [],
  currentStage: '',
  stageProgress: 0,
  loading: false,
  error: null,

  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const { tasks } = await api.listTasks();
      set({ tasks, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  selectTask: async (id) => {
    if (!id) {
      set({ selectedTaskId: null, selectedTask: null, wsMessages: [], currentStage: '', stageProgress: 0 });
      return;
    }
    set({ selectedTaskId: id, wsMessages: [], currentStage: '', stageProgress: 0, error: null });
    try {
      const task = await api.getTask(id);
      set({ selectedTask: task });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createAndStartTask: async (goal, domainHint) => {
    set({ loading: true, error: null, wsMessages: [] });
    try {
      const task = await api.createTask({
        research_goal: goal,
        domain_hint: domainHint,
        max_sources: 15,
        enable_analysis: true,
      });
      await api.startTask(task.task_id);
      set({
        selectedTaskId: task.task_id,
        selectedTask: task,
        loading: false,
      });
      // 刷新列表（将新任务加入列表顶部）
      get().fetchTasks();
      return task.task_id;
    } catch (e) {
      set({ loading: false, error: String(e) });
      return null;
    }
  },

  deleteTask: async (id) => {
    try {
      await api.deleteTask(id);
      const { tasks, selectedTaskId } = get();
      set({
        tasks: tasks.filter(t => t.task_id !== id),
        selectedTaskId: selectedTaskId === id ? null : selectedTaskId,
        selectedTask: selectedTaskId === id ? null : get().selectedTask,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  handleWSMessage: (msg) => {
    set((state) => ({ wsMessages: [...state.wsMessages.slice(-200), msg] }));

    if (msg.type === 'stage_start' || msg.type === 'stage_complete') {
      set({ currentStage: msg.stage || '' });
    }
    if (msg.type === 'stage_progress' && msg.pct !== undefined) {
      set({ stageProgress: msg.pct });
    }
    if (msg.type === 'snapshot' && msg.stages) {
      // 找到当前运行中的阶段
      const running = Object.entries(msg.stages).find(([, s]) => s.status === 'running');
      if (running) {
        set({ currentStage: running[0] });
      }
    }
    // 任务完成、错误或阶段完成时自动刷新 selectedTask
    if (msg.type === 'task_complete' || msg.type === 'error' ||
        (msg.type === 'stage_complete' && msg.stage)) {
      const tid = msg.task_id || get().selectedTaskId;
      if (tid) {
        api.getTask(tid).then(task => set({ selectedTask: task })).catch(() => {});
        get().fetchTasks();
      }
    }
  },

  clearMessages: () => set({ wsMessages: [], currentStage: '', stageProgress: 0 }),
}));
