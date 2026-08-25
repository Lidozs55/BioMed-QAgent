export type BioMedAgentErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_SESSION_CONFIG"
  | "SESSION_BUSY"
  | "SESSION_DISPOSED"
  | "DUPLICATE_RUN"
  | "RUN_NOT_FOUND"
  | "UPSTREAM_FAILURE";

export class BioMedAgentError extends Error {
  readonly code: BioMedAgentErrorCode;

  constructor(code: BioMedAgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BioMedAgentError";
    this.code = code;
  }
}

export type BioMedAgentEvent =
  | { type: "turn_started" }
  | { type: "assistant_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: "tool_progress";
      toolCallId: string;
      toolName: string;
      result: unknown;
    }
  | {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "turn_completed" }
  | { type: "turn_cancelled"; reason?: string }
  | { type: "context_compacted"; summary: string }
  | {
      type: "context_usage";
      tokens: number | null;
      contextWindow: number;
      percent: number | null;
      source: "runtime";
    };

export interface BioMedToolResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

export interface BioMedToolExecutionContext {
  toolCallId: string;
}

export interface BioMedAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute: (
    argumentsValue: unknown,
    signal?: AbortSignal,
    context?: BioMedToolExecutionContext,
  ) => Promise<BioMedToolResult>;
}

export interface BioMedModelConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Auto-compaction trigger ratio of the context window (settings-derived). */
  compactionTriggerRatio?: number;
  /** Auto-compaction target ratio of the context window (settings-derived). */
  compactionTargetRatio?: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
  enableSearch?: boolean;
  thinkingMode?: boolean;
}

export interface BioMedSessionConfig {
  taskId: string;
  runId: string;
  cwd: string;
  sessionDir?: string;
  model?: BioMedModelConfig;
  resourceRoots?: readonly string[];
  skillRoots?: readonly string[];
  systemPrompt?: string;
  tools?: readonly BioMedAgentTool[];
  /** Tools whose full schemas are available on the first model turn. */
  initialToolNames?: readonly string[];
  cleanup?: () => Promise<void>;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface BioMedAgentSession {
  readonly piSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  run(input: string, options?: RunOptions): AsyncIterable<BioMedAgentEvent>;
  steer?(text: string): Promise<void>;
  compact?(): Promise<{ summary: string }>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface BioMedAgentAdapter {
  createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession>;
}
