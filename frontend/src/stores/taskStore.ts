/** 任务状态管理 — Zustand store */
import { create } from 'zustand';
import { api } from '@/api/client';
import type { TaskSummary, WSMessage, StageInfo } from '@/api/types';

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
  // 迭代决策最新状态（达尔文 Stage Gate 量化指标 + 收敛决策）
  latestIterationDecision: WSMessage | null;
  latestStageGateEvaluation: WSMessage | null;

  // 加载状态
  loading: boolean;
  error: string | null;

  // 迭代状态 (来自 WS iteration_round / iteration_decision / iteration_converged)
  roundIdx: number;
  maxRounds: number;
  iterationDecisions: Array<{ round: number; should_continue: boolean; reason: string }>;
  convergenceReason: string;

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
  latestIterationDecision: null,
  latestStageGateEvaluation: null,
  roundIdx: 0,
  maxRounds: 3,
  iterationDecisions: [],
  convergenceReason: '',
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
      set({ selectedTaskId: null, selectedTask: null, wsMessages: [], currentStage: '', stageProgress: 0, latestIterationDecision: null, latestStageGateEvaluation: null });
      return;
    }
    set({ selectedTaskId: id, wsMessages: [], currentStage: '', stageProgress: 0, latestIterationDecision: null, latestStageGateEvaluation: null, error: null });
    try {
      const task = await api.getTask(id);
      set({ selectedTask: task });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createAndStartTask: async (goal, domainHint) => {
    set({ loading: true, error: null, wsMessages: [], roundIdx: 0, maxRounds: 3, iterationDecisions: [], convergenceReason: '' });
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
    // Handle iteration round start
    if (msg.type === 'iteration_round') {
      set({
        roundIdx: msg.round ?? 0,
        maxRounds: msg.max_rounds ?? 3,
        currentStage: '',
        stageProgress: 0,
        wsMessages: [...get().wsMessages, msg].slice(-MAX_WS_MESSAGES),
      });
      return;
    }

    // Handle iteration decision (per-round)
    if (msg.type === 'iteration_decision') {
      const decisions = [...get().iterationDecisions];
      const idx = decisions.findIndex(d => d.round === msg.round);
      const entry = {
        round: msg.round ?? 0,
        should_continue: msg.should_continue ?? false,
        reason: msg.reason ?? '',
      };
      if (idx >= 0) decisions[idx] = entry;
      else decisions.push(entry);
      set({
        iterationDecisions: decisions,
        latestIterationDecision: msg,
        wsMessages: [...get().wsMessages, msg].slice(-MAX_WS_MESSAGES),
      });
      return;
    }

    // Handle iteration convergence (all rounds done)
    if (msg.type === 'iteration_converged') {
      set({
        convergenceReason: msg.reason ?? '',
        wsMessages: [...get().wsMessages, msg].slice(-MAX_WS_MESSAGES),
      });
      return;
    }

    // Handle stage gate evaluation
    if (msg.type === 'stage_gate_evaluation') {
      set({
        latestStageGateEvaluation: msg,
        wsMessages: [...get().wsMessages, msg].slice(-MAX_WS_MESSAGES),
      });
      return;
    }

    set((state) => ({ wsMessages: [...state.wsMessages.slice(-MAX_WS_MESSAGES), msg] }));

    // 新任务开始时重置迭代状态
    if (msg.type === 'task_start') {
      set({ roundIdx: 0, iterationDecisions: [], convergenceReason: '' });
    }
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

  clearMessages: () => set({
    wsMessages: [], currentStage: '', stageProgress: 0,
    latestIterationDecision: null, latestStageGateEvaluation: null,
  }),
}));
