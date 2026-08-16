import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalizeWithAncestor } from "../permissions/path-normalizer.js";
import type { PermissionBroker } from "../permissions/broker.js";
import type { WorkspaceAuditSink } from "./audit.js";
import { WorkspacePolicyError, type WorkspaceLimits } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 64 * 1024,
  maxReadCharacters: 64 * 1024,
  maxListDepth: 3,
  maxListEntries: 200,
  maxSearchFileBytes: 128 * 1024,
  maxSearchFiles: 200,
  maxSearchResults: 100,
  maxSearchLineChars: 1_000,
  maxSearchOutputChars: 32 * 1024,
  maxWriteBytes: 256 * 1024,
  maxExecOutputBytes: 64 * 1024,
  maxExecTimeoutMs: 30_000,
};

/**
 * Workspace context (Agent Workspace refactor).
 *
 * ``workspaceRoot`` is the agent-owned working directory
 * (``data/workspaces/<taskId>``); ``taskOutputRoot`` is the framework-owned
 * output (``data/output/tasks/<taskId>``). All file tools resolve paths
 * relative to ``workspaceRoot`` and may reach other roots only through the
 * permission system.
 */
export interface TaskWorkspaceConfig {
  taskId: string;
  runId: string;
  piSessionId?: string;
  workspaceRoot: string;
  taskOutputRoot: string;
  dataRoot: string;
  repositoryRoot: string;
  /** Permission control plane: every file tool request passes through it. */
  permissions: PermissionBroker;
  audit: WorkspaceAuditSink;
  limits?: Partial<WorkspaceLimits>;
}

export interface WorkspaceContext {
  taskId: string;
  runId: string;
  piSessionId?: string;
  workspaceRoot: string;
  canonicalWorkspaceRoot: string;
  taskOutputRoot: string;
  dataRoot: string;
  repositoryRoot: string;
  permissions: PermissionBroker;
  audit: WorkspaceAuditSink;
  limits: WorkspaceLimits;
}

function requireSafeId(name: string, value: string | undefined, optional = false): void {
  if (optional && value === undefined) return;
  if (value === undefined || !SAFE_ID.test(value)) {
    throw new WorkspacePolicyError(
      "INVALID_IDENTITY",
      `${name} must be one safe path component`,
    );
  }
}

function validatedLimits(overrides: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkspacePolicyError("LIMIT_EXCEEDED", `${name} must be a positive integer`);
    }
  }
  return limits;
}

export async function createWorkspaceContext(
  config: TaskWorkspaceConfig,
): Promise<WorkspaceContext> {
  requireSafeId("taskId", config.taskId);
  requireSafeId("runId", config.runId);
  requireSafeId("piSessionId", config.piSessionId, true);
  for (const [name, value] of [
    ["workspaceRoot", config.workspaceRoot],
    ["taskOutputRoot", config.taskOutputRoot],
    ["dataRoot", config.dataRoot],
    ["repositoryRoot", config.repositoryRoot],
  ] as const) {
    if (!path.isAbsolute(value)) {
      throw new WorkspacePolicyError("INVALID_PATH", `${name} must be absolute`);
    }
  }
  const workspaceRoot = path.resolve(config.workspaceRoot);
  try {
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new WorkspacePolicyError("NOT_FOUND", "Task Workspace root must exist", {
      cause: error,
    });
  }
  // Canonicalize EVERY security-boundary root, not just the workspace (audit
  // fix): the classifier assumes its input roots are canonical, so a symlink/
  // junction-exposed task-output or repository root would otherwise let a
  // canonical candidate escape containment checks and be mis-classified.
  // ``canonicalizeWithAncestor`` handles not-yet-created roots (task output
  // dirs are created lazily) by resolving through the nearest existing
  // ancestor and re-appending the missing suffix.
  const [canonicalWorkspaceRoot, taskOutputRoot, dataRoot, repositoryRoot] =
    await Promise.all([
      realpath(workspaceRoot),
      canonicalizeWithAncestor(path.resolve(config.taskOutputRoot)),
      canonicalizeWithAncestor(path.resolve(config.dataRoot)),
      canonicalizeWithAncestor(path.resolve(config.repositoryRoot)),
    ]);
  return {
    taskId: config.taskId,
    runId: config.runId,
    piSessionId: config.piSessionId,
    workspaceRoot,
    canonicalWorkspaceRoot,
    taskOutputRoot,
    dataRoot,
    repositoryRoot,
    permissions: config.permissions,
    audit: config.audit,
    limits: validatedLimits(config.limits),
  };
}
