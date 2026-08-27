/**
 * Phase 4 step 5 (canonicalization) parity checks: namespace authorization
 * rules, measurement identities, the gene symbol map, and fixture-driven GDC /
 * Xena canonicalization runs (mirror ``backend/tests/test_dataset_canonicalizer.py``).
 * Vitest-free so the same checks run under vitest and as a plain Node script.
 *
 * The GEO-adapter scenarios in the Python suite are substituted with
 * hand-built source-long batches (the GEO adapter itself is Phase 5 work);
 * the declared-namespace, probe-schema and probe-map paths are exercised
 * directly against the canonicalizer.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { deepEqual } from "./contract-parity.js";
import type {
  DataBatch,
  NormalizationProfile,
  SourceAsset,
} from "../src/dataset/contracts/index.js";
import {
  parseDataBatch,
  parseNormalizationProfile,
  parseSourceAsset,
} from "../src/dataset/contracts/index.js";
import {
  SOURCE_LONG_COLUMNS,
  assetIdFromSha256,
  getAdapter,
  makeRecordId,
} from "../src/dataset/adapters/index.js";
import { csvLine, delimitedRowsWithLines, readSourceText } from "../src/dataset/adapters/index.js";
import type { DatasetSchema } from "../src/dataset/contracts/index.js";
import {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
} from "../src/dataset/schema/index.js";
import {
  MeasurementIdentity,
  SYMBOL_TO_ENSEMBL,
  authorizeNamespace,
  canonicalize,
  expressionNormalizationV1,
  resolveEnsemblToSymbol,
  resolveSymbolToEnsembl,
  validateGeneMap,
} from "../src/dataset/canonicalizer/index.js";
import type { CanonicalizationResult } from "../src/dataset/canonicalizer/index.js";

type ErrorClass = new (message?: string) => Error;

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

function checkDeepEqual(issues: string[], actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    issues.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkThrows(
  issues: string[],
  name: string,
  fn: () => unknown,
  messagePattern?: RegExp,
  errorType?: ErrorClass,
): void {
  try {
    fn();
    issues.push(`${name}: expected an error but none was thrown`);
  } catch (error) {
    const actual = error as Error;
    if (errorType !== undefined && !(error instanceof errorType)) {
      issues.push(`${name}: expected ${errorType.name}, got ${String(error)}`);
    } else if (messagePattern !== undefined && !messagePattern.test(actual.message)) {
      issues.push(
        `${name}: message '${actual.message}' does not match ${messagePattern}`,
      );
    }
  }
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
function sourceAssetFromPath(path: string, sourceId = "src_test"): SourceAsset {
  const bytes = readFileSync(path);
  const checksum = sha256Hex(bytes);
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${checksum}`,
    kind: "source",
    relative_path: `source_assets/${basename(path)}`,
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

/** Write an input fixture, creating its parent directory (Python tmp_path). */
function writeFixtureFile(
  path: string,
  content: string | Buffer,
  encoding?: BufferEncoding,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, encoding);
}

interface CsvTable {
  header: string[];
  rows: Record<string, string>[];
}

function readCsvTable(path: string): CsvTable {
  const text = readSourceText(path);
  const lines = delimitedRowsWithLines(text, ",");
  const header = lines[0]?.values ?? [];
  const rows = lines.slice(1).map(({ values }) => {
    const row: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]] = values[index] ?? "";
    }
    return row;
  });
  return { header, rows };
}

function writeCsvTable(path: string, table: CsvTable): void {
  const lines = [csvLine(table.header)];
  for (const row of table.rows) {
    lines.push(csvLine(table.header.map((column) => row[column] ?? "")));
  }
  writeFixtureFile(path, lines.join(""));
}

/** Default source-long row values (mirrors the adapters' longRow). */
function sourceLongRow(overrides: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = {
    record_id: "",
    dataset_id: "build_test",
    source_id: "src_test",
    asset_id: "asset_unknown",
    gene_id_raw: "",
    gene_id_namespace_declared: "",
    sample_id: "",
    measurement_type: "gene_expression",
    value_semantics: "expression_value",
    value_scale: "linear",
    is_normalized: "false",
    is_integer_expected: "false",
    expression_value: "",
    expression_unit: "expression_value",
    source_logical_file: "synthetic.csv",
    source_line_number: "2",
    source_column_index: "1",
    source_column_name: "S1",
    source_raw_value: "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    values[key] = value;
  }
  return values;
}

/** Build a DataBatch whose file asset points at a written source-long CSV. */
function batchForLongCsv(
  outputDir: string,
  fileName: string,
  rows: Record<string, string>[],
  statistics: Record<string, unknown> = {},
): DataBatch {
  const table: CsvTable = { header: [...SOURCE_LONG_COLUMNS], rows };
  const path = join(outputDir, "source_assets", fileName);
  writeCsvTable(path, table);
  const checksum = sha256Hex(readFileSync(path));
  return parseDataBatch({
    schema_version: "1.0",
    batch_id: "batch_binding_1",
    binding_id: "binding_1",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    file_asset: {
      schema_version: "1.0",
      asset_id: assetIdFromSha256(checksum),
      kind: "parsed",
      relative_path: `source_assets/${fileName}`,
      sha256: checksum,
      size_bytes: readFileSync(path).length,
      media_type: "text/csv",
      generated_by_step_id: "step_test",
    },
    row_count: rows.length,
    column_count: SOURCE_LONG_COLUMNS.length,
    parser_id: "test.long.v1",
    parser_version: "1.0.0",
    statistics,
    warnings: [],
    declared_mappings: [],
  });
}

function parseAdapterBatch(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  outputDir: string;
}): Promise<DataBatch> {
  const adapter = getAdapter(options.adapterId);
  const asset = sourceAssetFromFixture(options.fixturesRoot, options.fixture);
  return adapter.parse(asset, join(options.fixturesRoot, options.fixture), {
    requirementId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: options.outputDir,
  });
}
async function runCanonicalize(options: {
  batch: DataBatch;
  outputDir: string;
  schema?: DatasetSchema;
  profile?: NormalizationProfile;
  geneSymbolMap?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  probeMap?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  probeTargetNamespace?: string;
}): Promise<CanonicalizationResult> {
  return canonicalize({
    batch: options.batch,
    schema: options.schema ?? buildGeneExpressionSchema(),
    profile: options.profile ?? expressionNormalizationV1(),
    outputDir: options.outputDir,
    geneSymbolMap: options.geneSymbolMap,
    probeMap: options.probeMap,
    probeTargetNamespace: options.probeTargetNamespace,
  });
}

/** Remap parsed long rows into a new source CSV and return the new batch. */
function remapBatchRows(options: {
  batch: DataBatch;
  outputDir: string;
  fileName: string;
  remap: (row: Record<string, string>) => Record<string, string>;
}): DataBatch {
  if (options.batch.file_asset === null) {
    throw new Error("batch has no file asset");
  }
  const table = readCsvTable(
    join(options.outputDir, options.batch.file_asset.relative_path),
  );
  const remapped: CsvTable = {
    header: table.header,
    rows: table.rows.map((row) => options.remap({ ...row })),
  };
  const path = join(options.outputDir, "source_assets", options.fileName);
  writeCsvTable(path, remapped);
  const checksum = sha256Hex(readFileSync(path));
  const asset = options.batch.file_asset;
  return parseDataBatch({
    schema_version: "1.0",
    batch_id: options.batch.batch_id,
    binding_id: options.batch.binding_id,
    dataset_family: options.batch.dataset_family,
    row_granularity: options.batch.row_granularity,
    schema_ref: options.batch.schema_ref,
    file_asset: {
      schema_version: "1.0",
      asset_id: assetIdFromSha256(checksum),
      kind: asset.kind,
      relative_path: `source_assets/${options.fileName}`,
      sha256: checksum,
      size_bytes: readFileSync(path).length,
      media_type: asset.media_type,
      generated_by_step_id: asset.generated_by_step_id,
    },
    row_count: options.batch.row_count,
    column_count: options.batch.column_count,
    parser_id: options.batch.parser_id,
    parser_version: options.batch.parser_version,
    statistics: { ...options.batch.statistics },
    warnings: options.batch.warnings,
    declared_mappings: options.batch.declared_mappings,
  });
}

export function scratchOutputRoot(prefix = "canonicalizer-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function testNormalizationProfile(options: {
  profile_id: string;
  allowed_namespaces: string[];
  allowed_units: string[];
  allowed_semantics: string[];
  allowed_value_scales: string[];
}): NormalizationProfile {
  return parseNormalizationProfile({
    schema_version: "1.0",
    profile_id: options.profile_id,
    dataset_family: "gene_expression",
    allowed_namespaces: options.allowed_namespaces,
    allowed_units: options.allowed_units,
    allowed_semantics: options.allowed_semantics,
    allowed_value_scales: options.allowed_value_scales,
    unit_conversions: [],
    aggregation_policy: "keep_all",
    description: "test profile",
  });
}
/** authorize_namespace rules + MeasurementIdentity + gene map invariants. */
export function checkCanonicalizerContractParity(): string[] {
  const issues: string[] = [];

  // test_authorize_namespace_rules.
  checkDeepEqual(
    issues,
    authorizeNamespace("ENSG00000141510"),
    ["ENSG00000141510", "ensembl_gene", ""],
    "ENSG without version",
  );
  checkDeepEqual(
    issues,
    authorizeNamespace("ENSG00000141510.17"),
    ["ENSG00000141510", "ensembl_gene", "17"],
    "ENSG with version",
  );
  checkDeepEqual(issues, authorizeNamespace("TP53"), ["TP53", "gene_symbol", ""], "symbol TP53");
  checkDeepEqual(issues, authorizeNamespace("BRCA1"), ["BRCA1", "gene_symbol", ""], "symbol BRCA1");
  check(issues, authorizeNamespace("1007_s_at") === null, "probe id must stay unauthorized");
  check(issues, authorizeNamespace("") === null, "empty id must stay unauthorized");

  // test_probe_id_misclassified_by_symbol_regex_is_regression_target.
  check(issues, authorizeNamespace("AFFX-BioB-5") === null, "AFFX control probe unauthorized");
  check(issues, authorizeNamespace("1007_s_at") === null, "1007_s_at probe unauthorized");

  // Declared-namespace paths (test_canonicalizer_consumes_declared_namespace).
  checkDeepEqual(
    issues,
    authorizeNamespace("AFFX-BioB-5", "geo_probe"),
    ["AFFX-BioB-5", "geo_probe", ""],
    "declared geo_probe",
  );
  checkDeepEqual(
    issues,
    authorizeNamespace("ENSG00000141510", "ensembl_gene"),
    ["ENSG00000141510", "ensembl_gene", ""],
    "declared ensembl_gene",
  );
  checkDeepEqual(
    issues,
    authorizeNamespace("TP53", "gene_symbol"),
    ["TP53", "gene_symbol", ""],
    "declared gene_symbol",
  );
  check(issues, authorizeNamespace("TP53", "bogus") === null, "unknown declared namespace");

  // MeasurementIdentity serialize / deserialize / ordering (identity.py).
  const identity = new MeasurementIdentity("normalized_expression", "unknown", "log2_expression");
  checkDeepEqual(
    issues,
    identity.serialize(),
    ["normalized_expression", "unknown", "log2_expression"],
    "MeasurementIdentity.serialize",
  );
  const restored = MeasurementIdentity.deserialize(["normalized_expression", "log2", "log2_expression"]);
  check(issues, restored.value_scale === "log2", "MeasurementIdentity.deserialize scale");
  checkThrows(
    issues,
    "deserialize invalid scale rejected",
    () => MeasurementIdentity.deserialize(["normalized_expression", "raw_count", "x"]),
    /one of/,
  );
  const ordered = [
    new MeasurementIdentity("expression_value", "linear", "expression_value"),
    new MeasurementIdentity("normalized_expression", "log2", "log2_expression"),
    new MeasurementIdentity("expression_value", "log2", "expression_value"),
  ].sort((a, b) => a.compareTo(b));
  checkDeepEqual(
    issues,
    ordered.map((item) => item.serialize()[0]),
    ["expression_value", "expression_value", "normalized_expression"],
    "identity sort by semantics then scale",
  );

  // gene_maps.py invariants.
  checkDeepEqual(issues, validateGeneMap(), [], "gene map must be consistent");
  check(issues, resolveSymbolToEnsembl("TP53") === "ENSG00000141510", "TP53 -> ENSG");
  check(issues, resolveSymbolToEnsembl("MYH9") === undefined, "MYH9 unmapped");
  check(issues, resolveEnsemblToSymbol("ENSG00000141510") === "TP53", "ENSG -> TP53");
  check(issues, resolveEnsemblToSymbol("ENSG00000000003") === undefined, "unknown ENSG unmapped");
  check(
    issues,
    Object.keys(SYMBOL_TO_ENSEMBL).length === 20,
    "SYMBOL_TO_ENSEMBL mirrors the curated 20-entry table",
  );

  return issues;
}
/** Fixture-driven GDC/Xena canonicalization (test_dataset_canonicalizer.py). */
export async function checkCanonicalizerFixtureParity(options: {
  fixturesRoot: string;
  outputRoot: string;
}): Promise<string[]> {
  const issues: string[] = [];
  rmSync(options.outputRoot, { recursive: true, force: true });
  mkdirSync(options.outputRoot, { recursive: true });
  const fixtures = options.fixturesRoot;

  // test_canonical_matrix_rows.
  const matrixOut = join(options.outputRoot, "gdc_matrix");
  const matrixBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_expression.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: matrixOut,
  });
  const matrixResult = await runCanonicalize({ batch: matrixBatch, outputDir: matrixOut });
  check(issues, matrixResult.rowCount === 4, "matrix row_count 4");
  check(issues, matrixResult.rejectedCount === 0, "matrix rejected_count 0");
  checkDeepEqual(issues, matrixResult.namespaces, ["gene_symbol"], "matrix namespaces");
  const schemaColumns = buildGeneExpressionSchema().fields.map((field) => field.name);
  const matrixTable = readCsvTable(matrixResult.canonicalPath);
  checkDeepEqual(issues, matrixTable.header, schemaColumns, "matrix canonical header = schema fields");
  check(issues, matrixTable.rows.length === 4, "matrix canonical row count");
  check(issues, matrixTable.rows[0].gene_id === "TP53", "matrix gene_id TP53");
  check(issues, matrixTable.rows[0].gene_id_namespace === "gene_symbol", "matrix namespace gene_symbol");
  check(issues, matrixTable.rows[0].gene_id_version === "", "matrix version empty");
  check(issues, matrixTable.rows[0].gene_id_raw === "TP53", "matrix gene_id_raw TP53");
  check(issues, matrixTable.rows[0].source_sample_alias === "S1", "matrix alias S1");
  check(issues, matrixTable.rows[0].record_id.startsWith("rec_"), "matrix record_id prefix");

  // test_canonical_star_ensembl_normalization.
  const starOut = join(options.outputRoot, "gdc_star");
  const starBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_star_counts.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: starOut,
  });
  const starResult = await runCanonicalize({ batch: starBatch, outputDir: starOut });
  check(issues, starResult.rowCount === 2, "star row_count 2");
  check(issues, starResult.rejectedCount === 0, "star rejected_count 0");
  checkDeepEqual(issues, starResult.namespaces, ["ensembl_gene"], "star namespaces");
  const starTable = readCsvTable(starResult.canonicalPath);
  check(issues, starTable.rows[0].gene_id === "ENSG00000141510", "star gene_id ENSG");
  check(issues, starTable.rows[0].gene_id_namespace === "ensembl_gene", "star namespace ensembl_gene");
  check(issues, starTable.rows[0].gene_id_version === "17", "star version 17");
  check(issues, starTable.rows[0].source_sample_alias === "", "star alias empty");
  check(
    issues,
    starTable.rows[0].record_id ===
      makeRecordId("build_test", "ENSG00000141510.17", "gdc_star_counts"),
    "star record_id matches canonical digest",
  );
  const starLog = readFileSync(starResult.auditPaths[1], "utf8");
  check(issues, starLog.includes("ensembl_version_split"), "star log rule ensembl_version_split");
  check(issues, starLog.includes("ENSG00000141510"), "star log gene id");

  // test_canonical_rejected_rows_audit.
  const parseRejected = readFileSync(join(starOut, "batches", "binding_1_rejected.csv"), "utf8");
  check(issues, parseRejected.includes("__no_feature"), "parse rejected __no_feature");
  check(issues, parseRejected.includes("non_ensg_annotation_row"), "parse rejected annotation reason");
  const starRejected = readFileSync(starResult.auditPaths[0], "utf8");
  check(issues, !starRejected.includes("unauthorized_namespace"), "canonical rejected has no unauthorized rows");

  // test_field_mappings_audit_written.
  const mappingsLines = readFileSync(matrixResult.auditPaths[2], "utf8").split(/\r\n|\n/).filter((line) => line.length > 0);
  check(issues, mappingsLines.length === 6, "field mappings header + 5 rows");
  check(issues, mappingsLines[1].includes("adapter_declared"), "field mappings adapter_declared");

  // test_canonical_batch_metadata (Xena).
  const xenaOut = join(options.outputRoot, "xena");
  const xenaBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "ncbi/gse178352/xena_matrix.tsv",
    adapterId: "xena.matrix.v1",
    outputDir: xenaOut,
  });
  const xenaResult = await runCanonicalize({ batch: xenaBatch, outputDir: xenaOut });
  check(issues, xenaResult.batch.schema_ref === "gene_expression.long.v1", "xena schema_ref");
  check(issues, xenaResult.batch.row_count === 4, "xena row_count 4");
  check(issues, xenaResult.batch.column_count === schemaColumns.length, "xena column_count = 22");
  check(issues, xenaResult.batch.file_asset?.kind === "normalized", "xena file_asset kind normalized");
  checkDeepEqual(
    issues,
    xenaResult.batch.statistics.gene_id_namespaces,
    ["gene_symbol"],
    "xena gene_id_namespaces",
  );
  // test_canonical_is_deterministic.
  const detOut = join(options.outputRoot, "deterministic");
  const detBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_expression.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: detOut,
  });
  const first = await runCanonicalize({ batch: detBatch, outputDir: detOut });
  const second = await runCanonicalize({ batch: detBatch, outputDir: detOut });
  check(
    issues,
    deepEqual(readFileSync(first.canonicalPath), readFileSync(second.canonicalPath)),
    "deterministic canonical bytes",
  );
  check(
    issues,
    first.batch.file_asset?.sha256 === second.batch.file_asset?.sha256,
    "deterministic canonical sha256",
  );

  // test_unknown_unit_rejected.
  const restrictedProfile = testNormalizationProfile({
    profile_id: "gene_expression.normalization.restricted.v1",
    allowed_namespaces: expressionNormalizationV1().allowed_namespaces,
    allowed_units: ["expression_value"],
    allowed_semantics: expressionNormalizationV1().allowed_semantics,
    allowed_value_scales: expressionNormalizationV1().allowed_value_scales,
  });
  const restrictedOut = join(options.outputRoot, "restricted_unit");
  const restrictedBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_star_counts.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: restrictedOut,
  });
  const restrictedResult = await runCanonicalize({
    batch: restrictedBatch,
    outputDir: restrictedOut,
    profile: restrictedProfile,
  });
  check(issues, restrictedResult.rowCount === 0, "restricted unit row_count 0");
  check(issues, restrictedResult.rejectedCount === 2, "restricted unit rejected 2");
  check(
    issues,
    readFileSync(restrictedResult.auditPaths[0], "utf8").includes("unknown_unit"),
    "restricted unit reason code",
  );

  // test_gene_symbol_map_resolves_symbols_to_ensembl.
  const mapOut = join(options.outputRoot, "symbol_map");
  const mapBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_expression.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: mapOut,
  });
  const mapResult = await runCanonicalize({
    batch: mapBatch,
    outputDir: mapOut,
    geneSymbolMap: SYMBOL_TO_ENSEMBL,
  });
  check(issues, mapResult.rowCount === 4, "symbol map row_count 4");
  check(issues, mapResult.rejectedCount === 0, "symbol map rejected 0");
  checkDeepEqual(issues, mapResult.namespaces, ["ensembl_gene"], "symbol map namespaces");
  check(
    issues,
    mapResult.batch.statistics.gene_symbol_mapped_count === 4,
    "symbol map mapped_count 4",
  );
  const mapTable = readCsvTable(mapResult.canonicalPath);
  check(issues, mapTable.rows[0].gene_id === "ENSG00000141510", "symbol map TP53 -> ENSG");
  check(issues, mapTable.rows[0].gene_id_namespace === "ensembl_gene", "symbol map namespace");
  check(issues, mapTable.rows[0].gene_id_version === "", "symbol map version empty");
  const mapLog = readFileSync(mapResult.auditPaths[1], "utf8");
  check(issues, mapLog.includes("gene_symbol_map"), "symbol map log rule");
  check(issues, mapLog.includes("local gene symbol map"), "symbol map log evidence");

  // test_gene_symbol_map_keeps_unmapped_symbols.
  const partialOut = join(options.outputRoot, "symbol_partial");
  const partialPath = join(partialOut, "symbol_matrix.tsv");
  writeFixtureFile(partialPath, "gene_id\tS1\nTP53\t1.5\nMYH9\t2.5\n", "utf8");
  const partialAsset = sourceAssetFromPath(partialPath);
  const partialBatch = await getAdapter("gdc.expression.v1").parse(
    partialAsset,
    partialPath,
    {
      requirementId: "build_test",
      bindingId: "binding_1",
      schemaRef: "gene_expression.long.v1",
      outputDir: partialOut,
    },
  );
  const partialResult = await runCanonicalize({
    batch: partialBatch,
    outputDir: partialOut,
    geneSymbolMap: SYMBOL_TO_ENSEMBL,
  });
  check(issues, partialResult.rowCount === 2, "partial map row_count 2");
  check(issues, partialResult.rejectedCount === 0, "partial map rejected 0");
  checkDeepEqual(
    issues,
    partialResult.namespaces,
    ["ensembl_gene", "gene_symbol"],
    "partial map namespaces",
  );
  check(
    issues,
    partialResult.batch.statistics.gene_symbol_mapped_count === 1,
    "partial map mapped_count 1",
  );
  const partialTable = readCsvTable(partialResult.canonicalPath);
  const byId = new Map(partialTable.rows.map((row) => [row.gene_id_raw, row]));
  check(issues, byId.get("TP53")?.gene_id_namespace === "ensembl_gene", "TP53 mapped to ensembl_gene");
  check(issues, byId.get("MYH9")?.gene_id_namespace === "gene_symbol", "MYH9 stays gene_symbol");
  check(issues, byId.get("MYH9")?.gene_id === "MYH9", "MYH9 never dropped");
  // test_multi_unit_batch_detected_as_inconsistency.
  const multiOut = join(options.outputRoot, "multi_unit");
  const multiPath = join(multiOut, "mixed_unit_matrix.tsv");
  writeFixtureFile(
    multiPath,
    "gene_id\tS1\tS2\nTP53\t1.5\t2.5\nBRCA1\t3.5\t4.5\n",
    "utf8",
  );
  const multiAsset = sourceAssetFromPath(multiPath);
  const multiBatch = await getAdapter("gdc.expression.v1").parse(multiAsset, multiPath, {
    requirementId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: multiOut,
  });
  const mixedBatch = remapBatchRows({
    batch: multiBatch,
    outputDir: multiOut,
    fileName: "mixed_parsed.tsv",
    remap: (row) => {
      if (row.sample_id === "S2") row.expression_unit = "unstranded";
      return row;
    },
  });
  const mixedProfile = testNormalizationProfile({
    profile_id: "gene_expression.normalization.mixed.v1",
    allowed_namespaces: expressionNormalizationV1().allowed_namespaces,
    allowed_units: ["tpm_unstranded", "unstranded", "expression_value"],
    allowed_semantics: expressionNormalizationV1().allowed_semantics,
    allowed_value_scales: expressionNormalizationV1().allowed_value_scales,
  });
  const multiResult = await runCanonicalize({
    batch: mixedBatch,
    outputDir: multiOut,
    profile: mixedProfile,
  });
  check(issues, multiResult.rowCount === 4, "multi-unit row_count 4");
  check(issues, multiResult.rejectedCount === 0, "multi-unit rejected 0");
  check(
    issues,
    multiResult.batch.statistics.unit_inconsistency_detected === true,
    "multi-unit inconsistency detected",
  );
  check(
    issues,
    multiResult.batch.warnings.some((warning) => warning.includes("multiple expression units")),
    "multi-unit warning present",
  );
  checkDeepEqual(
    issues,
    [...(multiResult.batch.statistics.expression_units as string[])].sort(),
    ["expression_value", "unstranded"],
    "multi-unit expression_units",
  );

  // T4 scale scenarios (GEO-series substitutes via hand-built long rows).
  const scaleOut = join(options.outputRoot, "scale");
  const scaleBatch = batchForLongCsv(
    scaleOut,
    "geo_scale.tsv",
    [
      sourceLongRow({
        gene_id_raw: "ENSG00000141510",
        sample_id: "GSM1",
        value_semantics: "normalized_expression",
        value_scale: "unknown",
        expression_value: "5.0",
        expression_unit: "log2_expression",
      }),
      sourceLongRow({
        gene_id_raw: "ENSG00000141510",
        sample_id: "GSM2",
        value_semantics: "normalized_expression",
        value_scale: "unknown",
        expression_value: "6.0",
        expression_unit: "log2_expression",
      }),
    ],
    { format: "series_matrix", platform_ids: ["GPL570"] },
  );

  // test_scale_outside_allowlist_rejected.
  const restrictedScale = testNormalizationProfile({
    profile_id: "gene_expression.normalization.restricted_scale.v1",
    allowed_namespaces: ["ensembl_gene"],
    allowed_units: ["log2_expression"],
    allowed_semantics: ["normalized_expression"],
    allowed_value_scales: ["log2", "linear"],
  });
  const rejectedScale = await runCanonicalize({
    batch: scaleBatch,
    outputDir: scaleOut,
    profile: restrictedScale,
  });
  check(issues, rejectedScale.rowCount === 0, "scale outside allowlist row_count 0");
  check(issues, rejectedScale.rejectedCount === 2, "scale outside allowlist rejected 2");
  check(
    issues,
    readFileSync(rejectedScale.auditPaths[0], "utf8").includes("unknown_scale"),
    "scale outside allowlist reason code",
  );

  // test_unknown_scale_accepted_when_explicitly_allowed.
  const unknownOkProfile = testNormalizationProfile({
    profile_id: "gene_expression.normalization.unknown_ok.v1",
    allowed_namespaces: ["ensembl_gene"],
    allowed_units: ["log2_expression"],
    allowed_semantics: ["normalized_expression"],
    allowed_value_scales: ["log2", "unknown"],
  });
  const unknownOk = await runCanonicalize({
    batch: scaleBatch,
    outputDir: scaleOut,
    profile: unknownOkProfile,
  });
  check(issues, unknownOk.rowCount === 2, "unknown accepted row_count 2");
  check(issues, unknownOk.rejectedCount === 0, "unknown accepted rejected 0");
  checkDeepEqual(
    issues,
    unknownOk.batch.statistics.measurement_identities,
    [["normalized_expression", "unknown", "log2_expression"]],
    "unknown accepted measurement identities",
  );
  const unknownOkTable = readCsvTable(unknownOk.canonicalPath);
  check(
    issues,
    unknownOkTable.rows.every((row) => row.value_scale === "unknown"),
    "unknown scale preserved in canonical rows",
  );
  // test_raw_count_scale_declaration_rejected.
  const rawCountOut = join(options.outputRoot, "raw_count");
  const rawCountBatch = await parseAdapterBatch({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_expression.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: rawCountOut,
  });
  const remappedRawCount = remapBatchRows({
    batch: rawCountBatch,
    outputDir: rawCountOut,
    fileName: "raw_count_scale.tsv",
    remap: (row) => {
      row.value_scale = "raw_count";
      return row;
    },
  });
  const rawCountResult = await runCanonicalize({ batch: remappedRawCount, outputDir: rawCountOut });
  check(issues, rawCountResult.rowCount === 0, "raw_count scale row_count 0");
  check(issues, rawCountResult.rejectedCount === 4, "raw_count scale rejected 4");
  check(
    issues,
    readFileSync(rawCountResult.auditPaths[0], "utf8").includes("unknown_scale"),
    "raw_count scale reason code",
  );

  // Declared geo_probe under the gene schema (test_canonicalizer_consumes_declared_namespace).
  const declaredOut = join(options.outputRoot, "declared_geo");
  const declaredBatch = batchForLongCsv(
    declaredOut,
    "geo_series.tsv",
    [
      sourceLongRow({
        gene_id_raw: "AFFX-BioB-5",
        gene_id_namespace_declared: "geo_probe",
        sample_id: "GSM1",
        value_semantics: "normalized_expression",
        value_scale: "log2",
        expression_value: "1.5",
        expression_unit: "log2_expression",
      }),
      sourceLongRow({
        gene_id_raw: "ENSG00000141510",
        gene_id_namespace_declared: "ensembl_gene",
        sample_id: "GSM2",
        value_semantics: "normalized_expression",
        value_scale: "log2",
        expression_value: "6.0",
        expression_unit: "log2_expression",
      }),
    ],
    { format: "series_matrix", platform_ids: ["GPL570"] },
  );
  const declaredResult = await runCanonicalize({ batch: declaredBatch, outputDir: declaredOut });
  check(issues, declaredResult.rowCount === 2, "declared geo row_count 2");
  check(issues, declaredResult.rejectedCount === 0, "declared geo rejected 0");
  checkDeepEqual(
    issues,
    declaredResult.namespaces,
    ["ensembl_gene", "geo_probe"],
    "declared geo namespaces",
  );
  const declaredLog = readFileSync(declaredResult.auditPaths[1], "utf8");
  check(issues, declaredLog.includes("AFFX-BioB-5"), "declared geo log probe id");
  check(issues, declaredLog.includes("namespace_geo_probe"), "declared geo log rule");

  // Probe schema + probe->gene map (canonicalizer.py probe_schema branch).
  const probeOut = join(options.outputRoot, "probe_schema");
  const probeBatch = batchForLongCsv(
    probeOut,
    "probe_rows.tsv",
    [
      sourceLongRow({
        gene_id_raw: "AFFX-BioB-5",
        gene_id_namespace_declared: "geo_probe",
        sample_id: "GSM1",
        value_semantics: "normalized_expression",
        value_scale: "log2",
        expression_value: "1.5",
        expression_unit: "log2_expression",
        source_raw_value: "1.5",
      }),
      sourceLongRow({
        gene_id_raw: "1007_s_at",
        gene_id_namespace_declared: "geo_probe",
        sample_id: "GSM2",
        value_semantics: "normalized_expression",
        value_scale: "log2",
        expression_value: "2.0",
        expression_unit: "log2_expression",
        source_raw_value: "2.0",
      }),
    ],
    { format: "series_matrix", platform_ids: ["GPL570"] },
  );
  const probeResult = await runCanonicalize({
    batch: probeBatch,
    outputDir: probeOut,
    schema: buildProbeExpressionSchema(),
    probeMap: { "AFFX-BioB-5": "TP53" },
    probeTargetNamespace: "gene_symbol",
  });
  check(issues, probeResult.rowCount === 2, "probe schema row_count 2");
  check(issues, probeResult.rejectedCount === 0, "probe schema rejected 0");
  checkDeepEqual(
    issues,
    probeResult.namespaces,
    ["geo_probe"],
    "probe schema namespaces (D5 #2 all rows keep geo_probe)",
  );
  check(
    issues,
    probeResult.batch.statistics.probe_mapped_count === 1,
    "probe schema mapped_count 1",
  );
  const probeTable = readCsvTable(probeResult.canonicalPath);
  const probeByRaw = new Map(probeTable.rows.map((row) => [row.probe_id, row]));
  check(issues, probeByRaw.get("AFFX-BioB-5")?.gene_id_namespace === "geo_probe", "mapped probe keeps geo_probe");
  check(issues, probeByRaw.get("1007_s_at")?.gene_id_namespace === "geo_probe", "unmapped probe namespace");
  check(
    issues,
    probeTable.rows.every((row) => row.platform_id === "GPL570"),
    "probe schema platform_id",
  );
  check(
    issues,
    probeTable.rows.every((row) => row.value === row.source_raw_value),
    "probe schema value column",
  );
  const probeLog = readFileSync(probeResult.auditPaths[1], "utf8");
  check(issues, probeLog.includes("probe_gene_map"), "probe log rule");
  check(issues, probeLog.includes("GPL platform annotation"), "probe log evidence");

  return issues;
}