/**
 * Validation outcome contract (Python ``ValidationResult``): whether a
 * manifest digest passed a versioned profile.
 */

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  PublicationCandidateRef,
  RelationDefinition,
  RelationMissingPolicy,
  TableDefinition,
} from "@biomed/contracts";
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

export type ResolvedRelationMissingPolicy = Exclude<
  RelationMissingPolicy,
  "profile_defined"
>;

export interface TokenPreservationRule {
  table_id: string;
  source_field: string;
  output_field: string;
  token_kind: "relation" | "unit";
}

export interface TrustedTableFileInput {
  origin: "core_operation_result";
  relative_path: string;
  delimiter: "," | "\t";
  operation_result: OperationResultManifest;
}

export interface MultiTableValidationTable {
  definition: TableDefinition;
  schema: DatasetSchemaV2;
  file: TrustedTableFileInput | null;
  provenance_refs: string[];
  confidence_refs: string[];
}

export interface MultiTableValidationPolicy {
  token_preservation_rules: TokenPreservationRule[];
  profile_relation_missing_policies: Record<
    string,
    ResolvedRelationMissingPolicy
  >;
}

export interface MultiTableValidationRequest {
  task_id: string;
  run_id?: string;
  requirement_id: string;
  candidate: PublicationCandidateRef;
  tables: MultiTableValidationTable[];
  relations: RelationDefinition[];
  trusted_root: string;
  forbidden_roots: string[];
  policy: MultiTableValidationPolicy;
}

export interface MultiTableValidationCheck {
  check_id: string;
  scope: string;
  passed: boolean;
  detail: string;
}

export interface MultiTableValidationResult {
  passed: boolean;
  checks: MultiTableValidationCheck[];
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
