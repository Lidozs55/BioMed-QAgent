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
 * 2. framework-internal scope       → deny
 * 3. Restricted preset              → its matrix (grants/rules never beat it)
 * 4. temporary grant                → allow
 * 5. persistent explicit rule       → allow / ask / deny
 * 6. preset default                 → allow / ask / deny
 * ```
 *
 * The Restricted preset is a hard lockdown (audit fix): it is evaluated
 * before temporary grants and persistent rules, so a ``fs.write`` grant
 * approved while the preset was permissive cannot survive a later switch to
 * Restricted, and existing allow rules never beat it. When multiple
 * persistent path rules match, the **most specific path wins** (longest
 * canonical prefix), never configuration order.
 */
export interface EvaluatorOptions {
  protectedPaths: ProtectedPaths;
  grants: TemporaryGrantStore;
  policyStore: PermissionPolicyStore;
  /** Migration feature flag override for process.exec (plan §58). */
  execPolicyOverride?: "deny" | "ask" | "allow";
}

export type EvaluationResult =
  | { decision: "allow"; reason: "invariant_skipped" | "temporary_grant" | "rule" | "default" }
  | { decision: "deny"; reason: "protected" | "rule" | "default" }
  | { decision: "ask"; reason: "rule" | "default" };

export class PermissionEvaluator {
  private readonly protectedPaths: ProtectedPaths;
  private readonly grants: TemporaryGrantStore;
  private readonly policyStore: PermissionPolicyStore;
  private readonly execPolicyOverride?: "deny" | "ask" | "allow";

  constructor(options: EvaluatorOptions) {
    this.protectedPaths = options.protectedPaths;
    this.grants = options.grants;
    this.policyStore = options.policyStore;
    this.execPolicyOverride = options.execPolicyOverride;
  }

  async evaluate(request: PermissionRequest): Promise<EvaluationResult> {
    // Framework control plane (P0 audit): settings, model credentials and
    // every other task's workspace/output are hard-denied for ALL
    // capabilities before any grant, rule, or preset — a project-scope
    // grant can never reach them (ADR-026 §2).
    if (request.scope === "framework_internal") {
      return { decision: "deny", reason: "protected" };
    }
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
    const settings = await this.policyStore.getSettings();
    if (settings.preset === "restricted") {
      // Hard lockdown: under Restricted no temporary grant and no persistent
      // rule can escalate past the preset matrix (audit fix). The matrix
      // allows workspace fs, denies project/external fs.
      const matrix = await this.policyStore.matrix();
      return policyResult(matrix[capability][request.scope]);
    }
    if (this.grants.matches(request.taskId, request.runId, capability, request.scope, canonical)) {
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
    const settings = await this.policyStore.getSettings();
    if (settings.preset === "restricted") {
      // The Restricted preset guarantees command execution is denied even
      // when a temporary grant or persistent exec approval exists (audit
      // fix: revocation must be effective, not just displayed).
      return { decision: "deny", reason: "default" };
    }
    if (this.grants.matches(request.taskId, request.runId, "process.exec", request.scope)) {
      return { decision: "allow", reason: "temporary_grant" };
    }
    if (this.execPolicyOverride !== undefined) {
      return policyResult(this.execPolicyOverride);
    }
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
    case "framework_internal": return "framework internal";
    case "sensitive": return "sensitive";
    case "project": return "project";
    case "external": return "external";
  }
}
