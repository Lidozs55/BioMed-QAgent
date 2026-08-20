import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  EVALUATION_DIAGNOSTIC_BOUNDARIES,
  type EvaluationDiagnosticBoundary,
  type EvaluationDiagnosticReport,
  type EvaluationStrictStatus,
} from "@biomed/contracts";

import { diagnoseEvidenceBoundary } from "./diagnosis-engine.js";
import { loadGoldEvidenceInventory } from "./gold-evidence/inventory.js";
import { parseReferenceRequirements } from "./reference-requirements.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

interface GoldManifestCase {
  case_id: string;
  spec: string;
}

interface GoldCaseSpec {
  case_id: string;
  schema_ref: string;
}

export interface GoldDiagnosticGap {
  case_id: string;
  checks: readonly string[];
}

export interface GoldDiagnosticAggregate {
  total: number;
  strict_status: Readonly<Record<EvaluationStrictStatus, number>>;
  boundaries: Readonly<Record<EvaluationDiagnosticBoundary, number>>;
  finding_codes: Readonly<Record<string, number>>;
}

export interface GoldDiagnosticMatrix {
  schema_version: "1.0";
  target_product_commit: string;
  cases: readonly EvaluationDiagnosticReport[];
  aggregate: GoldDiagnosticAggregate;
  evidence_gaps: readonly GoldDiagnosticGap[];
}

export interface GoldDiagnosticMatrixInput {
  evidence_root: string;
  gold_root: string;
  target_product_commit: string;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${path} has unknown fields: ${extras.join(", ")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }
  return value;
}

async function confinedFile(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new TypeError("path escapes Gold root");
  }
  const candidate = resolve(root, relativePath);
  const resolved = await realpath(candidate);
  const suffix = relative(root, resolved);
  if (suffix === "" || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new TypeError("path escapes Gold root");
  }
  return resolved;
}

async function readJsonObject(root: string, relativePath: string, path: string): Promise<Record<string, unknown>> {
  const filePath = await confinedFile(root, relativePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_JSON_BYTES) {
    throw new TypeError(`${path} must be a bounded JSON file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new TypeError(`${path} must contain valid JSON`);
  }
  return object(parsed, path);
}

function parseManifest(value: Record<string, unknown>): GoldManifestCase[] {
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 128) {
    throw new TypeError("Gold manifest cases must be a bounded non-empty array");
  }
  const cases = value.cases.map((entry, index) => {
    const item = object(entry, `Gold manifest cases[${index}]`);
    exactKeys(item, ["case_id", "spec"], `Gold manifest cases[${index}]`);
    const caseId = text(item.case_id, `Gold manifest cases[${index}].case_id`);
    if (!SAFE_CASE_ID.test(caseId)) throw new TypeError("Gold manifest case_id must be safe");
    return { case_id: caseId, spec: text(item.spec, `Gold manifest cases[${index}].spec`) };
  });
  if (new Set(cases.map((entry) => entry.case_id)).size !== cases.length) {
    throw new TypeError("Gold manifest case_id values must be unique");
  }
  return cases.sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function parseCaseSpec(value: Record<string, unknown>, expectedCaseId: string): GoldCaseSpec {
  const caseId = text(value.case_id, "Gold case spec.case_id");
  if (caseId !== expectedCaseId) throw new TypeError("Gold case spec case_id does not match manifest");
  return {
    case_id: caseId,
    schema_ref: text(value.schema_ref, "Gold case spec.schema_ref"),
  };
}

function sortedCounts<T extends string>(values: readonly T[], keys?: readonly T[]): Readonly<Record<T, number>> {
  const result = Object.fromEntries((keys ?? [...new Set(values)].sort()).map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function aggregate(reports: readonly EvaluationDiagnosticReport[]): GoldDiagnosticAggregate {
  const findings = reports.flatMap((report) => report.findings);
  return {
    total: reports.length,
    strict_status: sortedCounts(
      reports.map((report) => report.strict_status),
      ["pass", "fail", "blocked"],
    ),
    boundaries: sortedCounts(
      findings.map((finding) => finding.boundary),
      EVALUATION_DIAGNOSTIC_BOUNDARIES,
    ),
    finding_codes: sortedCounts(findings.map((finding) => finding.code)),
  };
}

function evidenceGaps(reports: readonly EvaluationDiagnosticReport[]): GoldDiagnosticGap[] {
  return reports.flatMap((report) => {
    const checks = Object.entries(report.checks)
      .filter(([, status]) => status === "unknown" || status === "blocked")
      .map(([name]) => name)
      .sort();
    return checks.length === 0 ? [] : [{ case_id: report.case_id, checks }];
  });
}

export async function buildGoldDiagnosticMatrix(
  input: GoldDiagnosticMatrixInput,
): Promise<GoldDiagnosticMatrix> {
  if (!COMMIT.test(input.target_product_commit)) {
    throw new TypeError("target_product_commit must be a lowercase commit hash");
  }
  const evidenceRoot = await realpath(input.evidence_root);
  const goldRoot = await realpath(input.gold_root);
  const manifest = await readJsonObject(goldRoot, "manifest.json", "Gold manifest");
  const cases = parseManifest(manifest);
  const reports: EvaluationDiagnosticReport[] = [];
  for (const entry of cases) {
    const spec = parseCaseSpec(
      await readJsonObject(goldRoot, entry.spec, `Gold case spec ${entry.case_id}`),
      entry.case_id,
    );
    const requirements = parseReferenceRequirements(
      await readJsonObject(goldRoot, spec.schema_ref, `Gold reference ${entry.case_id}`),
    );
    const inventory = await loadGoldEvidenceInventory({
      evidence_root: evidenceRoot,
      gold_root: goldRoot,
      case_id: entry.case_id,
      target_product_commit: input.target_product_commit,
    });
    reports.push(diagnoseEvidenceBoundary({ inventory, requirements }));
  }
  reports.sort((left, right) => left.case_id.localeCompare(right.case_id));
  return {
    schema_version: "1.0",
    target_product_commit: input.target_product_commit,
    cases: reports,
    aggregate: aggregate(reports),
    evidence_gaps: evidenceGaps(reports),
  };
}

export function serializeGoldDiagnosticMatrix(matrix: GoldDiagnosticMatrix): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function goldDiagnosticExitCode(matrix: GoldDiagnosticMatrix): 0 | 2 | 3 {
  if (matrix.aggregate.strict_status.fail > 0) return 2;
  if (matrix.aggregate.strict_status.blocked > 0) return 3;
  return 0;
}

export async function writeGoldDiagnosticMatrixAtomic(outputPath: string, content: string): Promise<void> {
  const resolved = resolve(outputPath);
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, resolved);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
