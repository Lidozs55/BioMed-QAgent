import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type InlineExtension,
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
import {
  RunProgressContextTracker,
  runProgressContextMessage,
} from "./run-progress-context.js";
import { SKILL_TOOL_MAP } from "./skills/skill-tool-map.js";

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
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface PiUpstreamSession {
  readonly sessionId: string;
  prompt(input: string): Promise<void>;
  resetRunProgress?(): void;
  continueAfterLength?(): Promise<void>;
  steer?(text: string): Promise<void>;
  compact?(): Promise<{ summary: string }>;
  /**
   * Reconcile the session with the currently active product model config.
   * Called before every prompt and before manual compaction so a mid-task
   * model switch (which may change the context window) is always reflected in
   * the Pi model registry, session model, and compaction budgets.
   */
  reconcileConfig?(): Promise<void>;
  /** Current session context usage (token estimate and window percent). */
  contextUsage?(): { tokens: number | null; percent: number | null } | undefined;
  getContextUsage?(): {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
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
  reasoningChars: number;
  assistantChars: number;
  toolEvents: number;
  lengthContinuationStalls: number;
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
// Guard against a pathological length loop: three continuations with almost no
// new assistant/reasoning/tool progress indicate a degenerate configuration.
const MAX_STALLED_LENGTH_CONTINUATIONS = 3;
const MIN_PROGRESS_CHARS = 32;
/** Minimum recent context kept after compaction, as a fraction of the window. */
const MIN_KEEP_RATIO = 0.05;
/** Maximum final compaction target, as a fraction of the window. */
const MAX_KEEP_RATIO = 0.6;
/** Fraction of the Pi reserve budget available to the compaction summary. */
const SUMMARY_BUDGET_RATIO = 0.8;
/** Manual compaction keeps only a tiny recent tail so Pi always has older content to summarize. */
const MANUAL_KEEP_RECENT_RATIO = 0.01;
const LENGTH_CONTINUATION_MESSAGE =
  "The previous assistant turn was truncated by the model length limit. " +
  "Continue the same task from the compacted context without repeating completed work. " +
  "Finish the remaining tool calls, required data artifacts, validation, and final response.";
export const TOOL_ACTIVATION_NAME = "activate_agent_tools";
const MAX_ACTIVATED_TOOLS = 12;

function runProgressContextExtension(
  tracker: RunProgressContextTracker,
): InlineExtension {
  return {
    name: "biomed-run-progress",
    hidden: true,
    factory(pi) {
      pi.on("tool_execution_start", (event) => {
        tracker.toolStarted(event.toolCallId, event.toolName);
      });
      pi.on("tool_execution_end", (event) => {
        tracker.toolCompleted(event.toolCallId, event.toolName, event.isError);
      });
      pi.on("context", (event) => ({
        messages: [...event.messages, runProgressContextMessage(tracker)],
      }));
    },
  };
}

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

export function toolCatalogPrompt(
  tools: readonly BioMedAgentTool[],
  initialToolNames: readonly string[],
): string {
  if (tools.length === 0) return "";
  const initial = new Set(initialToolNames);
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const mappedToolNames = new Set<string>();
  const skillEntries = SKILL_TOOL_MAP.flatMap((skill) => {
    const skillTools = skill.tools.filter((name) => available.has(name));
    if (skillTools.length === 0) return [];
    for (const name of skillTools) mappedToolNames.add(name);
    const toolList = skillTools
      .map((name) => `${name}${initial.has(name) ? " (active)" : ""}`)
      .join(", ");
    return [
      `- ${skill.name} [${skill.category}]`,
      `  Function: ${skill.description}`,
      `  Route/boundary: ${skill.routing}`,
      `  Tools: ${toolList}`,
    ];
  });
  const otherTools = tools
    .filter((tool) => !mappedToolNames.has(tool.name))
    .map((tool) => {
      const summary = tool.description.replace(/\s+/g, " ").trim().slice(0, 180);
      return `- ${tool.name}${initial.has(tool.name) ? " (active)" : ""}: ${summary}`;
    });
  return [
    "",
    "Available curated skill/tool map (complete for this session):",
    "Use it before substantive work to choose the route and respect each trust boundary.",
    "Tools marked (active) have full schemas now. For other listed tools, call activate_agent_tools before use; activation does not bypass permissions, validation, or publication gates.",
    ...skillEntries,
    ...(otherTools.length === 0
      ? []
      : [
          "Other optional tools (not owned by a curated biomedical skill):",
          ...otherTools,
        ]),
  ].join("\n");
}

export function activationToolDefinition(
  tools: readonly BioMedAgentTool[],
  initialToolNames: readonly string[],
  setActiveTools: (names: readonly string[]) => void,
): ToolDefinition {
  const allNames = new Set(tools.map((tool) => tool.name));
  const initial = [...new Set(initialToolNames)].filter((name) => allNames.has(name));
  const optional = tools
    .filter((tool) => !initial.includes(tool.name))
    .map((tool) => tool.name)
    .sort();
  const activated = new Set<string>();
  return {
    name: TOOL_ACTIVATION_NAME,
    label: "Activate Agent Tools",
    description:
      "Add a bounded set of optional tools for the next model turn. Previously activated tools and Dataset Core tools remain available.",
    parameters: {
      type: "object",
      properties: {
        tool_names: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ACTIVATED_TOOLS,
          items: { type: "string", enum: optional },
        },
      },
      required: ["tool_names"],
      additionalProperties: false,
    },
    async execute(_toolCallId, parameters) {
      const record = parameters as Record<string, unknown>;
      const requested = Array.isArray(record.tool_names)
        ? record.tool_names.filter((name): name is string => typeof name === "string")
        : [];
      const selected = [...new Set(requested)].filter((name) => optional.includes(name));
      const unknown = [...new Set(requested)].filter((name) => !optional.includes(name));
      if (selected.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: "tool_names must contain an optional catalog tool" }),
          }],
          details: { ok: false, unknown_tools: unknown },
        };
      }
      for (const name of selected) activated.add(name);
      const activeOptional = optional.filter((name) => activated.has(name));
      setActiveTools([...initial, TOOL_ACTIVATION_NAME, ...activeOptional]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            activated_tools: selected,
            active_optional_tools: activeOptional,
            unknown_tools: unknown,
            next_turn: true,
          }),
        }],
        details: {
          ok: true,
          activated_tools: selected,
          active_optional_tools: activeOptional,
          unknown_tools: unknown,
          next_turn: true,
        },
      };
    },
  };
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
  currentTokens?: number | null,
): { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } {
  const reserveTokens = Math.max(0, Math.round(contextWindow * (1 - triggerRatio)));
  // Pi caps the compaction summary at 80% of the reserve budget; pre-reserve
  // that headroom so a dense summary never displaces the recent context.
  const summaryBudget = Math.round(SUMMARY_BUDGET_RATIO * reserveTokens);
  const floorKeep = Math.round(contextWindow * MIN_KEEP_RATIO);
  const capKeep = Math.round(contextWindow * MAX_KEEP_RATIO);
  const hasKnownUsage = currentTokens !== null &&
    currentTokens !== undefined &&
    Number.isFinite(currentTokens) &&
    currentTokens > 0;
  const finalTarget = hasKnownUsage
    ? Math.min(Math.max(Math.round(currentTokens * targetRatio), floorKeep), capKeep)
    : Math.min(Math.max(Math.round(contextWindow * targetRatio), floorKeep), capKeep);
  const desiredKeep = Math.max(floorKeep, finalTarget - summaryBudget);
  const keptRecent = Math.min(
    desiredKeep,
    Math.max(0, contextWindow - reserveTokens),
  );
  // When the whole conversation already fits under the final target, Pi would
  // keep everything anyway; leave its settings in the no-op range.
  const effectiveKeep = hasKnownUsage && currentTokens <= finalTarget
    ? Math.max(currentTokens, keptRecent)
    : keptRecent;
  return {
    compaction: {
      enabled: true,
      reserveTokens,
      keepRecentTokens: effectiveKeep,
    },
  };
}

/**
 * Manual compaction forces a small recent tail even when the automatic keep
 * budget would leave Pi with zero messages to summarize below the threshold.
 */
export function resolveManualPiCompactionOverrides(
  contextWindow: number,
  triggerRatio: number,
  targetRatio: number,
  currentTokens?: number | null,
): { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } {
  const auto = resolvePiCompactionOverrides(
    contextWindow,
    triggerRatio,
    targetRatio,
    currentTokens,
  );
  const hasKnownUsage = currentTokens !== null &&
    currentTokens !== undefined &&
    Number.isFinite(currentTokens) &&
    currentTokens > 0;
  const keepRecentTokens = hasKnownUsage
    ? Math.max(1, Math.round(currentTokens * MANUAL_KEEP_RECENT_RATIO))
    : 1;
  return {
    compaction: {
      ...auto.compaction,
      keepRecentTokens,
    },
  };
}

/**
 * Whether a freshly resolved product config requires re-applying the Pi
 * session model / context window / compaction budgets.
 */
export function shouldReconfigureSession(
  current: BioMedModelConfig,
  next: BioMedModelConfig,
): boolean {
  const windowOf = (config: BioMedModelConfig): number => config.contextWindow ?? 131_072;
  return (
    current.provider !== next.provider ||
    current.modelId !== next.modelId ||
    current.baseUrl !== next.baseUrl ||
    windowOf(current) !== windowOf(next) ||
    current.compactionTriggerRatio !== next.compactionTriggerRatio ||
    current.compactionTargetRatio !== next.compactionTargetRatio
  );
}

export function applyModelProfileToPayload(
  payload: unknown,
  selected: BioMedModelConfig,
): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next: Record<string, unknown> = { ...payload };
  const dashScopeQwen = usesDashScopeQwen(selected);
  for (const [key, value] of Object.entries(selected.params ?? {})) {
    if (value === undefined) continue;
    if (key === "top_logprobs" && selected.params?.logprobs !== true) continue;
    if (key === "max_tokens" || key === "temperature" || key === "top_p") continue;
    if (key === "context_window" || key === "max_output_tokens" ||
        key === "suggested_max_tokens" || key === "capabilities") continue;
    if (dashScopeQwen &&
        (key === "repetition_penalty" || key === "enable_search" ||
         key === "thinking_mode" || key === "enable_thinking")) continue;
    next[key] = key === "thinking" && typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value) as unknown;
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? parsed
              : value;
          } catch {
            return value;
          }
        })()
      : value;
  }
  if (selected.topP !== undefined) next.top_p = selected.topP;
  if (dashScopeQwen) {
    if (selected.repetitionPenalty !== undefined) {
      next.repetition_penalty = selected.repetitionPenalty;
    }
    if (selected.enableSearch !== undefined) next.enable_search = selected.enableSearch;
    if (selected.thinkingMode !== undefined) next.enable_thinking = selected.thinkingMode;
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
  let current = config.model ?? (resolveModel === undefined
    ? modelFromEnvironment(environment)
    : await resolveModel());
  const currentWindow = (): number => current.contextWindow ?? 131_072;
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
  });
  modelRuntime.registerProvider(current.provider, {
    api: "openai-completions",
    baseUrl: current.baseUrl,
    models: [
      {
        id: current.modelId,
        name: current.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: currentWindow(),
        maxTokens: current.maxTokens ?? 8_192,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(current.provider, current.apiKey, {
    allowNetwork: false,
  });
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => {
    const upstreamPayload = options?.onPayload;
    return streamSimple(model, context, {
      ...options,
      maxTokens: current.maxTokens ?? options?.maxTokens,
      temperature: current.temperature ?? options?.temperature,
      onPayload: async (payload, payloadModel) => {
        const transformed = upstreamPayload === undefined
          ? payload
          : (await upstreamPayload(payload, payloadModel)) ?? payload;
        return applyModelProfileToPayload(transformed, current);
      },
    });
  };
  const model = modelRuntime.getModel(current.provider, current.modelId);
  if (model === undefined) {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Configured Pi model is unavailable",
    );
  }
  const settingsManager = SettingsManager.inMemory();
  if (
    current.compactionTriggerRatio !== undefined &&
    current.compactionTargetRatio !== undefined
  ) {
    settingsManager.applyOverrides(resolvePiCompactionOverrides(
      currentWindow(),
      current.compactionTriggerRatio,
      current.compactionTargetRatio,
      null,
    ));
  }
  const runProgressTracker = config.getBuildResult === undefined
    ? undefined
    : new RunProgressContextTracker(config.getBuildResult);
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
    extensionFactories: runProgressTracker === undefined
      ? []
      : [runProgressContextExtension(runProgressTracker)],
  });
  await resourceLoader.reload();
  const configuredTools = config.tools ?? [];
  const allToolNames = configuredTools.map((tool) => tool.name);
  const initialToolNames = config.initialToolNames === undefined
    ? allToolNames
    : [...new Set(config.initialToolNames)].filter((name) => allToolNames.includes(name));
  const piSessionRef: {
    current?: Awaited<ReturnType<typeof createAgentSession>>["session"];
  } = {};
  const activationTool = activationToolDefinition(
    configuredTools,
    initialToolNames,
    (names) => piSessionRef.current?.setActiveToolsByName([...names]),
  );
  const customTools = configuredTools.length === 0
    ? []
    : [...toPiCustomTools(configuredTools), activationTool];
  const allowedToolNames = configuredTools.length === 0
    ? []
    : [...allToolNames, TOOL_ACTIVATION_NAME];
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
    tools: allowedToolNames,
    customTools,
  });
  piSessionRef.current = session;
  if (configuredTools.length > 0) {
    session.setActiveToolsByName([...initialToolNames, TOOL_ACTIVATION_NAME]);
  }
  const reconcileConfig = resolveModel === undefined
    ? undefined
    : async (): Promise<void> => {
      const next = await resolveModel();
      if (!shouldReconfigureSession(current, next)) {
        if (current.apiKey !== next.apiKey) {
          await modelRuntime.setRuntimeApiKey(next.provider, next.apiKey, {
            allowNetwork: false,
          });
        }
      } else {
        modelRuntime.registerProvider(next.provider, {
          api: "openai-completions",
          baseUrl: next.baseUrl,
          models: [
            {
              id: next.modelId,
              name: next.modelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: next.contextWindow ?? 131_072,
              maxTokens: next.maxTokens ?? 8_192,
            },
          ],
        });
        await modelRuntime.setRuntimeApiKey(next.provider, next.apiKey, {
          allowNetwork: false,
        });
        const nextModel = modelRuntime.getModel(next.provider, next.modelId);
        if (nextModel === undefined) {
          throw new BioMedAgentError(
            "INVALID_CONFIGURATION",
            "Configured Pi model is unavailable",
          );
        }
        await session.setModel(nextModel);
      }
      if (
        next.compactionTriggerRatio !== undefined &&
        next.compactionTargetRatio !== undefined
      ) {
        const usage = session.getContextUsage();
        settingsManager.applyOverrides(resolvePiCompactionOverrides(
          next.contextWindow ?? 131_072,
          next.compactionTriggerRatio,
          next.compactionTargetRatio,
          usage?.tokens ?? null,
        ));
      }
      current = next;
    };
  return {
    sessionId: session.sessionId,
    prompt: (input) => session.prompt(input),
    resetRunProgress: () => runProgressTracker?.reset(),
    continueAfterLength: () => session.sendCustomMessage({
      customType: "biomed_length_continuation",
      content: LENGTH_CONTINUATION_MESSAGE,
      display: false,
    }, { triggerTurn: true }),
    steer: (text) => session.steer(text),
    compact: async () => {
      const usage = session.getContextUsage();
      const autoOverrides =
        current.compactionTriggerRatio !== undefined &&
        current.compactionTargetRatio !== undefined
          ? resolvePiCompactionOverrides(
              currentWindow(),
              current.compactionTriggerRatio,
              current.compactionTargetRatio,
              usage?.tokens ?? null,
            )
          : undefined;
      const manualOverrides = autoOverrides === undefined
        ? undefined
        : current.compactionTriggerRatio !== undefined &&
            current.compactionTargetRatio !== undefined
          ? resolveManualPiCompactionOverrides(
              currentWindow(),
              current.compactionTriggerRatio,
              current.compactionTargetRatio,
              usage?.tokens ?? null,
            )
          : undefined;
      if (manualOverrides !== undefined) {
        settingsManager.applyOverrides(manualOverrides);
      }
      try {
        const result = await session.compact();
        return { summary: result.summary };
      } finally {
        if (autoOverrides !== undefined) {
          settingsManager.applyOverrides(autoOverrides);
        }
      }
    },
    getContextUsage: () => session.getContextUsage(),
    reconcileConfig,
    contextUsage: () => {
      const usage = session.getContextUsage();
      return usage === undefined
        ? undefined
        : { tokens: usage.tokens, percent: usage.percent };
    },
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = toUpstreamEvent(event);
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = session.getContextUsage();
          listener(usage === undefined ? mapped : { ...mapped, contextUsage: usage });
          return;
        }
        if (event.type === "compaction_end") {
          const usage = session.getContextUsage();
          listener(usage === undefined ? mapped : { ...mapped, contextUsage: usage });
          return;
        }
        listener(mapped);
      });
    },
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

export interface OneShotTextGenerationInput {
  model: BioMedModelConfig;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Runs a tool-free, one-shot model turn for control-plane workflows while
 * keeping Pi/model-provider details inside the adapter boundary.
 */
export async function generateOneShotText(
  input: OneShotTextGenerationInput,
): Promise<string> {
  if (input.systemPrompt.trim() === "" || input.prompt.trim() === "") {
    throw new TypeError("One-shot model prompts must not be empty");
  }
  const upstream = await createRealUpstreamSession({
    taskId: "skill_iteration",
    runId: "run_skill_iteration",
    cwd: input.cwd,
    model: input.model,
    systemPrompt: input.systemPrompt,
    skillRoots: [],
    resourceRoots: [],
    tools: [],
  }, process.env);
  let output = "";
  let reasoningChars = 0;
  let lengthContinuationStalls = 0;
  let stopReason: string | undefined;
  const unsubscribe = upstream.subscribe((event) => {
    const message = event.assistantMessageEvent;
    if (event.type === "message_update" && message?.type === "text_delta") {
      output += message.delta ?? "";
      if (output.length > 100_000) void upstream.abort();
    } else if (event.type === "message_update" && message?.type === "thinking_delta") {
      reasoningChars += (message.delta ?? "").length;
    } else if (event.type === "message_end") {
      stopReason = event.assistantStopReason;
    }
  });
  const abort = (): void => {
    void upstream.abort();
  };
  const isAborted = (): boolean => input.signal?.aborted === true;
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (isAborted()) throw new Error("Model generation was cancelled");
    await upstream.prompt(input.prompt);
    while (stopReason === "length") {
      if (upstream.continueAfterLength === undefined) {
        throw new Error("Model generation was truncated");
      }
      const beforeOutput = output.length;
      const beforeReasoning = reasoningChars;
      stopReason = undefined;
      await upstream.continueAfterLength();
      const madeProgress =
        output.length > beforeOutput ||
        reasoningChars - beforeReasoning >= MIN_PROGRESS_CHARS;
      if (!madeProgress) {
        lengthContinuationStalls += 1;
        if (lengthContinuationStalls >= MAX_STALLED_LENGTH_CONTINUATIONS) {
          throw new Error("Model length continuation made no meaningful progress");
        }
      } else {
        lengthContinuationStalls = 0;
      }
    }
    if (isAborted()) throw new Error("Model generation was cancelled");
    if (stopReason === "error") throw new Error("Model generation failed upstream");
    if (output.length > 100_000) throw new Error("Model generation exceeded the output limit");
    if (output.trim() === "") throw new Error("Model generation returned no text");
    return output;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    upstream.dispose();
  }
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
      active.toolEvents += 1;
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
      active.toolEvents += 1;
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
      if (event.contextUsage !== undefined) {
        this.pushBoundary(active, {
          event: {
            type: "context_usage",
            tokens: event.contextUsage.tokens,
            contextWindow: event.contextUsage.contextWindow,
            percent: event.contextUsage.percent,
            source: "runtime",
          },
        });
      }
    } else if (event.type === "message_end" && event.assistantStopReason !== undefined) {
      active.assistantStopReason = event.assistantStopReason;
      if (event.contextUsage !== undefined) {
        this.pushBoundary(active, {
          event: {
            type: "context_usage",
            tokens: event.contextUsage.tokens,
            contextWindow: event.contextUsage.contextWindow,
            percent: event.contextUsage.percent,
            source: "runtime",
          },
        });
      }
    }
  }

  private async promptUntilComplete(active: ActiveTurn, input: string): Promise<void> {
    active.assistantStopReason = undefined;
    await this.upstream.prompt(input);
    while (!active.cancelled && active.assistantStopReason === "length") {
      if (this.upstream.continueAfterLength === undefined) {
        throw new Error("Pi runtime cannot continue a length-truncated turn");
      }
      const beforeReasoning = active.reasoningChars;
      const beforeAssistant = active.assistantChars;
      const beforeTools = active.toolEvents;
      active.assistantStopReason = undefined;
      await this.upstream.continueAfterLength();
      const madeProgress =
        active.assistantChars > beforeAssistant ||
        active.reasoningChars - beforeReasoning >= MIN_PROGRESS_CHARS ||
        active.toolEvents > beforeTools;
      if (!madeProgress) {
        active.lengthContinuationStalls += 1;
        if (active.lengthContinuationStalls >= MAX_STALLED_LENGTH_CONTINUATIONS) {
          throw new Error("Pi runtime length continuation made no meaningful progress");
        }
      } else {
        active.lengthContinuationStalls = 0;
      }
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
    if (type === "reasoning_delta") {
      active.reasoningChars += delta.length;
    } else {
      active.assistantChars += delta.length;
    }
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
    await this.upstream.reconcileConfig?.();
    const active: ActiveTurn = {
      queue: new EventQueue(),
      cancelled: false,
      terminal: false,
      reasoningChars: 0,
      assistantChars: 0,
      toolEvents: 0,
      lengthContinuationStalls: 0,
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

  resetRunProgress(): void {
    this.upstream.resetRunProgress?.();
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
    await this.upstream.reconcileConfig?.();
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
        systemPrompt:
          PHASE1_SYSTEM_PROMPT +
          toolCatalogPrompt(config.tools ?? [], config.initialToolNames ?? (config.tools ?? []).map((tool) => tool.name)),
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
