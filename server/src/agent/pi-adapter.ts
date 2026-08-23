import { readdir, stat } from "node:fs/promises";
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
import { PHASE1_SYSTEM_PROMPT, phase1ResourceRoots } from "./phase1-prompt.js";
import { requireSafeId as validateSafeId } from "./ids.js";

type Environment = Record<string, string | undefined>;

export interface PiUpstreamEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  assistantStopReason?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  reason?: "manual" | "threshold" | "overflow";
  aborted?: boolean;
  errorMessage?: string;
  compactionResult?: { summary: string } | undefined;
}

export interface PiUpstreamSession {
  readonly sessionId: string;
  prompt(input: string): Promise<void>;
  continueAfterLength?(): Promise<void>;
  steer?(text: string): Promise<void>;
  compact?(): Promise<{ summary: string }>;
  subscribe(listener: (event: PiUpstreamEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiAgentAdapterOptions {
  environment?: Environment;
  createUpstreamSession?: (
    config: BioMedSessionConfig,
  ) => Promise<PiUpstreamSession>;
  resolveModel?: () => Promise<BioMedModelConfig>;
  phase1SkillRoot?: string;
  onResourceDiagnostic?: (message: string) => void;
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
  pendingDelta?: Extract<
    BioMedAgentEvent,
    { type: "assistant_delta" | "reasoning_delta" }
  >;
  deltaTimer?: ReturnType<typeof setTimeout>;
  assistantStopReason?: string;
}

const MAX_TEXT = 4_096;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
const DELTA_FLUSH_INTERVAL_MS = 32;
const LENGTH_CONTINUATION_MESSAGE =
  "The previous assistant turn was truncated by the model length limit. " +
  "Continue the same task from the compacted context without repeating completed work. " +
  "Finish the remaining tool calls, required data artifacts, validation, and final response.";

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
  validateSafeId(name, value, {
    message: `${name} must be a safe non-empty identifier`,
    errorFactory: (message) => new BioMedAgentError("INVALID_SESSION_CONFIG", message),
  });
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
  const sessionDir = config.sessionDir === undefined
    ? undefined
    : await requireDirectory("session directory", config.sessionDir);
  return { ...config, cwd, resourceRoots, skillRoots, sessionDir };
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

function usesDashScopeQwen(selected: BioMedModelConfig): boolean {
  if (selected.baseUrl === undefined) return false;
  try {
    const target = new URL(selected.baseUrl);
    const modelId = selected.modelId.toLowerCase();
    return (modelId.startsWith("qwen") || modelId.startsWith("qwq")) &&
      target.hostname === "dashscope.aliyuncs.com" &&
      target.pathname.replace(/\/$/, "") === "/compatible-mode/v1";
  } catch {
    return false;
  }
}

/**
 * Translate product-level compaction ratios onto Pi's absolute compaction
 * settings. Pi compacts when context tokens exceed
 * ``contextWindow - reserveTokens`` and keeps approximately
 * ``keepRecentTokens`` tokens from the end of the conversation.
 */
export function resolvePiCompactionOverrides(
  contextWindow: number,
  triggerRatio: number,
  targetRatio: number,
): { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } {
  return {
    compaction: {
      enabled: true,
      reserveTokens: Math.max(0, Math.round(contextWindow * (1 - triggerRatio))),
      keepRecentTokens: Math.max(0, Math.round(contextWindow * targetRatio)),
    },
  };
}

export function applyModelProfileToPayload(
  payload: unknown,
  selected: BioMedModelConfig,
): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next: Record<string, unknown> = { ...payload };
  if (selected.topP !== undefined) next.top_p = selected.topP;
  if (usesDashScopeQwen(selected)) {
    if (selected.repetitionPenalty !== undefined) {
      next.repetition_penalty = selected.repetitionPenalty;
    }
    if (selected.enableSearch !== undefined) next.enable_search = selected.enableSearch;
    if (selected.thinkingMode === true) next.enable_thinking = true;
  }
  return next;
}

function toUpstreamEvent(event: AgentSessionEvent): PiUpstreamEvent {
  switch (event.type) {
    case "message_end":
      return {
        type: event.type,
        assistantStopReason:
          event.message.role === "assistant"
            ? event.message.stopReason
            : undefined,
      };
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
    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        compactionResult:
          event.result === undefined
            ? undefined
            : { summary: boundedText(event.result.summary) },
        aborted: event.aborted,
        errorMessage:
          event.errorMessage === undefined
            ? undefined
            : boundedText(event.errorMessage),
      };
    default:
      return { type: event.type };
  }
}

async function createRealUpstreamSession(
  config: BioMedSessionConfig,
  environment: Environment,
  resolveModel?: () => Promise<BioMedModelConfig>,
): Promise<PiUpstreamSession> {
  const selected = config.model ?? (resolveModel === undefined
    ? modelFromEnvironment(environment)
    : await resolveModel());
  const contextWindow = selected.contextWindow ?? 131_072;
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
  });
  modelRuntime.registerProvider(selected.provider, {
    api: "openai-completions",
    baseUrl: selected.baseUrl,
    models: [
      {
        id: selected.modelId,
        name: selected.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: selected.maxTokens ?? 8_192,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(selected.provider, selected.apiKey, {
    allowNetwork: false,
  });
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => {
    const upstreamPayload = options?.onPayload;
    return streamSimple(model, context, {
      ...options,
      maxTokens: selected.maxTokens ?? options?.maxTokens,
      temperature: selected.temperature ?? options?.temperature,
      onPayload: async (payload, payloadModel) => {
        const transformed = upstreamPayload === undefined
          ? payload
          : (await upstreamPayload(payload, payloadModel)) ?? payload;
        return applyModelProfileToPayload(transformed, selected);
      },
    });
  };
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (model === undefined) {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Configured Pi model is unavailable",
    );
  }
  const settingsManager = SettingsManager.inMemory();
  if (
    selected.compactionTriggerRatio !== undefined &&
    selected.compactionTargetRatio !== undefined
  ) {
    settingsManager.applyOverrides(resolvePiCompactionOverrides(
      contextWindow,
      selected.compactionTriggerRatio,
      selected.compactionTargetRatio,
    ));
  }
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
    systemPrompt: config.systemPrompt,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: config.cwd,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: config.sessionDir === undefined
      ? SessionManager.inMemory(config.cwd)
      : SessionManager.continueRecent(config.cwd, config.sessionDir),
    settingsManager,
    noTools: (config.tools?.length ?? 0) > 0 ? "builtin" : "all",
    customTools: toPiCustomTools(config.tools ?? []),
  });
  return {
    sessionId: session.sessionId,
    prompt: (input) => session.prompt(input),
    continueAfterLength: () => session.sendCustomMessage({
      customType: "biomed_length_continuation",
      content: LENGTH_CONTINUATION_MESSAGE,
      display: false,
    }, { triggerTurn: true }),
    steer: (text) => session.steer(text),
    compact: async () => {
      const result = await session.compact();
      return { summary: result.summary };
    },
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
        this.queueDelta(active, "assistant_delta", message.delta);
      } else if (message?.type === "thinking_delta" && message.delta !== undefined) {
        this.queueDelta(active, "reasoning_delta", message.delta);
      }
    } else if (event.type === "tool_execution_start") {
      this.pushBoundary(active, {
        event: {
          type: "tool_started",
          ...common,
          arguments: boundedValue(event.args),
        },
      });
    } else if (event.type === "tool_execution_update") {
      this.pushBoundary(active, {
        event: {
          type: "tool_progress",
          ...common,
          result: boundedValue(event.partialResult),
        },
      });
    } else if (event.type === "tool_execution_end") {
      this.pushBoundary(active, {
        event: {
          type: "tool_completed",
          ...common,
          result: boundedValue(event.result),
          isError: event.isError === true,
        },
      });
    } else if (event.type === "compaction_end") {
      const summary = event.compactionResult?.summary;
      if (event.aborted !== true && typeof summary === "string" && summary.trim() !== "") {
        this.pushBoundary(active, { event: { type: "context_compacted", summary } });
      }
    } else if (event.type === "message_end" && event.assistantStopReason !== undefined) {
      active.assistantStopReason = event.assistantStopReason;
    }
  }

  private async promptUntilComplete(active: ActiveTurn, input: string): Promise<void> {
    active.assistantStopReason = undefined;
    await this.upstream.prompt(input);
    while (!active.cancelled && active.assistantStopReason === "length") {
      if (this.upstream.continueAfterLength === undefined) {
        throw new Error("Pi runtime cannot continue a length-truncated turn");
      }
      active.assistantStopReason = undefined;
      await this.upstream.continueAfterLength();
    }
    if (!active.cancelled && active.assistantStopReason === "error") {
      throw new Error("Pi runtime ended with an upstream error");
    }
  }

  private queueDelta(
    active: ActiveTurn,
    type: "assistant_delta" | "reasoning_delta",
    rawDelta: string,
  ): void {
    const delta = boundedText(rawDelta);
    const pending = active.pendingDelta;
    if (
      pending !== undefined &&
      (pending.type !== type || pending.delta.length + delta.length > MAX_TEXT)
    ) {
      this.flushPendingDelta(active);
    }
    if (active.pendingDelta === undefined) {
      active.pendingDelta = { type, delta };
      active.deltaTimer = setTimeout(
        () => this.flushPendingDelta(active),
        DELTA_FLUSH_INTERVAL_MS,
      );
      return;
    }
    active.pendingDelta = {
      ...active.pendingDelta,
      delta: `${active.pendingDelta.delta}${delta}`,
    };
  }

  private flushPendingDelta(active: ActiveTurn): void {
    if (active.deltaTimer !== undefined) {
      clearTimeout(active.deltaTimer);
      active.deltaTimer = undefined;
    }
    const pending = active.pendingDelta;
    active.pendingDelta = undefined;
    if (pending !== undefined) active.queue.push({ event: pending });
  }

  private pushBoundary(active: ActiveTurn, item: QueueItem): void {
    this.flushPendingDelta(active);
    active.queue.push(item);
  }

  private finish(active: ActiveTurn, item: QueueItem): void {
    if (active.terminal) return;
    this.flushPendingDelta(active);
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
      void this.cancel("aborted").catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    active.queue.push({ event: { type: "turn_started" } });
    void this.promptUntilComplete(active, input).then(
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
        if (active.deltaTimer !== undefined) clearTimeout(active.deltaTimer);
        active.deltaTimer = undefined;
        active.pendingDelta = undefined;
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
    } catch (error) {
      const failure = new BioMedAgentError(
        "UPSTREAM_FAILURE",
        "Agent runtime cancellation failed",
        { cause: error },
      );
      this.finish(active, { error: failure });
      throw failure;
    }
    this.finish(active, {
      event: reason === undefined
        ? { type: "turn_cancelled" }
        : { type: "turn_cancelled", reason: boundedText(reason) },
    });
  }

  async steer(text: string): Promise<void> {
    if (this.activeTurn === undefined || this.activeTurn.terminal) {
      throw new BioMedAgentError("SESSION_BUSY", "Agent session has no active turn to steer");
    }
    if (this.upstream.steer === undefined) {
      throw new BioMedAgentError("UPSTREAM_FAILURE", "Agent runtime does not support steering");
    }
    await this.upstream.steer(text);
  }

  async compact(): Promise<{ summary: string }> {
    if (this.upstream.compact === undefined) {
      throw new BioMedAgentError("UPSTREAM_FAILURE", "Agent runtime does not support compaction");
    }
    return this.upstream.compact();
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
  private readonly phase1SkillRoot: string;
  private readonly onResourceDiagnostic: (message: string) => void;

  constructor(options: PiAgentAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.createUpstreamSession =
      options.createUpstreamSession ??
      ((config) =>
        createRealUpstreamSession(config, this.environment, options.resolveModel));
    this.phase1SkillRoot = options.phase1SkillRoot ?? phase1ResourceRoots().skillRoot;
    this.onResourceDiagnostic = options.onResourceDiagnostic ?? (() => undefined);
  }

  private async optionalSkillRoots(): Promise<string[]> {
    try {
      const info = await stat(this.phase1SkillRoot);
      if (!info.isDirectory()) throw new Error("not a directory");
      const entries = await readdir(this.phase1SkillRoot, { withFileTypes: true });
      const hasSkills = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            stat(path.join(this.phase1SkillRoot, entry.name, "SKILL.md"))
              .then(() => true)
              .catch(() => false),
          ),
      );
      if (!hasSkills.some(Boolean)) throw new Error("no skills found");
      return [path.resolve(this.phase1SkillRoot)];
    } catch {
      this.onResourceDiagnostic(
        "Optional Pi Skill resources are unavailable; continuing without them".slice(
          0,
          256,
        ),
      );
      return [];
    }
  }

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    let validated: BioMedSessionConfig | undefined;
    try {
      const optionalSkillRoots = await this.optionalSkillRoots();
      validated = await validateSessionConfig({
        ...config,
        systemPrompt: PHASE1_SYSTEM_PROMPT,
        skillRoots: [...optionalSkillRoots, ...(config.skillRoots ?? [])],
      });
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
