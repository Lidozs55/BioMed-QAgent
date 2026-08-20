import {
  EVALUATION_DIAGNOSTIC_BOUNDARIES,
  parseEvaluationDiagnosticReport,
  type EvaluationCheckStatus,
  type EvaluationDiagnosticFinding,
  type EvaluationDiagnosticReport,
} from "@biomed/contracts";

import type { GoldEvidenceInventory } from "./gold-evidence/inventory.js";
import type { ReferenceRequirements } from "./reference-requirements.js";

export interface DiagnoseEvidenceInput {
  inventory: GoldEvidenceInventory;
  requirements: ReferenceRequirements;
}

function compareFindings(
  left: EvaluationDiagnosticFinding,
  right: EvaluationDiagnosticFinding,
): number {
  const boundary = EVALUATION_DIAGNOSTIC_BOUNDARIES.indexOf(left.boundary) -
    EVALUATION_DIAGNOSTIC_BOUNDARIES.indexOf(right.boundary);
  if (boundary !== 0) return boundary;
  return left.code.localeCompare(right.code) ||
    left.requirement_ref.localeCompare(right.requirement_ref) ||
    left.evidence_refs.join("\u0000").localeCompare(right.evidence_refs.join("\u0000")) ||
    left.message.localeCompare(right.message);
}

function warning(finding: EvaluationDiagnosticFinding): EvaluationDiagnosticFinding {
  return { ...finding, severity: "warning" };
}

function insufficientEvidence(
  checks: Readonly<Record<string, EvaluationCheckStatus>>,
  evidenceRefs: readonly string[],
): EvaluationDiagnosticFinding {
  const unknown = Object.entries(checks)
    .filter(([, status]) => status === "unknown")
    .map(([name]) => name)
    .sort();
  return {
    code: "evaluator.insufficient_evidence",
    severity: "blocker",
    boundary: "evaluator",
    requirement_ref: unknown.length > 0 ? unknown.join(",") : "diagnostic_evidence",
    evidence_refs: [...new Set(evidenceRefs)].sort(),
    message: unknown.length > 0
      ? `Evidence is insufficient to evaluate: ${unknown.join(", ")}`
      : "Evidence is insufficient to determine a strict result",
  };
}

function blockedEvidence(evidenceRefs: readonly string[]): EvaluationDiagnosticFinding {
  return {
    code: "evaluator.evidence_blocked",
    severity: "blocker",
    boundary: "evaluator",
    requirement_ref: "blocked_check",
    evidence_refs: [...new Set(evidenceRefs)].sort(),
    message: "At least one evaluation check is blocked and requires external resolution",
  };
}

export function diagnoseEvidenceBoundary(
  input: DiagnoseEvidenceInput,
): EvaluationDiagnosticReport {
  const checks = input.inventory.checks;
  const checkStatuses = Object.values(checks);
  const allChecksPass = checkStatuses.every((status) => status === "pass");
  const hasBlockedCheck = checkStatuses.some((status) => status === "blocked");
  const inventoryFindings = input.inventory.findings
    .map((finding) => finding.code === "evidence.historical_inadmissible" ? warning(finding) : { ...finding })
    .sort(compareFindings);
  const uncheckable = input.requirements.uncheckable.map<EvaluationDiagnosticFinding>((requirement) => ({
    code: "evaluator.requirement_uncheckable",
    severity: "warning",
    boundary: "evaluator",
    requirement_ref: requirement.requirement_id,
    evidence_refs: [],
    message: requirement.reason,
  }));
  const candidates = inventoryFindings.filter((finding) => finding.severity === "blocker");
  if (candidates.length === 0 && hasBlockedCheck) {
    candidates.push(blockedEvidence(input.inventory.evidence_refs));
  } else if (candidates.length === 0 && !allChecksPass) {
    candidates.push(insufficientEvidence({
      frozen_inputs: checks.frozen_inputs,
      execution: checks.execution,
      trusted_inputs: checks.trusted_inputs,
      semantic_product: checks.semantic_product,
      publication: checks.publication,
      reproducibility: checks.reproducibility,
    }, input.inventory.evidence_refs));
  }

  const primary = candidates.sort(compareFindings)[0] ?? null;
  const findings = [...inventoryFindings, ...uncheckable]
    .filter((finding) => primary === null || finding !== primary)
    .map(warning);
  if (primary !== null) findings.push({ ...primary, severity: "blocker" });

  const strictStatus = allChecksPass
    ? "pass"
    : hasBlockedCheck
      ? "blocked"
      : "fail";
  return parseEvaluationDiagnosticReport({
    schema_version: "1.0",
    case_id: input.inventory.case_id,
    product_commit: input.inventory.target_product_commit,
    strict_status: strictStatus,
    checks,
    findings,
  });
}
