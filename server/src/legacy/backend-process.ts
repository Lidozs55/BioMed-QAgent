import { once } from "node:events";
import { execFile, type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
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
  waitUntilReady: (target: string, secret: string, child?: Child) => Promise<void>;
  generateSecret?: () => string;
  allocatePrivatePort?: () => Promise<number>;
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
    if (options.bridgeSecret === undefined || options.bridgeSecret.trim() === "") {
      throw new Error("Attach mode requires a non-empty Dataset Core bridge secret");
    }
    await dependencies.waitUntilReady(target.origin, options.bridgeSecret);
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
  const privatePort = options.privatePort === 0
    ? await (dependencies.allocatePrivatePort ?? allocateLoopbackPort)()
    : options.privatePort;
  const target = `http://127.0.0.1:${privatePort}`;
  const bridgeSecret =
    dependencies.generateSecret?.() ?? randomBytes(32).toString("hex");
  const child = dependencies.spawnChild({
    command: path.join(backendRoot, ...pythonRelative),
    args: [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(privatePort),
    ],
    cwd: backendRoot,
    environment: { PI_DATASET_BRIDGE_SECRET: bridgeSecret },
  });
  const close = onceAsync(() => dependencies.terminateChild(child));
  try {
    await dependencies.waitUntilReady(target, bridgeSecret, child);
  } catch (error) {
    await close();
    throw error;
  }
  return { target, owned: true, bridgeSecret, close };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a private legacy backend port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export async function waitForLegacyReadiness(
  target: string,
  secret: string,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  if (child !== undefined) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Legacy backend exited before readiness (code=${String(child.exitCode)}, ` +
          `signal=${String(child.signalCode)})`,
      );
    }
    childExit = once(child, "exit").then(([code, signal]) => ({
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal as NodeJS.Signals : null,
    }));
  }
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const probe = fetch(
        new URL("/internal/migration/pi/dataset/operations", target),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-biomed-bridge-secret": secret,
          },
          body: JSON.stringify({
            version: 1,
            request_id: "readiness_probe",
            task_id: "readiness_probe",
            run_id: "readiness_probe",
            pi_session_id: "readiness_probe",
            tool_call_id: "readiness_probe",
            op: "get_build_result",
            args: { build_id: "readiness_probe" },
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
        },
      );
      const result = childExit === undefined
        ? { kind: "response" as const, response: await probe }
        : await Promise.race([
            probe.then((response) => ({ kind: "response" as const, response })),
            childExit.then(({ code, signal }) => ({
              kind: "exit" as const,
              code,
              signal,
            })),
          ]);
      if (result.kind === "exit") {
        throw new Error(
          `Legacy backend exited before readiness (code=${String(result.code)}, ` +
            `signal=${String(result.signal)})`,
        );
      }
      if (await acceptsReadinessProbe(result.response)) return;
      lastError = new Error(`legacy identity probe returned ${result.response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("exited before readiness")) {
        throw error;
      }
      lastError = error;
    }
    await delay(Math.max(1, Math.min(100, deadline - Date.now())));
  }
  throw new Error(`Legacy backend did not become ready within ${timeoutMs}ms`, {
    cause: lastError,
  });
}

async function acceptsReadinessProbe(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.request_id !== "readiness_probe" || record.ok !== false) {
      return false;
    }
    const error = record.error;
    return error !== null && typeof error === "object" && !Array.isArray(error) &&
      (error as Record<string, unknown>).code === "invalid_input";
  } catch {
    return false;
  }
}

export function spawnLegacyChild(input: SpawnChildInput): ChildProcess {
  return spawn(input.command, input.args, {
    cwd: input.cwd,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
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

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function windowsTreeTerminationScript(processId: number): string {
  return [
    `$rootPid = [int]${processId}`,
    "$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)",
    "$children = @{}",
    "foreach ($item in $processes) {",
    "  $parent = [int]$item.ParentProcessId",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }",
    "  $children[$parent] += [int]$item.ProcessId",
    "}",
    "$pending = [System.Collections.Generic.Stack[int]]::new()",
    "$pending.Push($rootPid)",
    "$targets = [System.Collections.Generic.List[int]]::new()",
    "while ($pending.Count -gt 0) {",
    "  $current = $pending.Pop()",
    "  if ($children.ContainsKey($current)) {",
    "    foreach ($childPid in $children[$current]) {",
    "      $targets.Add($childPid)",
    "      $pending.Push($childPid)",
    "    }",
    "  }",
    "}",
    "[array]::Reverse($targets.ToArray())",
    "foreach ($targetPid in $targets) {",
    "  if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {",
    "    Stop-Process -Id $targetPid -Force -ErrorAction Stop",
    "  }",
    "}",
    "if (Get-Process -Id $rootPid -ErrorAction SilentlyContinue) {",
    "  Stop-Process -Id $rootPid -Force -ErrorAction Stop",
    "}",
  ].join("\n");
}

async function terminateWindowsTree(processId: number): Promise<void> {
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsTreeTerminationScript(processId),
    ]);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code !== "128") throw error;
  }
}

export async function terminateLegacyChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await terminateWindowsTree(child.pid);
    return;
  }
  const processGroup = -child.pid;
  try {
    process.kill(processGroup, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  try {
    await waitForExit(child, timeoutMs);
  } catch {
    try {
      process.kill(processGroup, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await waitForExit(child, timeoutMs);
  }
}

export function createLegacyBackend(options: LegacyBackendOptions): Promise<LegacyBackendHandle> {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  return startLegacyBackend(options, {
    spawnChild: spawnLegacyChild,
    terminateChild: (child) => terminateLegacyChild(child, shutdownTimeoutMs),
    waitUntilReady: (target, secret, child) =>
      waitForLegacyReadiness(target, secret, readinessTimeoutMs, child),
    allocatePrivatePort: allocateLoopbackPort,
  });
}
