import { types } from "node:util";

import type {
  ProviderRevisionEvidenceV1,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import { parseSourceAssetRegistrationReceipt } from "./source.js";

const MAX_ACCESSION_LENGTH = 256;
const MAX_PROVIDER_IDENTITY_LENGTH = 1_024;
const MAX_REVISION_TOKEN_LENGTH = 1_024;
const MAX_RELATIVE_PATH_LENGTH = 1_024;
const MAX_MEDIA_TYPE_LENGTH = 256;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const EVIDENCE_KEYS = new Set([
  "schema_version",
  "canonical_accession",
  "provider_snapshot_identity",
  "provider_revision_token",
  "source_asset_registration_receipt",
]);
const RECEIPT_KEYS = new Set([
  "schema_version",
  "receipt_id",
  "task_id",
  "asset_ref",
  "source_id",
  "relative_path",
  "sha256",
  "size_bytes",
  "media_type",
  "registered_at",
  "path_compatibility",
]);
const ASSET_REF_KEYS = new Set(["schema_version", "asset_id", "task_id", "role"]);
const PATH_COMPATIBILITY_KEYS = new Set([
  "schema_version",
  "mode",
  "legacy_path",
  "telemetry_event",
]);

type DataRecord = Record<string, unknown>;

function snapshotExactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): DataRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || types.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.size
    || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const result = Object.create(null) as DataRecord;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${String(key)} must be an enumerable data property`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

function boundedEvidenceText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must contain well-formed Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} must contain well-formed Unicode`);
    }
  }
  if (value.normalize("NFC") !== value) {
    throw new TypeError(`${label} must be NFC-normalized`);
  }
  if (CONTROL_OR_BIDI.test(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  return value;
}

function boundedReceipt(
  receiptValue: unknown,
): SourceAssetRegistrationReceipt {
  const receipt = snapshotExactRecord(
    receiptValue,
    RECEIPT_KEYS,
    "ProviderRevisionEvidenceV1.source_asset_registration_receipt",
  );
  const assetRef = snapshotExactRecord(
    receipt.asset_ref,
    ASSET_REF_KEYS,
    "ProviderRevisionEvidenceV1.source_asset_registration_receipt.asset_ref",
  );
  const compatibility = snapshotExactRecord(
    receipt.path_compatibility,
    PATH_COMPATIBILITY_KEYS,
    "ProviderRevisionEvidenceV1.source_asset_registration_receipt.path_compatibility",
  );

  const parsed = parseSourceAssetRegistrationReceipt({
    ...receipt,
    asset_ref: assetRef,
    path_compatibility: compatibility,
  });
  boundedEvidenceText(
    parsed.relative_path,
    MAX_RELATIVE_PATH_LENGTH,
    "ProviderRevisionEvidenceV1.source_asset_registration_receipt.relative_path",
  );
  boundedEvidenceText(
    parsed.media_type,
    MAX_MEDIA_TYPE_LENGTH,
    "ProviderRevisionEvidenceV1.source_asset_registration_receipt.media_type",
  );
  if (parsed.path_compatibility.legacy_path !== null) {
    boundedEvidenceText(
      parsed.path_compatibility.legacy_path,
      MAX_RELATIVE_PATH_LENGTH,
      "ProviderRevisionEvidenceV1.source_asset_registration_receipt.path_compatibility.legacy_path",
    );
  }
  return parsed;
}

export function parseProviderRevisionEvidenceV1(
  value: unknown,
): ProviderRevisionEvidenceV1 {
  const record = snapshotExactRecord(value, EVIDENCE_KEYS, "ProviderRevisionEvidenceV1");
  if (record.schema_version !== "1.0") {
    throw new TypeError("ProviderRevisionEvidenceV1.schema_version must be 1.0");
  }
  const providerRevisionToken = record.provider_revision_token === null
    ? null
    : boundedEvidenceText(
      record.provider_revision_token,
      MAX_REVISION_TOKEN_LENGTH,
      "ProviderRevisionEvidenceV1.provider_revision_token",
    );
  return {
    schema_version: "1.0",
    canonical_accession: boundedEvidenceText(
      record.canonical_accession,
      MAX_ACCESSION_LENGTH,
      "ProviderRevisionEvidenceV1.canonical_accession",
    ),
    provider_snapshot_identity: boundedEvidenceText(
      record.provider_snapshot_identity,
      MAX_PROVIDER_IDENTITY_LENGTH,
      "ProviderRevisionEvidenceV1.provider_snapshot_identity",
    ),
    provider_revision_token: providerRevisionToken,
    source_asset_registration_receipt: boundedReceipt(
      record.source_asset_registration_receipt,
    ),
  };
}
