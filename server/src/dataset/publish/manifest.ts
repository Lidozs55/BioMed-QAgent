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
  DatasetExecutionSpec,
  DatasetManifest,
  DatasetSchema,
  ManifestArtifactEntry,
  ValidationResult,
} from "../contracts/index.js";
import { parseManifestArtifactEntry } from "../contracts/index.js";
import { CHECKPOINT_STRIDE, checkpoint, throwIfAborted } from "../cooperative.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { asPosix, joinOutput } from "../adapters/paths.js";
import { delimitedRowsFromFileAsync } from "../adapters/text.js";
import { pyFloat, pythonJsonDumps } from "../runtime/digests.js";
import type { CanonicalizationResult } from "../canonicalizer/index.js";
import type { IntegrationResult } from "../integrator/index.js";
import type { SourceAsset } from "../contracts/index.js";
import {
  CONFIDENCE_ARTIFACT_FILE,
  readConfidenceArtifact,
} from "../confidence/artifact.js";

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

export interface HumanCorrectionProvenance {
  human_corrections: Array<Record<string, JsonValue>>;
  transform_records: Array<Record<string, JsonValue>>;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function buildHumanCorrectionProvenance(
  results: readonly CanonicalizationResult[],
): HumanCorrectionProvenance {
  const humanCorrections: Array<Record<string, JsonValue>> = [];
  const transformRecords: Array<Record<string, JsonValue>> = [];
  for (const result of results) {
    const bindingId = result.batch.binding_id;
    const mappingCorrections = result.batch.statistics["human_mapping_corrections"];
    if (Array.isArray(mappingCorrections)) {
      for (const value of mappingCorrections) {
        const correction = jsonRecord(value);
        if (correction === null) continue;
        const original = correction["original"] ?? null;
        const corrected = correction["corrected"] ?? null;
        const mappingId = correction["mapping_id"] ?? "unknown_mapping";
        const reviewId = correction["review_id"] ?? null;
        humanCorrections.push({
          kind: "field_mapping",
          binding_id: bindingId,
          ...correction,
        });
        transformRecords.push({
          transform_id: `human_mapping_${String(mappingId)}_${String(reviewId ?? "review")}`,
          binding_id: bindingId,
          subject_id: mappingId,
          method: "human_correction",
          input: original,
          output: corrected,
          review_id: reviewId,
        });
      }
    }
    const unitCorrection = jsonRecord(result.batch.statistics["human_unit_correction"]);
    if (unitCorrection?.["method"] === "human_correction") {
      const reviewId = unitCorrection["review_id"] ?? null;
      const input = { unit: unitCorrection["from_unit"] ?? null };
      const output = {
        unit: unitCorrection["to_unit"] ?? null,
        factor: unitCorrection["factor"] ?? null,
        offset: unitCorrection["offset"] ?? null,
      };
      humanCorrections.push({
        kind: "unit_conversion",
        binding_id: bindingId,
        ...unitCorrection,
      });
      transformRecords.push({
        transform_id: `human_unit_${bindingId}_${String(reviewId ?? "review")}`,
        binding_id: bindingId,
        subject_id: bindingId,
        method: "human_correction",
        input,
        output,
        review_id: reviewId,
      });
    }
  }
  return { human_corrections: humanCorrections, transform_records: transformRecords };
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
  const correctionProvenance = buildHumanCorrectionProvenance(options.canonicalResults);
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
    human_corrections: correctionProvenance.human_corrections,
    transform_records: correctionProvenance.transform_records,
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

function dictRecord(header: readonly string[], values: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index < header.length; index += 1) {
    record[header[index]] = values[index] ?? "";
  }
  return record;
}

/** First *limit* primary rows as provenance backtraces (Python mirror). */
async function sampleBacktraces(primaryPath: string, signal?: AbortSignal | null, limit = 5): Promise<Array<Record<string, unknown>>> {
  const backtraces: Array<Record<string, unknown>> = [];
  let header: string[] = [];
  let headerSeen = false;
  for await (const { values } of delimitedRowsFromFileAsync(primaryPath, ",", signal)) {
    if (!headerSeen) {
      headerSeen = true;
      header = values;
      continue;
    }
    const row = dictRecord(header, values);
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
  let visited = 0;
  let header: string[] = [];
  let headerSeen = false;
  for await (const { values } of delimitedRowsFromFileAsync(primaryPath, ",", signal)) {
    if (!headerSeen) {
      headerSeen = true;
      header = values;
      continue;
    }
    const row = dictRecord(header, values);
    const assetId = (row["asset_id"] ?? "").trim();
    if (assetId.length > 0 && sourceAssetIds.has(assetId)) {
      traced += 1;
    } else {
      untraced += 1;
    }
    visited += 1;
    if (visited % CHECKPOINT_STRIDE === 0) await checkpoint(signal);
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
  const artifact = await readConfidenceArtifact(outputDir);
  const reportPath = joinOutput(outputDir, "confidence_report.csv");
  let anomalyCount = 0;
  if (existsSync(reportPath)) {
    let header: string[] = [];
    let headerSeen = false;
    for await (const { values } of delimitedRowsFromFileAsync(reportPath, ",", signal)) {
      if (!headerSeen) {
        headerSeen = true;
        header = values;
        continue;
      }
      const row = dictRecord(header, values);
      if ((row["anomaly"] ?? "").trim().toLowerCase() === "true") {
        anomalyCount += 1;
      }
    }
  }
  if (artifact === null && !existsSync(reportPath)) return {};
  const summary: Record<string, JsonValue> = {};
  if (artifact !== null) {
    const levels: Record<"high" | "medium" | "low", number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    const reviewStates: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    const overridesByBatch = new Map<string, number>();
    for (const override of artifact.record_overrides) {
      overridesByBatch.set(
        override.batch_id,
        (overridesByBatch.get(override.batch_id) ?? 0) + 1,
      );
    }
    const add = (
      level: "high" | "medium" | "low",
      humanReviewState: string,
      recordReasons: readonly string[],
      count: number,
    ): void => {
      levels[level] += count;
      reviewStates[humanReviewState] = (reviewStates[humanReviewState] ?? 0) + count;
      for (const reason of recordReasons) reasons[reason] = (reasons[reason] ?? 0) + count;
    };
    for (const batch of artifact.batch_defaults) {
      add(
        batch.level,
        batch.components.human_review_state,
        batch.reasons,
        Math.max(0, batch.record_count - (overridesByBatch.get(batch.batch_id) ?? 0)),
      );
    }
    for (const override of artifact.record_overrides) {
      add(
        override.level,
        override.components.human_review_state,
        override.reasons,
        1,
      );
    }
    summary["level_distribution"] = levels;
    summary["human_review_distribution"] = reviewStates;
    summary["reason_counts"] = reasons;
    summary["pending_human_review_count"] = reviewStates["pending"] ?? 0;
    summary["batch_default_count"] = artifact.batch_defaults.length;
    summary["record_override_count"] = artifact.record_overrides.length;
    summary["evidence_report_file"] = CONFIDENCE_ARTIFACT_FILE;
  }
  if (existsSync(reportPath)) {
    summary["statistical_anomalies"] = {
      detected_count: anomalyCount,
      report_file: "confidence_report.csv",
    };
    // Compatibility aliases for historical result viewers. New policy and UI
    // consume statistical_anomalies, never these fields as evidence strength.
    summary["detected_anomaly_count"] = anomalyCount;
    summary["report_file"] = "confidence_report.csv";
  }
  return summary;
}

/**
 * Assemble the immutable role-based manifest (pure; no manifest file write).
 * Writes the deterministic ``schema.json`` artifact (part of the digest
 * inputs), computes the package digest over data artifacts, and returns the
 * manifest object.
 */
export async function assembleManifest(options: {
  taskId: string;
  requirementId: string;
  spec: DatasetExecutionSpec;
  schema: DatasetSchema;
  integration: IntegrationResult;
  canonicalResults: readonly CanonicalizationResult[];
  provenancePath: string;
  auditPaths: readonly string[];
  validation: ValidationResult;
  sourceSummary: Record<string, JsonValue>;
  outputDir: string;
  signal?: AbortSignal | null;
  reusePrimaryEntry?: ManifestArtifactEntry | null;
}): Promise<DatasetManifest> {
  const signal = options.signal ?? null;
  throwIfAborted(signal);
  const schemaPath = joinOutput(options.outputDir, SCHEMA_FILE);
  await writeFile(schemaPath, `${pythonJsonDumps(options.schema)}\n`, "utf8");
  const entries: ManifestArtifactEntry[] = [
    options.reusePrimaryEntry ??
      (await entry("primary_dataset", options.integration.mergedPath, options.outputDir, "text/csv", signal)),
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
    requirement_id: options.requirementId,
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

export type { DatasetManifest, ManifestArtifactEntry };
