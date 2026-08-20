import { describe, expect, test } from "vitest";

import type { GoldEvidenceInventory } from "../src/evaluation/gold-evidence/inventory.js";
import { diagnoseEvidenceBoundary } from "../src/evaluation/diagnosis-engine.js";
import type { ReferenceRequirements } from "../src/evaluation/reference-requirements.js";

const requirements: ReferenceRequirements = {
  schema_id: "fixture-reference",
  version: "1",
  family: "example_family",
  tables: [],
  relations: [],
  required_provenance: [],
  optional_contracts: {},
  uncheckable: [],
};

function inventory(
  overrides: Partial<GoldEvidenceInventory> = {},
): GoldEvidenceInventory {
  return {
    schema_version: "1.0",
    case_id: "case-a",
    target_product_commit: "a".repeat(40),
    identity: {
      status: "pass",
      manifest_id: "fixture",
      manifest_version: 1,
      product_commit: "a".repeat(40),
      request_id: "request-a",
      task_id: "task-a",
      run_id: "run-a",
      accepted_status: "queued",
      terminal_status: "completed",
      hash_checks: {},
    },
    historical: {
      status: "unknown",
      admissible_as_current_evidence: null,
    },
    checks: {
      frozen_inputs: "pass",
      execution: "pass",
      trusted_inputs: "unknown",
      semantic_product: "unknown",
      publication: "unknown",
      reproducibility: "unknown",
    },
    observed: {
      task_status: "completed",
      run_status: "completed",
      build_status: "succeeded",
      build_id: "build-a",
      build_publication_id: null,
      publication_ids: [],
      artifact_count: null,
      hil_count: null,
    },
    evidence_refs: ["evidence-case-a.json"],
    findings: [],
    ...overrides,
  };
}

describe("diagnoseEvidenceBoundary", () => {
  test("classifies unknown checks as an evaluator insufficiency blocker", () => {
    const report = diagnoseEvidenceBoundary({
      inventory: inventory(),
      requirements,
    });
    expect(report.strict_status).toBe("fail");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "evaluator.insufficient_evidence",
        boundary: "evaluator",
        severity: "blocker",
      }),
    ]));
    expect(report.findings.filter((finding) => finding.severity === "blocker")).toHaveLength(1);
  });

  test("preserves the earliest evidenced discovery failure as the primary blocker", () => {
    const report = diagnoseEvidenceBoundary({
      inventory: inventory({
        findings: [
          {
            code: "reproducibility.artifact_verification_missing",
            severity: "blocker",
            boundary: "reproducibility",
            requirement_ref: "artifact_hash",
            evidence_refs: ["evidence-case-a.json"],
            message: "Artifact hash is absent",
          },
          {
            code: "evidence.accept_missing",
            severity: "blocker",
            boundary: "discovery",
            requirement_ref: "accept_receipt",
            evidence_refs: ["accept-case-a.json"],
            message: "Accepted receipt is absent",
          },
        ],
        checks: {
          frozen_inputs: "fail",
          execution: "unknown",
          trusted_inputs: "unknown",
          semantic_product: "unknown",
          publication: "unknown",
          reproducibility: "fail",
        },
      }),
      requirements,
    });
    expect(report.strict_status).toBe("fail");
    expect(report.findings.find((finding) => finding.severity === "blocker")).toMatchObject({
      code: "evidence.accept_missing",
      boundary: "discovery",
    });
    expect(report.findings.filter((finding) => finding.severity === "blocker")).toHaveLength(1);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "reproducibility.artifact_verification_missing",
        severity: "warning",
      }),
    ]));
  });

  test("reports blocked status when a check is blocked", () => {
    const report = diagnoseEvidenceBoundary({
      inventory: inventory({
        checks: {
          frozen_inputs: "pass",
          execution: "pass",
          trusted_inputs: "blocked",
          semantic_product: "unknown",
          publication: "unknown",
          reproducibility: "unknown",
        },
      }),
      requirements,
    });
    expect(report.strict_status).toBe("blocked");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "evaluator.evidence_blocked",
        severity: "blocker",
      }),
    ]));
  });

  test("does not make historical inadmissibility a current-run blocker", () => {
    const report = diagnoseEvidenceBoundary({
      inventory: inventory({
        checks: {
          frozen_inputs: "pass",
          execution: "pass",
          trusted_inputs: "pass",
          semantic_product: "pass",
          publication: "pass",
          reproducibility: "pass",
        },
        findings: [{
          code: "evidence.historical_inadmissible",
          severity: "blocker",
          boundary: "reproducibility",
          requirement_ref: "same_commit_evidence",
          evidence_refs: ["historical/case-a.runs.json"],
          message: "Historical evidence is not current evidence",
        }],
      }),
      requirements,
    });
    expect(report.strict_status).toBe("pass");
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "evidence.historical_inadmissible",
        severity: "warning",
      }),
    ]);
  });
});
