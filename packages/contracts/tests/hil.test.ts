import { describe, expect, it } from "vitest";

import {
  DEFAULT_HIL_APPROVAL_SETTINGS,
  HIL_HUMAN_MANDATORY_SCOPES,
  parseHILDecision,
  parseHILRequest,
  parseHumanReviewRecord,
  parseHilApprovalSettings,
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
        requirement_id: "build_123",
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

  it("parses a one-time browser evidence acceptance review", () => {
    expect(parseHILRequest({
      schema_version: "1.0",
      request_id: "hil_browser_acceptance",
      task_id: "task_123",
      run_id: "run_123",
      requirement_id: null,
      kind: "data_review",
      review_type: "browser_evidence_acceptance",
      status: "pending",
      blocking: true,
      subject: {
        evidence_ids: ["evidence_123"],
        source_asset_ids: ["asset_123"],
        table_ids: ["records"],
        locator_urls: ["https://example.org/records.tsv"],
      },
      review_items: [],
      summary: "Accept the exact browser evidence and build binding",
      evidence_digest: DIGEST,
      policy_ref: "browser.acquisition.evidence-acceptance.v1",
      created_at: "2026-08-25T00:00:00.000Z",
      resolved_at: null,
    })).toMatchObject({ review_type: "browser_evidence_acceptance", blocking: true });
  });

  it("parses a publication-acceptance data review subject", () => {
    expect(parseHILRequest({
      schema_version: "1.0",
      request_id: "hil_publication",
      task_id: "task_123",
      run_id: "run_123",
      requirement_id: "build_123",
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
        requirement_id: null,
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

describe("HIL approval policy contracts", () => {
  it("parses default and overridden approval settings", () => {
    expect(
      parseHilApprovalSettings({
        schema_version: "1.0",
        default_mode: "human_review",
        review_modes: {
          permission: "auto_approve",
          field_mapping: "llm_pre_review",
        },
      }),
    ).toEqual({
      schema_version: "1.0",
      default_mode: "human_review",
      review_modes: {
        permission: "auto_approve",
        field_mapping: "llm_pre_review",
      },
    });
  });

  it("treats missing review_modes as empty and rejects invalid modes/scopes", () => {
    expect(
      parseHilApprovalSettings({
        default_mode: "auto_approve",
        review_modes: null,
      }),
    ).toEqual({ default_mode: "auto_approve", review_modes: {} });

    expect(() =>
      parseHilApprovalSettings({ default_mode: "ask", review_modes: {} }),
    ).toThrow(/default_mode/);
    expect(() =>
      parseHilApprovalSettings({
        default_mode: "human_review",
        review_modes: { nonsense_scope: "auto_approve" },
      }),
    ).toThrow(/review_modes key/);
    expect(() =>
      parseHilApprovalSettings({
        default_mode: "human_review",
        review_modes: { field_mapping: "sometimes" },
      }),
    ).toThrow(/review_modes\.field_mapping/);
  });

  it("keeps human-mandatory scopes exported for the settings surface", () => {
    expect(HIL_HUMAN_MANDATORY_SCOPES).toEqual([
      "vlm_extraction",
      "browser_evidence_acceptance",
      "publication_acceptance",
    ]);
    expect(DEFAULT_HIL_APPROVAL_SETTINGS.default_mode).toBe("human_review");
  });

  it("accepts model and auto reviewers on review records", () => {
    const base = {
      schema_version: "1.0",
      review_id: "review_123",
      request_id: "hil_123",
      decision: { action: "accept" as const },
      reviewed_at: "2026-08-16T01:03:00.000Z",
      evidence_digest: DIGEST,
      reason: "approved by model pre-review: clear mapping",
    };
    expect(parseHumanReviewRecord({ ...base, reviewer: "model" }).reviewer).toBe("model");
    expect(parseHumanReviewRecord({ ...base, reviewer: "auto" }).reviewer).toBe("auto");
    expect(() => parseHumanReviewRecord({ ...base, reviewer: "robot" })).toThrow(/reviewer/);
  });
});
