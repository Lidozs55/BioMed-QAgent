import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { canonicalizeWithAncestor } from "../permissions/path-normalizer.js";
import { PermissionDeniedError } from "../permissions/index.js";
import type { WorkspaceContext } from "./context.js";
import type { WorkspaceExecResult } from "./types.js";

const SECRET_ARGUMENT = /(?:api[-_]?key|authorization|password|secret|token)(?:=|:)/i;
/** ``--token value`` style flag whose NEXT argument is the secret value. */
const SECRET_FLAG = /^--?(?:api[-_]?key|authorization|password|secret|token)$/i;
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

interface ActiveCommand {
  cancel(): void;
  done: Promise<void>;
  complete(): void;
}

export class WorkspaceProcessRegistry {
  readonly #active = new Set<ActiveCommand>();

  get activeCount(): number {
    return this.#active.size;
  }

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

/**
 * Resolve how a bare executable name would be found at spawn time. The spawn
 * uses the raw name through PATH (plus PATHEXT on Windows); the approval
 * card must show the REAL binary, never a fabricated ``<workspace>/name``
 * that would never execute (round-4 audit).
 */
async function resolveOnPath(executable: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
    : [""];
  const directories = pathEnv.split(path.delimiter).filter((dir) => dir !== "");
  for (const directory of directories) {
    const base = path.join(directory, executable);
    const candidates = process.platform === "win32" && path.extname(base) === ""
      ? extensions.map((ext) => `${base}${ext}`)
      : [base];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isDirectory()) {
          return await canonicalizeWithAncestor(candidate).catch(() => candidate);
        }
      } catch {
        // Not found in this directory; keep searching.
      }
    }
  }
  return null;
}

/**
 * Build the display/audit form of a command (round-3/round-4 audit): the
 * executable keeps its FULL path so the approval card shows exactly WHICH
 * binary would run:
 *
 * - absolute path → canonicalized;
 * - relative path with a separator (``./bin/tool``) → resolved against the
 *   spawn cwd (the workspace root) — never against the server cwd;
 * - bare name (``python``) → looked up through PATH/PATHEXT; when the lookup
 *   fails the name is shown with an explicit ``(resolved via PATH)`` note
 *   instead of a fake workspace-relative path.
 *
 * Secret-looking argument values are redacted (both ``--token=value`` and
 * ``--token value`` forms). The permission system and audit see this form;
 * the actual spawn still uses the raw ``executable``/``args`` inputs.
 */
export async function sanitizedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string[]> {
  let shownExecutable = executable;
  if (typeof executable === "string" && executable.trim() !== "") {
    if (path.isAbsolute(executable)) {
      shownExecutable = await canonicalizeWithAncestor(executable).catch(() => executable);
    } else if (executable.includes("/") || executable.includes("\\")) {
      // Relative path with a separator: spawn resolves it against its cwd,
      // which is the workspace root — resolve against the same base.
      const target = path.resolve(cwd, executable);
      shownExecutable = await canonicalizeWithAncestor(target).catch(() => target);
    } else {
      const resolved = await resolveOnPath(executable);
      shownExecutable = resolved === null
        ? `${executable} (resolved via PATH)`
        : resolved;
    }
  }
  return [shownExecutable, ...redactArguments(args)];
}

/**
 * Stateful argument redaction (round-4 audit): ``--token=value`` is caught
 * as a single argument, but the very common ``--token value`` two-argument
 * form would leak the value — the flag consumes the following argument too.
 */
function redactArguments(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const argument of args) {
    if (hideNext) {
      out.push("[redacted]");
      hideNext = false;
      continue;
    }
    if (SECRET_ARGUMENT.test(argument)) {
      out.push("[redacted]");
      continue;
    }
    if (SECRET_FLAG.test(argument)) {
      out.push("[redacted]");
      hideNext = true;
      continue;
    }
    out.push(argument);
  }
  return out;

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

function safeEnvironment(): NodeJS.ProcessEnv {
  const combined = { ...process.env };
  return Object.fromEntries(
    Object.entries(combined).filter(
      ([key, value]) => value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()),
    ),
  ) as NodeJS.ProcessEnv;
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
  for (const root of new Set([context.workspaceRoot, context.canonicalWorkspaceRoot])) {
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
  const command = await sanitizedCommand(input.executable, input.args, context.workspaceRoot);
  const invalid = validateCommand(input, context);
  if (invalid !== undefined) return rejectedResult(command, invalid);
  // process.exec is an independent high-risk capability (plan §25–§27): the
  // cwd being the workspace is NOT a sandbox. The broker decides, defaulting
  // to ask; the execution runtime below keeps the operational controls
  // (timeout, output limits, cancel, process-tree cleanup, audit).
  try {
    await context.permissions.evaluate({
      capability: "process.exec",
      command: command.join(" "),
      cwd: context.workspaceRoot,
      scope: "workspace",
      signal,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return rejectedResult(command, `Permission denied: ${error.message}`);
    }
    throw error;
  }
  const started = performance.now();
  const child = spawn(input.executable, input.args, {
    cwd: context.workspaceRoot,
    env: safeEnvironment(),
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
    return {
      command,
      exitCode,
      stdout: redactOutput(context, Buffer.concat(stdout).toString("utf8")),
      stderr: redactOutput(context, Buffer.concat(stderr).toString("utf8")),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      truncated,
      timedOut,
      cancelled,
      policy: "allowed",
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    unregister();
  }
}
