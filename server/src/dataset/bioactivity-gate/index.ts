/**
 * D-E3 second-consumer go/no-go gate (staging) — minimal bioactivity_measurement
 * readiness decision (ADR-038/039 and docs/architecture/canonical-evidence.md).
 *
 * Pure Core decision boundary that evaluates whether bioactivity_measurement
 * can be admitted as the second real consumer of the generic Host/Core path
 * that the expression slice already exercises. The untrusted caller supplies
 * only typed, immutable Core-owned evidence: every claim is bound to an exact
 * task/build/run/commit/digest reference with a legacy rollback pointer, and
 * parity anchors come from the already-released first consumer (expression).
 * The gate:
 *
 * - verifies the bioactivity FamilySpec/projection/topology can describe the
 *   capability's input/output topology without a new family-specific Core
 *   branch, and that the generic Host/Core contract refs are shared with the
 *   first consumer;
 * - verifies dataset/revision identity, provenance/relation/assessment
 *   semantics parity, and that task/run/build/implementation/input/output/
 *   publication evidence is independent of the first consumer;
 * - returns not_ready (never go_no_go) for static retrieval examples, an
 *   unavailable sandbox, synthetic benchmarks, claims that reuse only an
 *   interface name, and executor scans whose marker relies only on
 *   `family.id ===` equality;
 * - returns go_no_go with recommendation no_go (never go) when real
 *   OperationResult/assessment/publication parity or a second-consumer
 *   independent shadow is missing, when a family-specific dispatch/DAG
 *   extension is found, or when any rollback reference is missing.
 *
 * Staging scope — this module is intentionally NOT wired anywhere:
 * - It is not exported from any barrel, and no executor/Host/admission/B3
 *   code imports it.
 * - The only products are a `BioactivityConsumerReport` and the `GoNoGo`
 *   decision; the gate never constructs a Publication, OperationResult or
 *   activation decision, and never executes, publishes or activates anything.
 * - It performs no I/O: all evidence is Core-owned typed facts, and the
 *   evaluation is deterministic for identical inputs (including the injected
 *   clock).
 */
import { canonicalDigest } from "../adapters/identity.js";

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;

export type BioactivityEvidenceClass = "trusted" | "fixture" | "example" | "synthetic_benchmark";
export type GoNoGo = "go_no_go" | "not_ready";
export type BioactivityRecommendation = "go" | "no_go";
export type BioactivityNotReadyReason =
  | "static_retrieval_example"
  | "sandbox_unavailable"
  | "synthetic_benchmark"
  | "interface_name_only"
  | "family_id_equality_marker";
export type BioactivityConsumerBlockerCode =
  | "invalid_evidence_ref"
  | "missing_rollback_ref"
  | "fixture_evidence"
  | "missing_family_spec_topology"
  | "topology_issues"
  | "contract_digest_mismatch"
  | "missing_operation_result"
  | "missing_assessment_parity"
  | "missing_publication_parity"
  | "provenance_semantics_mismatch"
  | "relation_semantics_mismatch"
  | "cross_consumer_evidence_mismatch"
  | "family_specific_branch"
  | "missing_independent_shadow"
  | "sandbox_unproven";

/** Every claim is bound to an exact execution, digest and legacy rollback. */
export interface BioactivityEvidenceRef {
  readonly task_id: string;
  readonly build_id: string;
  readonly run_id: string;
  readonly commit: string;
  readonly digest: string;
  readonly rollback_ref: string;
  readonly evidence_class: BioactivityEvidenceClass;
}

export interface BioactivitySandboxEvidence {
  readonly available: boolean;
  readonly proof_kind: "real_os_sandbox" | "fixture" | "example" | "synthetic_benchmark";
  readonly proof_ref: BioactivityEvidenceRef;
}

export interface BioactivityFamilySpecEvidence {
  readonly spec_digest: string;
  readonly projection_id: string;
  readonly projection_digest: string;
  /** True when the FamilySpec projection describes the input/output topology. */
  readonly input_output_describable: boolean;
  /** Issue codes reported by the Core FamilySpec topology checker. */
  readonly topology_issues: readonly string[];
  readonly ref: BioactivityEvidenceRef;
}

export interface BioactivitySemanticsEvidence {
  readonly semantics_digest: string;
  readonly ref: BioactivityEvidenceRef;
}

export interface BioactivityExecutorScanEvidence {
  /**
   * How the executor scan proved the absence of family-specific dispatch.
   * A marker that only matches `family.id ===` is not evidence and can never
   * satisfy the gate.
   */
  readonly scan_method: "generic_interface_scan" | "family_id_equality_only";
  readonly family_specific_dispatch_found: boolean;
  readonly dag_extension_found: boolean;
  readonly findings: readonly string[];
  readonly ref: BioactivityEvidenceRef;
}

/** The second real consumer candidate: bioactivity_measurement. */
export interface BioactivityConsumerClaim {
  readonly consumer_id: string;
  readonly family_id: string;
  readonly evidence_class: BioactivityEvidenceClass;
  /** Claims the Host/Core path by interface name only, without real evidence. */
  readonly interface_name_only: boolean;
  readonly sandbox: BioactivitySandboxEvidence;
  readonly family_spec: BioactivityFamilySpecEvidence;
  readonly host_contract_ref: BioactivityEvidenceRef;
  readonly core_contract_ref: BioactivityEvidenceRef;
  /** Real native OperationResult evidence; null means none exists. */
  readonly operation_result_ref: BioactivityEvidenceRef | null;
  readonly dataset_id: string;
  readonly revision_id: string;
  readonly dataset_ref: BioactivityEvidenceRef;
  readonly task_id: string;
  readonly build_id: string;
  readonly run_id: string;
  readonly implementation_digest: string;
  readonly input_digest: string;
  readonly output_digest: string;
  readonly publication_semantics_digest: string;
  readonly publication_ref: BioactivityEvidenceRef;
  readonly provenance: BioactivitySemanticsEvidence;
  readonly relations: BioactivitySemanticsEvidence;
  readonly assessment: BioactivitySemanticsEvidence;
  readonly executor_scan: BioactivityExecutorScanEvidence;
  readonly legacy_rollback_ref: BioactivityEvidenceRef;
  /** Independent shadow run evidence for this capability; null means none. */
  readonly shadow_ref: BioactivityEvidenceRef | null;
}

/** The already-released first real consumer (expression); parity anchor. */
export interface BioactivityReferenceConsumer {
  readonly consumer_id: string;
  readonly family_id: string;
  readonly host_contract_ref: BioactivityEvidenceRef;
  readonly core_contract_ref: BioactivityEvidenceRef;
  readonly publication_ref: BioactivityEvidenceRef;
  readonly publication_semantics_digest: string;
  readonly provenance_semantics_digest: string;
  readonly relation_semantics_digest: string;
  readonly assessment_semantics_digest: string;
  readonly task_id: string;
  readonly build_id: string;
  readonly run_id: string;
  readonly implementation_digest: string;
  readonly input_digest: string;
  readonly output_digest: string;
}

export interface BioactivityConsumerInput {
  readonly consumer: BioactivityConsumerClaim;
  readonly reference: BioactivityReferenceConsumer;
  readonly now?: () => Date;
}

export interface BioactivityConsumerBlocker {
  readonly code: BioactivityConsumerBlockerCode;
  readonly detail: string;
  readonly refs: readonly BioactivityEvidenceRef[];
}

export interface BioactivityConsumerChecks {
  readonly family_spec_topology_ready: boolean;
  readonly host_core_contracts_shared: boolean;
  readonly dataset_revision_identity_exact: boolean;
  readonly semantics_parity: boolean;
  readonly independence: boolean;
  readonly operation_result_parity: boolean;
  readonly publication_parity: boolean;
  readonly independent_shadow: boolean;
  readonly legacy_rollback_present: boolean;
  readonly executor_scan_generic: boolean;
}

export interface BioactivityConsumerReport {
  schema_version: "1.0";
  report_kind: "bioactivity_consumer";
  report_id: string;
  consumer_id: string;
  reference_consumer_id: string;
  decision: GoNoGo;
  /** null while decision === "not_ready". */
  recommendation: BioactivityRecommendation | null;
  not_ready_reason: BioactivityNotReadyReason | null;
  not_ready_detail: string | null;
  blockers: readonly BioactivityConsumerBlocker[];
  /** null while decision === "not_ready". */
  checks: BioactivityConsumerChecks | null;
  issued_at: string;
}

/** Typed rejection for malformed untrusted inputs. */
export class BioactivityConsumerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BioactivityConsumerInputError";
  }
}

interface NotReadyShortCircuit {
  reason: BioactivityNotReadyReason;
  detail: string;
}

interface ReportBase {
  schema_version: "1.0";
  report_kind: "bioactivity_consumer";
  report_id: string;
  consumer_id: string;
  reference_consumer_id: string;
  issued_at: string;
}

function nonEmptyId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new BioactivityConsumerInputError(`${name} must be a non-empty id without NUL`);
  }
  return value;
}

function nonEmptyDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !HEX_DIGEST.test(value)) {
    throw new BioactivityConsumerInputError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function validateRef(ref: BioactivityEvidenceRef, name: string): void {
  nonEmptyId(ref.task_id, `${name}.task_id`);
  nonEmptyId(ref.build_id, `${name}.build_id`);
  nonEmptyId(ref.run_id, `${name}.run_id`);
  if (typeof ref.rollback_ref !== "string" || ref.rollback_ref.includes("\0")) {
    throw new BioactivityConsumerInputError(`${name}.rollback_ref must be a string without NUL`);
  }
  nonEmptyId(ref.commit, `${name}.commit`);
  nonEmptyDigest(ref.digest, `${name}.digest`);
}

function validateSandbox(sandbox: BioactivitySandboxEvidence): void {
  if (typeof sandbox.available !== "boolean") {
    throw new BioactivityConsumerInputError("sandbox.available must be a boolean");
  }
  validateRef(sandbox.proof_ref, "sandbox.proof_ref");
}

function validateClaim(claim: BioactivityConsumerClaim): void {
  nonEmptyId(claim.consumer_id, "consumer.consumer_id");
  nonEmptyId(claim.family_id, "consumer.family_id");
  nonEmptyId(claim.dataset_id, "consumer.dataset_id");
  nonEmptyId(claim.revision_id, "consumer.revision_id");
  nonEmptyId(claim.task_id, "consumer.task_id");
  nonEmptyId(claim.build_id, "consumer.build_id");
  nonEmptyId(claim.run_id, "consumer.run_id");
  nonEmptyDigest(claim.implementation_digest, "consumer.implementation_digest");
  nonEmptyDigest(claim.input_digest, "consumer.input_digest");
  nonEmptyDigest(claim.output_digest, "consumer.output_digest");
  nonEmptyDigest(claim.publication_semantics_digest, "consumer.publication_semantics_digest");
  nonEmptyId(claim.family_spec.projection_id, "consumer.family_spec.projection_id");
  nonEmptyDigest(claim.family_spec.spec_digest, "consumer.family_spec.spec_digest");
  nonEmptyDigest(claim.family_spec.projection_digest, "consumer.family_spec.projection_digest");
  if (typeof claim.interface_name_only !== "boolean") {
    throw new BioactivityConsumerInputError("consumer.interface_name_only must be a boolean");
  }
  validateSandbox(claim.sandbox);
  validateRef(claim.family_spec.ref, "consumer.family_spec.ref");
  validateRef(claim.host_contract_ref, "consumer.host_contract_ref");
  validateRef(claim.core_contract_ref, "consumer.core_contract_ref");
  if (claim.operation_result_ref !== null) validateRef(claim.operation_result_ref, "consumer.operation_result_ref");
  validateRef(claim.dataset_ref, "consumer.dataset_ref");
  validateRef(claim.publication_ref, "consumer.publication_ref");
  validateRef(claim.provenance.ref, "consumer.provenance.ref");
  validateRef(claim.relations.ref, "consumer.relations.ref");
  validateRef(claim.assessment.ref, "consumer.assessment.ref");
  validateRef(claim.executor_scan.ref, "consumer.executor_scan.ref");
  validateRef(claim.legacy_rollback_ref, "consumer.legacy_rollback_ref");
  if (claim.shadow_ref !== null) validateRef(claim.shadow_ref, "consumer.shadow_ref");
  if (claim.provenance.semantics_digest.length === 0 || claim.provenance.semantics_digest.includes("\0")) {
    throw new BioactivityConsumerInputError("consumer.provenance.semantics_digest must be a non-empty digest without NUL");
  }
  if (claim.relations.semantics_digest.length === 0 || claim.relations.semantics_digest.includes("\0")) {
    throw new BioactivityConsumerInputError("consumer.relations.semantics_digest must be a non-empty digest without NUL");
  }
  if (claim.assessment.semantics_digest.length === 0 || claim.assessment.semantics_digest.includes("\0")) {
    throw new BioactivityConsumerInputError("consumer.assessment.semantics_digest must be a non-empty digest without NUL");
  }
}

function validateReference(reference: BioactivityReferenceConsumer): void {
  nonEmptyId(reference.consumer_id, "reference.consumer_id");
  nonEmptyId(reference.family_id, "reference.family_id");
  nonEmptyId(reference.task_id, "reference.task_id");
  nonEmptyId(reference.build_id, "reference.build_id");
  nonEmptyId(reference.run_id, "reference.run_id");
  nonEmptyDigest(reference.implementation_digest, "reference.implementation_digest");
  nonEmptyDigest(reference.input_digest, "reference.input_digest");
  nonEmptyDigest(reference.output_digest, "reference.output_digest");
  nonEmptyDigest(reference.publication_semantics_digest, "reference.publication_semantics_digest");
  nonEmptyDigest(reference.provenance_semantics_digest, "reference.provenance_semantics_digest");
  nonEmptyDigest(reference.relation_semantics_digest, "reference.relation_semantics_digest");
  nonEmptyDigest(reference.assessment_semantics_digest, "reference.assessment_semantics_digest");
  validateRef(reference.host_contract_ref, "reference.host_contract_ref");
  validateRef(reference.core_contract_ref, "reference.core_contract_ref");
  validateRef(reference.publication_ref, "reference.publication_ref");
}

function validateInput(input: BioactivityConsumerInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BioactivityConsumerInputError("input must be a plain evidence packet");
  }
  validateClaim(input.consumer);
  validateReference(input.reference);
}

function refIsExact(ref: BioactivityEvidenceRef): boolean {
  return ref.task_id.trim().length > 0
    && ref.build_id.trim().length > 0
    && ref.run_id.trim().length > 0
    && COMMIT.test(ref.commit)
    && HEX_DIGEST.test(ref.digest)
    && ref.rollback_ref.trim().length > 0;
}

function refBlockers(ref: BioactivityEvidenceRef): BioactivityConsumerBlocker[] {
  const blockers: BioactivityConsumerBlocker[] = [];
  if (ref.rollback_ref.trim().length === 0) {
    blockers.push({
      code: "missing_rollback_ref",
      detail: "Every second-consumer evidence claim must carry an exact legacy rollback reference.",
      refs: [ref],
    });
    return blockers;
  }
  if (!refIsExact(ref)) {
    blockers.push({
      code: "invalid_evidence_ref",
      detail: "Evidence must identify task, build, run, commit and digest exactly.",
      refs: [ref],
    });
    return blockers;
  }
  if (ref.evidence_class === "fixture") {
    blockers.push({
      code: "fixture_evidence",
      detail: "Fixture evidence cannot satisfy the second-consumer gate.",
      refs: [ref],
    });
  }
  return blockers;
}

function notReadyShortCircuit(claim: BioactivityConsumerClaim): NotReadyShortCircuit | null {
  const refs = [
    claim.family_spec.ref,
    claim.host_contract_ref,
    claim.core_contract_ref,
    claim.dataset_ref,
    claim.publication_ref,
    claim.provenance.ref,
    claim.relations.ref,
    claim.assessment.ref,
    claim.executor_scan.ref,
    claim.legacy_rollback_ref,
    claim.sandbox.proof_ref,
    ...(claim.operation_result_ref === null ? [] : [claim.operation_result_ref]),
    ...(claim.shadow_ref === null ? [] : [claim.shadow_ref]),
  ];
  const exampleRef = refs.find((ref) => ref.evidence_class === "example");
  if (claim.evidence_class === "example" || exampleRef !== undefined) {
    return {
      reason: "static_retrieval_example",
      detail: "Static retrieval example evidence cannot be evaluated by the second-consumer gate.",
    };
  }
  const syntheticRef = refs.find((ref) => ref.evidence_class === "synthetic_benchmark");
  if (
    claim.evidence_class === "synthetic_benchmark"
    || claim.sandbox.proof_kind === "synthetic_benchmark"
    || syntheticRef !== undefined
  ) {
    return {
      reason: "synthetic_benchmark",
      detail: "Synthetic benchmark evidence cannot be evaluated by the second-consumer gate.",
    };
  }
  if (!claim.sandbox.available) {
    return {
      reason: "sandbox_unavailable",
      detail: "No executable sandbox is available for the second consumer.",
    };
  }
  if (claim.interface_name_only) {
    return {
      reason: "interface_name_only",
      detail: "The claim reuses Host/Core interface names without real evidence and cannot be evaluated.",
    };
  }
  if (claim.executor_scan.scan_method === "family_id_equality_only") {
    return {
      reason: "family_id_equality_marker",
      detail: "The executor scan marker relies only on family.id equality, which is not evidence of a generic dispatch.",
    };
  }
  return null;
}

function notReadyReport(base: ReportBase, short: NotReadyShortCircuit): BioactivityConsumerReport {
  return {
    ...base,
    decision: "not_ready",
    recommendation: null,
    not_ready_reason: short.reason,
    not_ready_detail: short.detail,
    blockers: [],
    checks: null,
  };
}

/**
 * Evaluate whether bioactivity_measurement can start as the second real
 * consumer of the generic Host/Core path.
 *
 * Deterministic: identical inputs (including the injected clock) always yield
 * an identical report, and every blocking condition is a typed blocker entry
 * rather than a throw. `not_ready` is produced only for non-evidence (static
 * retrieval examples, unavailable sandbox, synthetic benchmarks, interface-
 * name-only claims, family.id-only scan markers) and never carries a
 * recommendation. `go_no_go` always carries a recommendation: `go` only when
 * no blocker exists, otherwise `no_go`.
 */
export function evaluateBioactivityConsumer(input: BioactivityConsumerInput): BioactivityConsumerReport {
  validateInput(input);
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Core bioactivity consumer clock returned an invalid timestamp");
  }
  const issuedAt = now.toISOString();
  const reportId = canonicalDigest({
    consumer: input.consumer,
    reference: input.reference,
  });
  const base: ReportBase = {
    schema_version: "1.0",
    report_kind: "bioactivity_consumer",
    report_id: reportId,
    consumer_id: input.consumer.consumer_id,
    reference_consumer_id: input.reference.consumer_id,
    issued_at: issuedAt,
  };

  const notReady = notReadyShortCircuit(input.consumer);
  if (notReady !== null) return notReadyReport(base, notReady);

  const consumer = input.consumer;
  const reference = input.reference;
  const blockers: BioactivityConsumerBlocker[] = [];

  // Every evidence claim must be exact and carry a legacy rollback reference.
  const allRefs: BioactivityEvidenceRef[] = [
    consumer.family_spec.ref,
    consumer.host_contract_ref,
    consumer.core_contract_ref,
    consumer.dataset_ref,
    consumer.publication_ref,
    consumer.provenance.ref,
    consumer.relations.ref,
    consumer.assessment.ref,
    consumer.executor_scan.ref,
    consumer.legacy_rollback_ref,
    consumer.sandbox.proof_ref,
    ...(consumer.operation_result_ref === null ? [] : [consumer.operation_result_ref]),
    ...(consumer.shadow_ref === null ? [] : [consumer.shadow_ref]),
  ];
  for (const ref of allRefs) {
    blockers.push(...refBlockers(ref));
  }

  // FamilySpec/projection/topology must describe the bioactivity I/O topology.
  const spec = consumer.family_spec;
  if (
    !spec.input_output_describable
    || spec.projection_id.trim().length === 0
    || !HEX_DIGEST.test(spec.spec_digest)
    || !HEX_DIGEST.test(spec.projection_digest)
  ) {
    blockers.push({
      code: "missing_family_spec_topology",
      detail: "The bioactivity input/output topology is not describable by a FamilySpec projection.",
      refs: [spec.ref],
    });
  }
  if (spec.topology_issues.length > 0) {
    blockers.push({
      code: "topology_issues",
      detail: `The Core FamilySpec topology checker reported ${spec.topology_issues.length} issue(s).`,
      refs: [spec.ref],
    });
  }

  // The generic Host/Core contract refs must be shared with the first consumer.
  if (
    consumer.host_contract_ref.digest !== reference.host_contract_ref.digest
    || consumer.core_contract_ref.digest !== reference.core_contract_ref.digest
  ) {
    blockers.push({
      code: "contract_digest_mismatch",
      detail: "The second consumer must reuse the same generic Host/Core contract digest as the first consumer.",
      refs: [consumer.host_contract_ref, consumer.core_contract_ref],
    });
  }

  // Dataset/revision identity: exact ids bound to the claim's executions.
  const datasetExact = consumer.dataset_id.length > 0
    && consumer.revision_id.length > 0
    && refIsExact(consumer.dataset_ref)
    && consumer.dataset_ref.task_id === consumer.task_id
    && consumer.dataset_ref.build_id === consumer.build_id;

  // Provenance/relation/assessment semantics must match the first consumer.
  const provenanceParity = consumer.provenance.semantics_digest === reference.provenance_semantics_digest;
  const relationParity = consumer.relations.semantics_digest === reference.relation_semantics_digest;
  const assessmentParity = consumer.assessment.semantics_digest === reference.assessment_semantics_digest;
  if (!provenanceParity) {
    blockers.push({
      code: "provenance_semantics_mismatch",
      detail: "Provenance semantics differ from the first consumer.",
      refs: [consumer.provenance.ref],
    });
  }
  if (!relationParity) {
    blockers.push({
      code: "relation_semantics_mismatch",
      detail: "Relation semantics differ from the first consumer.",
      refs: [consumer.relations.ref],
    });
  }
  if (!assessmentParity) {
    blockers.push({
      code: "missing_assessment_parity",
      detail: "Assessment parity with the first consumer is missing or differs.",
      refs: [consumer.assessment.ref],
    });
  }

  // Independent task/run/build/implementation/input/output/publication evidence.
  const independentFromReference = consumer.task_id !== reference.task_id
    && consumer.build_id !== reference.build_id
    && consumer.run_id !== reference.run_id
    && consumer.implementation_digest !== reference.implementation_digest
    && consumer.input_digest !== reference.input_digest
    && consumer.output_digest !== reference.output_digest
    && consumer.publication_ref.digest !== reference.publication_ref.digest;
  const internallyConsistent = allRefs.every(
    (ref) => ref.task_id === consumer.task_id && ref.build_id === consumer.build_id,
  );
  if (!independentFromReference || !internallyConsistent) {
    blockers.push({
      code: "cross_consumer_evidence_mismatch",
      detail: independentFromReference
        ? "The second consumer evidence claims do not all bind to the same task/build execution."
        : "The second consumer must be evidenced by task/run/build/implementation/input/output/publication identity independent of the first consumer.",
      refs: allRefs,
    });
  }

  // Real OperationResult, publication parity and independent shadow.
  if (consumer.operation_result_ref === null) {
    blockers.push({
      code: "missing_operation_result",
      detail: "A real native OperationResult evidence reference is required.",
      refs: [],
    });
  }
  if (
    consumer.publication_semantics_digest !== reference.publication_semantics_digest
    || !HEX_DIGEST.test(consumer.publication_semantics_digest)
  ) {
    blockers.push({
      code: "missing_publication_parity",
      detail: "Publication parity with the first consumer is missing or differs.",
      refs: [consumer.publication_ref],
    });
  }
  if (consumer.shadow_ref === null) {
    blockers.push({
      code: "missing_independent_shadow",
      detail: "A second-consumer independent shadow evidence reference is required.",
      refs: [],
    });
  }

  // Executor scan must prove the absence of family-specific dispatch/DAG.
  if (consumer.executor_scan.family_specific_dispatch_found || consumer.executor_scan.dag_extension_found) {
    blockers.push({
      code: "family_specific_branch",
      detail: consumer.executor_scan.family_specific_dispatch_found
        ? "The executor scan found family-specific dispatch that is not part of the generic Core path."
        : "The executor scan found a family-specific DAG extension that is not part of the generic Core path.",
      refs: [consumer.executor_scan.ref],
    });
  }

  // Sandbox proof must be a real OS isolation proof.
  if (consumer.sandbox.proof_kind !== "real_os_sandbox") {
    blockers.push({
      code: "sandbox_unproven",
      detail: "Only a real OS isolation sandbox proof can satisfy the second-consumer gate.",
      refs: [consumer.sandbox.proof_ref],
    });
  }

  const codes = new Set(blockers.map((blocker) => blocker.code));
  const checks: BioactivityConsumerChecks = {
    family_spec_topology_ready: !codes.has("missing_family_spec_topology") && !codes.has("topology_issues"),
    host_core_contracts_shared: !codes.has("contract_digest_mismatch"),
    dataset_revision_identity_exact: datasetExact && !codes.has("invalid_evidence_ref") && !codes.has("missing_rollback_ref"),
    semantics_parity: provenanceParity && relationParity && assessmentParity,
    independence: independentFromReference && internallyConsistent,
    operation_result_parity: consumer.operation_result_ref !== null,
    publication_parity: !codes.has("missing_publication_parity"),
    independent_shadow: consumer.shadow_ref !== null,
    legacy_rollback_present: !codes.has("missing_rollback_ref"),
    executor_scan_generic: !codes.has("family_specific_branch"),
  };

  const decision: GoNoGo = "go_no_go";
  const recommendation: BioactivityRecommendation = blockers.length === 0 ? "go" : "no_go";
  return {
    ...base,
    decision,
    recommendation,
    not_ready_reason: null,
    not_ready_detail: null,
    blockers,
    checks,
  };
}
