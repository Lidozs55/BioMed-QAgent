/**
 * Phase 4 step 4 (adapters) parity checks: DownloadAttempt / AcquisitionResult
 * / SourceRecord / SourceRelation contract invariants (mirror
 * ``backend/tests/contracts/test_source_contracts.py``), the Database /
 * DownloadStatus / ErrorCode enums, AdapterParams invariants, and
 * fixture-driven GDC / Xena adapter runs (mirror
 * ``backend/tests/test_dataset_adapters.py``). Vitest-free so the same
 * checks run under vitest and as a plain Node script.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { deepEqual } from "./contract-parity.js";
import {
  DATABASE,
  DATABASE_IDENTIFIER_ALIASES,
  DOWNLOAD_STATUS,
  ERROR_CODE,
  SOURCE_CAPABILITIES,
  parseAcquisitionResult,
  parseAdapterParams,
  parseDownloadAttempt,
  parseSourceAsset,
  parseSourceBinding,
  parseSourceRecord,
  parseSourceRelation,
} from "../src/dataset/contracts/index.js";
import type { SourceAsset } from "../src/dataset/contracts/index.js";
import {
  ADAPTER_REGISTRY,
  AdapterError,
  BuildError,
  REJECTED_COLUMNS,
  SOURCE_LONG_COLUMNS,
  SourceAdapter,
  adapterParamsForBinding,
  assetIdFromSha256,
  canonicalDigest,
  getAdapter,
} from "../src/dataset/adapters/index.js";

const SHA256 = "ab".repeat(32);
const NOW = "2026-07-12T00:00:00Z";

type ErrorClass = new (message?: string) => Error;

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
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

function sourceAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    asset_id: `asset_${SHA256}`,
    kind: "source",
    relative_path: "source_assets/GSE178352_counts.txt.gz",
    sha256: SHA256,
    size_bytes: 1024,
    media_type: "application/gzip",
    generated_by_step_id: null,
    source_id: "src_geo",
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
    ...overrides,
  };
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

/** DownloadAttempt / AcquisitionResult / SourceRecord / SourceRelation + enums + AdapterParams. */
export function checkAdapterContractParity(): string[] {
  const issues: string[] = [];

  // SourceRecord / SourceRelation preserve explicit evidence (Python test).
  const source = parseSourceRecord({
    schema_version: "1.0",
    source_id: "src_article",
    database: "pubmed",
    accession: "34180400",
    url: "https://pubmed.ncbi.nlm.nih.gov/34180400/",
    title: "A paper",
    retrieved_at: NOW,
  });
  check(issues, source.database === "pubmed", "SourceRecord.database must parse");
  const relation = parseSourceRelation({
    schema_version: "1.0",
    relation_id: "rel_article_geo",
    from_source_id: source.source_id,
    to_source_id: "src_geo",
    relation_type: "article_describes_dataset",
    evidence_type: "accession_in_article",
    evidence_value: "GSE178352",
    evidence_url: source.url,
  });
  check(
    issues,
    relation.evidence_value === "GSE178352",
    "SourceRelation.evidence_value must be preserved",
  );

  // DownloadAttempt status/error/time invariants (Python test).
  const successful = parseDownloadAttempt({
    schema_version: "1.0",
    attempt_id: "attempt_1",
    source_id: "src_geo",
    url: "https://example.test/counts.gz",
    status: "succeeded",
    bytes_received: 42,
    error_code: null,
    error_message: null,
    started_at: NOW,
    finished_at: "2026-07-12T00:00:01Z",
  });
  check(
    issues,
    successful.error_code === null,
    "successful attempt must have null error_code",
  );
  checkThrows(
    issues,
    "succeeded with error rejected",
    () =>
      parseDownloadAttempt({
        ...successful,
        error_code: "network_error",
        error_message: "unexpected",
      }),
    /successful download/,
  );
  checkThrows(
    issues,
    "failed without error rejected",
    () =>
      parseDownloadAttempt({
        schema_version: "1.0",
        attempt_id: "attempt_2",
        source_id: "src_geo",
        url: "https://example.test/counts.gz",
        status: "failed",
        bytes_received: 0,
        error_code: null,
        error_message: null,
        started_at: NOW,
        finished_at: NOW,
      }),
    /failed download/,
  );
  checkThrows(
    issues,
    "finished_at before started_at rejected",
    () =>
      parseDownloadAttempt({
        ...successful,
        started_at: "2026-07-12T00:00:01Z",
        finished_at: NOW,
      }),
    /finished_at/,
  );

  // AcquisitionResult: succeeded <-> asset, asset references its attempt.
  const asset = parseSourceAsset(sourceAsset());
  const result = parseAcquisitionResult({
    schema_version: "1.0",
    attempt: successful,
    asset,
  });
  check(
    issues,
    result.asset?.asset_id === asset.asset_id,
    "AcquisitionResult asset must round-trip",
  );
  checkThrows(
    issues,
    "succeeded without asset rejected",
    () => parseAcquisitionResult({ schema_version: "1.0", attempt: successful, asset: null }),
    /require an asset/,
  );
  const failedAttempt = parseDownloadAttempt({
    schema_version: "1.0",
    attempt_id: "attempt_2",
    source_id: "src_geo",
    url: "https://example.test/counts.gz",
    status: "failed",
    bytes_received: 0,
    error_code: "network_error",
    error_message: "boom",
    started_at: NOW,
    finished_at: NOW,
  });
  checkThrows(
    issues,
    "failed with asset rejected",
    () =>
      parseAcquisitionResult({
        schema_version: "1.0",
        attempt: failedAttempt,
        asset,
      }),
    /forbid one/,
  );
  checkThrows(
    issues,
    "asset referencing the wrong attempt rejected",
    () =>
      parseAcquisitionResult({
        schema_version: "1.0",
        attempt: successful,
        asset: parseSourceAsset(sourceAsset({ successful_attempt_id: "attempt_other" })),
      }),
    /reference its successful attempt/,
  );

  // Database / DownloadStatus / ErrorCode enum surfaces + capability table.
  check(issues, DATABASE.UCSC_XENA === "ucsc_xena", "DATABASE.UCSC_XENA value");
  check(issues, DATABASE.CHEMBL === "chembl", "DATABASE.CHEMBL value");
  check(
    issues,
    DOWNLOAD_STATUS.CANCELLED === "cancelled",
    "DOWNLOAD_STATUS.CANCELLED value",
  );
  check(
    issues,
    ERROR_CODE.CHECKSUM_MISMATCH === "checksum_mismatch",
    "ERROR_CODE.CHECKSUM_MISMATCH value",
  );
  check(issues, SOURCE_CAPABILITIES.gdc === "pipeline_supported", "gdc capability");
  check(issues, SOURCE_CAPABILITIES.reactome === "pipeline_supported", "reactome capability");
  check(issues, SOURCE_CAPABILITIES.uniprot === "research_only", "uniprot capability");
  check(
    issues,
    DATABASE_IDENTIFIER_ALIASES.xena === "ucsc_xena",
    "DATABASE_IDENTIFIER_ALIASES xena",
  );

  // AdapterParams invariants (Python AdapterParams validators).
  const params = parseAdapterParams({
    schema_version: "1.0",
    format: "supplementary_matrix",
    value_semantics: "expression_value",
    value_scale: "linear",
    expression_unit: "expression_value",
    is_normalized: false,
    platform_ids: ["GPL570"],
    delimiter: ",",
  });
  check(issues, params.delimiter === ",", "AdapterParams delimiter survives parsing");
  check(issues, params.platform_ids[0] === "GPL570", "AdapterParams platform_ids survive");
  checkThrows(
    issues,
    "bad platform id rejected",
    () =>
      parseAdapterParams({
        schema_version: "1.0",
        format: "series_matrix",
        value_semantics: "expression_value",
        value_scale: "linear",
        expression_unit: "expression_value",
        platform_ids: ["GSE1"],
      }),
    /GPL/,
  );
  checkThrows(
    issues,
    "multi-character delimiter rejected",
    () =>
      parseAdapterParams({
        schema_version: "1.0",
        format: "supplementary_matrix",
        value_semantics: "expression_value",
        value_scale: "linear",
        expression_unit: "expression_value",
        delimiter: "::",
      }),
    /single character/,
  );
  checkThrows(
    issues,
    "delimiter on non-supplementary format rejected",
    () =>
      parseAdapterParams({
        schema_version: "1.0",
        format: "series_matrix",
        value_semantics: "expression_value",
        value_scale: "linear",
        expression_unit: "expression_value",
        delimiter: ",",
      }),
    /supplementary_matrix/,
  );
  checkThrows(
    issues,
    "unknown value scale rejected",
    () =>
      parseAdapterParams({
        schema_version: "1.0",
        format: "series_matrix",
        value_semantics: "expression_value",
        value_scale: "fold_change",
        expression_unit: "expression_value",
      }),
    /must be one of/,
  );

  // adapterParamsForBinding: empty parameters -> null; invalid -> BuildError.
  const emptyBinding = parseSourceBinding({
    schema_version: "1.0",
    binding_id: "binding_1",
    source: "gdc",
    acquisition: {
      schema_version: "1.0",
      mode: "builtin",
      provider_id: "gdc.v1",
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: "gdc.expression.v1",
    accession: null,
    parameters: {},
  });
  check(
    issues,
    adapterParamsForBinding(emptyBinding) === null,
    "empty binding parameters must map to null",
  );
  const invalidBinding = parseSourceBinding({
    ...emptyBinding,
    parameters: {
      format: "bogus",
      value_semantics: "x",
      value_scale: "linear",
      expression_unit: "x",
    },
  });
  checkThrows(
    issues,
    "invalid binding parameters raise BuildError",
    () => adapterParamsForBinding(invalidBinding),
    /invalid adapter parameters/,
    BuildError,
  );

  return issues;
}

export interface AdapterFixtureOptions {
  fixturesRoot: string;
  outputRoot: string;
}

function runAdapter(
  adapter: SourceAdapter,
  fixturesRoot: string,
  fixture: string,
  outputDir: string,
) {
  const asset = sourceAssetFromFixture(fixturesRoot, fixture);
  return adapter.parse(asset, join(fixturesRoot, fixture), {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir,
  });
}

/** GDC / Xena adapter runs against the backend fixtures (test_dataset_adapters.py). */
export function checkAdapterFixtureParity(options: AdapterFixtureOptions): string[] {
  const issues: string[] = [];
  rmSync(options.outputRoot, { recursive: true, force: true });
  mkdirSync(options.outputRoot, { recursive: true });
  const fixtures = options.fixturesRoot;

  // 1. GDC matrix batch shape (test_gdc_matrix_batch_shape).
  const gdc = getAdapter("gdc.expression.v1");
  const gdcBatch = runAdapter(gdc, fixtures, "gdc/gdc_expression.tsv", join(options.outputRoot, "gdc_matrix"));
  check(issues, gdcBatch.batch_id === "batch_binding_1", "GDC batch_id");
  check(issues, gdcBatch.dataset_family === "gene_expression", "GDC dataset_family");
  check(issues, gdcBatch.row_granularity === "gene_sample_measurement", "GDC row_granularity");
  check(issues, gdcBatch.schema_ref === "gene_expression.long.v1", "GDC schema_ref");
  check(issues, gdcBatch.parser_id === "gdc.expression.v1", "GDC parser_id");
  check(issues, gdcBatch.row_count === 4, "GDC row_count");
  check(issues, gdcBatch.column_count === SOURCE_LONG_COLUMNS.length, "GDC column_count");
  check(issues, gdcBatch.statistics.format === "expression_matrix", "GDC statistics.format");
  check(issues, gdcBatch.statistics.sample_count === 2, "GDC statistics.sample_count");
  check(issues, gdcBatch.statistics.rejected_count === 0, "GDC statistics.rejected_count");
  check(issues, gdcBatch.warnings.length === 0, "GDC warnings empty");
  check(issues, gdcBatch.file_asset?.kind === "parsed", "GDC file_asset kind parsed");
  check(
    issues,
    gdcBatch.file_asset?.relative_path === "batches/binding_1.csv",
    "GDC file_asset relative_path",
  );
  check(issues, gdcBatch.file_asset?.media_type === "text/csv", "GDC file_asset media_type");
  check(
    issues,
    gdcBatch.file_asset?.generated_by_step_id === "step_gdc.expression.v1",
    "GDC file_asset generated_by_step_id",
  );
  check(
    issues,
    gdcBatch.file_asset?.sha256 ===
      sha256Hex(readFileSync(join(options.outputRoot, "gdc_matrix", "batches", "binding_1.csv"))),
    "GDC file_asset sha256 matches written csv",
  );

  // 2. GDC declared mappings (test_gdc_matrix_declared_mappings).
  const pairs = new Set(
    gdcBatch.declared_mappings.map((m) => `${m.source_field}|${m.target_field}`),
  );
  check(issues, pairs.has("gene_id|gene_id_raw"), "GDC mapping gene_id->gene_id_raw");
  check(issues, pairs.has("S1|sample_id"), "GDC mapping S1->sample_id");
  check(issues, pairs.has("S1|expression_value"), "GDC mapping S1->expression_value");
  const sampleMapping = gdcBatch.declared_mappings.find(
    (m) => m.source_field === "S1" && m.target_field === "sample_id",
  );
  check(
    issues,
    sampleMapping?.transform === "wide_to_long_sample_id",
    "GDC sample mapping transform",
  );
  check(
    issues,
    gdcBatch.declared_mappings.every(
      (m) =>
        m.mapping_method === "adapter_declared" &&
        m.review_status === "accepted" &&
        m.confidence_level === "high",
    ),
    "GDC mapping methods/status/confidence",
  );

  // 3. GDC rows are source-long (test_gdc_matrix_rows_are_source_long).
  const gdcCsv = readFileSync(
    join(options.outputRoot, "gdc_matrix", "batches", "binding_1.csv"),
    "utf8",
  );
  const gdcLines = gdcCsv.split(/\r\n|\n/).filter((line) => line.length > 0);
  check(
    issues,
    deepEqual(gdcLines[0].split(","), [...SOURCE_LONG_COLUMNS]),
    "GDC csv header equals SOURCE_LONG_COLUMNS",
  );
  check(issues, gdcLines.length === 5, "GDC csv header + 4 rows");
  const gdcFirst = Object.fromEntries(
    gdcLines[0]
      .split(",")
      .map((column, index) => [column, gdcLines[1].split(",")[index]]),
  );
  check(issues, gdcFirst["gene_id_raw"] === "TP53", "GDC row gene_id_raw");
  check(issues, gdcFirst["sample_id"] === "S1", "GDC row sample_id");
  check(issues, gdcFirst["expression_value"] === "1.5", "GDC row expression_value");
  check(issues, gdcFirst["expression_unit"] === "expression_value", "GDC row expression_unit");
  check(issues, gdcFirst["source_line_number"] === "2", "GDC row source_line_number");
  check(issues, gdcFirst["source_column_index"] === "1", "GDC row source_column_index");
  check(
    issues,
    gdcFirst["gene_id_namespace_declared"] === "",
    "GDC row gene_id_namespace_declared empty",
  );
  check(
    issues,
    gdcFirst["record_id"] ===
      `rec_${canonicalDigest(["build_test", "TP53", "S1"]).slice(0, 32)}`,
    "GDC row record_id matches canonical digest",
  );

  // 4. GDC STAR counts (test_gdc_star_counts_batch + _rejected_rows_audited).
  const gdcStar = runAdapter(gdc, fixtures, "gdc/gdc_star_counts.tsv", join(options.outputRoot, "gdc_star"));
  check(issues, gdcStar.statistics.format === "star_counts", "STAR statistics.format");
  check(issues, gdcStar.statistics.source_row_count === 2, "STAR statistics.source_row_count");
  check(issues, gdcStar.row_count === 2, "STAR row_count");
  check(issues, gdcStar.statistics.rejected_count === 1, "STAR statistics.rejected_count");
  check(issues, gdcStar.warnings.length === 0, "STAR warnings empty");
  const starLines = readFileSync(
    join(options.outputRoot, "gdc_star", "batches", "binding_1.csv"),
    "utf8",
  )
    .split(/\r\n|\n/)
    .filter((line) => line.length > 0);
  check(issues, starLines.length === 3, "STAR csv header + 2 rows");
  const starFirst = Object.fromEntries(
    starLines[0]
      .split(",")
      .map((column, index) => [column, starLines[1].split(",")[index]]),
  );
  check(issues, starFirst["dataset_id"] === "build_test", "STAR row dataset_id");
  check(issues, starFirst["gene_id_raw"] === "ENSG00000141510.17", "STAR row gene_id_raw verbatim");
  check(issues, starFirst["is_normalized"] === "true", "STAR row is_normalized");
  check(issues, starFirst["expression_value"] === "85.5", "STAR row expression_value");
  check(issues, starFirst["expression_unit"] === "tpm_unstranded", "STAR row expression_unit");
  check(issues, starFirst["sample_id"] === "gdc_star_counts", "STAR row sample_id from filename");
  const starRejected = readFileSync(
    join(options.outputRoot, "gdc_star", "batches", "binding_1_rejected.csv"),
    "utf8",
  )
    .split(/\r\n|\n/)
    .filter((line) => line.length > 0);
  check(issues, starRejected.length === 2, "STAR rejected header + 1 row");
  check(issues, starRejected[1].includes("__no_feature"), "STAR rejected row gene");
  check(issues, starRejected[1].includes("non_ensg_annotation_row"), "STAR rejected reason");

  // 5. Xena matrix (test_xena_matrix_batch).
  const xena = getAdapter("xena.matrix.v1");
  const xenaBatch = runAdapter(xena, fixtures, "ncbi/gse178352/xena_matrix.tsv", join(options.outputRoot, "xena"));
  check(issues, xenaBatch.parser_id === "xena.matrix.v1", "Xena parser_id");
  check(issues, xenaBatch.statistics.format === "expression_matrix", "Xena statistics.format");
  check(issues, xenaBatch.row_count === 4, "Xena row_count");
  check(issues, xenaBatch.declared_mappings.length === 5, "Xena declared mappings count");
  check(issues, xenaBatch.parser_version === "1.0.0", "Xena parser_version");
  check(
    issues,
    xenaBatch.file_asset?.generated_by_step_id === "step_xena.matrix.v1",
    "Xena file_asset generated_by_step_id",
  );
  check(issues, getAdapter("xena.matrix.v1").source_database === "ucsc_xena", "Xena source_database");

  // 6. Checksum mismatch fails closed (test_checksum_mismatch_fails_closed).
  const checksumOut = join(options.outputRoot, "checksum");
  const tampered = parseSourceAsset({
    schema_version: "1.0",
    asset_id: assetIdFromSha256("0".repeat(64)),
    kind: "source",
    relative_path: "source_assets/gdc/gdc_expression.tsv",
    sha256: "0".repeat(64),
    size_bytes: readFileSync(join(fixtures, "gdc/gdc_expression.tsv")).length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: "src_test",
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
  checkThrows(
    issues,
    "checksum mismatch raises AdapterError",
    () =>
      gdc.parse(tampered, join(fixtures, "gdc/gdc_expression.tsv"), {
        buildId: "build_test",
        bindingId: "binding_1",
        schemaRef: "gene_expression.long.v1",
        outputDir: checksumOut,
      }),
    /checksum/,
    AdapterError,
  );
  check(
    issues,
    !existsSync(join(checksumOut, "batches")),
    "checksum failure must not create a batches dir",
  );

  // 7. Malformed header fails closed (test_malformed_header_fails_closed).
  const malformedOut = join(options.outputRoot, "malformed");
  const malformedPath = join(malformedOut, "malformed.tsv");
  writeFixtureFile(malformedPath, "sample_id\tvalue\n", "utf8");
  checkThrows(
    issues,
    "malformed header raises AdapterError",
    () =>
      gdc.parse(sourceAssetFromPath(malformedPath), malformedPath, {
        buildId: "build_test",
        bindingId: "binding_1",
        schemaRef: "gene_expression.long.v1",
        outputDir: malformedOut,
      }),
    /gene_id/,
    AdapterError,
  );

  // 8. Non-finite value audited not fatal (test_non_finite_value_audited_not_fatal).
  const badValueOut = join(options.outputRoot, "bad_value");
  const badValuePath = join(badValueOut, "bad_value.tsv");
  writeFixtureFile(badValuePath, "gene_id\tS1\nTP53\tnan-value\n", "utf8");
  const badValueBatch = gdc.parse(sourceAssetFromPath(badValuePath), badValuePath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: badValueOut,
  });
  check(issues, badValueBatch.row_count === 0, "bad value row_count 0");
  check(issues, badValueBatch.statistics.rejected_count === 1, "bad value rejected_count 1");
  check(issues, badValueBatch.statistics.source_row_count === 1, "bad value source_row_count 1");
  const badValueRejected = readFileSync(
    join(badValueOut, "batches", "binding_1_rejected.csv"),
    "utf8",
  );
  check(issues, badValueRejected.includes("non_finite_value"), "bad value reason code");
  check(issues, badValueRejected.includes("nan-value"), "bad value raw preserved");

  // 9. NaN/Inf audited (test_nan_and_inf_values_audited).
  const specialOut = join(options.outputRoot, "special");
  const specialPath = join(specialOut, "special.tsv");
  writeFixtureFile(specialPath, "gene_id\tS1\tS2\nTP53\tnan\tinf\nBRCA1\t3\t4.25\n", "utf8");
  const specialBatch = gdc.parse(sourceAssetFromPath(specialPath), specialPath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: specialOut,
  });
  check(issues, specialBatch.row_count === 2, "special row_count 2 (only BRCA1 cells)");
  check(issues, specialBatch.statistics.rejected_count === 2, "special rejected_count 2");
  const specialRejected = readFileSync(
    join(specialOut, "batches", "binding_1_rejected.csv"),
    "utf8",
  );
  check(issues, specialRejected.includes("nan"), "special rejected contains nan");
  check(issues, specialRejected.includes("inf"), "special rejected contains inf");

  // 10. GDC annotation columns ignored (test_gdc_annotation_columns_ignored).
  const annotatedOut = join(options.outputRoot, "annotated");
  const annotatedPath = join(annotatedOut, "annotated.tsv");
  writeFixtureFile(
    annotatedPath,
    "gene_id\tgene_name\tgene_type\tS1\tS2\nENSG00000141510\tTP53\tprotein_coding\t1.5\t2\n",
    "utf8",
  );
  const annotatedBatch = gdc.parse(sourceAssetFromPath(annotatedPath), annotatedPath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: annotatedOut,
  });
  check(issues, annotatedBatch.statistics.sample_count === 2, "annotated sample_count 2");
  check(issues, annotatedBatch.row_count === 2, "annotated row_count 2");
  const annotatedCsv = readFileSync(
    join(annotatedOut, "batches", "binding_1.csv"),
    "utf8",
  );
  check(issues, !annotatedCsv.includes("protein_coding"), "annotated rows drop gene_type");
  check(issues, !annotatedCsv.includes("gene_name"), "annotated rows drop gene_name");

  // 11. Gzip source parsed (test_gzip_source_parsed).
  const gzipOut = join(options.outputRoot, "gzip");
  const gzipPath = join(gzipOut, "gdc_expression.tsv.gz");
  writeFixtureFile(
    gzipPath,
    gzipSync(readFileSync(join(fixtures, "gdc/gdc_expression.tsv"))),
  );
  const gzipBatch = gdc.parse(sourceAssetFromPath(gzipPath), gzipPath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: gzipOut,
  });
  check(issues, gzipBatch.row_count === 4, "gzip source row_count 4");

  // 12. STAR counts unstranded fallback (test_star_counts_unstranded_fallback).
  const starFallbackOut = join(options.outputRoot, "star_fallback");
  const starFallbackPath = join(starFallbackOut, "star_counts_raw.tsv");
  writeFixtureFile(
    starFallbackPath,
    "gene_id\tgene_name\tgene_type\tunstranded\nENSG00000141510.17\tTP53\tprotein_coding\t120\n",
    "utf8",
  );
  const starFallback = gdc.parse(sourceAssetFromPath(starFallbackPath), starFallbackPath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: starFallbackOut,
  });
  check(issues, starFallback.statistics.format === "star_counts", "fallback statistics.format");
  const fallbackCsv = readFileSync(
    join(starFallbackOut, "batches", "binding_1.csv"),
    "utf8",
  );
  const fallbackLines = fallbackCsv.split(/\r\n|\n/).filter((line) => line.length > 0);
  const fallbackRow = Object.fromEntries(
    fallbackLines[0]
      .split(",")
      .map((column, index) => [column, fallbackLines[1].split(",")[index]]),
  );
  check(issues, fallbackRow["value_semantics"] === "raw_count", "fallback value_semantics");
  check(issues, fallbackRow["expression_unit"] === "unstranded", "fallback expression_unit");
  check(issues, fallbackRow["is_normalized"] === "false", "fallback is_normalized");
  check(issues, fallbackRow["is_integer_expected"] === "true", "fallback is_integer_expected");

  // 13. Blank-line parity (test_blank_line_parity): GDC strict, Xena skips.
  const blankGdcOut = join(options.outputRoot, "blank_gdc");
  const blankGdcPath = join(blankGdcOut, "gdc_blank.tsv");
  writeFixtureFile(blankGdcPath, "gene_id\tS1\nTP53\t1.5\n\nBRCA1\t3\n", "utf8");
  checkThrows(
    issues,
    "GDC blank line raises AdapterError",
    () =>
      gdc.parse(sourceAssetFromPath(blankGdcPath), blankGdcPath, {
        buildId: "build_test",
        bindingId: "binding_1",
        schemaRef: "gene_expression.long.v1",
        outputDir: blankGdcOut,
      }),
    /invalid GDC expression row/,
    AdapterError,
  );
  const blankXenaOut = join(options.outputRoot, "blank_xena");
  const blankXenaPath = join(blankXenaOut, "xena_blank.tsv");
  writeFixtureFile(blankXenaPath, "gene_id\tS1\nTP53\t1.5\n\nBRCA1\t3\n", "utf8");
  const blankXenaBatch = xena.parse(sourceAssetFromPath(blankXenaPath), blankXenaPath, {
    buildId: "build_test",
    bindingId: "binding_1",
    schemaRef: "gene_expression.long.v1",
    outputDir: blankXenaOut,
  });
  check(issues, blankXenaBatch.row_count === 2, "Xena blank line skipped");

  // 14. Registry + unknown adapter (test_unknown_adapter_rejected, test_adapter_registry_entries).
  check(issues, "gdc.expression.v1" in ADAPTER_REGISTRY, "registry has gdc adapter");
  check(issues, "xena.matrix.v1" in ADAPTER_REGISTRY, "registry has xena adapter");
  checkThrows(
    issues,
    "unknown adapter rejected",
    () => getAdapter("geo.probe.v1"),
    /unknown source adapter/,
    AdapterError,
  );

  // 15. Source-long contract carries the declared namespace column.
  check(
    issues,
    SOURCE_LONG_COLUMNS.includes("gene_id_namespace_declared"),
    "SOURCE_LONG_COLUMNS carries gene_id_namespace_declared",
  );
  check(issues, REJECTED_COLUMNS.length === 9, "REJECTED_COLUMNS length 9");

  return issues;
}

/** Convenience wrapper: contract + fixture parity. */
export function checkAdaptersParity(options: AdapterFixtureOptions): string[] {
  return [...checkAdapterContractParity(), ...checkAdapterFixtureParity(options)];
}

/** Scratch output root for callers that want to manage their own temp dir. */
export function scratchOutputRoot(prefix = "adapter-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}