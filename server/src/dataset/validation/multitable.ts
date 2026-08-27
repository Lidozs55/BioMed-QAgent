import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  RelationDefinition,
  SchemaFieldV2,
} from "@biomed/contracts";

import {
  delimitedRowsFromFileAsync,
  type DelimitedRowBounds,
} from "../adapters/text.js";
import type {
  MultiTableValidationCheck,
  MultiTableValidationRequest,
  MultiTableValidationResult,
  MultiTableValidationTable,
  ResolvedRelationMissingPolicy,
  TokenPreservationRule,
} from "../contracts/validation.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import { parsePublicationCandidateRef, parseRelationDefinition, parseTableDefinition } from "../contracts/multitable.js";
import { parseDatasetSchemaV2 } from "../contracts/schema.js";
import { assertRelativePath } from "../contracts/primitives.js";
import { checkpoint, CHECKPOINT_STRIDE, throwIfAborted } from "../cooperative.js";
import {
  checkRelationIndexes,
  DiskIndexOwnershipError,
  DiskIndexResourceLimitError,
  type PrimaryKeyIndexCheck,
  type TupleIndex,
} from "./disk-index.js";
import {
  decideB3Backend,
  type B3BackendDecision,
  type B3CleanupCapability,
  type B3DiskTupleIndexFactory,
  type B3ParityProof,
} from "./b3-backend-decision/index.js";
import {
  decideValidatorResources,
  MULTITABLE_RESOURCE_CONFIGURATION_SOURCE,
  MULTITABLE_RESOURCE_MEASUREMENT_SOURCE,
  MULTITABLE_RESOURCE_PREFLIGHT_TELEMETRY_SCHEMA_VERSION,
  type MultiTableMeasuredInput,
  type MultiTableMeasuredResources,
  type MultiTableResourceMeasurementSource,
  type MultiTableResourcePreflightTelemetry,
  type MultiTableResourceValidationOptions,
  type ResourceBaselineDecision,
  type ResourceKeyEstimate,
} from "./resource-baseline.js";

export type {
  MultiTableMeasuredInput,
  MultiTableMeasuredResources,
  MultiTableResourcePreflightTelemetry,
  MultiTableResourceTelemetrySink,
  MultiTableResourceValidationOptions,
} from "./resource-baseline.js";

/**
 * Production C-T11 disk capability for one Core-owned validation. When the
 * measured resources select disk mode, every one of these capabilities must
 * be present and valid or the validation fails closed; memory is never the
 * fallback.
 */
export interface MultiTableB3BackendOptions {
  /** Core-owned identity the disk indexes are bound to. */
  readonly owner: {
    readonly taskId: string;
    readonly requirementId: string;
    readonly generation: number;
  };
  /** Creates the real disk-backed TupleIndex instances for PK/FK combos. */
  readonly factory: B3DiskTupleIndexFactory;
  /** True only when the validator inputs were snapshotted immutably. */
  readonly snapshotImmutable: boolean;
  /** Memory/disk parity proof, or null when no parity evidence exists. */
  readonly parityProof: B3ParityProof | null;
  /** Cleanup capability for the disk index owner. */
  readonly cleanup: B3CleanupCapability | null;
  /** Parent directory for the task-owned disk indexes. */
  readonly directory?: string;
  /** Per-index SQLite quota. */
  readonly quotaBytesPerIndex: number;
  readonly batchSize?: number;
}

/**
 * Explicit C-T4 production opt-in for validateMultiTableCandidate. Omitting
 * this object preserves the legacy small-input path and return shape, but that
 * path is not Family Host large-input admission.
 */
export interface MultiTableValidationOptions {
  resourceBaseline: MultiTableResourceValidationOptions;
  /** Production C-T11 disk capability; absent means disk-selected measurements fail closed. */
  b3Backend?: MultiTableB3BackendOptions;
}

interface TableScan {
  rowCount: number;
  keyCounts: Map<string, Map<string, number>>;
  /** Per-combo disk indexes in disk mode; null in memory mode or for absent tables. */
  diskIndexes: Map<string, TupleIndex> | null;
}

interface ResolvedTrustedTable {
  path: string;
  size: number;
  sha256: string;
  resultManifestId: string;
  relativePath: string;
}

const SUPPORTED_DATA_TYPES = new Set([
  "string",
  "integer",
  "float",
  "number",
  "boolean",
  "date",
  "datetime",
  "json",
]);

function check(
  checks: MultiTableValidationCheck[],
  checkId: string,
  scope: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ check_id: checkId, scope, passed, detail });
}

function copyKeyEstimates(
  estimates: readonly ResourceKeyEstimate[],
): ResourceKeyEstimate[] {
  return estimates.map((estimate) => ({ ...estimate }));
}

function copyMeasuredInputs(
  inputs: readonly MultiTableMeasuredInput[],
): MultiTableMeasuredInput[] {
  return inputs.map((input) => ({ ...input }));
}

interface ResourceTelemetryFacts {
  measurementSource: MultiTableResourceMeasurementSource;
  measuredInputs: readonly MultiTableMeasuredInput[];
  measurementComplete: boolean;
  rowEstimate: number | null;
  keyEstimates: readonly ResourceKeyEstimate[];
  validatorMode: MultiTableResourcePreflightTelemetry["validatorMode"];
  thresholdBasis: MultiTableResourcePreflightTelemetry["thresholdBasis"];
  estimatedHeapBytes: number | null;
  estimatedTempBytes: number | null;
  failureReason: MultiTableResourcePreflightTelemetry["failureReason"];
}

async function emitResourceTelemetry(
  options: MultiTableResourceValidationOptions,
  facts: ResourceTelemetryFacts,
  startedAt: number,
  signal?: AbortSignal | null,
): Promise<void> {
  const telemetry: MultiTableResourcePreflightTelemetry = {
    schemaVersion: MULTITABLE_RESOURCE_PREFLIGHT_TELEMETRY_SCHEMA_VERSION,
    measurementSource: facts.measurementSource,
    validatorMode: facts.validatorMode,
    thresholdBasis: facts.thresholdBasis === null ? null : { ...facts.thresholdBasis },
    measuredInputs: copyMeasuredInputs(facts.measuredInputs),
    measurementComplete: facts.measurementComplete,
    rowEstimate: facts.rowEstimate,
    keyEstimates: copyKeyEstimates(facts.keyEstimates),
    configuredHeapBytes: options.configuredHeapBytes,
    configuredTempBytes: options.configuredTempBytes,
    estimatedHeapBytes: facts.estimatedHeapBytes,
    estimatedTempBytes: facts.estimatedTempBytes,
    durationMs: Math.max(0, performance.now() - startedAt),
    heapBytes: process.memoryUsage().heapUsed,
    tempBytes: null,
    failureReason: facts.failureReason,
  };
  try {
    await options.telemetrySink(telemetry);
  } catch (error) {
    throw new Error("multi-table resource telemetry sink failed", { cause: error });
  }
  throwIfAborted(signal);
}

function resourceConfigurationDecision(
  options: MultiTableResourceValidationOptions,
  signal?: AbortSignal | null,
): ResourceBaselineDecision {
  const decision = decideValidatorResources({
    rowEstimate: 0,
    keyEstimates: [],
    configuredHeapBytes: options.configuredHeapBytes,
    configuredTempBytes: options.configuredTempBytes,
    diskIndexAvailable: false,
    cancelCapable: signal !== undefined && signal !== null,
  }, options.policy);
  if (decision.validatorMode !== "memory" || (signal !== undefined && signal !== null)) {
    return decision;
  }
  return {
    ...decision,
    validatorMode: "reject",
    failureReason: "cancel_unavailable",
    telemetry: {
      ...decision.telemetry,
      failureReason: "cancel_unavailable",
    },
  };
}

function resourceScanBounds(
  options: MultiTableResourceValidationOptions,
  expectedFields: number,
): DelimitedRowBounds {
  return {
    maxRowChars: options.policy.maxRowCharacters,
    maxFieldChars: options.policy.maxFieldCharacters,
    maxRowFields: expectedFields,
  };
}

async function resourcePreflight(
  options: MultiTableResourceValidationOptions,
  measured: MultiTableMeasuredResources,
  startedAt: number,
  diskIndexAvailable: boolean,
  signal?: AbortSignal | null,
): Promise<ResourceBaselineDecision> {
  throwIfAborted(signal);
  const keyEstimates = copyKeyEstimates(measured.keyEstimates);
  const measuredInputs = copyMeasuredInputs(measured.measuredInputs);
  const decision = decideValidatorResources({
    rowEstimate: measured.rowEstimate,
    keyEstimates,
    configuredHeapBytes: options.configuredHeapBytes,
    configuredTempBytes: options.configuredTempBytes,
    // Disk is available only to the explicit C-T11 staging PK path. The
    // production/default call shape never flips this capability globally.
    diskIndexAvailable,
    cancelCapable: signal !== undefined && signal !== null,
  }, options.policy);
  await emitResourceTelemetry(options, {
    measurementSource: MULTITABLE_RESOURCE_MEASUREMENT_SOURCE,
    validatorMode: decision.validatorMode,
    thresholdBasis: decision.thresholdBasis,
    measuredInputs,
    measurementComplete: true,
    rowEstimate: measured.rowEstimate,
    keyEstimates,
    estimatedHeapBytes: decision.estimatedHeapBytes,
    estimatedTempBytes: decision.estimatedTempBytes,
    failureReason: decision.failureReason,
  }, startedAt, signal);
  return decision;
}

function resourceDecisionDetail(decision: ResourceBaselineDecision): string {
  return JSON.stringify({
    validator_mode: decision.validatorMode,
    threshold_basis: decision.thresholdBasis,
    estimated_heap_bytes: decision.estimatedHeapBytes,
    estimated_temp_bytes: decision.estimatedTempBytes,
    failure_reason: decision.failureReason,
  });
}

function backendDecisionDetail(
  decision: ResourceBaselineDecision,
  backend: B3BackendDecision,
): string {
  return JSON.stringify({
    validator_mode: decision.validatorMode,
    threshold_basis: decision.thresholdBasis,
    estimated_heap_bytes: decision.estimatedHeapBytes,
    estimated_temp_bytes: decision.estimatedTempBytes,
    failure_reason: decision.failureReason,
    backend_outcome: backend.outcome,
    ...(backend.outcome === "reject"
      ? { backend_reason: backend.reason, backend_detail: backend.detail }
      : {}),
  });
}

function assertDiskIndexQuota(
  options: MultiTableB3BackendOptions,
  decision: ResourceBaselineDecision,
  indexCount: number,
): void {
  const effectiveQuota = decision.thresholdBasis?.effectiveTempQuotaBytes;
  const reserved = BigInt(options.quotaBytesPerIndex) * BigInt(indexCount);
  if (effectiveQuota === undefined || reserved > BigInt(effectiveQuota)) {
    throw new DiskIndexResourceLimitError(
      "B3 disk index reservations exceed the selected temp quota",
    );
  }
}

/**
 * Total per-combo indexes the disk pass creates for present tables: one per
 * unique PK/FK/relation combination per table.
 */
function diskIndexCount(
  request: MultiTableValidationRequest,
  resolvedTables: ReadonlyMap<string, ResolvedTrustedTable>,
): number {
  let count = 0;
  for (const table of request.tables) {
    if (resolvedTables.has(table.definition.table_id)) {
      count += relationCombos(table.definition.table_id, table.schema, request.relations).length;
    }
  }
  return count;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalRoot(root: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(root)));
}

async function sha256File(filePath: string, signal?: AbortSignal | null): Promise<string> {
  throwIfAborted(signal);
  const hasher = createHash("sha256");
  const source = createReadStream(filePath);
  try {
    for await (const chunk of source) {
      throwIfAborted(signal);
      hasher.update(chunk as Buffer);
    }
    return hasher.digest("hex");
  } finally {
    source.destroy();
  }
}

function operationAllowsTable(result: OperationResultManifest): boolean {
  const allowed =
    (result.operation_kind === "parse" && result.output_kind === "parsed_table") ||
    (result.operation_kind === "canonicalize" && result.output_kind === "canonical_table") ||
    (result.operation_kind === "integrate" && result.output_kind === "integrated_table") ||
    (result.operation_kind === "assemble" && result.output_kind === "publication_candidate") ||
    (result.operation_kind === "derive" && result.output_kind === "derived_evidence");
  return allowed && result.status === "succeeded";
}

async function resolveTrustedTablePath(
  request: MultiTableValidationRequest,
  table: MultiTableValidationTable,
  trustedRoot: string,
  forbiddenRoots: readonly string[],
  signal?: AbortSignal | null,
): Promise<ResolvedTrustedTable> {
  const file = table.file;
  if (file === null) throw new Error("table has no file reference");
  if (file.origin !== "core_operation_result") {
    throw new Error("only Core operation result files are accepted");
  }
  const result = parseOperationResultManifest(
    file.operation_result,
    request.task_id,
    request.run_id,
    request.requirement_id,
  );
  if (!operationAllowsTable(result)) {
    throw new Error("table file is not from a successful native Core table operation");
  }
  const relativePath = assertRelativePath(file.relative_path, "TrustedTableFileInput.relative_path");
  const receipts = result.output_files.filter((entry) => entry.relative_path === relativePath);
  if (receipts.length !== 1) {
    throw new Error("table file must have exactly one operation result receipt");
  }
  const lexicalPath = path.resolve(trustedRoot, ...relativePath.split("/"));
  if (!isWithin(trustedRoot, lexicalPath)) throw new Error("table file escapes the trusted root");
  const actualPath = path.normalize(await realpath(lexicalPath));
  if (!isWithin(trustedRoot, actualPath)) throw new Error("table file resolves outside the trusted root");
  if (forbiddenRoots.some((root) => isWithin(root, actualPath))) {
    throw new Error("Agent workspace and forbidden roots are not trusted table inputs");
  }
  const fileStat = await stat(actualPath);
  if (!fileStat.isFile()) throw new Error("table input is not a regular file");
  const receipt = receipts[0];
  if (fileStat.size !== receipt.size_bytes) throw new Error("table size does not match its Core receipt");
  const digest = await sha256File(actualPath, signal);
  if (digest !== receipt.sha256.toLowerCase()) throw new Error("table hash does not match its Core receipt");
  return {
    path: actualPath,
    size: fileStat.size,
    sha256: digest,
    resultManifestId: result.result_manifest_id,
    relativePath,
  };
}

function fieldsKey(fields: readonly string[]): string {
  return JSON.stringify(fields);
}

function tupleKey(values: readonly string[]): string {
  return JSON.stringify(values);
}

function tuplePayloadBytes(values: readonly string[]): number {
  // Map keys are JavaScript strings. Two bytes per UTF-16 code unit is a
  // conservative, deterministic payload estimate independent of V8's optional
  // one-byte string representation.
  return tupleKey(values).length * 2;
}

interface MutableKeyMeasurement {
  keyId: string;
  entryEstimate: number;
  tupleWidthEstimateBytes: number;
  tupleFieldCount: number;
}

async function measureTableResources(
  table: MultiTableValidationTable,
  resolved: ResolvedTrustedTable,
  request: MultiTableValidationRequest,
  options: MultiTableResourceValidationOptions,
  signal?: AbortSignal | null,
): Promise<{ input: MultiTableMeasuredInput; rows: number; keys: ResourceKeyEstimate[] }> {
  const tableId = table.definition.table_id;
  const expectedHeader = table.definition.field_names;
  const combinations = relationCombos(tableId, table.schema, request.relations);
  const keys = combinations.map((fields): MutableKeyMeasurement => ({
    keyId: JSON.stringify([tableId, fields]),
    entryEstimate: 0,
    tupleWidthEstimateBytes: 0,
    tupleFieldCount: fields.length,
  }));
  let header: string[] | null = null;
  let rows = 0;
  for await (const row of delimitedRowsFromFileAsync(
    resolved.path,
    table.file?.delimiter ?? ",",
    signal,
    resourceScanBounds(options, expectedHeader.length),
  )) {
    if (header === null) {
      header = row.values;
      if (!sameStrings(header, expectedHeader)) {
        throw new Error(`resource measurement header mismatch for ${tableId}`);
      }
      continue;
    }
    if (row.values.length === 0) continue;
    if (row.values.length !== expectedHeader.length) {
      throw new Error(`resource measurement row width mismatch for ${tableId}`);
    }
    rows += 1;
    if (!Number.isSafeInteger(rows)) {
      throw new Error(`resource measurement row count overflow for ${tableId}`);
    }
    const values = new Map(expectedHeader.map((name, index) => [name, row.values[index] ?? ""]));
    for (let index = 0; index < combinations.length; index += 1) {
      const fields = combinations[index] ?? [];
      const measurement = keys[index];
      if (measurement === undefined) throw new Error("resource measurement key closure failed");
      measurement.entryEstimate = rows;
      measurement.tupleWidthEstimateBytes = Math.max(
        measurement.tupleWidthEstimateBytes,
        tuplePayloadBytes(fields.map((field) => values.get(field) ?? "")),
      );
    }
    if (rows % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }
  if (header === null) throw new Error(`resource measurement found no header for ${tableId}`);
  return {
    input: {
      tableId,
      resultManifestId: resolved.resultManifestId,
      relativePath: resolved.relativePath,
      sizeBytes: resolved.size,
      sha256: resolved.sha256,
    },
    rows,
    keys,
  };
}

async function measureResources(
  request: MultiTableValidationRequest,
  resolvedTables: ReadonlyMap<string, ResolvedTrustedTable>,
  options: MultiTableResourceValidationOptions,
  signal?: AbortSignal | null,
): Promise<MultiTableMeasuredResources> {
  const measuredInputs: MultiTableMeasuredInput[] = [];
  const keyEstimates: ResourceKeyEstimate[] = [];
  let rowEstimate = 0;
  for (const table of request.tables) {
    const resolved = resolvedTables.get(table.definition.table_id);
    if (resolved === undefined) continue;
    const measured = await measureTableResources(
      table,
      resolved,
      request,
      options,
      signal,
    );
    measuredInputs.push(measured.input);
    keyEstimates.push(...measured.keys);
    rowEstimate += measured.rows;
    if (!Number.isSafeInteger(rowEstimate)) throw new Error("resource measurement row count overflow");
  }
  return {
    measuredInputs,
    rowEstimate,
    keyEstimates,
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function matchesType(value: string, field: SchemaFieldV2): boolean {
  switch (field.data_type) {
    case "string": return true;
    case "integer": return /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
    case "float":
    case "number": return value.trim() !== "" && Number.isFinite(Number(value));
    case "boolean": return value === "true" || value === "false";
    case "date": return validDate(value);
    case "datetime": return validDateTime(value);
    case "json": {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

function relationCombos(
  tableId: string,
  schema: DatasetSchemaV2,
  relations: readonly RelationDefinition[],
): string[][] {
  const combinations = [schema.primary_key];
  for (const relation of relations) {
    if (relation.from_table_id === tableId) combinations.push(relation.from_fields);
    if (relation.to_table_id === tableId) combinations.push(relation.to_fields);
  }
  const unique = new Map(combinations.map((fields) => [fieldsKey(fields), [...fields]]));
  return [...unique.values()];
}

function tableTokenRules(
  tableId: string,
  rules: readonly TokenPreservationRule[],
): TokenPreservationRule[] {
  return rules.filter((rule) => rule.table_id === tableId);
}

interface MemoryScanBudget {
  remainingBytes: bigint;
  rowOverheadBytes: bigint;
  keyEntryOverheadBytes: bigint;
  tupleFieldOverheadBytes: bigint;
}

function createMemoryScanBudget(
  decision: ResourceBaselineDecision,
  options: MultiTableResourceValidationOptions,
): MemoryScanBudget {
  const threshold = decision.thresholdBasis?.effectiveMemoryThresholdBytes;
  if (threshold === undefined) {
    throw new Error("memory resource decision has no effective threshold");
  }
  return {
    remainingBytes: BigInt(threshold),
    rowOverheadBytes: BigInt(options.policy.rowOverheadBytes),
    keyEntryOverheadBytes: BigInt(options.policy.keyEntryOverheadBytes),
    tupleFieldOverheadBytes: BigInt(options.policy.tupleFieldOverheadBytes),
  };
}

function reserveMemoryScanRow(
  budget: MemoryScanBudget,
  tuplePayloads: readonly { bytes: number; fieldCount: number }[],
): void {
  let required = budget.rowOverheadBytes;
  for (const tuple of tuplePayloads) {
    required += budget.keyEntryOverheadBytes
      + BigInt(tuple.bytes)
      + BigInt(tuple.fieldCount) * budget.tupleFieldOverheadBytes;
  }
  if (required > budget.remainingBytes) {
    throw new Error("measured memory threshold exceeded during table scan");
  }
  budget.remainingBytes -= required;
}

async function scanTable(
  table: MultiTableValidationTable,
  filePath: string,
  request: MultiTableValidationRequest,
  checks: MultiTableValidationCheck[],
  signal?: AbortSignal | null,
  memoryBudget?: MemoryScanBudget,
  scanBounds?: DelimitedRowBounds,
  diskIndexes?: ReadonlyMap<string, TupleIndex>,
): Promise<TableScan> {
  const tableId = table.definition.table_id;
  const expectedHeader = table.definition.field_names;
  const declaredFields = new Set(expectedHeader);
  const scannedFields = table.schema.fields.filter((field) => declaredFields.has(field.name));
  const combinations = relationCombos(tableId, table.schema, request.relations);
  const diskMode = diskIndexes !== undefined;
  const memoryCombinations = diskMode ? [] : combinations;
  const keyCounts = new Map(
    memoryCombinations.map((fields) => [fieldsKey(fields), new Map<string, number>()]),
  );
  const pendingBatches = new Map<string, string[][]>();
  const tokenRules = tableTokenRules(tableId, request.policy.token_preservation_rules);
  let header: string[] | null = null;
  let rowCount = 0;
  let malformedWidth = 0;
  let nullabilityFailures = 0;
  let typeFailures = 0;
  let tokenFailures = 0;
  let primaryKeyNulls = 0;
  let unsupportedType: string | null = null;

  for (const field of scannedFields) {
    if (!SUPPORTED_DATA_TYPES.has(field.data_type)) {
      unsupportedType ??= `${field.name}:${field.data_type}`;
    }
  }

  for await (const row of delimitedRowsFromFileAsync(
    filePath,
    table.file?.delimiter ?? ",",
    signal,
    scanBounds,
  )) {
    if (header === null) {
      header = row.values;
      continue;
    }
    if (row.values.length === 0) continue;
    rowCount += 1;
    if (row.values.length !== expectedHeader.length) {
      malformedWidth += 1;
      continue;
    }
    const values = new Map(expectedHeader.map((name, index) => [name, row.values[index] ?? ""]));
    for (const field of scannedFields) {
      const value = values.get(field.name) ?? "";
      if (value === "") {
        if (!field.nullable) nullabilityFailures += 1;
      } else if (!matchesType(value, field)) {
        typeFailures += 1;
      }
    }
    if (diskMode) {
      for (const fields of combinations) {
        const comboKey = fieldsKey(fields);
        const index = diskIndexes.get(comboKey);
        if (index === undefined) {
          throw new Error(`B3 disk index closure failed for ${tableId} combo ${comboKey}`);
        }
        let batch = pendingBatches.get(comboKey);
        if (batch === undefined) {
          batch = [];
          pendingBatches.set(comboKey, batch);
        }
        batch.push(fields.map((field) => values.get(field) ?? ""));
        if (batch.length === CHECKPOINT_STRIDE) {
          await index.addBatch(batch, signal);
          pendingBatches.set(comboKey, []);
        }
      }
    } else {
      const primaryValues = table.schema.primary_key.map((field) => values.get(field) ?? "");
      if (primaryValues.some((value) => value === "")) primaryKeyNulls += 1;
      const encodedKeys = memoryCombinations.map((fields) => {
        const valuesForKey = fields.map((field) => values.get(field) ?? "");
        return {
          fields,
          encoded: tupleKey(valuesForKey),
          bytes: tuplePayloadBytes(valuesForKey),
        };
      });
      if (memoryBudget !== undefined) {
        reserveMemoryScanRow(
          memoryBudget,
          encodedKeys.map(({ bytes, fields }) => ({ bytes, fieldCount: fields.length })),
        );
      }
      for (const { fields, encoded } of encodedKeys) {
        const counts = keyCounts.get(fieldsKey(fields));
        counts?.set(encoded, (counts.get(encoded) ?? 0) + 1);
      }
    }
    for (const rule of tokenRules) {
      if ((values.get(rule.source_field) ?? "") !== (values.get(rule.output_field) ?? "")) {
        tokenFailures += 1;
      }
    }
    if (rowCount % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
  }

  if (diskMode) {
    for (const [comboKey, index] of diskIndexes) {
      const batch = pendingBatches.get(comboKey);
      if (batch !== undefined && batch.length > 0) {
        await index.addBatch(batch, signal);
      }
    }
  }

  check(checks, "header_order", tableId, sameStrings(header ?? [], expectedHeader),
    `actual=${JSON.stringify(header ?? [])}; expected=${JSON.stringify(expectedHeader)}`);
  check(checks, "row_width", tableId, malformedWidth === 0,
    `${malformedWidth} malformed row(s) in ${rowCount} data row(s)`);
  check(checks, "data_type", tableId, unsupportedType === null && typeFailures === 0,
    unsupportedType === null ? `${typeFailures} invalid typed value(s)` : `unsupported schema data type ${unsupportedType}`);
  check(checks, "nullability", tableId, nullabilityFailures === 0,
    `${nullabilityFailures} null value(s) in non-nullable fields`);
  const emptyAllowed = table.definition.role !== "primary" && table.definition.allow_empty;
  check(checks, "required_allow_empty", tableId, rowCount > 0 || emptyAllowed,
    `rows=${rowCount}; role=${table.definition.role}; required=${table.definition.required}; allow_empty=${table.definition.allow_empty}`);
  const primaryKeyResult: PrimaryKeyIndexCheck = diskMode
    ? (() => {
        const index = diskIndexes.get(fieldsKey(table.schema.primary_key));
        if (index === undefined) {
          throw new Error(`B3 disk index closure failed for ${tableId} primary key`);
        }
        return index.primaryKeyCheck();
      })()
    : (() => {
        const pkCounts = keyCounts.get(fieldsKey(table.schema.primary_key)) ?? new Map();
        const duplicateKeys = countDuplicates(pkCounts);
        return {
          duplicateKeys,
          nullOrBlankRows: primaryKeyNulls,
          passed: duplicateKeys === 0 && primaryKeyNulls === 0,
        };
      })();
  check(checks, "primary_key_uniqueness", tableId, primaryKeyResult.passed,
    `${primaryKeyResult.duplicateKeys} duplicate primary key value(s); null_or_blank=${primaryKeyResult.nullOrBlankRows}`);
  check(checks, "token_preservation", tableId, tokenFailures === 0,
    `${tokenFailures} relation/unit token mismatch(es) across ${tokenRules.length} rule(s)`);
  return {
    rowCount,
    keyCounts,
    diskIndexes: diskMode ? new Map(diskIndexes) : null,
  };
}

function countDuplicates(counts: ReadonlyMap<string, number>): number {
  return [...counts.values()].filter((count) => count > 1).length;
}

function relationPolicy(
  request: MultiTableValidationRequest,
  relation: RelationDefinition,
): ResolvedRelationMissingPolicy | null {
  if (relation.missing_policy !== "profile_defined") return relation.missing_policy;
  return request.policy.profile_relation_missing_policies[relation.relation_id] ?? null;
}

async function validateRelation(
  request: MultiTableValidationRequest,
  relation: RelationDefinition,
  scans: ReadonlyMap<string, TableScan>,
  checks: MultiTableValidationCheck[],
  signal?: AbortSignal | null,
): Promise<void> {
  const from = scans.get(relation.from_table_id);
  const to = scans.get(relation.to_table_id);
  if (from === undefined || to === undefined) {
    check(checks, "foreign_key", relation.relation_id, false, "relation table is absent or untrusted");
    check(checks, "cardinality", relation.relation_id, false, "relation table is absent or untrusted");
    return;
  }
  const policy = relationPolicy(request, relation);
  if (from.diskIndexes !== null || to.diskIndexes !== null) {
    // Disk mode: PK/FK/cardinality reuse the same per-combo tuple indexes.
    // A relation endpoint without an index (absent table) fails closed with
    // exactly the memory-mode checks below.
    if (from.diskIndexes === null || to.diskIndexes === null) {
      check(checks, "foreign_key", relation.relation_id, false, "relation table is absent or untrusted");
      check(checks, "cardinality", relation.relation_id, false, "relation table is absent or untrusted");
      return;
    }
    const fromIndex = from.diskIndexes.get(fieldsKey(relation.from_fields));
    const toIndex = to.diskIndexes.get(fieldsKey(relation.to_fields));
    if (fromIndex === undefined || toIndex === undefined) {
      check(checks, "foreign_key", relation.relation_id, false, "relation table is absent or untrusted");
      check(checks, "cardinality", relation.relation_id, false, "relation table is absent or untrusted");
      return;
    }
    const result = await checkRelationIndexes(fromIndex, toIndex, {
      cardinality: relation.cardinality,
      missingPolicy: policy,
      signal,
      referencedRowCount: relation.cardinality === "one_to_many" ? from.rowCount : to.rowCount,
    });
    check(checks, "foreign_key", relation.relation_id, result.missingPolicyPassed,
      `missing=${result.foreignKeyMissing}; policy=${policy ?? "unresolved_profile_defined"}`);
    check(checks, "cardinality", relation.relation_id, result.cardinalityPassed,
      `cardinality=${relation.cardinality}; from_duplicate_keys=${result.fromDuplicateKeys}; to_duplicate_keys=${result.toDuplicateKeys}`);
    return;
  }
  const fromCounts = from.keyCounts.get(fieldsKey(relation.from_fields)) ?? new Map();
  const toCounts = to.keyCounts.get(fieldsKey(relation.to_fields)) ?? new Map();
  const dependentCounts = relation.cardinality === "one_to_many" ? toCounts : fromCounts;
  const referencedCounts = relation.cardinality === "one_to_many" ? fromCounts : toCounts;
  let missing = 0;
  for (const [key, count] of dependentCounts) {
    if (!referencedCounts.has(key)) missing += count;
  }
  const referencedEmpty = relation.cardinality === "one_to_many" ? from.rowCount === 0 : to.rowCount === 0;
  const missingAllowed = policy === "allow_missing" || (policy === "allow_empty" && referencedEmpty);
  check(checks, "foreign_key", relation.relation_id,
    policy !== null && (missing === 0 || missingAllowed),
    `missing=${missing}; policy=${policy ?? "unresolved_profile_defined"}`);
  const fromDuplicates = countDuplicates(fromCounts);
  const toDuplicates = countDuplicates(toCounts);
  const passed =
    (relation.cardinality === "one_to_one" && fromDuplicates === 0 && toDuplicates === 0) ||
    (relation.cardinality === "one_to_many" && fromDuplicates === 0) ||
    (relation.cardinality === "many_to_one" && toDuplicates === 0) ||
    relation.cardinality === "many_to_many";
  check(checks, "cardinality", relation.relation_id, passed,
    `cardinality=${relation.cardinality}; from_duplicate_keys=${fromDuplicates}; to_duplicate_keys=${toDuplicates}`);
}

function validateDefinitions(
  request: MultiTableValidationRequest,
  checks: MultiTableValidationCheck[],
): boolean {
  const tableIds = request.tables.map((table) => table.definition.table_id);
  const relationIds = request.relations.map((relation) => relation.relation_id);
  const uniqueTables = new Set(tableIds).size === tableIds.length;
  const uniqueRelations = new Set(relationIds).size === relationIds.length;
  const candidateTables = sameStrings([...request.candidate.table_ids].sort(), [...tableIds].sort());
  const candidateRelations = sameStrings([...request.candidate.relation_ids].sort(), [...relationIds].sort());
  check(checks, "candidate_references", request.candidate.candidate_id,
    uniqueTables && uniqueRelations && candidateTables && candidateRelations,
    "candidate must reference every validation table/relation exactly once");

  let valid = uniqueTables && uniqueRelations && candidateTables && candidateRelations;
  const tableMap = new Map(request.tables.map((table) => [table.definition.table_id, table]));
  for (const table of request.tables) {
    const definition = table.definition;
    const schema = table.schema;
    const schemaFields = schema.fields.map((field) => field.name);
    const declaredFieldSet = new Set(definition.field_names);
    const orderedDeclaredFields = schemaFields.filter((field) => declaredFieldSet.has(field));
    const requiredFields = schema.fields
      .filter((field) => field.required)
      .map((field) => field.name);
    const schemaMatches = definition.schema_ref === schema.schema_id &&
      sameStrings(definition.field_names, orderedDeclaredFields) &&
      definition.field_names.every((field) => schemaFields.includes(field)) &&
      requiredFields.every((field) => declaredFieldSet.has(field)) &&
      sameStrings(definition.primary_key, schema.primary_key) &&
      schema.primary_key.every((field) => declaredFieldSet.has(field));
    check(checks, "table_schema_contract", definition.table_id, schemaMatches,
      "table fields must preserve schema order and include every required/primary-key field");
    const provenanceClosed = table.provenance_refs.length > 0 &&
      table.provenance_refs.every((ref) => request.candidate.provenance_refs.includes(ref));
    const confidenceClosed = table.confidence_refs.length > 0 &&
      table.confidence_refs.every((ref) => request.candidate.confidence_refs.includes(ref));
    check(checks, "table_provenance_refs", definition.table_id, provenanceClosed,
      `${table.provenance_refs.length} table provenance ref(s)`);
    check(checks, "table_confidence_refs", definition.table_id, confidenceClosed,
      `${table.confidence_refs.length} table confidence ref(s)`);
    if (!schemaMatches || !provenanceClosed || !confidenceClosed) valid = false;
  }
  const tableProvenanceRefs = request.tables.flatMap((table) => table.provenance_refs);
  const tableConfidenceRefs = request.tables.flatMap((table) => table.confidence_refs);
  const exactEvidenceRefs =
    new Set(tableProvenanceRefs).size === tableProvenanceRefs.length &&
    new Set(tableConfidenceRefs).size === tableConfidenceRefs.length &&
    sameStrings([...tableProvenanceRefs].sort(), [...request.candidate.provenance_refs].sort()) &&
    sameStrings([...tableConfidenceRefs].sort(), [...request.candidate.confidence_refs].sort());
  check(checks, "candidate_evidence_closure", request.candidate.candidate_id, exactEvidenceRefs,
    "candidate provenance/confidence refs must equal the disjoint per-table ref sets");
  if (!exactEvidenceRefs) valid = false;

  for (const relation of request.relations) {
    const from = tableMap.get(relation.from_table_id);
    const to = tableMap.get(relation.to_table_id);
    const relationValid = from !== undefined && to !== undefined &&
      relation.from_fields.length > 0 &&
      relation.from_fields.length === relation.to_fields.length &&
      relation.from_fields.every((field) => from.definition.field_names.includes(field)) &&
      relation.to_fields.every((field) => to.definition.field_names.includes(field));
    check(checks, "relation_contract", relation.relation_id, relationValid,
      "relation endpoints and equal-arity fields must reference declared tables");
    if (!relationValid) valid = false;
  }
  for (const rule of request.policy.token_preservation_rules) {
    const table = tableMap.get(rule.table_id);
    const sourceField = table?.schema.fields.find((field) => field.name === rule.source_field);
    const outputField = table?.schema.fields.find((field) => field.name === rule.output_field);
    const roleFragment = rule.token_kind === "relation" ? "relation" : "unit";
    const ruleValid = table !== undefined &&
      table.definition.field_names.includes(rule.source_field) &&
      table.definition.field_names.includes(rule.output_field) &&
      sourceField?.semantic_role.includes(roleFragment) === true &&
      outputField?.semantic_role.includes(roleFragment) === true;
    check(checks, "token_preservation_rule", `${rule.table_id}:${rule.token_kind}`, ruleValid,
      `${rule.source_field} -> ${rule.output_field}`);
    if (!ruleValid) valid = false;
  }
  for (const table of request.tables) {
    const protectedFields = table.schema.fields
      .filter((field) =>
        field.semantic_role.includes("relation") ||
        field.semantic_role.includes("unit") ||
        field.unit_policy === "preserve_original",
      )
      .map((field) => field.name)
      .filter((field) => table.definition.field_names.includes(field));
    const coveredFields = new Set(
      tableTokenRules(table.definition.table_id, request.policy.token_preservation_rules)
        .flatMap((rule) => [rule.source_field, rule.output_field]),
    );
    const uncovered = protectedFields.filter((field) => !coveredFields.has(field));
    check(checks, "token_policy_coverage", table.definition.table_id, uncovered.length === 0,
      uncovered.length === 0 ? `${protectedFields.length} protected token field(s)` : `uncovered=${uncovered.join(",")}`);
    if (uncovered.length > 0) valid = false;
  }
  return valid;
}

/**
 * Validate a trusted multi-table publication candidate.
 *
 * The two-argument form is retained for legacy small-input callers and keeps
 * its existing result shape and behavior. It does not constitute Family Host
 * large-input admission. Such callers must explicitly pass resource options;
 * the validator then derives estimates from Core-receipted bytes before it
 * allocates any PK/FK Map.
 */
export async function validateMultiTableCandidate(
  request: MultiTableValidationRequest,
  signal?: AbortSignal | null,
  options?: MultiTableValidationOptions,
): Promise<MultiTableValidationResult> {
  throwIfAborted(signal);
  const checks: MultiTableValidationCheck[] = [];
  if (options !== undefined) {
    const startedAt = performance.now();
    const configuration = resourceConfigurationDecision(options.resourceBaseline, signal);
    if (configuration.validatorMode !== "memory") {
      await emitResourceTelemetry(options.resourceBaseline, {
        measurementSource: MULTITABLE_RESOURCE_CONFIGURATION_SOURCE,
        validatorMode: configuration.validatorMode,
        thresholdBasis: configuration.thresholdBasis,
        measuredInputs: [],
        measurementComplete: false,
        rowEstimate: null,
        keyEstimates: [],
        estimatedHeapBytes: configuration.estimatedHeapBytes,
        estimatedTempBytes: configuration.estimatedTempBytes,
        failureReason: configuration.failureReason,
      }, startedAt, signal);
      check(
        checks,
        "resource_baseline",
        request.candidate.candidate_id,
        false,
        resourceDecisionDetail(configuration),
      );
      return { passed: false, checks };
    }
  }
  try {
    parsePublicationCandidateRef(request.candidate);
    for (const table of request.tables) {
      parseTableDefinition(table.definition);
      parseDatasetSchemaV2(table.schema);
    }
    request.relations.forEach(parseRelationDefinition);
  } catch (error) {
    check(checks, "contract_parse", request.candidate.candidate_id, false,
      error instanceof Error ? error.message : String(error));
    return { passed: false, checks };
  }
  if (!validateDefinitions(request, checks)) return { passed: false, checks };

  let trustedRoot: string;
  let forbiddenRoots: string[];
  try {
    trustedRoot = await canonicalRoot(request.trusted_root);
    if (request.forbidden_roots.length === 0) {
      throw new Error("at least one Agent workspace or forbidden root is required");
    }
    forbiddenRoots = await Promise.all(request.forbidden_roots.map(canonicalRoot));
    if (forbiddenRoots.some((root) => isWithin(root, trustedRoot))) {
      throw new Error("trusted root is inside an Agent workspace or forbidden root");
    }
    check(checks, "trusted_root", request.candidate.candidate_id, true, trustedRoot);
  } catch (error) {
    check(checks, "trusted_root", request.candidate.candidate_id, false,
      error instanceof Error ? error.message : String(error));
    return { passed: false, checks };
  }

  const resolvedTables = new Map<string, ResolvedTrustedTable>();
  const scans = new Map<string, TableScan>();
  for (const table of request.tables) {
    const tableId = table.definition.table_id;
    if (table.file === null) {
      const allowed = !table.definition.required;
      check(checks, "trusted_table_input", tableId, allowed,
        allowed ? "optional table is absent" : "required table has no Core file reference");
      if (allowed) scans.set(tableId, { rowCount: 0, keyCounts: new Map(), diskIndexes: null });
      continue;
    }
    try {
      const resolved = await resolveTrustedTablePath(
        request, table, trustedRoot, forbiddenRoots, signal,
      );
      resolvedTables.set(tableId, resolved);
      check(checks, "trusted_table_input", tableId, true,
        `${table.file.relative_path}; size=${resolved.size}; sha256=${resolved.sha256}`);
    } catch (error) {
      check(checks, "trusted_table_input", tableId, false,
        error instanceof Error ? error.message : String(error));
    }
  }
  if (
    options !== undefined
    && checks.some((item) => item.check_id === "trusted_table_input" && !item.passed)
  ) {
    return { passed: false, checks };
  }

  let memoryBudget: MemoryScanBudget | undefined;
  if (options !== undefined) {
    const startedAt = performance.now();
    let measured: MultiTableMeasuredResources;
    try {
      measured = await measureResources(
        request,
        resolvedTables,
        options.resourceBaseline,
        signal,
      );
    } catch (error) {
      await emitResourceTelemetry(options.resourceBaseline, {
        measurementSource: MULTITABLE_RESOURCE_MEASUREMENT_SOURCE,
        validatorMode: "reject",
        thresholdBasis: null,
        measuredInputs: [],
        measurementComplete: false,
        rowEstimate: null,
        keyEstimates: [],
        estimatedHeapBytes: null,
        estimatedTempBytes: null,
        failureReason: "measurement_failed",
      }, startedAt, signal);
      check(checks, "resource_measurement", request.candidate.candidate_id, false,
        error instanceof Error ? error.message : String(error));
      return { passed: false, checks };
    }
    const decision = await resourcePreflight(
      options.resourceBaseline,
      measured,
      startedAt,
      options.b3Backend !== undefined,
      signal,
    );
    if (decision.validatorMode === "reject") {
      check(
        checks,
        "resource_baseline",
        request.candidate.candidate_id,
        false,
        resourceDecisionDetail(decision),
      );
      return { passed: false, checks };
    }
    // Production backend gate: memory stays at or below the measured
    // threshold; every disk capability (factory, immutable snapshot, parity
    // proof, owner, cancel, cleanup, temp quota) must hold or the validation
    // fails closed. There is no fallback to the Map-backed scan after an
    // explicit disk selection.
    const backend = decideB3Backend({
      taskId: request.task_id,
      requirementId: request.requirement_id,
      generation: options.b3Backend?.owner.generation ?? 0,
      measured: decision,
      factory: options.b3Backend?.factory ?? null,
      snapshotImmutable: options.b3Backend?.snapshotImmutable ?? false,
      parityProof: options.b3Backend?.parityProof ?? null,
      signal: signal ?? null,
      cleanup: options.b3Backend?.cleanup ?? null,
      owner: options.b3Backend?.owner ?? null,
    });
    if (backend.outcome === "reject") {
      check(
        checks,
        "resource_baseline",
        request.candidate.candidate_id,
        false,
        backendDecisionDetail(decision, backend),
      );
      return { passed: false, checks };
    }
    check(
      checks,
      "resource_baseline",
      request.candidate.candidate_id,
      true,
      resourceDecisionDetail(decision),
    );
    if (backend.outcome === "memory") {
      memoryBudget = createMemoryScanBudget(decision, options.resourceBaseline);
    } else {
      if (options.b3Backend === undefined) {
        throw new Error("disk backend admitted without production options");
      }
      throwIfAborted(signal);
      assertDiskIndexQuota(
        options.b3Backend,
        decision,
        diskIndexCount(request, resolvedTables),
      );
    }
  }

  const diskMode = options?.b3Backend !== undefined && memoryBudget === undefined;
  const createdIndexes: TupleIndex[] = [];
  try {
    for (const table of request.tables) {
      const tableId = table.definition.table_id;
      const resolved = resolvedTables.get(tableId);
      if (resolved === undefined) continue;
      let tableIndexes: Map<string, TupleIndex> | undefined;
      try {
        if (diskMode) {
          if (options?.b3Backend === undefined) {
            throw new Error("disk validator options are unavailable");
          }
          const b3Backend = options.b3Backend;
          tableIndexes = new Map();
          // One owner-bound disk index per unique PK/FK/relation combo; the
          // same index serves primary-key checks and FK/cardinality reuse.
          for (const fields of relationCombos(tableId, table.schema, request.relations)) {
            const index = await b3Backend.factory.createIndex({
              owner: {
                taskId: request.task_id,
                requirementId: request.requirement_id,
                generation: b3Backend.owner.generation,
              },
              directory: b3Backend.directory,
              quotaBytes: b3Backend.quotaBytesPerIndex,
              batchSize: b3Backend.batchSize,
              signal,
            });
            const owner = index.ownerBinding();
            if (
              owner.taskId !== request.task_id
              || owner.generation !== b3Backend.owner.generation
            ) {
              throw new DiskIndexOwnershipError(
                "created B3 disk index is not bound to the current validation owner",
              );
            }
            createdIndexes.push(index);
            tableIndexes.set(fieldsKey(fields), index);
          }
        }
        // Recheck the receipt digest immediately before the selected index pass.
        // This narrows but does not eliminate path-level TOCTOU; immutable
        // Core-owned descriptor snapshots are declared at the backend gate.
        const digest = await sha256File(resolved.path, signal);
        if (digest !== resolved.sha256) {
          throw new Error("table changed after resource measurement");
        }
        const scan = await scanTable(
          table,
          resolved.path,
          request,
          checks,
          signal,
          memoryBudget,
          options === undefined
            ? undefined
            : resourceScanBounds(
              options.resourceBaseline,
              table.definition.field_names.length,
            ),
          tableIndexes,
        );
        const digestAfterScan = await sha256File(resolved.path, signal);
        if (digestAfterScan !== resolved.sha256) {
          throw new Error("table changed during validation scan");
        }
        scans.set(tableId, scan);
      } catch (error) {
        if (diskMode) throw error;
        check(checks, "trusted_table_input", tableId, false,
          error instanceof Error ? error.message : String(error));
      }
    }
    for (const relation of request.relations) {
      await validateRelation(request, relation, scans, checks, signal);
    }
    return { passed: checks.every((item) => item.passed), checks };
  } finally {
    for (const index of createdIndexes) await index.cleanup();
  }
}
