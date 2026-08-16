import { describe, expect, it } from "vitest";

import type { HumanReviewRecord } from "@biomed/contracts";

import { parseDataBatch } from "../src/dataset/contracts/data.js";
import { parseNormalizationProfile } from "../src/dataset/contracts/profiles.js";
import { expressionNormalizationV1 } from "../src/dataset/canonicalizer/profiles.js";
import {
  reviewBatchForHIL,
  type DatasetHILGate,
} from "../src/dataset/review/hil-policy.js";
import { buildHumanCorrectionProvenance } from "../src/dataset/publish/manifest.js";

function batch(options: { proposed?: boolean; unit?: string } = {}) {
  return parseDataBatch({
    batch_id: "batch_1",
    binding_id: "binding_1",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample",
    schema_ref: "gene_expression.long.v1",
    file_asset: null,
    row_count: 3,
    column_count: 4,
    parser_id: "fixture",
    parser_version: "1.0.0",
    statistics: { expression_unit: options.unit ?? "tpm" },
    warnings: [],
    declared_mappings: [
      {
        mapping_id: "map_gene",
        source_schema_ref: "source.v1",
        target_schema_ref: "gene_expression.long.v1",
        source_field: "Gene Symbol",
        target_field: "gene_id",
        transform: "identity",
        mapping_method: options.proposed ? "string_similarity" : "adapter_declared",
        confidence_level: options.proposed ? "low" : "high",
        evidence: "fixture evidence",
        review_status: options.proposed ? "proposed" : "accepted",
      },
    ],
  });
}

function gate(decisions: HumanReviewRecord["decision"][]): {
  gate: DatasetHILGate;
  requests: Array<{ review_type: string | null; review_items: unknown[] }>;
} {
  const requests: Array<{ review_type: string | null; review_items: unknown[] }> = [];
  let index = 0;
  return {
    requests,
    gate: {
      requestHIL: async (input) => {
        requests.push({
          review_type: input.review_type,
          review_items: input.review_items,
        });
        const decision = decisions[index++];
        if (decision === undefined) throw new Error("missing fixture decision");
        return {
          schema_version: "1.0",
          review_id: `review_${index}`,
          request_id: `request_${index}`,
          decision,
          reviewer: "user",
          reviewed_at: "2026-08-16T01:00:00.000Z",
          evidence_digest: "a".repeat(64),
          reason: null,
        };
      },
    },
  };
}

describe("Dataset Core HIL policy", () => {
  it("batches proposed mappings and records explicit human approval", async () => {
    const fixture = gate([{ action: "accept" }]);
    const reviewed = await reviewBatchForHIL({
      batch: batch({ proposed: true }),
      profile: expressionNormalizationV1(),
      gate: fixture.gate,
      buildId: "build_1",
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      review_type: "field_mapping",
      review_items: [{ item_id: "map_gene", confidence_level: "low" }],
    });
    expect(reviewed.batch.declared_mappings[0]).toMatchObject({
      mapping_method: "human_approved",
      review_status: "accepted",
      confidence_level: "low",
    });
    expect(reviewed.batch.declared_mappings[0]?.evidence).toContain("human review");
    expect(reviewed.batch.statistics.mapping_human_review_state).toBe("accepted");
  });

  it("records mapping corrections with their original and corrected values", async () => {
    const fixture = gate([{
      action: "correct",
      correction: {
        mappings: {
          map_gene: { target_field: "gene_symbol", transform: "trim" },
        },
      },
    }]);
    const reviewed = await reviewBatchForHIL({
      batch: batch({ proposed: true }),
      profile: expressionNormalizationV1(),
      gate: fixture.gate,
      buildId: "build_1",
    });

    expect(reviewed.batch.statistics.mapping_human_review_state).toBe("corrected");
    expect(reviewed.batch.statistics.human_mapping_corrections).toEqual([{
      mapping_id: "map_gene",
      review_id: "review_1",
      original: { target_field: "gene_id", transform: "identity" },
      corrected: { target_field: "gene_symbol", transform: "trim" },
    }]);
    expect(buildHumanCorrectionProvenance([{
      batch: reviewed.batch,
      canonicalPath: "canonical.csv",
      rowCount: 3,
      rejectedCount: 0,
      namespaces: ["gene_symbol"],
      auditPaths: [],
    }])).toMatchObject({
      human_corrections: [{
        kind: "field_mapping",
        mapping_id: "map_gene",
        original: { target_field: "gene_id", transform: "identity" },
        corrected: { target_field: "gene_symbol", transform: "trim" },
      }],
      transform_records: [{
        method: "human_correction",
        input: { target_field: "gene_id", transform: "identity" },
        output: { target_field: "gene_symbol", transform: "trim" },
      }],
    });
  });

  it("accepts only structured finite linear unit corrections", async () => {
    const fixture = gate([
      {
        action: "correct",
        correction: {
          unit_conversion: {
            from_unit: "counts_per_thousand",
            to_unit: "tpm",
            factor: 0.001,
            offset: 0,
            evidence: "Reviewer confirmed the source documentation",
          },
        },
      },
    ]);
    const reviewed = await reviewBatchForHIL({
      batch: batch({ unit: "counts_per_thousand" }),
      profile: expressionNormalizationV1(),
      gate: fixture.gate,
      buildId: "build_1",
    });
    expect(fixture.requests[0]?.review_type).toBe("unit_conversion");
    expect(reviewed.unitCorrection).toEqual({
      method: "human_correction",
      rule_id: null,
      from_unit: "counts_per_thousand",
      to_unit: "tpm",
      factor: 0.001,
      offset: 0,
      evidence: "Reviewer confirmed the source documentation",
      review_id: "review_1",
    });
    expect(reviewed.batch.statistics.human_unit_correction).toMatchObject({
      to_unit: "tpm",
    });
  });

  it("applies a registered deterministic unit rule without opening HIL", async () => {
    const profile = parseNormalizationProfile({
      ...expressionNormalizationV1(),
      unit_conversions: [{
        rule_id: "counts_per_thousand_to_tpm",
        from_unit: "counts_per_thousand",
        to_unit: "tpm",
        formula: "value * 0.001",
        evidence: "Curated provider specification",
      }],
    });
    const reviewed = await reviewBatchForHIL({
      batch: batch({ unit: "counts_per_thousand" }),
      profile,
      gate: null,
      buildId: "build_1",
    });

    expect(reviewed.unitCorrection).toEqual({
      method: "registered_rule",
      rule_id: "counts_per_thousand_to_tpm",
      from_unit: "counts_per_thousand",
      to_unit: "tpm",
      factor: 0.001,
      offset: 0,
      evidence: "Curated provider specification",
      review_id: null,
    });
    expect(reviewed.batch.statistics.registered_unit_conversion).toMatchObject({
      rule_id: "counts_per_thousand_to_tpm",
    });
  });

  it("fails closed when a registered unit formula is not a safe linear rule", async () => {
    const profile = parseNormalizationProfile({
      ...expressionNormalizationV1(),
      unit_conversions: [{
        rule_id: "unsafe",
        from_unit: "mystery",
        to_unit: "tpm",
        formula: "model(value)",
        evidence: "Bad fixture",
      }],
    });
    await expect(reviewBatchForHIL({
      batch: batch({ unit: "mystery" }),
      profile,
      gate: null,
      buildId: "build_1",
    })).rejects.toThrow(/safe linear formula/);
  });

  it("rejects arbitrary or non-finite unit correction formulas", async () => {
    const fixture = gate([
      {
        action: "correct",
        correction: {
          unit_conversion: {
            from_unit: "mystery",
            to_unit: "tpm",
            factor: "value * model_guess",
            offset: 0,
            evidence: "guess",
          },
        },
      },
    ]);
    await expect(
      reviewBatchForHIL({
        batch: batch({ unit: "mystery" }),
        profile: expressionNormalizationV1(),
        gate: fixture.gate,
        buildId: "build_1",
      }),
    ).rejects.toThrow(/finite number/);
  });

  it("does not admit rejected or skipped candidates", async () => {
    const fixture = gate([{ action: "skip" }]);
    await expect(
      reviewBatchForHIL({
        batch: batch({ proposed: true }),
        profile: expressionNormalizationV1(),
        gate: fixture.gate,
        buildId: "build_1",
      }),
    ).rejects.toThrow(/skipped/);
  });
});
