/**
 * Phase 4 step 7 (integrator) parity checks (mirror
 * ``backend/tests/test_dataset_integrator.py``).  The integrator appends
 * canonical sources into one primary dataset with deterministic dedup and
 * conflict auditing.  Vitest-free so the same checks run under vitest and as
 * a plain Node script.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataBatch, SourceAsset } from "../src/dataset/contracts/index.js";
import { parseSourceAsset } from "../src/dataset/contracts/index.js";
import { csvLine, getAdapter } from "../src/dataset/adapters/index.js";
import { buildGeneExpressionSchema } from "../src/dataset/schema/index.js";
import {
  canonicalize,
  expressionNormalizationV1,
} from "../src/dataset/canonicalizer/index.js";
import type { CanonicalizationResult } from "../src/dataset/canonicalizer/index.js";
import { IntegratorError, integrate } from "../src/dataset/integrator/index.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sourceAssetFromFixture(
  fixturesRoot: string,
  relativePath: string,
  sourceId = "src_test",
): SourceAsset {
  const bytes = readFileSync(join(fixturesRoot, relativePath));
  const checksum = sha256Hex(bytes);
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${checksum}`,
    kind: "source",
    relative_path: `source_assets/${relativePath}`,
    sha256: checksum,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: sourceId,
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

/** Python csv.DictReader: header row + per-row field dicts. */
function readCsvDictRows(path: string): Array<Record<string, string>> {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index]] = values[index] ?? "";
    }
    return record;
  });
}

function writeCsvDictRows(path: string, rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return;
  const header = Object.keys(rows[0]);
  const lines = [csvLine(header)];
  for (const row of rows) {
    lines.push(csvLine(header.map((column) => row[column] ?? "")));
  }
  writeFileSync(path, lines.join(""), "utf8");
}

function parseAdapterBatch(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  bindingId: string;
  outputDir: string;
}): DataBatch {
  const adapter = getAdapter(options.adapterId);
  const asset = sourceAssetFromFixture(options.fixturesRoot, options.fixture);
  return adapter.parse(asset, join(options.fixturesRoot, options.fixture), {
    buildId: "build_test",
    bindingId: options.bindingId,
    schemaRef: "gene_expression.long.v1",
    outputDir: options.outputDir,
  });
}

function canonical(
  options: {
    fixturesRoot: string;
    fixture: string;
    adapterId: string;
    bindingId: string;
    outputDir: string;
  },
): CanonicalizationResult {
  const batch = parseAdapterBatch(options);
  return canonicalize({
    batch,
    schema: buildGeneExpressionSchema(),
    profile: expressionNormalizationV1(),
    outputDir: options.outputDir,
  });
}

function integrateOptions(options: {
  outputDir: string;
  results: readonly CanonicalizationResult[];
  mergeStrategy?: string;
}) {
  return {
    results: options.results,
    mergeStrategy: options.mergeStrategy ?? "append_by_canonical_row",
    schema: buildGeneExpressionSchema(),
    buildId: "build_test",
    outputDir: options.outputDir,
  };
}

export function scratchOutputRoot(prefix = "integrator-parity-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

/** Mirror ``backend/tests/test_dataset_integrator.py``. */
export function checkIntegratorParity(options: {
  fixturesRoot: string;
  outputRoot: string;
}): string[] {
  const issues: string[] = [];
  const fixturesRoot = options.fixturesRoot;
  const outputRoot = options.outputRoot;

  // test_single_source_passthrough
  {
    const out = join(outputRoot, "single");
    mkdirSync(out, { recursive: true });
    const gdc = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_gdc",
      outputDir: out,
    });
    const result = integrate(integrateOptions({ outputDir: out, results: [gdc] }));
    check(issues, result.rowCount === 4, "single source: row_count must be 4");
    check(issues, result.dedupCount === 0, "single source: dedup_count must be 0");
    check(issues, result.conflictCount === 0, "single source: conflict_count must be 0");
    check(issues, result.batch.file_asset !== null && result.batch.file_asset.kind === "artifact", "single source: file asset kind must be artifact");
    check(issues, readCsvDictRows(result.mergedPath).length === 4, "single source: merged file must have 4 rows");
  }

  // test_mirror_duplicates_dedup
  {
    const out = join(outputRoot, "mirror");
    mkdirSync(out, { recursive: true });
    const a = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_a",
      outputDir: out,
    });
    const b = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_b",
      outputDir: out,
    });
    const result = integrate(integrateOptions({ outputDir: out, results: [a, b] }));
    check(issues, result.rowCount === 4, "mirror dedup: row_count must be 4");
    check(issues, result.dedupCount === 4, "mirror dedup: dedup_count must be 4");
    check(issues, result.conflictCount === 0, "mirror dedup: conflict_count must be 0");
    const stats = result.batch.statistics as Record<string, unknown>;
    check(issues, stats["dedup_count"] === 4, "mirror dedup: statistics.dedup_count must be 4");
  }

  // test_value_conflict_audited
  {
    const out = join(outputRoot, "conflict");
    mkdirSync(out, { recursive: true });
    const gdc = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_gdc",
      outputDir: out,
    });
    const xena = canonical({
      fixturesRoot,
      fixture: "ncbi/gse178352/xena_matrix.tsv",
      adapterId: "xena.matrix.v1",
      bindingId: "binding_xena",
      outputDir: out,
    });
    const result = integrate(integrateOptions({ outputDir: out, results: [gdc, xena] }));
    check(issues, result.rowCount === 4, "conflict audit: row_count must be 4");
    check(issues, result.dedupCount === 3, "conflict audit: dedup_count must be 3");
    check(issues, result.conflictCount === 1, "conflict audit: conflict_count must be 1");
    const conflicts = readCsvDictRows(result.conflictsPath ?? "");
    check(issues, conflicts.length === 1, "conflict audit: one conflict row");
    if (conflicts.length > 0) {
      check(issues, conflicts[0]["gene_id"] === "TP53", "conflict audit: gene_id must be TP53");
      check(issues, conflicts[0]["sample_id"] === "S2", "conflict audit: sample_id must be S2");
      check(issues, conflicts[0]["first_value"] === "2", "conflict audit: first_value must be 2");
      check(issues, conflicts[0]["second_value"] === "9.9", "conflict audit: second_value must be 9.9");
      check(issues, conflicts[0]["action"] === "kept_first_source", "conflict audit: action must be kept_first_source");
    }
    const merged = readCsvDictRows(result.mergedPath);
    const tp53s2 = merged.find((r) => r["gene_id"] === "TP53" && r["sample_id"] === "S2");
    check(issues, tp53s2 !== undefined && tp53s2["expression_value"] === "2", "conflict audit: merged TP53/S2 must keep first value 2");
  }

  // test_numeric_equivalent_values_dedup ("1.0" vs "1" are numerically equal)
  {
    const out = join(outputRoot, "numeric-equiv");
    mkdirSync(out, { recursive: true });
    const a = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_a",
      outputDir: out,
    });
    const b = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_b",
      outputDir: out,
    });
    const rows = readCsvDictRows(b.canonicalPath);
    for (const row of rows) {
      if (row["gene_id"] === "TP53" && row["sample_id"] === "S1") {
        row["expression_value"] = "1.50";
      }
    }
    writeCsvDictRows(b.canonicalPath, rows);
    const result = integrate(integrateOptions({ outputDir: out, results: [a, b] }));
    check(issues, result.dedupCount === 4, "numeric equiv: dedup_count must be 4");
    check(issues, result.conflictCount === 0, "numeric equiv: conflict_count must be 0");
  }

  // test_measurement_type_is_part_of_identity
  {
    const out = join(outputRoot, "identity");
    mkdirSync(out, { recursive: true });
    const a = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_a",
      outputDir: out,
    });
    const b = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_b",
      outputDir: out,
    });
    const rows = readCsvDictRows(b.canonicalPath);
    for (const row of rows) {
      row["measurement_type"] = "alternate_measurement";
    }
    writeCsvDictRows(b.canonicalPath, rows);
    const result = integrate(integrateOptions({ outputDir: out, results: [a, b] }));
    check(issues, result.rowCount === 8, "identity: row_count must be 8");
    check(issues, result.dedupCount === 0, "identity: dedup_count must be 0");
  }

  // test_nan_mirror_rows_dedup_not_conflict
  {
    const out = join(outputRoot, "nan");
    mkdirSync(out, { recursive: true });
    const a = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_a",
      outputDir: out,
    });
    const b = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_b",
      outputDir: out,
    });
    const rowsA = readCsvDictRows(a.canonicalPath);
    const rowsB = readCsvDictRows(b.canonicalPath);
    for (const row of rowsB) {
      if (row["gene_id"] === "TP53" && row["sample_id"] === "S1") {
        row["expression_value"] = "nan";
      }
    }
    for (const row of rowsA) {
      if (row["gene_id"] === "TP53" && row["sample_id"] === "S1") {
        row["expression_value"] = "nan";
      }
    }
    writeCsvDictRows(a.canonicalPath, rowsA);
    writeCsvDictRows(b.canonicalPath, rowsB);
    const result = integrate(integrateOptions({ outputDir: out, results: [a, b] }));
    check(issues, result.dedupCount === 4, "nan mirror: dedup_count must be 4");
    check(issues, result.conflictCount === 0, "nan mirror: conflict_count must be 0");
  }

  // test_unsupported_merge_strategy_rejected
  {
    const out = join(outputRoot, "strategy");
    mkdirSync(out, { recursive: true });
    const gdc = canonical({
      fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_gdc",
      outputDir: out,
    });
    let threw = false;
    try {
      integrate(integrateOptions({ outputDir: out, results: [gdc], mergeStrategy: "agent_injected_strategy" }));
    } catch (error) {
      threw = error instanceof IntegratorError && /unsupported merge strategy/.test(String(error.message));
    }
    check(issues, threw, "unsupported merge strategy must raise IntegratorError");
  }

  // test_zero_sources_rejected
  {
    const out = join(outputRoot, "zero");
    mkdirSync(out, { recursive: true });
    let threw = false;
    try {
      integrate(integrateOptions({ outputDir: out, results: [] }));
    } catch (error) {
      threw = error instanceof IntegratorError && /zero sources/.test(String(error.message));
    }
    check(issues, threw, "zero sources must raise IntegratorError");
  }

  return issues;
}
