import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ApplicationHostOptions } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import type { BioMedModelConfig } from "./agent/contracts.js";
import type { HostConfig } from "./config.js";
import { NodeBrowserPool } from "./external/browser/pool.js";
import { DatabaseClient } from "./persistence/db-client.js";
import type { VlmConfig } from "./processing/vlm/vlm-client.js";
import { createProductApi } from "./product/product-api.js";
import {
  createPhase3Runtime,
  type Phase3RuntimeOptions,
} from "./runtime/phase3-composition.js";
import { ModelSettingsService } from "./settings/model-settings.js";
import { createPermissionSettingsApi } from "./settings/permission-settings.js";
import {
  JsonPermissionPolicyStore,
  PermissionBrokerRegistry,
} from "./agent/permissions/index.js";

interface ApiSurface {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

interface ModelSettingsSurface extends ApiSurface {
  resolveActiveModel(): Promise<BioMedModelConfig>;
  resolveVlmConfig?(): Promise<Partial<VlmConfig>>;
}

type FormalRuntime = Pick<
  Awaited<ReturnType<typeof createPhase3Runtime>>,
  "handle" | "handleUpgrade" | "close"
>;

export interface BootstrapInput {
  config: HostConfig;
  repositoryRoot: string;
  tasksRoot: string;
  workspacesRoot: string;
  database?: DatabaseClient;
  browserPool?: NodeBrowserPool;
  modelSettings?: ModelSettingsSurface;
  productApi?: ApiSurface;
  createFormalRuntime?: (options: Phase3RuntimeOptions) => Promise<FormalRuntime>;
}

export type BootstrapOptions = Omit<ApplicationHostOptions, "frontend">;

function combineApis(...apis: ApiSurface[]): ApiSurface {
  return {
    handle(request, response) {
      return apis.some((api) => api.handle(request, response));
    },
  };
}

export async function createBootstrapOptions(input: BootstrapInput): Promise<BootstrapOptions> {
  const { config, tasksRoot, workspacesRoot, repositoryRoot } = input;
  const dataRoot = path.resolve(tasksRoot, "..", "..");
  const cacheDir = path.join(dataRoot, "cache");
  const databasesDir = process.env.SKILL_DATA_DIR === undefined ||
    process.env.SKILL_DATA_DIR.trim() === ""
    ? path.join(dataRoot, "skills")
    : path.resolve(process.env.SKILL_DATA_DIR);
  const settingsDir = path.join(dataRoot, "settings");
  const permissionPolicyStore = new JsonPermissionPolicyStore(
    path.join(settingsDir, "agent-permissions.json"),
  );
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
  });
  const permissionBrokerRegistry = new PermissionBrokerRegistry();
  const vlmConfig = modelSettings.resolveVlmConfig === undefined
    ? undefined
    : await modelSettings.resolveVlmConfig().catch(() => undefined);
  const lifecycle = new LifecycleRegistry({ timeoutMs: config.shutdownTimeoutMs + 5_000 });
  const formalFactory = input.createFormalRuntime ?? createPhase3Runtime;

  return {
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    lifecycle,
    initializeLifecycle: async (registry) => {
      registry.add("database bridge", () => database.close());
      registry.add("browser pool", () => browserPool.close());
      await browserPool.start();
    },
    hostApi: combineApis(
      productApi,
      modelSettings,
      createPermissionSettingsApi(permissionPolicyStore, permissionBrokerRegistry),
    ),
    formalRuntime: () => formalFactory({
      tasksRoot,
      workspacesRoot,
      repositoryRoot,
      agentExecPolicy: config.agentExecPolicy,
      permissionPolicyStore,
      permissionBrokerRegistry,
      resolveModel: modelSettings.resolveActiveModel,
      database,
      browserPool,
      vlmConfig,
    }),
  };
}
