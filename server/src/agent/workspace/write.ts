import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceContext } from "./context.js";
import { resolveWorkspacePath, verifyCanonicalPath } from "./path-policy.js";
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
export async function writeWorkspaceText(
  context: WorkspaceContext,
  input: { path: string; content: string },
): Promise<WorkspaceWriteResult> {
  if (typeof input.content !== "string") {
    throw new WorkspacePolicyError("NOT_TEXT", "Write content must be text");
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > context.limits.maxWriteBytes) {
    throw new WorkspacePolicyError("LIMIT_EXCEEDED", "Write content exceeds Workspace limit");
  }
  const resolved = await resolveWorkspacePath(context, input.path, "write");
  const parent = path.dirname(resolved.absolutePath);
  await mkdir(parent, { recursive: true });
  await verifyCanonicalPath(context, parent);
  const created = !(await exists(resolved.absolutePath));
  if (!created) {
    const target = await lstat(resolved.absolutePath);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new WorkspacePolicyError("PATH_ESCAPE", "Write target must be a regular file");
    }
  }
  const temporary = path.join(parent, `.${path.basename(resolved.absolutePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, input.content, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, resolved.absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!created && (code === "EEXIST" || code === "EPERM")) {
        await rm(resolved.absolutePath);
        await rename(temporary, resolved.absolutePath);
      } else {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: resolved.relativePath, bytes, created };
}
