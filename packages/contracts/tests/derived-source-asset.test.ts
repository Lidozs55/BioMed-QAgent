import { describe, expect, it } from "vitest";

import { parseCoreDerivedAssetProvenance } from "../src/index.js";

const DIGEST = "a".repeat(64);

function provenance() {
  return {
    schema_version: "1.0",
    task_id: "task_1",
    asset_id: `asset_${DIGEST}`,
    parent_asset_ids: [`asset_${"b".repeat(64)}`],
    operation_kind: "vlm_extraction",
    operation_result_id: "result_vlm_1",
    implementation_id: "dataset_core.chart_vlm_evidence",
    implementation_version: "1.0.0",
    parameters_digest: "c".repeat(64),
    output_digest: DIGEST,
    evidence: {
      model_name: "qwen-vl-max",
      model_version: "qwen-vl-max",
      prompt_digest: "d".repeat(64),
      bbox: [0, 0, 1, 1],
      confidence: "low",
      review_id: "review_1",
    },
    created_at: "2026-08-28T00:00:00.000Z",
  };
}

describe("Core derived SourceAsset provenance contract", () => {
  it("binds the output asset digest and preserves operation evidence", () => {
    expect(parseCoreDerivedAssetProvenance(provenance())).toMatchObject({
      operation_kind: "vlm_extraction",
      operation_result_id: "result_vlm_1",
      evidence: { confidence: "low", review_id: "review_1" },
    });
  });

  it("rejects unknown fields, digest drift, duplicate parents, and unknown operations", () => {
    expect(() => parseCoreDerivedAssetProvenance({ ...provenance(), extra: true })).toThrow();
    expect(() => parseCoreDerivedAssetProvenance({ ...provenance(), output_digest: "e".repeat(64) })).toThrow(/asset_id/);
    expect(() => parseCoreDerivedAssetProvenance({
      ...provenance(),
      parent_asset_ids: [provenance().parent_asset_ids[0], provenance().parent_asset_ids[0]],
    })).toThrow(/unique/);
    expect(() => parseCoreDerivedAssetProvenance({ ...provenance(), operation_kind: "workspace_copy" })).toThrow();
  });
});
