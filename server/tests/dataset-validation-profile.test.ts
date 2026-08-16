import { describe, expect, it } from "vitest";

import {
  parseConfidenceGatePolicy,
  parseValidationProfile,
} from "../src/dataset/contracts/profiles.js";
import type { ConfidenceArtifact } from "../src/dataset/confidence/artifact.js";
import { evaluateConfidenceGate } from "../src/dataset/validation/profile.js";

const policy = parseConfidenceGatePolicy({
  block_pending_human_review: true,
  required_fields_min_level: "medium",
  allow_low_confidence_primary: false,
  max_low_confidence_fraction: 0,
  require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"],
});

function artifact(options: {
  level?: "high" | "medium" | "low";
  channel?: string;
  review?: "not_required" | "pending" | "accepted" | "corrected" | "rejected";
  count?: number;
} = {}): ConfidenceArtifact {
  return {
    schema_version: "1.0",
    batch_defaults: [{
      batch_id: "batch_1",
      record_count: options.count ?? 10,
      level: options.level ?? "high",
      channel: options.channel ?? "official_api",
      components: {
        source_reliability: "high",
        extraction_reliability: options.level ?? "high",
        mapping_reliability: "high",
        cross_source_consistency: "not_checked",
        human_review_state: options.review ?? "not_required",
      },
      reasons: [],
    }],
    record_overrides: [],
  };
}

describe("profile-owned confidence gates", () => {
  it("parses a strict confidence gate policy in ValidationProfile", () => {
    expect(
      parseValidationProfile({
        profile_id: "test.release.v1",
        dataset_family: "test",
        acceptance: {},
        description: "test",
        required_entity_level: "any",
        confidence_gate: policy,
      }).confidence_gate,
    ).toEqual(policy);
    expect(() =>
      parseConfidenceGatePolicy({ ...policy, max_low_confidence_fraction: 1.5 }),
    ).toThrow(/between 0 and 1/);
  });

  it("blocks unresolved review and low-confidence primary records", () => {
    expect(evaluateConfidenceGate(policy, artifact({ level: "low", review: "pending" }))).toMatchObject({
      passed: false,
      pending_count: 10,
      low_fraction: 1,
    });
  });

  it("requires nondeterministic channels to be reviewed", () => {
    expect(
      evaluateConfidenceGate(policy, artifact({ channel: "vlm", level: "medium" })),
    ).toMatchObject({ passed: false, unreviewed_required_channel_count: 10 });
    expect(
      evaluateConfidenceGate(
        policy,
        artifact({ channel: "vlm", level: "medium", review: "accepted" }),
      ),
    ).toMatchObject({ passed: true });
  });

  it("enforces configured low-confidence fraction independently of review", () => {
    const permissive = parseConfidenceGatePolicy({
      ...policy,
      required_fields_min_level: "low",
      allow_low_confidence_primary: true,
      max_low_confidence_fraction: 0.25,
    });
    expect(evaluateConfidenceGate(permissive, artifact({ level: "low", count: 4 }))).toMatchObject({
      passed: false,
      low_fraction: 1,
    });
  });
});
