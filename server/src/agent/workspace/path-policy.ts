import path from "node:path";

import {
  classifyCanonicalPath,
  normalizeAgentPathFor,
  PathNormalizationError,
  type NormalizedPath,
  type ResourceScope,
} from "../permissions/index.js";
import type { WorkspaceContext } from "./context.js";
import { WorkspacePolicyError } from "./types.js";

export interface ResolvedAgentPath {
  /** Workspace-relative path when inside the workspace, else the absolute input. */
  displayPath: string;
  /** Absolute (uncanonicalized) path. */
  absolutePath: string;
  /** Canonical absolute path used for classification and IO. */
  canonical: string;
  scope: ResourceScope;
}

/**
 * Resolve an agent path (relative → workspace-anchored, absolute → as-is),
 * canonicalize it, classify its scope, and ask the PermissionBroker for the
 * capability. Throws when the policy denies; suspends while the user decides.
 *
 * The Agent Workspace refactor removed the old "absolute path / ``../``
 * escape → reject" rule: paths now flow through normalize → classify →
 * PermissionBroker (plan §13, §20).
 */
export async function resolveAgentPath(
  context: WorkspaceContext,
  input: string,
  capability: "fs.read" | "fs.write" | "fs.edit",
): Promise<ResolvedAgentPath> {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("Path must be a non-empty string");
  }
  let normalized: NormalizedPath;
  try {
    normalized = await normalizeAgentPathFor(input, context.canonicalWorkspaceRoot);
  } catch (error) {
    if (error instanceof PathNormalizationError) {
      throw new WorkspacePolicyError("INVALID_PATH", error.message);
    }
    throw error;
  }
  const scope = classifyCanonicalPath(normalized.canonical, {
    workspaceRoot: context.canonicalWorkspaceRoot,
    taskOutputRoot: context.taskOutputRoot,
    repositoryRoot: context.repositoryRoot,
  });
  await context.permissions.evaluate({
    capability,
    resource: input,
    canonicalResource: normalized.canonical,
    scope,
  });
  const within = process.platform === "win32"
    ? normalized.canonical.toLowerCase().startsWith(context.canonicalWorkspaceRoot.toLowerCase())
    : normalized.canonical.startsWith(context.canonicalWorkspaceRoot);
  return {
    displayPath: within
      ? path.relative(context.workspaceRoot, normalized.absolute).replaceAll("\\", "/")
      : input,
    absolutePath: normalized.absolute,
    canonical: normalized.canonical,
    scope,
  };
}
