/**
 * Immutable manifest and publication contracts (Python ``DatasetManifest`` /
 * ``DatasetPublication`` / ``ManifestArtifactEntry``). Wire types come from
 * ``@biomed/contracts``; these parse functions enforce the Pydantic
 * invariants the deterministic core relies on.
 */

import type {
  ArtifactRole,
  DatasetManifestV1,
  DatasetManifestV2,
  DatasetPublication,
  ManifestArtifactEntry,
  VersionedDatasetManifest,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalString,
  assertRecord,
  assertString,
  assertStringArray,
  parsePublicationSchemaVersion,
  parseSchemaVersion,
} from "./primitives.js";
import { parseDatasetManifestV2 } from "./multitable.js";
export * from "./multitable.js";

export type {
  DatasetManifest,
  DatasetPublication,
  ManifestArtifactEntry,
  VersionedDatasetManifest,
} from "@biomed/contracts";

function isArtifactRole(value: string): value is ArtifactRole {
  return (
    value === "primary_dataset" ||
    value === "supporting_dataset" ||
    value === "schema" ||
    value === "provenance" ||
    value === "audit_report"
  );
}

const MANIFEST_ARTIFACT_ENTRY_KEYS = [
  "schema_version",
  "artifact_id",
  "role",
  "relative_path",
  "media_type",
  "size_bytes",
  "sha256",
] as const;

export function parseManifestArtifactEntry(value: unknown): ManifestArtifactEntry {
  const record = assertRecord(value, "ManifestArtifactEntry");
  assertExactKeys(record, MANIFEST_ARTIFACT_ENTRY_KEYS, "ManifestArtifactEntry");
  const role = assertString(record.role, "ManifestArtifactEntry.role");
  if (!isArtifactRole(role)) {
    throw new TypeError("ManifestArtifactEntry.role is not a valid artifact role");
  }
  return {
    schema_version: parseSchemaVersion(record),
    artifact_id: assertNonEmptyString(
      record.artifact_id,
      "ManifestArtifactEntry.artifact_id",
    ),
    role,
    relative_path: assertNonEmptyString(
      record.relative_path,
      "ManifestArtifactEntry.relative_path",
    ),
    media_type: assertNonEmptyString(
      record.media_type,
      "ManifestArtifactEntry.media_type",
    ),
    size_bytes: assertNonNegativeInt(
      record.size_bytes,
      "ManifestArtifactEntry.size_bytes",
    ),
    sha256: assertNonEmptyString(record.sha256, "ManifestArtifactEntry.sha256"),
  };
}

const DATASET_MANIFEST_KEYS = [
  "schema_version",
  "manifest_id",
  "task_id",
  "build_id",
  "dataset_family",
  "row_granularity",
  "schema_ref",
  "primary_key",
  "row_count",
  "sha256",
  "artifacts",
  "source_summary",
  "validation_summary",
  "confidence_summary",
  "provenance_summary",
] as const;

export function parseDatasetManifest(value: DatasetManifestV2): DatasetManifestV2;
export function parseDatasetManifest(value: DatasetManifestV1): DatasetManifestV1;
export function parseDatasetManifest(value: Record<string, unknown>): DatasetManifestV1;
export function parseDatasetManifest(value: unknown): VersionedDatasetManifest;
export function parseDatasetManifest(value: unknown): VersionedDatasetManifest {
  const record = assertRecord(value, "DatasetManifest");
  if (record.schema_version === "2.0") return parseDatasetManifestV2(record);
  assertExactKeys(record, DATASET_MANIFEST_KEYS, "DatasetManifest");
  const artifacts = (() => {
    if (!Array.isArray(record.artifacts)) {
      throw new TypeError("DatasetManifest.artifacts must be an array");
    }
    return record.artifacts.map((entry) => parseManifestArtifactEntry(entry));
  })();
  const primaries = artifacts.filter((entry) => entry.role === "primary_dataset");
  if (primaries.length > 1) {
    throw new TypeError("manifest may declare at most one primary_dataset");
  }
  return {
    schema_version: parseSchemaVersion(record),
    manifest_id: assertNonEmptyString(record.manifest_id, "DatasetManifest.manifest_id"),
    task_id: assertNonEmptyString(record.task_id, "DatasetManifest.task_id"),
    build_id: assertNonEmptyString(record.build_id, "DatasetManifest.build_id"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "DatasetManifest.dataset_family",
    ),
    row_granularity: assertNonEmptyString(
      record.row_granularity,
      "DatasetManifest.row_granularity",
    ),
    schema_ref: assertNonEmptyString(record.schema_ref, "DatasetManifest.schema_ref"),
    primary_key: record.primary_key === undefined
      ? []
      : assertStringArray(record.primary_key, "DatasetManifest.primary_key"),
    row_count: assertNonNegativeInt(record.row_count, "DatasetManifest.row_count"),
    sha256: assertNonEmptyString(record.sha256, "DatasetManifest.sha256"),
    artifacts,
    source_summary: record.source_summary === undefined
      ? {}
      : assertJsonRecord(record.source_summary, "DatasetManifest.source_summary"),
    validation_summary: record.validation_summary === undefined
      ? {}
      : assertJsonRecord(record.validation_summary, "DatasetManifest.validation_summary"),
    confidence_summary: record.confidence_summary === undefined
      ? {}
      : assertJsonRecord(record.confidence_summary, "DatasetManifest.confidence_summary"),
    provenance_summary: record.provenance_summary === undefined
      ? {}
      : assertJsonRecord(record.provenance_summary, "DatasetManifest.provenance_summary"),
  };
}

const DATASET_PUBLICATION_KEYS = [
  "schema_version",
  "publication_id",
  "manifest_ref",
  "manifest_sha256",
  "validation_result_ref",
  "published_at",
  "supersedes_publication_id",
] as const;

const PUBLICATION_SHA256 = /^[0-9a-f]{64}$/;

export function parseDatasetPublication(value: unknown): DatasetPublication {
  const record = assertRecord(value, "DatasetPublication");
  assertExactKeys(record, DATASET_PUBLICATION_KEYS, "DatasetPublication");
  const publicationId = assertNonEmptyString(
    record.publication_id,
    "DatasetPublication.publication_id",
  );
  const supersedes = assertOptionalString(
    record.supersedes_publication_id,
    "DatasetPublication.supersedes_publication_id",
  );
  if (supersedes === publicationId) {
    throw new TypeError("publication cannot supersede itself");
  }
  const schemaVersion = parsePublicationSchemaVersion(record);
  let manifestSha256: string | undefined;
  if (schemaVersion === "1.1") {
    // P7 trust anchor: SHA-256 of the dataset_manifest.json file bytes.
    // A 1.1 record without the receipt is malformed and must not parse.
    manifestSha256 = assertNonEmptyString(
      record.manifest_sha256,
      "DatasetPublication.manifest_sha256",
    );
    if (!PUBLICATION_SHA256.test(manifestSha256)) {
      throw new TypeError("DatasetPublication.manifest_sha256 must be a SHA-256 hex digest");
    }
  } else if (record.manifest_sha256 !== undefined) {
    // A legacy 1.0 record claiming a P7 receipt is mislabeled: reject it so
    // a downgrade cannot smuggle an unverified file through a "legacy" tag.
    throw new TypeError("DatasetPublication schema_version 1.0 must not carry manifest_sha256");
  }
  const parsed: DatasetPublication = {
    schema_version: schemaVersion,
    publication_id: publicationId,
    manifest_ref: assertNonEmptyString(
      record.manifest_ref,
      "DatasetPublication.manifest_ref",
    ),
    validation_result_ref: assertNonEmptyString(
      record.validation_result_ref,
      "DatasetPublication.validation_result_ref",
    ),
    published_at: assertNonEmptyString(
      record.published_at,
      "DatasetPublication.published_at",
    ),
    supersedes_publication_id: supersedes,
  };
  if (manifestSha256 !== undefined) parsed.manifest_sha256 = manifestSha256;
  return parsed;
}
