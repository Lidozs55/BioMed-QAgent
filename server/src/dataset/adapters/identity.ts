/**
 * Canonical identifier generation for persisted pipeline records (Python
 * ``app.domain.contracts.ids``).
 */

import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Python ``json.dumps``-compatible canonical JSON (compact separators,
 * sorted keys, unicode preserved). Mirrors ``_canonical_digest`` inputs;
 * the values hashed by the deterministic core are strings / string arrays.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Python ``_canonical_digest``: sha256 of canonical JSON bytes. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function assetIdFromSha256(sha256: string): string {
  const checksum = sha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(checksum)) {
    throw new Error("SHA-256 must contain exactly 64 hexadecimal characters");
  }
  return `asset_${checksum}`;
}

export function makeRecordId(datasetId: string, geneIdRaw: string, sampleId: string): string {
  const values = [datasetId, geneIdRaw, sampleId];
  if (values.some((value) => value.length === 0)) {
    throw new Error("record ID components must not be blank");
  }
  return `rec_${canonicalDigest(values).slice(0, 32)}`;
}