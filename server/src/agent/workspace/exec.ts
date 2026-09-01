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
const DIRECT_NETWORK_EXECUTABLES = new Set(["curl", "curl.exe", "wget", "wget.exe"]);
const HTTP_URL_ARGUMENT = /https?:\/\//iu;
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
  "PYTHONUTF8",
  "PYTHONIOENCODING",
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

/**
 * Spawn-time failures (missing binary, missing execute bit, ...) never reach
 * the child, so stderr arrives empty and the raw errno exception used to
 * escape as an opaque WORKSPACE_OPERATION_FAILED. Prepend an actionable,
 * auditable diagnostic (the errno code is machine-readable and never
 * secret-bearing) so the caller can self-correct instead of blind-retrying.
 */
function spawnDiagnostics(
  code: string | undefined,
  executable: string,
  stderr: string,
): string {
  if (code === undefined) return stderr;
  const hint = code === "EACCES"
    ? " (not executable: grant the execute bit or run through an interpreter)"
    : code === "ENOENT"
    ? " (command not found on PATH and not a workspace-relative file)"
    : code === "EISDIR"
    ? " (path is a directory, not an executable file)"
    : "";
  const prefix = `Failed to spawn ${executable}: ${code}${hint}`;
  return stderr === "" ? prefix : `${prefix}\n${stderr}`;
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
  const combined = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
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
    input.args.length > 1_000 ||
    input.args.some(
      (argument) => typeof argument !== "string" || argument.length > 65_536 || argument.includes("\0"),
    )
  ) {
    return "Executable arguments are invalid";
  }
  const executableBase = input.executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (
    (executableBase !== undefined && DIRECT_NETWORK_EXECUTABLES.has(executableBase)) ||
    input.args.some((argument) => HTTP_URL_ARGUMENT.test(argument))
  ) {
    return "Direct network transport through workspace_exec is not allowed; use governed navigate_page/download_from_page tools or a registered Dataset Core provider";
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
    // Only reached with a real pid on Windows: taskkill on a fabricated id
    // would be a pointless external call (it errors and is swallowed).
    if (pid <= 1) return;
    await taskkill(pid);
    return;
  }
  // A spawn that failed before creating a process (EACCES/ENOENT) leaves
  // ``child.pid`` undefined; the historical ``?? -1`` made ``-pid`` equal 1,
  // i.e. ``process.kill(1, "SIGKILL")`` — a real SIGKILL aimed at init when
  // privileges allow. Never signal anything at or below pid 1.
  if (pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: the group already exited. EPERM: the group is already being
    // reaped (or runs under another uid) — nothing safe to signal.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
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
  // ``error`` fires instead of a child when spawn itself fails (missing
  // binary, no execute bit, ...): capture the errno for the result stderr.
  let spawnErrorCode: string | undefined;
  child.once("error", (error) => {
    spawnErrorCode = (error as NodeJS.ErrnoException).code;
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
      // No pid means spawn never completed — there is no child to kill.
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill("SIGKILL");
      }
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
  }, input.timeoutMs ?? context.limits.defaultExecTimeoutMs);
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
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: spawnDiagnostics(
        spawnErrorCode,
        input.executable,
        Buffer.concat(stderr).toString("utf8"),
      ),
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
