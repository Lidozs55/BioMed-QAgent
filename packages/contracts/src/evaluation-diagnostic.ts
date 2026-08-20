import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertFinite,
  assertObject,
  assertString,
} from "./runtime/primitives.js";

export const EVALUATION_DIAGNOSTIC_BOUNDARIES = [
  "discovery",
  "trusted_input",
  "contract",
  "assembly",
  "validation",
  "publication",
  "reproducibility",
  "evaluator",
] as const;

export type EvaluationDiagnosticBoundary =
  (typeof EVALUATION_DIAGNOSTIC_BOUNDARIES)[number];

export const EVALUATION_FINDING_SEVERITIES = [
  "info",
  "warning",
  "blocker",
] as const;

export type EvaluationFindingSeverity =
  (typeof EVALUATION_FINDING_SEVERITIES)[number];

export const EVALUATION_CHECK_STATUSES = [
  "pass",
  "fail",
  "blocked",
  "unknown",
] as const;

export type EvaluationCheckStatus =
  (typeof EVALUATION_CHECK_STATUSES)[number];

export const EVALUATION_STRICT_STATUSES = ["pass", "fail", "blocked"] as const;

export type EvaluationStrictStatus =
  (typeof EVALUATION_STRICT_STATUSES)[number];

export interface EvaluationDiagnosticFinding {
  code: string;
  severity: EvaluationFindingSeverity;
  boundary: EvaluationDiagnosticBoundary;
  requirement_ref: string;
  evidence_refs: readonly string[];
  message: string;
}

export interface EvaluationDiagnosticChecks {
  frozen_inputs: EvaluationCheckStatus;
  execution: EvaluationCheckStatus;
  trusted_inputs: EvaluationCheckStatus;
  semantic_product: EvaluationCheckStatus;
  publication: EvaluationCheckStatus;
  reproducibility: EvaluationCheckStatus;
}

export interface EvaluationDiagnosticReport {
  schema_version: "1.0";
  case_id: string;
  product_commit: string;
  strict_status: EvaluationStrictStatus;
  findings: readonly EvaluationDiagnosticFinding[];
  checks: EvaluationDiagnosticChecks;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINDING_CODE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
const PRODUCT_COMMIT = /^[0-9a-f]{40,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function exactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new APIError(502, `Unexpected field(s) at ${path}: ${extras.join(", ")}`);
  }
}

function safeId(value: unknown, path: string): string {
  const text = assertString(value, path, true);
  if (!SAFE_ID.test(text)) {
    throw new APIError(502, `Expected safe identifier at ${path}`);
  }
  return text;
}

function boundedText(value: unknown, path: string, maxLength: number): string {
  const text = assertString(value, path, true);
  if (text.length > maxLength || CONTROL_CHARACTER.test(text)) {
    throw new APIError(502, `Expected bounded text at ${path}`);
  }
  return text;
}

function evidenceRef(value: unknown, path: string): string {
  const text = boundedText(value, path, 512);
  const normalized = text.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    text.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.includes("..")
  ) {
    throw new APIError(502, `Expected confined evidence reference at ${path}`);
  }
  return text;
}

function parseFinding(value: unknown, path: string): EvaluationDiagnosticFinding {
  const object = assertObject(value, path);
  exactKeys(
    object,
    ["code", "severity", "boundary", "requirement_ref", "evidence_refs", "message"],
    path,
  );
  const code = boundedText(Reflect.get(object, "code"), `${path}.code`, 128);
  if (!FINDING_CODE.test(code)) {
    throw new APIError(502, `Expected diagnostic code at ${path}.code`);
  }
  const refs = assertArray(
    Reflect.get(object, "evidence_refs"),
    `${path}.evidence_refs`,
    (entry, index) => evidenceRef(entry, `${path}.evidence_refs[${index}]`),
  );
  return {
    code,
    severity: assertFinite(
      Reflect.get(object, "severity"),
      `${path}.severity`,
      EVALUATION_FINDING_SEVERITIES,
    ),
    boundary: assertFinite(
      Reflect.get(object, "boundary"),
      `${path}.boundary`,
      EVALUATION_DIAGNOSTIC_BOUNDARIES,
    ),
    requirement_ref: boundedText(
      Reflect.get(object, "requirement_ref"),
      `${path}.requirement_ref`,
      256,
    ),
    evidence_refs: [...new Set(refs)].sort(),
    message: boundedText(Reflect.get(object, "message"), `${path}.message`, 1_024),
  };
}

function parseChecks(value: unknown, path: string): EvaluationDiagnosticChecks {
  const object = assertObject(value, path);
  const keys = [
    "frozen_inputs",
    "execution",
    "trusted_inputs",
    "semantic_product",
    "publication",
    "reproducibility",
  ] as const;
  exactKeys(object, keys, path);
  return {
    frozen_inputs: assertFinite(
      Reflect.get(object, "frozen_inputs"),
      `${path}.frozen_inputs`,
      EVALUATION_CHECK_STATUSES,
    ),
    execution: assertFinite(
      Reflect.get(object, "execution"),
      `${path}.execution`,
      EVALUATION_CHECK_STATUSES,
    ),
    trusted_inputs: assertFinite(
      Reflect.get(object, "trusted_inputs"),
      `${path}.trusted_inputs`,
      EVALUATION_CHECK_STATUSES,
    ),
    semantic_product: assertFinite(
      Reflect.get(object, "semantic_product"),
      `${path}.semantic_product`,
      EVALUATION_CHECK_STATUSES,
    ),
    publication: assertFinite(
      Reflect.get(object, "publication"),
      `${path}.publication`,
      EVALUATION_CHECK_STATUSES,
    ),
    reproducibility: assertFinite(
      Reflect.get(object, "reproducibility"),
      `${path}.reproducibility`,
      EVALUATION_CHECK_STATUSES,
    ),
  };
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

function validateStatusCombination(report: EvaluationDiagnosticReport): void {
  const checkStatuses = Object.values(report.checks);
  const blockerCount = report.findings.filter((finding) => finding.severity === "blocker").length;
  if (report.strict_status === "pass") {
    if (blockerCount > 0 || checkStatuses.some((status) => status !== "pass")) {
      throw new APIError(502, "A passing evaluation requires all checks to pass and no blockers");
    }
    return;
  }
  if (blockerCount === 0) {
    throw new APIError(502, "A failed or blocked evaluation requires at least one blocker");
  }
  const hasBlockedCheck = checkStatuses.includes("blocked");
  if (report.strict_status === "blocked" && !hasBlockedCheck) {
    throw new APIError(502, "A blocked evaluation requires at least one blocked check");
  }
  if (report.strict_status === "fail" && hasBlockedCheck) {
    throw new APIError(502, "A failed evaluation cannot contain blocked checks");
  }
}

export function parseEvaluationDiagnosticReport(
  value: unknown,
): EvaluationDiagnosticReport {
  const object = assertObject(value, "evaluation report");
  exactKeys(
    object,
    ["schema_version", "case_id", "product_commit", "strict_status", "findings", "checks"],
    "evaluation report",
  );
  if (Reflect.get(object, "schema_version") !== "1.0") {
    throw new APIError(502, 'Expected "1.0" at evaluation report.schema_version');
  }
  const productCommit = assertString(
    Reflect.get(object, "product_commit"),
    "evaluation report.product_commit",
    true,
  );
  if (!PRODUCT_COMMIT.test(productCommit)) {
    throw new APIError(502, "Expected lowercase 40-64 character commit hash at evaluation report.product_commit");
  }
  const report: EvaluationDiagnosticReport = {
    schema_version: "1.0",
    case_id: safeId(Reflect.get(object, "case_id"), "evaluation report.case_id"),
    product_commit: productCommit,
    strict_status: assertFinite(
      Reflect.get(object, "strict_status"),
      "evaluation report.strict_status",
      EVALUATION_STRICT_STATUSES,
    ),
    findings: assertArray(
      Reflect.get(object, "findings"),
      "evaluation report.findings",
      (entry, index) => parseFinding(entry, `evaluation report.findings[${index}]`),
    ).sort(compareFindings),
    checks: parseChecks(Reflect.get(object, "checks"), "evaluation report.checks"),
  };
  validateStatusCombination(report);
  return report;
}
