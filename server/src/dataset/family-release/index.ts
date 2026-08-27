export const FAMILY_RELEASE_GATES = ["R1", "R2", "R3", "R4", "R5"] as const;

export type FamilyReleaseGate = (typeof FAMILY_RELEASE_GATES)[number];
export type FamilyReleaseEvidenceClass = "trusted" | "fixture" | "example" | "synthetic_benchmark";
export type FamilyReleaseDecision = "go_no_go" | "not_ready";
export type FamilyReleaseRecommendation = "go" | "no_go";
export type FamilyReleaseBlockerCode =
  | "invalid_evidence_ref"
  | "missing_rollback_ref"
  | "fixture_evidence"
  | "example_evidence"
  | "synthetic_benchmark"
  | "missing_contract_digest"
  | "missing_review_ref"
  | "sandbox_unavailable"
  | "unproven_sandbox"
  | "missing_core_admission"
  | "missing_native_operation_result"
  | "missing_publication_verifier"
  | "publish_shortcut"
  | "missing_recovery_evidence"
  | "insufficient_real_consumers"
  | "non_independent_consumers"
  | "missing_same_commit_artifact"
  | "cross_run_evidence_mismatch";

/** Every claim in the release packet is bound to an exact execution and rollback. */
export interface FamilyReleaseEvidenceRef {
  readonly task_id: string;
  readonly requirement_id: string;
  readonly run_id: string;
  readonly commit: string;
  readonly digest: string;
  readonly rollback_ref: string;
  readonly evidence_class: FamilyReleaseEvidenceClass;
}

export interface FamilyReleaseContractEvidence {
  readonly contract_digest: string;
  readonly review_refs: readonly FamilyReleaseEvidenceRef[];
}

export interface FamilyReleaseSandboxEvidence {
  readonly available: boolean;
  readonly proof_kind: "real_os_sandbox" | "fixture" | "example" | "synthetic_benchmark";
  readonly proof_ref: FamilyReleaseEvidenceRef;
  readonly network_denied: boolean;
  readonly credentials_denied: boolean;
  readonly path_escape_denied: boolean;
  readonly hard_kill_verified: boolean;
}

export interface FamilyReleaseCoreEvidence {
  readonly admission: {
    readonly native: boolean;
    readonly ref: FamilyReleaseEvidenceRef;
  };
  readonly operation_result: {
    readonly native: boolean;
    readonly ref: FamilyReleaseEvidenceRef;
  };
  readonly publication_verifier: {
    readonly native: boolean;
    readonly authoritative_receipt_revalidation: boolean;
    readonly rejects_publish_shortcut: boolean;
    readonly ref: FamilyReleaseEvidenceRef;
  };
}

export interface FamilyReleaseRecoveryEvidence {
  readonly cancel: FamilyReleaseEvidenceRef;
  readonly timeout: FamilyReleaseEvidenceRef;
  readonly restart: FamilyReleaseEvidenceRef;
  readonly stale_worker: FamilyReleaseEvidenceRef;
  readonly late_commit: FamilyReleaseEvidenceRef;
  readonly publish_reuse: FamilyReleaseEvidenceRef;
  readonly all_recovered: boolean;
}

export interface FamilyReleaseConsumerEvidence {
  readonly consumer_id: string;
  readonly real_consumer: boolean;
  readonly independent_from: readonly string[];
  readonly ref: FamilyReleaseEvidenceRef;
  readonly same_commit_artifact_refs: readonly FamilyReleaseEvidenceRef[];
}

export interface FamilyHostReleaseInput {
  readonly contract: FamilyReleaseContractEvidence;
  readonly sandbox: FamilyReleaseSandboxEvidence;
  readonly core: FamilyReleaseCoreEvidence;
  readonly recovery: FamilyReleaseRecoveryEvidence;
  readonly consumers: readonly FamilyReleaseConsumerEvidence[];
}

export interface FamilyReleaseBlocker {
  readonly gate: FamilyReleaseGate;
  readonly code: FamilyReleaseBlockerCode;
  readonly detail: string;
  readonly refs: readonly FamilyReleaseEvidenceRef[];
}

export interface FamilyReleaseGateResult {
  readonly gate: FamilyReleaseGate;
  readonly ready: boolean;
  readonly blockers: readonly FamilyReleaseBlocker[];
}

export interface FamilyHostReleaseEvaluation {
  readonly decision: FamilyReleaseDecision;
  readonly recommendation: FamilyReleaseRecommendation;
  readonly gates: readonly FamilyReleaseGateResult[];
  readonly blockers: readonly FamilyReleaseBlocker[];
}

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;
const GATE_ORDER = new Map<FamilyReleaseGate, number>(FAMILY_RELEASE_GATES.map((gate, index) => [gate, index]));

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function refIsExact(ref: FamilyReleaseEvidenceRef): boolean {
  return nonEmpty(ref.task_id)
    && nonEmpty(ref.requirement_id)
    && nonEmpty(ref.run_id)
    && COMMIT.test(ref.commit)
    && HEX_DIGEST.test(ref.digest)
    && nonEmpty(ref.rollback_ref);
}

function refBlocker(gate: FamilyReleaseGate, ref: FamilyReleaseEvidenceRef): FamilyReleaseBlocker | undefined {
  if (ref.rollback_ref.trim().length === 0) {
    return {
      gate,
      code: "missing_rollback_ref",
      detail: "Every release requirement must carry an exact rollback reference.",
      refs: [ref],
    };
  }
  if (!refIsExact(ref)) {
    return {
      gate,
      code: "invalid_evidence_ref",
      detail: "Evidence must identify task, build, run, commit, digest, and rollback exactly.",
      refs: [ref],
    };
  }
  if (ref.evidence_class !== "trusted") {
    const code: FamilyReleaseBlockerCode = ref.evidence_class === "fixture"
      ? "fixture_evidence"
      : ref.evidence_class === "example" ? "example_evidence" : "synthetic_benchmark";
    return {
      gate,
      code,
      detail: "Fixture, example, and synthetic benchmark evidence cannot satisfy a release gate.",
      refs: [ref],
    };
  }
  return undefined;
}

function refsForEvidence(gate: FamilyReleaseGate, refs: readonly FamilyReleaseEvidenceRef[]): FamilyReleaseBlocker[] {
  return refs.flatMap((ref) => {
    const blocker = refBlocker(gate, ref);
    return blocker === undefined ? [] : [blocker];
  });
}

function distinctBlockers(blockers: readonly FamilyReleaseBlocker[]): FamilyReleaseBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.gate}:${blocker.code}:${blocker.detail}:${blocker.refs.map((ref) => ref.run_id).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evaluateR1(input: FamilyHostReleaseInput): FamilyReleaseBlocker[] {
  const blockers = refsForEvidence("R1", input.contract.review_refs);
  if (!HEX_DIGEST.test(input.contract.contract_digest)) {
    blockers.push({
      gate: "R1",
      code: "missing_contract_digest",
      detail: "R1 requires the exact @biomed/contracts digest.",
      refs: input.contract.review_refs,
    });
  }
  if (input.contract.review_refs.length === 0) {
    blockers.push({
      gate: "R1",
      code: "missing_review_ref",
      detail: "R1 requires at least one review evidence reference.",
      refs: [],
    });
  }
  return blockers;
}

function evaluateR2(input: FamilyHostReleaseInput): FamilyReleaseBlocker[] {
  const { sandbox } = input;
  const blockers = refsForEvidence("R2", [sandbox.proof_ref]);
  if (!sandbox.available) {
    blockers.push({ gate: "R2", code: "sandbox_unavailable", detail: "No executable sandbox is available for release.", refs: [sandbox.proof_ref] });
  }
  if (sandbox.proof_kind !== "real_os_sandbox") {
    const code: FamilyReleaseBlockerCode = sandbox.proof_kind === "fixture"
      ? "fixture_evidence"
      : sandbox.proof_kind === "example" ? "example_evidence" : "synthetic_benchmark";
    blockers.push({ gate: "R2", code, detail: "Fixture, example, and synthetic sandbox evidence cannot satisfy R2.", refs: [sandbox.proof_ref] });
    blockers.push({ gate: "R2", code: "unproven_sandbox", detail: "Only a real OS isolation proof can satisfy R2.", refs: [sandbox.proof_ref] });
  }
  if (!(sandbox.network_denied && sandbox.credentials_denied && sandbox.path_escape_denied && sandbox.hard_kill_verified)) {
    blockers.push({ gate: "R2", code: "unproven_sandbox", detail: "R2 requires network, credential, path-escape, and hard-kill proof.", refs: [sandbox.proof_ref] });
  }
  return blockers;
}

function evaluateR3(input: FamilyHostReleaseInput): FamilyReleaseBlocker[] {
  const { admission, operation_result: operationResult, publication_verifier: verifier } = input.core;
  const refs = [admission.ref, operationResult.ref, verifier.ref];
  const blockers = refsForEvidence("R3", refs);
  if (!admission.native) blockers.push({ gate: "R3", code: "missing_core_admission", detail: "R3 requires native Core quarantine admission.", refs: [admission.ref] });
  if (!operationResult.native) blockers.push({ gate: "R3", code: "missing_native_operation_result", detail: "R3 requires a native OperationResult.", refs: [operationResult.ref] });
  if (!verifier.native) blockers.push({ gate: "R3", code: "missing_publication_verifier", detail: "R3 requires the native publication verifier.", refs: [verifier.ref] });
  if (!verifier.authoritative_receipt_revalidation || !verifier.rejects_publish_shortcut) {
    blockers.push({ gate: "R3", code: "publish_shortcut", detail: "Publication must revalidate the authoritative receipt and reject checkpoint shortcuts.", refs: [verifier.ref] });
  }
  return blockers;
}

function evaluateR4(input: FamilyHostReleaseInput): FamilyReleaseBlocker[] {
  const evidence = input.recovery;
  const refs = [evidence.cancel, evidence.timeout, evidence.restart, evidence.stale_worker, evidence.late_commit, evidence.publish_reuse];
  const blockers = refsForEvidence("R4", refs);
  if (!evidence.all_recovered) {
    blockers.push({ gate: "R4", code: "missing_recovery_evidence", detail: "R4 requires cancel, timeout, restart, stale, late-commit, and publish-reuse recovery.", refs });
  }
  return blockers;
}

function evaluateR5(input: FamilyHostReleaseInput): FamilyReleaseBlocker[] {
  const consumers = [...input.consumers].sort((left, right) => left.consumer_id.localeCompare(right.consumer_id));
  const refs = consumers.flatMap((consumer) => [consumer.ref, ...consumer.same_commit_artifact_refs]);
  const blockers = refsForEvidence("R5", refs);
  const realConsumers = consumers.filter((consumer) => consumer.real_consumer);
  if (realConsumers.length < 2) {
    blockers.push({ gate: "R5", code: "insufficient_real_consumers", detail: "R5 requires two independent real consumers.", refs: realConsumers.map((consumer) => consumer.ref) });
  }
  const ids = new Set(realConsumers.map((consumer) => consumer.consumer_id));
  if (realConsumers.length >= 2 && (ids.size !== realConsumers.length || realConsumers.some((consumer) => realConsumers
    .filter((other) => other.consumer_id !== consumer.consumer_id)
    .some((other) => !consumer.independent_from.includes(other.consumer_id))))) {
    blockers.push({ gate: "R5", code: "non_independent_consumers", detail: "The two real consumers must be independently evidenced.", refs: realConsumers.map((consumer) => consumer.ref) });
  }
  if (realConsumers.some((consumer) => consumer.same_commit_artifact_refs.length === 0)) {
    blockers.push({ gate: "R5", code: "missing_same_commit_artifact", detail: "Each real consumer requires same-commit artifact evidence.", refs: realConsumers.flatMap((consumer) => [consumer.ref]) });
  }
  const runs = new Set(realConsumers.map((consumer) => consumer.ref.run_id));
  if (realConsumers.length >= 2 && runs.size !== realConsumers.length) {
    blockers.push({ gate: "R5", code: "cross_run_evidence_mismatch", detail: "Representative consumers must be evidenced by independent runs.", refs: realConsumers.map((consumer) => consumer.ref) });
  }
  return blockers;
}

export function evaluateFamilyHostRelease(input: FamilyHostReleaseInput): FamilyHostReleaseEvaluation {
  const gateBlockers: Readonly<Record<FamilyReleaseGate, readonly FamilyReleaseBlocker[]>> = {
    R1: evaluateR1(input),
    R2: evaluateR2(input),
    R3: evaluateR3(input),
    R4: evaluateR4(input),
    R5: evaluateR5(input),
  };
  const gates = FAMILY_RELEASE_GATES.map((gate) => ({
    gate,
    ready: gateBlockers[gate].length === 0,
    blockers: distinctBlockers(gateBlockers[gate]),
  }));
  const blockers = gates.flatMap((gate) => gate.blockers);
  const ready = blockers.length === 0;
  return {
    decision: ready ? "go_no_go" : "not_ready",
    recommendation: ready ? "go" : "no_go",
    gates,
    blockers,
  };
}

export function compareFamilyReleaseEvidence(left: FamilyReleaseEvidenceRef, right: FamilyReleaseEvidenceRef): number {
  return [left.task_id, left.requirement_id, left.run_id, left.commit, left.digest, left.rollback_ref]
    .join("\u0000")
    .localeCompare([right.task_id, right.requirement_id, right.run_id, right.commit, right.digest, right.rollback_ref].join("\u0000"));
}

export function familyReleaseGateIndex(gate: FamilyReleaseGate): number {
  return GATE_ORDER.get(gate) ?? -1;
}
