import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceContext } from "./context.js";
import { WorkspacePolicyError } from "./types.js";

const RESERVED_WINDOWS_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export interface ResolvedWorkspacePath {
  relativePath: string;
  absolutePath: string;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Normalize a workspace-relative agent path.
 *
 * The Agent Workspace refactor removed the ``source_assets/parsed/...``
 * allowlist: the workspace is the agent's own directory, so every relative
 * path inside it is writable. Absolute paths are accepted from the
 * permission-system layer (path-normalizer), not here.
 */
export function normalizeAgentPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new WorkspacePolicyError("INVALID_PATH", "Path must be a non-empty string");
  }
  const slashPath = input.replaceAll("\\", "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/.test(slashPath)
  ) {
    throw new WorkspacePolicyError("INVALID_PATH", "Absolute and device paths are forbidden");
  }
  const rawParts = slashPath.split("/");
  if (rawParts.some((part) => part === "..")) {
    throw new WorkspacePolicyError("INVALID_PATH", "Parent traversal is forbidden");
  }
  const parts = rawParts.filter((part) => part !== "" && part !== ".");
  for (const part of parts) {
    if (part.endsWith(".") || part.endsWith(" ") || RESERVED_WINDOWS_NAME.test(part)) {
      throw new WorkspacePolicyError("INVALID_PATH", "Reserved path aliases are forbidden");
    }
  }
  return parts.join("/");
}

async function canonicalExistingAncestor(target: string): Promise<string> {
  let candidate = target;
  while (true) {
    try {
      await lstat(candidate);
      return realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function ensureCanonicalContainment(
  context: WorkspaceContext,
  absolutePath: string,
): Promise<void> {
  let canonical: string;
  try {
    canonical = await canonicalExistingAncestor(absolutePath);
  } catch (error) {
    throw new WorkspacePolicyError("NOT_FOUND", "Workspace path does not exist", {
      cause: error,
    });
  }
  if (!isContained(context.canonicalWorkspaceRoot, canonical)) {
    throw new WorkspacePolicyError("PATH_ESCAPE", "Resolved path escapes Task Workspace");
  }
}

/** Resolve a workspace-relative path and verify canonical containment. */
export async function resolveWorkspacePath(
  context: WorkspaceContext,
  input: string,
): Promise<ResolvedWorkspacePath> {
  const relativePath = normalizeAgentPath(input);
  const absolutePath = relativePath === ""
    ? context.workspaceRoot
    : path.resolve(context.workspaceRoot, ...relativePath.split("/"));
  if (!isContained(context.workspaceRoot, absolutePath)) {
    throw new WorkspacePolicyError("PATH_ESCAPE", "Path escapes Task Workspace");
  }
  await ensureCanonicalContainment(context, absolutePath);
  return { relativePath, absolutePath };
}

export async function verifyCanonicalPath(
  context: WorkspaceContext,
  absolutePath: string,
): Promise<void> {
  await ensureCanonicalContainment(context, absolutePath);
}
