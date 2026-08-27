import { describe, expect, it } from "vitest";
import type { Projection, FamilySpec } from "@biomed/contracts";
import type { DynamicFamilyTableOutputs } from "../src/dataset/dynamic-family/index.js";
import { createBrowserPublicationHandoff } from "../src/dataset/acquisition/browser-publication-handoff.js";

function output(tableId: string): DynamicFamilyTableOutputs {
  const digest = "a".repeat(64);
  const data = {
    schema_version: "1.0", result_manifest_id: `result_${tableId}`, task_id: "task", run_id: "run", requirement_id: "build", operation_id: `op_${tableId}`, operation_kind: "integrate", operation_attempt_id: `attempt_${tableId}`, attempt: 1, status: "succeeded", input_digest: digest, parameter_digest: digest, implementation_digest: digest, output_digest: digest, output_kind: "integrated_table",
    output_summary: { table_id: tableId, dataset_family: "family", row_granularity: "row", schema_ref: `schema.${tableId}`, row_count: 1, column_count: 1, primary_file_sha256: digest }, output_files: [{ relative_path: `tables/${tableId}.csv`, size_bytes: 2, sha256: digest }], dependency_closure: { input_asset_ids: ["asset"], upstream_result_manifest_ids: [], parameter_digest: digest, implementation_digest: digest }, commit: { state: "committed", commit_id: `commit_${tableId}`, committed_at: "2026-08-24T00:00:00Z" },
  } as DynamicFamilyTableOutputs["data"];
  return { data, provenance: [data], confidence: [data], audit: [] };
}

const projection = { primary_tables: ["one"], supporting_tables: [], derived_tables: [], projection_id: "projection", schema_version: "2.0" } as unknown as Projection;
const acceptance = { requestId: "hil_browser", reviewId: "review_browser", hilEvidenceDigest: "b".repeat(64), acceptedBrowserEvidenceDigests: ["a".repeat(64)], reviewer: "user" as const, reviewedAt: "2026-08-24T00:00:00Z", reason: null };

describe("createBrowserPublicationHandoff", () => {
  it("accepts a closed browser table handoff", () => {
    const table = output("one");
    const handoff = createBrowserPublicationHandoff({ taskId: "task", runId: "run", requirementId: "build", generation: 1, familySpec: {} as FamilySpec, projection, preflightReceipt: {} as never, tableOutputs: { one: table }, integratedResults: [table.data], sourceAcquisitionProvenance: [{} as never], browserEvidenceDigests: ["a".repeat(64)], browserEvidenceAcceptance: acceptance, trustedRoot: "D:/trusted" });
    expect(handoff.kind).toBe("browser_publication_handoff");
  });

  it("rejects missing browser evidence", () => {
    const table = output("one");
    expect(() => createBrowserPublicationHandoff({ taskId: "task", runId: "run", requirementId: "build", generation: 1, familySpec: {} as FamilySpec, projection, preflightReceipt: {} as never, tableOutputs: { one: table }, integratedResults: [table.data], sourceAcquisitionProvenance: [{} as never], browserEvidenceDigests: [], browserEvidenceAcceptance: acceptance, trustedRoot: "D:/trusted" })).toThrow("evidence digests");
  });

  it("rejects an acceptance that does not cover the publication evidence", () => {
    const table = output("one");
    expect(() => createBrowserPublicationHandoff({ taskId: "task", runId: "run", requirementId: "build", generation: 1, familySpec: {} as FamilySpec, projection, preflightReceipt: {} as never, tableOutputs: { one: table }, integratedResults: [table.data], sourceAcquisitionProvenance: [{} as never], browserEvidenceDigests: ["c".repeat(64)], browserEvidenceAcceptance: acceptance, trustedRoot: "D:/trusted" })).toThrow("does not cover");
  });
});
