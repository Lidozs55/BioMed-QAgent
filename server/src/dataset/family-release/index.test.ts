import { describe, expect, it } from "vitest";

import {
  evaluateFamilyHostRelease,
  type FamilyHostReleaseInput,
  type FamilyReleaseEvidenceRef,
} from "./index.js";

const DIGEST_1 = "1".repeat(64);
const COMMIT = "6ad0c6a9";

function ref(runId: string, evidenceClass: FamilyReleaseEvidenceRef["evidence_class"] = "trusted"): FamilyReleaseEvidenceRef {
  return {
    task_id: "task-release",
    requirement_id: "build-expression",
    run_id: runId,
    commit: COMMIT,
    digest: DIGEST_1,
    rollback_ref: "rollback:family-host:6ad0c6a9",
    evidence_class: evidenceClass,
  };
}

function releaseInput(): FamilyHostReleaseInput {
  return {
    contract: {
      contract_digest: DIGEST_1,
      review_refs: [ref("run-review")],
    },
    sandbox: {
      available: true,
      proof_kind: "real_os_sandbox",
      proof_ref: ref("run-sandbox"),
      network_denied: true,
      credentials_denied: true,
      path_escape_denied: true,
      hard_kill_verified: true,
    },
    core: {
      admission: { native: true, ref: ref("run-core") },
      operation_result: { native: true, ref: ref("run-core") },
      publication_verifier: {
        native: true,
        authoritative_receipt_revalidation: true,
        rejects_publish_shortcut: true,
        ref: ref("run-publish"),
      },
    },
    recovery: {
      cancel: ref("run-cancel"),
      timeout: ref("run-timeout"),
      restart: ref("run-restart"),
      stale_worker: ref("run-stale"),
      late_commit: ref("run-late"),
      publish_reuse: ref("run-reuse"),
      all_recovered: true,
    },
    consumers: [
      {
        consumer_id: "bioactivity_measurement",
        real_consumer: true,
        independent_from: ["gene_expression"],
        ref: ref("run-bioactivity"),
        same_commit_artifact_refs: [ref("run-bioactivity-artifact")],
      },
      {
        consumer_id: "gene_expression",
        real_consumer: true,
        independent_from: ["bioactivity_measurement"],
        ref: ref("run-expression"),
        same_commit_artifact_refs: [ref("run-expression-artifact")],
      },
    ],
  };
}

function blockerCodes(input: FamilyHostReleaseInput): string[] {
  return evaluateFamilyHostRelease(input).blockers.map((blocker) => blocker.code);
}

describe("evaluateFamilyHostRelease", () => {
  it("returns a deterministic R1-R5 order and preserves go/no-go typing", () => {
    const input = releaseInput();
    const first = evaluateFamilyHostRelease(input);
    const second = evaluateFamilyHostRelease({
      ...input,
      consumers: [...input.consumers].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.decision).toBe("go_no_go");
    expect(first.recommendation).toBe("go");
    expect(first.gates.map((gate) => gate.gate)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(first.blockers).toEqual([]);
  });

  it.each([
    ["fixture", "fixture_evidence"],
    ["example", "example_evidence"],
    ["synthetic_benchmark", "synthetic_benchmark"],
  ] as const)("marks %s evidence not_ready with a typed go_no_go decision", (evidenceClass, code) => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      consumers: base.consumers.map((consumer, index) => index === 0
        ? { ...consumer, ref: ref("run-bioactivity", evidenceClass) }
        : consumer),
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(result.recommendation).toBe("no_go");
    expect(blockerCodes(input)).toContain(code);
  });

  it("blocks sandbox_unavailable and unproven sandbox evidence", () => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      sandbox: { ...base.sandbox, available: false, proof_kind: "fixture" },
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(result.gates[1].gate).toBe("R2");
    expect(blockerCodes(input)).toEqual(expect.arrayContaining(["sandbox_unavailable", "unproven_sandbox", "fixture_evidence"]));
  });

  it("requires rollback references on every exact evidence reference", () => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      recovery: { ...base.recovery, timeout: { ...base.recovery.timeout, rollback_ref: "" } },
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(blockerCodes(input)).toContain("missing_rollback_ref");
  });

  it("blocks one real consumer and missing same-commit artifact evidence", () => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      consumers: [{ ...base.consumers[0], same_commit_artifact_refs: [] }],
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(blockerCodes(input)).toEqual(expect.arrayContaining(["insufficient_real_consumers", "missing_same_commit_artifact"]));
  });

  it("requires independent runs for cross-run representative evidence", () => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      consumers: base.consumers.map((consumer) => ({
        ...consumer,
        ref: { ...consumer.ref, run_id: "run-shared" },
      })),
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(blockerCodes(input)).toContain("cross_run_evidence_mismatch");
  });

  it("rejects a missing verifier and a publish shortcut", () => {
    const base = releaseInput();
    const input: FamilyHostReleaseInput = {
      ...base,
      core: {
        ...base.core,
        publication_verifier: {
          ...base.core.publication_verifier,
          native: false,
          authoritative_receipt_revalidation: false,
          rejects_publish_shortcut: false,
        },
      },
    };

    const result = evaluateFamilyHostRelease(input);

    expect(result.decision).toBe("not_ready");
    expect(blockerCodes(input)).toEqual(expect.arrayContaining(["missing_publication_verifier", "publish_shortcut"]));
  });
});
