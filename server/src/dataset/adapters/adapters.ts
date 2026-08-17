/**
 * SourceAdapters: source format -> DataBatch (ARCHITECTURE §2 parse[*]).
 *
 * Port of ``backend/app/datasets/build/adapters.py`` (migration plan Phase 4
 * step 4). An Adapter is the deterministic, fail-closed parser for one source
 * format: it verifies the SourceAsset checksum, understands the source layout
 * (wide matrix or single-sample STAR counts), validates every cell, and
 * streams a *source-long* table plus parse-level rejected rows. The GDC and
 * Xena adapters are ported here; the GEO adapter is registered statically and
 * imports the shared base module rather than this registry, keeping ESM startup
 * free of a top-level-await cycle.
 *
 * Numeric policy (uniform across adapters): structural malformation (wrong
 * field count, bad header, blank gene id) is fatal and fail-closed; a value
 * cell that is not a finite number (blank, ``nan``, ``inf``, garbage) is
 * rejected row-level into the audit file — never silently accepted, never
 * aborting the whole source.
 */

import type { JsonValue } from "@biomed/contracts";
import type {
  AdapterParams,
  FieldMapping,
  SourceAsset,
  SourceBinding,
} from "../contracts/index.js";
import { parseAdapterParams } from "../contracts/index.js";
import { CHECKPOINT_STRIDE, checkpoint } from "../cooperative.js";
import {
  SourceAdapter,
  type ExtractContext,
  type ExtractResult,
  type RowWriter,
} from "./base.js";
import { AdapterError, BuildError, EmptySourceError } from "./errors.js";
import { geoExpressionAdapter } from "./geo/index.js";
import { makeRecordId } from "./identity.js";
import { type DelimitedRow } from "./text.js";

export {
  REJECTED_COLUMNS,
  SOURCE_LONG_COLUMNS,
  SourceAdapter,
  rowGranularityFor,
  type RowWriter,
} from "./base.js";

// GDC files-API expression exports may carry annotation columns next to the
// gene_id column; they are not samples and must not become long-format rows.
const GDC_ANNOTATION_COLUMNS = new Set([
  "gene_name",
  "gene_type",
  "gene_version",
  "gene_id_version",
]);

/** Python ``math.isfinite(float(value))`` for a raw cell string. */
function isFiniteNumber(value: string): boolean {
  if (value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

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

/** Declared mappings for a wide expression matrix (gene_id + samples). */
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
    );
    mappings.push(
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

function rejectedRecord(options: {
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

function longRow(options: {
  buildId: string;
  sourceAsset: SourceAsset;
  geneIdRaw: string;
  sampleId: string;
  measurementType: string;
  valueSemantics: string;
  valueScale: string;
  isNormalized: boolean;
  isIntegerExpected: boolean;
  expressionValue: string;
  expressionUnit: string;
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
    // Python _long_row omits gene_id_namespace_declared; DictWriter writes "".
    "",
    options.sampleId,
    options.measurementType,
    options.valueSemantics,
    options.valueScale,
    String(options.isNormalized).toLowerCase(),
    String(options.isIntegerExpected).toLowerCase(),
    options.expressionValue,
    options.expressionUnit,
    options.sourceName,
    String(options.line),
    String(options.column),
    options.columnName,
    options.expressionValue,
  ];
}

/** Emit long rows for one wide-matrix row; returns (emitted, rejected). */
function emitMatrixCells(options: {
  longWriter: RowWriter;
  rejectedWriter: RowWriter;
  batchId: string;
  sourceAsset: SourceAsset;
  buildId: string;
  sourceName: string;
  line: number;
  values: readonly string[];
  header: readonly string[];
  samples: readonly string[];
}): { emitted: number; rejected: number } {
  let emitted = 0;
  let rejected = 0;
  const geneIdRaw = options.values[0];
  for (const sampleId of options.samples) {
    const column = options.header.indexOf(sampleId);
    const raw = options.values[column];
    if (!isFiniteNumber(raw)) {
      options.rejectedWriter.writeRow(
        rejectedRecord({
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
        sampleId,
        measurementType: "gene_expression",
        valueSemantics: "expression_value",
        valueScale: "linear",
        isNormalized: false,
        isIntegerExpected: false,
        expressionValue: raw,
        expressionUnit: "expression_value",
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

/** Build typed AdapterParams from a binding's declared parameters. */
export function adapterParamsForBinding(binding: SourceBinding): AdapterParams | null {
  const parameters = binding.parameters;
  if (parameters === undefined || Object.keys(parameters).length === 0) {
    return null;
  }
  try {
    return parseAdapterParams(parameters);
  } catch (error) {
    throw new BuildError(
      `binding ${binding.binding_id} has invalid adapter parameters: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function nextHeaderAsync(
  rows: AsyncIterable<DelimitedRow>,
): Promise<{ headerLine: number; header: string[] }> {
  const iterator = rows[Symbol.asyncIterator]();
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) break;
    const { line, values } = value;
    if (values.length === 0 || !values.some((item) => item.length > 0)) {
      continue;
    }
    if (values[0].startsWith("#")) continue;
    if (
      values.length < 2 ||
      !["gene_id", "gene", "gene_id_raw"].includes(values[0].toLowerCase())
    ) {
      throw new AdapterError(
        `expression table must start with gene_id and value columns (line ${line})`,
      );
    }
    return { headerLine: line, header: values };
  }
  throw new AdapterError("expression table contains no header");
}

/** Parses GDC gene-expression TSV files (matrix or STAR-counts layout). */
export class GdcExpressionAdapter extends SourceAdapter {
  readonly adapter_id = "gdc.expression.v1";
  readonly version = "1.0.0";
  readonly source_database = "gdc";

  protected async extract(
    rows: AsyncIterable<DelimitedRow>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: ExtractContext,
    signal?: AbortSignal | null,
  ): Promise<ExtractResult> {
    const { headerLine, header } = await nextHeaderAsync(rows);
    if (
      header.includes("gene_name") &&
      (header.includes("tpm_unstranded") || header.includes("unstranded"))
    ) {
      return this.extractStarCounts(rows, longWriter, rejectedWriter, {
        ...context,
        headerLine,
        header,
      }, signal);
    }
    return this.extractMatrix(rows, longWriter, rejectedWriter, {
      ...context,
      headerLine,
      header,
    }, signal);
  }

  private async extractMatrix(
    rows: AsyncIterable<DelimitedRow>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: ExtractContext & { headerLine: number; header: string[] },
    signal?: AbortSignal | null,
  ): Promise<ExtractResult> {
    const { headerLine, header, sourceAsset, buildId, bindingId, sourceName } = context;
    const samples = header
      .slice(1)
      .filter((column) => !GDC_ANNOTATION_COLUMNS.has(column));
    if (
      samples.length === 0 ||
      new Set(samples).size !== samples.length ||
      samples.some((sample) => sample.length === 0)
    ) {
      throw new AdapterError(
        "GDC expression sample columns must be non-empty and unique",
      );
    }
    const mappings = wideMatrixMappings({
      bindingId,
      samples,
      geneEvidence: "GDC files API: gene_id column header",
      sampleEvidence: "matrix sample column header",
    });
    let sourceRowCount = 0;
    let rowCount = 0;
    let rejectedCount = 0;
    let visited = 0;
    const batchId = `batch_${bindingId}`;
    for await (const { line, values } of rows) {
      if (line <= headerLine) continue;
      if (values.length !== header.length || values[0].length === 0) {
        throw new AdapterError(`invalid GDC expression row at line ${line}`);
      }
      sourceRowCount += 1;
      const { emitted, rejected } = emitMatrixCells({
        longWriter,
        rejectedWriter,
        batchId,
        sourceAsset,
        buildId,
        sourceName,
        line,
        values,
        header,
        samples,
      });
      rowCount += emitted;
      rejectedCount += rejected;
      visited += 1;
      if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
    }
    if (sourceRowCount === 0) {
      throw new EmptySourceError("GDC expression TSV contains no data rows");
    }
    const statistics: Record<string, JsonValue> = {
      source_database: this.source_database,
      extraction_channel: "official_api",
      dataset_type: "gene_expression",
      format: "expression_matrix",
      sample_count: samples.length,
      source_row_count: sourceRowCount,
      row_count: rowCount,
    };
    return { statistics, warnings: [], mappings, rejectedCount };
  }

  private async extractStarCounts(
    rows: AsyncIterable<DelimitedRow>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: ExtractContext & { headerLine: number; header: string[] },
    signal?: AbortSignal | null,
  ): Promise<ExtractResult> {
    const { headerLine, header, sourceAsset, buildId, bindingId, sourceName } = context;
    if (new Set(header).size !== header.length) {
      throw new AdapterError("GDC STAR-counts columns must be unique");
    }
    const metric = header.includes("tpm_unstranded") ? "tpm_unstranded" : "unstranded";
    const metricColumn = header.indexOf(metric);
    const sampleId = sourceName.split(".", 1)[0];
    const mappings = [
      mapping({
        mappingId: "gene_id_to_raw",
        bindingId,
        sourceField: "gene_id",
        targetField: "gene_id_raw",
        transform: "identity",
        evidence: "GDC STAR-counts gene_id column",
      }),
      mapping({
        mappingId: "metric_to_value",
        bindingId,
        sourceField: metric,
        targetField: "expression_value",
        transform: "column_value",
        evidence: "GDC STAR-counts metric column",
      }),
      mapping({
        mappingId: "filename_to_sample",
        bindingId,
        sourceField: "filename",
        targetField: "sample_id",
        transform: "filename_sample",
        evidence: "GDC STAR-counts file naming (one sample per file)",
      }),
    ];
    const isTpm = metric === "tpm_unstranded";
    const semantics = isTpm ? "normalized_expression" : "raw_count";
    let sourceRowCount = 0;
    let rowCount = 0;
    let rejectedCount = 0;
    let visited = 0;
    const batchId = `batch_${bindingId}`;
    for await (const { line, values } of rows) {
      if (line <= headerLine) continue;
      if (values.length === 0 || !values.some((value) => value.length > 0)) continue;
      if (values.length !== header.length) {
        throw new AdapterError(`invalid GDC STAR-counts row at line ${line}`);
      }
      const geneIdRaw = values[0];
      if (!geneIdRaw.startsWith("ENSG")) {
        rejectedWriter.writeRow(
          rejectedRecord({
            batchId,
            geneIdRaw,
            sampleId,
            reasonCode: "non_ensg_annotation_row",
            reason:
              "STAR-counts rows outside the ENSG namespace are annotation rows, not genes",
            sourceName,
            line,
            rawValue: geneIdRaw,
          }),
        );
        rejectedCount += 1;
        continue;
      }
      const raw = values[metricColumn];
      if (!isFiniteNumber(raw)) {
        rejectedWriter.writeRow(
          rejectedRecord({
            batchId,
            geneIdRaw,
            sampleId,
            reasonCode: "non_finite_value",
            reason: `value=${JSON.stringify(raw)} is not a finite number`,
            sourceName,
            line,
            rawValue: raw,
          }),
        );
        rejectedCount += 1;
        continue;
      }
      longWriter.writeRow(
        longRow({
          buildId,
          sourceAsset,
          geneIdRaw,
          sampleId,
          measurementType: "gene_expression",
          valueSemantics: semantics,
          valueScale: "linear",
          isNormalized: isTpm,
          isIntegerExpected: !isTpm,
          expressionValue: raw,
          expressionUnit: metric,
          sourceName,
          line,
          column: metricColumn,
          columnName: metric,
        }),
      );
      sourceRowCount += 1;
      rowCount += 1;
      visited += 1;
      if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
    }
    if (sourceRowCount === 0) {
      throw new EmptySourceError("GDC STAR-counts TSV contains no data rows");
    }
    const statistics: Record<string, JsonValue> = {
      source_database: this.source_database,
      extraction_channel: "official_api",
      dataset_type: "gene_expression",
      format: "star_counts",
      sample_count: 1,
      source_row_count: sourceRowCount,
      row_count: rowCount,
    };
    return { statistics, warnings: [], mappings, rejectedCount };
  }
}

/** Parses UCSC Xena gene-expression matrices. */
export class XenaMatrixAdapter extends SourceAdapter {
  readonly adapter_id = "xena.matrix.v1";
  readonly version = "1.0.0";
  readonly source_database = "ucsc_xena";

  protected async extract(
    rows: AsyncIterable<DelimitedRow>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: ExtractContext,
    signal?: AbortSignal | null,
  ): Promise<ExtractResult> {
    const { headerLine, header } = await nextHeaderAsync(rows);
    const { sourceAsset, buildId, bindingId, sourceName } = context;
    const samples = header.slice(1);
    if (samples.length === 0 || samples.some((sample) => sample.length === 0)) {
      throw new AdapterError("Xena matrix sample headers must not be blank");
    }
    if (new Set(samples).size !== samples.length) {
      throw new AdapterError("Xena matrix sample headers must be unique");
    }
    const mappings = wideMatrixMappings({
      bindingId,
      samples,
      geneEvidence: "Xena matrix gene_id column header",
      sampleEvidence: "matrix sample column header",
    });
    let sourceRowCount = 0;
    let rowCount = 0;
    let rejectedCount = 0;
    let visited = 0;
    const batchId = `batch_${bindingId}`;
    for await (const { line, values } of rows) {
      if (line <= headerLine) continue;
      if (values.length === 0 || !values.some((value) => value.length > 0)) continue;
      if (values.length !== header.length) {
        throw new AdapterError(`source line ${line} has an unexpected field count`);
      }
      const geneIdRaw = values[0];
      if (geneIdRaw.length === 0) {
        throw new AdapterError("Xena matrix gene_id must not be blank");
      }
      sourceRowCount += 1;
      const { emitted, rejected } = emitMatrixCells({
        longWriter,
        rejectedWriter,
        batchId,
        sourceAsset,
        buildId,
        sourceName,
        line,
        values,
        header,
        samples,
      });
      rowCount += emitted;
      rejectedCount += rejected;
      visited += 1;
      if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
    }
    if (sourceRowCount === 0) {
      throw new EmptySourceError("Xena matrix contains no data rows");
    }
    const statistics: Record<string, JsonValue> = {
      source_database: this.source_database,
      extraction_channel: "official_api",
      dataset_type: "gene_expression",
      format: "expression_matrix",
      sample_count: samples.length,
      source_row_count: sourceRowCount,
      row_count: rowCount,
    };
    return { statistics, warnings: [], mappings, rejectedCount };
  }
}

const gdcAdapter = new GdcExpressionAdapter();
const xenaAdapter = new XenaMatrixAdapter();

export const ADAPTER_REGISTRY: Readonly<Record<string, SourceAdapter>> = {
  [gdcAdapter.adapter_id]: gdcAdapter,
  [xenaAdapter.adapter_id]: xenaAdapter,
  [geoExpressionAdapter.adapter_id]: geoExpressionAdapter,
};

export function getAdapter(adapterId: string): SourceAdapter {
  const adapter = ADAPTER_REGISTRY[adapterId];
  if (adapter === undefined) {
    throw new AdapterError(`unknown source adapter: ${adapterId}`);
  }
  return adapter;
}
