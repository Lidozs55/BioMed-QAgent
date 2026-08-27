import { describe, expect, it } from "vitest";

import {
  compareSelectedShadowRuns,
  type CompareSelectedShadowRunsInput,
  type ShadowBlockingMismatchCode,
  type ShadowEvidenceReport,
  type ShadowRunManifest,
  type ShadowRunResolution,
  type ShadowRunSelection,
} from "../src/dataset/shadow-evidence/index.js";
import * as gateModule from "../src/dataset/shadow-evidence/index.js";

const TASK_ID = "task-shadow-d-e2";
const BUILD_ID = "build-shadow-d-e2";
const LEGACY: ShadowRunSelection = { run_id: "run-legacy-1", attempt: 1, manifest_id: "manifest-legacy-1" };
const HOST: ShadowRunSelection = { run_id: "run-host-1", attempt: 1, manifest_id: "manifest-host-1" };
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const LEGACY_ROOT = "/shadow/roots/legacy-1";
const HOST_ROOT = "/shadow/roots/host-1";
const FIXED_NOW = "2026-01-02T00:00:00.000Z";

function hostManifest(overrides: Partial<ShadowRunManifest> = {}): ShadowRunManifest {
  return manifest({ manifest_id: "manifest-host-1", run_id: "run-host-1", ...overrides });
}

function manifest(overrides: Partial<ShadowRunManifest> = {}): ShadowRunManifest {
  return {
    manifest_id: "manifest-legacy-1",
    run_id: "run-legacy-1",
    attempt: 1,
    task_id: TASK_ID,
    requirement_id: BUILD_ID,
    input_digest: DIGEST_A,
    parameter_digest: DIGEST_A,
    implementation_digest: DIGEST_A,
    dataset_revision_id: `dsrev_${"d".repeat(64)}`,
    input_asset_ids: ["asset_1", "asset_2"],
    upstream_result_manifest_ids: ["manifest-up-1"],
    output_files: [{ relative_path: "out/table.csv", size_bytes: 100, sha256: DIGEST_A }],
    primary_keys: ["sample_id", "gene_id"],
    assessment: {
      product_status: "publishable",
      scores: [{ dimension: "schema", score: 1, satisfied: 2, required: 2 }],
      blockers: [],
    },
    provenance: {
      source_receipt_ids: ["receipt-geo-1"],
      locators: ["geo:GSE1"],
      retrieved_at: "2026-01-01T00:00:00.000Z",
      transform_digest: DIGEST_A,
    },
    ...overrides,
  };
}

function resolution(overrides: Partial<ShadowRunResolution> = {}): ShadowRunResolution {
  return {
    manifest: manifest(),
    artifact_root: LEGACY_ROOT,
    host_receipt: { receipt_id: "receipt-host-1", receipt_digest: DIGEST_A },
    ...overrides,
  };
}

function resolvingInput(
  legacyResolution: ShadowRunResolution,
  hostResolution: ShadowRunResolution,
  overrides: Partial<CompareSelectedShadowRunsInput> = {},
): CompareSelectedShadowRunsInput {
  return {
    task_id: TASK_ID,
    requirement_id: BUILD_ID,
    legacy: LEGACY,
    host: HOST,
    resolve_run: async (selection) =>
      selection.manifest_id === LEGACY.manifest_id ? legacyResolution : hostResolution,
    recompute_declared_bytes: async () => ({ sha256: DIGEST_A, size_bytes: 100 }),
    now: () => new Date(FIXED_NOW),
    ...overrides,
  };
}

function matchingInput(): CompareSelectedShadowRunsInput {
  return resolvingInput(
    resolution(),
    resolution({
      manifest: hostManifest(),
      artifact_root: HOST_ROOT,
      host_receipt: { receipt_id: "receipt-host-2", receipt_digest: DIGEST_A },
    }),
  );
}

function mismatchCodes(report: ShadowEvidenceReport): ShadowBlockingMismatchCode[] {
  return report.blocking_mismatches.map((mismatch) => mismatch.code);
}

describe("D-E2 Core-owned shadow evidence gate", () => {
  it("verifies two matching shadow runs with recomputed byte parity", async () => {
    const report = await compareSelectedShadowRuns(matchingInput());
    expect(report.verdict).toBe("verified");
    expect(report.shadow_verified).toBe(true);
    expect(report.not_ready_reason).toBeNull();
    expect(report.blocking_mismatches).toEqual([]);
    expect(report.closure).toEqual({
      input_digest_equal: true,
      parameter_digest_equal: true,
      implementation_digest_equal: true,
      dataset_revision_equal: true,
      input_assets_equal: true,
      upstream_results_equal: true,
    });
    expect(report.primary_keys_preserved).toBe(true);
    expect(report.assessment_match).toBe(true);
    expect(report.provenance_match).toBe(true);
    expect(report.digest_comparisons).toEqual([
      {
        relative_path: "out/table.csv",
        status: "equal",
        legacy: { relative_path: "out/table.csv", sha256: DIGEST_A, size_bytes: 100, digest_status: "recomputed" },
        host: { relative_path: "out/table.csv", sha256: DIGEST_A, size_bytes: 100, digest_status: "recomputed" },
      },
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("returns not_ready with no shadow_verified when a receipt is missing or the Host is unavailable", async () => {
    const missingReceipt = await compareSelectedShadowRuns(
      resolvingInput(resolution(), resolution({ manifest: hostManifest(), host_receipt: null })),
    );
    expect(missingReceipt.verdict).toBe("not_ready");
    expect(missingReceipt.not_ready_reason).toBe("receipt_missing");
    expect(missingReceipt.shadow_verified).toBe(false);
    expect(missingReceipt.blocking_mismatches).toEqual([]);

    const hostDown = await compareSelectedShadowRuns(
      resolvingInput(resolution(), resolution({ manifest: hostManifest() }), {
        resolve_run: async () => {
          throw new Error("host transport down");
        },
      }),
    );
    expect(hostDown.verdict).toBe("not_ready");
    expect(hostDown.not_ready_reason).toBe("host_unavailable");
    expect(hostDown.shadow_verified).toBe(false);
  });

  it("blocks a cross-run resolution whose manifest identity does not match the selection", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution({ manifest: manifest({ run_id: "run-other" }) }),
        resolution({
          manifest: hostManifest({ attempt: 2 }),
          artifact_root: HOST_ROOT,
        }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(mismatchCodes(report)).toEqual(["cross_run_mismatch", "cross_run_mismatch"]);
  });

  it("blocks byte tamper when declared bytes differ from recomputed bytes", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution({
          manifest: manifest({
            output_files: [{ relative_path: "out/table.csv", size_bytes: 100, sha256: DIGEST_B }],
          }),
        }),
        resolution({ manifest: hostManifest(), artifact_root: HOST_ROOT }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(mismatchCodes(report)).toContain("byte_tamper");
  });

  it("blocks shadow runs that resolve to the same output root", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution(),
        resolution({ manifest: hostManifest(), artifact_root: LEGACY_ROOT }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(mismatchCodes(report)).toContain("same_output_root");
  });

  it("blocks an input closure mismatch (parameter/implementation/dataset_revision)", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution(),
        resolution({
          manifest: hostManifest({ parameter_digest: DIGEST_B }),
          artifact_root: HOST_ROOT,
        }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(mismatchCodes(report)).toContain("input_closure_mismatch");
    expect(report.closure?.parameter_digest_equal).toBe(false);
  });

  it("blocks a reversed declared PK/tuple column order", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution(),
        resolution({ manifest: hostManifest({ primary_keys: ["gene_id", "sample_id"] }), artifact_root: HOST_ROOT }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(report.primary_keys_preserved).toBe(false);
    const pkMismatch = report.blocking_mismatches.find(
      (mismatch) => mismatch.code === "primary_key_order_mismatch",
    );
    expect(pkMismatch?.detail).toContain("reversed");
  });

  it("blocks an assessment scores mismatch", async () => {
    const report = await compareSelectedShadowRuns(
      resolvingInput(
        resolution(),
        resolution({
          manifest: hostManifest({
            assessment: {
              product_status: "publishable",
              scores: [{ dimension: "schema", score: 0.5, satisfied: 1, required: 2 }],
              blockers: [],
            },
          }),
          artifact_root: HOST_ROOT,
        }),
      ),
    );
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    expect(report.assessment_match).toBe(false);
    expect(mismatchCodes(report)).toContain("assessment_scores_mismatch");
  });

  it("never falls back to reported parity: declared_only digests are never equal or trusted, and identical inputs are deterministic", async () => {
    const noRecompute = resolvingInput(
      resolution(),
      resolution({ manifest: hostManifest(), artifact_root: HOST_ROOT }),
      { recompute_declared_bytes: null },
    );
    const report = await compareSelectedShadowRuns(noRecompute);
    expect(report.verdict).toBe("mismatch");
    expect(report.shadow_verified).toBe(false);
    // Both sides declare the same digest string, yet the comparison is
    // declared_only, never equal, and the shadow is not trusted.
    expect(report.digest_comparisons).toEqual([
      {
        relative_path: "out/table.csv",
        status: "declared_only",
        legacy: { relative_path: "out/table.csv", sha256: DIGEST_A, size_bytes: 100, digest_status: "declared_only" },
        host: { relative_path: "out/table.csv", sha256: DIGEST_A, size_bytes: 100, digest_status: "declared_only" },
      },
    ]);
    expect(mismatchCodes(report)).toContain("byte_parity_unverifiable");

    const again = await compareSelectedShadowRuns(noRecompute);
    expect(again).toEqual(report);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("exposes no publication or OperationResult semantics", async () => {
    const runtimeExports = Object.keys(gateModule);
    expect(runtimeExports).toContain("compareSelectedShadowRuns");
    expect(
      runtimeExports.filter((name) => /publication|operation_result|activated/i.test(name)),
    ).toEqual([]);

    const reports = [
      await compareSelectedShadowRuns(matchingInput()),
      await compareSelectedShadowRuns(
        resolvingInput(resolution(), resolution({ manifest: hostManifest(), host_receipt: null })),
      ),
      await compareSelectedShadowRuns(
        resolvingInput(
          resolution(),
          resolution({ manifest: hostManifest({ parameter_digest: DIGEST_B }), artifact_root: HOST_ROOT }),
        ),
      ),
    ];
    for (const report of reports) {
      expect(report.report_kind).toBe("shadow_evidence");
      const keys = Object.keys(report);
      expect(keys).not.toContain("publication");
      expect(keys).not.toContain("operation_result");
      expect(keys).not.toContain("activated");
      expect(report.shadow_verified).toBe(report.verdict === "verified");
    }
  });
});
