/** API 类型定义 */

export type TaskStatus =
  | 'created' | 'planning' | 'searching' | 'acquiring'
  | 'parsing' | 'cleaning' | 'analyzing' | 'reviewing'
  | 'completed' | 'failed';

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

export interface TaskSummary {
  task_id: string;
  research_goal: string;
  status: TaskStatus;
  total_records: number;
  avg_confidence: number;
  source_count: number;
  stages: Record<string, StageInfo>;
  entities: Entities;
  domain: string;
  errors: string[];
  created_at: string;
  completed_at: string | null;
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

export interface WSMessage {
  type: 'task_start' | 'stage_start' | 'stage_progress' | 'stage_complete'
      | 'task_complete' | 'error' | 'snapshot' | 'pong'
      | 'iteration_round' | 'iteration_decision' | 'iteration_converged';
  task_id?: string;
  stage?: string;
  message?: string;
  pct?: number;
  status?: TaskStatus;
  stages?: Record<string, StageInfo>;
  total_records?: number;
  records_count?: number;
  context?: Record<string, unknown>;
  review?: Record<string, unknown>;
  summary?: TaskSummary;
  // Iteration fields
  round?: number;
  max_rounds?: number;
  should_continue?: boolean;
  reason?: string;
  next_round_queries?: string[];
  gap_analysis?: Record<string, unknown>;
}
