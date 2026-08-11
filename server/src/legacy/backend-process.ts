import { once } from "node:events";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface LegacyBackendOptions {
  repositoryRoot: string;
  privatePort: number;
  legacyUrl?: string;
  platform?: NodeJS.Platform;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  bridgeSecret?: string;
}

export interface SpawnChildInput {
  command: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string>;
}

export interface LegacyBackendHandle {
  target: string;
  owned: boolean;
  bridgeSecret?: string;
  close: () => Promise<void>;
}

export interface LegacyBackendDependencies<Child = ChildProcess> {
  spawnChild: (input: SpawnChildInput) => Child;
  terminateChild: (child: Child) => Promise<void>;
  waitUntilReady: (healthUrl: string) => Promise<void>;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function requireLoopbackLegacyUrl(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("LEGACY_BACKEND_URL must be an absolute HTTP URL");
  }
  if (!(["http:", "https:"] as const).includes(target.protocol as "http:" | "https:")) {
    throw new Error("LEGACY_BACKEND_URL must use HTTP or HTTPS");
  }
  if (!isLoopbackHostname(target.hostname)) {
    throw new Error("Phase 1 legacy backend target must be loopback-only");
  }
  if (target.username !== "" || target.password !== "") {
    throw new Error("LEGACY_BACKEND_URL must not contain credentials");
  }
  return target;
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= action();
    return promise;
  };
}

export async function startLegacyBackend<Child>(
  options: LegacyBackendOptions,
  dependencies: LegacyBackendDependencies<Child>,
): Promise<LegacyBackendHandle> {
  if (options.legacyUrl !== undefined) {
    const target = requireLoopbackLegacyUrl(options.legacyUrl);
    await dependencies.waitUntilReady(new URL("/api/v1/health", target).toString());
    return {
      target: target.origin,
      owned: false,
      bridgeSecret: options.bridgeSecret,
      close: async () => undefined,
    };
  }

  const platform = options.platform ?? process.platform;
  const backendRoot = path.join(options.repositoryRoot, "backend");
  const pythonRelative =
    platform === "win32"
      ? [".venv", "Scripts", "python.exe"]
      : [".venv", "bin", "python"];
  const target = `http://127.0.0.1:${options.privatePort}`;
  const bridgeSecret = options.bridgeSecret ?? randomBytes(32).toString("hex");
  const child = dependencies.spawnChild({
    command: path.join(backendRoot, ...pythonRelative),
    args: [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(options.privatePort),
    ],
    cwd: backendRoot,
    environment: { PI_DATASET_BRIDGE_SECRET: bridgeSecret },
  });
  const close = onceAsync(() => dependencies.terminateChild(child));
  try {
    await dependencies.waitUntilReady(`${target}/api/v1/health`);
  } catch (error) {
    await close();
    throw error;
  }
  return { target, owned: true, bridgeSecret, close };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForLegacyReadiness(
  healthUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
      });
      if (response.ok) return;
      lastError = new Error(`legacy health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(Math.max(1, Math.min(100, deadline - Date.now())));
  }
  throw new Error(`Legacy backend did not become ready within ${timeoutMs}ms`, {
    cause: lastError,
  });
}

export function spawnLegacyChild(input: SpawnChildInput): ChildProcess {
  return spawn(input.command, input.args, {
    cwd: input.cwd,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...input.environment },
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Legacy backend did not exit")), timeoutMs);
  });
  try {
    await Promise.race([once(child, "exit"), timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function terminateLegacyChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, timeoutMs);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, timeoutMs);
  }
}

export function createLegacyBackend(options: LegacyBackendOptions): Promise<LegacyBackendHandle> {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  return startLegacyBackend(options, {
    spawnChild: spawnLegacyChild,
    terminateChild: (child) => terminateLegacyChild(child, shutdownTimeoutMs),
    waitUntilReady: (healthUrl) => waitForLegacyReadiness(healthUrl, readinessTimeoutMs),
  });
}
