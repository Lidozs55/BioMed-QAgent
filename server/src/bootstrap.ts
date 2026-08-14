import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ApplicationHostOptions } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import { createPhase1ExperimentalRuntime } from "./agent/phase1-composition.js";
import type { BioMedModelConfig } from "./agent/contracts.js";
import type { HostConfig } from "./config.js";
import { NodeBrowserPool } from "./external/browser/pool.js";
import { createLegacyBackend } from "./legacy/backend-process.js";
import { DatabaseClient } from "./persistence/db-client.js";
import type { VlmConfig } from "./processing/vlm/vlm-client.js";
import { createProductApi } from "./product/product-api.js";
import {
  createPhase3Runtime,
  type Phase3RuntimeOptions,
} from "./runtime/phase3-composition.js";
import { ModelSettingsService } from "./settings/model-settings.js";

interface ApiSurface {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

interface ModelSettingsSurface extends ApiSurface {
  resolveActiveModel(): Promise<BioMedModelConfig>;
  resolveVlmConfig?(): Promise<Partial<VlmConfig>>;
}

type LegacyHandle = Pick<Awaited<ReturnType<typeof createLegacyBackend>>, "target" | "bridgeSecret" | "close">;
type FormalRuntime = Pick<
  Awaited<ReturnType<typeof createPhase3Runtime>>,
  "handle" | "handleUpgrade" | "close"
>;
type ExperimentalRuntime = Awaited<ReturnType<typeof createPhase1ExperimentalRuntime>>;

export interface BootstrapInput {
  config: HostConfig;
  repositoryRoot: string;
  tasksRoot: string;
  database?: DatabaseClient;
  browserPool?: NodeBrowserPool;
  modelSettings?: ModelSettingsSurface;
  productApi?: ApiSurface;
  createLegacy?: (options: Parameters<typeof createLegacyBackend>[0]) => Promise<LegacyHandle>;
  createFormalRuntime?: (options: Phase3RuntimeOptions) => Promise<FormalRuntime>;
  createExperimentalRuntime?: (
    options: Parameters<typeof createPhase1ExperimentalRuntime>[0],
  ) => Promise<ExperimentalRuntime>;
}

export type BootstrapOptions = Omit<ApplicationHostOptions, "frontend">;

function combineApis(...apis: ApiSurface[]): ApiSurface {
  return {
    handle(request, response) {
      return apis.some((api) => api.handle(request, response));
    },
  };
}

function needsLegacyBackend(config: HostConfig): boolean {
  return (
    config.flags.agentRuntime === "legacy" ||
    config.flags.datasetCore === "python" ||
    config.flags.piExperimental
  );
}

export async function createBootstrapOptions(input: BootstrapInput): Promise<BootstrapOptions> {
  const { config, repositoryRoot, tasksRoot } = input;
  const dataRoot = path.resolve(tasksRoot, "..", "..");
  const cacheDir = path.join(dataRoot, "cache");
  const databasesDir = process.env.SKILL_DATA_DIR === undefined ||
    process.env.SKILL_DATA_DIR.trim() === ""
    ? path.join(dataRoot, "skills")
    : path.resolve(process.env.SKILL_DATA_DIR);
  const settingsDir = path.join(dataRoot, "settings");
  const database = input.database ?? new DatabaseClient({ cacheDir, databasesDir });
  const browserPool = input.browserPool ?? new NodeBrowserPool({ maxContexts: 4 });
  const modelSettings = input.modelSettings ?? await ModelSettingsService.create({
    settingsDir,
    legacyRegistryPath: path.join(settingsDir, "model_registry.db"),
    environment: process.env,
  });
  const productApi = input.productApi ?? await createProductApi({
    tasksRoot,
    cacheDir,
    settingsDir,
    database,
    profile: {
      appHost: "ts",
      agentRuntime: "pi",
      datasetCore: config.flags.datasetCore,
    },
  });
  const vlmConfig = modelSettings.resolveVlmConfig === undefined
    ? undefined
    : await modelSettings.resolveVlmConfig().catch(() => undefined);
  const needsBrowserPool = config.flags.agentRuntime === "pi" || config.flags.piExperimental;
  const lifecycle = new LifecycleRegistry({ timeoutMs: config.shutdownTimeoutMs + 5_000 });
  const legacyFactory = input.createLegacy ?? createLegacyBackend;
  const formalFactory = input.createFormalRuntime ?? createPhase3Runtime;
  const experimentalFactory = input.createExperimentalRuntime ?? createPhase1ExperimentalRuntime;
  const legacy = needsLegacyBackend(config)
    ? () => legacyFactory({
        repositoryRoot,
        privatePort: config.legacyPrivatePort,
        legacyUrl: config.legacyUrl,
        bridgeSecret: config.legacyBridgeSecret,
        readinessTimeoutMs: config.legacyReadinessTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      })
    : undefined;

  return {
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    lifecycle,
    ...(legacy === undefined ? {} : { legacy }),
    initializeLifecycle: async (registry) => {
      registry.add("database bridge", () => database.close());
      if (needsBrowserPool) {
        registry.add("browser pool", () => browserPool.close());
        await browserPool.start();
      }
    },
    ...(config.flags.agentRuntime === "pi"
      ? { hostApi: combineApis(productApi, modelSettings) }
      : {}),
    ...(config.flags.agentRuntime === "pi"
      ? {
          formalRuntime: ({ target, bridgeSecret }) => formalFactory({
            tasksRoot,
            ...(target === undefined ? {} : { legacyTarget: target }),
            ...(bridgeSecret === undefined ? {} : { bridgeSecret }),
            workspaceDevExec: config.workspaceDevExec,
            resolveModel: modelSettings.resolveActiveModel,
            datasetCore: config.flags.datasetCore,
            database,
            browserPool,
            vlmConfig,
          }),
        }
      : {}),
    ...(config.flags.piExperimental
      ? {
          experimentalPi: ({ target, bridgeSecret }) => {
            if (target === undefined) {
              throw new Error("PI_EXPERIMENTAL=1 requires a legacy backend target");
            }
            return experimentalFactory({
              repositoryRoot,
              tasksRoot,
              legacyTarget: target,
              ...(bridgeSecret === undefined ? {} : { bridgeSecret }),
              workspaceDevExec: config.workspaceDevExec,
              resolveModel: modelSettings.resolveActiveModel,
            });
          },
        }
      : {}),
  };
}
