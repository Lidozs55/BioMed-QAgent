/**
 * Build outcome contracts (Python ``app.domain.contracts.dataset_state``).
 * The wire types are the canonical shapes from ``@biomed/contracts``; the
 * parse functions here add the strict runtime validation the deterministic
 * core requires (mirroring the Pydantic invariants).
 */

import type {
  ArtifactRole,
  BindingFailureDetail,
  BuildResult,
  BuildResultStatus,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalString,
  assertRecord,
  assertString,
  assertStringArray,
  parseSchemaVersion,
} from "./primitives.js";

export type {
  ArtifactRole,
  BindingFailureDetail,
  BuildResult,
  BuildResultStatus,
} from "@biomed/contracts";

const BUILD_RESULT_STATUSES: readonly BuildResultStatus[] = [
  "succeeded",
  "partial_success",
  "no_data",
  "spec_rejected",
];

const ARTIFACT_ROLES: readonly ArtifactRole[] = [
  "primary_dataset",
  "supporting_dataset",
  "schema",
  "provenance",
  "audit_report",
];

export function parseBindingFailureDetail(value: unknown): BindingFailureDetail {
  const record = assertRecord(value, "BindingFailureDetail");
  assertExactKeys(
    record,
    ["schema_version", "binding_id", "reason_code", "message"],
    "BindingFailureDetail",
  );
  return {
    schema_version: parseSchemaVersion(record),
    binding_id: assertNonEmptyString(
      record.binding_id,
      "BindingFailureDetail.binding_id",
    ),
    reason_code: assertNonEmptyString(
      record.reason_code,
      "BindingFailureDetail.reason_code",
    ),
    message: assertString(record.message, "BindingFailureDetail.message"),
  };
}

const BUILD_RESULT_KEYS = [
  "schema_version",
  "status",
  "valid_row_count",
  "successful_sources",
  "rejected_sources",
  "available_artifact_roles",
  "publication_id",
  "reason_codes",
  "user_summary",
  "recommended_next_action",
  "binding_failures",
  "build_id",
] as const;

export function parseBuildResult(value: unknown): BuildResult {
  const record = assertRecord(value, "BuildResult");
  assertExactKeys(record, BUILD_RESULT_KEYS, "BuildResult");
  const status = assertString(record.status, "BuildResult.status") as BuildResultStatus;
  if (!BUILD_RESULT_STATUSES.includes(status)) {
    throw new TypeError(
      "BuildResult.status must be one of succeeded, partial_success, no_data, spec_rejected",
    );
  }
  const validRowCount = assertNonNegativeInt(
    record.valid_row_count,
    "BuildResult.valid_row_count",
  );
  const successfulSources = record.successful_sources === undefined
    ? []
    : assertStringArray(record.successful_sources, "BuildResult.successful_sources");
  const rejectedSources = record.rejected_sources === undefined
    ? []
    : assertStringArray(record.rejected_sources, "BuildResult.rejected_sources");
  const availableArtifactRoles = (() => {
    if (record.available_artifact_roles === undefined) return [];
    if (!Array.isArray(record.available_artifact_roles)) {
      throw new TypeError("BuildResult.available_artifact_roles must be an array");
    }
    return record.available_artifact_roles.map((role, index) => {
      const text = assertString(
        role,
        `BuildResult.available_artifact_roles[${index}]`,
      ) as ArtifactRole;
      if (!ARTIFACT_ROLES.includes(text)) {
        throw new TypeError(
          `BuildResult.available_artifact_roles[${index}] is not a valid artifact role`,
        );
      }
      return text;
    });
  })();
  const publicationId = assertOptionalString(
    record.publication_id,
    "BuildResult.publication_id",
  );
  const reasonCodes = record.reason_codes === undefined
    ? []
    : assertStringArray(record.reason_codes, "BuildResult.reason_codes");
  const bindingFailures = (() => {
    if (record.binding_failures === undefined) return [];
    if (!Array.isArray(record.binding_failures)) {
      throw new TypeError("BuildResult.binding_failures must be an array");
    }
    return record.binding_failures.map((failure) => parseBindingFailureDetail(failure));
  })();
  if (status === "succeeded") {
    if (successfulSources.length === 0) {
      throw new TypeError("succeeded build requires successful_sources");
    }
    if (publicationId === null) {
      throw new TypeError("succeeded build requires publication_id");
    }
  }
  if (status === "no_data" && validRowCount !== 0) {
    throw new TypeError("no_data build must have zero valid rows");
  }
  if (status === "spec_rejected" && reasonCodes.length === 0) {
    throw new TypeError("spec_rejected build requires reason_codes");
  }
  if (
    publicationId !== null &&
    status !== "succeeded" &&
    status !== "partial_success"
  ) {
    throw new TypeError(
      "publication_id is only valid for succeeded or partial_success",
    );
  }
  const result: BuildResult = {
    schema_version: parseSchemaVersion(record),
    status,
    valid_row_count: validRowCount,
    successful_sources: successfulSources,
    rejected_sources: rejectedSources,
    available_artifact_roles: availableArtifactRoles,
    publication_id: publicationId,
    reason_codes: reasonCodes,
    user_summary: assertString(record.user_summary, "BuildResult.user_summary"),
    recommended_next_action: assertString(
      record.recommended_next_action,
      "BuildResult.recommended_next_action",
    ),
    binding_failures: bindingFailures,
    build_id: record.build_id === undefined
      ? null
      : assertOptionalString(record.build_id, "BuildResult.build_id"),
  };
  return result;
}

