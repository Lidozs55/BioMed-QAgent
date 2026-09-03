/**
 * The real Pi upstream-session factory: ModelRuntime/provider registration,
 * search-info probe wiring, resource loading (skills/prompts), tool wiring,
 * interrupted-turn recovery, config reconciliation, and the upstream event
 * subscription that feeds ``PiBioMedAgentSession``. This is the only module
 * that constructs a live Pi session.
 */

import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_RETRY_POLICY,
} from "@biomed/contracts";

import {
  BioMedAgentError,
  type BioMedModelConfig,
  type BioMedSessionConfig,
} from "../contracts.js";
import {
  installSearchInfoProbe,
  registerSearchProbe,
  releaseSearchProbe,
  SEARCH_PROBE_HEADER,
  type ProviderSearchResult,
} from "../search-info-capture.js";
import {
  RunProgressContextTracker,
  runProgressContextMessage,
} from "../run-progress-context.js";
import {
  isRecoverablePiProviderError,
  isRecoverablePiStreamError,
  resolveManualPiCompactionOverrides,
  resolvePiCompactionOverrides,
  resolvePiCompactionTargetTokens,
  resolvePiRetryOverrides,
  resolveSessionBudget,
  shouldReconfigureSession,
  waitForStreamRecovery,
} from "./budget.js";
import {
  applyModelProfileToPayload,
  resolveRequestMaxTokens,
  usesDashScopeQwen,
} from "./model-profile.js";
import {
  activationToolDefinition,
  curateSkillsOverride,
  SKILL_READ_TOOL_NAME,
  skillReadToolDefinition,
  TOOL_ACTIVATION_NAME,
  toPiCustomTools,
} from "./tools.js";
import { toUpstreamEvent } from "./upstream-event.js";
import type { PiUpstreamSession } from "./types.js";

const LENGTH_CONTINUATION_MESSAGE =
  "The previous assistant turn was truncated by the model length limit. " +
  "Continue the same task from the compacted context without repeating completed work. " +
  "Finish the remaining tool calls, required data artifacts, validation, and final response.";
const STREAM_RECOVERY_MESSAGE =
  "The previous assistant turn was interrupted by a transient provider stream read failure. " +
  "Continue the same task from durable state without repeating completed calls or claiming the interrupted action succeeded.";
const PROVIDER_RECOVERY_MESSAGE =
  "The previous assistant turn exhausted its normal retries because the provider was temporarily rate limited or unavailable. " +
  "Continue the same task from durable state without repeating completed calls or claiming the interrupted action succeeded.";

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

export async function createRealUpstreamSession(
  config: BioMedSessionConfig,
  resolveModel?: () => Promise<BioMedModelConfig>,
): Promise<PiUpstreamSession> {
  let current: BioMedModelConfig;
  if (config.model !== undefined) {
    current = config.model;
  } else if (resolveModel !== undefined) {
    current = await resolveModel();
  } else {
    throw new BioMedAgentError(
      "INVALID_CONFIGURATION",
      "Pi model configuration is required",
    );
  }
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
        maxTokens: current.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(current.provider, current.apiKey, {
    allowNetwork: false,
  });
  // Installs the process-wide search_info fetch tee once (idempotent); the
  // tee only activates for requests carrying a registered probe header.
  installSearchInfoProbe();
  const searchInfoListeners = new Set<(results: ProviderSearchResult[]) => void>();
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => {
    const upstreamPayload = options?.onPayload;
    // Probe only DashScope Qwen chat calls with 联网搜索 enabled: the probe
    // header correlates the tee'd response with this exact request, so
    // concurrent sessions never cross-attach captured results.
    const searchProbe = current.enableSearch === true && usesDashScopeQwen(current)
      ? registerSearchProbe()
      : undefined;
    if (searchProbe !== undefined) {
      void searchProbe.slot.done.then((results) => {
        releaseSearchProbe(searchProbe.probeId);
        if (results.length === 0) return;
        for (const listener of searchInfoListeners) listener(results);
      }).catch(() => {
        releaseSearchProbe(searchProbe.probeId);
      });
    }
    return streamSimple(model, context, {
      ...options,
      maxTokens: resolveRequestMaxTokens(current.maxTokens, options?.maxTokens),
      temperature: current.temperature ?? options?.temperature,
      ...(searchProbe === undefined ? {} : {
        headers: { ...options?.headers, [SEARCH_PROBE_HEADER]: searchProbe.probeId },
      }),
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
  const retryPolicy = current.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY;
  const settingsManager = SettingsManager.inMemory(resolvePiRetryOverrides(retryPolicy));
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
  const runProgressTracker = config.getCurrentPublicationId === undefined
    ? undefined
    : new RunProgressContextTracker(config.getCurrentPublicationId);
  const skillRoots = [...(config.skillRoots ?? [])];
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: path.join(config.cwd, ".pi"),
    settingsManager,
    additionalSkillPaths: skillRoots,
    additionalPromptTemplatePaths: [...(config.resourceRoots ?? [])],
    noExtensions: true,
    noSkills: skillRoots.length === 0,
    ...(skillRoots.length === 0 ? {} : { skillsOverride: curateSkillsOverride(skillRoots) }),
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
  // The confined read tool stays active for the whole session: dropping it
  // would also drop the <available_skills> listing on the next prompt rebuild
  // (Pi's customPromptHasRead gate), leaving "consult the matching skill"
  // instructions dangling again.
  const skillReadTool = skillRoots.length === 0
    ? undefined
    : skillReadToolDefinition(skillRoots, config.codeReadRoots ?? []);
  const withSkillRead = (names: readonly string[]): readonly string[] =>
    skillReadTool === undefined || names.includes(SKILL_READ_TOOL_NAME)
      ? names
      : [...names, SKILL_READ_TOOL_NAME];
  const piSessionRef: {
    current?: Awaited<ReturnType<typeof createAgentSession>>["session"];
  } = {};
  const activationTool = activationToolDefinition(
    configuredTools,
    initialToolNames,
    (names) => piSessionRef.current?.setActiveToolsByName([...withSkillRead(names)]),
  );
  const customTools = [
    ...(skillReadTool === undefined ? [] : [skillReadTool]),
    ...(configuredTools.length === 0
      ? []
      : [...toPiCustomTools(configuredTools), activationTool]),
  ];
  const allowedToolNames = customTools.map((tool) => tool.name);
  const { session } = await createAgentSession({
    cwd: config.cwd,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: config.sessionDir === undefined
      ? SessionManager.inMemory(config.cwd)
      : SessionManager.continueRecent(config.cwd, config.sessionDir),
    settingsManager,
    noTools: customTools.length > 0 ? "builtin" : "all",
    tools: allowedToolNames,
    customTools,
  });
  piSessionRef.current = session;
  const baseActiveToolNames = withSkillRead([
    ...initialToolNames,
    ...(configuredTools.length > 0 ? [TOOL_ACTIVATION_NAME] : []),
  ]);
  if (baseActiveToolNames.length > 0) {
    session.setActiveToolsByName([...baseActiveToolNames]);
  }
  let lastAssistantOutcome: { stopReason: string | undefined; errorMessage: string | undefined } | undefined;
  let streamRecoveryController: AbortController | undefined;
  const recoverySubscription = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistantOutcome = {
        stopReason: event.message.stopReason,
        errorMessage: event.message.errorMessage,
      };
    }
  });
  const shouldRecoverInterruptedStream = (): boolean =>
    lastAssistantOutcome !== undefined
    && lastAssistantOutcome.stopReason === "error"
    && isRecoverablePiStreamError(lastAssistantOutcome.errorMessage);
  const shouldRecoverProviderFailure = (): boolean =>
    lastAssistantOutcome !== undefined
    && lastAssistantOutcome.stopReason === "error"
    && isRecoverablePiProviderError(lastAssistantOutcome.errorMessage);
  const promptWithStreamRecovery = async (input: string): Promise<void> => {
    const controller = new AbortController();
    streamRecoveryController?.abort();
    streamRecoveryController = controller;
    try {
      lastAssistantOutcome = undefined;
      await session.prompt(input);
      let streamAttempt = 0;
      let providerAttempt = 0;
      while (shouldRecoverInterruptedStream() || shouldRecoverProviderFailure()) {
        const streamInterrupted = shouldRecoverInterruptedStream();
        if (streamInterrupted) {
          streamAttempt += 1;
          if (streamAttempt > retryPolicy.recoveryMaxAttempts) break;
        } else {
          providerAttempt += 1;
          if (providerAttempt > retryPolicy.recoveryMaxAttempts) break;
        }
        const delayMs = streamInterrupted
          ? Math.min(
              retryPolicy.maxDelayMs,
              retryPolicy.baseDelayMs * 2 ** (streamAttempt - 1),
            )
          : retryPolicy.maxDelayMs;
        const ready = await waitForStreamRecovery(delayMs, controller.signal);
        if (!ready) return;
        lastAssistantOutcome = undefined;
        await session.sendCustomMessage({
          customType: streamInterrupted ? "biomed_stream_recovery" : "biomed_provider_recovery",
          content: streamInterrupted ? STREAM_RECOVERY_MESSAGE : PROVIDER_RECOVERY_MESSAGE,
          display: false,
        }, { triggerTurn: true });
      }
    } finally {
      if (streamRecoveryController === controller) streamRecoveryController = undefined;
    }
  };
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
              maxTokens: next.maxTokens ?? DEFAULT_MAX_TOKENS,
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
    prompt: promptWithStreamRecovery,
    resetRunProgress: () => runProgressTracker?.reset(),
    onSearchInfo(listener) {
      searchInfoListeners.add(listener);
      return () => {
        searchInfoListeners.delete(listener);
      };
    },
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
    getBudget: () => resolveSessionBudget(current),
    getSystemPrompt: () => session.systemPrompt,
    reconcileConfig,
    contextUsage: () => {
      const usage = session.getContextUsage();
      return usage === undefined
        ? undefined
        : { tokens: usage.tokens, percent: usage.percent };
    },
    subscribe(listener) {
      return session.subscribe((event) => {
        const compactionTargetTokens =
          event.type === "compaction_end" &&
          event.result !== undefined &&
          current.compactionTargetRatio !== undefined
            ? resolvePiCompactionTargetTokens(
                currentWindow(),
                current.compactionTargetRatio,
                event.result.tokensBefore,
              )
            : undefined;
        const mapped = toUpstreamEvent(event, compactionTargetTokens);
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
    abort: () => {
      streamRecoveryController?.abort();
      return session.abort();
    },
    dispose: () => {
      streamRecoveryController?.abort();
      recoverySubscription();
      session.dispose();
    },
  };
}
