/**
 * Deterministic guard for HIL auto-approval (自动档守卫).
 *
 * ``auto_approve`` and ``llm_pre_review`` short-circuit the human decision,
 * so a forged or malformed request — e.g. the agent trying to bless a script
 * that writes task output directly instead of going through the
 * deterministic pipeline — must never be auto-resolved. Every auto-path
 * request is screened here BEFORE any model call:
 *
 * 1. Structural conformance — ``policy_ref`` must be a registered producer
 *    policy and must match the request ``kind``/``review_type`` exactly.
 *    New HIL producers MUST register here; an unregistered ref is denied
 *    under auto modes (fail-closed).
 * 2. Bypass-intent markers — explicit "skip the gate / bypass the pipeline /
 *    write data directly via script" phrasing in agent-influenced request
 *    content denies the request.
 *
 * A deny resolves the request as ``reject`` (reviewer ``auto``) with the
 * reason recorded, and the gate emits an ``HIL_AUTO_REJECTED`` warning.
 */
import type { HILKind, HILRequest, HILReviewType } from "@biomed/contracts";

export interface RegisteredHILPolicy {
  kind: HILKind;
  review_type: HILReviewType | null;
}

/**
 * The only policy_refs auto modes may ever resolve, with the exact request
 * shape their producer emits (see hil-approval-policy.md §自动档守卫).
 */
export const HIL_POLICY_REGISTRY: Readonly<Record<string, RegisteredHILPolicy>> = Object.freeze({
  "runtime.credential.v1": { kind: "permission", review_type: null },
  "dataset.field_mapping.v1": { kind: "semantic_review", review_type: "field_mapping" },
  "dataset.unit_conversion.v1": { kind: "semantic_review", review_type: "unit_conversion" },
  "dataset.vlm_extraction.v1": { kind: "data_review", review_type: "vlm_extraction" },
  "browser.acquisition.evidence-acceptance.v1": {
    kind: "data_review",
    review_type: "browser_evidence_acceptance",
  },
  "dynamic_family_hil_acceptance.v1": {
    kind: "data_review",
    review_type: "publication_acceptance",
  },
});

export interface HILAutoGuardVerdict {
  decision: "allow" | "deny";
  reason: string;
}

/** High-precision bypass-intent markers; matched against request text. */
const BYPASS_MARKERS: ReadonlyArray<RegExp> = [
  /\bbypass\s+(the\s+)?(policy|pipeline|validation|gate|review)/i,
  /\b(skip|ignore)\s+(the\s+)?(policy|pipeline|validation|gate|review)/i,
  /绕过(系统|审核|审批|校验|门禁|管线|流程)/,
  /跳过(系统|审核|审批|校验|门禁|管线|流程)/,
  /不(经过|走|用)(审核|审批|校验|门禁|管线|正常流程)/,
  /直接(写|写入|修改|覆盖)(入|到)?(数据|库|表|输出|output)/,
];

/** Script/SQL direct-write markers: review content only, never permission op names. */
const SCRIPT_WRITE_MARKERS: ReadonlyArray<RegExp> = [
  /\b(exec|execute|run)\s+(a\s+)?(script|python|node|bash|sh|shell|powershell)\b/i,
  /\b(INSERT INTO|DROP TABLE|DELETE FROM|TRUNCATE TABLE|ALTER TABLE)\b/i,
];

function markerHit(text: string, markers: ReadonlyArray<RegExp>): string | null {
  for (const marker of markers) {
    if (marker.test(text)) return marker.source;
  }
  return null;
}

export function inspectHilAutoRequest(request: HILRequest): HILAutoGuardVerdict {
  const registered = HIL_POLICY_REGISTRY[request.policy_ref];
  if (registered === undefined) {
    return {
      decision: "deny",
      reason:
        `policy_ref '${request.policy_ref}' is not a registered HIL producer policy; ` +
        "auto modes may only resolve requests from the deterministic pipeline",
    };
  }
  if (registered.kind !== request.kind || registered.review_type !== request.review_type) {
    return {
      decision: "deny",
      reason:
        `policy_ref '${request.policy_ref}' does not match the request shape ` +
        `(expected kind=${registered.kind}, review_type=${registered.review_type ?? "null"}; ` +
        `got kind=${request.kind}, review_type=${request.review_type ?? "null"})`,
    };
  }
  // Permission summaries are gate-generated ("Approve credential use for <op>")
  // with user-declared operation names; only bypass-intent applies there.
  const summaryHit = markerHit(request.summary, BYPASS_MARKERS);
  if (summaryHit !== null) {
    return { decision: "deny", reason: `bypass-intent marker in summary: /${summaryHit}/` };
  }
  if (request.kind === "permission") {
    return { decision: "allow", reason: "conforms to the registered producer policy" };
  }
  const content = JSON.stringify({
    items: request.review_items.map((item) => ({
      summary: item.summary,
      evidence: item.evidence,
      proposed_value: item.proposed_value,
    })),
  });
  for (const markers of [BYPASS_MARKERS, SCRIPT_WRITE_MARKERS]) {
    const hit = markerHit(content, markers);
    if (hit !== null) {
      return { decision: "deny", reason: `direct-write/bypass marker in request content: /${hit}/` };
    }
  }
  return { decision: "allow", reason: "conforms to the registered producer policy" };
}
