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

/** Iteration round info from WS iteration_round event */
export interface IterationInfo {
  round: number;
  max_rounds: number;
  status: 'running' | 'completed' | 'converged';
}

/** Iteration decision from WS iteration_decision event */
export interface IterationDecision {
  round: number;
  should_continue: boolean;
  reason: string;
  next_round_queries?: string[];
  gap_analysis?: Record<string, unknown>;
}

/** Stage Gate 量化评估指标（stage_gate_evaluation 载荷） */
export interface StageGateMetrics {
  coverage: number;          // 0-1，关键实体覆盖率
  avg_confidence: number;    // 0-1，平均抽取置信度
  conflict_rate: number;     // 0-1，冲突记录占比
  source_diversity: number;  // 不同数据源数量
  record_count?: number;
  entity_coverage?: Record<string, { covered: string[]; missing: string[] }>;
}

export interface StageGateSuggestion {
  action: 'expand_search' | 'add_source' | 'deepen_analysis'
        | 'refine_keywords' | 'request_user_input' | string;
  reason?: string;
  query?: string;
  source?: string;
  analysis?: string;
  [key: string]: unknown;
}

export interface WSMessage {
  type: 'task_start' | 'stage_start' | 'stage_progress' | 'stage_complete'
      | 'task_complete' | 'error' | 'snapshot' | 'pong'
      | 'iteration_round' | 'iteration_decision' | 'iteration_converged'
      | 'stage_gate_evaluation' | 'awaiting_confirmation';
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
  // 迭代决策事件载荷（iteration_round / iteration_decision / iteration_converged）
  round?: number;
  max_rounds?: number;
  should_continue?: boolean;
  reason?: string;
  next_round_queries?: string[];
  gap_analysis?: Record<string, unknown>;
  target_entities?: string[];
  convergence_signals?: string[];
  needs_user_input?: boolean;
  // awaiting_confirmation 载荷
  checkpoint?: string;
  payload?: CheckpointPayload;
  // Stage Gate 量化评估载荷（stage_gate_evaluation）
  passed?: boolean;
  metrics?: StageGateMetrics;
  suggestions?: StageGateSuggestion[];
}
