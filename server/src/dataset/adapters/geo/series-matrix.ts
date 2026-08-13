/**
 * GeoExpressionAdapter: GEO expression formats -> source-long DataBatch
 * (P5-04; Python ``app/datasets/build/geo_adapter.py`` parity).
 *
 * The ``geo.expression.v1`` adapter parses three explicit GEO expression
 * formats selected through typed ``AdapterParams`` (tximport_counts /
 * series_matrix / supplementary_matrix).  The value scale, semantics, unit
 * and normalization flag come ONLY from the parameters — never inferred from
 * a file name.  It declares the per-row namespace
 * (``gene_id_namespace_declared``) and the batch-level
 * ``source_gene_id_namespace`` statistic: tximport rows are
 * ``ensembl_gene``; series/supplementary ID_REF rows are ``ensembl_gene``
 * only when they match the ENSG shape, otherwise ``geo_probe``.  The adapter
 * does NOT map probes to genes — that is the canonicalizer/mapping layer's
 * job.
 *
 * Fail-closed contract (mirrors the shared adapter policy): structural
 * malformation (missing table block, bad header, column-width mismatch,
 * duplicate/blank sample headers) is fatal; a value cell that is not a
 * finite number is rejected row-level into the audit file; zero valid
 * expression rows raise a typed ``EmptySourceError``.
 *
 * Deviation note: Python ``DataBatch`` carries a ``supporting_assets`` list
 * of FileAssets for the sample-metadata side table; the TS DataBatch
 * contract (owned elsewhere) has no such field, so the relative paths are
 * recorded under ``statistics.supporting_assets`` instead (string array,
 * JSON-safe).  The written CSV is byte-identical to the Python side table.
 */

import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { JsonValue } from "@biomed/contracts";
import type {
  AdapterParams,
  DataBatch,
  FieldMapping,
  SourceAsset,
} from "../../contracts/index.js";
import { parseDataBatch } from "../../contracts/index.js";
import {
  REJECTED_COLUMNS,
  SOURCE_LONG_COLUMNS,
  SourceAdapter,
  rowGranularityFor,
  type RowWriter,
} from "../adapters.js";
import { AdapterError, EmptySourceError } from "../errors.js";
import { assetIdFromSha256, makeRecordId } from "../identity.js";
import { sha256File } from "../hashing.js";
import { csvLine, delimitedRowsWithLines, parseDelimitedLine, readSourceText } from "../text.js";
import {
  parseGeoSeriesMatrixSamples,
  parseGeoSoftSamples,
  writeSampleMetadata,
} from "./sample-metadata.js";

/** Ensembl gene IDs (tximport output, or ENSG-shaped series/supplementary
 * ID_REF values); version suffixes tolerated like the canonicalizer. */
const ENSEMBL_PATTERN = /^ENSG\d{11}(?:\.\d+)?$/;

/** Informational measurement-type labels mirror the V1 GEO parsers. */
const MEASUREMENT_TYPE_BY_FORMAT: Record<AdapterParams["format"], string> = {
  tximport_counts: "tximport_estimated_count",
  series_matrix: "series_matrix_expression",
  supplementary_matrix: "supplementary_expression",
};

/** Python ``_declared_namespace``. */
export function declaredNamespace(geneIdRaw: string): string {
  return ENSEMBL_PATTERN.test(geneIdRaw) ? "ensembl_gene" : "geo_probe";
}

/** Python ``_namespace_summary``. */
function namespaceSummary(declared: ReadonlySet<string>): string {
  const values = [...declared];
  if (values.length === 1) return values[0];
  return `mixed_${values.sort().join("_")}`;
}

/** Python ``_sniff_delimiter``: CSV vs TSV only (never scale/semantics). */
function sniffDelimiter(line: string): string {
  return line.includes("\t") ? "\t" : ",";
}

/** Python ``math.isfinite(float(value))`` for a raw cell string. */
function isFiniteNumber(value: string): boolean {
  if (value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

/** Python ``_mapping`` (mirrors the base-class helper). */
function mapping(options: {
  mappingId: string;
  bindingId: string;
  sourceField: string;
  targetField: string;
  transform: string;
  evidence: string;
}): FieldMapping {
  return {
    schema_version: "1.0",
    mapping_id: `map_${options.bindingId}_${options.mappingId}`,
    source_schema_ref: `binding_${options.bindingId}.source`,
    target_schema_ref: "gene_expression.long.v1",
    source_field: options.sourceField,
    target_field: options.targetField,
    transform: options.transform,
    mapping_method: "adapter_declared",
    confidence_level: "high",
    evidence: options.evidence,
    review_status: "accepted",
  };
}

/** Python ``_wide_matrix_mappings`` (mirrors the base-class helper). */
function wideMatrixMappings(options: {
  bindingId: string;
  samples: readonly string[];
  geneEvidence: string;
  sampleEvidence: string;
}): FieldMapping[] {
  const mappings = [
    mapping({
      mappingId: "gene_id_to_raw",
      bindingId: options.bindingId,
      sourceField: "gene_id",
      targetField: "gene_id_raw",
      transform: "identity",
      evidence: options.geneEvidence,
    }),
  ];
  for (const sample of options.samples) {
    mappings.push(
      mapping({
        mappingId: `sample_id_${sample}`,
        bindingId: options.bindingId,
        sourceField: sample,
        targetField: "sample_id",
        transform: "wide_to_long_sample_id",
        evidence: options.sampleEvidence,
      }),
      mapping({
        mappingId: `value_${sample}`,
        bindingId: options.bindingId,
        sourceField: sample,
        targetField: "expression_value",
        transform: "wide_to_long_value",
        evidence: options.sampleEvidence,
      }),
    );
  }
  return mappings;
}

function longRow(options: {
  buildId: string;
  sourceAsset: SourceAsset;
  geneIdRaw: string;
  declared: string;
  sampleId: string;
  measurementType: string;
  parameters: AdapterParams;
  expressionValue: string;
  sourceName: string;
  line: number;
  column: number;
  columnName: string;
}): string[] {
  return [
    makeRecordId(options.buildId, options.geneIdRaw, options.sampleId),
    options.buildId,
    options.sourceAsset.source_id,
    options.sourceAsset.asset_id,
    options.geneIdRaw,
    options.declared,
    options.sampleId,
    options.measurementType,
    options.parameters.value_semantics,
    options.parameters.value_scale,
    String(options.parameters.is_normalized).toLowerCase(),
    String(!options.parameters.is_normalized).toLowerCase(),
    options.expressionValue,
    options.parameters.expression_unit,
    options.sourceName,
    String(options.line),
    String(options.column),
    options.columnName,
    options.expressionValue,
  ];
}

function rejectedRow(options: {
  batchId: string;
  geneIdRaw: string;
  sampleId: string;
  reasonCode: string;
  reason: string;
  sourceName: string;
  line: number;
  rawValue: string;
}): string[] {
  return [
    `rej_${options.batchId}_${options.line}`,
    options.batchId,
    options.geneIdRaw,
    options.sampleId,
    options.reasonCode,
    options.reason,
    options.sourceName,
    String(options.line),
    options.rawValue,
  ];
}

interface EmitCellsOptions {
  longWriter: RowWriter;
  rejectedWriter: RowWriter;
  batchId: string;
  sourceAsset: SourceAsset;
  buildId: string;
  sourceName: string;
  line: number;
  values: readonly string[];
  samples: readonly string[];
  sampleColumns: Readonly<Record<string, number>>;
  parameters: AdapterParams;
  measurementType: string;
  declared: string;
}

/** Python ``_emit_geo_cells``: one wide-matrix row -> long rows. */
function emitGeoCells(options: EmitCellsOptions): {
  emitted: number;
  rejected: number;
} {
  let emitted = 0;
  let rejected = 0;
  const geneIdRaw = options.values[0];
  for (const sampleId of options.samples) {
    const column = options.sampleColumns[sampleId];
    const raw = options.values[column];
    if (!isFiniteNumber(raw)) {
      options.rejectedWriter.writeRow(
        rejectedRow({
          batchId: options.batchId,
          geneIdRaw,
          sampleId,
          reasonCode: "non_finite_value",
          reason: `value=${JSON.stringify(raw)} is not a finite number`,
          sourceName: options.sourceName,
          line: options.line,
          rawValue: raw,
        }),
      );
      rejected += 1;
      continue;
    }
    options.longWriter.writeRow(
      longRow({
        buildId: options.buildId,
        sourceAsset: options.sourceAsset,
        geneIdRaw,
        declared: options.declared,
        sampleId,
        measurementType: options.measurementType,
        parameters: options.parameters,
        expressionValue: raw,
        sourceName: options.sourceName,
        line: options.line,
        column,
        columnName: sampleId,
      }),
    );
    emitted += 1;
  }
  return { emitted, rejected };
}

/** Python ``_statistics``. */
function geoStatistics(options: {
  parameters: AdapterParams;
  sampleCount: number;
  sourceRowCount: number;
  rowCount: number;
  declared: ReadonlySet<string>;
  sampleIds: readonly string[];
}): Record<string, JsonValue> {
  return {
    source_database: "geo",
    dataset_type: "gene_expression",
    format: options.parameters.format,
    sample_count: options.sampleCount,
    sample_ids: [...options.sampleIds],
    source_row_count: options.sourceRowCount,
    row_count: options.rowCount,
    source_gene_id_namespace: namespaceSummary(options.declared),
    value_semantics: options.parameters.value_semantics,
    value_scale: options.parameters.value_scale,
    expression_unit: options.parameters.expression_unit,
    is_normalized: options.parameters.is_normalized,
    platform_ids: [...options.parameters.platform_ids],
  };
}

interface GeoExtractContext {
  sourceAsset: SourceAsset;
  buildId: string;
  bindingId: string;
  sourceName: string;
  parameters: AdapterParams;
}

interface GeoExtractOutcome {
  statistics: Record<string, JsonValue>;
  warnings: string[];
  mappings: FieldMapping[];
  rejectedCount: number;
}

// ------------------------------------------------------------- tximport

function extractTximport(
  text: string,
  longWriter: RowWriter,
  rejectedWriter: RowWriter,
  context: GeoExtractContext,
): GeoExtractOutcome {
  const { sourceAsset, buildId, bindingId, sourceName, parameters } = context;
  const rows = delimitedRowsWithLines(text, "\t");
  let header: string[] | null = null;
  let dataStart = 0;
  for (const { values } of rows) {
    dataStart += 1;
    if (values.length === 0 || !values.some((value) => value !== "")) continue;
    header = values;
    break;
  }
  if (header === null) {
    throw new EmptySourceError("tximport counts file contains no header");
  }
  const countFields = header
    .map((name, index) => ({ index, name }))
    .filter(({ name }) => name.startsWith("counts."))
    .map(({ index, name }) => ({
      index,
      name,
      alias: name.split(".", 2)[1],
    }));
  if (countFields.length === 0) {
    throw new AdapterError(
      "tximport counts file must contain counts.<sample> columns",
    );
  }
  const samples = countFields.map(({ alias }) => alias);
  if (
    samples.some((sample) => sample === "") ||
    new Set(samples).size !== samples.length
  ) {
    throw new AdapterError(
      "tximport counts sample aliases must be non-blank and unique",
    );
  }
  const mappings = wideMatrixMappings({
    bindingId,
    samples,
    geneEvidence: "tximport counts gene column (first data column)",
    sampleEvidence: "tximport counts.<sample> column header",
  });
  const sampleColumns: Record<string, number> = {};
  for (const { index, alias } of countFields) {
    sampleColumns[alias] = index + 1;
  }
  let sourceRowCount = 0;
  let rowCount = 0;
  let rejectedCount = 0;
  const batchId = `batch_${bindingId}`;
  const declared = new Set<string>();
  for (let rowIndex = dataStart; rowIndex < rows.length; rowIndex += 1) {
    const { line, values } = rows[rowIndex];
    if (values.length !== header.length + 1) {
      throw new AdapterError(`source line ${line} has an unexpected field count`);
    }
    const geneIdRaw = values[0];
    if (geneIdRaw === "") {
      throw new AdapterError(`tximport gene id must not be blank (line ${line})`);
    }
    sourceRowCount += 1;
    declared.add("ensembl_gene");
    const { emitted, rejected } = emitGeoCells({
      longWriter,
      rejectedWriter,
      batchId,
      sourceAsset,
      buildId,
      sourceName,
      line,
      values,
      samples,
      sampleColumns,
      parameters,
      measurementType: MEASUREMENT_TYPE_BY_FORMAT.tximport_counts,
      declared: "ensembl_gene",
    });
    rowCount += emitted;
    rejectedCount += rejected;
  }
  if (sourceRowCount === 0) {
    throw new EmptySourceError("tximport counts file contains no data rows");
  }
  return {
    statistics: geoStatistics({
      parameters,
      sampleCount: samples.length,
      sourceRowCount,
      rowCount,
      declared,
      sampleIds: samples,
    }),
    warnings: [],
    mappings,
    rejectedCount,
  };
}

// ------------------------------------------------------- series matrix

function extractSeriesMatrix(
  text: string,
  longWriter: RowWriter,
  rejectedWriter: RowWriter,
  context: GeoExtractContext,
): GeoExtractOutcome {
  const { sourceAsset, buildId, bindingId, sourceName, parameters } = context;
  let inBlock = false;
  let header: string[] | null = null;
  let samples: string[] = [];
  const sampleColumns: Record<string, number> = {};
  let sourceRowCount = 0;
  let rowCount = 0;
  let rejectedCount = 0;
  const batchId = `batch_${bindingId}`;
  const declared = new Set<string>();
  let samplePlatforms: string[] = [];
  for (const { line, values } of delimitedRowsWithLines(text, "\t")) {
    if (!inBlock) {
      if (values[0]?.startsWith("!Sample_platform_id")) {
        samplePlatforms = values.slice(1).map((value) => value.trim());
      }
      if (values[0]?.startsWith("!series_matrix_table_begin")) {
        inBlock = true;
      }
      continue;
    }
    if (values[0]?.startsWith("!series_matrix_table_end")) break;
    if (header === null) {
      if (values.length === 0 || !values.some((value) => value !== "")) continue;
      header = values;
      samples = header.slice(1);
      if (header[0] === "") {
        throw new AdapterError(
          "series matrix probe column header must be non-blank",
        );
      }
      if (samples.length === 0 || samples.some((sample) => sample === "")) {
        throw new AdapterError("series matrix sample columns must be non-blank");
      }
      if (new Set(samples).size !== samples.length) {
        throw new AdapterError("series matrix sample columns must be unique");
      }
      samples.forEach((sample, index) => {
        sampleColumns[sample] = index + 1;
      });
      continue;
    }
    if (values.length === 0 || values.every((value) => value === "")) continue;
    if (values.length !== header.length) {
      throw new AdapterError(`source line ${line} has an unexpected field count`);
    }
    const geneIdRaw = values[0];
    if (geneIdRaw === "") {
      throw new AdapterError(`series matrix probe id must not be blank (line ${line})`);
    }
    sourceRowCount += 1;
    const namespace = declaredNamespace(geneIdRaw);
    declared.add(namespace);
    const { emitted, rejected } = emitGeoCells({
      longWriter,
      rejectedWriter,
      batchId,
      sourceAsset,
      buildId,
      sourceName,
      line,
      values,
      samples,
      sampleColumns,
      parameters,
      measurementType: MEASUREMENT_TYPE_BY_FORMAT.series_matrix,
      declared: namespace,
    });
    rowCount += emitted;
    rejectedCount += rejected;
  }
  if (!inBlock) {
    throw new AdapterError(
      "series matrix file has no !series_matrix_table_begin block",
    );
  }
  if (header === null) {
    throw new EmptySourceError(
      "series matrix expression block is empty (header-only)",
    );
  }
  if (sourceRowCount === 0) {
    throw new EmptySourceError("series matrix contains no data rows");
  }
  if (rowCount === 0) {
    throw new EmptySourceError("series matrix contains no valid expression rows");
  }
  const mappings = wideMatrixMappings({
    bindingId,
    samples,
    geneEvidence: "GEO series matrix ID_REF column header",
    sampleEvidence: "series matrix sample column header",
  });
  const statistics = geoStatistics({
    parameters,
    sampleCount: samples.length,
    sourceRowCount,
    rowCount,
    declared,
    sampleIds: samples,
  });
  if (
    samplePlatforms.length > 0 &&
    (samplePlatforms.length !== samples.length ||
      samplePlatforms.some((platform) => platform === ""))
  ) {
    throw new AdapterError(
      "series matrix sample platform metadata must cover every sample",
    );
  }
  if (samplePlatforms.length > 0) {
    const evidencedPlatforms = [...new Set(samplePlatforms)].sort();
    const declaredPlatforms = [...parameters.platform_ids].sort();
    if (
      declaredPlatforms.length > 0 &&
      JSON.stringify(declaredPlatforms) !== JSON.stringify(evidencedPlatforms)
    ) {
      throw new AdapterError(
        "declared platform_ids do not match !Sample_platform_id " +
          `evidence: declared=${JSON.stringify(declaredPlatforms)}, ` +
          `evidenced=${JSON.stringify(evidencedPlatforms)}`,
      );
    }
    statistics.platform_ids = evidencedPlatforms;
    const samplePlatformIds: Record<string, string> = {};
    samples.forEach((sampleId, index) => {
      samplePlatformIds[sampleId] = samplePlatforms[index];
    });
    statistics.sample_platform_ids = samplePlatformIds;
  }
  return {
    statistics,
    warnings: [],
    mappings,
    rejectedCount,
  };
}

// ------------------------------------------------- supplementary matrix

function extractSupplementary(
  text: string,
  longWriter: RowWriter,
  rejectedWriter: RowWriter,
  context: GeoExtractContext,
): GeoExtractOutcome {
  const { sourceAsset, buildId, bindingId, sourceName, parameters } = context;
  let delimiter = parameters.delimiter;
  let header: string[] | null = null;
  let samples: string[] = [];
  const sampleColumns: Record<string, number> = {};
  let sourceRowCount = 0;
  let rowCount = 0;
  let rejectedCount = 0;
  const batchId = `batch_${bindingId}`;
  const declared = new Set<string>();
  const lines = text.split(/\r\n|\n|\r/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineText = lines[lineIndex].replace(/\r$/, "");
    const line = lineIndex + 1;
    if (lineText.trim() === "") continue;
    if (header === null && delimiter === "auto") {
      delimiter = sniffDelimiter(lineText);
    }
    const values = parseDelimitedLine(lineText, delimiter);
    if (header === null) {
      header = values;
      samples = header.slice(1);
      if (header[0] === "") {
        throw new AdapterError(
          "supplementary probe column header must be non-blank",
        );
      }
      if (samples.length === 0 || samples.some((sample) => sample === "")) {
        throw new AdapterError(
          "supplementary sample columns must be non-blank",
        );
      }
      if (new Set(samples).size !== samples.length) {
        throw new AdapterError(
          "supplementary sample columns must be unique",
        );
      }
      samples.forEach((sample, index) => {
        sampleColumns[sample] = index + 1;
      });
      continue;
    }
    if (values.length !== header.length) {
      throw new AdapterError(`source line ${line} has an unexpected field count`);
    }
    const geneIdRaw = values[0];
    if (geneIdRaw === "") {
      throw new AdapterError(
        `supplementary probe id must not be blank (line ${line})`,
      );
    }
    sourceRowCount += 1;
    const namespace = declaredNamespace(geneIdRaw);
    declared.add(namespace);
    const { emitted, rejected } = emitGeoCells({
      longWriter,
      rejectedWriter,
      batchId,
      sourceAsset,
      buildId,
      sourceName,
      line,
      values,
      samples,
      sampleColumns,
      parameters,
      measurementType: MEASUREMENT_TYPE_BY_FORMAT.supplementary_matrix,
      declared: namespace,
    });
    rowCount += emitted;
    rejectedCount += rejected;
  }
  if (header === null) {
    throw new EmptySourceError("supplementary matrix file contains no header");
  }
  if (sourceRowCount === 0) {
    throw new EmptySourceError("supplementary matrix contains no data rows");
  }
  if (rowCount === 0) {
    throw new EmptySourceError(
      "supplementary matrix contains no valid expression rows",
    );
  }
  const mappings = wideMatrixMappings({
    bindingId,
    samples,
    geneEvidence: "supplementary expression matrix first column header",
    sampleEvidence: "supplementary matrix sample column header",
  });
  return {
    statistics: geoStatistics({
      parameters,
      sampleCount: samples.length,
      sourceRowCount,
      rowCount,
      declared,
      sampleIds: samples,
    }),
    warnings: [],
    mappings,
    rejectedCount,
  };
}

/** Dispatch on the typed ``AdapterParams.format`` (Python ``_extract``). */
function extractGeoText(
  text: string,
  longWriter: RowWriter,
  rejectedWriter: RowWriter,
  context: GeoExtractContext,
): GeoExtractOutcome {
  switch (context.parameters.format) {
    case "tximport_counts":
      return extractTximport(text, longWriter, rejectedWriter, context);
    case "series_matrix":
      return extractSeriesMatrix(text, longWriter, rejectedWriter, context);
    case "supplementary_matrix":
      return extractSupplementary(text, longWriter, rejectedWriter, context);
  }
}

export interface GeoParseOptions {
  buildId: string;
  bindingId: string;
  schemaRef: string;
  outputDir: string;
  parameters?: AdapterParams | null;
  /** Python ``metadata_path``: explicit SOFT metadata for tximport/suppl. */
  metadataPath?: string | null;
}

/**
 * GEO expression adapter (Python ``GeoExpressionAdapter``).
 *
 * Overrides ``parse`` so the raw source text is read once (gzip-aware) and
 * the supplementary extractor can sniff its delimiter per line; the base
 * class pre-splits every source with the tab delimiter.
 */
export class GeoExpressionAdapter extends SourceAdapter {
  readonly adapter_id = "geo.expression.v1";
  readonly version = "1.1.0";
  readonly source_database = "geo";

  parse(
    sourceAsset: SourceAsset,
    sourcePath: string,
    options: GeoParseOptions,
  ): DataBatch {
    const {
      buildId,
      bindingId,
      schemaRef,
      outputDir,
      metadataPath = null,
    } = options;
    const parameters = options.parameters ?? null;
    const digest = sha256File(sourcePath);
    if (digest !== sourceAsset.sha256) {
      throw new AdapterError(
        `source asset checksum mismatch before parsing: ${sourcePath}`,
      );
    }
    const sourceName = basename(sourcePath);
    const batchDir = join(outputDir, "batches");
    mkdirSync(batchDir, { recursive: true });
    const outputPath = join(batchDir, `${bindingId}.csv`);
    const rejectedPath = join(batchDir, `${bindingId}_rejected.csv`);
    const supportingPaths: string[] = [];
    const longRows: string[][] = [];
    const rejectedRows: string[][] = [];
    try {
      if (parameters === null) {
        throw new AdapterError(
          "geo.expression.v1 requires AdapterParams " +
            "(format/value_semantics/value_scale/expression_unit)",
        );
      }
      let text: string;
      try {
        text = readSourceText(sourcePath);
      } catch (error) {
        // A truncated gzip stream (or otherwise unreadable input) fails
        // closed as an AdapterError; the base parse removes any partial
        // batch files so the chain never consumes a truncated batch.
        throw new AdapterError(
          `could not read ${JSON.stringify(sourceName)}: truncated or ` +
            `unreadable input: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const { statistics, warnings, mappings, rejectedCount } = extractGeoText(
        text,
        { writeRow: (values) => longRows.push([...values]) },
        { writeRow: (values) => rejectedRows.push([...values]) },
        { sourceAsset, buildId, bindingId, sourceName, parameters },
      );
      const supporting = this.writeSupportingAssets({
        sourceText: text,
        metadataPath,
        outputDir,
        bindingId,
        parameters,
        statistics,
      });
      supportingPaths.push(...supporting.paths);
      warnings.push(...supporting.warnings);
      const longContent =
        csvLine([...SOURCE_LONG_COLUMNS]) +
        longRows.map((row) => csvLine(row)).join("");
      const rejectedContent =
        csvLine([...REJECTED_COLUMNS]) +
        rejectedRows.map((row) => csvLine(row)).join("");
      writeFileSync(outputPath, longContent, "utf8");
      writeFileSync(rejectedPath, rejectedContent, "utf8");
      const checksum = sha256File(outputPath);
      const rowCount =
        typeof statistics.row_count === "number" ? statistics.row_count : 0;
      const fileAsset = {
        schema_version: "1.0",
        asset_id: assetIdFromSha256(checksum),
        kind: "parsed",
        relative_path: `batches/${bindingId}.csv`,
        sha256: checksum,
        size_bytes: statSync(outputPath).size,
        media_type: "text/csv",
        generated_by_step_id: `step_${this.adapter_id}`,
      } as const;
      return parseDataBatch({
        schema_version: "1.0",
        batch_id: `batch_${bindingId}`,
        binding_id: bindingId,
        dataset_family: "gene_expression",
        row_granularity: rowGranularityFor(schemaRef),
        schema_ref: schemaRef,
        file_asset: fileAsset,
        row_count: rowCount,
        column_count: SOURCE_LONG_COLUMNS.length,
        parser_id: this.adapter_id,
        parser_version: this.version,
        statistics: {
          ...statistics,
          row_count: rowCount,
          rejected_count: rejectedCount,
          supporting_assets: supportingPaths.map((supportingPath) =>
            relative(outputDir, supportingPath).replace(/\\/g, "/"),
          ),
        },
        warnings,
        declared_mappings: mappings,
      });
    } catch (error) {
      for (const pathToUnlink of [outputPath, rejectedPath, ...supportingPaths]) {
        try {
          unlinkSync(pathToUnlink);
        } catch {
          // ignore missing partial output
        }
      }
      throw error;
    }
  }

  /** Python ``_write_supporting_assets``. */
  private writeSupportingAssets(options: {
    sourceText: string;
    metadataPath: string | null;
    outputDir: string;
    bindingId: string;
    parameters: AdapterParams;
    statistics: Record<string, JsonValue>;
  }): { paths: string[]; warnings: string[] } {
    const { sourceText, metadataPath, outputDir, bindingId, parameters, statistics } =
      options;
    let samples: ReturnType<typeof parseGeoSoftSamples>["samples"];
    let warnings: string[];
    if (metadataPath !== null) {
      ({ samples, warnings } = parseGeoSoftSamples(readSourceText(metadataPath)));
    } else if (parameters.format === "series_matrix") {
      ({ samples, warnings } = parseGeoSeriesMatrixSamples(sourceText));
    } else {
      return { paths: [], warnings: [] };
    }
    if (samples.length === 0) {
      if (metadataPath !== null) {
        throw new AdapterError("GEO metadata contains no SAMPLE records");
      }
      return { paths: [], warnings };
    }
    const sampleIds = Array.isArray(statistics.sample_ids)
      ? statistics.sample_ids.map(String)
      : [];
    const expectedSamples = new Set(sampleIds);
    const observedSamples = new Set(
      samples.map((sample) => sample.source_sample_alias ?? sample.sample_id),
    );
    if (
      expectedSamples.size !== observedSamples.size ||
      [...expectedSamples].some((sampleId) => !observedSamples.has(sampleId))
    ) {
      throw new AdapterError(
        "GEO metadata sample IDs do not match expression sample IDs: " +
          `metadata=${JSON.stringify([...observedSamples].sort())}, ` +
          `expression=${JSON.stringify([...expectedSamples].sort())}`,
      );
    }
    const supportingPath = join(
      outputDir,
      "supporting",
      `${bindingId}_sample_metadata.csv`,
    );
    writeSampleMetadata(supportingPath, samples);
    return { paths: [supportingPath], warnings };
  }

  /**
   * Base-class parse path: reconstruct the raw text from tab-split rows
   * (lossless for tab formats; supplementary comma/semicolon lines arrive as
   * single fields and are re-split by the extractor).
   */
  protected extract(
    rows: ReturnType<typeof delimitedRowsWithLines>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: {
      sourceAsset: SourceAsset;
      buildId: string;
      bindingId: string;
      sourceName: string;
      parameters: AdapterParams | null;
    },
  ): {
    statistics: Record<string, JsonValue>;
    warnings: string[];
    mappings: FieldMapping[];
    rejectedCount: number;
  } {
    if (context.parameters === null) {
      throw new AdapterError(
        "geo.expression.v1 requires AdapterParams " +
          "(format/value_semantics/value_scale/expression_unit)",
      );
    }
    const text = rows.map((row) => row.values.join("\t")).join("\n");
    const { statistics, warnings, mappings, rejectedCount } = extractGeoText(
      text,
      longWriter,
      rejectedWriter,
      {
        sourceAsset: context.sourceAsset,
        buildId: context.buildId,
        bindingId: context.bindingId,
        sourceName: context.sourceName,
        parameters: context.parameters,
      },
    );
    return { statistics, warnings, mappings, rejectedCount };
  }
}

export const geoExpressionAdapter = new GeoExpressionAdapter();
