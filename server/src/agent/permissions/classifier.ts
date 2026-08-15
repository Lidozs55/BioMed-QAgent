import type { ResourceScope } from "./types.js";
import { canonicalIsWithin } from "./path-normalizer.js";

/**
 * Resource scope classification (plan §15).
 *
 * After canonicalization, a path is classified into exactly one scope:
 *
 * ```text
 * data/workspaces/<currentTaskId>/a.csv          → workspace
 * data/output/tasks/<currentTaskId>/artifacts/…  → task_output
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
}

export function classifyCanonicalPath(
  canonical: string,
  roots: ClassificationRoots,
): ResourceScope {
  if (canonicalIsWithin(roots.workspaceRoot, canonical)) return "workspace";
  if (canonicalIsWithin(roots.taskOutputRoot, canonical)) return "task_output";
  if (canonicalIsWithin(roots.repositoryRoot, canonical)) return "project";
  return "external";
}
