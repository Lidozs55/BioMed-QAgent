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

export type UntrustedCoverageStatus = "complete" | "partial" | "unknown";

export interface UntrustedArtifactMetadata {
  schema_version: "1.0";
  name: string;
  media_type: string;
  source_note: string | null;
  coverage_status: UntrustedCoverageStatus;
  covered_scope: string[];
  missing_scope: string[];
}

export interface UntrustedArtifactReceipt extends UntrustedArtifactMetadata {
  submission_id: string;
  task_id: string;
  authoritative: false;
  trust: "untrusted";
  size_bytes: number;
  sha256: string;
  submitted_at: string;
}

export const UNTRUSTED_ARTIFACT_DIRECTORY = "quarantine" as const;
export const UNTRUSTED_SUBMISSION_ID_PATTERN = /^ua_[0-9a-f]{24}$/;

const COVERAGE_STATUSES = ["complete", "partial", "unknown"] as const;
const METADATA_KEYS = new Set([
  "schema_version",
  "name",
  "media_type",
  "source_note",
  "coverage_status",
  "covered_scope",
  "missing_scope",
]);
const RECEIPT_KEYS = new Set([
  ...METADATA_KEYS,
  "submission_id",
  "task_id",
  "authoritative",
  "trust",
  "size_bytes",
  "sha256",
  "submitted_at",
]);

function exactObject(value: unknown, path: string, keys: ReadonlySet<string>): Record<string, unknown> {
  const object = assertObject(value, path);
  const actual = Object.keys(object);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new APIError(502, `Unknown or missing fields at ${path}`);
  }
  return object;
}

function requiredText(value: unknown, path: string): string {
  const text = assertString(value, path, true);
  if (text.trim() === "") throw new APIError(502, `Expected non-empty string at ${path}`);
  return text;
}

function scope(value: unknown, path: string): string[] {
  return assertArray(value, path, (item, index) => requiredText(item, `${path}[${index}]`));
}

export function parseUntrustedArtifactMetadata(
  value: unknown,
  path = "untrusted_artifact_metadata",
): UntrustedArtifactMetadata {
  const object = exactObject(value, path, METADATA_KEYS);
  return {
    schema_version: assertFinite(object.schema_version, `${path}.schema_version`, ["1.0"] as const),
    name: requiredText(object.name, `${path}.name`),
    media_type: requiredText(object.media_type, `${path}.media_type`),
    source_note: assertStringOrNull(object.source_note, `${path}.source_note`),
    coverage_status: assertFinite(object.coverage_status, `${path}.coverage_status`, COVERAGE_STATUSES),
    covered_scope: scope(object.covered_scope, `${path}.covered_scope`),
    missing_scope: scope(object.missing_scope, `${path}.missing_scope`),
  };
}

export function parseUntrustedArtifactReceipt(
  value: unknown,
  path = "untrusted_artifact_receipt",
): UntrustedArtifactReceipt {
  const object = exactObject(value, path, RECEIPT_KEYS);
  const metadata = parseUntrustedArtifactMetadata(Object.fromEntries(
    [...METADATA_KEYS].map((key) => [key, object[key]]),
  ), path);
  if (object.authoritative !== false) {
    throw new APIError(502, `Expected false at ${path}.authoritative`);
  }
  const submissionId = assertString(object.submission_id, `${path}.submission_id`, true);
  if (!UNTRUSTED_SUBMISSION_ID_PATTERN.test(submissionId)) {
    throw new APIError(502, `Invalid submission id at ${path}.submission_id`);
  }
  return {
    ...metadata,
    submission_id: submissionId,
    task_id: assertString(object.task_id, `${path}.task_id`, true),
    authoritative: false,
    trust: assertFinite(object.trust, `${path}.trust`, ["untrusted"] as const),
    size_bytes: assertNonNegativeInt(object.size_bytes, `${path}.size_bytes`),
    sha256: assertHex64(object.sha256, `${path}.sha256`),
    submitted_at: assertString(object.submitted_at, `${path}.submitted_at`, true),
  };
}
