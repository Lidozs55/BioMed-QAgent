import path from "node:path";

import { canonicalIsWithin } from "./path-normalizer.js";
import type { ProtectedPaths } from "./protected-paths.js";
import type { PermissionPolicyStore } from "./policy-store.js";
import type { TemporaryGrantStore } from "./grants.js";
import type {
  FilePermissionRule,
  PermissionPolicy,
  PermissionRequest,
  ResourceScope,
} from "./types.js";

/**
 * Permission decision evaluation (plan §19).
 *
 * Order of decision:
 *
 * ```text
 * 1. framework invariant            → deny
 * 2. temporary grant                → allow
 * 3. persistent explicit rule       → allow / ask / deny
 * 4. preset default                 → allow / ask / deny
 * ```
 *
 * When multiple persistent path rules match, the **most specific path wins**
 * (longest canonical prefix), never configuration order.
 */
export interface EvaluatorOptions {
  protectedPaths: ProtectedPaths;
  grants: TemporaryGrantStore;
  policyStore: PermissionPolicyStore;
}

export type EvaluationResult =
  | { decision: "allow"; reason: "invariant_skipped" | "temporary_grant" | "rule" | "default" }
  | { decision: "deny"; reason: "protected" | "rule" | "default" }
  | { decision: "ask"; reason: "rule" | "default" };

export class PermissionEvaluator {
  private readonly protectedPaths: ProtectedPaths;
  private readonly grants: TemporaryGrantStore;
  private readonly policyStore: PermissionPolicyStore;

  constructor(options: EvaluatorOptions) {
    this.protectedPaths = options.protectedPaths;
    this.grants = options.grants;
    this.policyStore = options.policyStore;
  }

  async evaluate(request: PermissionRequest): Promise<EvaluationResult> {
    if (request.capability === "process.exec") {
      return this.evaluateExec(request);
    }
    return this.evaluateFile(request);
  }

  private async evaluateFile(request: PermissionRequest): Promise<EvaluationResult> {
    const canonical = request.canonicalResource;
    if (canonical === undefined) {
      return { decision: "deny", reason: "default" };
    }
    const capability = request.capability as "fs.read" | "fs.write" | "fs.edit";
    if (this.protectedPaths.isProtected(canonical, capability)) {
      return { decision: "deny", reason: "protected" };
    }
    if (this.grants.matches(request.taskId, request.runId, capability, request.scope)) {
      return { decision: "allow", reason: "temporary_grant" };
    }
    const rule = await this.mostSpecificRule(capability, canonical);
    if (rule !== null) {
      return rule.policy === "allow"
        ? { decision: "allow", reason: "rule" }
        : rule.policy === "deny"
          ? { decision: "deny", reason: "rule" }
          : { decision: "ask", reason: "rule" };
    }
    const matrix = await this.policyStore.matrix();
    return policyResult(matrix[capability][request.scope]);
  }

  private async evaluateExec(request: PermissionRequest): Promise<EvaluationResult> {
    if (this.grants.matches(request.taskId, request.runId, "process.exec", request.scope)) {
      return { decision: "allow", reason: "temporary_grant" };
    }
    const settings = await this.policyStore.getSettings();
    if (settings.persistent_exec_allow) {
      return { decision: "allow", reason: "rule" };
    }
    const matrix = await this.policyStore.matrix();
    return policyResult(matrix["process.exec"][request.scope]);
  }

  private async mostSpecificRule(
    capability: "fs.read" | "fs.write" | "fs.edit",
    canonical: string,
  ): Promise<FilePermissionRule | null> {
    const settings = await this.policyStore.getSettings();
    let best: FilePermissionRule | null = null;
    let bestLength = -1;
    for (const rule of settings.rules) {
      if (rule.capability !== capability) continue;
      const ruleRoot = path.resolve(rule.path);
      const matches = rule.recursive
        ? canonicalIsWithin(ruleRoot, canonical)
        : path.resolve(canonical) === ruleRoot;
      if (!matches) continue;
      const specificity = ruleRoot.length;
      if (specificity > bestLength) {
        best = rule;
        bestLength = specificity;
      }
    }
    return best;
  }
}

function policyResult(policy: PermissionPolicy): EvaluationResult {
  return policy === "allow"
    ? { decision: "allow", reason: "default" }
    : policy === "deny"
      ? { decision: "deny", reason: "default" }
      : { decision: "ask", reason: "default" };
}

export function scopeLabel(scope: ResourceScope): string {
  switch (scope) {
    case "workspace": return "workspace";
    case "task_output": return "task output";
    case "project": return "project";
    case "external": return "external";
  }
}
