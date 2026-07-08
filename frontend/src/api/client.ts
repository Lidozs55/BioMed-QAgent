/** BioMed QAgent API 客户端 */
import type {
  TaskSummary, DataResponse, LineageGraph,
} from './types';

const BASE = '/api/v1';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export const api = {
  // ===== 任务 =====
  createTask: (data: {
    research_goal: string;
    domain_hint?: string;
    max_sources?: number;
    enable_analysis?: boolean;
  }) => request<TaskSummary>('/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  listTasks: () => request<{ tasks: TaskSummary[]; total: number }>('/tasks'),

  getTask: (id: string) => request<TaskSummary>(`/tasks/${id}`),

  startTask: (id: string) => request<{ status: string; task_id: string; websocket: string }>(
    `/tasks/${id}/start`, { method: 'POST' },
  ),

  deleteTask: (id: string) => request<{ status: string }>(`/tasks/${id}`, { method: 'DELETE' }),

  // ===== 数据 =====
  getTaskData: (id: string, limit = 100, offset = 0, source?: string) =>
    request<DataResponse>(`/tasks/${id}/data?limit=${limit}&offset=${offset}${source ? `&source=${source}` : ''}`),

  exportCsv: (id: string) => `${BASE}/tasks/${id}/export/csv`,
  exportJson: (id: string) => `${BASE}/tasks/${id}/export/json`,
  exportMergedCsv: (id: string) => `${BASE}/tasks/${id}/export/merged/csv`,

  // ===== 报告 =====
  getReportUrl: (id: string) => `${BASE}/tasks/${id}/report`,
  regenerateReport: (id: string) => request<{
    task_id: string; status: string;
    report_length: number; merged_csv_rows: number; records_count: number;
  }>(`/tasks/${id}/regenerate-report`, { method: 'POST' }),

  // ===== 分析结果 =====
  getAnalysis: (id: string) => request<{
    task_id: string; analysis_types: string[];
    analysis: Record<string, any>; has_results: boolean;
  }>(`/tasks/${id}/analysis`),

  // ===== 溯源 =====
  getLineage: (id: string) => request<LineageGraph>(`/tasks/${id}/lineage`),

  // ===== 反馈 =====
  submitFeedback: (id: string, payload: {
    feedback_type: string;
    message?: string;
    extra_entities?: Record<string, string[]>;
    retry_stage?: string;
  }) => request<{
    status: string; task_id: string;
    feedback_type: string; note: string;
  }>(`/tasks/${id}/feedback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  // ===== WebSocket =====
  wsUrl: (id: string) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/v1/ws/tasks/${id}`;
  },
};
