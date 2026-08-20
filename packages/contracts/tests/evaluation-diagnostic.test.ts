import { describe, expect, test } from "vitest";

import {
  parseEvaluationDiagnosticReport,
  type EvaluationDiagnosticReport,
} from "../src/index.js";

const commit = "a".repeat(40);

function checks(status: "pass" | "fail" | "blocked" | "unknown" = "pass") {
  return {
    frozen_inputs: status,
    execution: status,
    trusted_inputs: status,
    semantic_product: status,
    publication: status,
    reproducibility: status,
  };
}

function finding(overrides: Partial<EvaluationDiagnosticReport["findings"][number]> = {}) {
  return {
    code: "publication.required_table_missing",
    severity: "blocker" as const,
    boundary: "publication" as const,
    requirement_ref: "table.primary",
    evidence_refs: ["evidence/publication.json"],
    message: "Required table is missing",
    ...overrides,
  };
}

describe("evaluation diagnostic report contracts", () => {
  test("parses a passing report and preserves the versioned shape", () => {
    const report = parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-a",
      product_commit: commit,
      strict_status: "pass",
      findings: [],
      checks: checks(),
    });
    expect(report).toEqual({
      schema_version: "1.0",
      case_id: "case-a",
      product_commit: commit,
      strict_status: "pass",
      findings: [],
      checks: checks(),
    });
  });

  test("accepts a failed report with a blocker and rejects blocked checks in fail status", () => {
    const report = parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-b",
      product_commit: commit,
      strict_status: "fail",
      findings: [finding()],
      checks: { ...checks(), publication: "fail" },
    });
    expect(report.strict_status).toBe("fail");
    expect(() => parseEvaluationDiagnosticReport({
      ...report,
      checks: { ...report.checks, publication: "blocked" },
    })).toThrow(/cannot contain blocked checks/);
  });

  test("requires a blocker and blocked evidence for blocked status", () => {
    expect(parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-c",
      product_commit: commit,
      strict_status: "blocked",
      findings: [finding({ boundary: "trusted_input", code: "input.credential_pending" })],
      checks: { ...checks("unknown"), trusted_inputs: "blocked" },
    }).strict_status).toBe("blocked");

    expect(() => parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-c",
      product_commit: commit,
      strict_status: "blocked",
      findings: [],
      checks: { ...checks("unknown"), trusted_inputs: "blocked" },
    })).toThrow(/requires at least one blocker/);
  });

  test("sorts findings deterministically and removes duplicate evidence references", () => {
    const first = finding({
      code: "publication.hash_mismatch",
      evidence_refs: ["z.json", "a.json", "a.json"],
      requirement_ref: "artifact.hash",
    });
    const second = finding({
      boundary: "discovery",
      code: "source.not_found",
      requirement_ref: "source.primary",
    });
    const report = parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-d",
      product_commit: commit,
      strict_status: "fail",
      findings: [first, second],
      checks: { ...checks(), publication: "fail" },
    });
    expect(report.findings.map((item) => item.code)).toEqual([
      "source.not_found",
      "publication.hash_mismatch",
    ]);
    expect(report.findings[1]?.evidence_refs).toEqual(["a.json", "z.json"]);
  });

  test.each([
    { extra: true },
    { schema_version: "2.0" },
    { case_id: "../escape" },
    { product_commit: "G".repeat(40) },
  ])("rejects malformed top-level reports: %o", (override) => {
    expect(() => parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-e",
      product_commit: commit,
      strict_status: "pass",
      findings: [],
      checks: checks(),
      ...override,
    })).toThrow();
  });

  test.each(["/absolute.json", "../escape.json", "C:\\secret.json"])(
    "rejects unsafe evidence references: %s",
    (reference) => {
      expect(() => parseEvaluationDiagnosticReport({
        schema_version: "1.0",
        case_id: "case-f",
        product_commit: commit,
        strict_status: "fail",
        findings: [finding({ evidence_refs: [reference] })],
        checks: { ...checks(), publication: "fail" },
      })).toThrow(/confined evidence reference/);
    },
  );

  test("rejects a passing report with unknown checks or blockers", () => {
    expect(() => parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-g",
      product_commit: commit,
      strict_status: "pass",
      findings: [finding()],
      checks: checks(),
    })).toThrow(/all checks to pass and no blockers/);

    expect(() => parseEvaluationDiagnosticReport({
      schema_version: "1.0",
      case_id: "case-h",
      product_commit: commit,
      strict_status: "fail",
      findings: [],
      checks: { ...checks(), publication: "fail" },
    })).toThrow(/requires at least one blocker/);
  });
});
