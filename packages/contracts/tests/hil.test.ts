import { describe, expect, it } from "vitest";

import {
  parseHILDecision,
  parseHILRequest,
  parseHumanReviewRecord,
  parseResumeHILInput,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

describe("durable HIL contracts", () => {
  it("parses a batched semantic review request", () => {
    expect(
      parseHILRequest({
        schema_version: "1.0",
        request_id: "hil_123",
        task_id: "task_123",
        run_id: "run_123",
        build_id: "build_123",
        kind: "semantic_review",
        review_type: "field_mapping",
        status: "pending",
        blocking: true,
        subject: {
          binding_id: "binding_123",
          record_ids: ["row_1", "row_2"],
          mapping_ids: ["map_gene"],
          provenance_ids: ["prov_123"],
        },
        review_items: [
          {
            item_id: "map_gene",
            summary: "Review Gene Symbol mapping",
            subject: { mapping_ids: ["map_gene"] },
            evidence: { source_field: "Gene Symbol" },
            proposed_value: "gene_symbol",
            confidence_level: "low",
          },
        ],
        summary: "One field mapping requires review",
        evidence_digest: DIGEST,
        policy_ref: "dataset.field_mapping.v1",
        created_at: "2026-08-16T01:02:03.000Z",
        resolved_at: null,
      }),
    ).toMatchObject({
      kind: "semantic_review",
      review_type: "field_mapping",
      review_items: [{ item_id: "map_gene", confidence_level: "low" }],
    });
  });

  it("parses a publication-acceptance data review subject", () => {
    expect(parseHILRequest({
      schema_version: "1.0",
      request_id: "hil_publication",
      task_id: "task_123",
      run_id: "run_123",
      build_id: "build_123",
      kind: "data_review",
      review_type: "publication_acceptance",
      status: "pending",
      blocking: true,
      subject: {
        candidate_ids: ["candidate_123"],
        table_ids: ["activity_value_records", "chart_series"],
      },
      review_items: [],
      summary: "Review evidence-bound publication candidate",
      evidence_digest: DIGEST,
      policy_ref: "dynamic_family_hil_acceptance.v1",
      created_at: "2026-08-16T01:02:03.000Z",
      resolved_at: null,
    })).toMatchObject({
      review_type: "publication_acceptance",
      subject: { candidate_ids: ["candidate_123"], table_ids: ["activity_value_records", "chart_series"] },
    });
  });

  it.each([
    [{ action: "approve" }],
    [{ action: "accept" }],
    [{ action: "correct", correction: { map_gene: "gene_id" } }],
    [{ action: "reject" }],
    [{ action: "skip" }],
  ])("parses structured decision %j", (decision) => {
    expect(parseHILDecision(decision)).toEqual(decision);
  });

  it("normalizes legacy permission decisions without accepting legacy data corrections", () => {
    expect(parseHILDecision("approve", { allowLegacyPermission: true })).toEqual({
      action: "approve",
    });
    expect(() => parseHILDecision("approve")).toThrow();
  });

  it("requires correction content for correct and forbids it for other actions", () => {
    expect(() => parseHILDecision({ action: "correct" })).toThrow();
    expect(() =>
      parseHILDecision({ action: "accept", correction: "unexpected" }),
    ).toThrow();
  });

  it("parses evidence-bound resume input and immutable review records", () => {
    const decision = { action: "correct" as const, correction: { row_1: 42 } };
    expect(
      parseResumeHILInput({
        request_id: "hil_123",
        evidence_digest: DIGEST,
        decision,
        reason: "Read the value from the source image",
      }),
    ).toEqual({
      request_id: "hil_123",
      evidence_digest: DIGEST,
      decision,
      reason: "Read the value from the source image",
    });

    expect(
      parseHumanReviewRecord({
        schema_version: "1.0",
        review_id: "review_123",
        request_id: "hil_123",
        decision,
        reviewer: "user",
        reviewed_at: "2026-08-16T01:03:00.000Z",
        evidence_digest: DIGEST,
        reason: null,
      }),
    ).toMatchObject({ review_id: "review_123", reviewer: "user", decision });
  });

  it("rejects unknown review types and malformed evidence digests", () => {
    expect(() =>
      parseResumeHILInput({
        request_id: "hil_123",
        evidence_digest: "stale",
        decision: { action: "accept" },
      }),
    ).toThrow(/64-char hex/);

    expect(() =>
      parseHILRequest({
        request_id: "hil_123",
        task_id: "task_123",
        run_id: "run_123",
        build_id: null,
        kind: "semantic_review",
        review_type: "free_form_chat",
        status: "pending",
        blocking: true,
        subject: {},
        review_items: [],
        summary: "invalid",
        evidence_digest: DIGEST,
        policy_ref: "test",
        created_at: "2026-08-16T01:02:03.000Z",
        resolved_at: null,
      }),
    ).toThrow(/review_type/);
  });
});
