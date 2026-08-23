import { describe, expect, it } from "vitest";

import {
  BioactivityConsumerInputError,
  evaluateBioactivityConsumer,
  type BioactivityConsumerBlockerCode,
  type BioactivityConsumerClaim,
  type BioactivityConsumerInput,
  type BioactivityConsumerReport,
  type BioactivityEvidenceRef,
  type BioactivityReferenceConsumer,
} from "../src/dataset/bioactivity-gate/index.js";
import * as gateModule from "../src/dataset/bioactivity-gate/index.js";

const COMMIT = "acd253ec";
const ROLLBACK = "rollback:family-host:acd253ec";
const BIO_TASK = "task-bioactivity-e3";
const BIO_BUILD = "build-bioactivity-e3";
const BIO_RUN = "run-bio-1";
const REF_TASK = "task-expression-e2";
const REF_BUILD = "build-expression-e2";
const REF_RUN = "run-expression-1";
const CONTRACT_DIGEST = "c".repeat(64); // generic Host/Core contract, shared
const SEMANTICS_DIGEST = "d".repeat(64); // provenance/relation/assessment, shared
const SPEC_DIGEST = "e".repeat(64);
const IMPL_BIO = "1".repeat(64);
const INPUT_BIO = "2".repeat(64);
const OUTPUT_BIO = "3".repeat(64);
const PUB_BIO = "4".repeat(64);
const IMPL_REF = "5".repeat(64);
const INPUT_REF = "6".repeat(64);
const OUTPUT_REF = "7".repeat(64);
const PUB_REF = "8".repeat(64);
const REVISION_ID = `dsrev_${"f".repeat(64)}`;
const FIXED_NOW = "2026-01-02T00:00:00.000Z";

function ref(runId: string, overrides: Partial<BioactivityEvidenceRef> = {}): BioactivityEvidenceRef {
  return {
    task_id: BIO_TASK,
    build_id: BIO_BUILD,
    run_id: runId,
    commit: COMMIT,
    digest: SPEC_DIGEST,
    rollback_ref: ROLLBACK,
    evidence_class: "trusted",
    ...overrides,
  };
}

function reference(overrides: Partial<BioactivityReferenceConsumer> = {}): BioactivityReferenceConsumer {
  return {
    consumer_id: "gene_expression",
    family_id: "gene_expression",
    task_id: REF_TASK,
    build_id: REF_BUILD,
    run_id: REF_RUN,
    implementation_digest: IMPL_REF,
    input_digest: INPUT_REF,
    output_digest: OUTPUT_REF,
    host_contract_ref: ref("run-expression-host-1", { task_id: REF_TASK, build_id: REF_BUILD, digest: CONTRACT_DIGEST }),
    core_contract_ref: ref("run-expression-core-1", { task_id: REF_TASK, build_id: REF_BUILD, digest: CONTRACT_DIGEST }),
    publication_ref: ref("run-expression-pub-1", { task_id: REF_TASK, build_id: REF_BUILD, digest: PUB_REF }),
    publication_semantics_digest: SEMANTICS_DIGEST,
    provenance_semantics_digest: SEMANTICS_DIGEST,
    relation_semantics_digest: SEMANTICS_DIGEST,
    assessment_semantics_digest: SEMANTICS_DIGEST,
    ...overrides,
  };
}

function claim(overrides: Partial<BioactivityConsumerClaim> = {}): BioactivityConsumerClaim {
  return {
    consumer_id: "bioactivity_measurement",
    family_id: "bioactivity_measurement",
    evidence_class: "trusted",
    interface_name_only: false,
    sandbox: {
      available: true,
      proof_kind: "real_os_sandbox",
      proof_ref: ref("run-bio-sandbox"),
    },
    family_spec: {
      spec_digest: SPEC_DIGEST,
      projection_id: "bioactivity.projection.v1",
      projection_digest: SPEC_DIGEST,
      input_output_describable: true,
      topology_issues: [],
      ref: ref("run-bio-topology"),
    },
    host_contract_ref: ref("run-bio-host-1", { digest: CONTRACT_DIGEST }),
    core_contract_ref: ref("run-bio-core-1", { digest: CONTRACT_DIGEST }),
    operation_result_ref: ref("run-bio-op-result"),
    dataset_id: "ds_bioactivity",
    revision_id: REVISION_ID,
    dataset_ref: ref("run-bio-dataset"),
    task_id: BIO_TASK,
    build_id: BIO_BUILD,
    run_id: BIO_RUN,
    implementation_digest: IMPL_BIO,
    input_digest: INPUT_BIO,
    output_digest: OUTPUT_BIO,
    publication_semantics_digest: SEMANTICS_DIGEST,
    publication_ref: ref("run-bio-pub-1", { digest: PUB_BIO }),
    provenance: { semantics_digest: SEMANTICS_DIGEST, ref: ref("run-bio-provenance") },
    relations: { semantics_digest: SEMANTICS_DIGEST, ref: ref("run-bio-relations") },
    assessment: { semantics_digest: SEMANTICS_DIGEST, ref: ref("run-bio-assessment") },
    executor_scan: {
      scan_method: "generic_interface_scan",
      family_specific_dispatch_found: false,
      dag_extension_found: false,
      findings: ["executor.dispatch:generic"],
      ref: ref("run-bio-scan"),
    },
    legacy_rollback_ref: ref("run-bio-rollback"),
    shadow_ref: ref("run-bio-shadow"),
    ...overrides,
  };
}

function readyInput(claimOverrides: Partial<BioactivityConsumerClaim> = {}): BioactivityConsumerInput {
  return {
    consumer: claim(claimOverrides),
    reference: reference(),
    now: () => new Date(FIXED_NOW),
  };
}

function blockerCodes(report: BioactivityConsumerReport): BioactivityConsumerBlockerCode[] {
  return report.blockers.map((blocker) => blocker.code);
}

describe("D-E3 bioactivity second-consumer go/no-go gate", () => {
  it("recommends go when the bioactivity consumer carries complete real evidence", () => {
    const report = evaluateBioactivityConsumer(readyInput());
    expect(report.decision).toBe("go_no_go");
    expect(report.recommendation).toBe("go");
    expect(report.not_ready_reason).toBeNull();
    expect(report.blockers).toEqual([]);
    expect(report.checks).toEqual({
      family_spec_topology_ready: true,
      host_core_contracts_shared: true,
      dataset_revision_identity_exact: true,
      semantics_parity: true,
      independence: true,
      operation_result_parity: true,
      publication_parity: true,
      independent_shadow: true,
      legacy_rollback_present: true,
      executor_scan_generic: true,
    });
    expect(report.report_kind).toBe("bioactivity_consumer");
    expect(report.consumer_id).toBe("bioactivity_measurement");
    expect(report.reference_consumer_id).toBe("gene_expression");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("rejects non-evidence with not_ready: static examples, unavailable sandbox, synthetic benchmarks, interface-name-only claims, and family.id-only scan markers", () => {
    const cases: Array<{
      name: string;
      overrides: Partial<BioactivityConsumerClaim>;
      reason: string;
    }> = [
      {
        name: "static retrieval example",
        overrides: { evidence_class: "example" },
        reason: "static_retrieval_example",
      },
      {
        name: "synthetic benchmark evidence class",
        overrides: { evidence_class: "synthetic_benchmark" },
        reason: "synthetic_benchmark",
      },
      {
        name: "synthetic benchmark sandbox proof",
        overrides: { sandbox: { available: true, proof_kind: "synthetic_benchmark", proof_ref: ref("run-bio-sandbox") } },
        reason: "synthetic_benchmark",
      },
      {
        name: "unavailable sandbox",
        overrides: { sandbox: { available: false, proof_kind: "real_os_sandbox", proof_ref: ref("run-bio-sandbox") } },
        reason: "sandbox_unavailable",
      },
      {
        name: "interface name reuse only",
        overrides: { interface_name_only: true },
        reason: "interface_name_only",
      },
      {
        name: "family.id equality-only scan marker",
        overrides: {
          executor_scan: {
            scan_method: "family_id_equality_only",
            family_specific_dispatch_found: false,
            dag_extension_found: false,
            findings: ["family.id === bioactivity_measurement"],
            ref: ref("run-bio-scan"),
          },
        },
        reason: "family_id_equality_marker",
      },
      {
        name: "example-class evidence ref under a trusted claim",
        overrides: { shadow_ref: ref("run-bio-shadow", { evidence_class: "example" }) },
        reason: "static_retrieval_example",
      },
    ];
    for (const entry of cases) {
      const report = evaluateBioactivityConsumer(readyInput(entry.overrides));
      expect(report.decision, entry.name).toBe("not_ready");
      expect(report.not_ready_reason, entry.name).toBe(entry.reason);
      expect(report.recommendation, entry.name).toBeNull();
      expect(report.checks, entry.name).toBeNull();
      expect(report.blockers, entry.name).toEqual([]);
    }
  });

  it("returns go_no_go with no_go when real OperationResult/assessment/publication parity or the independent shadow is missing", () => {
    const missingOperationResult = evaluateBioactivityConsumer(
      readyInput({ operation_result_ref: null }),
    );
    expect(missingOperationResult.decision).toBe("go_no_go");
    expect(missingOperationResult.recommendation).toBe("no_go");
    expect(missingOperationResult.checks?.operation_result_parity).toBe(false);
    expect(blockerCodes(missingOperationResult)).toContain("missing_operation_result");

    const missingShadow = evaluateBioactivityConsumer(readyInput({ shadow_ref: null }));
    expect(missingShadow.decision).toBe("go_no_go");
    expect(missingShadow.recommendation).toBe("no_go");
    expect(missingShadow.checks?.independent_shadow).toBe(false);
    expect(blockerCodes(missingShadow)).toContain("missing_independent_shadow");

    const assessmentMismatch = evaluateBioactivityConsumer(readyInput({
      assessment: { semantics_digest: IMPL_REF, ref: ref("run-bio-assessment") },
    }));
    expect(assessmentMismatch.decision).toBe("go_no_go");
    expect(assessmentMismatch.recommendation).toBe("no_go");
    expect(assessmentMismatch.checks?.semantics_parity).toBe(false);
    expect(blockerCodes(assessmentMismatch)).toContain("missing_assessment_parity");

    const publicationMismatch = evaluateBioactivityConsumer(readyInput({
      publication_semantics_digest: IMPL_REF,
    }));
    expect(publicationMismatch.decision).toBe("go_no_go");
    expect(publicationMismatch.recommendation).toBe("no_go");
    expect(publicationMismatch.checks?.publication_parity).toBe(false);
    expect(blockerCodes(publicationMismatch)).toContain("missing_publication_parity");
  });

  it("blocks cross-family evidence mismatch when the second consumer reuses first-consumer execution identity", () => {
    const reusedRun = evaluateBioactivityConsumer(readyInput({ run_id: REF_RUN }));
    expect(reusedRun.decision).toBe("go_no_go");
    expect(reusedRun.recommendation).toBe("no_go");
    expect(reusedRun.checks?.independence).toBe(false);
    expect(blockerCodes(reusedRun)).toContain("cross_consumer_evidence_mismatch");

    const reusedImplementation = evaluateBioactivityConsumer(readyInput({ implementation_digest: IMPL_REF }));
    expect(blockerCodes(reusedImplementation)).toContain("cross_consumer_evidence_mismatch");

    const reusedPublication = evaluateBioactivityConsumer(readyInput({
      publication_ref: ref("run-bio-pub-1", { digest: PUB_REF }),
    }));
    expect(blockerCodes(reusedPublication)).toContain("cross_consumer_evidence_mismatch");

    // Internal inconsistency: a claim ref bound to another task/build/run.
    const detachedRef = evaluateBioactivityConsumer(readyInput({
      host_contract_ref: ref("run-bio-host-1", { task_id: REF_TASK, build_id: REF_BUILD, digest: CONTRACT_DIGEST }),
    }));
    expect(detachedRef.decision).toBe("go_no_go");
    expect(detachedRef.recommendation).toBe("no_go");
    expect(blockerCodes(detachedRef)).toContain("cross_consumer_evidence_mismatch");
  });

  it("blocks a family-specific dispatch or DAG extension found by the executor scan", () => {
    const dispatchBranch = evaluateBioactivityConsumer(readyInput({
      executor_scan: {
        scan_method: "generic_interface_scan",
        family_specific_dispatch_found: true,
        dag_extension_found: false,
        findings: ["runtime/registered-multitable.ts: family.id === bioactivity_measurement"],
        ref: ref("run-bio-scan"),
      },
    }));
    expect(dispatchBranch.decision).toBe("go_no_go");
    expect(dispatchBranch.recommendation).toBe("no_go");
    expect(dispatchBranch.checks?.executor_scan_generic).toBe(false);
    const dispatchBlocker = dispatchBranch.blockers.find((blocker) => blocker.code === "family_specific_branch");
    expect(dispatchBlocker?.detail).toContain("family-specific dispatch");

    const dagBranch = evaluateBioactivityConsumer(readyInput({
      executor_scan: {
        scan_method: "generic_interface_scan",
        family_specific_dispatch_found: false,
        dag_extension_found: true,
        findings: ["transform slot extended with a bioactivity-only DAG"],
        ref: ref("run-bio-scan"),
      },
    }));
    expect(dagBranch.decision).toBe("go_no_go");
    expect(dagBranch.recommendation).toBe("no_go");
    const dagBlocker = dagBranch.blockers.find((blocker) => blocker.code === "family_specific_branch");
    expect(dagBlocker?.detail).toContain("DAG extension");
  });

  it("blocks every evidence claim that lacks a legacy rollback reference", () => {
    const missingRollback = evaluateBioactivityConsumer(readyInput({
      legacy_rollback_ref: ref("run-bio-rollback", { rollback_ref: "" }),
    }));
    expect(missingRollback.decision).toBe("go_no_go");
    expect(missingRollback.recommendation).toBe("no_go");
    expect(missingRollback.checks?.legacy_rollback_present).toBe(false);
    expect(blockerCodes(missingRollback)).toContain("missing_rollback_ref");

    const missingRollbackOnShadow = evaluateBioactivityConsumer(readyInput({
      shadow_ref: ref("run-bio-shadow", { rollback_ref: "" }),
    }));
    expect(blockerCodes(missingRollbackOnShadow)).toContain("missing_rollback_ref");

    const everyRef = evaluateBioactivityConsumer(readyInput({
      core_contract_ref: ref("run-bio-core-1", { rollback_ref: "" }),
    }));
    expect(everyRef.checks?.legacy_rollback_present).toBe(false);
  });

  it("blocks a generic Host/Core contract digest that differs from the first consumer", () => {
    const report = evaluateBioactivityConsumer(readyInput({
      core_contract_ref: ref("run-bio-core-1", { digest: IMPL_BIO }),
    }));
    expect(report.decision).toBe("go_no_go");
    expect(report.recommendation).toBe("no_go");
    expect(report.checks?.host_core_contracts_shared).toBe(false);
    expect(blockerCodes(report)).toContain("contract_digest_mismatch");
  });

  it("blocks fixture-class evidence with no_go instead of not_ready", () => {
    const report = evaluateBioactivityConsumer(readyInput({
      shadow_ref: ref("run-bio-shadow", { evidence_class: "fixture" }),
    }));
    expect(report.decision).toBe("go_no_go");
    expect(report.recommendation).toBe("no_go");
    expect(blockerCodes(report)).toContain("fixture_evidence");
  });

  it("is deterministic: identical inputs yield identical reports and only the injected clock changes issued_at", () => {
    const input = readyInput();
    const first = evaluateBioactivityConsumer(input);
    const second = evaluateBioactivityConsumer(input);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    const later = evaluateBioactivityConsumer({ ...input, now: () => new Date("2026-01-03T00:00:00.000Z") });
    expect(later.report_id).toBe(first.report_id);
    expect(later.decision).toBe(first.decision);
    expect(later.blockers).toEqual(first.blockers);
    expect(later.issued_at).toBe("2026-01-03T00:00:00.000Z");
    expect({ ...later, issued_at: first.issued_at }).toEqual(first);
  });

  it("exposes no publication, OperationResult or activation semantics", () => {
    const runtimeExports = Object.keys(gateModule);
    expect(runtimeExports).toContain("evaluateBioactivityConsumer");
    expect(runtimeExports.filter((name) => /^(OperationResult|Publication|Activation)/i.test(name))).toEqual([]);

    const reports = [
      evaluateBioactivityConsumer(readyInput()),
      evaluateBioactivityConsumer(readyInput({ operation_result_ref: null })),
      evaluateBioactivityConsumer(readyInput({ evidence_class: "example" })),
      evaluateBioactivityConsumer(readyInput({ run_id: REF_RUN })),
    ];
    for (const report of reports) {
      expect(report.report_kind).toBe("bioactivity_consumer");
      const keys = Object.keys(report);
      expect(keys).not.toContain("publication");
      expect(keys).not.toContain("operation_result");
      expect(keys).not.toContain("activated");
      if (report.decision === "not_ready") {
        expect(report.recommendation).toBeNull();
        expect(report.checks).toBeNull();
      }
    }
    const ready = evaluateBioactivityConsumer(readyInput());
    expect(ready.recommendation).toBe("go");
    const noGo = evaluateBioactivityConsumer(readyInput({ run_id: REF_RUN }));
    expect(noGo.recommendation).toBe("no_go");
  });

  it("rejects malformed inputs with a typed input error", () => {
    expect(() => evaluateBioactivityConsumer(readyInput({ consumer_id: "" }))).toThrow(BioactivityConsumerInputError);
    expect(() => evaluateBioactivityConsumer(readyInput({ task_id: "bad\u0000task" }))).toThrow(BioactivityConsumerInputError);
    expect(() => evaluateBioactivityConsumer(readyInput({
      publication_ref: ref("run-bio-pub-1", { digest: "not-a-digest" }),
    }))).toThrow(BioactivityConsumerInputError);
    expect(() => evaluateBioactivityConsumer({
      consumer: claim(),
      reference: reference({ task_id: "" }),
      now: () => new Date(FIXED_NOW),
    })).toThrow(BioactivityConsumerInputError);
  });
});
