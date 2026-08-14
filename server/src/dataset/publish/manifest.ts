/**
 * Role-based DatasetManifest V2 builder (ARCHITECTURE §3.6-3.7; Python
 * ``backend/app/datasets/build/manifest.py``).
 *
 * The manifest is the only authoritative entry point for locating the primary
 * dataset and its supporting artifacts — programs never hard-code filenames.
 * Manifest digest is computed over the data artifacts (primary, schema,
 * provenance, audits) so it is stable and independent of the manifest JSON
 * itself and of the validation report.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { JsonValue } from "@biomed/contracts";
import type {
  ArtifactRole,
  DatasetBuildSpec,
  DatasetManifest,
  DatasetSchema,
  ManifestArtifactEntry,
  ValidationResult,
} from "../contracts/index.js";
import { parseManifestArtifactEntry } from "../contracts/index.js";
import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { delimitedRowsWithLinesAsync, readSourceTextAsync } from "../adapters/text.js";
import { pyFloat, pythonJsonDumps } from "../runtime/digests.js";
import type { CanonicalizationResult } from "../canonicalizer/index.js";
import type { IntegrationResult } from "../integrator/index.js";
import type { SourceAsset } from "../contracts/index.js";

export const SCHEMA_FILE = "schema.json";
export const PROVENANCE_FILE = "provenance.json";
export const MANIFEST_FILE = "dataset_manifest.json";

export async function fileSha256(path: string, signal?: AbortSignal | null): Promise<string> {
  return sha256FileStream(path, signal);
}

/**
 * Deterministic digest over sorted (relative_path, sha256) artifact pairs
 * (Python ``package_digest``).
 */
export function packageDigest(entries: readonly ManifestArtifactEntry[]): string {
  const hasher = createHash("sha256");
  const sorted = [...entries].sort((a, b) => (a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0));
  for (const entry of sorted) {
    hasher.update(entry.relative_path, "utf8");
    hasher.update("\u0000", "utf8");
    hasher.update(entry.sha256, "utf8");
    hasher.update("\u0000", "utf8");
  }
  return hasher.digest("hex");
}

async function entry(
  role: ArtifactRole,
  path: string,
  outputDir: string,
  mediaType = "text/csv",
  signal?: AbortSignal | null,
): Promise<ManifestArtifactEntry> {
  const checksum = await fileSha256(path, signal);
  const relativePath = asPosix(relative(outputDir, path));
  // C3a: content-addressed ids must not collide when identical bytes appear
  // at two relative paths — include the path in the digest.
  const artifactId =
    "artifact_" +
    createHash("sha256")
      .update(`${relativePath}\u0000${checksum}`, "utf8")
      .digest("hex")
      .slice(0, 32);
  return parseManifestArtifactEntry({
    schema_version: "1.0",
    artifact_id: artifactId,
    role,
    relative_path: relativePath,
    media_type: mediaType,
    size_bytes: statSync(path).size,
    sha256: checksum,
  });
}

/** Write provenance.json: source inventory, mappings, rules, backtraces. */
export async function buildProvenanceDocument(options: {
  schema: DatasetSchema;
  integration: IntegrationResult;
  canonicalResults: readonly CanonicalizationResult[];
  sourceAssets: Readonly<Record<string, SourceAsset>>;
  outputDir: string;
  signal?: AbortSignal | null;
}): Promise<string> {
  const signal = options.signal ?? null;
  throwIfAborted(signal);
  const mappings = options.canonicalResults.flatMap((result) =>
    result.batch.declared_mappings.map((mapping) => ({
      mapping_id: mapping.mapping_id,
      source_field: mapping.source_field,
      target_field: mapping.target_field,
      transform: mapping.transform,
      mapping_method: mapping.mapping_method,
      confidence_level: mapping.confidence_level,
      evidence: mapping.evidence,
    })),
  );
  const normalizationRules = options.canonicalResults.map((result) => ({
    binding_id: result.batch.binding_id,
    namespaces: [...result.namespaces],
    normalization_log_file: rel(
      options.outputDir,
      result.auditPaths[1] ?? result.auditPaths[0] ?? "",
    ),
  }));
  const document = {
    schema_ref: options.schema.schema_id,
    sources: Object.entries(options.sourceAssets)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([bindingId, asset]) => ({
        binding_id: bindingId,
        asset_id: asset.asset_id,
        source_id: asset.source_id,
        logical_file: asset.relative_path.split("/").pop() ?? "",
        sha256: asset.sha256,
        successful_attempt_id: asset.successful_attempt_id,
      })),
    field_mappings: mappings,
    normalization_rules: normalizationRules,
    merge_strategy: options.integration.batch.statistics["merge_strategy"],
    sample_backtraces: await sampleBacktraces(options.integration.mergedPath, signal),
  };
  const path = joinOutput(options.outputDir, PROVENANCE_FILE);
  await writeFile(path, `${pythonJsonDumps(document)}\n`, "utf8");
  return path;
}

function rel(outputDir: string, path: string): string {
  if (path.length === 0) return "";
  return asPosix(relative(outputDir, path));
}

/** First *limit* primary rows as provenance backtraces (Python mirror). */
async function sampleBacktraces(primaryPath: string, signal?: AbortSignal | null, limit = 5): Promise<Array<Record<string, unknown>>> {
  const backtraces: Array<Record<string, unknown>> = [];
  for (const row of await readCsvDictRows(primaryPath, signal)) {
    backtraces.push({
      record_id: row["record_id"] ?? "",
      gene_id: row["gene_id"] ?? "",
      gene_id_namespace: row["gene_id_namespace"] ?? "",
      sample_id: row["sample_id"] ?? "",
      asset_id: row["asset_id"] ?? "",
      source_logical_file: row["source_logical_file"] ?? "",
      source_line_number: row["source_line_number"] ?? "",
      source_column_name: row["source_column_name"] ?? "",
      source_raw_value: row["source_raw_value"] ?? "",
      transforms: [
        {
          transform: "namespace_authorize",
          input: row["gene_id_raw"] ?? "",
          output: row["gene_id"] ?? "",
        },
      ],
    });
    if (backtraces.length >= limit) break;
  }
  return backtraces;
}

/** Provenance coverage of the primary dataset (Design §16 Phase 6 P2). */
export async function computeProvenanceCoverage(
  primaryPath: string,
  sourceAssetIds: ReadonlySet<string>,
  signal?: AbortSignal | null,
): Promise<{ traced_rows: number; untraced_rows: number; coverage_ratio: ReturnType<typeof pyFloat> }> {
  let traced = 0;
  let untraced = 0;
  for (const row of await readCsvDictRows(primaryPath, signal)) {
    const assetId = (row["asset_id"] ?? "").trim();
    if (assetId.length > 0 && sourceAssetIds.has(assetId)) {
      traced += 1;
    } else {
      untraced += 1;
    }
  }
  const total = traced + untraced;
  const ratio = total > 0 ? traced / total : 0;
  return {
    traced_rows: traced,
    untraced_rows: untraced,
    coverage_ratio: pyFloat(Math.round(ratio * 10000) / 10000),
  };
}

/** Manifest-side confidence contract surface (Python ``build_confidence_summary``). */
export async function buildConfidenceSummary(outputDir: string, signal?: AbortSignal | null): Promise<Record<string, JsonValue>> {
  const reportPath = joinOutput(outputDir, "confidence_report.csv");
  if (!existsSync(reportPath)) return {};
  let anomalyCount = 0;
  for (const row of await readCsvDictRows(reportPath, signal)) {
    if ((row["anomaly"] ?? "").trim().toLowerCase() === "true") {
      anomalyCount += 1;
    }
  }
  return {
    detected_anomaly_count: anomalyCount,
    report_file: "confidence_report.csv",
  };
}

/**
 * Assemble the immutable role-based manifest (pure; no manifest file write).
 * Writes the deterministic ``schema.json`` artifact (part of the digest
 * inputs), computes the package digest over data artifacts, and returns the
 * manifest object.
 */
export async function assembleManifest(options: {
  taskId: string;
  buildId: string;
  spec: DatasetBuildSpec;
  schema: DatasetSchema;
  integration: IntegrationResult;
  canonicalResults: readonly CanonicalizationResult[];
  provenancePath: string;
  auditPaths: readonly string[];
  validation: ValidationResult;
  sourceSummary: Record<string, JsonValue>;
  outputDir: string;
  signal?: AbortSignal | null;
}): Promise<DatasetManifest> {
  const signal = options.signal ?? null;
  throwIfAborted(signal);
  const schemaPath = joinOutput(options.outputDir, SCHEMA_FILE);
  await writeFile(schemaPath, `${pythonJsonDumps(options.schema)}\n`, "utf8");
  const entries: ManifestArtifactEntry[] = [
    await entry("primary_dataset", options.integration.mergedPath, options.outputDir, "text/csv", signal),
    await entry("schema", schemaPath, options.outputDir, "application/json", signal),
    await entry("provenance", options.provenancePath, options.outputDir, "application/json", signal),
  ];
  for (const path of [...options.auditPaths].sort()) {
    entries.push(await entry("audit_report", path, options.outputDir, undefined, signal));
  }
  const digest = packageDigest(entries);
  let sourceAssetIds: Set<string>;
  try {
    const document = JSON.parse(await readFile(options.provenancePath, "utf8")) as {
      sources?: Array<Record<string, unknown>>;
    };
    sourceAssetIds = new Set(
      (document["sources"] ?? [])
        .map((source) => source["asset_id"])
        .filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0),
    );
  } catch {
    sourceAssetIds = new Set();
  }
  const coverage = await computeProvenanceCoverage(options.integration.mergedPath, sourceAssetIds, signal);
  return {
    schema_version: "1.0",
    manifest_id: `manifest_${digest.slice(0, 16)}`,
    task_id: options.taskId,
    build_id: options.buildId,
    dataset_family: options.spec.dataset_family,
    row_granularity: options.spec.row_granularity,
    schema_ref: options.schema.schema_id,
    primary_key: [...options.schema.primary_key],
    row_count: options.integration.rowCount,
    sha256: digest,
    artifacts: entries,
    source_summary: options.sourceSummary,
    validation_summary: {
      profile_ref: options.validation.profile_ref,
      status: options.validation.status,
      checked_count: options.validation.checked_count,
      failed_count: options.validation.failed_count,
      report_path: options.validation.report_path,
    },
    confidence_summary: await buildConfidenceSummary(options.outputDir, signal),
    provenance_summary: {
      source_count: Object.keys(options.sourceSummary).length,
      field_mapping_count: options.canonicalResults.reduce(
        (sum, result) => sum + result.batch.declared_mappings.length,
        0,
      ),
      normalization_log_entries: options.canonicalResults.reduce(
        (sum, result) => sum + result.rowCount,
        0,
      ),
      rejected_count: options.canonicalResults.reduce(
        (sum, result) => sum + result.rejectedCount,
        0,
      ),
      dedup_count: options.integration.dedupCount,
      conflict_count: options.integration.conflictCount,
      // coverage_ratio is a PyFloat marker so pythonJsonDumps emits
      // 1.0 like Python json.dumps(round(ratio, 4)); it is JSON-safe.
      coverage: coverage as unknown as JsonValue,
    },
  };
}

/** Write ``dataset_manifest.json`` for an assembled manifest. */
export function writeManifest(manifest: DatasetManifest, outputDir: string): string {
  const manifestPath = joinOutput(outputDir, MANIFEST_FILE);
  writeFileSync(manifestPath, `${pythonJsonDumps(manifest)}\n`, "utf8");
  return manifestPath;
}

function joinOutput(outputDir: string, name: string): string {
  return `${outputDir.replace(/[\\/]+$/, "")}/${name}`;
}

function asPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Python csv.DictReader: header row + per-row field dicts. */
async function readCsvDictRows(path: string, signal?: AbortSignal | null): Promise<Array<Record<string, string>>> {
  if (!existsSync(path)) return [];
  const rows = await delimitedRowsWithLinesAsync(await readSourceTextAsync(path, signal), ",", signal);
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

export type { DatasetManifest, ManifestArtifactEntry };