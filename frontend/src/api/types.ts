/** API 类型定义 */

export type TaskStatus =
  | 'created' | 'planning' | 'searching' | 'acquiring'
  | 'parsing' | 'cleaning' | 'analyzing' | 'reviewing'
  | 'awaiting_confirmation' | 'completed' | 'failed';

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface StageInfo {
  name: string;
  status: StageStatus;
  records_count: number;
  message: string;
  started_at: string | null;
  completed_at: string | null;
  iterations: number;
}

export interface Entities {
  compounds: string[];
  genes: string[];
  diseases: string[];
  pathways: string[];
}

export interface CheckpointPayload {
  checkpoint: string;
  task_id: string;
  total_records: number;
  avg_confidence: number;
  review_quality: string;
  review_issues: string[];
  review_recommendations: string[];
  low_confidence_count: number;
}

export interface TaskSummary {
  task_id: string;
  research_goal: string;
  status: TaskStatus;
  total_records: number;
  avg_confidence: number;
  source_count: number;
  current_round: number;
  stages: Record<string, StageInfo>;
  entities: Entities;
  domain: string;
  errors: string[];
  created_at: string;
  completed_at: string | null;
  pending_checkpoint: string | null;
  checkpoint_payload: CheckpointPayload | Record<string, never>;
}

export interface DataRecord {
  record_id: string;
  task_id: string;
  fields: Record<string, unknown>;
  source_ref: {
    source_name: string;
    url?: string;
    doi?: string;
    pmid?: string;
    query?: string;
    retrieved_at?: string;
  };
  extraction_method: string;
  extraction_confidence: number;
  quality_flags: string[];
}

export interface DataResponse {
  task_id: string;
  total: number;
  limit: number;
  offset: number;
  sources: Record<string, number>;
  records: DataRecord[];
}

export interface LineageNode {
  node_id: string;
  operation_type: string;
  agent_name: string;
  tool_name: string;
  input_node_ids: string[];
  output_record_ids: string[];
  parameters: Record<string, unknown>;
  timestamp: string;
  field_provenance?: Record<string, string[]>;
}

export interface LineageGraph {
  task_id: string;
  nodes: LineageNode[];
  edges: { source: string; target: string }[];
  stats: { total_nodes: number; total_records_tracked: number };
}

/** 追查任务（方案A隐性循环：reviewer 从报告薄弱点提取） */
export interface FollowupTask {
  query: string;
  target_entities?: { genes?: string[]; compounds?: string[] };
  reason?: string;
  priority?: 'high' | 'medium' | 'low';
}

export interface WSMessage {
  type: 'task_start' | 'stage_start' | 'stage_progress' | 'stage_complete'
      | 'task_complete' | 'error' | 'snapshot' | 'pong'
      | 'followup_round'
      | 'awaiting_confirmation';
  task_id?: string;
  stage?: string;
  message?: string;
  pct?: number;
  status?: TaskStatus;
  stages?: Record<string, StageInfo>;
  total_records?: number;
  current_round?: number;
  records_count?: number;
  context?: Record<string, unknown>;
  review?: Record<string, unknown>;
  summary?: TaskSummary;
  // followup_round 事件载荷（追查循环轮次）
  round?: number;
  max_rounds?: number;
  tasks_count?: number;
  // stage_complete（review 阶段）携带的追查任务列表
  followup_tasks?: FollowupTask[];
  // awaiting_confirmation 载荷
  checkpoint?: string;
  payload?: CheckpointPayload;
}
