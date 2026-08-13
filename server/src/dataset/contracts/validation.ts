/**
 * Validation outcome contract (Python ``ValidationResult``): whether a
 * manifest digest passed a versioned profile.
 */

import type { SchemaVersion } from "./primitives.js";
import {
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalString,
  assertRecord,
  parseSchemaVersion,
} from "./primitives.js";
import type { ValidationResultStatus } from "./enums.js";
import { assertValidationResultStatus } from "./enums.js";

export interface ValidationResult {
  schema_version?: SchemaVersion;
  manifest_digest: string;
  profile_ref: string;
  status: ValidationResultStatus;
  checked_count: number;
  failed_count: number;
  report_path: string | null;
}

const VALIDATION_RESULT_KEYS = [
  "schema_version",
  "manifest_digest",
  "profile_ref",
  "status",
  "checked_count",
  "failed_count",
  "report_path",
] as const;

export function parseValidationResult(value: unknown): ValidationResult {
  const record = assertRecord(value, "ValidationResult");
  assertExactKeys(record, VALIDATION_RESULT_KEYS, "ValidationResult");
  const status = assertValidationResultStatus(record.status, "ValidationResult.status");
  const checkedCount = assertNonNegativeInt(
    record.checked_count,
    "ValidationResult.checked_count",
  );
  const failedCount = assertNonNegativeInt(
    record.failed_count,
    "ValidationResult.failed_count",
  );
  if (failedCount > checkedCount) {
    throw new TypeError("failed_count must not exceed checked_count");
  }
  if (status === "passed" && failedCount !== 0) {
    throw new TypeError("passed requires zero failed checks");
  }
  if (status === "failed" && failedCount === 0) {
    throw new TypeError("failed requires at least one failed check");
  }
  return {
    schema_version: parseSchemaVersion(record),
    manifest_digest: assertNonEmptyString(
      record.manifest_digest,
      "ValidationResult.manifest_digest",
    ),
    profile_ref: assertNonEmptyString(
      record.profile_ref,
      "ValidationResult.profile_ref",
    ),
    status,
    checked_count: checkedCount,
    failed_count: failedCount,
    report_path: assertOptionalString(
      record.report_path,
      "ValidationResult.report_path",
    ),
  };
}
