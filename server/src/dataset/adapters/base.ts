/** Shared adapter primitives kept separate from the GEO registry import graph. */

import { appendFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

import type { JsonValue } from "@biomed/contracts";

import type {
  AdapterParams,
  DataBatch,
  FieldMapping,
  SourceAsset,
} from "../contracts/index.js";
import { parseDataBatch } from "../contracts/index.js";
import { throwIfAborted } from "../cooperative.js";
import { AdapterError } from "./errors.js";
import { sha256FileStream } from "./hashing.js";
import { assetIdFromSha256, makeRecordId } from "./identity.js";
import {
  parseExpressionAdapterIdentityContext,
  type ExpressionAdapterIdentityContext,
} from "./identity-context.js";
import {
  csvLine,
  delimitedRowsFromFileAsync,
  type DelimitedRow,
} from "./text.js";

/** Source-long layout emitted by every expression adapter (Python mirror). */
export const SOURCE_LONG_COLUMNS: readonly string[] = [
  "record_id",
  "dataset_id",
  "source_id",
  "asset_id",
  "gene_id_raw",
  "gene_id_namespace_declared",
  "sample_id",
  "measurement_type",
  "value_semantics",
  "value_scale",
  "is_normalized",
  "is_integer_expected",
  "expression_value",
  "expression_unit",
  "source_logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "source_raw_value",
];

/** Explicit revision-scoped source-long layout. V1 remains unchanged. */
export const SOURCE_LONG_COLUMNS_V2: readonly string[] = [
  "record_id",
  "dataset_id",
  "dataset_revision_id",
  ...SOURCE_LONG_COLUMNS.slice(2),
];

export function sourceLongColumns(
  identityContext: ExpressionAdapterIdentityContext | null,
): readonly string[] {
  return identityContext === null ? SOURCE_LONG_COLUMNS : SOURCE_LONG_COLUMNS_V2;
}

export function sourceLongIdentityValues(options: {
  identityContext: ExpressionAdapterIdentityContext | null;
  buildId: string;
  sourceAsset: SourceAsset;
  geneIdRaw: string;
  sampleId: string;
}): string[] {
  if (options.identityContext === null) {
    return [
      makeRecordId(options.buildId, options.geneIdRaw, options.sampleId),
      options.buildId,
      options.sourceAsset.source_id,
      options.sourceAsset.asset_id,
    ];
  }
  const context = options.identityContext;
  if (context.sourceAssetId !== options.sourceAsset.asset_id) {
    throw new AdapterError("expression identity source asset does not match parse input");
  }
  return [
    makeRecordId(context.datasetRevisionId, options.geneIdRaw, options.sampleId),
    context.datasetId,
    context.datasetRevisionId,
    options.sourceAsset.source_id,
    options.sourceAsset.asset_id,
  ];
}

/** Parse-level rejection audit row shape (Python mirror). */
export const REJECTED_COLUMNS: readonly string[] = [
  "rejected_id",
  "batch_id",
  "gene_id_raw",
  "sample_id",
  "reason_code",
  "reason",
  "source_logical_file",
  "source_line_number",
  "source_raw_value",
];

export interface RowWriter {
  writeRow(values: readonly string[]): void;
}

/** Rows buffered before a sync append; bounds memory for large matrices. */
const CSV_WRITER_FLUSH_ROWS = 8192;

/**
 * Bounded-memory CSV writer implementing the synchronous RowWriter contract.
 *
 * Extractors emit rows one at a time; accumulating every row and joining
 * once (the pre-fix behavior) allocates multi-gigabyte heaps for large
 * matrices and blocks the event loop for the whole join. This writer appends
 * the header plus rows in bounded chunks instead, so peak memory stays flat
 * and the cooperative checkpoints in extraction loops keep firing.
 *
 * The output file is always overwritten (any stale partial file from an
 * interrupted attempt is removed first), matching the plain ``writeFile``
 * semantics the pipeline had before streaming writes were introduced.
 */
export class BufferedCsvWriter implements RowWriter {
  private readonly buffer: string[] = [];
  private readonly flushAt: number;

  constructor(
    private readonly outputPath: string,
    header: readonly string[],
    flushAt: number = CSV_WRITER_FLUSH_ROWS,
  ) {
    try {
      unlinkSync(outputPath);
    } catch {
      // fresh output: nothing to remove
    }
    this.buffer.push(csvLine(header));
    this.flushAt = flushAt;
  }

  writeRow(values: readonly string[]): void {
    this.buffer.push(csvLine(values));
    if (this.buffer.length >= this.flushAt) {
      this.appendBuffer();
    }
  }

  /** Append any buffered rows so the file reaches its final state. */
  flush(): void {
    if (this.buffer.length > 0) {
      this.appendBuffer();
    }
  }

  /** Alias of ``flush`` for callers that finalize with a ``close`` step. */
  close(): void {
    this.flush();
  }

  private appendBuffer(): void {
    appendFileSync(this.outputPath, this.buffer.join(""), "utf8");
    this.buffer.length = 0;
  }
}

export interface ExtractContext {
  sourceAsset: SourceAsset;
  buildId: string;
  bindingId: string;
  sourceName: string;
  parameters: AdapterParams | null;
  identityContext: ExpressionAdapterIdentityContext | null;
  schemaRef: string;
}

export interface ExtractResult {
  statistics: Record<string, JsonValue>;
  warnings: string[];
  mappings: FieldMapping[];
  rejectedCount: number;
}

async function verifySha256(
  path: string,
  expected: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const digest = await sha256FileStream(path, signal);
  if (digest !== expected) {
    throw new AdapterError(`source asset checksum mismatch before parsing: ${path}`);
  }
}

/** Map the target schema to the parsed row granularity (Python mirror). */
export function rowGranularityFor(schemaRef: string): string {
  return schemaRef === "gene_expression.probe_long.v1" || schemaRef === "gene_expression.probe_long.v2"
    ? "probe_sample_measurement"
    : "gene_sample_measurement";
}

/** Base class for expression source adapters (fail closed). */
export abstract class SourceAdapter {
  abstract readonly adapter_id: string;
  abstract readonly version: string;
  abstract readonly source_database: string;

  async parse(
    sourceAsset: SourceAsset,
    sourcePath: string,
    options: {
      buildId: string;
      bindingId: string;
      schemaRef: string;
      outputDir: string;
      parameters?: AdapterParams | null;
      /** Core-derived identity capability required by expression V2. */
      identityContext?: ExpressionAdapterIdentityContext | null;
      /** Task-relative filesystem path of an explicit metadata asset (e.g.
       * GEO SOFT ``metadata_files``); adapters that do not consume it ignore
       * the field. */
      metadataPath?: string | null;
      signal?: AbortSignal | null;
    },
  ): Promise<DataBatch> {
    const { buildId, bindingId, schemaRef, outputDir } = options;
    const parameters = options.parameters ?? null;
    const identityContext = schemaRef.endsWith(".v2")
      ? parseExpressionAdapterIdentityContext(options.identityContext)
      : options.identityContext === undefined || options.identityContext === null
        ? null
        : (() => {
            throw new AdapterError("V1 expression adapters cannot receive V2 identity context");
          })();
    if (identityContext !== null && identityContext.schemaRef !== schemaRef) {
      throw new AdapterError(
        `expression identity schemaRef does not match parse schemaRef: ${identityContext.schemaRef} != ${schemaRef}`,
      );
    }
    const signal = options.signal ?? null;
    await verifySha256(sourcePath, sourceAsset.sha256, signal);
    throwIfAborted(signal);
    const sourceName = basename(sourcePath);
    const batchDir = join(outputDir, "batches");
    mkdirSync(batchDir, { recursive: true });
    const outputPath = join(batchDir, `${bindingId}.csv`);
    const rejectedPath = join(batchDir, `${bindingId}_rejected.csv`);
    const longWriter = new BufferedCsvWriter(outputPath, sourceLongColumns(identityContext));
    const rejectedWriter = new BufferedCsvWriter(rejectedPath, REJECTED_COLUMNS);
    try {
      const rows = delimitedRowsFromFileAsync(sourcePath, "\t", signal);
      const { statistics, warnings, mappings, rejectedCount } = await this.extract(
        rows,
        longWriter,
        rejectedWriter,
        { sourceAsset, buildId, bindingId, sourceName, parameters, identityContext, schemaRef },
        signal,
      );
      longWriter.flush();
      rejectedWriter.flush();
      const checksum = await sha256FileStream(outputPath, signal);
      const rowCount = typeof statistics.row_count === "number" ? statistics.row_count : 0;
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
        column_count: sourceLongColumns(identityContext).length,
        parser_id: this.adapter_id,
        parser_version: this.version,
        statistics: {
          ...statistics,
          row_count: rowCount,
          rejected_count: rejectedCount,
          ...(identityContext === null ? {} : {
            dataset_id: identityContext.datasetId,
            dataset_revision_id: identityContext.datasetRevisionId,
            carrier_asset_ids: [...identityContext.carrierAssetIds],
          }),
        },
        warnings,
        declared_mappings: mappings,
      });
    } catch (error) {
      try {
        unlinkSync(outputPath);
      } catch {
        // ignore missing partial output
      }
      try {
        unlinkSync(rejectedPath);
      } catch {
        // ignore missing partial output
      }
      throw error;
    }
  }

  protected abstract extract(
    rows: AsyncIterable<DelimitedRow>,
    longWriter: RowWriter,
    rejectedWriter: RowWriter,
    context: ExtractContext,
    signal?: AbortSignal | null,
  ): Promise<ExtractResult>;
}
