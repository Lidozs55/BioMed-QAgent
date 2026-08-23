import type {
  DatasetManifest,
  HILRequest,
  ProductAssessment,
  ProductBlocker,
  ProductScore,
} from "@/runtime/contracts";

export interface DynamicFamilyToolOutput {
  ok: boolean;
  status: string | null;
  build_id: string | null;
  publication_id: string | null;
  manifest_id: string | null;
  manifest_sha256: string | null;
  operation_result_manifest_id: string | null;
  backend: "in_process_unisolated" | null;
  security_boundary: false | null;
  error: { code: string | null; message: string | null } | null;
}

export interface PublicationAcceptanceTableEvidence {
  table_id: string;
  role: string | null;
  schema_ref: string | null;
  row_count: number | null;
  sha256: string | null;
}

export interface PublicationAcceptanceEvidence {
  candidate: {
    candidate_id: string | null;
    task_id: string | null;
    build_id: string | null;
    dataset_family: string | null;
    row_granularity: string | null;
    canonical_sha256: string | null;
    registered_asset_ids: string[];
  };
  provisionalAssessment: {
    requirement_id: string | null;
    product_status: ProductAssessment["product_status"] | null;
    missing_requirements: string[];
    sha256: string | null;
  } | null;
  b3: {
    profile_ref: string | null;
    checks_sha256: string | null;
    checked_count: number | null;
    failed_count: number | null;
  } | null;
  tables: PublicationAcceptanceTableEvidence[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function securityBoundaryValue(value: unknown): false | null {
  return value === false ? false : null;
}

function parseError(value: unknown): DynamicFamilyToolOutput["error"] {
  const object = record(value);
  if (object === null) return null;
  return {
    code: stringValue(object.code),
    message: stringValue(object.message),
  };
}

/**
 * Parse the current submit_dynamic_family_build tool response. This is a UI
 * projection only; the authoritative wire validation remains in contracts and
 * the server tool boundary.
 */
export function parseDynamicFamilyToolOutput(value: unknown): DynamicFamilyToolOutput | null {
  const object = record(value);
  if (object === null || typeof object.ok !== "boolean") return null;
  return {
    ok: object.ok,
    status: stringValue(object.status),
    build_id: stringValue(object.build_id),
    publication_id: stringValue(object.publication_id),
    manifest_id: stringValue(object.manifest_id),
    manifest_sha256: stringValue(object.manifest_sha256),
    operation_result_manifest_id: stringValue(object.operation_result_manifest_id),
    backend: object.backend === "in_process_unisolated" ? object.backend : null,
    security_boundary: securityBoundaryValue(object.security_boundary),
    error: parseError(object.error),
  };
}

export function parseDynamicFamilyToolOutputText(value: string | null): DynamicFamilyToolOutput | null {
  if (value === null || value.trim() === "") return null;
  try {
    return parseDynamicFamilyToolOutput(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

const SCORE_DIMENSIONS = [
  "schema",
  "relations",
  "identifiers",
  "provenance",
  "confidence",
  "reproducibility",
] as const;
const BLOCKER_CODES = [
  "missing_entities",
  "missing_relations",
  "missing_evidence",
  "identity_not_closed",
  "cross_reference_not_closed",
  "provenance_incomplete",
  "confidence_below_threshold",
  "human_review_pending",
  "artifact_incomplete",
] as const;

function isScoreDimension(value: unknown): value is ProductScore["dimension"] {
  return typeof value === "string" && (SCORE_DIMENSIONS as readonly string[]).includes(value);
}

function isBlockerCode(value: unknown): value is ProductBlocker["code"] {
  return typeof value === "string" && (BLOCKER_CODES as readonly string[]).includes(value);
}

function parseScores(value: unknown): ProductScore[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const object = record(entry);
    const dimension = object?.dimension;
    const score = finiteNumber(object?.score);
    const satisfied = finiteNumber(object?.satisfied);
    const required = finiteNumber(object?.required);
    if (
      object === null ||
      !isScoreDimension(dimension) ||
      score === null ||
      satisfied === null ||
      required === null
    ) return [];
    return [{ dimension, score, satisfied, required }];
  });
}

function parseBlockers(value: unknown): ProductBlocker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const object = record(entry);
    const dimension = object?.dimension;
    const code = object?.code;
    if (
      object === null ||
      typeof object.requirement_id !== "string" ||
      !isScoreDimension(dimension) ||
      !isBlockerCode(code) ||
      typeof object.message !== "string"
    ) return [];
    return [{
      requirement_id: object.requirement_id,
      dimension,
      code,
      message: object.message,
    }];
  });
}

/** Parse the ProductAssessment projection carried in a manifest confidence summary. */
export function parseProductAssessmentSummary(value: unknown): ProductAssessment | null {
  const object = record(value);
  const status = object?.product_status;
  if (
    object === null ||
    (status !== "incomplete" && status !== "validated" && status !== "publishable")
  ) return null;
  const blockers = parseBlockers(object.blockers);
  return {
    schema_version: "1.0",
    requirement_id: stringValue(object.requirement_id) ?? "manifest-confidence-summary",
    package_id: stringValue(object.package_id) ?? "unknown",
    package_version: stringValue(object.package_version) ?? "unknown",
    product_status: status,
    scores: parseScores(object.scores),
    missing_requirements: stringArray(object.missing_requirements),
    blockers,
  };
}

/** Return ProductAssessment only when the current manifest exposes its summary. */
export function productAssessmentFromManifest(manifest: DatasetManifest): ProductAssessment | null {
  const confidence = record(manifest.confidence_summary);
  if (confidence === null) return null;
  const direct = parseProductAssessmentSummary(confidence.product_assessment);
  if (direct !== null) return direct;
  const blockers = parseBlockers(confidence.product_blockers);
  const status = confidence.product_status;
  if (
    status !== "incomplete" &&
    status !== "validated" &&
    status !== "publishable"
  ) return null;
  return parseProductAssessmentSummary({
    schema_version: "1.0",
    requirement_id: "manifest-confidence-summary",
    package_id: manifest.manifest_id,
    package_version: "unknown",
    product_status: status,
    scores: confidence.product_scores,
    missing_requirements: blockers.map((blocker) => blocker.requirement_id),
    blockers,
  });
}

function parseTableEvidence(value: unknown): PublicationAcceptanceTableEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const object = record(entry);
    const tableId = stringValue(object?.table_id);
    if (object === null || tableId === null) return [];
    return [{
      table_id: tableId,
      role: stringValue(object.role),
      schema_ref: stringValue(object.schema_ref),
      row_count: finiteNumber(object.row_count),
      sha256: stringValue(object.sha256),
    }];
  });
}

/**
 * Extract only the evidence-bound publication fields from the current HIL
 * reviewed_snapshot. Missing fields remain null rather than being guessed.
 */
export function parsePublicationAcceptanceEvidence(
  request: HILRequest,
): PublicationAcceptanceEvidence {
  const firstItem = request.review_items[0];
  const snapshot = record(firstItem?.evidence.reviewed_snapshot);
  const candidate = record(snapshot?.candidate);
  const provisional = record(snapshot?.provisional_assessment);
  const b3 = record(snapshot?.b3);
  return {
    candidate: {
      candidate_id: stringValue(candidate?.candidate_id),
      task_id: stringValue(candidate?.task_id),
      build_id: stringValue(candidate?.build_id),
      dataset_family: stringValue(candidate?.dataset_family),
      row_granularity: stringValue(candidate?.row_granularity),
      canonical_sha256: stringValue(candidate?.canonical_sha256),
      registered_asset_ids: stringArray(candidate?.registered_asset_ids),
    },
    provisionalAssessment: provisional === null
      ? null
      : {
          requirement_id: stringValue(provisional.requirement_id),
          product_status:
            provisional.product_status === "incomplete" ||
            provisional.product_status === "validated" ||
            provisional.product_status === "publishable"
              ? provisional.product_status
              : null,
          missing_requirements: stringArray(provisional.missing_requirements),
          sha256: stringValue(provisional.sha256),
        },
    b3: b3 === null
      ? null
      : {
          profile_ref: stringValue(b3.profile_ref),
          checks_sha256: stringValue(b3.checks_sha256),
          checked_count: finiteNumber(b3.checked_count),
          failed_count: finiteNumber(b3.failed_count),
        },
    tables: parseTableEvidence(snapshot?.tables),
  };
}

export function statusLabel(status: string | null): string {
  switch (status) {
    case "published":
      return "已发布";
    case "rejected":
      return "已拒绝";
    case "failed":
      return "执行失败";
    case "running":
      return "执行中";
    default:
      return status ?? "未提供状态";
  }
}