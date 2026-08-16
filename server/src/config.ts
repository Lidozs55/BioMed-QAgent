type Environment = Record<string, string | undefined>;

import path from "node:path";

export type AgentExecPolicy = "deny" | "ask" | "allow";

export interface HostConfig {
  publicHost: string;
  publicPort: number;
  shutdownTimeoutMs: number;
  /**
   * Migration feature flag (plan §58): overrides the process.exec policy
   * regardless of preset. Removed once the settings layer stabilizes.
   */
  agentExecPolicy: AgentExecPolicy | null;
  /**
   * Environment-level exec switch (HIL branch): when false (default) command
   * execution is hard-disabled before the permission system is consulted —
   * the agent gets ``policy: "disabled"`` without an ask. When true, exec
   * flows through the permission broker (preset/grants/rules/asks).
   */
  workspaceDevExec: boolean;
}
export const DEFAULT_HOST_CONFIG = {
  HOST: "127.0.0.1",
  PORT: "5173",
  SHUTDOWN_TIMEOUT_MS: "10000",
  AGENT_EXEC_POLICY: "",
  WORKSPACE_DEV_EXEC: "0",
} as const;

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
    agentExecPolicy: parseAgentExecPolicy(environment.AGENT_EXEC_POLICY),
    workspaceDevExec: parseChoice(
      "WORKSPACE_DEV_EXEC",
      environment.WORKSPACE_DEV_EXEC,
      DEFAULT_HOST_CONFIG.WORKSPACE_DEV_EXEC,
      ["0", "1"] as const,
    ) === "1",
  };
}

function parseChoice(
  name: string,
  value: string | undefined,
  fallback: string,
  choices: readonly string[],
): string {
  const resolved = value ?? fallback;
  if (!choices.includes(resolved)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  }
  return resolved;
}

function parseAgentExecPolicy(value: string | undefined): AgentExecPolicy | null {
  if (value === undefined || value.trim() === "") return null;
  if (value === "deny" || value === "ask" || value === "allow") return value;
  throw new Error("AGENT_EXEC_POLICY must be one of: deny, ask, allow");
}
/**
 * 解析 OUTPUT_DIR 为绝对路径。
 *
 * - 未设置或空 → 默认 <repositoryRoot>/data/output；
 * - 绝对路径 → 原样解析；
 * - 相对路径 → 锚定 repositoryRoot 而非进程 cwd。
 *
 * 早期实现用 `path.resolve(OUTPUT_DIR)` 按 cwd 解析，导致在 `server/`
 * 目录下运行 server 包 dev/start 脚本时数据写到 `server/data/`（例如
 * 根 .env 写 `OUTPUT_DIR=data/output` 时）。锚定后行为与 cwd 无关。
 */
export function resolveOutputDir(repositoryRoot: string, raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return path.join(repositoryRoot, "data", "output");
  }
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(repositoryRoot, trimmed);
}

/**
 * 解析 Workspace 根目录（Agent Workspace refactor，plan §2.1）。
 *
 * Workspace 与 Task Output 在物理目录层面分离：
 *
 * ```text
 * data/
 * ├── workspaces/<taskId>/   ← Agent-owned
 * └── output/tasks/<taskId>/ ← BioMed-owned
 * ```
 *
 * 默认 OUTPUT_DIR 为 ``<repo>/data/output`` 时，workspaces 根为
 * ``<repo>/data/workspaces``（output 的兄弟目录）。
 */
export function resolveWorkspacesRoot(repositoryRoot: string, raw: string | undefined): string {
  const outputDir = resolveOutputDir(repositoryRoot, raw);
  return path.join(path.dirname(outputDir), "workspaces");
}
