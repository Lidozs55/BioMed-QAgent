import path from "node:path";

import { canonicalIsWithin } from "./path-normalizer.js";

/**
 * Framework-invariant paths (plan §23, §48).
 *
 * Even when the surrounding scope is allowed, ordinary ``fs.write`` /
 * ``fs.edit`` must never touch framework protocol directories of the current
 * task:
 *
 * ```text
 * data/output/tasks/<taskId>/state/**
 * data/output/tasks/<taskId>/logs/**
 * data/output/tasks/<taskId>/artifacts/**
 * ```
 *
 * These are application protocol, not user files. The evaluator checks this
 * invariant before any grant or default (hard deny). Formal artifacts are
 * still produced exclusively by the Dataset Core; if ``process.exec`` is
 * allowed and bypasses this protection, artifact integrity checks (manifest
 * + hash) detect the modification (plan §24).
 */
const PROTECTED_RELATIVE_DIRECTORIES = ["state", "logs", "artifacts"];

export interface ProtectedPathsOptions {
  taskOutputRoot: string;
}

export class ProtectedPaths {
  private readonly taskOutputRoot: string;

  constructor(options: ProtectedPathsOptions) {
    this.taskOutputRoot = path.resolve(options.taskOutputRoot);
  }

  /** True when the canonical path lies under a protected framework directory. */
  isProtected(canonical: string, capability: "fs.read" | "fs.write" | "fs.edit"): boolean {
    if (capability === "fs.read") return false; // reads of output stay allowed
    for (const name of PROTECTED_RELATIVE_DIRECTORIES) {
      const protectedRoot = path.join(this.taskOutputRoot, name);
      if (canonicalIsWithin(protectedRoot, canonical)) return true;
    }
    return false;
  }
}
