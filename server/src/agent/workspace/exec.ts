import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceContext } from "./context.js";
import { WorkspacePolicyError, type WorkspaceExecResult } from "./types.js";

const SECRET_ARGUMENT = /(?:api[-_]?key|authorization|password|secret|token)(?:=|:)/i;
const EXECUTABLE_METACHARACTERS = /[&|;<>\r\n\0]/u;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

interface SnapshotEntry {
  type: "directory" | "file";
  bytes?: Buffer;
  mode: number;
}

type ProtectedSnapshot = Map<string, SnapshotEntry>;

interface ActiveCommand {
  cancel(): void;
  done: Promise<void>;
  complete(): void;
}

export class WorkspaceProcessRegistry {
  readonly #active = new Set<ActiveCommand>();

  register(cancel: () => void): () => void {
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const active = { cancel, done, complete };
    this.#active.add(active);
    return () => {
      active.complete();
      this.#active.delete(active);
    };
  }

  async cancelAll(): Promise<void> {
    const active = [...this.#active];
    for (const command of active) command.cancel();
    await Promise.allSettled(active.map((command) => command.done));
  }
}

export function sanitizedCommand(executable: string, args: readonly string[]): string[] {
  return [
    path.basename(executable),
    ...args.map((argument) => (SECRET_ARGUMENT.test(argument) ? "[redacted]" : argument)),
  ];
}

function disabledResult(command: string[]): WorkspaceExecResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    truncated: false,
    timedOut: false,
    cancelled: false,
    policy: "disabled",
  };
}

function rejectedResult(command: string[], message: string, durationMs = 0): WorkspaceExecResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: message,
    durationMs,
    truncated: false,
    timedOut: false,
    cancelled: false,
    policy: "rejected",
  };
}

function safeEnvironment(context: WorkspaceContext): NodeJS.ProcessEnv {
  const combined = { ...process.env, ...(context.developmentExec?.environment ?? {}) };
  return Object.fromEntries(
    Object.entries(combined).filter(
      ([key, value]) => value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()),
    ),
  ) as NodeJS.ProcessEnv;
}

function isAgentStaging(relativePath: string): boolean {
  const normalized = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
  return normalized === "staging/agent" || normalized.startsWith("staging/agent/");
}

async function snapshotProtected(context: WorkspaceContext): Promise<ProtectedSnapshot> {
  const snapshot: ProtectedSnapshot = new Map();
  let files = 0;
  let bytes = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relative = relativeDirectory === ""
        ? child.name
        : `${relativeDirectory}/${child.name}`;
      if (isAgentStaging(relative)) continue;
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new WorkspacePolicyError(
          "EXEC_POLICY_REJECTED",
          "Development exec refuses an unprotected link in formal Workspace areas",
        );
      }
      if (info.isDirectory()) {
        snapshot.set(relative, { type: "directory", mode: info.mode });
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) {
        throw new WorkspacePolicyError(
          "EXEC_POLICY_REJECTED",
          "Development exec refuses an unsupported formal Workspace entry",
        );
      }
      files += 1;
      bytes += info.size;
      if (files > context.limits.maxSnapshotFiles || bytes > context.limits.maxSnapshotBytes) {
        throw new WorkspacePolicyError(
          "LIMIT_EXCEEDED",
          "Formal Workspace snapshot exceeds the configured safety limit",
        );
      }
      snapshot.set(relative, { type: "file", bytes: await readFile(absolute), mode: info.mode });
    }
  }

  await visit(context.root, "");
  return snapshot;
}

function snapshotsEqual(before: ProtectedSnapshot, after: ProtectedSnapshot): boolean {
  if (before.size !== after.size) return false;
  for (const [relative, expected] of before) {
    const actual = after.get(relative);
    if (actual?.type !== expected.type) return false;
    if (expected.type === "file" && !expected.bytes?.equals(actual.bytes ?? Buffer.alloc(0))) {
      return false;
    }
  }
  return true;
}

async function restoreProtected(
  context: WorkspaceContext,
  snapshot: ProtectedSnapshot,
): Promise<void> {
  const current = await readdir(context.root, { withFileTypes: true });
  for (const entry of current) {
    const absolute = path.join(context.root, entry.name);
    const staging = process.platform === "win32"
      ? entry.name.toLowerCase() === "staging"
      : entry.name === "staging";
    if (!staging || entry.isSymbolicLink() || !entry.isDirectory()) {
      await rm(absolute, { recursive: true, force: true });
      continue;
    }
    const stagingChildren = await readdir(absolute, { withFileTypes: true });
    for (const child of stagingChildren) {
      const agent = process.platform === "win32"
        ? child.name.toLowerCase() === "agent"
        : child.name === "agent";
      if (!agent) await rm(path.join(absolute, child.name), { recursive: true, force: true });
    }
  }
  await mkdir(path.join(context.root, "staging", "agent"), { recursive: true });
  const entries = [...snapshot.entries()].sort(
    ([left], [right]) => left.split("/").length - right.split("/").length,
  );
  for (const [relative, entry] of entries) {
    const absolute = path.join(context.root, ...relative.split("/"));
    if (entry.type === "directory") {
      await mkdir(absolute, { recursive: true });
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, entry.bytes ?? Buffer.alloc(0));
    }
    if (process.platform !== "win32") await chmod(absolute, entry.mode);
  }
}

function validateCommand(input: {
  executable: string;
  args: string[];
  timeoutMs?: number;
}, context: WorkspaceContext): string | undefined {
  if (
    typeof input.executable !== "string" ||
    input.executable.trim() === "" ||
    EXECUTABLE_METACHARACTERS.test(input.executable)
  ) {
    return "Executable authority is invalid";
  }
  if (
    !Array.isArray(input.args) ||
    input.args.length > 100 ||
    input.args.some(
      (argument) => typeof argument !== "string" || argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    return "Executable arguments are invalid";
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > context.limits.maxExecTimeoutMs)
  ) {
    return "Execution timeout is outside the configured limit";
  }
  return undefined;
}

function runInternal(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish("");
    }, 2_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (size >= 4 * 1024 * 1024) return;
      const remaining = 4 * 1024 * 1024 - size;
      const bounded = chunk.subarray(0, remaining);
      chunks.push(bounded);
      size += bounded.length;
    });
    child.once("error", () => finish(""));
    child.once("close", () => finish(Buffer.concat(chunks).toString("utf8")));
  });
}

async function taskkill(pid: number): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  await runInternal(path.join(systemRoot, "System32", "taskkill.exe"), [
    "/PID",
    String(pid),
    "/T",
    "/F",
  ]);
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await taskkill(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function redactOutput(context: WorkspaceContext, value: string): string {
  let redacted = value;
  for (const root of new Set([context.root, context.canonicalRoot])) {
    if (process.platform === "win32") {
      const representations = [root, JSON.stringify(root).slice(1, -1)];
      for (const representation of representations) {
        let index = redacted.toLowerCase().indexOf(representation.toLowerCase());
        while (index !== -1) {
          redacted = `${redacted.slice(0, index)}[workspace]${redacted.slice(index + representation.length)}`;
          index = redacted
            .toLowerCase()
            .indexOf(representation.toLowerCase(), index + "[workspace]".length);
        }
      }
    } else {
      redacted = redacted.replaceAll(root, "[workspace]");
    }
  }
  return redacted;
}

export async function executeWorkspaceCommand(
  context: WorkspaceContext,
  input: { executable: string; args: string[]; timeoutMs?: number },
  signal: AbortSignal | undefined,
  registry: WorkspaceProcessRegistry,
): Promise<WorkspaceExecResult> {
  const command = sanitizedCommand(input.executable, input.args);
  if (context.developmentExec?.enabled !== true) return disabledResult(command);
  const invalid = validateCommand(input, context);
  if (invalid !== undefined) return rejectedResult(command, invalid);
  const started = performance.now();
  let before: ProtectedSnapshot;
  try {
    before = await snapshotProtected(context);
  } catch (error) {
    const message = error instanceof WorkspacePolicyError
      ? error.message
      : "Formal Workspace safety snapshot failed";
    return rejectedResult(command, message, Math.round(performance.now() - started));
  }

  const child = spawn(input.executable, input.args, {
    cwd: context.root,
    env: safeEnvironment(context),
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let exitCode: number | null;
  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let outputBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    termination ??= killProcessTree(child.pid ?? -1).finally(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return termination;
  };
  const unregister = registry.register(() => {
    cancelled = true;
    void terminate();
  });
  const capture = (target: Buffer[]) => (chunk: Buffer): void => {
    const remaining = context.limits.maxExecOutputBytes - outputBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const bounded = chunk.subarray(0, remaining);
    target.push(bounded);
    outputBytes += bounded.length;
    if (bounded.length < chunk.length) truncated = true;
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, input.timeoutMs ?? context.limits.maxExecTimeoutMs);
  const onAbort = (): void => {
    cancelled = true;
    void terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();

  try {
    exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (code) => resolve(code));
    });
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await terminate();

    let protectedChanged = false;
    try {
      protectedChanged = !snapshotsEqual(before, await snapshotProtected(context));
    } catch {
      protectedChanged = true;
    }
    if (protectedChanged) await restoreProtected(context, before);
    return {
      command,
      exitCode,
      stdout: redactOutput(context, Buffer.concat(stdout).toString("utf8")),
      stderr: redactOutput(context, Buffer.concat(stderr).toString("utf8")),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      truncated,
      timedOut,
      cancelled,
      policy: protectedChanged ? "rejected" : "allowed",
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    unregister();
  }
}
