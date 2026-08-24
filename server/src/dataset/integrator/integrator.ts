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

import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@biomed/contracts";
import type { CanonicalizationResult } from "../canonicalizer/index.js";
import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import { BufferedCsvWriter } from "../adapters/base.js";
import { BuildError } from "../adapters/errors.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { assetIdFromSha256 } from "../adapters/identity.js";
import { asPosix } from "../adapters/paths.js";
import { delimitedRowsFromFileAsync } from "../adapters/text.js";
import type { DataBatch, DatasetSchema, FileAsset } from "../contracts/index.js";
import { parseDataBatch, parseFileAsset } from "../contracts/index.js";
import type { ExpressionAdapterIdentityContext } from "../adapters/identity-context.js";

export const MERGE_STRATEGY_APPEND = "append_by_canonical_row";

/**
 * Agent-facing aliases mapped onto the single implemented merge semantics.
 * ``union`` — combine all canonical rows, deduplicating by canonical row
 * identity — is exactly what append-by-canonical-row does, so it is accepted
 * verbatim (single-source builds are a no-op regardless).
 */
const MERGE_STRATEGY_ALIASES: Record<string, string> = {
  union: MERGE_STRATEGY_APPEND,
};

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

interface V2IntegrationContract {
  readonly keyColumns: readonly string[];
  readonly valueColumn: string;
}

/** V2 keys/measurements are schema contracts, not inferred V1 columns. */
const V2_INTEGRATION_CONTRACTS: Readonly<Record<string, V2IntegrationContract>> = {
  "gene_expression.long.v2": {
    keyColumns: ["dataset_revision_id", "sample_id", "gene_id", "measurement_type"],
    valueColumn: "expression_value",
  },
  "gene_expression.probe_long.v2": {
    keyColumns: ["dataset_revision_id", "probe_id", "platform_id", "sample_id"],
    valueColumn: "value",
  },
};

/** Unsupported merge strategy or zero sources (Python ``IntegratorError``). */
export class IntegratorError extends BuildError {}

/** Temp-store disk quota exceeded (WP-A6): fail closed, never OOM. */
export class IntegratorResourceLimitError extends IntegratorError {
  constructor(message: string) {
    super(message);
    this.name = "IntegratorResourceLimitError";
  }
}

/** Inside the temp key-table row count (observable: ``IntegrationResult``). */
const TEMP_STORE_DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024;

/** Merged primary dataset batch plus merge audit counts. */
export interface IntegrationResult {
  batch: DataBatch;
  mergedPath: string;
  rowCount: number;
  dedupCount: number;
  conflictCount: number;
  conflictsPath: string | null;
  /** Peak temp-store disk usage last observed during integration (bytes). */
  tempStoreBytes: number;
  /** Distinct identities pinned inside the temp key table. */
  tempStoreRows: number;
}

/** Append canonical sources into one primary dataset, dedup by row identity. */
export async function integrate(options: {
  results: readonly CanonicalizationResult[];
  mergeStrategy: string;
  schema: DatasetSchema;
  buildId: string;
  outputDir: string;
  signal?: AbortSignal | null;
  /** WP-A6: bound the temp key-table's on-disk size (bytes). */
  tempStore?: { quotaBytes: number };
  /** Core-derived identity capability for revision-scoped V2 integration. */
  identityContext?: Pick<ExpressionAdapterIdentityContext, "datasetId" | "datasetRevisionId" | "carrierAssetIds"> | null;
}): Promise<IntegrationResult> {
  const {
    results,
    mergeStrategy,
    schema,
    buildId,
    outputDir,
    signal,
    tempStore,
    identityContext = null,
  } = options;
  throwIfAborted(signal);
  const strategy = MERGE_STRATEGY_ALIASES[mergeStrategy] ?? mergeStrategy;
  if (strategy !== MERGE_STRATEGY_APPEND) {
    throw new IntegratorError(
      `unsupported merge strategy ${mergeStrategy}; ` +
        `server allows only ${MERGE_STRATEGY_APPEND} (alias: union)`,
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
  // V1 keeps its historical inferred tuple byte-for-byte. V2 uses the
  // registered schema-specific contract, including probe platform identity.
  const idField = schema.fields.some((field) => field.name === "probe_id")
    ? "probe_id"
    : "gene_id";
  const revisionScoped = schema.fields.some((field) => field.name === "dataset_revision_id");
  if (revisionScoped && identityContext === null) {
    throw new IntegratorError("revision-scoped integration requires Core-derived dataset identity");
  }
  // WP-A6: column-name whitelist before the identity tuple is interpolated
  // into SQL, so an out-of-contract schema cannot inject a column reference.
  if (idField !== "gene_id" && idField !== "probe_id") {
    throw new IntegratorError(`unsupported identity field ${idField}`);
  }
  const v2Contract = revisionScoped ? V2_INTEGRATION_CONTRACTS[schema.schema_id] : undefined;
  if (revisionScoped && v2Contract === undefined) {
    throw new IntegratorError(`unsupported revision-scoped schema contract ${schema.schema_id}`);
  }
  const keyColumns = v2Contract?.keyColumns ?? [idField, "sample_id", "measurement_type", "value_semantics"];
  const valueColumn = v2Contract?.valueColumn ?? "expression_value";
  const fieldNames = new Set(columns);
  if (v2Contract !== undefined && (keyColumns.some((column) => !fieldNames.has(column)) || !fieldNames.has(valueColumn))) {
    throw new IntegratorError(`schema ${schema.schema_id} does not declare its integration contract columns`);
  }
  let rowCount = 0;
  let dedupCount = 0;
  let conflictCount = 0;
  let tempStoreBytes = 0;
  let tempStoreRows: number;
  const quotaBytes = tempStore?.quotaBytes ?? TEMP_STORE_DEFAULT_QUOTA_BYTES;
  const conflictColumns = revisionScoped
    ? ["conflict_id", ...keyColumns, "first_source_asset_id", "first_value", "second_source_asset_id", "second_value", "action"]
    : CONFLICT_COLUMNS;

// Streamed outputs: row buffers are flushed in bounded chunks so the
  // merged/conflicts files never accumulate in memory (M2 large-file fix;
  // same shared BufferedCsvWriter the source adapters use).
  const mergedWriter = new BufferedCsvWriter(mergedPath, columns);
  const conflictWriter = new BufferedCsvWriter(conflictsPath, conflictColumns);
  // WP-A6: O(unique) `seen` Map is replaced by a disk-backed temp table
  // (same canonical identity, first-source-wins), so peak JS heap stays flat
  // while rows scale. Task-path temp db is discarded in `finally`.
  const tempDbPath = join(outputDir, "integrate-temp.sqlite");
  const db = new DatabaseSync(tempDbPath);
  try {
    db.exec("PRAGMA journal_mode=OFF;");
    db.exec("PRAGMA synchronous=OFF;");
    db.exec(`
      CREATE TABLE seen (
        ${keyColumns.map((column) => `${column} TEXT NOT NULL`).join(",\n        ")},
        value TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (${keyColumns.join(", ")})
      )
    `);
    const insertSeen = db.prepare(
      `INSERT INTO seen (${keyColumns.join(", ")}, value, asset_id) VALUES (${keyColumns.map(() => "?").join(", ")}, ?, ?)`,
    );
    const selectSeen = db.prepare(
      `SELECT value, asset_id FROM seen WHERE ${keyColumns.map((column) => `${column}=?`).join(" AND ")}`,
    );
    // WP-A6: insert in bounded transactions (one per checkpoint stride). The
    // dedup SELECT always sees prior rows (cached pages), COMMIT flushes to
    // disk so the on-disk quota stat reflects real growth, and per-row
    // autocommit's fsync cost is amortised away.
    const inTransaction = results.length > 1;
    if (inTransaction) db.exec("BEGIN");
    let visited = 0;
    for (const result of results) {
      for await (const row of readCsvDictRows(result.canonicalPath, signal)) {
        visited += 1;
        // M2: checkpoint per processed row (not only new-unique rows) so an
        // extreme dedup/conflict workload still yields to the event loop.
        if (visited % CHECKPOINT_STRIDE === 0) {
          if (inTransaction) db.exec("COMMIT");
          await checkpoint(signal);
          tempStoreBytes = await enforceTempQuota(tempDbPath, quotaBytes);
          if (inTransaction) db.exec("BEGIN");
        }
        const keyParts = rowIdentity(row, keyColumns);
        if (identityContext !== null && (
          row.dataset_id !== identityContext.datasetId
          || row.dataset_revision_id !== identityContext.datasetRevisionId
        )) {
          throw new IntegratorError("canonical row identity does not match Core-derived dataset identity");
        }
        const value = row[valueColumn] ?? "";
        const existing = selectSeen.get(...keyParts) as
          | { value: string; asset_id: string }
          | undefined;
        if (existing === undefined) {
          if (results.length > 1) {
            insertSeen.run(...keyParts, value, row["asset_id"] ?? "");
          }
          mergedWriter.writeRow(columns.map((column) => row[column] ?? ""));
          rowCount += 1;
          continue;
        }
        if (numericallyEqual(existing.value, value)) {
          dedupCount += 1;
          continue;
        }
        conflictWriter.writeRow([
          revisionScoped
            ? `conflict_${keyParts.join("_")}_${rowCount}`
            : `conflict_${keyParts[0]}_${keyParts[1]}_${rowCount}`,
          ...keyParts,
          existing.asset_id,
          existing.value,
          row["asset_id"] ?? "",
          value,
          "kept_first_source",
        ]);
        conflictCount += 1;
      }
    }
    if (inTransaction) db.exec("COMMIT");
    try {
      tempStoreBytes = statSync(tempDbPath).size;
    } catch { /* not observable after abort */ }
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM seen").get();
    tempStoreRows = countRow ? Number(countRow.count) : 0;
  } catch (error) {
    mergedWriter.close();
    conflictWriter.close();
    try { unlinkSync(mergedPath); } catch { /* best effort */ }
    try { unlinkSync(conflictsPath); } catch { /* best effort */ }
    throw error;
  } finally {
    db.close();
    try { unlinkSync(tempDbPath); } catch { /* best effort */ }
  }
  mergedWriter.close();
  conflictWriter.close();

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
    dataset_id: identityContext?.datasetId ?? buildId,
    ...(identityContext === null ? {} : {
      dataset_revision_id: identityContext.datasetRevisionId,
      carrier_asset_ids: [...identityContext.carrierAssetIds],
    }),
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
    tempStoreBytes,
    tempStoreRows,
  };
}

/**
 * WP-A6: enforce the temp-store disk quota, failing closed with a typed
 * resource-limit error instead of letting the task's working set grow without
 * bound. Returns the observed temp-db size (bytes).
 */
async function enforceTempQuota(
  tempDbPath: string,
  quotaBytes: number,
): Promise<number> {
  if (quotaBytes <= 0) return 0;
  let size: number;
  try {
    size = statSync(tempDbPath).size;
  } catch {
    return 0;
  }
  if (size > quotaBytes) {
    throw new IntegratorResourceLimitError(
      `resource_limit: integrate temp store exceeded ${quotaBytes} bytes (${size})`,
    );
  }
  return size;
}

function rowIdentity(
  row: Record<string, string>,
  keyColumns: readonly string[],
): string[] {
  return keyColumns.map((column) => row[column] ?? "");
}

/** Python csv.DictReader: header row + per-row field dicts. */
async function* readCsvDictRows(
  path: string,
  signal?: AbortSignal | null,
): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let visited = 0;
  for await (const row of delimitedRowsFromFileAsync(path, ",", signal)) {
    if (header === null) {
      header = row.values;
      continue;
    }
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index]] = row.values[index] ?? "";
    }
    yield record;
    visited += 1;
    if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }
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
