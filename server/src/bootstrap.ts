import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { RuntimeLimits } from "@biomed/contracts";

import type { ApplicationHostOptions } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import type { BioMedModelConfig } from "./agent/contracts.js";
import { createSkillIterationApi } from "./agent/skill-iteration/api.js";
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
import { createHilApprovalSettingsApi } from "./settings/hil-approval-settings.js";
import { createPermissionSettingsApi } from "./settings/permission-settings.js";
import {
  JsonHilApprovalPolicyStore,
} from "./runtime/hil-approval-store.js";
import {
  JsonPermissionPolicyStore,
  PermissionBrokerRegistry,
} from "./agent/permissions/index.js";

interface ApiSurface {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

interface ModelSettingsSurface extends ApiSurface {
  resolveActiveModel(): Promise<BioMedModelConfig>;
  resolveRuntimeLimits?(): RuntimeLimits;
  /** Consulted per extraction call, never snapshotted at bootstrap. */
  resolveVlmConfig?(): Promise<VlmConfig>;
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
  skillIterationApi?: ApiSurface;
  createFormalRuntime?: (options: Phase3RuntimeOptions) => Promise<FormalRuntime>;
}

export type BootstrapOptions = Omit<ApplicationHostOptions, "frontend">;

export function resolveProductCommit(
  repositoryRoot: string,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const configured = environment.BIOMED_PRODUCT_COMMIT?.trim();
  if (configured !== undefined && configured !== "") {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(configured)) {
      throw new Error("BIOMED_PRODUCT_COMMIT must be a lowercase 40- or 64-character commit hash");
    }
    return configured;
  }
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

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
  const hilApprovalPolicy = new JsonHilApprovalPolicyStore(
    path.join(settingsDir, "hil-approval.json"),
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
    productCommit: resolveProductCommit(repositoryRoot),
  });
  const skillIterationApi = input.skillIterationApi ?? createSkillIterationApi({
    repositoryRoot,
    tasksRoot,
    settingsDir,
    resolveModel: modelSettings.resolveActiveModel,
  });
  const permissionBrokerRegistry = new PermissionBrokerRegistry();
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
      skillIterationApi,
      modelSettings,
      createPermissionSettingsApi(permissionPolicyStore, permissionBrokerRegistry),
      createHilApprovalSettingsApi(hilApprovalPolicy),
    ),
    formalRuntime: () => formalFactory({
      tasksRoot,
      workspacesRoot,
      repositoryRoot,
      agentExecPolicy: config.agentExecPolicy,
      operationTimeoutMs: config.operationTimeoutMs,
      permissionPolicyStore,
      permissionBrokerRegistry,
      hilApprovalPolicy,
      resolveModel: modelSettings.resolveActiveModel,
      resolveRuntimeLimits: modelSettings.resolveRuntimeLimits,
      database,
      browserPool,
      resolveVlmConfig: modelSettings.resolveVlmConfig,
    }),
  };
}
