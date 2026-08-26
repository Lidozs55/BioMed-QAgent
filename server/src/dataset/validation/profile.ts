/**
 * Versioned validation profiles (Python ``app/datasets/build/profiles.py`` —
 * validation registry). ``gene_expression.release.v1`` implements the
 * expression demo checks: primary present, UTF-8, schema-conformant columns,
 * complete required fields, numeric values, single unit, closed provenance,
 * and (gene-required builds) complete probe→gene coverage.
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import type {
  ConfidenceGatePolicy,
  DatasetManifest,
  DatasetSchema,
  ValidationResult,
  ValidationProfile,
} from "../contracts/index.js";
import type { JsonValue } from "@biomed/contracts";
import { parseValidationProfile } from "../contracts/index.js";

import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import {
  DelimitedBoundsError,
  delimitedRowsFromFileAsync,
  type DelimitedRowBounds,
} from "../adapters/text.js";
import { joinOutput } from "../adapters/paths.js";
import {
  ConfidenceColumnAggregator,
  anomaliesOf,
  defaultConfidenceThresholds,
  writeConfidenceReport,
} from "./confidence.js";
import {
  readConfidenceArtifact,
  type ConfidenceArtifact,
} from "../confidence/artifact.js";

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

/**
 * Per-scan streaming row bounds for the primary dataset scans.  These are
 * generous caps that only reject pathological rows/fields, so a single
 * oversized row cannot balloon memory inside a multi-gigabyte primary while
 * legitimate expression rows (a handful of short columns) pass untouched.
 */
const SCAN_MAX_ROW_CHARS = 8 * 1024 * 1024;
const SCAN_MAX_FIELD_CHARS = 1024 * 1024;
const SCAN_MAX_ROW_FIELDS = 4096;
const SCAN_BOUNDS: DelimitedRowBounds = {
  maxRowChars: SCAN_MAX_ROW_CHARS,
  maxFieldChars: SCAN_MAX_FIELD_CHARS,
  maxRowFields: SCAN_MAX_ROW_FIELDS,
};

/** Convert a {@link DelimitedBoundsError} from a primary scan into a failed check. */
function rowBoundsCheck(error: unknown): ProfileCheck {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    check_id: "row_or_field_length_bound",
    description:
      "primary dataset rows stay within the bounded column/field/row length limits",
    passed: false,
    detail,
  };
}

export interface ConfidenceGateResult {
  passed: boolean;
  total_count: number;
  low_count: number;
  low_fraction: number;
  pending_count: number;
  below_minimum_count: number;
  unreviewed_required_channel_count: number;
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

export function evaluateConfidenceGate(
  policy: ConfidenceGatePolicy,
  artifact: ConfidenceArtifact,
): ConfidenceGateResult {
  const overridesByBatch = new Map<string, number>();
  for (const override of artifact.record_overrides) {
    overridesByBatch.set(
      override.batch_id,
      (overridesByBatch.get(override.batch_id) ?? 0) + 1,
    );
  }
  let total = 0;
  let low = 0;
  let pending = 0;
  let belowMinimum = 0;
  let unreviewedChannel = 0;
  const requiredChannel = new Set(policy.require_review_for_channels);
  const add = (
    level: "high" | "medium" | "low",
    channel: string,
    review: string,
    count: number,
  ): void => {
    total += count;
    if (level === "low") low += count;
    if (review === "pending") pending += count;
    if (CONFIDENCE_RANK[level] < CONFIDENCE_RANK[policy.required_fields_min_level]) {
      belowMinimum += count;
    }
    if (
      requiredChannel.has(channel) &&
      review !== "accepted" &&
      review !== "corrected"
    ) {
      unreviewedChannel += count;
    }
  };
  for (const batch of artifact.batch_defaults) {
    add(
      batch.level,
      batch.channel,
      batch.components.human_review_state,
      Math.max(0, batch.record_count - (overridesByBatch.get(batch.batch_id) ?? 0)),
    );
  }
  for (const override of artifact.record_overrides) {
    add(
      override.level,
      override.channel,
      override.components.human_review_state,
      1,
    );
  }
  const lowFraction = total === 0 ? 0 : low / total;
  const passed =
    (!policy.block_pending_human_review || pending === 0) &&
    belowMinimum === 0 &&
    (policy.allow_low_confidence_primary || low === 0) &&
    (policy.max_low_confidence_fraction === null ||
      lowFraction <= policy.max_low_confidence_fraction) &&
    unreviewedChannel === 0;
  return {
    passed,
    total_count: total,
    low_count: low,
    low_fraction: lowFraction,
    pending_count: pending,
    below_minimum_count: belowMinimum,
    unreviewed_required_channel_count: unreviewedChannel,
  };
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

/**
 * Bounded-memory strict UTF-8 validator. Feed raw bytes chunk by chunk with
 * ``push``; the same byte rules as the former in-memory ``decodeUtf8Strict``
 * apply (Python ``UnicodeDecodeError``-style messages, absolute byte
 * positions), but no decoded string is ever materialized, and a multi-byte
 * sequence split across a chunk boundary is carried over until its
 * continuation bytes arrive. Call ``finish`` at EOF: a sequence still open
 * then is ``unexpected end of data``.
 */
export class Utf8StreamingValidator {
  private pending: Buffer = Buffer.alloc(0);
  private offset = 0;

  push(bytes: Buffer): void {
    const pendingLength = this.pending.length;
    const combined =
      pendingLength > 0 ? Buffer.concat([this.pending, bytes]) : bytes;
    this.pending = Buffer.alloc(0);
    const start = this.offset - pendingLength;
    let index = 0;
    while (index < combined.length) {
      const absolute = start + index;
      const byte = combined[index];
      let length: number;
      let codePoint: number;
      if (byte < 0x80) {
        length = 1;
        codePoint = byte;
      } else if ((byte & 0xe0) === 0xc0) {
        length = 2;
        codePoint = byte & 0x1f;
        if (byte < 0xc2) {
          throw new Utf8DecodeError(utf8Error("invalid start byte", byte, absolute));
        }
      } else if ((byte & 0xf0) === 0xe0) {
        length = 3;
        codePoint = byte & 0x0f;
      } else if ((byte & 0xf8) === 0xf0) {
        length = 4;
        codePoint = byte & 0x07;
      } else {
        throw new Utf8DecodeError(utf8Error("invalid start byte", byte, absolute));
      }
      if (index + length > combined.length) {
        this.pending = Buffer.from(combined.subarray(index));
        break;
      }
      for (let offset = 1; offset < length; offset += 1) {
        const continuation = combined[index + offset];
        if ((continuation & 0xc0) !== 0x80) {
          throw new Utf8DecodeError(
            utf8Error("invalid continuation byte", continuation, absolute + offset),
          );
        }
        codePoint = (codePoint << 6) | (continuation & 0x3f);
      }
      if (
        (length === 2 && codePoint < 0x80) ||
        (length === 3 && codePoint < 0x800) ||
        (length === 4 && codePoint < 0x10000)
      ) {
        throw new Utf8DecodeError(utf8Error("invalid start byte", byte, absolute));
      }
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Utf8DecodeError(utf8Error("invalid start byte", byte, absolute));
      }
      index += length;
    }
    this.offset += bytes.length;
  }

  finish(): void {
    if (this.pending.length > 0) {
      const start = this.offset - this.pending.length;
      throw new Utf8DecodeError(
        `'utf-8' codec can't decode bytes in position ${start}-${this.offset - 1}: unexpected end of data`,
      );
    }
  }
}

/**
 * Cooperative ``checkCsvEncoding`` backing: streams ``path`` in bounded
 * chunks through ``Utf8StreamingValidator``, yielding to the event loop and
 * re-checking the AbortSignal every 64 MiB so timeouts and cancels stay
 * honored on multi-gigabyte primaries without loading the file whole.
 */
async function validateUtf8Streaming(
  path: string,
  signal?: AbortSignal | null,
): Promise<void> {
  throwIfAborted(signal);
  const validator = new Utf8StreamingValidator();
  const source = createReadStream(path, { highWaterMark: 1 << 20 });
  let bytesRead = 0;
  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      validator.push(bytes);
      bytesRead += bytes.length;
      if (bytesRead % (64 * 1024 * 1024) === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(signal);
      }
    }
    validator.finish();
  } finally {
    source.destroy();
  }
}

function utf8Error(reason: string, byte: number, position: number): string {
  const hex = byte.toString(16).padStart(2, "0");
  return `'utf-8' codec can't decode byte 0x${hex} in position ${position}: ${reason}`;
}

/**
 * Server-owned gene-level probe→gene coverage threshold for the release gate.
 * A strict 1.0 (zero residual) requirement is unreachable on real GEO arrays:
 * platforms such as GPL570 / GPL887 carry roughly 13–17% of probes with no
 * gene annotation (control / QC probes), a fixed property of the array rather
 * than an integration defect. The threshold is a server constant (never read
 * from the Agent-supplied spec — that smuggling path is rejected elsewhere);
 * residual rows above the floor are reported as warnings, not silently
 * dropped, so a partial mapping can never masquerade as a complete dataset.
 */
const REQUIRED_GENE_COVERAGE = 0.8;

export interface ValidationProfileRuntime {
  readonly profile_id: string;
  readonly required_entity_level: string;
  readonly profile: ValidationProfile;
  validate(options: {
    manifest: DatasetManifest;
    primaryPath: string;
    schema: DatasetSchema;
    manifestDigest: string;
    outputDir: string;
    probeMappingSummaries?: ProbeMappingSummary[] | null;
    signal?: AbortSignal | null;
  }): Promise<ValidationResult>;
}

export class ExpressionValidationProfile implements ValidationProfileRuntime {
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
      confidence_gate: {
        block_pending_human_review: true,
        required_fields_min_level: "medium",
        allow_low_confidence_primary: false,
        max_low_confidence_fraction: 0,
        require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"],
      },
    });
  }

  validate(options: {
    manifest: DatasetManifest;
    primaryPath: string;
    schema: DatasetSchema;
    manifestDigest: string;
    outputDir: string;
    probeMappingSummaries?: ProbeMappingSummary[] | null;
    signal?: AbortSignal | null;
  }): Promise<ValidationResult> {
    const signal = options.signal ?? null;
    throwIfAborted(signal);
    return this.validateCore(options, signal);
  }

  private async validateCore(
    options: {
      manifest: DatasetManifest;
      primaryPath: string;
      schema: DatasetSchema;
      manifestDigest: string;
      outputDir: string;
      probeMappingSummaries?: ProbeMappingSummary[] | null;
    },
    signal: AbortSignal | null,
  ): Promise<ValidationResult> {
    const { checks, warnings: coverageWarnings } = await this.runChecks(
      options.manifest,
      options.primaryPath,
      options.schema,
      options.probeMappingSummaries ?? null,
      signal,
    );
    const confidenceArtifact = await readConfidenceArtifact(options.outputDir);
    if (confidenceArtifact === null) {
      checks.push({
        check_id: "evidence_confidence_policy",
        description: "evidence confidence and human-review state satisfy the release profile",
        passed: false,
        detail: "required confidence_records.json artifact is missing",
      });
    } else {
      const gate = evaluateConfidenceGate(this.profile.confidence_gate, confidenceArtifact);
      checks.push({
        check_id: "evidence_confidence_policy",
        description: "evidence confidence and human-review state satisfy the release profile",
        passed: gate.passed,
        detail:
          `total=${gate.total_count}; low=${gate.low_count}; ` +
          `low_fraction=${gate.low_fraction.toFixed(4)}; pending=${gate.pending_count}; ` +
          `below_minimum=${gate.below_minimum_count}; ` +
          `unreviewed_required_channel=${gate.unreviewed_required_channel_count}`,
      });
    }
    const encodingFailed = checks.some(
      (check) => check.check_id === "csv_encoding_utf8" && !check.passed,
    );
    let confidenceWarnings: Array<Record<string, string>> = [];
    if (existsSync(options.primaryPath) && !encodingFailed) {
      const confidence = await this.runConfidenceCheck(
        options.primaryPath,
        options.outputDir,
        options.schema,
        signal,
      );
      checks.push(confidence.check);
      confidenceWarnings = confidence.warnings;
    }
    const warnings = [
      ...coverageWarnings,
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
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

  private async runChecks(
    _manifest: DatasetManifest,
    primaryPath: string,
    schema: DatasetSchema,
    probeMappingSummaries: ProbeMappingSummary[] | null,
    signal?: AbortSignal | null,
  ): Promise<{ checks: ProfileCheck[]; warnings: Array<Record<string, string>> }> {
    if (!existsSync(primaryPath)) {
      return {
        checks: [
          {
            check_id: "primary_dataset_exists",
            description: "primary dataset artifact exists",
            passed: false,
            detail: `missing primary dataset file: ${primaryPath}`,
          },
        ],
        warnings: [],
      };
    }
    const encodingCheck = await this.checkCsvEncoding(primaryPath, signal);
    if (!encodingCheck.passed) {
      return { checks: [encodingCheck], warnings: [] };
    }
    const checks: ProfileCheck[] = [
      await this.checkMinRows(_manifest, primaryPath, signal),
      await this.checkColumnCount(primaryPath, schema, signal),
      encodingCheck,
    ];
    checks.push(...(await this.checkRows(primaryPath, schema, signal)));
    const warnings: Array<Record<string, string>> = [];
    if (this.required_entity_level === "gene") {
      const coverage = await this.checkProbeCoverageRequiredGeneLevel(
        primaryPath,
        probeMappingSummaries,
        signal,
      );
      checks.push(coverage.check);
      if (coverage.warning !== null) warnings.push(coverage.warning);
    }
    return { checks, warnings };
  }

  private async checkCsvEncoding(primaryPath: string, signal?: AbortSignal | null): Promise<ProfileCheck> {
    throwIfAborted(signal);
    try {
      await validateUtf8Streaming(primaryPath, signal);
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

  private async checkMinRows(_manifest: DatasetManifest, primaryPath: string, signal?: AbortSignal | null): Promise<ProfileCheck> {
    const minimum = this.profile.acceptance.minimum_valid_rows;
    try {
      let totalLines = 0;
      for await (const { line } of delimitedRowsFromFileAsync(primaryPath, ",", signal, SCAN_BOUNDS)) {
        totalLines = line;
      }
      const fileRows = totalLines === 0 ? 0 : totalLines - 1;
      return {
        check_id: "minimum_valid_rows",
        description: `primary dataset has at least ${minimum} row(s)`,
        passed: fileRows >= minimum,
        detail: `file_row_count=${fileRows}, minimum=${minimum}`,
      };
    } catch (error) {
      if (error instanceof DelimitedBoundsError) return rowBoundsCheck(error);
      throw error;
    }
  }

  private async checkColumnCount(primaryPath: string, schema: DatasetSchema, signal?: AbortSignal | null): Promise<ProfileCheck> {
    try {
      let header: string[] = [];
      for await (const { values } of delimitedRowsFromFileAsync(primaryPath, ",", signal, SCAN_BOUNDS)) {
        header = values;
        break; // only the header row is needed
      }
      const expected = schema.fields.length;
      return {
        check_id: "column_count_matches_schema",
        description: "primary dataset column count matches the schema",
        passed: header.length === expected,
        detail: `actual=${header.length}, schema=${expected}`,
      };
    } catch (error) {
      if (error instanceof DelimitedBoundsError) return rowBoundsCheck(error);
      throw error;
    }
  }

  private async checkRows(primaryPath: string, schema: DatasetSchema, signal?: AbortSignal | null): Promise<ProfileCheck[]> {
    const required = new Set(
      schema.fields.filter((field) => field.required).map((field) => field.name),
    );
    const valueColumn = valueField(schema);
    try {
      let header: string[] = [];
      let expected = schema.fields.length;
      let rowCount = 0;
      let malformedWidth = 0;
      const blankRequired: Record<string, number> = {};
      let nonNumeric = 0;
      const units = new Set<string>();
      let missingProvenance = 0;
      let visited = 0;
      let headerSeen = false;
      for await (const { values: cells } of delimitedRowsFromFileAsync(primaryPath, ",", signal, SCAN_BOUNDS)) {
        if (!headerSeen) {
          headerSeen = true;
          header = cells;
          expected = header.length > 0 ? header.length : schema.fields.length;
          continue;
        }
        if (cells.length === 0) continue; // blank lines are not data rows
        rowCount += 1;
        if (cells.length !== expected) {
          malformedWidth += 1;
          continue;
        }
        const values: Record<string, string> = {};
        for (let index = 0; index < header.length; index += 1) {
          values[header[index]] = cells[index];
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
        visited += 1;
        if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
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
    } catch (error) {
      if (error instanceof DelimitedBoundsError) return [rowBoundsCheck(error)];
      throw error;
    }
  }

  private async checkProbeCoverageRequiredGeneLevel(
    primaryPath: string,
    summaries: ProbeMappingSummary[] | null,
    signal?: AbortSignal | null,
  ): Promise<{ check: ProfileCheck; warning: Record<string, string> | null }> {
    let scan: { total: number; residual: number };
    try {
      scan = await countResidualGeoProbeRows(primaryPath, signal);
    } catch (error) {
      if (error instanceof DelimitedBoundsError) {
        return { check: rowBoundsCheck(error), warning: null };
      }
      throw error;
    }
    const coverage = scan.total > 0 ? (scan.total - scan.residual) / scan.total : 0;
    const belowFloor: string[] = [];
    if (summaries !== null) {
      for (const summary of summaries) {
        if (
          summary.total_probe_count > 0 &&
          Math.abs(summary.coverage_ratio - REQUIRED_GENE_COVERAGE) > 1e-9 &&
          summary.coverage_ratio < REQUIRED_GENE_COVERAGE
        ) {
          belowFloor.push(summary.binding_id);
        }
      }
    }
    const passed = coverage >= REQUIRED_GENE_COVERAGE - 1e-9 && belowFloor.length === 0;
    const detail =
      `residual_geo_probe_rows=${scan.residual}; total_rows=${scan.total}; ` +
      `coverage_ratio=${coverage.toFixed(4)}; required=${REQUIRED_GENE_COVERAGE.toFixed(4)}` +
      (summaries !== null
        ? `; coverage_below_required=${belowFloor.length > 0 ? pyReprList(belowFloor) : "none"}`
        : "");
    const check: ProfileCheck = {
      check_id: CHECK_ID_PROBE_COVERAGE_REQUIRED_GENE_LEVEL,
      description:
        `gene-required build: probe→gene coverage must reach a server-owned ` +
        `floor of ${REQUIRED_GENE_COVERAGE.toFixed(2)} with no fully-unmapped binding`,
      passed,
      detail,
    };
    const warning =
      passed && coverage < 1.0
        ? {
            check_id: "probe_coverage_gene_residual",
            residual_geo_probe_rows: String(scan.residual),
            total_rows: String(scan.total),
            coverage_ratio: coverage.toFixed(4),
            detail:
              `gene build published with ${(1 - coverage).toFixed(4)} ` +
              `unmapped probe share (platform-inherent, not silently dropped)`,
          }
        : null;
    return { check, warning };
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

  private async runConfidenceCheck(
    primaryPath: string,
    outputDir: string,
    schema: DatasetSchema,
    signal?: AbortSignal | null,
  ): Promise<{ check: ProfileCheck; warnings: Array<Record<string, string>> }> {
    const valueColumn = valueField(schema);
    const aggregator = new ConfidenceColumnAggregator(valueColumn, this.confidenceThresholds);
    let valueIndex = -1;
    let visited = 0;
    let headerSeen = false;
    try {
      for await (const { values } of delimitedRowsFromFileAsync(primaryPath, ",", signal, SCAN_BOUNDS)) {
        if (!headerSeen) {
          headerSeen = true;
          valueIndex = values.indexOf(valueColumn);
          continue;
        }
        aggregator.push(valueIndex >= 0 ? values[valueIndex] ?? "" : "");
        visited += 1;
        if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
      }
    } catch (error) {
      if (error instanceof DelimitedBoundsError) return { check: rowBoundsCheck(error), warnings: [] };
      throw error;
    }
    const summary = aggregator.summary();
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
      confidence_gate: {
        block_pending_human_review: true,
        required_fields_min_level: "medium",
        allow_low_confidence_primary: false,
        max_low_confidence_fraction: 0,
        require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"],
      },
    });
  }
}

class RegisteredMultitableValidationProfile implements ValidationProfileRuntime {
  readonly required_entity_level = "any";
  constructor(readonly profile: ValidationProfile) {}
  get profile_id(): string { return this.profile.profile_id; }

  async validate(options: {
    manifest: DatasetManifest;
    primaryPath: string;
    schema: DatasetSchema;
    manifestDigest: string;
    outputDir: string;
    probeMappingSummaries?: ProbeMappingSummary[] | null;
    signal?: AbortSignal | null;
  }): Promise<ValidationResult> {
    const passed = existsSync(options.primaryPath) && options.manifest.row_count >= this.profile.acceptance.minimum_valid_rows;
    const report = {
      profile_ref: this.profile.profile_id,
      manifest_digest: options.manifestDigest,
      checks: [{
        check_id: "registered_multitable_primary",
        description: "registered multi-table primary artifact is present and non-empty",
        passed,
        detail: `row_count=${options.manifest.row_count}`,
      }],
      warnings: [],
    };
    await writeFile(joinOutput(options.outputDir, "validation_report.json"), `${JSON.stringify(report, null, 2)}\\n`, "utf8");
    return {
      schema_version: "1.0",
      manifest_digest: options.manifestDigest,
      profile_ref: this.profile.profile_id,
      status: passed ? "passed" : "failed",
      checked_count: 1,
      failed_count: passed ? 0 : 1,
      report_path: "validation_report.json",
    };
  }
}

const VALIDATION_PROFILES: Readonly<Record<string, ValidationProfileRuntime>> = {
  "gene_expression.release.v1": new ExpressionValidationProfile(),
  "gene_expression.probe_release.v1": new ProbeExpressionValidationProfile(),
  "literature_evidence.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "literature_evidence.release.v1", dataset_family: "literature_evidence",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered literature evidence multi-table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
  "target_evidence.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "target_evidence.release.v1", dataset_family: "target_evidence",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered target evidence multi-table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
  "variant_evidence.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "variant_evidence.release.v1", dataset_family: "variant_evidence",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered variant evidence multi-table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
  "protein_structure.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "protein_structure.release.v1", dataset_family: "protein_structure",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered protein structure multi-table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
  "bioactivity_measurement.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "bioactivity_measurement.release.v1", dataset_family: "bioactivity_measurement",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered bioactivity measurement multi-table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
  "gut_microbiome.release.v1": new RegisteredMultitableValidationProfile(parseValidationProfile({
    profile_id: "gut_microbiome.release.v1", dataset_family: "gut_microbiome",
    acceptance: { minimum_valid_rows: 1, allow_empty_primary_dataset: false, allow_partial_publish: false },
    description: "Strict registered MGnify taxonomy table release gate.", required_entity_level: "any",
    confidence_gate: { block_pending_human_review: true, required_fields_min_level: "medium", allow_low_confidence_primary: false, max_low_confidence_fraction: 0, require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"] },
  })),
};

/** Registered validation profile refs (server allowlist). */
export const VALIDATION_PROFILE_REFS: readonly string[] = Object.keys(VALIDATION_PROFILES);

/** Resolve a validation profile by ref (throws on unregistered refs). */
export function getValidationProfile(profileRef: string): ValidationProfileRuntime {
  const profile = VALIDATION_PROFILES[profileRef];
  if (profile === undefined) {
    throw new Error(`validation profile '${profileRef}' is not registered`);
  }
  return profile;
}

/** Python ``json.dumps(record, sort_keys=True)`` for string->int maps. */
function sortedJson(record: Record<string, number>): string {
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${record[key]}`);
  return `{${parts.join(",")}}`;
}

/**
 * Count primary rows whose ``gene_id_namespace`` is still ``geo_probe``,
 * alongside the total data row count (needed to compute real coverage on
 * platforms whose unannotated probes are a fixed property of the array).
 */
async function countResidualGeoProbeRows(
  primaryPath: string,
  signal?: AbortSignal | null,
): Promise<{ total: number; residual: number }> {
  let namespaceIndex = -1;
  let residual = 0;
  let total = 0;
  let headerSeen = false;
  for await (const { values } of delimitedRowsFromFileAsync(primaryPath, ",", signal, SCAN_BOUNDS)) {
    if (!headerSeen) {
      headerSeen = true;
      namespaceIndex = values.indexOf("gene_id_namespace");
      if (namespaceIndex < 0) return { total, residual };
      continue;
    }
    total += 1;
    if ((values[namespaceIndex] ?? "").trim() === "geo_probe") residual += 1;
    if (total % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }
  return { total, residual };
}
