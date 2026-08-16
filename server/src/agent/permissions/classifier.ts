import path from "node:path";

import type { ResourceScope } from "./types.js";
import { isSensitiveResource } from "./types.js";
import { canonicalIsWithin } from "./path-normalizer.js";

/**
 * Resource scope classification (plan §15).
 *
 * After canonicalization, a path is classified into exactly one scope:
 *
 * ```text
 * data/workspaces/<currentTaskId>/a.csv          → workspace
 * data/output/tasks/<currentTaskId>/artifacts/…  → task_output
 * data/settings/…, other task workspaces/outputs → framework_internal
 * <repositoryRoot>/package.json                  → project
 * D:\datasets\TCGA\a.csv                         → external
 * ```
 *
 * The permission system consumes only the standardized scope and never
 * re-interprets directory structure.
 */
export interface ClassificationRoots {
  /** Canonical current-task workspace root. */
  workspaceRoot: string;
  /** Canonical current-task framework output root. */
  taskOutputRoot: string;
  /** Canonical repository root. */
  repositoryRoot: string;
  /** Canonical ``data/`` root (framework control plane lives under it). */
  dataRoot: string;
}

export function classifyCanonicalPath(
  canonical: string,
  roots: ClassificationRoots,
): ResourceScope {
  if (canonicalIsWithin(roots.workspaceRoot, canonical)) return "workspace";
  if (canonicalIsWithin(roots.taskOutputRoot, canonical)) return "task_output";
  // Framework control plane (P0 audit): ``data/settings/**`` (persisted
  // permission rules + model credentials live there) and EVERY task's
  // workspace / framework output except the current one are protected from
  // ordinary project grants. The current task's dirs were already matched
  // above; anything else under these roots is framework-internal, whether
  // it belongs to another task or to the settings control plane. The
  // evaluator hard-denies this scope before any grant/rule/preset.
  const settingsRoot = path.join(roots.dataRoot, "settings");
  const workspacesRoot = path.join(roots.dataRoot, "workspaces");
  const outputTasksRoot = path.join(roots.dataRoot, "output", "tasks");
  if (
    canonicalIsWithin(settingsRoot, canonical) ||
    canonicalIsWithin(workspacesRoot, canonical) ||
    canonicalIsWithin(outputTasksRoot, canonical)
  ) {
    return "framework_internal";
  }
  // Sensitive resource names (.env, key/pem, credentials/secrets) get their
  // own scope: an approved project/external grant must not auto-cover them
  // (round-3 audit). The current task's dirs were matched above.
  if (isSensitiveResource(canonical)) return "sensitive";
  if (canonicalIsWithin(roots.repositoryRoot, canonical)) return "project";
  return "external";
}
