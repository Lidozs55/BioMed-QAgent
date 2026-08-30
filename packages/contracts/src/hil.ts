import type { JsonValue } from "./json.js";
import {
  assertArray,
  assertBoolean,
  assertFinite,
  assertHex64,
  assertJsonRecord,
  assertJsonValue,
  assertObject,
  assertString,
  assertStringOrNull,
  optSchemaVersion,
} from "./runtime/primitives.js";

export const HIL_KINDS = [
  "permission",
  "semantic_review",
  "data_review",
  "conflict_resolution",
] as const;
export type HILKind = (typeof HIL_KINDS)[number];

export const HIL_REVIEW_TYPES = [
  "field_mapping",
  "entity_mapping",
  "unit_conversion",
  "vlm_extraction",
  "source_conflict",
  "measurement_semantics",
  "browser_acquisition_formalization",
  "browser_evidence_acceptance",
  "publication_acceptance",
] as const;
export type HILReviewType = (typeof HIL_REVIEW_TYPES)[number];

export const HIL_STATUSES = ["pending", "resolved", "cancelled", "expired"] as const;
export type HILStatus = (typeof HIL_STATUSES)[number];

export const HIL_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type HILConfidenceLevel = (typeof HIL_CONFIDENCE_LEVELS)[number];

/**
 * Who resolved a review request. ``user`` is the classic human decision;
 * ``model`` is an LLM pre-review pass (``hil_pre_review`` approval mode);
 * ``auto`` is the ``auto_approve`` mode short-circuit. Publication-boundary
 * consumers (product assessment, chart evidence, browser handoff) still
 * require ``"user"`` and reject the other two at their own gates.
 */
export const HIL_REVIEWERS = ["user", "model", "auto"] as const;
export type HILReviewer = (typeof HIL_REVIEWERS)[number];

/**
 * Three-tier approval authority per HIL scope (AGENTS HIL approval policy):
 *
 * - ``human_review`` — every request waits for a human decision (classic).
 * - ``llm_pre_review`` — an LLM reviews first; only requests it fails are
 *   escalated to a human. A pass resolves as the kind's affirmative decision
 *   (``approve`` for permission, ``accept`` for reviews) with reviewer
 *   ``model``.
 * - ``auto_approve`` — no review at all: resolves immediately with the
 *   affirmative decision and reviewer ``auto``.
 */
export const HIL_APPROVAL_MODES = ["human_review", "llm_pre_review", "auto_approve"] as const;
export type HILApprovalMode = (typeof HIL_APPROVAL_MODES)[number];

export const HIL_APPROVAL_SCOPES = ["permission", ...HIL_REVIEW_TYPES] as const;
export type HILApprovalScope = (typeof HIL_APPROVAL_SCOPES)[number];

/**
 * Scopes whose consumers structurally require a human reviewer
 * (``reviewer === "user"`` is validated downstream): VLM chart-evidence
 * publication, browser evidence acceptance, and dynamic-family publication
 * acceptance. The settings API rejects non-human modes for these.
 */
export const HIL_HUMAN_MANDATORY_SCOPES: readonly HILApprovalScope[] = [
  "vlm_extraction",
  "browser_evidence_acceptance",
  "publication_acceptance",
];

export const DEFAULT_HIL_APPROVAL_SETTINGS: HILApprovalSettings = {
  schema_version: "1.0",
  default_mode: "human_review",
  review_modes: {},
};

export interface HILApprovalSettings {
  schema_version?: "1.0";
  default_mode: HILApprovalMode;
  /** Per-scope overrides; scopes omitted here fall back to ``default_mode``. */
  review_modes: Partial<Record<HILApprovalScope, HILApprovalMode>>;
}

export interface HILSubject {
  binding_id?: string;
  record_ids?: string[];
  mapping_ids?: string[];
  provenance_ids?: string[];
  candidate_ids?: string[];
  table_ids?: string[];
  evidence_ids?: string[];
  source_asset_ids?: string[];
  locator_urls?: string[];
}

export interface HILReviewItem {
  item_id: string;
  summary: string;
  subject: HILSubject;
  evidence: Record<string, JsonValue>;
  proposed_value: JsonValue;
  confidence_level: HILConfidenceLevel | null;
}

export interface HILRequest {
  schema_version?: "1.0";
  request_id: string;
  task_id: string;
  run_id: string;
  requirement_id: string | null;
  kind: HILKind;
  review_type: HILReviewType | null;
  status: HILStatus;
  blocking: boolean;
  subject: HILSubject;
  review_items: HILReviewItem[];
  summary: string;
  evidence_digest: string;
  policy_ref: string;
  created_at: string;
  resolved_at: string | null;
}

export type HILDecision =
  | { action: "approve" }
  | { action: "accept" }
  | { action: "correct"; correction: JsonValue }
  | { action: "reject" }
  | { action: "skip" };

export interface ResumeHILInput {
  request_id: string;
  evidence_digest: string;
  decision: HILDecision;
  reason: string | null;
}

export interface HumanReviewRecord {
  schema_version?: "1.0";
  review_id: string;
  request_id: string;
  decision: HILDecision;
  reviewer: HILReviewer;
  reviewed_at: string;
  evidence_digest: string;
  reason: string | null;
}

function parseStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  return assertArray(value, path, (item, index) =>
    assertString(item, `${path}[${index}]`, true),
  );
}

export function parseHILSubject(value: unknown, path = "subject"): HILSubject {
  const obj = assertObject(value, path);
  const bindingId = obj.binding_id;
  const recordIds = parseStringArray(obj.record_ids, `${path}.record_ids`);
  const mappingIds = parseStringArray(obj.mapping_ids, `${path}.mapping_ids`);
  const provenanceIds = parseStringArray(obj.provenance_ids, `${path}.provenance_ids`);
  const candidateIds = parseStringArray(obj.candidate_ids, `${path}.candidate_ids`);
  const tableIds = parseStringArray(obj.table_ids, `${path}.table_ids`);
  const evidenceIds = parseStringArray(obj.evidence_ids, `${path}.evidence_ids`);
  const sourceAssetIds = parseStringArray(obj.source_asset_ids, `${path}.source_asset_ids`);
  const locatorUrls = parseStringArray(obj.locator_urls, `${path}.locator_urls`);
  return {
    ...(bindingId === undefined
      ? {}
      : { binding_id: assertString(bindingId, `${path}.binding_id`, true) }),
    ...(recordIds === undefined ? {} : { record_ids: recordIds }),
    ...(mappingIds === undefined ? {} : { mapping_ids: mappingIds }),
    ...(provenanceIds === undefined ? {} : { provenance_ids: provenanceIds }),
    ...(candidateIds === undefined ? {} : { candidate_ids: candidateIds }),
    ...(tableIds === undefined ? {} : { table_ids: tableIds }),
    ...(evidenceIds === undefined ? {} : { evidence_ids: evidenceIds }),
    ...(sourceAssetIds === undefined ? {} : { source_asset_ids: sourceAssetIds }),
    ...(locatorUrls === undefined ? {} : { locator_urls: locatorUrls }),
  };
}

export function parseHILReviewItem(value: unknown, path = "review_item"): HILReviewItem {
  const obj = assertObject(value, path);
  return {
    item_id: assertString(obj.item_id, `${path}.item_id`, true),
    summary: assertString(obj.summary, `${path}.summary`, true),
    subject: parseHILSubject(obj.subject, `${path}.subject`),
    evidence: assertJsonRecord(obj.evidence, `${path}.evidence`),
    proposed_value: assertJsonValue(obj.proposed_value, `${path}.proposed_value`),
    confidence_level:
      obj.confidence_level === null || obj.confidence_level === undefined
        ? null
        : assertFinite(
            obj.confidence_level,
            `${path}.confidence_level`,
            HIL_CONFIDENCE_LEVELS,
          ),
  };
}

export function parseHILDecision(
  value: unknown,
  options: { allowLegacyPermission?: boolean } = {},
  path = "decision",
): HILDecision {
  if (options.allowLegacyPermission && (value === "approve" || value === "reject")) {
    return { action: value };
  }
  const obj = assertObject(value, path);
  const action = assertFinite(obj.action, `${path}.action`, [
    "approve",
    "accept",
    "correct",
    "reject",
    "skip",
  ] as const);
  if (action === "correct") {
    if (!("correction" in obj)) {
      throw new TypeError(`${path}.correction is required for correct decisions`);
    }
    return {
      action,
      correction: assertJsonValue(obj.correction, `${path}.correction`),
    };
  }
  if ("correction" in obj) {
    throw new TypeError(`${path}.correction is only valid for correct decisions`);
  }
  return { action };
}

export function parseHILRequest(value: unknown, path = "hil_request"): HILRequest {
  const obj = assertObject(value, path);
  const kind = assertFinite(obj.kind, `${path}.kind`, HIL_KINDS);
  const reviewType =
    obj.review_type === null || obj.review_type === undefined
      ? null
      : assertFinite(obj.review_type, `${path}.review_type`, HIL_REVIEW_TYPES);
  if (kind === "permission" && reviewType !== null) {
    throw new TypeError(`${path}.review_type must be null for permission requests`);
  }
  if (kind !== "permission" && reviewType === null) {
    throw new TypeError(`${path}.review_type is required for review requests`);
  }
  return {
    schema_version: optSchemaVersion(obj.schema_version, `${path}.schema_version`),
    request_id: assertString(obj.request_id, `${path}.request_id`, true),
    task_id: assertString(obj.task_id, `${path}.task_id`, true),
    run_id: assertString(obj.run_id, `${path}.run_id`, true),
    requirement_id: assertStringOrNull(obj.requirement_id, `${path}.requirement_id`),
    kind,
    review_type: reviewType,
    status: assertFinite(obj.status, `${path}.status`, HIL_STATUSES),
    blocking: assertBoolean(obj.blocking, `${path}.blocking`),
    subject: parseHILSubject(obj.subject, `${path}.subject`),
    review_items: assertArray(obj.review_items, `${path}.review_items`, (item, index) =>
      parseHILReviewItem(item, `${path}.review_items[${index}]`),
    ),
    summary: assertString(obj.summary, `${path}.summary`, true),
    evidence_digest: assertHex64(obj.evidence_digest, `${path}.evidence_digest`),
    policy_ref: assertString(obj.policy_ref, `${path}.policy_ref`, true),
    created_at: assertString(obj.created_at, `${path}.created_at`, true),
    resolved_at: assertStringOrNull(obj.resolved_at, `${path}.resolved_at`),
  };
}

export function parseResumeHILInput(
  value: unknown,
  path = "resume_hil_input",
): ResumeHILInput {
  const obj = assertObject(value, path);
  return {
    request_id: assertString(obj.request_id, `${path}.request_id`, true),
    evidence_digest: assertHex64(obj.evidence_digest, `${path}.evidence_digest`),
    decision: parseHILDecision(obj.decision, {}, `${path}.decision`),
    reason: assertStringOrNull(obj.reason, `${path}.reason`),
  };
}

export function parseHumanReviewRecord(
  value: unknown,
  path = "human_review_record",
): HumanReviewRecord {
  const obj = assertObject(value, path);
  const reviewer = assertFinite(obj.reviewer, `${path}.reviewer`, HIL_REVIEWERS);
  return {
    schema_version: optSchemaVersion(obj.schema_version, `${path}.schema_version`),
    review_id: assertString(obj.review_id, `${path}.review_id`, true),
    request_id: assertString(obj.request_id, `${path}.request_id`, true),
    decision: parseHILDecision(obj.decision, {}, `${path}.decision`),
    reviewer,
    reviewed_at: assertString(obj.reviewed_at, `${path}.reviewed_at`, true),
    evidence_digest: assertHex64(obj.evidence_digest, `${path}.evidence_digest`),
    reason: assertStringOrNull(obj.reason, `${path}.reason`),
  };
}

export function parseHilApprovalSettings(
  value: unknown,
  path = "hil_approval_settings",
): HILApprovalSettings {
  const obj = assertObject(value, path);
  return {
    schema_version: optSchemaVersion(obj.schema_version, `${path}.schema_version`),
    default_mode: assertFinite(obj.default_mode, `${path}.default_mode`, HIL_APPROVAL_MODES),
    review_modes: parseApprovalScopeModes(obj.review_modes, `${path}.review_modes`),
  };
}

function parseApprovalScopeModes(
  value: unknown,
  path: string,
): HILApprovalSettings["review_modes"] {
  if (value === undefined || value === null) return {};
  const obj = assertObject(value, path);
  const modes: HILApprovalSettings["review_modes"] = {};
  for (const [scope, mode] of Object.entries(obj)) {
    const key = assertFinite(scope, `${path} key`, HIL_APPROVAL_SCOPES);
    modes[key] = assertFinite(mode, `${path}.${scope}`, HIL_APPROVAL_MODES);
  }
  return modes;
}
