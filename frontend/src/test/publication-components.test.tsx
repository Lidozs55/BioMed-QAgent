import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PublicationResultsViewer from "@/components/PublicationResultsViewer";
import { PublicationReportCard } from "@/components/conversation/PublicationReportCard";
import type { PublicationDetail } from "@/runtime/contracts";
import type { PublicationReportItem } from "@/runtime/types";

const detail: PublicationDetail = {
  publication_id: "pub_1",
  requirement_id: "requirement_1",
  run_id: "run_1",
  task_id: "task_1",
  manifest_ref: "dataset_runs/run_1/requirement_1/publish/pub_1/dataset_manifest.json",
  manifest: {
    manifest_id: "manifest_1",
    task_id: "task_1",
    requirement_id: "requirement_1",
    dataset_family: "gene_expression",
    row_granularity: "gene",
    schema_ref: "gene_expression.long.v1",
    primary_key: ["record_id"],
    row_count: 4,
    sha256: "a".repeat(64),
    artifacts: [],
    source_summary: {},
    validation_summary: { status: "passed", checked_count: 2, failed_count: 0 },
    confidence_summary: {},
    provenance_summary: {},
  },
  publication: {
    schema_version: "1.1",
    publication_id: "pub_1",
    manifest_ref: "dataset_runs/run_1/requirement_1/publish/pub_1/dataset_manifest.json",
    manifest_sha256: "a".repeat(64),
    validation_result_ref: "validation_report.json",
    published_at: "2026-08-27T00:00:00Z",
    supersedes_publication_id: null,
  },
  artifacts: [],
};

afterEach(() => vi.unstubAllGlobals());

function stubPublication(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
}

describe("Publication components", () => {
  it("renders immutable publication detail without a Build outcome", async () => {
    stubPublication();
    render(<PublicationResultsViewer publicationId="pub_1" taskId="task_1" />);
    expect(await screen.findByText("数据发布产物")).toBeVisible();
    expect(screen.getByText("需求 requirement_1 · task_1")).toBeVisible();
    expect(screen.getByText("4 行")).toBeVisible();
  });

  it("renders a conversation publication report", async () => {
    stubPublication();
    const item: PublicationReportItem = {
      kind: "publication_report",
      itemId: "publication:pub_1",
      runId: "run_1",
      sequence: 1,
      createdAt: "2026-08-27T00:00:00Z",
      taskId: "task_1",
      publicationId: "pub_1",
    };
    render(<PublicationReportCard item={item} />);
    expect(await screen.findByText("数据发布产物")).toBeVisible();
    expect(screen.getByText("4 行 · 需求 requirement_1")).toBeVisible();
  });
});
