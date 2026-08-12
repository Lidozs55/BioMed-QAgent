type Environment = Record<string, string | undefined>;

export interface FeatureFlags {
  appHost: "fastapi" | "ts";
  agentRuntime: "legacy" | "pi";
  datasetCore: "python" | "ts";
  piExperimental: boolean;
}

export interface HostConfig {
  flags: FeatureFlags;
  publicHost: string;
  publicPort: number;
  legacyPrivatePort: number;
  legacyUrl?: string;
  legacyBridgeSecret?: string;
  legacyReadinessTimeoutMs: number;
  shutdownTimeoutMs: number;
  workspaceDevExec: boolean;
}

export const DEFAULT_HOST_CONFIG = {
  APP_HOST: "ts",
  AGENT_RUNTIME: "legacy",
  DATASET_CORE: "python",
  PI_EXPERIMENTAL: "1",
  HOST: "127.0.0.1",
  PORT: "5173",
  LEGACY_BACKEND_PORT: "0",
  LEGACY_READINESS_TIMEOUT_MS: "30000",
  SHUTDOWN_TIMEOUT_MS: "10000",
  WORKSPACE_DEV_EXEC: "0",
} as const;

function parseChoice<const Values extends readonly string[]>(
  name: string,
  value: string | undefined,
  defaultValue: Values[number],
  values: Values,
): Values[number] {
  const resolved = value ?? defaultValue;
  if (!values.includes(resolved)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return resolved as Values[number];
}

function parsePort(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseFeatureFlags(environment: Environment): FeatureFlags {
  const appHost = parseChoice(
    "APP_HOST",
    environment.APP_HOST,
    DEFAULT_HOST_CONFIG.APP_HOST,
    ["fastapi", "ts"] as const,
  );
  const agentRuntime = parseChoice(
    "AGENT_RUNTIME",
    environment.AGENT_RUNTIME,
    DEFAULT_HOST_CONFIG.AGENT_RUNTIME,
    ["legacy", "pi"] as const,
  );
  const datasetCore = parseChoice(
    "DATASET_CORE",
    environment.DATASET_CORE,
    DEFAULT_HOST_CONFIG.DATASET_CORE,
    ["python", "ts"] as const,
  );
  const piExperimentalValue = parseChoice(
    "PI_EXPERIMENTAL",
    environment.PI_EXPERIMENTAL,
    DEFAULT_HOST_CONFIG.PI_EXPERIMENTAL,
    ["0", "1"] as const,
  );
  const piExperimental = piExperimentalValue === "1";

  const profile = `${appHost}/${agentRuntime}/${datasetCore}/${piExperimentalValue}`;
  const validProfiles = new Set([
    "fastapi/legacy/python/0",
    "ts/legacy/python/0",
    "ts/legacy/python/1",
    "ts/pi/python/1",
  ]);
  if (!validProfiles.has(profile)) {
    throw new Error(`Invalid Phase 0/1 feature flag combination: ${profile}`);
  }

  return { appHost, agentRuntime, datasetCore, piExperimental };
}

export function parseHostConfig(environment: Environment): HostConfig {
  const flags = parseFeatureFlags(environment);
  if (flags.appHost !== "ts") {
    throw new Error("The TypeScript server entry requires APP_HOST=ts");
  }

  const publicHost = environment.HOST ?? DEFAULT_HOST_CONFIG.HOST;
  if (publicHost.trim() === "") {
    throw new Error("HOST must not be empty");
  }

  return {
    flags,
    publicHost,
    publicPort: parsePort("PORT", environment.PORT ?? DEFAULT_HOST_CONFIG.PORT),
    legacyPrivatePort: parsePort(
      "LEGACY_BACKEND_PORT",
      environment.LEGACY_BACKEND_PORT ?? DEFAULT_HOST_CONFIG.LEGACY_BACKEND_PORT,
    ),
    legacyUrl: environment.LEGACY_BACKEND_URL,
    legacyBridgeSecret: environment.PI_DATASET_BRIDGE_SECRET,
    legacyReadinessTimeoutMs: parsePositiveInteger(
      "LEGACY_READINESS_TIMEOUT_MS",
      environment.LEGACY_READINESS_TIMEOUT_MS ??
        DEFAULT_HOST_CONFIG.LEGACY_READINESS_TIMEOUT_MS,
    ),
    shutdownTimeoutMs: parsePositiveInteger(
      "SHUTDOWN_TIMEOUT_MS",
      environment.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_HOST_CONFIG.SHUTDOWN_TIMEOUT_MS,
    ),
    workspaceDevExec:
      parseChoice(
        "WORKSPACE_DEV_EXEC",
        environment.WORKSPACE_DEV_EXEC,
        DEFAULT_HOST_CONFIG.WORKSPACE_DEV_EXEC,
        ["0", "1"] as const,
      ) === "1",
  };
}
