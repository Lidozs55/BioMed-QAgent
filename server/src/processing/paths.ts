/**
 * Task-local file resolution for processing tools (P5-08).
 *
 * Mirrors Python ``app/tools/workdir.py::resolve_task_local_file``: a tool
 * accepts a path relative to the task root or an absolute path that must
 * stay inside the task root. Anything else is rejected before any file I/O
 * so a caller can never steer parsing outside the task workspace.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve an existing file inside ``taskRoot``.
 *
 * Returns the absolute path when the file exists; throws ``FileNotFoundError``
 * semantics via an error with ``code === "ENOENT"`` when missing and a plain
 * ``Error`` for task-root escapes (Python raises ValueError there).
 */
export async function resolveTaskLocalFile(value: string, taskRoot: string): Promise<string> {
  const requested = path.isAbsolute(value) ? value : path.join(taskRoot, value);
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = await realpath(taskRoot);
    candidateReal = await realpath(requested);
  } catch {
    throw notFoundError(value);
  }
  const relative = path.relative(rootReal, candidateReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("source path must remain inside the task work directory");
  }
  return candidateReal;
}

function notFoundError(value: string): NodeJS.ErrnoException {
  const error = new Error(`file not found: ${value}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

/** True when the error is a task-local "file missing" failure. */
export function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Convert an absolute path under ``taskRoot`` to a task-root-relative path
 * (forward slashes). P5-08B contract: tool ``outputs`` are taskRoot-relative.
 */
export function toTaskRelative(absolute: string, taskRoot: string): string {
  const root = path.resolve(taskRoot);
  const target = path.resolve(absolute);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return target;
  }
  return relative.split(path.sep).join("/");
}
