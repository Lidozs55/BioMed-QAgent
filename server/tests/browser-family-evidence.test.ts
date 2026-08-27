import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OperationResultManifest } from "@biomed/contracts";
import { createBrowserFamilyTableOutputs } from "../src/dataset/acquisition/browser-family-evidence.js";

function result(id: string, kind: "integrated_table" | "derived_evidence"): OperationResultManifest {
  const digest = "a".repeat(64);
  return {
    schema_version: "1.0", result_manifest_id: id, task_id: "task", run_id: "run", requirement_id: "build", operation_id: id, operation_kind: kind === "integrated_table" ? "integrate" : "derive", operation_attempt_id: `attempt_${id}`, attempt: 1, status: "succeeded", input_digest: digest, parameter_digest: digest, implementation_digest: digest, output_digest: digest, output_kind: kind,
    output_summary: { table_id: "one", dataset_family: "family", row_granularity: "row", schema_ref: "schema.one", row_count: 1, column_count: 1, primary_file_sha256: digest }, output_files: [{ relative_path: "tables/one.csv", size_bytes: 2, sha256: digest }], dependency_closure: { input_asset_ids: ["asset_one"], upstream_result_manifest_ids: [], parameter_digest: digest, implementation_digest: digest }, commit: { state: "committed", commit_id: `commit_${id}`, committed_at: "2026-08-24T00:00:00Z" },
  };
}

describe("createBrowserFamilyTableOutputs", () => {
  it("creates provenance and confidence manifests from source evidence", async () => {
    const out = await createBrowserFamilyTableOutputs({ taskId: "task", requirementId: "build", evidenceRoot: await mkdtemp(path.join(os.tmpdir(), "browser-evidence-")), implementationDigest: "b".repeat(64), integratedTables: { one: result("integrated_one", "integrated_table") }, sourceEvidenceByTable: { one: [result("source_one", "derived_evidence")] } });
    expect(out.one?.provenance).toHaveLength(1);
    expect(out.one?.confidence).toHaveLength(1);
    expect(out.one?.provenance[0]?.dependency_closure.upstream_result_manifest_ids).toContain("source_one");
  });

  it("rejects a table without source evidence", async () => {
    await expect(createBrowserFamilyTableOutputs({ taskId: "task", requirementId: "build", evidenceRoot: await mkdtemp(path.join(os.tmpdir(), "browser-evidence-")), implementationDigest: "b".repeat(64), integratedTables: { one: result("integrated_one", "integrated_table") }, sourceEvidenceByTable: {} })).rejects.toThrow("missing source evidence");
  });
});
