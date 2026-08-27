import { describe, expect, it } from "vitest";
import type { FamilySpec, OperationResultManifest, Projection } from "@biomed/contracts";
import { materializeBrowserIntegratedFamily } from "../src/dataset/acquisition/browser-family-materialization.js";

function result(tableId: string): OperationResultManifest {
  const digest = tableId.padEnd(64, "0");
  return {
    schema_version: "1.0", result_manifest_id: `result_${tableId}`, task_id: "task_family", run_id: "run_family", requirement_id: "build_family",
    operation_id: `integrate_${tableId}`, operation_kind: "integrate", operation_attempt_id: `attempt_${tableId}`, attempt: 1,
    status: "succeeded", input_digest: "a".repeat(64), parameter_digest: "b".repeat(64), implementation_digest: "c".repeat(64),
    output_digest: digest, output_kind: "integrated_table",
    output_summary: { table_id: tableId, dataset_family: "family_browser", row_granularity: "row", schema_ref: `schema.${tableId}`, row_count: 1, column_count: 1, primary_file_sha256: digest },
    output_files: [{ relative_path: `tables/${tableId}.csv`, size_bytes: 2, sha256: digest }],
    dependency_closure: { input_asset_ids: [`asset_${digest}`], upstream_result_manifest_ids: [], parameter_digest: "b".repeat(64), implementation_digest: "c".repeat(64) },
    commit: { state: "committed", commit_id: `commit_${tableId}`, committed_at: "2026-08-24T00:00:00Z" },
  };
}

const projection = { primary_tables: ["one", "two"], supporting_tables: [], derived_tables: [], required: ["one", "two"], optional: [], allow_empty: [], relations: [], row_granularity: "row", projection_id: "p", schema_version: "2.0", compatibility_dimensions: [], merge_identity_fields: [], validation_policy_ref: "v", assessment_policy_ref: "a" } as Projection;
const familySpec = { family_spec_id: "family_browser", semantic_version: "2.0.0", canonical_digest: "a".repeat(64), projections: [projection], table_definitions: [{ table_id: "one", schema_ref: "schema.one", role: "primary", required: true, allow_empty: false, primary_key: ["id"], field_names: ["id"] }, { table_id: "two", schema_ref: "schema.two", role: "primary", required: true, allow_empty: false, primary_key: ["id"], field_names: ["id"] }], relations: [], identity: { dataset_id_scheme: "ds_hash", dataset_revision_id_scheme: "dsrev_hash", asset_id_scheme: "asset_sha256", sample_identity_fields: [], probe_mapping_assertion_pk: "id" }, transform_capability_refs: [], declared_outputs: [{ table_id: "one", schema_ref: "schema.one" }, { table_id: "two", schema_ref: "schema.two" }], integration_policy_ref: "i", validation_policy_ref: "v", assessment_policy_ref: "a", resource_class_request: "small", scope: "task", author: "test", evidence_refs: [] } as FamilySpec;

describe("materializeBrowserIntegratedFamily", () => {
  it("fails closed when a projection-selected table is missing", async () => {
    await expect(materializeBrowserIntegratedFamily({ taskId: "task_family", requirementId: "build_family", familySpec, projection, tableOutputs: { one: { data: result("one"), provenance: [result("one_provenance")], confidence: [result("one_confidence")], audit: [] } } })).rejects.toThrow("missing selected table");
  });
});
