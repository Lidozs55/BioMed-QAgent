import path from "node:path";

import {
  canonicalizeWithAncestor,
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
    dataRoot: context.dataRoot,
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

/**
 * Re-verify the approved target right before IO (round-3 audit: path TOCTOU).
 *
 * A request can stay pending for a long time; a symlink/junction in the path
 * may be swapped while the user decides. On resume the target is
 * canonicalized again and must resolve to the SAME canonical path and scope
 * the approval was granted for — otherwise the old approval is void and the
 * operation fails instead of reading/writing a different target. The agent
 * retries the operation, which enters the broker again with the new
 * canonical target and asks afresh.
 */
export async function verifyAgentPathUnchanged(
  context: WorkspaceContext,
  resolved: ResolvedAgentPath,
): Promise<void> {
  const canonical = await canonicalizeWithAncestor(resolved.absolutePath);
  const scope = classifyCanonicalPath(canonical, {
    workspaceRoot: context.canonicalWorkspaceRoot,
    taskOutputRoot: context.taskOutputRoot,
    dataRoot: context.dataRoot,
    repositoryRoot: context.repositoryRoot,
  });
  const samePath = process.platform === "win32"
    ? canonical.toLowerCase() === resolved.canonical.toLowerCase()
    : canonical === resolved.canonical;
  if (!samePath || scope !== resolved.scope) {
    throw new WorkspacePolicyError(
      "PATH_ESCAPE",
      "Resource changed after permission was granted; please retry the operation",
    );
  }
}
