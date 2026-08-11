import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildReportCard } from "@/components/conversation/BuildReportCard";
import type { BuildDetail, BuildResult, DatasetManifest } from "@/runtime/contracts";
import type { BuildReportItem } from "@/runtime/types";

const ITEM: BuildReportItem = {
  kind: "build_report",
  itemId: "report:run_results",
  runId: "run_results",
  sequence: 8,
  createdAt: "2026-08-10T00:00:00Z",
  taskId: "task_results",
  buildId: "build_results",
};

const RESULT: BuildResult = {
  status: "succeeded",
  valid_row_count: 42,
  successful_sources: ["gdc", "geo"],
  rejected_sources: ["pubmed"],
  available_artifact_roles: ["primary_dataset", "provenance", "schema", "audit_report"],
  publication_id: "pub_results",
  reason_codes: [],
  user_summary: "数据构建成功",
  recommended_next_action: "",
  build_id: "build_results",
};

function manifest(overrides: Partial<DatasetManifest> = {}): DatasetManifest {
  return {
    manifest_id: "manifest_results",
    task_id: "task_results",
    build_id: "build_results",
    dataset_family: "gene_expression",
    row_granularity: "gene",
    schema_ref: "gene_expression.long.v1",
    primary_key: ["record_id"],
    row_count: 42,
    sha256: "a".repeat(64),
    artifacts: [
      {
        artifact_id: "primary",
        role: "primary_dataset",
        relative_path: "merged/main_data.csv",
        media_type: "text/csv",
        size_bytes: 1024,
        sha256: "b".repeat(64),
      },
      {
        artifact_id: "provenance",
        role: "provenance",
        relative_path: "provenance.json",
        media_type: "application/json",
        size_bytes: 512,
        sha256: "c".repeat(64),
      },
      {
        artifact_id: "warnings",
        role: "audit_report",
        relative_path: "warnings.csv",
        media_type: "text/csv",
        size_bytes: 256,
        sha256: "d".repeat(64),
      },
    ],
    source_summary: {},
    validation_summary: {
      status: "passed",
      checked_count: 12,
      failed_count: 0,
    },
    confidence_summary: {
      detected_anomaly_count: 2,
    },
    provenance_summary: {
      source_count: 2,
      coverage: { coverage_ratio: 0.95 },
    },
    ...overrides,
  };
}

function detail(overrides: Partial<BuildDetail> = {}): BuildDetail {
  const currentManifest = manifest();
  return {
    build_id: "build_results",
    task_id: "task_results",
    manifest_ref: "datasets_build/build_results/dataset_manifest.json",
    build_result: RESULT,
    manifest: currentManifest,
    publication: null,
    artifacts: currentManifest.artifacts,
    ...overrides,
  };
}

function stubFetch(currentDetail: BuildDetail | null, csv = "gene_id,count\nTP53,42\nBRCA1,7\nEGFR,8\nMYC,9\nPTEN,10\nALK,11\nKRAS,12\nBRAF,13\nNRAS,14\nPIK3CA,15\nIDH1,16\nNOT_SHOWN,17\n") {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/artifacts/")) {
      return Promise.resolve(new Response(csv, { status: 200 }));
    }
    if (currentDetail === null) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(currentDetail), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BuildReportCard", () => {
  it("shows primary preview, summaries, expandable tabs, and downloads all files", async () => {
    stubFetch(detail());
    const download = vi.fn();

    render(<BuildReportCard item={ITEM} download={download} />);

    expect(await screen.findByText("数据构建结果")).toBeVisible();
    expect(await screen.findByText("TP53")).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(screen.getByText("仅显示前 10 行")).toBeVisible();
    expect(screen.queryByText("NOT_SHOWN")).not.toBeInTheDocument();
    expect(screen.getByText("来源")).toBeVisible();
    expect(screen.getByText("处理")).toBeVisible();
    expect(screen.getByText("警告")).toBeVisible();
    const downloadButton = screen.getByRole("button", { name: "下载所有" });
    expect(downloadButton).toHaveClass("border-border");
    expect(downloadButton).not.toHaveClass("bg-primary");
    fireEvent.click(downloadButton);
    expect(download).toHaveBeenCalledTimes(3);
    expect(download).toHaveBeenNthCalledWith(1, expect.stringContaining("/primary"), "main_data.csv");
    fireEvent.click(screen.getByRole("button", { name: "展开详情" }));
    const dialog = await screen.findByRole("dialog", { name: "构建详情" });
    expect(dialog).toHaveClass("max-w-[min(1120px,calc(100vw-2rem))]");
    expect(within(dialog).getByRole("tab", { name: "主数据" })).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "来源" })).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "处理" })).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "警告" })).toBeVisible();
  });

  it("renders every generated artifact in a compact file list", async () => {
    const duplicateArtifact = {
      artifact_id: "warnings_duplicate",
      role: "audit_report" as const,
      relative_path: "warnings.csv",
      media_type: "text/csv",
      size_bytes: 119,
      sha256: "e".repeat(64),
    };
    const duplicateManifest = manifest({ artifacts: [...manifest().artifacts, duplicateArtifact] });
    stubFetch(
      detail({
        manifest: duplicateManifest,
        artifacts: duplicateManifest.artifacts,
      }),
    );

    render(<BuildReportCard item={ITEM} />);

    const artifactList = await screen.findByRole("list", { name: "生成产物" });
    expect(within(artifactList).getAllByText("warnings.csv")).toHaveLength(2);
    expect(within(artifactList).getByText("119 B")).toBeVisible();
    expect(within(artifactList).getByText("provenance.json")).toBeVisible();
  });

  it("shows an empty primary preview and disables download for a no-data build", async () => {
    const noDataResult: BuildResult = {
      ...RESULT,
      status: "no_data",
      valid_row_count: 0,
      publication_id: null,
      available_artifact_roles: [],
      build_id: "build_no_data",
    };
    const noDataManifest = manifest({
      build_id: "build_no_data",
      row_count: 0,
      artifacts: [],
    });
    stubFetch(
      detail({
        build_id: "build_no_data",
        manifest: noDataManifest,
        build_result: noDataResult,
        artifacts: [],
      }),
    );

    render(<BuildReportCard item={{ ...ITEM, buildId: "build_no_data" }} />);

    expect((await screen.findAllByText("无主数据")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "下载所有" })).toBeDisabled();
  });

  it("shows a recoverable error when the build detail cannot be loaded", async () => {
    stubFetch(null);

    render(<BuildReportCard item={ITEM} />);

    expect(await screen.findByText("无法加载构建结果")).toBeVisible();
  });
});
