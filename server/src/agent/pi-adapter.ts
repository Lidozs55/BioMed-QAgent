import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentEvent,
  type BioMedAgentSession,
  type BioMedAgentTool,
  type BioMedModelConfig,
  type BioMedSessionConfig,
  type RunOptions,
} from "./contracts.js";

type Environment = Record<string, string | undefined>;

export interface PiUpstreamEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface PiUpstreamSession {
  readonly sessionId: string;
  prompt(input: string): Promise<void>;
  subscribe(listener: (event: PiUpstreamEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiAgentAdapterOptions {
  environment?: Environment;
  createUpstreamSession?: (
    config: BioMedSessionConfig,
  ) => Promise<PiUpstreamSession>;
}

interface QueueItem {
  event?: BioMedAgentEvent;
  error?: BioMedAgentError;
  done?: true;
}

class EventQueue {
  private readonly values: QueueItem[] = [];
  private readonly waiters: Array<(item: QueueItem) => void> = [];

  push(item: QueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(item);
    else waiter(item);
  }

  next(): Promise<QueueItem> {
    const item = this.values.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface ActiveTurn {
  queue: EventQueue;
  cancelled: boolean;
  terminal: boolean;
  reason?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 4_096;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;

function boundedText(value: string): string {
  return value.slice(0, MAX_TEXT);
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundedText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => boundedValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_ITEMS)
        .map(([key, item]) => [boundedText(key), boundedValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_TEXT);
}

function requireSafeId(name: string, value: string): void {
  if (!SAFE_ID.test(value)) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${name} must be a safe non-empty identifier`,
    );
  }
}

async function requireDirectory(name: string, value: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${name} must be an absolute directory`,
    );
  }
  try {
    if (!(await stat(value)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${name} must reference an existing directory`,
      { cause: error },
    );
  }
  return path.resolve(value);
}

async function validateSessionConfig(
  config: BioMedSessionConfig,
): Promise<BioMedSessionConfig> {
  requireSafeId("taskId", config.taskId);
  requireSafeId("runId", config.runId);
  const cwd = await requireDirectory("cwd", config.cwd);
  const resourceRoots = await Promise.all(
    (config.resourceRoots ?? []).map((root) => requireDirectory("resource root", root)),
  );
  const skillRoots = await Promise.all(
    (config.skillRoots ?? []).map((root) => requireDirectory("skill root", root)),
  );
  return { ...config, cwd, resourceRoots, skillRoots };
}

function modelFromEnvironment(environment: Environment): BioMedModelConfig {
  const provider = environment.PI_PROVIDER ?? "dashscope";
  const modelId = environment.PI_MODEL ?? environment.MODEL_NAME;
  const apiKey = environment.PI_API_KEY ?? environment.DASHSCOPE_API_KEY;
  const baseUrl = environment.PI_BASE_URL ?? environment.DASHSCOPE_BASE_URL;
  if (modelId === undefined || modelId.trim() === "") {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Pi model configuration is required",
    );
  }
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Pi provider credentials are required",
    );
  }
  return { provider, modelId, apiKey, baseUrl };
}

function toUpstreamEvent(event: AgentSessionEvent): PiUpstreamEvent {
  switch (event.type) {
    case "message_update":
      return {
        type: event.type,
        assistantMessageEvent: event.assistantMessageEvent,
      };
    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return { type: event.type };
  }
}

async function createRealUpstreamSession(
  config: BioMedSessionConfig,
  environment: Environment,
): Promise<PiUpstreamSession> {
  const selected = config.model ?? modelFromEnvironment(environment);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
  });
  modelRuntime.registerProvider(selected.provider, {
    api: "openai-completions",
    apiKey: selected.apiKey,
    baseUrl: selected.baseUrl,
    models: [
      {
        id: selected.modelId,
        name: selected.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 8_192,
      },
    ],
  });
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (model === undefined) {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Configured Pi model is unavailable",
    );
  }
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: path.join(config.cwd, ".pi"),
    settingsManager,
    additionalSkillPaths: [...(config.skillRoots ?? [])],
    additionalPromptTemplatePaths: [...(config.resourceRoots ?? [])],
    noExtensions: true,
    noSkills: (config.skillRoots?.length ?? 0) === 0,
    noPromptTemplates: (config.resourceRoots?.length ?? 0) === 0,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: config.cwd,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(config.cwd),
    settingsManager,
    noTools: (config.tools?.length ?? 0) > 0 ? "builtin" : "all",
    customTools: toPiCustomTools(config.tools ?? []),
  });
  return {
    sessionId: session.sessionId,
    prompt: (input) => session.prompt(input),
    subscribe(listener) {
      return session.subscribe((event) => listener(toUpstreamEvent(event)));
    },
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

export function toPiCustomTools(
  tools: readonly BioMedAgentTool[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, parameters, signal) {
      const result = await tool.execute(parameters, signal, { toolCallId: _toolCallId });
      if (result.isError === true) throw new Error(result.content);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  }));
}

class PiBioMedAgentSession implements BioMedAgentSession {
  readonly piSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  private activeTurn?: ActiveTurn;
  private readonly unsubscribe: () => void;
  private disposePromise?: Promise<void>;
  private readonly cleanup?: () => Promise<void>;

  constructor(
    private readonly upstream: PiUpstreamSession,
    config: BioMedSessionConfig,
  ) {
    this.piSessionId = upstream.sessionId;
    this.taskId = config.taskId;
    this.runId = config.runId;
    this.cleanup = config.cleanup;
    this.unsubscribe = upstream.subscribe((event) => this.handleEvent(event));
  }

  private handleEvent(event: PiUpstreamEvent): void {
    const active = this.activeTurn;
    if (active === undefined || active.terminal) return;
    const common = {
      toolCallId: boundedText(event.toolCallId ?? "unknown"),
      toolName: boundedText(event.toolName ?? "unknown"),
    };
    if (event.type === "message_update") {
      const message = event.assistantMessageEvent;
      if (message?.type === "text_delta" && message.delta !== undefined) {
        active.queue.push({
          event: { type: "assistant_delta", delta: boundedText(message.delta) },
        });
      } else if (message?.type === "thinking_delta" && message.delta !== undefined) {
        active.queue.push({
          event: { type: "reasoning_delta", delta: boundedText(message.delta) },
        });
      }
    } else if (event.type === "tool_execution_start") {
      active.queue.push({
        event: {
          type: "tool_started",
          ...common,
          arguments: boundedValue(event.args),
        },
      });
    } else if (event.type === "tool_execution_update") {
      active.queue.push({
        event: {
          type: "tool_progress",
          ...common,
          result: boundedValue(event.partialResult),
        },
      });
    } else if (event.type === "tool_execution_end") {
      active.queue.push({
        event: {
          type: "tool_completed",
          ...common,
          result: boundedValue(event.result),
          isError: event.isError === true,
        },
      });
    }
  }

  private finish(active: ActiveTurn, item: QueueItem): void {
    if (active.terminal) return;
    active.terminal = true;
    active.queue.push(item);
    active.queue.push({ done: true });
  }

  async *run(input: string, options: RunOptions = {}): AsyncIterable<BioMedAgentEvent> {
    if (this.disposePromise !== undefined) {
      throw new BioMedAgentError("SESSION_DISPOSED", "Agent session is disposed");
    }
    if (this.activeTurn !== undefined) {
      throw new BioMedAgentError("SESSION_BUSY", "Agent session already has an active turn");
    }
    if (input.trim() === "") {
      throw new BioMedAgentError(
        "INVALID_SESSION_CONFIG",
        "Agent input must not be empty",
      );
    }
    const active: ActiveTurn = {
      queue: new EventQueue(),
      cancelled: false,
      terminal: false,
    };
    this.activeTurn = active;
    const onAbort = (): void => {
      void this.cancel("aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    active.queue.push({ event: { type: "turn_started" } });
    void this.upstream.prompt(input).then(
      () => {
        if (!active.cancelled) {
          this.finish(active, { event: { type: "turn_completed" } });
        }
      },
      (error: unknown) => {
        if (!active.cancelled) {
          this.finish(active, {
            error: new BioMedAgentError(
              "UPSTREAM_FAILURE",
              "Agent runtime request failed",
              { cause: error },
            ),
          });
        }
      },
    );
    try {
      while (true) {
        const item = await active.queue.next();
        if (item.error !== undefined) throw item.error;
        if (item.done === true) break;
        if (item.event !== undefined) yield item.event;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!active.terminal) {
        active.cancelled = true;
        await this.upstream.abort();
        active.terminal = true;
      }
      if (this.activeTurn === active) this.activeTurn = undefined;
    }
  }

  async cancel(reason?: string): Promise<void> {
    const active = this.activeTurn;
    if (active === undefined || active.terminal) return;
    active.cancelled = true;
    active.reason = reason;
    try {
      await this.upstream.abort();
    } finally {
      this.finish(active, {
        event: reason === undefined
          ? { type: "turn_cancelled" }
          : { type: "turn_cancelled", reason: boundedText(reason) },
      });
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        await this.cancel("session disposed");
      } finally {
        try {
          this.unsubscribe();
          this.upstream.dispose();
        } finally {
          await this.cleanup?.();
        }
      }
    })();
    return this.disposePromise;
  }
}

export class PiAgentAdapter implements BioMedAgentAdapter {
  private readonly environment: Environment;
  private readonly createUpstreamSession: (
    config: BioMedSessionConfig,
  ) => Promise<PiUpstreamSession>;

  constructor(options: PiAgentAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.createUpstreamSession =
      options.createUpstreamSession ??
      ((config) => createRealUpstreamSession(config, this.environment));
  }

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    let validated: BioMedSessionConfig | undefined;
    try {
      validated = await validateSessionConfig(config);
      const upstream = await this.createUpstreamSession(validated);
      return new PiBioMedAgentSession(upstream, validated);
    } catch (error) {
      await (validated?.cleanup ?? config.cleanup)?.();
      if (error instanceof BioMedAgentError) throw error;
      throw new BioMedAgentError(
        "UPSTREAM_FAILURE",
        "Agent session creation failed",
        { cause: error },
      );
    }
  }
}
