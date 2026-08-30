/**
 * Untrusted artifact submission (review/download quarantine) wire contracts.
 *
 * Lets an existing task RECEIVE an opaque, explicitly non-authoritative
 * artifact for human review/download WITHOUT entering the formal publication
 * chain. Everything here is deliberately ordinary JSON + base64: no multipart,
 * no new dependency, no extra subsystem. The receipt is a review convenience
 * only — it never routes into DatasetPublication / ProductAssessment /
 * OperationResult / Validation / Publisher semantics, never claims provenance,
 * and the submitted ``name`` is never used as a filesystem path (the server
 * generates the storage id).
 */

import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertFinite,
  assertHex64,
  assertNonNegativeInt,
  assertObject,
  assertString,
  assertStringOrNull,
} from "./runtime/primitives.js";

export const UNTRUSTED_ARTIFACT_SCHEMA_VERSION = "1.0" as const;
export const UNTRUSTED_ARTIFACT_TRUST = "untrusted" as const;

/** Submission receipt storage id. Server-generated; never client-supplied. */
export const UNTRUSTED_SUBMISSION_ID_PATTERN = /^ua_[0-9a-f]{24}$/;

/** How much of the submitted artifact the submission claims to cover. */
export type UntrustedCoverageStatus = "complete" | "partial" | "unknown";

export interface UntrustedArtifactReceipt {
  schema_version: typeof UNTRUSTED_ARTIFACT_SCHEMA_VERSION;
  /** Server-generated storage id; the only name used on disk. */
  submission_id: string;
  task_id: string;
  /** Verbatim display name; never used as a filesystem path. */
  name: string;
  media_type: string;
  source_note: string | null;
  coverage_status: UntrustedCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
  /** Always false: quarantine receipts are never authoritative. */
  authoritative: false;
  /** Always "untrusted". */
  trust: typeof UNTRUSTED_ARTIFACT_TRUST;
  size_bytes: number;
  sha256: string;
  submitted_at: string;
}

/** Storage layout: ``<taskRoot>/quarantine/<submission_id>/{receipt.json,artifact.bin}``. */
export const UNTRUSTED_ARTIFACT_DIRECTORY = "quarantine" as const;

const RECEIPT_KEYS = new Set([
  "schema_version",
  "submission_id",
  "task_id",
  "name",
  "media_type",
  "source_note",
  "coverage_status",
  "covered_scope",
  "missing_scope",
  "authoritative",
  "trust",
  "size_bytes",
  "sha256",
  "submitted_at",
]);

/** Coverage labels a client may declare; anything else is malformed. */
const COVERAGE_STATUSES = ["complete", "partial", "unknown"] as const;

function strictObject(value: unknown, path: string, keys: ReadonlySet<string>): Record<string, unknown> {
  const object = assertObject(value, path);
  const ownKeys = Object.keys(object);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => !keys.has(key))) {
    throw new APIError(502, `Unknown or missing fields at ${path}`);
  }
  return object;
}

function stringArray(value: unknown, path: string): string[] {
  return assertArray(value, path, (item, index) =>
    assertString(item, `${path}[${index}]`, true),
  );
}

/**
 * Exact-keys receipt parser (mirrors the publication / preflight receipt
 * style): unknown fields and missing fields both reject, so a drifted or
 * hand-edited receipt can never pass silently.
 */
export function parseUntrustedArtifactReceipt(
  value: unknown,
  path = "untrusted_artifact_receipt",
): UntrustedArtifactReceipt {
  const obj = strictObject(value, path, RECEIPT_KEYS);
  return {
    schema_version: assertFinite(
      obj.schema_version,
      `${path}.schema_version`,
      [UNTRUSTED_ARTIFACT_SCHEMA_VERSION] as const,
    ),
    submission_id: assertString(obj.submission_id, `${path}.submission_id`, true),
    task_id: assertString(obj.task_id, `${path}.task_id`, true),
    name: assertString(obj.name, `${path}.name`, true),
    media_type: assertString(obj.media_type, `${path}.media_type`, true),
    source_note: assertStringOrNull(obj.source_note, `${path}.source_note`),
    coverage_status: assertFinite(obj.coverage_status, `${path}.coverage_status`, COVERAGE_STATUSES),
    covered_scope: stringArray(obj.covered_scope, `${path}.covered_scope`),
    missing_scope: stringArray(obj.missing_scope, `${path}.missing_scope`),
    authoritative: obj.authoritative === false
      ? false
      : (() => {
          throw new APIError(502, `Expected false at ${path}.authoritative`);
        })(),
    trust: assertFinite(obj.trust, `${path}.trust`, [UNTRUSTED_ARTIFACT_TRUST] as const),
    size_bytes: assertNonNegativeInt(obj.size_bytes, `${path}.size_bytes`),
    sha256: assertHex64(obj.sha256, `${path}.sha256`),
    submitted_at: assertString(obj.submitted_at, `${path}.submitted_at`, true),
  };
}

/** POST /api/v1/tasks/:task_id/quarantine request body (validated, pre-decode). */
export interface UntrustedArtifactSubmissionInput {
  name: string;
  media_type: string;
  source_note: string | null;
  coverage_status: UntrustedCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
  bytes_base64: string;
  idempotency_key: string | null;
}

const INPUT_KEYS = new Set([
  "name",
  "media_type",
  "source_note",
  "coverage_status",
  "covered_scope",
  "missing_scope",
  "bytes_base64",
  "idempotency_key",
]);

/** Bounds aligned with the runtime's ordinary JSON transport (64 KiB body cap). */
export const UNTRUSTED_SUBMISSION_MAX_NAME_LENGTH = 256;
export const UNTRUSTED_SUBMISSION_MAX_MEDIA_TYPE_LENGTH = 128;
export const UNTRUSTED_SUBMISSION_MAX_NOTE_LENGTH = 1_000;
export const UNTRUSTED_SUBMISSION_MAX_SCOPE_ITEMS = 128;
export const UNTRUSTED_SUBMISSION_MAX_SCOPE_ITEM_LENGTH = 256;
export const UNTRUSTED_SUBMISSION_MAX_KEY_LENGTH = 128;
/**
 * 32 KiB of decoded bytes (≈44 KiB base64) fits the runtime's 64 KiB JSON
 * body cap with metadata room, so this bound — not the body cap — rejects
 * oversized payloads with a precise error. Larger files belong to the
 * multipart import / source-assets path, not the quarantine wire.
 */
export const UNTRUSTED_SUBMISSION_MAX_BYTES = 32 * 1024;
/** Longest ``bytes_base64`` text that can still decode within the byte cap. */
export const UNTRUSTED_SUBMISSION_MAX_BASE64_LENGTH =
  Math.ceil((UNTRUSTED_SUBMISSION_MAX_BYTES * 4) / 3) + 4;

/**
 * Validate the POST quarantine body. Throws the shared ``APIError`` contract;
 * the caller maps it onto its own HTTP status convention. ``bytes_base64`` is
 * validated as base64 text and length-bounded here; decoding and digest
 * computation happen in the server-side store.
 */
export function parseUntrustedArtifactSubmissionInput(
  value: unknown,
  path = "untrusted_artifact_submission",
): UntrustedArtifactSubmissionInput {
  const obj = strictObject(value, path, INPUT_KEYS);
  return {
    name: requiredBoundedString(obj.name, `${path}.name`, UNTRUSTED_SUBMISSION_MAX_NAME_LENGTH),
    media_type: requiredBoundedString(
      obj.media_type,
      `${path}.media_type`,
      UNTRUSTED_SUBMISSION_MAX_MEDIA_TYPE_LENGTH,
    ),
    source_note: optionalBoundedString(
      obj.source_note,
      `${path}.source_note`,
      UNTRUSTED_SUBMISSION_MAX_NOTE_LENGTH,
    ),
    coverage_status: assertFinite(obj.coverage_status, `${path}.coverage_status`, COVERAGE_STATUSES),
    covered_scope: boundedStringArray(obj.covered_scope, `${path}.covered_scope`),
    missing_scope: boundedStringArray(obj.missing_scope, `${path}.missing_scope`),
    bytes_base64: assertBase64(obj.bytes_base64, `${path}.bytes_base64`),
    idempotency_key: optionalBoundedString(
      obj.idempotency_key,
      `${path}.idempotency_key`,
      UNTRUSTED_SUBMISSION_MAX_KEY_LENGTH,
    ),
  };
}

function requiredBoundedString(value: unknown, path: string, max: number): string {
  const text = assertString(value, path);
  if (text.trim() === "") throw new APIError(502, `Expected non-empty string at ${path}`);
  if (text.length > max) throw new APIError(502, `String at ${path} exceeds ${max} characters`);
  return text;
}

function optionalBoundedString(value: unknown, path: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredBoundedString(value, path, max);
}

function boundedStringArray(value: unknown, path: string): string[] {
  if (Array.isArray(value) && value.length > UNTRUSTED_SUBMISSION_MAX_SCOPE_ITEMS) {
    throw new APIError(502, `Array at ${path} exceeds ${UNTRUSTED_SUBMISSION_MAX_SCOPE_ITEMS} items`);
  }
  return assertArray(value, path, (item, index) =>
    requiredBoundedString(item, `${path}[${index}]`, UNTRUSTED_SUBMISSION_MAX_SCOPE_ITEM_LENGTH),
  );
}

function assertBase64(value: unknown, path: string): string {
  const text = assertString(value, path);
  if (text.length === 0) throw new APIError(502, `Expected non-empty base64 at ${path}`);
  if (text.length > UNTRUSTED_SUBMISSION_MAX_BASE64_LENGTH) {
    throw new APIError(502, `Base64 payload at ${path} exceeds the submission size limit`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new APIError(502, `Expected standard base64 text at ${path}`);
  }
  return text;
}
