import path from "node:path";

import { WorkspacePolicyError } from "./types.js";
import { requireSafeId } from "../ids.js";

/**
 * Single source of truth for workspace / task-output path derivation
 * (Agent Workspace refactor, plan §11/§13).
 *
 * Layout:
 *
 * ```text
 * data/
 * ├── workspaces/
 * │   └── <taskId>/          ← Agent-owned working filesystem
 * └── output/
 *     └── tasks/
 *         └── <taskId>/      ← BioMed-owned application state/output
 * ```
 *
 * Business code must go through this module (or WorkspaceManager) instead of
 * re-assembling paths with ``path.join(DATA_ROOT, "workspaces", taskId)`` so
 * the rules never scatter again.
 */
export interface WorkspacePathConfig {
  /** Repository root (e.g. ``D:\\coding\\BioMed-QAgent``). */
  repositoryRoot: string;
  /** ``data/`` root (sibling of the output dir). */
  dataRoot: string;
  /** Framework task output root (``data/output`` by default). */
  outputRoot: string;
  /** Agent workspace root (``data/workspaces`` by default). */
  workspacesRoot: string;
  /** Task output tasks root (``data/output/tasks``). */
  tasksRoot: string;
}

export interface WorkspacePathInputs {
  repositoryRoot: string;
  workspacesRoot: string;
  tasksRoot: string;
}

export function resolveWorkspacePathConfig(input: WorkspacePathInputs): WorkspacePathConfig {
  const outputRoot = path.resolve(path.dirname(path.resolve(input.tasksRoot)));
  return {
    repositoryRoot: path.resolve(input.repositoryRoot),
    dataRoot: path.resolve(path.dirname(outputRoot)),
    outputRoot,
    workspacesRoot: path.resolve(input.workspacesRoot),
    tasksRoot: path.resolve(input.tasksRoot),
  };
}

export function taskWorkspacePath(workspacesRoot: string, taskId: string): string {
  requireSafeTaskId(taskId);
  return path.join(path.resolve(workspacesRoot), taskId);
}

export function taskOutputPath(tasksRoot: string, taskId: string): string {
  requireSafeTaskId(taskId);
  return path.join(path.resolve(tasksRoot), taskId);
}

export function requireSafeTaskId(taskId: string): void {
  requireSafeId("taskId", taskId, {
    message: "taskId must be one safe path component",
    errorFactory: (message) => new WorkspacePolicyError("INVALID_IDENTITY", message),
  });
}
