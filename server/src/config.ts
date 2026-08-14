type Environment = Record<string, string | undefined>;

export interface HostConfig {
  publicHost: string;
  publicPort: number;
  shutdownTimeoutMs: number;
  workspaceDevExec: boolean;
}

export const DEFAULT_HOST_CONFIG = {
  HOST: "127.0.0.1",
  PORT: "5173",
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

export function parseHostConfig(environment: Environment): HostConfig {
  const publicHost = environment.HOST ?? DEFAULT_HOST_CONFIG.HOST;
  if (publicHost.trim() === "") {
    throw new Error("HOST must not be empty");
  }

  return {
    publicHost,
    publicPort: parsePort("PORT", environment.PORT ?? DEFAULT_HOST_CONFIG.PORT),
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
