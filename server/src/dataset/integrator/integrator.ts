/**
 * Integrator: explicit append + dedup of canonical sources (Design §8.8;
 * Python ``backend/app/datasets/build/integrator.py``).
 *
 * Only the server-side ``append_by_canonical_row`` strategy is accepted; an
 * Agent cannot inject arbitrary merge logic.  Canonical row identity is
 * ``(gene_id, sample_id, measurement_type, value_semantics)``.  Mirror rows
 * (identical identity and numerically equal value) are deduplicated; rows
 * with the same identity but conflicting values keep the first source
 * deterministically and are recorded in a conflicts audit file.
 */

import { mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { JsonValue } from "@biomed/contracts";
import type { CanonicalizationResult } from "../canonicalizer/index.js";
import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import { BuildError } from "../adapters/errors.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { assetIdFromSha256 } from "../adapters/identity.js";
import { csvLine, delimitedRowsWithLinesAsync, readSourceTextAsync } from "../adapters/text.js";
import type { DataBatch, DatasetSchema, FileAsset } from "../contracts/index.js";
import { parseDataBatch, parseFileAsset } from "../contracts/index.js";

export const MERGE_STRATEGY_APPEND = "append_by_canonical_row";

export const CONFLICT_COLUMNS = [
  "conflict_id",
  "gene_id",
  "sample_id",
  "measurement_type",
  "value_semantics",
  "first_source_asset_id",
  "first_value",
  "second_source_asset_id",
  "second_value",
  "action",
] as const;

/** Unsupported merge strategy or zero sources (Python ``IntegratorError``). */
export class IntegratorError extends BuildError {}

/** Merged primary dataset batch plus merge audit counts. */
export interface IntegrationResult {
  batch: DataBatch;
  mergedPath: string;
  rowCount: number;
  dedupCount: number;
  conflictCount: number;
  conflictsPath: string | null;
}

/** Append canonical sources into one primary dataset, dedup by row identity. */
export async function integrate(options: {
  results: readonly CanonicalizationResult[];
  mergeStrategy: string;
  schema: DatasetSchema;
  buildId: string;
  outputDir: string;
  signal?: AbortSignal | null;
}): Promise<IntegrationResult> {
  const { results, mergeStrategy, schema, buildId, outputDir, signal } = options;
  throwIfAborted(signal);
  if (mergeStrategy !== MERGE_STRATEGY_APPEND) {
    throw new IntegratorError(
      `unsupported merge strategy ${mergeStrategy}; ` +
        `server allows only ${MERGE_STRATEGY_APPEND}`,
    );
  }
  if (results.length === 0) {
    throw new IntegratorError("cannot integrate zero sources");
  }
  const mergedDir = join(outputDir, "merged");
  mkdirSync(mergedDir, { recursive: true });
  const mergedPath = join(mergedDir, "primary.csv");
  const conflictsPath = join(mergedDir, "conflicts.csv");

  const columns = schema.fields.map((field) => field.name);
  // Phase 5 T7: the probe contract keys rows by probe_id (no gene_id
  // column); row identity follows the schema's entity identifier.
  const idField = schema.fields.some((field) => field.name === "probe_id")
    ? "probe_id"
    : "gene_id";
  const seen = new Map<string, [value: string, assetId: string]>();
  let rowCount = 0;
  let dedupCount = 0;
  let conflictCount = 0;

  const mergedLines: string[] = [csvLine(columns)];
  const conflictLines: string[] = [csvLine(CONFLICT_COLUMNS)];
  let visited = 0;
  for (const result of results) {
    const rows = await readCsvDictRows(result.canonicalPath, signal);
    for (const row of rows) {
      const keyParts = rowIdentity(row, idField);
      const key = keyParts.join("\u0000");
      const value = row["expression_value"] ?? "";
      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, [value, row["asset_id"] ?? ""]);
        mergedLines.push(csvLine(columns.map((column) => row[column] ?? "")));
        rowCount += 1;
        visited += 1;
        if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
        continue;
      }
      const [previousValue, previousAsset] = previous;
      if (numericallyEqual(previousValue, value)) {
        dedupCount += 1;
        continue;
      }
      conflictLines.push(
        csvLine([
          `conflict_${keyParts[0]}_${keyParts[1]}_${rowCount}`,
          keyParts[0],
          keyParts[1],
          keyParts[2],
          keyParts[3],
          previousAsset,
          previousValue,
          row["asset_id"] ?? "",
          value,
          "kept_first_source",
        ]),
      );
      conflictCount += 1;
    }
  }
  await writeFile(mergedPath, mergedLines.join(""), "utf8");
  await writeFile(conflictsPath, conflictLines.join(""), "utf8");

  const payloadChecksum = await sha256FileStream(mergedPath, signal);
  const fileAsset: FileAsset = parseFileAsset({
    schema_version: "1.0",
    asset_id: assetIdFromSha256(payloadChecksum),
    kind: "artifact",
    relative_path: asPosix(relative(outputDir, mergedPath)),
    sha256: payloadChecksum,
    size_bytes: statSync(mergedPath).size,
    media_type: "text/csv",
    generated_by_step_id: "step_integrator_v1",
  });
  const statistics: Record<string, JsonValue> = {
    row_count: rowCount,
    dedup_count: dedupCount,
    conflict_count: conflictCount,
    source_batches: results.map((result) => result.batch.binding_id),
    merge_strategy: MERGE_STRATEGY_APPEND,
    dataset_id: buildId,
  };
  const mergedBatch = parseDataBatch({
    schema_version: "1.0",
    batch_id: "merged_primary",
    binding_id: "merged",
    dataset_family: results[0].batch.dataset_family,
    row_granularity: results[0].batch.row_granularity,
    schema_ref: schema.schema_id,
    file_asset: fileAsset,
    row_count: rowCount,
    column_count: columns.length,
    parser_id: "expression.integrator.v1",
    parser_version: "1.0.0",
    statistics,
    warnings: [],
    declared_mappings: [],
  });
  return {
    batch: mergedBatch,
    mergedPath,
    rowCount,
    dedupCount,
    conflictCount,
    conflictsPath,
  };
}

function asPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function rowIdentity(
  row: Record<string, string>,
  idField: string,
): [string, string, string, string] {
  return [
    row[idField] ?? "",
    row["sample_id"] ?? "",
    row["measurement_type"] ?? "",
    row["value_semantics"] ?? "",
  ];
}

/** Python csv.DictReader: header row + per-row field dicts. */
async function readCsvDictRows(path: string, signal?: AbortSignal | null): Promise<Array<Record<string, string>>> {
  const text = await readSourceTextAsync(path, signal);
  const rows = await delimitedRowsWithLinesAsync(text, ",", signal);
  if (rows.length === 0) return [];
  const header = rows[0].values;
  const records: Array<Record<string, string>> = [];
  let visited = 0;
  for (const row of rows.slice(1)) {
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index]] = row.values[index] ?? "";
    }
    records.push(record);
    visited += 1;
    if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }
  return records;
}

function numericallyEqual(left: string, right: string): boolean {
  const leftFloat = pythonFloat(left);
  const rightFloat = pythonFloat(right);
  if (!leftFloat.ok || !rightFloat.ok) {
    return left === right; // Python float() raised ValueError for both
  }
  if (Number.isNaN(leftFloat.value) && Number.isNaN(rightFloat.value)) {
    return true; // NaN mirrors are duplicates, not conflicts
  }
  return leftFloat.value === rightFloat.value;
}

type FloatParse = { ok: true; value: number } | { ok: false };

/** Python ``float()``-compatible strict parse (whitespace, inf/nan, decimals). */
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
