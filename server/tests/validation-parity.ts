/**
 * Phase 4 step 8 (validation) parity checks: deterministic confidence
 * detectors (mirror ``backend/tests/test_dataset_confidence.py``), the
 * gene/probe release validation profiles (mirror
 * ``backend/tests/test_dataset_profiles.py``) and the SpecValidator pre-check
 * (mirror ``backend/tests/test_spec_validator.py``).  Vitest-free so the same
 * checks run under vitest and as a plain Node script.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { deepEqual } from "./contract-parity.js";
import {
  parseDatasetBuildSpec,
  parseDatasetManifest,
  type DatasetBuildSpec,
  type DatasetManifest,
} from "../src/dataset/contracts/index.js";
import {
  csvLine,
  delimitedRowsFromFileAsync,
  DelimitedBoundsError,
} from "../src/dataset/adapters/index.js";
import {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
  SchemaRegistry,
} from "../src/dataset/schema/index.js";
import {
  aggregateConfidenceMetrics,
  benfordDistance,
  ConfidenceColumnAggregator,
  defaultConfidenceThresholds,
  detectArithmeticProgression,
  detectConstantColumn,
  isBenfordApplicable,
  lastDigitChi2,
  writeConfidenceReport,
  type ConfidenceThresholds,
  getValidationProfile,
  type ProbeMappingSummary,
  SpecValidator,
  Utf8StreamingValidator,
} from "../src/dataset/validation/index.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

/** Deterministic PRNG so the "random" Benford suites are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function scratchOutputRoot(prefix = "validation-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Confidence detectors (test_dataset_confidence.py)
// ---------------------------------------------------------------------------

export function checkConfidenceParity(): string[] {
  const issues: string[] = [];

  // is_benford_applicable
  {
    const rng = mulberry32(20260807);
    const natural = Array.from({ length: 200 }, () => 10 ** (rng() * 6.0));
    check(issues, isBenfordApplicable(natural) === true, "benford applicable: natural-like data");
    const few = Array.from({ length: 5 }, (_, i) => 10 ** i);
    check(issues, isBenfordApplicable(few) === false, "benford not applicable: too few samples");
    const narrow = Array.from({ length: 50 }, (_, i) => 1.0 + 0.1 * i);
    check(issues, isBenfordApplicable(narrow) === false, "benford not applicable: single order span");
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => -(10 ** (i + 1))),
      ...Array.from({ length: 5 }, (_, i) => 10 ** (i + 1)),
    ];
    check(issues, isBenfordApplicable(mixed) === false, "benford not applicable: negative values");
    const rng7 = mulberry32(7);
    const normalized = Array.from({ length: 100 }, () => rng7());
    check(issues, isBenfordApplicable(normalized) === false, "benford not applicable: normalized");
    const nonNumeric = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? "n/a" : i % 3 === 1 ? "?" : ""));
    check(issues, isBenfordApplicable(nonNumeric) === false, "benford not applicable: non-numeric");
  }

  // benford_distance
  {
    const uniform = Array.from({ length: 9 }, (_, d) => (d + 1) * 10 ** 5).flatMap((v) => Array(40).fill(v));
    check(issues, benfordDistance(uniform) > 15.51, "benford distance: uniform first digit flagged");
    const rng = mulberry32(42);
    const benfordLike = Array.from({ length: 2000 }, () => 10 ** (rng() * 5.0));
    const distance = benfordDistance(benfordLike);
    check(issues, distance >= 0.0 && distance < 15.51, `benford distance: benford-like small (got ${distance})`);
    check(issues, benfordDistance([]) === 0.0, "benford distance: empty");
    check(issues, benfordDistance(["a", "b"]) === 0.0, "benford distance: non-numeric");
  }

  // last_digit_chi2
  {
    const uniform = Array.from({ length: 10 }, (_, d) => d / 10).flatMap((v) => Array(20).fill(v));
    check(issues, lastDigitChi2(uniform) < 16.92, "last digit chi2: uniform small");
    const zerosFives = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0].flatMap((v) => Array(20).fill(v));
    check(issues, lastDigitChi2(zerosFives) > 16.92, "last digit chi2: zeros and fives flagged");
    const exponent = Array(30).fill(1.5e7);
    check(issues, lastDigitChi2(exponent) > 16.92, "last digit chi2: exponent expansion");
    check(issues, lastDigitChi2([]) === 0.0, "last digit chi2: empty");
  }

  // detect_constant_column
  {
    check(issues, detectConstantColumn(Array(40).fill(3.7)) === true, "constant column: true");
    check(issues, detectConstantColumn([1.0, 2.0, 3.0]) === false, "constant column: false when varying");
    check(issues, detectConstantColumn([3.7]) === false, "constant column: single value");
  }

  // detect_arithmetic_progression
  {
    check(issues, detectArithmeticProgression([1.0, 2.0, 3.0, 4.0, 5.0]) === true, "progression: true 1..5");
    check(issues, detectArithmeticProgression([10.0, 20.0, 30.0]) === true, "progression: true 10/20/30");
    check(issues, detectArithmeticProgression([1.0, 2.0, 4.0, 8.0]) === false, "progression: false irregular");
    check(issues, detectArithmeticProgression([5.0, 5.0]) === false, "progression: too few distinct");
    const wideThresholds: ConfidenceThresholds = {
      ...defaultConfidenceThresholds(),
      progression_max_distinct: 10,
    };
    const wide = Array.from({ length: 100 }, (_, i) => i);
    check(issues, detectArithmeticProgression(wide, wideThresholds) === false, "progression: skipped on wide domain");
  }

  // aggregate_confidence_metrics
  {
    const summary = aggregateConfidenceMetrics({
      expression_value: Array(60).fill(3.7),
      sample_idx: [1, 2, 3, 4, 5],
    });
    check(issues, summary.anomaly_count >= 2, "aggregate: anomaly_count >= 2");
    const byDetector = new Map(
      summary.findings.map((finding) => [`${finding.column}:${finding.detector}`, finding]),
    );
    const constant = byDetector.get("expression_value:constant_column");
    check(issues, constant !== undefined && constant.anomaly === true, "aggregate: constant column anomaly");
    const progression = byDetector.get("sample_idx:arithmetic_progression");
    check(issues, progression !== undefined && progression.anomaly === true, "aggregate: progression anomaly");
    const benford = byDetector.get("sample_idx:benford_distance");
    check(issues, benford !== undefined && benford.applicable === false, "aggregate: benford not applicable to 1..5");

    const rng = mulberry32(11);
    const benfordValues = Array.from({ length: 300 }, () => 10 ** (rng() * 5.0));
    const benfordSummary = aggregateConfidenceMetrics({ value: benfordValues });
    const benfordFinding = benfordSummary.findings.find((f) => f.detector === "benford_distance");
    check(issues, benfordFinding !== undefined && benfordFinding.applicable === true, "aggregate: benford applicable flag");
    check(
      issues,
      benfordFinding !== undefined && benfordFinding.statistic !== null && Number.isFinite(benfordFinding.statistic),
      "aggregate: benford statistic finite",
    );

    const emptySummary = aggregateConfidenceMetrics({ empty: ["", "n/a"] });
    check(issues, emptySummary.anomaly_count === 0, "aggregate: empty column no anomaly");
    check(issues, emptySummary.findings[0].detector === "no_numeric_values", "aggregate: empty column detector");
    check(issues, emptySummary.findings[0].applicable === false, "aggregate: empty column not applicable");
  }

  // streaming aggregator mirrors aggregate_confidence_metrics (single pass, O(1) memory)
  {
    const cases: Array<{ column: string; values: Array<string | number>; thresholds?: ConfidenceThresholds }> = [
      { column: "benford_like", values: Array.from({ length: 300 }, () => 10 ** (mulberry32(2026)() * 5.0)) },
      { column: "uniform_first_digit", values: Array.from({ length: 9 }, (_, d) => (d + 1) * 10 ** 5).flatMap((v) => Array(40).fill(v)) },
      { column: "constant", values: Array(60).fill(3.7) },
      { column: "progression", values: Array.from({ length: 50 }, (_, i) => i) },
      { column: "tiny", values: [1.5, 2.5, 3.5] },
      { column: "empty", values: ["", "n/a", "?"] },
      { column: "mixed_negative", values: [...Array.from({ length: 40 }, (_, i) => -(10 ** (i % 6 + 1))), ...Array.from({ length: 40 }, (_, i) => 10 ** (i % 6 + 1))] },
      { column: "wide", values: Array.from({ length: 1000 }, (_, i) => i), thresholds: { ...defaultConfidenceThresholds(), progression_max_distinct: 10 } },
      { column: "boundary_exact", values: Array.from({ length: 10 }, (_, i) => i + 1), thresholds: { ...defaultConfidenceThresholds(), progression_max_distinct: 10 } },
      { column: "non_finite", values: ["nan", "inf", "-inf", "1e999", "abc", 0, -0, 5, 5, 5] },
      { column: "mixed_types", values: ["1.5", 2.5, "3.5e0", 4.5, "5", 6, "n/a", "", null as never] },
    ];
    for (const { column, values, thresholds } of cases) {
      const arraySummary = aggregateConfidenceMetrics({ [column]: values }, thresholds);
      const aggregator = new ConfidenceColumnAggregator(column, thresholds);
      for (const value of values) aggregator.push(value as string | number);
      if (!deepEqual(aggregator.summary(), arraySummary)) {
        issues.push(
          `streaming aggregator mismatch for ${column}: expected ${JSON.stringify(arraySummary)}, got ${JSON.stringify(aggregator.summary())}`,
        );
      }
    }

    // large column: single pass must not degrade the histogram accumulation
    const rng = mulberry32(99);
    const large = Array.from({ length: 50_000 }, () => 10 ** (rng() * 5.0));
    const largeArray = aggregateConfidenceMetrics({ value: large });
    const largeStream = new ConfidenceColumnAggregator("value");
    for (const value of large) largeStream.push(value);
    if (!deepEqual(largeStream.summary(), largeArray)) {
      issues.push(`streaming aggregator mismatch on large column: got ${JSON.stringify(largeStream.summary())}`);
    }
  }

  // last-digit gating on small samples
  {
    const gatedThresholds: ConfidenceThresholds = {
      ...defaultConfidenceThresholds(),
      min_last_digit_samples: 50,
    };
    const summary = aggregateConfidenceMetrics({ value: [1.5, 2.5, 3.5] }, gatedThresholds);
    const lastDigit = summary.findings.find((f) => f.detector === "last_digit_chi2");
    check(issues, lastDigit !== undefined && lastDigit.applicable === false, "last digit: not applicable below threshold");
    check(issues, lastDigit !== undefined && lastDigit.anomaly === false, "last digit: no spurious anomaly");
    check(issues, lastDigit !== undefined && lastDigit.statistic === null, "last digit: no statistic when gated");
    check(
      issues,
      !summary.findings.some((f) => f.detector === "last_digit_chi2" && f.anomaly),
      "last digit: no anomaly from gated detector",
    );

    const above = aggregateConfidenceMetrics({ value: [5.0, 10.0, 15.0].flatMap((v) => Array(20).fill(v)) });
    const aboveFinding = above.findings.find((f) => f.detector === "last_digit_chi2");
    check(issues, aboveFinding !== undefined && aboveFinding.applicable === true, "last digit: applicable above threshold");
    check(issues, aboveFinding !== undefined && aboveFinding.anomaly === true, "last digit: anomaly above threshold");
  }

  // write_confidence_report_deterministic
  {
    const out = scratchOutputRoot("confidence-report-");
    const summary = aggregateConfidenceMetrics({ value: [1.0, 2.0, 3.0] });
    const path1 = join(out, "confidence_report.csv");
    const path2 = join(out, "confidence_report2.csv");
    writeConfidenceReport(summary, path1);
    writeConfidenceReport(summary, path2);
    const text = readFileSync(path1, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const header = lines[0].split(",");
    const first = Object.fromEntries(header.map((column, index) => [column, lines[1].split(",")[index] ?? ""]));
    check(issues, first["column"] === "value", "report: first row column is value");
    check(issues, first["detector"] === "benford_distance", "report: first row detector is benford_distance");
    check(issues, first["applicable"] === "false", "report: first row applicable false");
    check(issues, first["statistic"] === "", "report: first row statistic blank");
    check(
      issues,
      readFileSync(path1).equals(readFileSync(path2)),
      "report: deterministic bytes across writes",
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Validation profiles (test_dataset_profiles.py)
// ---------------------------------------------------------------------------

const CANONICAL_HEADER = [
  "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
  "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
  "source_sample_alias", "measurement_type", "value_semantics",
  "value_scale", "is_normalized", "is_integer_expected",
  "expression_value", "expression_unit", "source_logical_file",
  "source_line_number", "source_column_index", "source_column_name",
  "source_raw_value",
];

function validRow(gene = "TP53", unit = "expression_value"): Record<string, string> {
  return {
    record_id: `rec_${gene}`,
    dataset_id: "build_test",
    source_id: "src_gdc",
    asset_id: "asset_a" + "0".repeat(57),
    gene_id_raw: gene,
    gene_id: gene,
    gene_id_namespace: "gene_symbol",
    gene_id_version: "",
    sample_id: "S1",
    source_sample_alias: "S1",
    measurement_type: "gene_expression",
    value_semantics: "expression_value",
    value_scale: "linear",
    is_normalized: "false",
    is_integer_expected: "false",
    expression_value: "1.5",
    expression_unit: unit,
    source_logical_file: "gdc_expression.tsv",
    source_line_number: "2",
    source_column_index: "1",
    source_column_name: "S1",
    source_raw_value: "1.5",
  };
}

function writePrimary(path: string, rows: Array<Record<string, string>>): void {
  const lines = [csvLine(CANONICAL_HEADER)];
  for (const row of rows) {
    lines.push(csvLine(CANONICAL_HEADER.map((column) => row[column] ?? "")));
  }
  writeFileSync(path, lines.join(""), "utf8");
  writeFileSync(join(dirname(path), "confidence_records.json"), `${JSON.stringify({
    schema_version: "1.0",
    batch_defaults: [{
      schema_version: "1.0",
      batch_id: "batch_fixture",
      record_count: rows.length,
      level: "high",
      channel: "deterministic_parser",
      components: {
        schema_version: "1.0",
        source_reliability: "high",
        extraction_reliability: "high",
        mapping_reliability: "high",
        cross_source_consistency: "not_checked",
        human_review_state: "not_required",
      },
      reasons: [],
    }],
    record_overrides: [],
  }, null, 2)}\n`, "utf8");
}

function manifest(rowCount: number): DatasetManifest {
  return parseDatasetManifest({
    schema_version: "1.0",
    manifest_id: "manifest_test",
    task_id: "task_test",
    build_id: "build_test",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    primary_key: ["gene_id", "sample_id"],
    row_count: rowCount,
    sha256: "a".repeat(64),
    artifacts: [
      {
        schema_version: "1.0",
        artifact_id: "artifact_1",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: 1,
        sha256: "b".repeat(64),
      },
    ],
    source_summary: {},
    validation_summary: {},
    confidence_summary: {},
    provenance_summary: {},
  });
}

function probeSummary(options: {
  bindingId?: string;
  platformId?: string;
  total: number;
  mapped: number;
  unmapped: number;
  ambiguous?: number;
  status?: string;
}): ProbeMappingSummary {
  const total = options.total;
  const mapped = options.mapped;
  return {
    binding_id: options.bindingId ?? "binding_geo",
    platform_id: options.platformId ?? "GPL570",
    source_namespace: "geo_probe",
    target_namespace: "gene_symbol",
    mapping_status: options.status ?? "partial",
    total_probe_count: total,
    mapped_probe_count: mapped,
    unmapped_probe_count: options.unmapped,
    ambiguous_probe_count: options.ambiguous ?? 0,
    coverage_ratio: total === 0 ? 0 : mapped / total,
    mapping_asset_id: "asset_mapping" + "0".repeat(50),
    mapping_rule_id: "geo.probe-map.v1",
  };
}

function loadReport(outputDir: string): Record<string, unknown> {
  const text = readFileSync(join(outputDir, "validation_report.json"), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function checkValidationProfileParity(options: { outputRoot: string }): Promise<string[]> {
  const issues: string[] = [];
  const outRoot = options.outputRoot;
  const profile = getValidationProfile("gene_expression.release.v1");

  // test_profile_registered
  check(issues, profile.profile_id === "gene_expression.release.v1", "profile: id registered");
  check(issues, profile.profile.acceptance.minimum_valid_rows === 1, "profile: minimum_valid_rows 1");

  // test_valid_primary_passes
  {
    const out = join(outRoot, "valid");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "passed", "profile: valid primary passes");
    check(issues, result.failed_count === 0, "profile: valid primary failed_count 0");
    check(issues, result.checked_count === 11, `profile: valid primary checked_count 11 (got ${result.checked_count})`);
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").length > 0, "profile: report written");
    check(issues, readFileSync(join(out, "confidence_report.csv"), "utf8").length > 0, "profile: confidence report written");
  }

  // A formal release profile must never silently skip its evidence gate.
  {
    const out = join(outRoot, "missing-confidence-artifact");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    const row = validRow();
    writeFileSync(
      primary,
      csvLine(CANONICAL_HEADER) + csvLine(CANONICAL_HEADER.map((column) => row[column] ?? "")),
      "utf8",
    );
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: missing confidence artifact fails closed");
    check(
      issues,
      readFileSync(join(out, "validation_report.json"), "utf8").includes("evidence_confidence_policy"),
      "profile: missing confidence artifact reports evidence gate",
    );
  }

  // test_empty_primary_fails_min_rows
  {
    const out = join(outRoot, "empty");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, []);
    await profile.validate({
      manifest: manifest(0),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("minimum_valid_rows"), "profile: empty primary reports minimum_valid_rows");
  }

  // test_header_only_file_fails_even_when_manifest_claims_rows
  {
    const out = join(outRoot, "header-only");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, []);
    const result = await profile.validate({
      manifest: manifest(5),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: header-only fails despite manifest rows");
    const report = readFileSync(join(out, "validation_report.json"), "utf8");
    check(issues, report.includes('"check_id": "minimum_valid_rows"'), "profile: header-only reports minimum_valid_rows");
    check(issues, report.includes("file_row_count=0"), "profile: header-only reports file_row_count=0");
  }

  // test_mixed_units_fail_consistency
  {
    const out = join(outRoot, "mixed-units");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow("TP53", "expression_value"), validRow("BRCA1", "tpm_unstranded")]);
    const result = await profile.validate({
      manifest: manifest(2),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: mixed units fail");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("unit_consistency"), "profile: mixed units report unit_consistency");
  }

  // test_non_numeric_value_fails
  {
    const out = join(outRoot, "non-numeric");
    mkdirSync(out, { recursive: true });
    const row = validRow();
    row["expression_value"] = "NaN-value";
    const primary = join(out, "primary.csv");
    writePrimary(primary, [row]);
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: non-numeric fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("expression_value_numeric"), "profile: non-numeric reports expression_value_numeric");
  }

  // test_nan_and_inf_values_fail
  for (const bad of ["nan", "inf", "-inf"]) {
    const out = join(outRoot, `nan-${bad.replace(/[^a-z]/g, "")}`);
    mkdirSync(out, { recursive: true });
    const row = validRow();
    row["expression_value"] = bad;
    const primary = join(out, "primary.csv");
    writePrimary(primary, [row]);
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", `profile: ${bad} fails`);
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("expression_value_numeric"), `profile: ${bad} reports numeric check`);
  }

  // test_missing_provenance_fails_closure
  {
    const out = join(outRoot, "no-provenance");
    mkdirSync(out, { recursive: true });
    const row = validRow();
    row["source_logical_file"] = "";
    const primary = join(out, "primary.csv");
    writePrimary(primary, [row]);
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: missing provenance fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("provenance_closure"), "profile: missing provenance reports closure");
  }

  // test_column_count_mismatch_fails
  {
    const out = join(outRoot, "column-count");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writeFileSync(primary, "only_one_column\n1\n", "utf8");
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: column count mismatch fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("column_count_matches_schema"), "profile: column count reports check");
  }

  // test_extra_column_row_fails_row_width
  {
    const out = join(outRoot, "extra-column");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    const row = validRow();
    const lines = [csvLine(CANONICAL_HEADER)];
    lines.push(csvLine([...CANONICAL_HEADER.map((column) => row[column] ?? ""), "EXTRA"]));
    writeFileSync(primary, lines.join(""), "utf8");
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: extra column row fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("row_width_matches_schema"), "profile: extra column reports row width");
  }

  // test_row_with_missing_cells_fails_row_width
  {
    const out = join(outRoot, "missing-cells");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    const row = validRow();
    const lines = [csvLine(CANONICAL_HEADER)];
    lines.push(csvLine(CANONICAL_HEADER.slice(0, -3).map((column) => row[column] ?? "")));
    writeFileSync(primary, lines.join(""), "utf8");
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: missing cells row fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("row_width_matches_schema"), "profile: missing cells reports row width");
  }

  // test_missing_primary_file_fails
  {
    const out = join(outRoot, "missing-file");
    mkdirSync(out, { recursive: true });
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: join(out, "nope.csv"),
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: missing primary file fails");
    check(issues, readFileSync(join(out, "validation_report.json"), "utf8").includes("primary_dataset_exists"), "profile: missing primary reports existence check");
  }

  // test_data_confidence_warning_does_not_block_release
  {
    const out = join(outRoot, "confidence-warning");
    mkdirSync(out, { recursive: true });
    const rows = Array.from({ length: 60 }, (_, i) => {
      const row = validRow(`G${i}`);
      row["expression_value"] = "3.7";
      return row;
    });
    const primary = join(out, "primary.csv");
    writePrimary(primary, rows);
    const result = await profile.validate({
      manifest: manifest(60),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "passed", "profile: confidence warning does not block");
    check(issues, result.failed_count === 0, "profile: confidence warning failed_count 0");
    const report = readFileSync(join(out, "validation_report.json"), "utf8");
    check(issues, report.includes('"check_id": "data_confidence"'), "profile: confidence warning report has check");
    check(issues, report.includes("warnings"), "profile: confidence warning report has warnings");
    check(issues, report.includes("constant_column"), "profile: confidence warning report names constant_column");
  }

  // test_data_confidence_report_rows
  {
    const out = join(outRoot, "confidence-report-rows");
    mkdirSync(out, { recursive: true });
    const rows = Array.from({ length: 60 }, (_, i) => {
      const row = validRow(`G${i}`);
      row["expression_value"] = "3.7";
      return row;
    });
    const primary = join(out, "primary.csv");
    writePrimary(primary, rows);
    const result = await profile.validate({
      manifest: manifest(60),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "passed", "profile: confidence report rows pass");
    const reportText = readFileSync(join(out, "confidence_report.csv"), "utf8");
    const reportLines = reportText.split(/\r?\n/).filter((line) => line.length > 0);
    const header = reportLines[0].split(",");
    const dictRows = reportLines.slice(1).map((line) => {
      const record: Record<string, string> = {};
      header.forEach((column, index) => { record[column] = line.split(",")[index] ?? ""; });
      return record;
    });
    check(issues, dictRows.length > 0, "profile: confidence report has rows");
    check(issues, new Set(dictRows.map((r) => r["column"])).size === 1 && dictRows[0]["column"] === "expression_value", "profile: confidence report column");
    const constant = dictRows.find((r) => r["detector"] === "constant_column");
    check(issues, constant !== undefined && constant["anomaly"] === "true", "profile: confidence report constant anomaly true");
    check(issues, constant !== undefined && constant["applicable"] === "true", "profile: confidence report constant applicable true");
  }

  // test_non_utf8_primary_fails_csv_encoding
  {
    const out = join(outRoot, "non-utf8");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writeFileSync(primary, Buffer.from([0x72, 0x65, 0x63, 0xff, 0xfe, 0x00, 0x62]));
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "failed", "profile: non-utf8 fails");
    const report = readFileSync(join(out, "validation_report.json"), "utf8");
    check(issues, report.includes('"check_id": "csv_encoding_utf8"'), "profile: non-utf8 reports encoding");
    check(issues, report.includes("not valid UTF-8"), "profile: non-utf8 message");
  }

  // test_utf8_primary_passes_csv_encoding
  {
    const out = join(outRoot, "utf8");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const content = readFileSync(primary);
    const replaced = Buffer.from(content.toString("utf8").replace("TP53", "TP53基因"), "utf8");
    writeFileSync(primary, replaced);
    const result = await profile.validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "passed", "profile: utf8 passes");
    const report = readFileSync(join(out, "validation_report.json"), "utf8");
    check(issues, report.includes('"check_id": "csv_encoding_utf8"'), "profile: utf8 reports encoding");
    check(issues, report.includes('"passed": true'), "profile: utf8 encoding passed true");
  }

  // regression: the encoding check used to readFile() the whole primary into
  // memory (decodeUtf8Strict), OOMing the heap on the 1.9GB merged build; the
  // streaming validator must keep the same byte rules across chunk boundaries
  {
    // a 3-byte sequence split across two pushes must still validate
    let carried: boolean;
    try {
      const validator = new Utf8StreamingValidator();
      validator.push(Buffer.from([0x61, 0x62, 0xe4]));
      validator.push(Buffer.from([0xb8, 0xad, 0x63]));
      validator.finish();
      carried = true;
    } catch {
      carried = false;
    }
    check(issues, carried, "profile: utf8 streaming carry-over validates");
    // an invalid continuation byte arriving in the next chunk fails at its
    // absolute byte position
    let continuation = "";
    try {
      const validator = new Utf8StreamingValidator();
      validator.push(Buffer.from([0xe4, 0xb8]));
      validator.push(Buffer.from([0x41]));
      validator.finish();
    } catch (error) {
      continuation = error instanceof Error ? error.message : "";
    }
    check(
      issues,
      continuation.includes("invalid continuation byte") && continuation.includes("position 2"),
      "profile: utf8 streaming invalid continuation at boundary",
    );
    // a sequence still open at EOF is unexpected end of data
    let truncated = "";
    try {
      const validator = new Utf8StreamingValidator();
      validator.push(Buffer.from([0x61, 0xe4]));
      validator.finish();
    } catch (error) {
      truncated = error instanceof Error ? error.message : "";
    }
    check(
      issues,
      truncated.includes("unexpected end of data") && truncated.includes("position 1-1"),
      "profile: utf8 streaming truncated at EOF",
    );
  }

  // test_utf8_primary_multichunk (streaming encoding check across >1MiB input)
  {
    const out = join(outRoot, "utf8-multichunk");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    const rows: Array<Record<string, string>> = [];
    for (let index = 0; index < 20_000; index += 1) {
      rows.push(validRow(`G${index}`));
    }
    writePrimary(primary, rows);
    const result = await profile.validate({
      manifest: manifest(rows.length),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.status === "passed", "profile: utf8 multichunk passes");
    const report = readFileSync(join(out, "validation_report.json"), "utf8");
    check(issues, report.includes('"check_id": "csv_encoding_utf8"'), "profile: utf8 multichunk reports encoding");
    check(issues, report.includes("primary dataset decodes as UTF-8"), "profile: utf8 multichunk encoding passed");
  }

  // entity level + probe release profile
  {
    const geneProfile = getValidationProfile("gene_expression.release.v1");
    check(issues, geneProfile.required_entity_level === "gene", "profile: gene entity level");
    check(issues, geneProfile.profile.required_entity_level === "gene", "profile: gene profile contract entity level");
    const probeProfile = getValidationProfile("gene_expression.probe_release.v1");
    check(issues, probeProfile.profile_id === "gene_expression.probe_release.v1", "profile: probe profile registered");
    check(issues, probeProfile.required_entity_level === "probe", "profile: probe entity level");
    check(issues, probeProfile.profile.required_entity_level === "probe", "profile: probe contract entity level");
    check(issues, probeProfile.profile.dataset_family === "gene_expression", "profile: probe family");
    check(issues, probeProfile.profile.acceptance.minimum_valid_rows === 1, "profile: probe minimum rows");
  }

  // test_probe_release_profile_runs_the_release_gate
  {
    const out = join(outRoot, "probe-gate");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await getValidationProfile("gene_expression.probe_release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
    });
    check(issues, result.profile_ref === "gene_expression.probe_release.v1", "profile: probe gate ref");
    check(issues, result.status === "passed", "profile: probe gate passes");
    check(issues, result.failed_count === 0, "profile: probe gate failed_count 0");
  }

  // test_gene_profile_coverage_below_one_fails
  {
    const out = join(outRoot, "coverage-below-one");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await getValidationProfile("gene_expression.release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
      probeMappingSummaries: [probeSummary({ total: 10, mapped: 8, unmapped: 2, status: "partial" })],
    });
    check(issues, result.status === "failed", "profile: coverage below one fails");
    check(issues, result.failed_count >= 1, "profile: coverage below one failed_count >= 1");
    const report = loadReport(out);
    const checks = (report["checks"] as Array<Record<string, unknown>>) ?? [];
    const coverage = checks.find((c) => c["check_id"] === "probe_coverage_required_gene_level");
    check(issues, coverage !== undefined && coverage["passed"] === false, "profile: coverage below one check failed");
  }

  // test_gene_profile_zero_coverage_fails
  {
    const out = join(outRoot, "coverage-zero");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await getValidationProfile("gene_expression.release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
      probeMappingSummaries: [probeSummary({ total: 10, mapped: 0, unmapped: 10, status: "unmapped" })],
    });
    check(issues, result.status === "failed", "profile: zero coverage fails");
    check(issues, result.failed_count >= 1, "profile: zero coverage failed_count >= 1");
  }

  // test_gene_profile_residual_geo_probe_rows_fail
  {
    const out = join(outRoot, "residual-geo");
    mkdirSync(out, { recursive: true });
    const row = validRow();
    row["gene_id_namespace"] = "geo_probe";
    row["gene_id"] = "AFFX-BioB-5";
    const primary = join(out, "primary.csv");
    writePrimary(primary, [row]);
    const result = await getValidationProfile("gene_expression.release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
      probeMappingSummaries: null,
    });
    check(issues, result.status === "failed", "profile: residual geo rows fail");
    const report = loadReport(out);
    const checks = (report["checks"] as Array<Record<string, unknown>>) ?? [];
    const coverage = checks.find((c) => c["check_id"] === "probe_coverage_required_gene_level");
    check(issues, coverage !== undefined && coverage["passed"] === false, "profile: residual geo coverage check failed");
  }

  // test_gene_profile_no_probes_passes
  {
    const out = join(outRoot, "no-probes");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await getValidationProfile("gene_expression.release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
      probeMappingSummaries: null,
    });
    check(issues, result.status === "passed", "profile: no probes passes");
    check(issues, result.failed_count === 0, "profile: no probes failed_count 0");
  }

  // test_probe_profile_zero_coverage_passes_with_warning
  {
    const out = join(outRoot, "probe-warning");
    mkdirSync(out, { recursive: true });
    const primary = join(out, "primary.csv");
    writePrimary(primary, [validRow()]);
    const result = await getValidationProfile("gene_expression.probe_release.v1").validate({
      manifest: manifest(1),
      primaryPath: primary,
      schema: buildGeneExpressionSchema(),
      manifestDigest: "d".repeat(64),
      outputDir: out,
      probeMappingSummaries: [probeSummary({ total: 10, mapped: 0, unmapped: 10, status: "unmapped" })],
    });
    check(issues, result.status === "passed", "profile: probe zero coverage passes with warning");
    check(issues, result.failed_count === 0, "profile: probe warning failed_count 0");
    const report = loadReport(out);
    const warnings = (report["warnings"] as Array<Record<string, string>>) ?? [];
    check(issues, warnings.some((w) => w["check_id"] === "probe_coverage"), "profile: probe warning present");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// A7 bounded scan row/field/column length limits
// ---------------------------------------------------------------------------

export async function checkRowBounds(): Promise<string[]> {
  const issues: string[] = [];
  const outRoot = scratchOutputRoot("row-bounds-");
  const profile = getValidationProfile("gene_expression.release.v1");

  // the bounded reader throws DelimitedBoundsError on an oversized row/field
  {
    const dir = join(outRoot, "reader");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rows.csv");
    writeFileSync(path, "a,b\n1,2\n" + "x".repeat(1024) + ",y\n", "utf8");
    let threw = false;
    try {
      const reader = delimitedRowsFromFileAsync(path, ",", null, { maxRowChars: 64, maxFieldChars: 32, maxRowFields: 16 })[Symbol.asyncIterator]();
      let pending = true;
      while (pending) {
        pending = !(await reader.next()).done;
      }
    } catch (error) {
      threw = error instanceof DelimitedBoundsError;
    }
    check(issues, threw, "row bounds: oversized row throws DelimitedBoundsError");
  }

  // an oversized primary row must surface as a failing check, never a crash
  {
    const dir = join(outRoot, "profile");
    mkdirSync(dir, { recursive: true });
    const primary = join(dir, "primary.csv");
    writeFileSync(primary, csvLine(CANONICAL_HEADER) + "x".repeat(8 * 1024 * 1024 + 1) + "\n", "utf8");
    let result: { status: string };
    try {
      result = await profile.validate({
        manifest: manifest(1),
        primaryPath: primary,
        schema: buildGeneExpressionSchema(),
        manifestDigest: "d".repeat(64),
        outputDir: dir,
      });
    } catch (error) {
      check(issues, false, `row bounds: validate must not throw (${error instanceof Error ? error.message : String(error)})`);
      return issues;
    }
    check(issues, result.status === "failed", "row bounds: oversized primary fails validation");
    const reportText = readFileSync(join(dir, "validation_report.json"), "utf8");
    check(issues, reportText.includes("row_or_field_length_bound"), "row bounds: report names row_or_field_length_bound");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// SpecValidator (test_spec_validator.py)
// ---------------------------------------------------------------------------

function specBase(): Record<string, unknown> {
  return {
    build_id: "build_test",
    objective: "compare TP53 expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [
      {
        binding_id: "binding_gdc",
        source: "gdc",
        acquisition: { mode: "builtin", provider_id: "gdc.files.v1" },
        adapter_id: "gdc.expression.star_counts.v1",
        accession: "TCGA-COAD",
      },
    ],
    validation_profile_ref: "gene_expression.release.v1",
  };
}

function spec(overrides: Record<string, unknown> = {}): DatasetBuildSpec {
  return parseDatasetBuildSpec({ ...specBase(), ...overrides });
}

function geoBinding(parameters: Record<string, unknown>): Record<string, unknown> {
  return {
    binding_id: "binding_geo",
    source: "geo",
    acquisition: { mode: "builtin", provider_id: "geo.files.v1" },
    adapter_id: "geo.expression.v1",
    parameters,
  };
}

function geoSpec(overrides: Record<string, unknown> = {}): DatasetBuildSpec {
  return parseDatasetBuildSpec({
    ...specBase(),
    source_bindings: [geoBinding({})],
    ...overrides,
  });
}

function geneOnlyRegistry(): SchemaRegistry {
  return new SchemaRegistry([buildGeneExpressionSchema()]);
}

function dualRegistry(): SchemaRegistry {
  return new SchemaRegistry([buildGeneExpressionSchema(), buildProbeExpressionSchema()]);
}

export function checkSpecValidatorParity(): string[] {
  const issues: string[] = [];
  const geneAllowlist = ["gene_expression.release.v1"];
  const dualAllowlist = ["gene_expression.release.v1", "gene_expression.probe_release.v1"];

  // test_valid_spec_passes
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(spec());
    check(issues, result.valid === true, "spec: valid passes");
    checkDeepEqual(issues, result.reason_codes, [], "spec: valid reason codes empty");
  }

  // test_empty_allowlist_rejects_every_profile
  {
    const result = new SpecValidator(geneOnlyRegistry()).validate(spec());
    check(issues, result.valid === false, "spec: empty allowlist rejects");
    check(issues, result.reason_codes.includes("profile_not_allowed"), "spec: empty allowlist profile_not_allowed");
  }

  // test_unknown_schema_rejected
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(spec({ schema_ref: "missing.v1" }));
    check(issues, result.valid === false, "spec: unknown schema rejected");
    check(issues, result.reason_codes.includes("unknown_schema"), "spec: unknown_schema code");
  }

  // test_family_mismatch_rejected
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(spec({ dataset_family: "pathway_member" }));
    check(issues, result.valid === false, "spec: family mismatch rejected");
    check(issues, result.reason_codes.includes("family_mismatch"), "spec: family_mismatch code");
  }

  // test_unknown_required_field_rejected
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(spec({ required_fields: ["no_such_field"] }));
    check(issues, result.valid === false, "spec: unknown required field rejected");
    check(issues, result.reason_codes.includes("unknown_required_field"), "spec: unknown_required_field code");
  }

  // test_profile_not_on_allowlist_rejected
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(spec({ validation_profile_ref: "other.profile.v1" }));
    check(issues, result.valid === false, "spec: profile not allowed rejected");
    check(issues, result.reason_codes.includes("profile_not_allowed"), "spec: profile_not_allowed code");
  }

  // test_multiple_failures_are_aggregated
  {
    const result = new SpecValidator(geneOnlyRegistry(), geneAllowlist).validate(
      spec({ dataset_family: "pathway_member", required_fields: ["no_such_field"] }),
    );
    check(issues, result.valid === false, "spec: multiple failures aggregated");
    check(issues, result.reason_codes.includes("family_mismatch") && result.reason_codes.includes("unknown_required_field"), "spec: aggregated codes");
  }

  // test_probe_schema_selectable_with_matching_entity_level
  {
    const result = new SpecValidator(dualRegistry(), dualAllowlist).validate(
      spec({
        schema_ref: "gene_expression.probe_long.v1",
        row_granularity: "probe_sample_measurement",
        validation_profile_ref: "gene_expression.probe_release.v1",
        target_entity_level: "probe",
      }),
    );
    check(issues, result.valid === true, "spec: probe schema selectable");
    checkDeepEqual(issues, result.reason_codes, [], "spec: probe schema reason codes");
  }

  // test_entity_level_mismatch_with_schema_rejected
  {
    const validator = new SpecValidator(dualRegistry(), geneAllowlist);
    const geneResult = validator.validate(spec({ schema_ref: "gene_expression.long.v1", target_entity_level: "probe" }));
    check(issues, geneResult.valid === false && geneResult.reason_codes.includes("entity_level_schema_mismatch"), "spec: probe build on gene schema rejected");
    const probeResult = validator.validate(
      spec({
        schema_ref: "gene_expression.probe_long.v1",
        row_granularity: "probe_sample_measurement",
        target_entity_level: "gene",
      }),
    );
    check(issues, probeResult.valid === false && probeResult.reason_codes.includes("entity_level_schema_mismatch"), "spec: gene build on probe schema rejected");
  }

  // test_unset_target_entity_level_derives_from_profile
  {
    const validator = new SpecValidator(dualRegistry(), dualAllowlist);
    check(issues, validator.validate(spec()).valid === true, "spec: gene profile + gene schema consistent");
    check(
      issues,
      validator.validate(
        spec({
          schema_ref: "gene_expression.probe_long.v1",
          row_granularity: "probe_sample_measurement",
          validation_profile_ref: "gene_expression.probe_release.v1",
        }),
      ).valid === true,
      "spec: probe profile + probe schema consistent",
    );
    const geneOnProbe = validator.validate(
      spec({ schema_ref: "gene_expression.probe_long.v1", row_granularity: "probe_sample_measurement" }),
    );
    check(issues, geneOnProbe.valid === false && geneOnProbe.reason_codes.includes("entity_level_schema_mismatch"), "spec: gene profile on probe schema inconsistent");
    const probeOnGene = validator.validate(spec({ validation_profile_ref: "gene_expression.probe_release.v1" }));
    check(issues, probeOnGene.valid === false && probeOnGene.reason_codes.includes("entity_level_schema_mismatch"), "spec: probe profile on gene schema inconsistent");
  }

  // test_gene_build_with_probe_profile_rejected
  {
    const result = new SpecValidator(dualRegistry(), dualAllowlist).validate(
      spec({ validation_profile_ref: "gene_expression.probe_release.v1", target_entity_level: "gene" }),
    );
    check(issues, result.valid === false && result.reason_codes.includes("entity_level_profile_mismatch"), "spec: gene build with probe profile rejected");
  }

  // test_probe_build_with_gene_profile_rejected
  {
    const result = new SpecValidator(dualRegistry(), dualAllowlist).validate(
      spec({
        schema_ref: "gene_expression.probe_long.v1",
        row_granularity: "probe_sample_measurement",
        validation_profile_ref: "gene_expression.release.v1",
        target_entity_level: "probe",
      }),
    );
    check(issues, result.valid === false && result.reason_codes.includes("entity_level_profile_mismatch"), "spec: probe build with gene profile rejected");
  }

  // GEO binding adapter-parameter rules (Phase 5 D1)
  {
    const validator = new SpecValidator(dualRegistry(), geneAllowlist);
    const validParams = {
      format: "series_matrix",
      value_semantics: "normalized_expression",
      value_scale: "log2",
      expression_unit: "log2_expression",
    };
    check(issues, validator.validate(geoSpec({ source_bindings: [geoBinding(validParams)] })).valid === true, "spec: geo valid params pass");
    check(issues, validator.validate(geoSpec()).valid === false, "spec: geo missing params rejected");
    check(issues, validator.validate(geoSpec({ source_bindings: [geoBinding({})] })).reason_codes.includes("invalid_adapter_parameters"), "spec: geo missing params code");
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, expression_unit: "bogus_unit" })] })).reason_codes.includes("unknown_unit"),
      "spec: geo unknown unit rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, value_semantics: "not_a_real_semantics" })] })).reason_codes.includes("unknown_semantics"),
      "spec: geo unknown semantics rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, format: "bogus_format" })] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: geo unknown format rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, delimiter: ";" })] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: geo inapplicable delimiter rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, smuggled_threshold: 0.5 })] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: geo unknown field rejected",
    );
    check(
      issues,
      validator.validate(spec({ source_bindings: [{ ...(specBase().source_bindings as Record<string, unknown>[])[0], parameters: { format: "series_matrix" } }] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: non-geo binding params rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, coverage_threshold: 0.8 })] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: coverage threshold smuggled rejected",
    );
    check(
      issues,
      validator.validate(geoSpec({ source_bindings: [geoBinding({ ...validParams, required_entity_level: "gene" })] })).reason_codes.includes("invalid_adapter_parameters"),
      "spec: entity policy smuggled rejected",
    );
  }

  return issues;
}

function checkDeepEqual(issues: string[], actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    issues.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
