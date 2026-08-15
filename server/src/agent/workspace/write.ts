import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceContext } from "./context.js";
import { resolveAgentPath, type ResolvedAgentPath } from "./path-policy.js";
import { WorkspacePolicyError, type WorkspaceWriteResult } from "./types.js";

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Atomic write core. Callers are responsible for having obtained permission
 * (``writeWorkspaceText`` gates with ``fs.write``; ``editWorkspaceText``
 * gates with ``fs.edit`` and reuses this core so the edit is not evaluated
 * twice under a different capability).
 */
export async function writeWorkspaceTextAt(
  context: WorkspaceContext,
  resolved: ResolvedAgentPath,
  content: string,
): Promise<WorkspaceWriteResult> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > context.limits.maxWriteBytes) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "Write content exceeds Workspace limit");
  }
  // Create parents under the requested path, then canonicalize the parent so
  // the final target follows any symlinked directories (the permission check
  // already classified the canonical ancestor).
  const parent = path.dirname(resolved.absolutePath);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const target = path.join(canonicalParent, path.basename(resolved.absolutePath));
  const created = !(await exists(target));
  if (!created) {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new WorkspacePolicyError("PATH_ESCAPE", "Write target must be a regular file");
    }
  }
  const temporary = path.join(canonicalParent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!created && (code === "EEXIST" || code === "EPERM")) {
        await rm(target);
        await rename(temporary, target);
      } else {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: resolved.displayPath, bytes, created };
}

/**
 * Atomically write text. The permission system decides whether the target is
 * reachable: the workspace is free, task output is read-only by default, and
 * project/external paths require (or ask for) user approval.
 */
export async function writeWorkspaceText(
  context: WorkspaceContext,
  input: { path: string; content: string },
): Promise<WorkspaceWriteResult> {
  if (typeof input.content !== "string") {
    throw new WorkspacePolicyError("NOT_TEXT", "Write content must be text");
  }
  const resolved = await resolveAgentPath(context, input.path, "fs.write");
  return writeWorkspaceTextAt(context, resolved, input.content);
}
