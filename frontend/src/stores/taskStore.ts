/** 任务状态管理 — Zustand store */
import { create } from 'zustand';
import { api } from '@/api/client';
import type { TaskSummary, WSMessage, FollowupTask } from '@/api/types';

const MAX_WS_MESSAGES = 200;

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

  // 追查循环状态（方案A隐性循环：来自 WS followup_round 事件）
  followupRoundIdx: number;
  maxFollowupRounds: number;
  followupTasks: FollowupTask[];

  // 动作
  fetchTasks: () => Promise<void>;
  selectTask: (id: string | null) => Promise<void>;
  createAndStartTask: (goal: string, domainHint?: string) => Promise<string | null>;
  deleteTask: (id: string) => Promise<void>;
  confirmTask: (id: string, decision: 'approve' | 'reject', fromStage?: string) => Promise<void>;
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
  followupRoundIdx: 0,
  maxFollowupRounds: 3,
  followupTasks: [],

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
    set({ loading: true, error: null, wsMessages: [], followupRoundIdx: 0, maxFollowupRounds: 3, followupTasks: [] });
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

  confirmTask: async (id, decision, fromStage) => {
    set({ loading: true, error: null });
    try {
      await api.confirmTask(id, decision, fromStage);
      const task = await api.getTask(id);
      set({ selectedTask: task, loading: false });
      get().fetchTasks();
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  handleWSMessage: (msg) => {
    // 心跳 pong 不进入展示列表
    if (msg.type === 'pong') return;

    // Handle followup round (方案A隐性循环：追查轮次)
    if (msg.type === 'followup_round') {
      set({
        followupRoundIdx: msg.round ?? 0,
        maxFollowupRounds: msg.max_rounds ?? 3,
        currentStage: '',
        stageProgress: 0,
        wsMessages: [...get().wsMessages, msg].slice(-MAX_WS_MESSAGES),
      });
      return;
    }

    set((state) => ({ wsMessages: [...state.wsMessages.slice(-MAX_WS_MESSAGES), msg] }));

    // 新任务开始时重置追查状态
    if (msg.type === 'task_start') {
      set({ followupRoundIdx: 0, followupTasks: [] });
    }
    if (msg.type === 'stage_start' || msg.type === 'stage_complete') {
      set({ currentStage: msg.stage || '' });
    }
    // review 阶段完成时提取追查任务列表
    if (msg.type === 'stage_complete' && msg.stage === 'review' && msg.followup_tasks) {
      set({ followupTasks: msg.followup_tasks });
    }
    if (msg.type === 'stage_progress' && msg.pct !== undefined) {
      set({ stageProgress: msg.pct });
    }
    if (msg.type === 'snapshot' && msg.stages) {
      const running = Object.entries(msg.stages).find(([, s]) => s.status === 'running');
      if (running) {
        set({ currentStage: running[0] });
      }
      // 从 snapshot 恢复追查轮次（WS 重连后）
      if (msg.current_round && msg.current_round > 0) {
        set({ followupRoundIdx: msg.current_round > 1 ? msg.current_round - 1 : 0 });
      }
    }
    // 任务完成、错误、等待确认或阶段完成时自动刷新 selectedTask
    if (msg.type === 'task_complete' || msg.type === 'error' ||
        msg.type === 'awaiting_confirmation' ||
        (msg.type === 'stage_complete' && msg.stage)) {
      const tid = msg.task_id || get().selectedTaskId;
      if (tid) {
        api.getTask(tid).then(task => set({ selectedTask: task })).catch(() => {});
        get().fetchTasks();
      }
    }
  },

  clearMessages: () => set({
    wsMessages: [], currentStage: '', stageProgress: 0,
    followupRoundIdx: 0, followupTasks: [],
  }),
}));
