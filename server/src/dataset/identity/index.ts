import type { DatasetIdentity, SampleIdentity } from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";

const ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;
const DATASET_ID_PATTERN = /^ds_[0-9a-f]{64}$/;
const DATASET_REVISION_ID_PATTERN = /^dsrev_[0-9a-f]{64}$/;
const SOURCE_NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

export interface DatasetIdInput {
  sourceNamespace: string;
  canonicalAccessions: readonly string[];
}

export interface DatasetRevisionIdInput {
  datasetId: string;
  revisionToken: string | null;
  providerSnapshot: string;
  carrierAssetIds: readonly string[];
}

export interface DatasetIdentityRecordsInput extends DatasetIdInput {
  revisionToken: string | null;
  providerSnapshot: string;
  carrierAssetIds: readonly string[];
}

export interface SampleIdentityInput {
  datasetRevisionId: string;
  sampleId: string;
}

interface CanonicalDatasetKey {
  source_namespace: string;
  canonical_accessions: string[];
}

interface CanonicalDatasetRevisionKey {
  dataset_id: string;
  revision_token: string | null;
  provider_snapshot: string;
  carrier_asset_ids: string[];
}

function canonicalNonBlank(value: string, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const canonical = value.normalize("NFC").trim();
  if (canonical.length === 0) throw new TypeError(`${field} must not be blank`);
  if ([...canonical].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return canonical;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

/**
 * Canonicalize the stable logical dataset key.
 *
 * - source namespace: NFC + trim + lowercase, then safe-identifier validation;
 * - accession closure: each accession is NFC + trimmed but remains case
 *   sensitive, then the closure is code-point sorted and deduplicated;
 * - the closure must contain at least one non-blank accession.
 */
export function canonicalizeDatasetKey(input: DatasetIdInput): CanonicalDatasetKey {
  const sourceNamespace = canonicalNonBlank(input.sourceNamespace, "source namespace").toLowerCase();
  if (!SOURCE_NAMESPACE_PATTERN.test(sourceNamespace)) {
    throw new TypeError("source namespace must match /^[a-z][a-z0-9._-]{0,127}$/");
  }
  if (!Array.isArray(input.canonicalAccessions) || input.canonicalAccessions.length === 0) {
    throw new TypeError("canonical accession closure must not be empty");
  }
  const canonicalAccessions = sortedUnique(input.canonicalAccessions.map((accession, index) =>
    canonicalNonBlank(accession, `canonical accession at index ${index}`),
  ));
  return {
    source_namespace: sourceNamespace,
    canonical_accessions: canonicalAccessions,
  };
}

/**
 * Canonicalize a reproducible source snapshot key.
 *
 * revisionToken is either explicit null or an NFC-trimmed non-blank string;
 * providerSnapshot is NFC-trimmed and non-blank; carrier asset IDs are already
 * canonical byte identities and are therefore validated without trimming or
 * case folding before code-point sorting and deduplication.
 */
export function canonicalizeDatasetRevisionKey(
  input: DatasetRevisionIdInput,
): CanonicalDatasetRevisionKey {
  const datasetId = validateDatasetId(input.datasetId);
  if (input.revisionToken !== null && typeof input.revisionToken !== "string") {
    throw new TypeError("revision token must be a string or null");
  }
  const revisionToken = input.revisionToken === null
    ? null
    : canonicalNonBlank(input.revisionToken, "revision token");
  const providerSnapshot = canonicalNonBlank(input.providerSnapshot, "provider snapshot");
  if (!Array.isArray(input.carrierAssetIds) || input.carrierAssetIds.length === 0) {
    throw new TypeError("carrier asset ID closure must not be empty");
  }
  const carrierAssetIds = sortedUnique(input.carrierAssetIds.map(validateAssetId));
  return {
    dataset_id: datasetId,
    revision_token: revisionToken,
    provider_snapshot: providerSnapshot,
    carrier_asset_ids: carrierAssetIds,
  };
}

export function createDatasetId(input: DatasetIdInput): string {
  return `ds_${canonicalDigest(canonicalizeDatasetKey(input))}`;
}

export function createDatasetRevisionId(input: DatasetRevisionIdInput): string {
  return `dsrev_${canonicalDigest(canonicalizeDatasetRevisionKey(input))}`;
}

/**
 * Materialize the frozen DatasetIdentity wire contract. The contract contains
 * one asset_id, so a multi-carrier revision is represented by one record per
 * sorted unique carrier while all records share dataset and revision IDs.
 */
export function createDatasetIdentityRecords(
  input: DatasetIdentityRecordsInput,
): DatasetIdentity[] {
  const datasetId = createDatasetId(input);
  const revisionKey = canonicalizeDatasetRevisionKey({
    datasetId,
    revisionToken: input.revisionToken,
    providerSnapshot: input.providerSnapshot,
    carrierAssetIds: input.carrierAssetIds,
  });
  const datasetRevisionId = `dsrev_${canonicalDigest(revisionKey)}`;
  return revisionKey.carrier_asset_ids.map((assetId) => ({
    dataset_id: datasetId,
    dataset_revision_id: datasetRevisionId,
    asset_id: assetId,
  }));
}

export function createSampleIdentity(input: SampleIdentityInput): SampleIdentity {
  return {
    dataset_revision_id: validateDatasetRevisionId(input.datasetRevisionId),
    sample_id: canonicalNonBlank(input.sampleId, "sample ID"),
  };
}

export function validateAssetId(value: string): string {
  if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
    throw new TypeError("asset ID must match asset_<lowercase sha256>");
  }
  return value;
}

export function validateDatasetId(value: string): string {
  if (typeof value !== "string" || !DATASET_ID_PATTERN.test(value)) {
    throw new TypeError("dataset ID must match ds_<lowercase sha256> and must not be a build ID");
  }
  return value;
}

export function validateDatasetRevisionId(value: string): string {
  if (typeof value !== "string" || !DATASET_REVISION_ID_PATTERN.test(value)) {
    throw new TypeError("dataset revision ID must match dsrev_<lowercase sha256>");
  }
  return value;
}

export function validateDatasetIdentity(value: DatasetIdentity): DatasetIdentity {
  return {
    dataset_id: validateDatasetId(value.dataset_id),
    dataset_revision_id: validateDatasetRevisionId(value.dataset_revision_id),
    asset_id: validateAssetId(value.asset_id),
  };
}

export function validateSampleIdentity(value: SampleIdentity): SampleIdentity {
  return {
    dataset_revision_id: validateDatasetRevisionId(value.dataset_revision_id),
    sample_id: canonicalNonBlank(value.sample_id, "sample ID"),
  };
}
