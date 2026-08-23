import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HILRequest } from "@biomed/contracts";

import {
  FamilyHostStatusCard,
  ProductAssessmentSummary,
} from "@/components/FamilyHostStatusCard";
import { HumanReviewBatch } from "@/components/HumanReviewBatch";
import { ToolCallStep } from "@/components/conversation/ToolCallStep";
import {
  parseDynamicFamilyToolOutputText,
  parsePublicationAcceptanceEvidence,
  parseProductAssessmentSummary,
} from "@/lib/familyHost";
import type { ToolCallItem } from "@/runtime/types";

const CREATED_AT = "2026-08-21T00:00:00Z";
const DIGEST = "a".repeat(64);

const dynamicOutput = {
  ok: true,
  status: "published",
  build_id: "build_family_1",
  publication_id: "pub_family_1",
  manifest_id: "manifest_family_1",
  manifest_sha256: DIGEST,
  operation_result_manifest_id: "result_1",
  tables: ["paper_records"],
  relations: ["paper_to_experiment"],
  artifacts: [],
  source_acquisition_provenance: [],
  backend: "in_process_unisolated",
  security_boundary: false,
};

function publicationRequest(): HILRequest {
  return {
    schema_version: "1.0",
    request_id: "hil_publication_1",
    task_id: "task_1",
    run_id: "run_1",
    build_id: "build_family_1",
    kind: "data_review",
    review_type: "publication_acceptance",
    status: "pending",
    blocking: true,
    subject: { candidate_ids: ["candidate_1"], table_ids: ["paper_records"] },
    review_items: [{
      item_id: "candidate_1",
      summary: "Review candidate",
      subject: { candidate_ids: ["candidate_1"] },
      evidence: {
        reviewed_snapshot: {
          candidate: {
            candidate_id: "candidate_1",
            task_id: "task_1",
            build_id: "build_family_1",
            dataset_family: "literature_evidence",
            row_granularity: "activity_measurement",
            canonical_sha256: DIGEST,
            registered_asset_ids: ["asset_1"],
          },
          provisional_assessment: {
            requirement_id: "assessment_1",
            product_status: "incomplete",
            missing_requirements: ["dynamic_family_hil_acceptance.v1"],
            sha256: DIGEST,
          },
          b3: {
            profile_ref: "profile_1",
            checks_sha256: DIGEST,
            checked_count: 6,
            failed_count: 0,
          },
          tables: [{
            table_id: "paper_records",
            role: "primary",
            schema_ref: "schema.paper.v1",
            row_count: 12,
            sha256: DIGEST,
          }],
        },
      },
      proposed_value: { action: "publish" },
      confidence_level: null,
    }],
    summary: "Accept the evidence-bound dynamic publication candidate",
    evidence_digest: DIGEST,
    policy_ref: "dynamic_family_hil_acceptance.v1",
    created_at: CREATED_AT,
    resolved_at: null,
  };
}

function toolItem(output: string): ToolCallItem {
  return {
    itemId: "tool:run_1:call_1",
    runId: "run_1",
    sequence: 1,
    createdAt: CREATED_AT,
    kind: "tool_call",
    toolCallId: "call_1",
    toolName: "submit_dynamic_family_build",
    arguments: null,
    status: "completed",
    output,
    completedSequence: 2,
  };
}

describe("Family Host frontend UX", () => {
  it("parses the current dynamic tool response without inventing missing fields", () => {
    const parsed = parseDynamicFamilyToolOutputText(JSON.stringify(dynamicOutput));
    expect(parsed).toMatchObject({
      ok: true,
      status: "published",
      backend: "in_process_unisolated",
      security_boundary: false,
    });
    expect(parseDynamicFamilyToolOutputText("not json")).toBeNull();
  });

  it("renders lifecycle state and explicit unisolated boundary label", () => {
    render(<FamilyHostStatusCard output={parseDynamicFamilyToolOutputText(JSON.stringify(dynamicOutput))!} />);
    expect(screen.getByTestId("family-host-status")).toHaveTextContent("in_process_unisolated");
    expect(screen.getByText(/不是安全边界/)).toBeInTheDocument();
    expect(screen.getByText("pub_family_1")).toBeInTheDocument();
  });

  it("renders dynamic tool output as typed lifecycle presentation", () => {
    render(<ToolCallStep item={toolItem(JSON.stringify(dynamicOutput))} />);
    expect(screen.getByTestId("family-host-status")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("parses ProductAssessment status, scores, and blockers", () => {
    const assessment = parseProductAssessmentSummary({
      schema_version: "1.0",
      requirement_id: "requirement_1",
      package_id: "candidate_1",
      package_version: "1.0",
      product_status: "incomplete",
      scores: [{ dimension: "confidence", score: 0, satisfied: 0, required: 1 }],
      missing_requirements: ["review_1"],
      blockers: [{
        requirement_id: "review_1",
        dimension: "confidence",
        code: "human_review_pending",
        message: "Review required",
      }],
    });
    expect(assessment?.product_status).toBe("incomplete");
    expect(assessment?.scores[0]?.score).toBe(0);
    expect(assessment?.blockers[0]?.code).toBe("human_review_pending");
  });

  it("renders ProductAssessment scores and blockers", () => {
    const assessment = parseProductAssessmentSummary({
      schema_version: "1.0",
      requirement_id: "requirement_1",
      package_id: "candidate_1",
      package_version: "1.0",
      product_status: "incomplete",
      scores: [{ dimension: "confidence", score: 0, satisfied: 0, required: 1 }],
      missing_requirements: ["review_1"],
      blockers: [{
        requirement_id: "review_1",
        dimension: "confidence",
        code: "human_review_pending",
        message: "Review required",
      }],
    });
    render(<ProductAssessmentSummary assessment={assessment!} />);
    expect(screen.getByText("ProductAssessment")).toBeInTheDocument();
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
    expect(screen.getByText("human_review_pending")).toBeInTheDocument();
    expect(screen.getByText("Review required")).toBeInTheDocument();
  });

  it("gives publication_acceptance only accept/reject controls and evidence summary", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request = publicationRequest();
    expect(parsePublicationAcceptanceEvidence(request).candidate.candidate_id).toBe("candidate_1");
    render(
      <HumanReviewBatch
        request={request}
        disabled={false}
        submittingAction={null}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByTestId("publication-acceptance-review")).toBeInTheDocument();
    expect(screen.getByText("evidence digest")).toBeInTheDocument();
    expect(screen.getByText("paper_records")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受并发布候选" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拒绝候选" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /修正/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /跳过/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "接受并发布候选" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ action: "accept" }));
  });
});
