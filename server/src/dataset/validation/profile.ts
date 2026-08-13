/**
 * Versioned validation profiles (Python ``app/datasets/build/profiles.py`` —
 * validation registry). ``gene_expression.release.v1`` implements the
 * expression demo checks: primary present, UTF-8, schema-conformant columns,
 * complete required fields, numeric values, single unit, closed provenance,
 * and (gene-required builds) complete probe→gene coverage.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { DatasetManifest, DatasetSchema, ValidationResult, ValidationProfile } from "../contracts/index.js";
import type { JsonValue } from "@biomed/contracts";
import { parseValidationProfile } from "../contracts/index.js";

import { delimitedRowsWithLines, readSourceText } from "../adapters/text.js";
import {
  aggregateConfidenceMetrics,
  anomaliesOf,
  defaultConfidenceThresholds,
  writeConfidenceReport,
} from "./confidence.js";

export const CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL =
  "probe_coverage_required_gene_level";

/** Phase 4 subset of the D3 ProbeMappingSummary consumed by the coverage gate. */
export interface ProbeMappingSummary {
  binding_id: string;
  platform_id: string | null;
  source_namespace: string;
  target_namespace: string | null;
  mapping_status: string;
  total_probe_count: number;
  mapped_probe_count: number;
  unmapped_probe_count: number;
  ambiguous_probe_count: number;
  coverage_ratio: number;
  mapping_asset_id: string | null;
  mapping_rule_id: string | null;
}

/** One named check of a validation profile run (Python ``ProfileCheck``). */
export interface ProfileCheck {
  check_id: string;
  description: string;
  passed: boolean;
  detail: string;
}

function valueField(schema: DatasetSchema): string {
  for (const field of schema.fields) {
    if (field.unit_policy === "declared_per_record") return field.name;
  }
  return "expression_value";
}

function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function pyReprList(values: readonly string[]): string {
  return `[${values.map((value) => pyRepr(value)).join(", ")}]`;
}

type FloatParse = { ok: true; value: number } | { ok: false };

function pythonFloat(value: string): FloatParse {
  const text = value.trim();
  if (text === "") return { ok: false };
  const lower = text.toLowerCase();
  if (lower === "nan") return { ok: true, value: Number.NaN };
  if (lower === "inf" || lower === "+inf" || lower === "infinity" || lower === "+infinity") {
    return { ok: true, value: Number.POSITIVE_INFINITY };
  }
  if (lower === "-inf" || lower === "-infinity") {
    return { ok: true, value: Number.NEGATIVE_INFINITY };
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    return { ok: true, value: Number(text) };
  }
  return { ok: false };
}

function isFiniteNumber(value: string): boolean {
  const parsed = pythonFloat(value);
  return parsed.ok && Number.isFinite(parsed.value);
}

class Utf8DecodeError extends Error {}

/** Strict UTF-8 decode with Python ``UnicodeDecodeError``-style messages. */
function decodeUtf8Strict(buffer: Buffer): string {
  let result = "";
  let index = 0;
  while (index < buffer.length) {
    const byte = buffer[index];
    let length: number;
    let codePoint: number;
    if (byte < 0x80) {
      length = 1;
      codePoint = byte;
    } else if ((byte & 0xe0) === 0xc0) {
      length = 2;
      codePoint = byte & 0x1f;
      if (byte < 0xc2) {
        throw new Utf8DecodeError(utf8Error("invalid start byte", byte, index));
      }
    } else if ((byte & 0xf0) === 0xe0) {
      length = 3;
      codePoint = byte & 0x0f;
    } else if ((byte & 0xf8) === 0xf0) {
      length = 4;
      codePoint = byte & 0x07;
    } else {
      throw new Utf8DecodeError(utf8Error("invalid start byte", byte, index));
    }
    if (index + length > buffer.length) {
      throw new Utf8DecodeError(
        `'utf-8' codec can't decode bytes in position ${index}-${buffer.length - 1}: unexpected end of data`,
      );
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = buffer[index + offset];
      if ((continuation & 0xc0) !== 0x80) {
        throw new Utf8DecodeError(
          utf8Error("invalid continuation byte", continuation, index + offset),
        );
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      (length === 2 && codePoint < 0x80) ||
      (length === 3 && codePoint < 0x800) ||
      (length === 4 && codePoint < 0x10000)
    ) {
      throw new Utf8DecodeError(utf8Error("invalid start byte", byte, index));
    }
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Utf8DecodeError(utf8Error("invalid start byte", byte, index));
    }
    result += String.fromCodePoint(codePoint);
    index += length;
  }
  return result;
}

function utf8Error(reason: string, byte: number, position: number): string {
  const hex = byte.toString(16).padStart(2, "0");
  return `'utf-8' codec can't decode byte 0x${hex} in position ${position}: ${reason}`;
}

/** Python csv.reader row list for one file (header preserved as first row). */
function readCsvRows(path: string): string[][] {
  return delimitedRowsWithLines(readSourceText(path), ",").map((row) => row.values);
}

export class ExpressionValidationProfile {
  readonly profile_id: string = "gene_expression.release.v1";
  readonly required_entity_level: string = "gene";
  profile: ValidationProfile;
  readonly confidenceThresholds = defaultConfidenceThresholds();

  constructor() {
    this.profile = parseValidationProfile({
      profile_id: this.profile_id,
      dataset_family: "gene_expression",
      acceptance: {
        minimum_valid_rows: 1,
        allow_empty_primary_dataset: false,
        allow_partial_publish: true,
      },
      description:
        "Expression release gate: primary dataset present with valid rows, " +
        "schema-conformant columns, complete required fields, numeric values, " +
        "a single unit, and closed provenance.",
      required_entity_level: this.required_entity_level,
    });
  }

  validate(options: {
    manifest: DatasetManifest;
    primaryPath: string;
    schema: DatasetSchema;
    manifestDigest: string;
    outputDir: string;
    probeMappingSummaries?: ProbeMappingSummary[] | null;
  }): ValidationResult {
    const checks = this.runChecks(
      options.manifest,
      options.primaryPath,
      options.schema,
      options.probeMappingSummaries ?? null,
    );
    const encodingFailed = checks.some(
      (check) => check.check_id === "csv_encoding_utf8" && !check.passed,
    );
    let confidenceWarnings: Array<Record<string, string>> = [];
    if (existsSync(options.primaryPath) && !encodingFailed) {
      const confidence = this.runConfidenceCheck(
        options.primaryPath,
        options.outputDir,
        options.schema,
      );
      checks.push(confidence.check);
      confidenceWarnings = confidence.warnings;
    }
    const warnings = [
      ...confidenceWarnings,
      ...this.probeCoverageWarnings(options.probeMappingSummaries ?? null),
    ];
    const report: Record<string, JsonValue> = {
      profile_ref: this.profile_id,
      manifest_digest: options.manifestDigest,
      checks: checks.map((check) => ({
        check_id: check.check_id,
        description: check.description,
        passed: check.passed,
        detail: check.detail,
      })),
      warnings: warnings.map((warning) => warning),
    };
    const reportPath = joinOutput(options.outputDir, "validation_report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const failed = checks.filter((check) => !check.passed);
    return {
      schema_version: "1.0",
      manifest_digest: options.manifestDigest,
      profile_ref: this.profile_id,
      status: failed.length === 0 ? "passed" : "failed",
      checked_count: checks.length,
      failed_count: failed.length,
      report_path: "validation_report.json",
    };
  }

  private runChecks(
    _manifest: DatasetManifest,
    primaryPath: string,
    schema: DatasetSchema,
    probeMappingSummaries: ProbeMappingSummary[] | null,
  ): ProfileCheck[] {
    if (!existsSync(primaryPath)) {
      return [
        {
          check_id: "primary_dataset_exists",
          description: "primary dataset artifact exists",
          passed: false,
          detail: `missing primary dataset file: ${primaryPath}`,
        },
      ];
    }
    const encodingCheck = this.checkCsvEncoding(primaryPath);
    if (!encodingCheck.passed) {
      return [encodingCheck];
    }
    const checks: ProfileCheck[] = [
      this.checkMinRows(_manifest, primaryPath),
      this.checkColumnCount(primaryPath, schema),
      encodingCheck,
    ];
    checks.push(...this.checkRows(primaryPath, schema));
    if (this.required_entity_level === "gene") {
      checks.push(
        this.checkProbeCoverageRequiredGeneLevel(primaryPath, probeMappingSummaries),
      );
    }
    return checks;
  }

  private checkCsvEncoding(primaryPath: string): ProfileCheck {
    try {
      decodeUtf8Strict(readFileSync(primaryPath));
      return {
        check_id: "csv_encoding_utf8",
        description: "primary dataset is UTF-8 encoded",
        passed: true,
        detail: "primary dataset decodes as UTF-8",
      };
    } catch (error) {
      return {
        check_id: "csv_encoding_utf8",
        description: "primary dataset is UTF-8 encoded",
        passed: false,
        detail:
          error instanceof Utf8DecodeError
            ? `primary dataset is not valid UTF-8: ${error.message}`
            : `primary dataset is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private checkMinRows(_manifest: DatasetManifest, primaryPath: string): ProfileCheck {
    const minimum = this.profile.acceptance.minimum_valid_rows;
    const rows = readCsvRows(primaryPath);
    const fileRows = rows.length === 0 ? 0 : rows.length - 1;
    return {
      check_id: "minimum_valid_rows",
      description: `primary dataset has at least ${minimum} row(s)`,
      passed: fileRows >= minimum,
      detail: `file_row_count=${fileRows}, minimum=${minimum}`,
    };
  }

  private checkColumnCount(primaryPath: string, schema: DatasetSchema): ProfileCheck {
    const rows = readCsvRows(primaryPath);
    const header = rows.length > 0 ? rows[0] : [];
    const expected = schema.fields.length;
    return {
      check_id: "column_count_matches_schema",
      description: "primary dataset column count matches the schema",
      passed: header.length === expected,
      detail: `actual=${header.length}, schema=${expected}`,
    };
  }

  private checkRows(primaryPath: string, schema: DatasetSchema): ProfileCheck[] {
    const required = new Set(
      schema.fields.filter((field) => field.required).map((field) => field.name),
    );
    const valueColumn = valueField(schema);
    const rows = readCsvRows(primaryPath);
    const header = rows.length > 0 ? rows[0] : [];
    const expected = header.length > 0 ? header.length : schema.fields.length;
    let rowCount = 0;
    let malformedWidth = 0;
    const blankRequired: Record<string, number> = {};
    let nonNumeric = 0;
    const units = new Set<string>();
    let missingProvenance = 0;
    for (const row of rows.slice(1)) {
      if (row.length === 0) continue; // blank lines are not data rows
      rowCount += 1;
      if (row.length !== expected) {
        malformedWidth += 1;
        continue;
      }
      const values: Record<string, string> = {};
      for (let index = 0; index < header.length; index += 1) {
        values[header[index]] = row[index];
      }
      for (const field of required) {
        if (!(values[field] ?? "").trim()) {
          blankRequired[field] = (blankRequired[field] ?? 0) + 1;
        }
      }
      if (!isFiniteNumber(values[valueColumn] ?? "")) {
        nonNumeric += 1;
      }
      const unit = values["expression_unit"] ?? "";
      if (unit) units.add(unit);
      if (
        !(values["source_logical_file"] ?? "").trim() ||
        !(values["asset_id"] ?? "").trim()
      ) {
        missingProvenance += 1;
      }
    }
    return [
      {
        check_id: "row_width_matches_schema",
        description: "every row has exactly the schema column count",
        passed: malformedWidth === 0,
        detail: `${malformedWidth} row(s) with a field count != ${expected} in ${rowCount} row(s)`,
      },
      {
        check_id: "required_field_completeness",
        description: "required schema fields are non-blank for every row",
        passed: Object.keys(blankRequired).length === 0,
        detail:
          `${rowCount} row(s); blank required fields: ` +
          (Object.keys(blankRequired).length > 0
            ? sortedJson(blankRequired)
            : "none"),
      },
      {
        check_id: "expression_value_numeric",
        description: `${valueColumn} parses as a number for every row`,
        passed: nonNumeric === 0,
        detail: `${nonNumeric} non-numeric value(s) in ${rowCount} row(s)`,
      },
      {
        check_id: "unit_consistency",
        description: "a single expression unit in the primary dataset",
        passed: units.size <= 1,
        detail: `units=${pyReprList([...units].sort())}`,
      },
      {
        check_id: "provenance_closure",
        description: "every row carries source file and asset provenance",
        passed: missingProvenance === 0,
        detail: `${missingProvenance} row(s) missing provenance in ${rowCount} row(s)`,
      },
    ];
  }

  private checkProbeCoverageRequiredGeneLevel(
    primaryPath: string,
    summaries: ProbeMappingSummary[] | null,
  ): ProfileCheck {
    const residual = countResidualGeoProbeRows(primaryPath);
    const belowOne: string[] = [];
    if (summaries !== null) {
      for (const summary of summaries) {
        if (
          summary.total_probe_count > 0 &&
          Math.abs(summary.coverage_ratio - 1.0) > 1e-9
        ) {
          belowOne.push(summary.binding_id);
        }
      }
    }
    const passed = residual === 0 && belowOne.length === 0;
    let detail = `residual_geo_probe_rows=${residual}`;
    if (summaries !== null) {
      detail += `; coverage_below_1.0=${belowOne.length > 0 ? pyReprList(belowOne) : "none"}`;
    }
    return {
      check_id: CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL,
      description:
        "gene-required build: probe→gene coverage must be 1.0 with " +
        "no residual geo_probe/ambiguous rows in the primary dataset",
      passed,
      detail,
    };
  }

  private probeCoverageWarnings(
    summaries: ProbeMappingSummary[] | null,
  ): Array<Record<string, string>> {
    if (this.required_entity_level !== "probe" || summaries === null) return [];
    const warnings: Array<Record<string, string>> = [];
    for (const summary of summaries) {
      warnings.push({
        check_id: "probe_coverage",
        binding_id: summary.binding_id,
        platform_id: summary.platform_id ?? "",
        mapping_status: summary.mapping_status,
        coverage_ratio: summary.coverage_ratio.toFixed(4),
        detail:
          `probe-level build: probe→gene coverage ` +
          `${summary.coverage_ratio.toFixed(4)} (mapped ` +
          `${summary.mapped_probe_count}/` +
          `${summary.total_probe_count}) is publishable at probe ` +
          "level (warning-only; entity policy requires probe)",
      });
    }
    return warnings;
  }

  private runConfidenceCheck(
    primaryPath: string,
    outputDir: string,
    schema: DatasetSchema,
  ): { check: ProfileCheck; warnings: Array<Record<string, string>> } {
    const valueColumn = valueField(schema);
    const values: string[] = [];
    const rows = readCsvRows(primaryPath);
    const header = rows.length > 0 ? rows[0] : [];
    const valueIndex = header.indexOf(valueColumn);
    for (const row of rows.slice(1)) {
      values.push(valueIndex >= 0 ? (row[valueIndex] ?? "") : "");
    }
    const summary = aggregateConfidenceMetrics(
      { [valueColumn]: values },
      this.confidenceThresholds,
    );
    const reportPath = joinOutput(outputDir, "confidence_report.csv");
    writeConfidenceReport(summary, reportPath);
    const warnings = anomaliesOf(summary).map((finding) => ({
      check_id: "data_confidence",
      detector: finding.detector,
      column: finding.column,
      statistic: finding.statistic === null ? "" : finding.statistic.toFixed(4),
      detail: finding.detail,
    }));
    const anomalies = anomaliesOf(summary);
    return {
      check: {
        check_id: "data_confidence",
        description:
          "deterministic statistical detectors (Benford / last digit / " +
          "constant / progression) on the primary numeric column",
        passed: true, // v1: warning-only, never blocks release
        detail:
          anomalies.length > 0
            ? `${summary.anomaly_count} anomaly(ies) in ${anomalies[0].column}`
            : "no statistical anomalies detected",
      },
      warnings,
    };
  }
}

/** Probe-level release gate: same checks; entity level is ``probe``. */
export class ProbeExpressionValidationProfile extends ExpressionValidationProfile {
  readonly profile_id = "gene_expression.probe_release.v1";
  readonly required_entity_level = "probe";

  constructor() {
    super();
    this.profile = parseValidationProfile({
      profile_id: this.profile_id,
      dataset_family: "gene_expression",
      acceptance: {
        minimum_valid_rows: 1,
        allow_empty_primary_dataset: false,
        allow_partial_publish: true,
      },
      description:
        "Expression release gate: primary dataset present with valid rows, " +
        "schema-conformant columns, complete required fields, numeric values, " +
        "a single unit, and closed provenance.",
      required_entity_level: this.required_entity_level,
    });
  }
}

const VALIDATION_PROFILES: Readonly<Record<string, ExpressionValidationProfile>> = {
  "gene_expression.release.v1": new ExpressionValidationProfile(),
  "gene_expression.probe_release.v1": new ProbeExpressionValidationProfile(),
};

/** Registered validation profile refs (server allowlist). */
export const VALIDATION_PROFILE_REFS: readonly string[] = Object.keys(VALIDATION_PROFILES);

/** Resolve a validation profile by ref (throws on unregistered refs). */
export function getValidationProfile(profileRef: string): ExpressionValidationProfile {
  const profile = VALIDATION_PROFILES[profileRef];
  if (profile === undefined) {
    throw new Error(`validation profile '${profileRef}' is not registered`);
  }
  return profile;
}

function joinOutput(outputDir: string, name: string): string {
  return `${outputDir.replace(/[\\/]+$/, "")}/${name}`;
}

/** Python ``json.dumps(record, sort_keys=True)`` for string->int maps. */
function sortedJson(record: Record<string, number>): string {
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${record[key]}`);
  return `{${parts.join(",")}}`;
}

/** Count primary rows whose ``gene_id_namespace`` is still ``geo_probe``. */
function countResidualGeoProbeRows(primaryPath: string): number {
  const rows = readCsvRows(primaryPath);
  if (rows.length === 0) return 0;
  const header = rows[0];
  const namespaceIndex = header.indexOf("gene_id_namespace");
  if (namespaceIndex < 0) return 0;
  let residual = 0;
  for (const row of rows.slice(1)) {
    if ((row[namespaceIndex] ?? "").trim() === "geo_probe") residual += 1;
  }
  return residual;
}

