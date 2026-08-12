import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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
  maxSnapshotFiles: 2_000,
  maxSnapshotBytes: 16 * 1024 * 1024,
};

export interface DevelopmentExecConfig {
  enabled: true;
  environment?: Readonly<Record<string, string | undefined>>;
}
export interface TaskWorkspaceConfig {
  taskId: string;
  runId: string;
  piSessionId?: string;
  root: string;
  audit: WorkspaceAuditSink;
  limits?: Partial<WorkspaceLimits>;
  developmentExec?: DevelopmentExecConfig;
}

export interface WorkspaceContext {
  taskId: string;
  runId: string;
  piSessionId?: string;
  root: string;
  canonicalRoot: string;
  audit: WorkspaceAuditSink;
  limits: WorkspaceLimits;
  developmentExec?: DevelopmentExecConfig;
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
  if (!path.isAbsolute(config.root)) {
    throw new WorkspacePolicyError("INVALID_PATH", "Workspace root must be absolute");
  }
  const root = path.resolve(config.root);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new WorkspacePolicyError("NOT_FOUND", "Task Workspace root must exist", {
      cause: error,
    });
  }
  return {
    taskId: config.taskId,
    runId: config.runId,
    piSessionId: config.piSessionId,
    root,
    canonicalRoot: await realpath(root),
    audit: config.audit,
    limits: validatedLimits(config.limits),
    developmentExec: config.developmentExec,
  };
}
