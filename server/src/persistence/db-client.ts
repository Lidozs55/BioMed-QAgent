/**
 * TS DatabaseClient — JSONL named-operation bridge client (P5-10/P5-11).
 *
 * The ONLY Python the TS product path may call. Manages the long-lived
 * ``database/bridge.py`` subprocess (migration plan §15): request-id
 * correlation, per-request timeout, stderr → app log, auto-restart on
 * unexpected exit, clean shutdown.
 *
 * Named operations only — the bridge rejects arbitrary SQL by design
 * (``sql.exec``/``db.raw_query`` are unknown ops there).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = "1";

/**
 * Named bridge operations (mirror of the ``database/bridge.py`` dispatch
 * table; the Python table is the protocol's canonical definition).
 */
export const BRIDGE_OP = {
  PING: "ping",
  CACHE_SEARCH: "cache.search",
  CACHE_LIST: "cache.list",
  CACHE_DESCRIBE: "cache.describe",
  CACHE_GET: "cache.get",
  DATABASE_LIST: "database.list",
  DATABASE_DISABLED: "database.disabled",
  DATABASE_GET: "database.get",
  DATABASE_TOOL_MANIFESTS: "database.tool_manifests",
  DATABASE_SAVE: "database.save",
  DATABASE_PATCH: "database.patch",
  DATABASE_DELETE: "database.delete",
  DATABASE_SET_ENABLED: "database.set_enabled",
} as const;

export class DatabaseBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseBridgeError";
  }
}

export class DatabaseBridgeUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DatabaseBridgeUnavailableError";
  }
}

export interface DatabaseClientOptions {
  /** Python executable. Default: probe BIOMED_PYTHON_BIN / repo .venv / python3. */
  pythonBin?: string;
  /** bridge.py location (defaults to repo database/bridge.py). */
  bridgePath?: string;
  cacheDir?: string;
  databasesDir?: string;
  /** Default per-request timeout (ms). */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function repoRoot(): string {
  // server/{src|dist}/persistence → ../../.. → repo root.
  return path.resolve(MODULE_DIR, "..", "..", "..");
}

export function defaultBridgePath(): string {
  return path.join(repoRoot(), "database", "bridge.py");
}

export function probePythonBin(): string {
  if (process.env.BIOMED_PYTHON_BIN) return process.env.BIOMED_PYTHON_BIN;
  const root = repoRoot();
  const windows = path.join(root, ".venv", "Scripts", "python.exe");
  if (existsSync(windows)) return windows;
  const posix = path.join(root, ".venv", "bin", "python");
  if (existsSync(posix)) return posix;
  return process.platform === "win32" ? "python" : "python3";
}

export class DatabaseClient {
  readonly pythonBin: string;
  readonly bridgePath: string;
  readonly cacheDir: string | undefined;
  readonly databasesDir: string | undefined;
  readonly timeoutMs: number;
  readonly onLog: ((line: string) => void) | undefined;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private starting: Promise<void> | null = null;

  constructor(options: DatabaseClientOptions = {}) {
    this.pythonBin = options.pythonBin ?? probePythonBin();
    this.bridgePath = options.bridgePath ?? defaultBridgePath();
    this.cacheDir = options.cacheDir;
    this.databasesDir = options.databasesDir;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onLog = options.onLog;
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.starting !== null) return this.starting;
    this.starting = this.spawnProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async spawnProcess(): Promise<void> {
    const args = [
      this.bridgePath,
    ];
    if (this.cacheDir !== undefined) {
      args.push("--cache-dir", this.cacheDir);
    }
    if (this.databasesDir !== undefined) {
      args.push("--databases-dir", this.databasesDir);
    }
    const child = spawn(this.pythonBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    child.on("error", (error) => {
      this.failAll(new DatabaseBridgeUnavailableError(`bridge process failed: ${error.message}`, error));
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        this.failAll(new DatabaseBridgeUnavailableError(`bridge exited with code ${String(code)}`));
      }
      if (this.process === child) this.process = null;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.onLog?.(line);
    });
    // Warm-up ping: fail fast when Python/bridge is unusable.
    await this.call<{ service: string }>(BRIDGE_OP.PING, {});
  }

  private handleLine(line: string): void {
    let message: { id?: unknown; ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.data);
    } else {
      const error = message.error;
      pending.reject(
        new DatabaseBridgeError(
          typeof error?.code === "string" ? error.code : "internal",
          typeof error?.message === "string" ? error.message : "bridge request failed",
        ),
      );
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async call<T>(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    await this.start();
    const id = `req_${++this.sequence}_${Date.now().toString(36)}`;
    const request = `${JSON.stringify({ version: PROTOCOL_VERSION, id, op, args })}\n`;
    const timeout = timeoutMs ?? this.timeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DatabaseBridgeUnavailableError(`bridge request ${op} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    const child = this.process;
    if (child === null) {
      throw new DatabaseBridgeUnavailableError("bridge is not running");
    }
    child.stdin.write(request, (error) => {
      if (error !== null && error !== undefined) {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new DatabaseBridgeUnavailableError(`bridge write failed: ${error.message}`, error));
        }
      }
    });
    return promise;
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child === null) return;
    this.failAll(new DatabaseBridgeUnavailableError("bridge client closed"));
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
