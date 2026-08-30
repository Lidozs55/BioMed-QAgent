import { describe, expect, it } from "vitest";

import { parseCleaningRuleProposal } from "@biomed/contracts";

import { parseNormalizationProfile } from "../src/dataset/contracts/profiles.js";
import { preflightCleaningRules } from "../src/dataset/cleaning/preflight.js";
import { rankMappingCandidates } from "../src/dataset/cleaning/string-similarity.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";

describe("cleaning autonomy primitives", () => {
  it("ranks candidates deterministically and keeps near ties ambiguous", () => {
    const first = rankMappingCandidates(["sample_id"], ["sample_id_a", "sample_id_b"]);
    const second = rankMappingCandidates(["sample_id"], ["sample_id_b", "sample_id_a"]);

    expect(first).toEqual(second);
    expect(first.states.sample_id).toBe("ambiguous");
    expect(first.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects proposals that try to carry approval state or unknown fields", () => {
    expect(() => parseCleaningRuleProposal({
      kind: "unit_conversion",
      proposal_id: "unit_1",
      binding_id: "binding_1",
      from_unit: "counts",
      to_unit: "tpm",
      factor: 1,
      offset: 0,
      evidence: "source documentation",
      accepted: true,
    })).toThrow(/unknown fields/);
  });

  it("rejects duplicate or out-of-whitelist registered unit routes", () => {
    const base = {
      profile_id: "gene_expression.normalization.test",
      dataset_family: "gene_expression",
      allowed_namespaces: ["gene_symbol"],
      allowed_units: ["tpm"],
      allowed_semantics: ["expression_value"],
      allowed_value_scales: ["linear"],
      aggregation_policy: "keep_all",
      description: "test",
    };
    expect(() => parseNormalizationProfile({
      ...base,
      unit_conversions: [
        { rule_id: "r1", from_unit: "counts", to_unit: "tpm", formula: "value", evidence: "test" },
        { rule_id: "r1", from_unit: "counts", to_unit: "tpm", formula: "value", evidence: "test" },
      ],
    })).toThrow(/duplicate rule_id/);
    expect(() => parseNormalizationProfile({
      ...base,
      unit_conversions: [
        { rule_id: "r1", from_unit: "counts", to_unit: "fpkm", formula: "value", evidence: "test" },
      ],
    })).toThrow(/outside allowed_units/);
  });

  it("keeps similarity-only mappings in HIL instead of auto-accepting them", () => {
    const result = preflightCleaningRules(createDefaultDatasetFamilyRegistry(), [{
      kind: "field_mapping",
      proposal_id: "mapping_1",
      binding_id: "binding_1",
      source_schema_ref: "gene_expression.long.v1",
      target_schema_ref: "gene_expression.long.v1",
      source_field: "sample_id",
      target_field: "sample_identifier",
      transform: "identity",
      candidate_set_digest: null,
      evidence: "column-name similarity",
    }]);
    expect(result.items[0]).toMatchObject({
      decision: "needs_hil",
      rule_id: null,
    });
  });
});
