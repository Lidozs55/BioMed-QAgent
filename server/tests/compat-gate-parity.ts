/**
 * Phase 4 step 6 (compatibility gate) parity checks (mirror
 * ``backend/tests/test_dataset_compat_gate.py``).  The gate decides whether
 * canonicalized sources may be merged into one primary dataset.  Vitest-free
 * so the same checks run under vitest and as a plain Node script.
 *
 * The GEO-adapter probe scenarios are exercised through the probe-schema
 * canonicalizer path (hand-built source-long batches) instead of the Python
 * ``GeoExpressionAdapter``; the per-rule assertions match the Python suite.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { deepEqual } from "./contract-parity.js";
import type {
  DataBatch,
  DatasetBuildSpec,
  FieldMapping,
  SourceAsset,
} from "../src/dataset/contracts/index.js";
import {
  parseDataBatch,
  parseDatasetBuildSpec,
  parseFieldMapping,
  parseSourceAsset,
} from "../src/dataset/contracts/index.js";
import {
  SOURCE_LONG_COLUMNS,
  assetIdFromSha256,
  getAdapter,
} from "../src/dataset/adapters/index.js";
import { csvLine } from "../src/dataset/adapters/index.js";
import {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
} from "../src/dataset/schema/index.js";
import {
  canonicalize,
  expressionNormalizationV1,
} from "../src/dataset/canonicalizer/index.js";
import type { CanonicalizationResult } from "../src/dataset/canonicalizer/index.js";
import { checkExpressionCompatibility } from "../src/dataset/compat/index.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

function checkDeepEqual(issues: string[], actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    issues.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

/** Write an input fixture, creating its parent directory (Python tmp_path). */
function writeFixtureFile(
  path: string,
  content: string | Buffer,
  encoding?: BufferEncoding,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, encoding);
}

function writeCsvTable(path: string, table: { header: string[]; rows: Record<string, string>[] }): void {
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
    source_id: "src_geo",
    asset_id: "asset_unknown",
    gene_id_raw: "",
    gene_id_namespace_declared: "",
    sample_id: "",
    measurement_type: "gene_expression",
    value_semantics: "normalized_expression",
    value_scale: "log2",
    is_normalized: "true",
    is_integer_expected: "false",
    expression_value: "",
    expression_unit: "log2_expression",
    source_logical_file: "synthetic.csv",
    source_line_number: "2",
    source_column_index: "1",
    source_column_name: "GSM1",
    source_raw_value: "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    values[key] = value;
  }
  return values;
}

function formalMapping(overrides: Partial<Record<string, unknown>> = {}): FieldMapping {
  return parseFieldMapping({
    schema_version: "1.0",
    mapping_id: "map_binding_geo_probe",
    source_schema_ref: "binding_binding_geo.source",
    target_schema_ref: "gene_expression.probe_long.v1",
    source_field: "ID_REF",
    target_field: "probe_id",
    transform: "identity",
    mapping_method: "adapter_declared",
    confidence_level: "high",
    evidence: "GEO series matrix ID_REF column",
    review_status: "accepted",
    ...overrides,
  });
}

/** Build a DataBatch whose file asset points at a written source-long CSV. */
function batchForLongCsv(options: {
  outputDir: string;
  fileName: string;
  rows: Record<string, string>[];
  statistics?: Record<string, unknown>;
  schemaRef?: string;
  rowGranularity?: string;
  mappings?: FieldMapping[];
}): DataBatch {
  const schemaRef = options.schemaRef ?? "gene_expression.long.v1";
  const rowGranularity = options.rowGranularity ?? "gene_sample_measurement";
  const table = { header: [...SOURCE_LONG_COLUMNS], rows: options.rows };
  const path = join(options.outputDir, "source_assets", options.fileName);
  writeCsvTable(path, table);
  const checksum = sha256Hex(readFileSync(path));
  return parseDataBatch({
    schema_version: "1.0",
    batch_id: "batch_binding_1",
    binding_id: "binding_1",
    dataset_family: "gene_expression",
    row_granularity: rowGranularity,
    schema_ref: schemaRef,
    file_asset: {
      schema_version: "1.0",
      asset_id: assetIdFromSha256(checksum),
      kind: "parsed",
      relative_path: `source_assets/${options.fileName}`,
      sha256: checksum,
      size_bytes: readFileSync(path).length,
      media_type: "text/csv",
      generated_by_step_id: "step_test",
    },
    row_count: options.rows.length,
    column_count: SOURCE_LONG_COLUMNS.length,
    parser_id: "test.long.v1",
    parser_version: "1.0.0",
    statistics: options.statistics ?? {},
    warnings: [],
    declared_mappings: options.mappings ?? [],
  });
}
function parseAdapterBatch(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  outputDir: string;
  bindingId?: string;
}): Promise<DataBatch> {
  const adapter = getAdapter(options.adapterId);
  const asset = sourceAssetFromFixture(options.fixturesRoot, options.fixture);
  return adapter.parse(asset, join(options.fixturesRoot, options.fixture), {
    buildId: "build_test",
    bindingId: options.bindingId ?? "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: options.outputDir,
  });
}

async function geneCanonical(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  outputDir: string;
  bindingId: string;
}): Promise<CanonicalizationResult> {
  const batch = await parseAdapterBatch({
    fixturesRoot: options.fixturesRoot,
    fixture: options.fixture,
    adapterId: options.adapterId,
    outputDir: options.outputDir,
    bindingId: options.bindingId,
  });
  return canonicalize({
    batch,
    schema: buildGeneExpressionSchema(),
    profile: expressionNormalizationV1(),
    outputDir: options.outputDir,
  });
}

/** Parse a probe-level series matrix and canonicalize under the probe schema. */
async function probeCanonical(options: {
  outputDir: string;
  bindingId: string;
  scale?: string;
  semantics?: string;
  unit?: string;
  namespaces?: string[];
  rowCount?: number;
}): Promise<CanonicalizationResult> {
  const scale = options.scale ?? "log2";
  const semantics = options.semantics ?? "normalized_expression";
  const unit = options.unit ?? "log2_expression";
  const rows = [
    sourceLongRow({
      gene_id_raw: "AFFX-BioB-5",
      gene_id_namespace_declared: "geo_probe",
      sample_id: "GSM1",
      value_semantics: semantics,
      value_scale: scale,
      expression_value: "1.5",
      expression_unit: unit,
      source_raw_value: "1.5",
    }),
    sourceLongRow({
      gene_id_raw: "1007_s_at",
      gene_id_namespace_declared: "geo_probe",
      sample_id: "GSM2",
      value_semantics: semantics,
      value_scale: scale,
      expression_value: "3.0",
      expression_unit: unit,
      source_raw_value: "3.0",
    }),
  ];
  const batch = batchForLongCsv({
    outputDir: options.outputDir,
    fileName: `${options.bindingId}_series_matrix.tsv`,
    rows,
    statistics: { format: "series_matrix", platform_ids: ["GPL570"] },
    schemaRef: "gene_expression.probe_long.v1",
    rowGranularity: "probe_sample_measurement",
    mappings: [formalMapping()],
  });
  const result = await canonicalize({
    batch,
    schema: buildProbeExpressionSchema(),
    profile: expressionNormalizationV1(),
    outputDir: options.outputDir,
  });
  const namespaces = options.namespaces ?? ["geo_probe"];
  const statistics: Record<string, unknown> = {
    ...result.batch.statistics,
    gene_id_namespaces: [...namespaces].sort(),
  };
  const canonicalBatch = parseDataBatch({
    schema_version: "1.0",
    batch_id: result.batch.batch_id,
    binding_id: result.batch.binding_id,
    dataset_family: result.batch.dataset_family,
    row_granularity: result.batch.row_granularity,
    schema_ref: result.batch.schema_ref,
    file_asset: result.batch.file_asset,
    row_count: result.batch.row_count,
    column_count: result.batch.column_count,
    parser_id: result.batch.parser_id,
    parser_version: result.batch.parser_version,
    statistics,
    warnings: result.batch.warnings,
    declared_mappings: result.batch.declared_mappings,
  });
  return {
    batch: canonicalBatch,
    canonicalPath: result.canonicalPath,
    rowCount: options.rowCount ?? result.rowCount,
    rejectedCount: result.rejectedCount,
    namespaces: [...namespaces].sort(),
    auditPaths: result.auditPaths,
  };
}

function withBatch(
  result: CanonicalizationResult,
  batch: DataBatch,
): CanonicalizationResult {
  return { ...result, batch };
}

function geneSpec(bindingIds: string[]): DatasetBuildSpec {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_test",
    objective: "compare TP53 expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: bindingIds.map((bindingId) => ({
      schema_version: "1.0",
      binding_id: bindingId,
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
    })),
    validation_profile_ref: "gene_expression.release.v1",
  });
}

function probeSpec(): DatasetBuildSpec {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_test",
    objective: "compare probe expression",
    dataset_family: "gene_expression",
    row_granularity: "probe_sample_measurement",
    schema_ref: "gene_expression.probe_long.v1",
    source_bindings: [
      {
        schema_version: "1.0",
        binding_id: "binding_geo",
        source: "geo",
        acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.series.v1" },
        adapter_id: "geo.expression.v1",
      },
    ],
    validation_profile_ref: "gene_expression.probe_release.v1",
  });
}

/** Minimal canonical wrapper for contract-level (fixture-free) checks. */
function minimalCanonical(batch: DataBatch, rowCount = 1): CanonicalizationResult {
  return {
    batch,
    canonicalPath: "",
    rowCount,
    rejectedCount: 0,
    namespaces: [],
    auditPaths: [],
  };
}

function canonicalBatch(options: {
  datasetFamily?: string;
  rowGranularity?: string;
  schemaRef?: string;
  mappings?: FieldMapping[];
  statistics?: Record<string, unknown>;
}): DataBatch {
  return parseDataBatch({
    schema_version: "1.0",
    batch_id: "batch_b",
    binding_id: "b",
    dataset_family: options.datasetFamily ?? "gene_expression",
    row_granularity: options.rowGranularity ?? "gene_sample_measurement",
    schema_ref: options.schemaRef ?? "gene_expression.long.v1",
    file_asset: {
      schema_version: "1.0",
      asset_id: assetIdFromSha256("ab".repeat(32)),
      kind: "parsed",
      relative_path: "batches/b.csv",
      sha256: "ab".repeat(32),
      size_bytes: 1,
      media_type: "text/csv",
      generated_by_step_id: "step_test",
    },
    row_count: 1,
    column_count: 1,
    parser_id: "p",
    parser_version: "1.0.0",
    statistics: options.statistics ?? {},
    warnings: [],
    declared_mappings: options.mappings ?? [],
  });
}
export function scratchOutputRoot(prefix = "compat-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Fixture-free gate rules (no_sources, per-source mismatch reasons, evidence). */
export function checkCompatGateContractParity(): string[] {
  const issues: string[] = [];
  const spec = geneSpec(["binding_gdc"]);

  // test_no_results_reports_no_sources.
  const noResults = checkExpressionCompatibility({ spec, results: [] });
  check(issues, noResults.compatible === false, "no results incompatible");
  checkDeepEqual(issues, noResults.reasons, ["no_sources"], "no results reasons");

  // test_family_mismatch_rejected.
  const family = checkExpressionCompatibility({
    spec,
    results: [minimalCanonical(canonicalBatch({ datasetFamily: "pathway_member" }))],
  });
  check(issues, family.compatible === false, "family mismatch incompatible");
  check(issues, family.reasons.includes("family_mismatch"), "family mismatch reason");

  // test_schema_mismatch_rejected.
  const schema = checkExpressionCompatibility({
    spec,
    results: [minimalCanonical(canonicalBatch({ schemaRef: "pathway_member.v1" }))],
  });
  check(issues, schema.reasons.includes("schema_mismatch"), "schema mismatch reason");

  // test_missing_mapping_evidence_rejected: empty, similarity, blank evidence.
  const empty = checkExpressionCompatibility({
    spec,
    results: [minimalCanonical(canonicalBatch({ mappings: [] }))],
  });
  check(issues, empty.reasons.includes("missing_mapping_evidence"), "empty mappings rejected");
  const similarity = checkExpressionCompatibility({
    spec,
    results: [
      minimalCanonical(
        canonicalBatch({
          mappings: [formalMapping({ mapping_method: "string_similarity", review_status: "proposed" })],
        }),
      ),
    ],
  });
  check(issues, similarity.reasons.includes("missing_mapping_evidence"), "similarity mapping rejected");
  const blank = checkExpressionCompatibility({
    spec,
    results: [
      minimalCanonical(
        canonicalBatch({ mappings: [formalMapping({ evidence: "   " })] }),
      ),
    ],
  });
  check(issues, blank.reasons.includes("missing_mapping_evidence"), "blank evidence rejected");

  // Formal mapping passes the evidence rule.
  const formal = checkExpressionCompatibility({
    spec,
    results: [minimalCanonical(canonicalBatch({ mappings: [formalMapping()] }))],
  });
  check(issues, !formal.reasons.includes("missing_mapping_evidence"), "formal mapping accepted");

  // Reasons are deduplicated preserving order.
  const duplicate = checkExpressionCompatibility({
    spec,
    results: [
      minimalCanonical(canonicalBatch({ datasetFamily: "x" })),
      minimalCanonical(canonicalBatch({ datasetFamily: "x" })),
    ],
  });
  checkDeepEqual(issues, duplicate.reasons, ["family_mismatch", "missing_mapping_evidence"], "reasons deduplicated");

  return issues;
}

/** Fixture-driven gate matrix (test_dataset_compat_gate.py). */
export async function checkCompatGateFixtureParity(options: {
  fixturesRoot: string;
  outputRoot: string;
}): Promise<string[]> {
  const issues: string[] = [];
  rmSync(options.outputRoot, { recursive: true, force: true });
  mkdirSync(options.outputRoot, { recursive: true });
  const fixtures = options.fixturesRoot;

  // test_compatible_gdc_xena_merge_passes.
  const mergeOut = join(options.outputRoot, "merge");
  const gdc = await geneCanonical({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_expression.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: join(mergeOut, "gdc"),
    bindingId: "binding_gdc",
  });
  const xena = await geneCanonical({
    fixturesRoot: fixtures,
    fixture: "ncbi/gse178352/xena_matrix.tsv",
    adapterId: "xena.matrix.v1",
    outputDir: join(mergeOut, "xena"),
    bindingId: "binding_xena",
  });
  const mergeReport = checkExpressionCompatibility({
    spec: geneSpec(["binding_gdc", "binding_xena"]),
    results: [gdc, xena],
  });
  check(issues, mergeReport.compatible === true, "GDC+Xena merge compatible");
  checkDeepEqual(issues, mergeReport.reasons, [], "GDC+Xena merge reasons");

  // test_single_source_passes.
  const single = checkExpressionCompatibility({ spec: geneSpec(["binding_gdc"]), results: [gdc] });
  check(issues, single.compatible === true, "single source passes");

  // test_unit_mismatch_rejected.
  const star = await geneCanonical({
    fixturesRoot: fixtures,
    fixture: "gdc/gdc_star_counts.tsv",
    adapterId: "gdc.expression.v1",
    outputDir: join(mergeOut, "star"),
    bindingId: "binding_star",
  });
  const unit = checkExpressionCompatibility({
    spec: geneSpec(["binding_matrix", "binding_star"]),
    results: [gdc, star],
  });
  check(issues, unit.compatible === false, "unit mismatch incompatible");
  check(issues, unit.reasons.includes("measurement_identity_mismatch"), "unit mismatch reason");

  // test_namespace_mismatch_rejected.
  const ns = checkExpressionCompatibility({
    spec: geneSpec(["binding_xena", "binding_star"]),
    results: [xena, star],
  });
  check(issues, ns.compatible === false, "namespace mismatch incompatible");
  check(issues, ns.reasons.includes("namespace_mismatch"), "namespace mismatch reason");

  // test_family_mismatch_rejected (fixture variant).
  const family = checkExpressionCompatibility({
    spec: geneSpec(["binding_gdc"]),
    results: [
      withBatch(
        gdc,
        parseDataBatch({ ...gdc.batch, dataset_family: "pathway_member" }),
      ),
    ],
  });
  check(issues, family.reasons.includes("family_mismatch"), "family mismatch fixture reason");

  // test_missing_mapping_evidence_rejected (fixture variant).
  const noEvidence = checkExpressionCompatibility({
    spec: geneSpec(["binding_gdc"]),
    results: [withBatch(gdc, parseDataBatch({ ...gdc.batch, declared_mappings: [] }))],
  });
  check(issues, noEvidence.reasons.includes("missing_mapping_evidence"), "missing evidence fixture reason");

  // test_schema_mismatch_rejected (fixture variant).
  const schema = checkExpressionCompatibility({
    spec: geneSpec(["binding_gdc"]),
    results: [
      withBatch(gdc, parseDataBatch({ ...gdc.batch, schema_ref: "pathway_member.v1" })),
    ],
  });
  check(issues, schema.reasons.includes("schema_mismatch"), "schema mismatch fixture reason");
  // test_unknown_scale_cross_source_merge_rejected.
  const probeOut = join(options.outputRoot, "probe");
  const unknownA = await probeCanonical({ outputDir: join(probeOut, "a"), bindingId: "binding_geo_a", scale: "unknown" });
  const unknownB = await probeCanonical({ outputDir: join(probeOut, "b"), bindingId: "binding_geo_b", scale: "unknown" });
  const unknownMerge = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [unknownA, unknownB],
  });
  check(issues, unknownMerge.compatible === false, "unknown x unknown incompatible");
  check(issues, unknownMerge.reasons.includes("measurement_identity_mismatch"), "unknown x unknown reason");

  // test_unknown_scale_single_source_passes.
  const unknownSingle = checkExpressionCompatibility({ spec: probeSpec(), results: [unknownA] });
  check(issues, unknownSingle.compatible === true, "unknown single source passes");
  checkDeepEqual(issues, unknownSingle.reasons, [], "unknown single source reasons");

  // test_log2_vs_linear_identity_mismatch.
  const log2Source = await probeCanonical({ outputDir: join(probeOut, "l2"), bindingId: "binding_geo_a", scale: "log2" });
  const linearSource = await probeCanonical({ outputDir: join(probeOut, "lin"), bindingId: "binding_geo_b", scale: "linear" });
  const log2Linear = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [log2Source, linearSource],
  });
  check(issues, log2Linear.compatible === false, "log2 vs linear incompatible");
  check(issues, log2Linear.reasons.includes("measurement_identity_mismatch"), "log2 vs linear reason");

  // test_known_and_unknown_scale_cross_source_rejected.
  const knownUnknown = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [log2Source, unknownB],
  });
  check(issues, knownUnknown.compatible === false, "known x unknown incompatible");
  check(issues, knownUnknown.reasons.includes("measurement_identity_mismatch"), "known x unknown reason");

  // test_probe_and_gene_schema_sources_rejected.
  const probeGene = checkExpressionCompatibility({
    spec: geneSpec(["binding_gene"]),
    results: [log2Source, gdc],
  });
  check(issues, probeGene.compatible === false, "probe + gene incompatible");
  check(issues, probeGene.reasons.includes("schema_mismatch"), "probe + gene schema reason");
  check(issues, probeGene.reasons.includes("granularity_mismatch"), "probe + gene granularity reason");

  // test_probe_level_build_mixed_namespace_sources_rejected.
  const geneRows = await probeCanonical({
    outputDir: join(probeOut, "gene_rows"),
    bindingId: "binding_geo_b",
    namespaces: ["ensembl_gene"],
  });
  const mixedNs = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [log2Source, geneRows],
  });
  check(issues, mixedNs.compatible === false, "mixed namespace incompatible");
  check(issues, mixedNs.reasons.includes("namespace_mismatch"), "mixed namespace reason");

  // test_probe_level_two_probe_sources_compatible.
  const log2Second = await probeCanonical({
    outputDir: join(probeOut, "l2b"),
    bindingId: "binding_geo_b",
    scale: "log2",
  });
  const probeProbe = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [log2Source, log2Second],
  });
  check(issues, probeProbe.compatible === true, "probe x probe compatible");
  checkDeepEqual(issues, probeProbe.reasons, [], "probe x probe reasons");

  // test_empty_source_does_not_forge_identity.
  const empty = await probeCanonical({
    outputDir: join(probeOut, "empty"),
    bindingId: "binding_geo_empty",
    scale: "unknown",
    rowCount: 0,
  });
  const nonEmpty = await probeCanonical({
    outputDir: join(probeOut, "real"),
    bindingId: "binding_geo_real",
    scale: "log2",
  });
  const emptyMerge = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [empty, nonEmpty],
  });
  check(issues, emptyMerge.compatible === true, "empty source does not forge identity");
  check(issues, !emptyMerge.reasons.includes("measurement_identity_mismatch"), "empty source no identity reason");

  // test_all_empty_sources_never_fabricate_identity.
  const allEmptyA = await probeCanonical({ outputDir: join(probeOut, "e1"), bindingId: "binding_geo_a", rowCount: 0 });
  const allEmptyB = await probeCanonical({ outputDir: join(probeOut, "e2"), bindingId: "binding_geo_b", rowCount: 0 });
  const allEmpty = checkExpressionCompatibility({
    spec: probeSpec(),
    results: [allEmptyA, allEmptyB],
  });
  check(issues, !allEmpty.reasons.includes("measurement_identity_mismatch"), "all empty no identity reason");
  check(issues, !allEmpty.reasons.includes("namespace_mismatch"), "all empty no namespace reason");

  return issues;
}

