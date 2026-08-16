import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseConfidenceComponents,
  parseConfidenceRecord,
} from "../src/dataset/contracts/data.js";
import {
  evaluateConfidence,
  mappingConfidence,
  requiresHumanReview,
} from "../src/dataset/confidence/evaluator.js";
import {
  CONFIDENCE_ARTIFACT_FILE,
  readConfidenceArtifact,
  writeConfidenceArtifact,
} from "../src/dataset/confidence/artifact.js";
import { buildConfidenceSummary } from "../src/dataset/publish/manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence confidence contracts and evaluator", () => {
  it("uses fixed component enums and keeps validation out of confidence", () => {
    expect(parseConfidenceComponents({})).toEqual({
      schema_version: "1.0",
      source_reliability: "not_applicable",
      extraction_reliability: "not_applicable",
      mapping_reliability: "not_applicable",
      cross_source_consistency: "not_checked",
      human_review_state: "not_required",
    });
    expect(() =>
      parseConfidenceComponents({ validation_status: "passed" }),
    ).toThrow(/unknown fields/);
    expect(() =>
      parseConfidenceComponents({ cross_source_consistency: "same_upstream_confirmed" }),
    ).toThrow(/cross_source_consistency/);
  });

  it("derives review requirement instead of accepting an adapter boolean", () => {
    const record = parseConfidenceRecord({
      confidence_id: "confidence_1",
      batch_id: "batch_1",
      record_id: "row_1",
      level: "low",
      channel: "vlm",
      components: {
        source_reliability: "medium",
        extraction_reliability: "low",
        mapping_reliability: "high",
        cross_source_consistency: "not_checked",
        human_review_state: "pending",
      },
      reasons: ["image label is ambiguous"],
    });
    expect(requiresHumanReview(record)).toBe(true);
    expect(() =>
      parseConfidenceRecord({ ...record, requires_human_review: false }),
    ).toThrow(/unknown fields/);
  });

  it("applies weakest-link and explicit nondeterministic caps", () => {
    expect(
      evaluateConfidence({
        confidence_id: "confidence_low",
        batch_id: "batch_1",
        record_id: "row_low",
        channel: "official_api",
        components: {
          source_reliability: "high",
          extraction_reliability: "high",
          mapping_reliability: "low",
          cross_source_consistency: "not_checked",
          human_review_state: "pending",
        },
      }).level,
    ).toBe("low");

    const vlm = evaluateConfidence({
      confidence_id: "confidence_vlm",
      batch_id: "batch_1",
      record_id: "row_vlm",
      channel: "vlm",
      components: {
        source_reliability: "high",
        extraction_reliability: "high",
        mapping_reliability: "high",
        cross_source_consistency: "consistent",
        human_review_state: "accepted",
      },
    });
    expect(vlm.level).toBe("medium");
    expect(vlm.reasons).toContain("vlm extraction is capped at medium");
  });

  it("does not upgrade weak evidence when a user accepts it", () => {
    const pending = evaluateConfidence({
      confidence_id: "confidence_pending",
      batch_id: "batch_1",
      record_id: "row_1",
      channel: "vlm",
      components: {
        source_reliability: "medium",
        extraction_reliability: "low",
        mapping_reliability: "high",
        cross_source_consistency: "not_checked",
        human_review_state: "pending",
      },
    });
    const accepted = evaluateConfidence({
      ...pending,
      components: { ...pending.components, human_review_state: "accepted" },
    });
    expect(accepted.level).toBe("low");
    expect(requiresHumanReview(accepted)).toBe(false);
  });

  it("derives mapping reliability and review state from declared mappings", () => {
    expect(
      mappingConfidence([
        {
          mapping_method: "curated",
          confidence_level: "high",
          review_status: "accepted",
        },
        {
          mapping_method: "string_similarity",
          confidence_level: "medium",
          review_status: "proposed",
        },
      ]),
    ).toEqual({
      reliability: "low",
      human_review_state: "pending",
      reasons: ["proposed string-similarity mapping requires human review"],
    });
  });

  it("stores one batch default plus sparse record overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "confidence-artifact-"));
    roots.push(root);
    const target = await writeConfidenceArtifact(root, {
      schema_version: "1.0",
      batch_defaults: [
        {
          batch_id: "batch_1",
          record_count: 10,
          level: "high",
          channel: "official_api",
          components: {
            source_reliability: "high",
            extraction_reliability: "high",
            mapping_reliability: "high",
            cross_source_consistency: "not_checked",
            human_review_state: "not_required",
          },
          reasons: [],
        },
      ],
      record_overrides: [
        evaluateConfidence({
          confidence_id: "confidence_override",
          batch_id: "batch_1",
          record_id: "row_7",
          channel: "official_api",
          components: {
            source_reliability: "high",
            extraction_reliability: "medium",
            mapping_reliability: "high",
            cross_source_consistency: "not_checked",
            human_review_state: "not_required",
          },
        }),
      ],
    });
    expect(path.basename(target)).toBe(CONFIDENCE_ARTIFACT_FILE);
    await expect(readConfidenceArtifact(root)).resolves.toMatchObject({
      batch_defaults: [{ batch_id: "batch_1", level: "high" }],
      record_overrides: [{ record_id: "row_7", level: "medium" }],
    });
    await expect(buildConfidenceSummary(root)).resolves.toMatchObject({
      level_distribution: { high: 9, medium: 1, low: 0 },
      human_review_distribution: { not_required: 10 },
      batch_default_count: 1,
      record_override_count: 1,
      evidence_report_file: CONFIDENCE_ARTIFACT_FILE,
    });
  });
});
