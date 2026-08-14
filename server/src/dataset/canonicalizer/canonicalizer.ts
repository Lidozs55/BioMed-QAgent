/**
 * Canonicalizer: DataBatch -> canonical ``gene_expression.long.v1`` rows
 * (Python ``app/datasets/build/canonicalizer.py``).
 *
 * Applies the expression normalization profile (ARCHITECTURE 8; Design 8.5):
 *
 * - authorizes each gene-id namespace (ensembl_gene / gene_symbol / geo_probe)
 *   and splits version suffixes, recording a normalization-log entry per
 *   entity;
 * - enforces the profile's allowed units / value semantics / value scales
 *   (Phase 5 D3: a scale outside the profile's ``allowed_value_scales`` is
 *   rejected; ``unknown`` is honest and never promoted to a known scale);
 * - separates normalization-rejected rows into an audit file.
 *
 * The canonicalizer is pure and deterministic: identical inputs produce
 * identical outputs and audits.
 */

import { mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { JsonValue } from "@biomed/contracts";
import type {
  DataBatch,
  DatasetSchema,
  FieldMapping,
  NormalizationProfile,
  ValueScale,
} from "../contracts/index.js";
import { assertValueScale, parseDataBatch, parseFileAsset } from "../contracts/index.js";
import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import { BuildError } from "../adapters/errors.js";
import { assetIdFromSha256, makeRecordId } from "../adapters/identity.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { csvLine, delimitedRowsWithLinesAsync, readSourceTextAsync } from "../adapters/text.js";
import { MeasurementIdentity } from "./identity.js";

const ENSEMBL_PATTERN = /^(ENSG\d{11})(?:\.(\d+))?$/;
const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
//: Affymetrix control/quality probes (``AFFX-...``) are not gene symbols;
//: namespace must come from the adapter declaration, never the ID shape
//: (Phase 5 D1).
const AFFYMETRIX_CONTROL_PATTERN = /^AFFX-/i;

export const NORMALIZATION_LOG_COLUMNS: readonly string[] = [
  "record_id",
  "gene_id_raw",
  "gene_id",
  "gene_id_namespace",
  "gene_id_version",
  "rule_id",
  "evidence",
];

export const FIELD_MAPPING_COLUMNS: readonly string[] = [
  "mapping_id",
  "source_schema_ref",
  "target_schema_ref",
  "source_field",
  "target_field",
  "transform",
  "mapping_method",
  "confidence_level",
  "evidence",
  "review_status",
];

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

/** Output of one source's canonicalization step (Python frozen dataclass). */
export interface CanonicalizationResult {
  batch: DataBatch;
  canonicalPath: string;
  rowCount: number;
  rejectedCount: number;
  namespaces: string[];
  auditPaths: string[];
}

export interface CanonicalizeOptions {
  batch: DataBatch;
  schema: DatasetSchema;
  profile: NormalizationProfile;
  outputDir: string;
  geneSymbolMap?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  probeMap?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  probeTargetNamespace?: string;
}

export type AuthorizedNamespace = [geneId: string, namespace: string, version: string];

/**
 * Return ``[gene_id, namespace, version]`` or null when unauthorized.
 *
 * Phase 5 D1: the adapter-declared namespace
 * (``gene_id_namespace_declared`` source-long column) is authoritative when
 * present — ``geo_probe`` rows are never guessed into ``gene_symbol`` by ID
 * shape.  Without a declaration (legacy GDC/Xena rows) the ENSG shape and a
 * conservative gene-symbol shape authorize; probe-like identifiers such as
 * Affymetrix control probes are never authorized as ``gene_symbol``.
 */
export function authorizeNamespace(
  geneIdRaw: string,
  declaredNamespace = "",
): AuthorizedNamespace | null {
  if (declaredNamespace !== "") {
    if (declaredNamespace === "ensembl_gene") {
      const ensembl = ENSEMBL_PATTERN.exec(geneIdRaw);
      if (ensembl === null) return null;
      return [ensembl[1], "ensembl_gene", ensembl[2] ?? ""];
    }
    if (declaredNamespace === "gene_symbol") {
      return [geneIdRaw, "gene_symbol", ""];
    }
    if (declaredNamespace === "geo_probe") {
      return [geneIdRaw, "geo_probe", ""];
    }
    return null;
  }
  const ensembl = ENSEMBL_PATTERN.exec(geneIdRaw);
  if (ensembl !== null) {
    return [ensembl[1], "ensembl_gene", ensembl[2] ?? ""];
  }
  if (
    SYMBOL_PATTERN.test(geneIdRaw) &&
    !AFFYMETRIX_CONTROL_PATTERN.test(geneIdRaw)
  ) {
    return [geneIdRaw, "gene_symbol", ""];
  }
  return null;
}

/** Python ``math.isfinite(float(value))`` for a raw cell string. */
function isFiniteNumber(value: string): boolean {
  if (value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

/** Python ``ValueScale(value)`` with a null result for unparseable strings. */
function parseValueScale(value: string): ValueScale | null {
  try {
    return assertValueScale(value, "value_scale");
  } catch {
    return null;
  }
}

interface RejectedRow {
  rejected_id: string;
  batch_id: string;
  gene_id_raw: string;
  sample_id: string;
  reason_code: string;
  reason: string;
  source_logical_file: string;
  source_line_number: string;
  source_raw_value: string;
}

function rejectedRow(
  row: Record<string, string>,
  batch: DataBatch,
  reasonCode: string,
  detail = "",
): RejectedRow {
  let reason = reasonCode.replace(/_/g, " ");
  if (detail !== "") {
    reason = `${reason} (${detail})`;
  }
  return {
    rejected_id: `rej_${batch.binding_id}_${row.record_id ?? ""}`,
    batch_id: batch.batch_id,
    gene_id_raw: row.gene_id_raw ?? "",
    sample_id: row.sample_id ?? "",
    reason_code: reasonCode,
    reason,
    source_logical_file: row.source_logical_file ?? "",
    source_line_number: row.source_line_number ?? "",
    source_raw_value: row.source_raw_value ?? "",
  };
}

async function writeFieldMappings(
  mappingsPath: string,
  mappings: readonly FieldMapping[],
): Promise<void> {
  const lines = [csvLine(FIELD_MAPPING_COLUMNS)];
  for (const mapping of mappings) {
    lines.push(
      csvLine([
        mapping.mapping_id,
        mapping.source_schema_ref,
        mapping.target_schema_ref,
        mapping.source_field,
        mapping.target_field,
        mapping.transform,
        mapping.mapping_method,
        mapping.confidence_level,
        mapping.evidence,
        mapping.review_status,
      ]),
    );
  }
  await writeFile(mappingsPath, lines.join(""), "utf8");
}

/**
 * Transform one source-long batch into canonical schema rows.
 *
 * ``geneSymbolMap`` optionally maps ``gene_symbol`` IDs to Ensembl gene IDs
 * (local, ship-bound; REVIEW 9.6).  A mapped row is re-namespaced to
 * ``ensembl_gene`` and recorded in the normalization log; unmapped symbols
 * stay in their original namespace and are never dropped.
 *
 * Phase 5 T7 (D2/D5): ``probeMap`` optionally maps ``geo_probe`` rows to gene
 * identifiers (a GPL platform annotation).  A hit is re-namespaced to
 * ``probeTargetNamespace`` and recorded with rule ``probe_gene_map``; an
 * unmapped probe stays ``geo_probe``.  Under the probe schema
 * (``gene_expression.probe_long.v1``) the canonical row carries
 * ``probe_id``/``platform_id``/``value`` instead of the gene-schema primary
 * columns.
 */
export async function canonicalize(
  options: CanonicalizeOptions,
  signal?: AbortSignal | null,
): Promise<CanonicalizationResult> {
  throwIfAborted(signal);
  const {
    batch,
    schema,
    profile,
    outputDir,
    geneSymbolMap,
    probeMap,
    probeTargetNamespace = "gene_symbol",
  } = options;
  if (batch.file_asset === null) {
    throw new BuildError("batch has no file asset to canonicalize");
  }
  const sourcePath = join(outputDir, batch.file_asset.relative_path);
  if (!isFileSync(sourcePath)) {
    throw new BuildError(`batch file not found: ${sourcePath}`);
  }
  const canonicalDir = join(outputDir, "canonical");
  mkdirSync(canonicalDir, { recursive: true });
  const canonicalPath = join(canonicalDir, `${batch.binding_id}.csv`);
  const rejectedPath = join(canonicalDir, `${batch.binding_id}_rejected.csv`);
  const logPath = join(canonicalDir, `${batch.binding_id}_normalization_log.csv`);
  const mappingsPath = join(canonicalDir, `${batch.binding_id}_field_mappings.csv`);

  const columns = schema.fields.map((field) => field.name);
  const probeSchema = schema.fields.some((field) => field.name === "probe_id");
  const platformIds = (
    Array.isArray(batch.statistics.platform_ids) ? batch.statistics.platform_ids : []
  ).map((platformId) => String(platformId));

  let rowCount = 0;
  let rejectedCount = 0;
  let mappedCount = 0;
  let probeMappedCount = 0;
  const namespaces = new Set<string>();
  const units = new Set<string>();
  const identities = new Map<string, MeasurementIdentity>();
  const canonicalRows: string[][] = [];
  const rejectedRows: string[][] = [];
  const logRows: string[][] = [];

  const text = await readSourceTextAsync(sourcePath, signal);
  const rows = await delimitedRowsWithLinesAsync(text, ",", signal);
  const header = rows[0]?.values ?? [];
  let visited = 0;
  for (const { values } of rows.slice(1)) {
    visited += 1;
    // M2: checkpoint per processed row (not only accepted rows) so an
    // extreme all-rejected workload still yields to the event loop and
    // honors the operation timeout / cancel signal.
    if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
    const row: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]] = values[index] ?? "";
    }
    const geneIdRaw = row.gene_id_raw ?? "";
    const declared = row.gene_id_namespace_declared ?? "";
    const normalized =
      geneIdRaw !== "" ? authorizeNamespace(geneIdRaw, declared) : null;
    if (normalized === null) {
      rejectedRows.push(
        toRejectedValues(rejectedRow(row, batch, "unauthorized_namespace")),
      );
      rejectedCount += 1;
      continue;
    }
    let [geneId, namespace, version] = normalized;
    if (!profile.allowed_namespaces.includes(namespace)) {
      rejectedRows.push(
        toRejectedValues(rejectedRow(row, batch, "unauthorized_namespace")),
      );
      rejectedCount += 1;
      continue;
    }
    const unit = row.expression_unit ?? "";
    const semantics = row.value_semantics ?? "";
    if (!profile.allowed_units.includes(unit)) {
      rejectedRows.push(
        toRejectedValues(rejectedRow(row, batch, "unknown_unit", `unit='${unit}'`)),
      );
      rejectedCount += 1;
      continue;
    }
    if (!profile.allowed_semantics.includes(semantics)) {
      rejectedRows.push(
        toRejectedValues(
          rejectedRow(row, batch, "unknown_semantics", `semantics='${semantics}'`),
        ),
      );
      rejectedCount += 1;
      continue;
    }
    // Phase 5 D3/T4: the declared value scale must be an honest ``ValueScale``
    // member that the profile explicitly allows.  ``unknown`` is accepted only
    // when allowed; it is never promoted to a known scale (log2) by inference.
    const scaleRaw = row.value_scale ?? "";
    const scale = parseValueScale(scaleRaw);
    if (scale === null || !profile.allowed_value_scales.includes(scale)) {
      rejectedRows.push(
        toRejectedValues(rejectedRow(row, batch, "unknown_scale", `scale='${scaleRaw}'`)),
      );
      rejectedCount += 1;
      continue;
    }
    const expressionValue = row.expression_value ?? "";
    if (!isFiniteNumber(expressionValue)) {
      rejectedRows.push(
        toRejectedValues(
          rejectedRow(row, batch, "non_finite_value", `value='${expressionValue}'`),
        ),
      );
      rejectedCount += 1;
      continue;
    }
    let mapped = false;
    if (namespace === "gene_symbol" && geneSymbolMap !== undefined) {
      const target = lookupMap(geneSymbolMap, geneId);
      if (target !== undefined) {
        geneId = target;
        namespace = "ensembl_gene";
        version = "";
        mapped = true;
        mappedCount += 1;
      }
    }
    let probeMapped = false;
    if (namespace === "geo_probe" && probeMap !== undefined) {
      const target = lookupMap(probeMap, geneId);
      if (target !== undefined) {
        geneId = target;
        namespace = probeTargetNamespace;
        version = "";
        probeMapped = true;
        probeMappedCount += 1;
      }
    }
    const canonicalRow: Record<string, string> = {};
    for (const column of columns) {
      const value = row[column];
      if (value !== undefined) canonicalRow[column] = value;
    }
    canonicalRow.record_id = makeRecordId(
      row.dataset_id,
      row.gene_id_raw,
      row.sample_id,
    );
    if (probeSchema) {
      // Under the probe contract the identity column is the ORIGINAL probe id;
      // probe->gene mapping only flips the namespace (the mapped gene id itself
      // lives in the mapping audit CSV).
      canonicalRow.probe_id = row.gene_id_raw ?? "";
      canonicalRow.platform_id = platformIds.length > 0 ? platformIds[0] : "";
      if (columns.includes("value")) {
        canonicalRow.value = row.expression_value ?? "";
      }
    } else {
      canonicalRow.gene_id = geneId;
      canonicalRow.gene_id_version = version;
    }
    canonicalRow.gene_id_namespace = namespace;
    const isStar = batch.statistics.format === "star_counts";
    canonicalRow.source_sample_alias = isStar ? "" : (row.source_column_name ?? "");
    canonicalRows.push(columns.map((column) => canonicalRow[column] ?? ""));
    const ruleId = probeMapped
      ? "probe_gene_map"
      : mapped
        ? "gene_symbol_map"
        : namespace === "ensembl_gene" && version !== ""
          ? "ensembl_version_split"
          : `namespace_${namespace}`;
    const evidence = probeMapped
      ? "GPL platform annotation (probe->gene)"
      : mapped
        ? "local gene symbol map (symbol->ensembl)"
        : namespace === "ensembl_gene"
          ? "Ensembl ID pattern ENSG###########(.N)"
          : "HGNC gene symbol pattern";
    logRows.push(
      toLogValues({
        record_id: canonicalRow.record_id,
        gene_id_raw: row.gene_id_raw ?? "",
        gene_id: geneId,
        gene_id_namespace: namespace,
        gene_id_version: version,
        rule_id: ruleId,
        evidence,
      }),
    );
    namespaces.add(namespace);
    units.add(unit);
    const identity = new MeasurementIdentity(semantics, scale, unit);
    identities.set(identity.key(), identity);
    rowCount += 1;
  }

  await writeFile(
    canonicalPath,
    csvLine(columns) + canonicalRows.map((row) => csvLine(row)).join(""),
    "utf8",
  );
  await writeFile(
    rejectedPath,
    csvLine(REJECTED_COLUMNS) + rejectedRows.map((row) => csvLine(row)).join(""),
    "utf8",
  );
  await writeFile(
    logPath,
    csvLine(NORMALIZATION_LOG_COLUMNS) + logRows.map((row) => csvLine(row)).join(""),
    "utf8",
  );
  await writeFieldMappings(mappingsPath, batch.declared_mappings);

  const payloadChecksum = await sha256FileStream(canonicalPath, signal);
  const fileAsset = parseFileAsset({
    schema_version: "1.0",
    asset_id: assetIdFromSha256(payloadChecksum),
    kind: "normalized",
    relative_path: relative(outputDir, canonicalPath).replace(/\\/g, "/"),
    sha256: payloadChecksum,
    size_bytes: statSync(canonicalPath).size,
    media_type: "text/csv",
    generated_by_step_id: "step_canonicalizer_v1",
  });
  // Unit-inconsistency detection: a canonical batch that mixes more than one
  // expression unit is recorded as an audit warning so the publication
  // decision can surface it instead of silently merging incompatible scales.
  const unitWarnings: string[] = [];
  if (units.size > 1) {
    const sortedUnits = [...units].sort();
    unitWarnings.push(
      `multiple expression units in one batch: [${
        sortedUnits.map((unit) => `'${unit}'`).join(", ")
      }]`,
    );
  }
  const statistics: Record<string, JsonValue> = {
    ...batch.statistics,
    row_count: rowCount,
    rejected_count: rejectedCount,
    gene_id_namespaces: [...namespaces].sort(),
    gene_symbol_mapped_count: mappedCount,
    probe_mapped_count: probeMappedCount,
    expression_units: [...units].sort(),
    unit_inconsistency_detected: units.size > 1,
    measurement_identities: [...identities.values()]
      .sort((a, b) => a.compareTo(b))
      .map((identity) => identity.serialize()),
    schema_ref: schema.schema_id,
  };
  const canonicalBatch = parseDataBatch({
    schema_version: "1.0",
    batch_id: `canon_${batch.binding_id}`,
    binding_id: batch.binding_id,
    dataset_family: batch.dataset_family,
    row_granularity: batch.row_granularity,
    schema_ref: schema.schema_id,
    file_asset: fileAsset,
    row_count: rowCount,
    column_count: columns.length,
    parser_id: "expression.canonicalizer.v1",
    parser_version: "1.0.0",
    statistics,
    warnings: [...batch.warnings, ...unitWarnings],
    declared_mappings: batch.declared_mappings,
  });
  return {
    batch: canonicalBatch,
    canonicalPath,
    rowCount,
    rejectedCount,
    namespaces: [...namespaces].sort(),
    auditPaths: [rejectedPath, logPath, mappingsPath],
  };
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isMap(
  map: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
): map is ReadonlyMap<string, string> {
  return map instanceof Map;
}

function lookupMap(
  map: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
  key: string,
): string | undefined {
  if (isMap(map)) return map.get(key);
  return map[key];
}

function toRejectedValues(row: RejectedRow): string[] {
  return [
    row.rejected_id,
    row.batch_id,
    row.gene_id_raw,
    row.sample_id,
    row.reason_code,
    row.reason,
    row.source_logical_file,
    row.source_line_number,
    row.source_raw_value,
  ];
}

function toLogValues(row: Record<string, string>): string[] {
  return NORMALIZATION_LOG_COLUMNS.map((column) => row[column] ?? "");
}