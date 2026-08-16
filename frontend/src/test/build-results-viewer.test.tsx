import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BuildResultsViewer from "@/components/BuildResultsViewer";
import ResultsViewer from "@/components/ResultsViewer";
import type {
  BuildDetail,
  BuildResult,
  DatasetManifest,
} from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const SUCCEEDED_RESULT: BuildResult = {
  status: "succeeded",
  valid_row_count: 42,
  successful_sources: ["binding_gdc", "binding_xena"],
  rejected_sources: ["binding_pubmed"],
  available_artifact_roles: [
    "primary_dataset",
    "schema",
    "provenance",
    "audit_report",
  ],
  publication_id: "pub_build_1",
  reason_codes: [],
  user_summary: "数据构建成功",
  recommended_next_action: "",
};

function manifest(overrides: Partial<DatasetManifest> = {}): DatasetManifest {
  return {
    manifest_id: "manifest_1",
    task_id: "task_results",
    build_id: "build_abc",
    dataset_family: "gene_expression",
    row_granularity: "gene",
    schema_ref: "gene_expression.long.v1",
    primary_key: ["record_id"],
    row_count: 42,
    sha256: "a".repeat(64),
    artifacts: [
      {
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: 1024,
        sha256: "b".repeat(64),
      },
      {
        artifact_id: "artifact_schema",
        role: "schema",
        relative_path: "schema.json",
        media_type: "application/json",
        size_bytes: 512,
        sha256: "c".repeat(64),
      },
      {
        artifact_id: "artifact_prov",
        role: "provenance",
        relative_path: "provenance.json",
        media_type: "application/json",
        size_bytes: 768,
        sha256: "d".repeat(64),
      },
      {
        artifact_id: "artifact_audit",
        role: "audit_report",
        relative_path: "audits/quality_report.csv",
        media_type: "text/csv",
        size_bytes: 256,
        sha256: "e".repeat(64),
      },
      {
        artifact_id: "artifact_confidence",
        role: "audit_report",
        relative_path: "confidence_records.json",
        media_type: "application/json",
        size_bytes: 384,
        sha256: "f".repeat(64),
      },
    ],
    source_summary: {
      binding_gdc: { row_count: 22 },
      binding_xena: { row_count: 20 },
    },
    validation_summary: {
      profile_ref: "pipeline.v1",
      status: "passed",
      checked_count: 12,
      failed_count: 0,
      report_path: null,
    },
    confidence_summary: {
      level_distribution: { high: 36, medium: 4, low: 2 },
      human_review_distribution: {
        not_required: 38,
        accepted: 3,
        corrected: 1,
      },
      reason_counts: {
        "vlm extraction is capped at medium": 4,
        "image label is ambiguous": 2,
      },
      pending_human_review_count: 0,
      batch_default_count: 2,
      record_override_count: 6,
      evidence_report_file: "confidence_records.json",
      statistical_anomalies: {
        detected_count: 2,
        report_file: "confidence_report.csv",
      },
      detected_anomaly_count: 2,
      report_file: "confidence_report.csv",
    },
    provenance_summary: {
      source_count: 2,
      field_mapping_count: 3,
      normalization_log_entries: 42,
      rejected_count: 1,
      dedup_count: 4,
      conflict_count: 1,
      coverage: {
        traced_rows: 40,
        untraced_rows: 2,
        coverage_ratio: 0.9524,
      },
    },
    ...overrides,
  };
}

function buildDetail(
  overrides: Partial<BuildDetail> = {},
  result: BuildResult = SUCCEEDED_RESULT,
): BuildDetail {
  const m = manifest();
  return {
    build_id: "build_abc",
    task_id: "task_results",
    manifest_ref: "datasets_build/build_abc/dataset_manifest.json",
    build_result: result,
    manifest: m,
    publication: {
      publication_id: "pub_build_1",
      manifest_ref: "datasets_build/build_abc/dataset_manifest.json",
      manifest_sha256: "a".repeat(64),
      validation_result_ref: "validation/pub_build_1",
      published_at: "2026-07-14T00:00:00Z",
      supersedes_publication_id: null,
    },
    artifacts: m.artifacts,
    ...overrides,
  };
}

const PRIMARY_CSV = "gene_id,count\nTP53,42\nBRCA1,7\n";

type FetchMock = (input: RequestInfo | URL) => Promise<unknown>;

function stubBuildFetch(
  detail: BuildDetail,
  csvText = PRIMARY_CSV,
  buildsItems: unknown[] = [],
): FetchMock {
  const fetchMock: FetchMock = (input) => {
    const url = String(input);
    if (url.includes("/artifacts/")) {
      return Promise.resolve({
        ok: true,
        text: async () => csvText,
      });
    }
    if (url.endsWith("/builds") || url.includes("/builds?")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: buildsItems, next_cursor: null }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => detail });
  };
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return fetchMock;
}

function stubBuildFetchPerArtifact(
  detail: BuildDetail,
  csvByArtifact: Record<string, string>,
): FetchMock {
  const fetchMock: FetchMock = (input) => {
    const url = String(input);
    if (url.includes("/artifacts/")) {
      const artifactId = (url.split("/artifacts/").pop() ?? "").split("?")[0] ?? "";
      return Promise.resolve({
        ok: true,
        text: async () => csvByArtifact[artifactId] ?? PRIMARY_CSV,
      });
    }
    return Promise.resolve({ ok: true, json: async () => detail });
  };
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return fetchMock;
}

/* ------------------------------------------------------------------ */
/*  BuildResultsViewer                                                 */
/* ------------------------------------------------------------------ */

describe("BuildResultsViewer", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("renders manifest summary fields: family / grain / schema / rows / coverage / validation / confidence / provenance", async () => {
    stubBuildFetch(buildDetail());

    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);

    expect(await screen.findByText("gene_expression")).toBeInTheDocument();
    expect(screen.getByText("gene")).toBeInTheDocument();
    expect(screen.getByText("gene_expression.long.v1")).toBeInTheDocument();
    expect(screen.getByText("42 行")).toBeInTheDocument();
    // source coverage
    expect(screen.getByText("2 个来源成功")).toBeInTheDocument();
    expect(screen.getByText("1 个来源被拒绝")).toBeInTheDocument();
    // validation (header + processing tab both render the status)
    expect(screen.getAllByText("passed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12 / 0").length).toBeGreaterThan(0);
    // statistical validation anomaly, separate from evidence confidence
    expect(screen.getByText("2 处")).toBeInTheDocument();
    // provenance coverage (header stat + sources tab both render the ratio)
    expect(screen.getAllByText("95.24%").length).toBeGreaterThan(0);
  });

  it("passes the task id to the builds API so colliding build ids resolve to this task", async () => {
    const urls: string[] = [];
    const fetchMock: FetchMock = (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/artifacts/")) {
        return Promise.resolve({
          ok: true,
          text: async () => PRIMARY_CSV,
        });
      }
      return Promise.resolve({ ok: true, json: async () => buildDetail() });
    };
    vi.stubGlobal("fetch", vi.fn(fetchMock));

    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);
    await screen.findByText("gene_expression");

    const buildUrl = urls.find((url) => url.includes("/builds/build_abc?"));
    const artifactUrl = urls.find((url) => url.includes("/artifacts/"));
    expect(buildUrl).toBeDefined();
    expect(buildUrl).toContain("task_id=task_results");
    expect(artifactUrl).toBeDefined();
    expect(artifactUrl).toContain("task_id=task_results");
  });

  it("shows confidence distributions, review states, reasons, and evidence drill-down", async () => {
    stubBuildFetch(buildDetail());
    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);

    fireEvent.click(await screen.findByRole("tab", { name: "处理" }));

    expect(await screen.findByText("可信度分布")).toBeInTheDocument();
    expect(screen.getByText("36")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText("low")).toBeInTheDocument();
    expect(screen.getByText("accepted 3")).toBeInTheDocument();
    expect(screen.getByText("corrected 1")).toBeInTheDocument();
    expect(screen.getByText("vlm extraction is capped at medium")).toBeInTheDocument();
    expect(screen.getByText("confidence_records.json")).toBeInTheDocument();
    expect(screen.getByText("provenance.json")).toBeInTheDocument();
    expect(screen.getAllByText("统计异常").length).toBeGreaterThan(0);
    expect(screen.getByText("统计异常报告")).toBeInTheDocument();
    expect(screen.queryByText("置信度异常")).not.toBeInTheDocument();
  });

  it("shows the NO_DATA reason in an informational banner, never as a red error", async () => {
    const noDataResult: BuildResult = {
      status: "no_data",
      valid_row_count: 0,
      successful_sources: [],
      rejected_sources: ["binding_pubmed"],
      available_artifact_roles: [],
      publication_id: null,
      reason_codes: ["no_records"],
      user_summary: "所选数据源未返回任何记录",
      recommended_next_action: "调整检索词后重试",
      build_id: "build_abc",
      binding_failures: [
        { binding_id: "binding_pubmed", reason_code: "empty_series_matrix", message: "series matrix 无数据表" },
      ],
    };
    stubBuildFetch(buildDetail({}, noDataResult));

    const { container } = render(
      <BuildResultsViewer buildId="build_abc" taskId="task_results" />,
    );

    expect(await screen.findByText("所选数据源未返回任何记录")).toBeInTheDocument();
    expect(screen.getByText("调整检索词后重试")).toBeInTheDocument();
    // K2: per-binding rejection trace is surfaced on the banner.
    expect(screen.getByText("binding_pubmed")).toBeInTheDocument();
    expect(screen.getByText("empty_series_matrix")).toBeInTheDocument();
    expect(screen.getByText("series matrix 无数据表")).toBeInTheDocument();

    const banner = container.querySelector('[data-status="no_data"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("所选数据源未返回任何记录");
    expect(banner?.textContent).toContain("binding_pubmed");
    // NO_DATA is informational — never destructive/red.
    expect(banner?.className).not.toContain("destructive");
    expect(banner?.className).not.toContain("bg-red");
    expect(banner?.className).not.toContain("text-red");
  });

  it("switches between the four result tabs: 主数据 / 来源 / 处理 / 警告", async () => {
    stubBuildFetch(buildDetail());

    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);

    // 主数据 tab (default) shows the primary dataset CSV preview.
    expect(await screen.findByText("TP53")).toBeInTheDocument();
    expect(screen.getByText("BRCA1")).toBeInTheDocument();

    // 来源 tab: provenance coverage + provenance artifact.
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("溯源覆盖详情")).toBeInTheDocument();
    expect(screen.getByText("provenance.json")).toBeInTheDocument();

    // 处理 tab: validation + audit artifacts.
    fireEvent.click(screen.getByRole("tab", { name: "处理" }));
    expect(await screen.findByText("quality_report.csv")).toBeInTheDocument();
    expect(screen.getByText("检测到 2 处统计异常")).toBeInTheDocument();

    // 警告 tab: no warnings artifact in this fixture -> calm empty state.
    fireEvent.click(screen.getByRole("tab", { name: "警告" }));
    expect(await screen.findByText("无警告")).toBeInTheDocument();
  });

  it("renders the warnings tab content from a warnings.csv artifact when present", async () => {
    const m = manifest({
      artifacts: [
        ...manifest().artifacts,
        {
          artifact_id: "artifact_warnings",
          role: "audit_report",
          relative_path: "audits/warnings.csv",
          media_type: "text/csv",
          size_bytes: 128,
          sha256: "f".repeat(64),
        },
      ],
    });
    stubBuildFetchPerArtifact(buildDetail({ manifest: m, artifacts: m.artifacts }), {
      artifact_warnings: "level,message\nlow,请注意归一化偏差\n",
    });

    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);
    await screen.findByText("gene_expression");

    fireEvent.click(screen.getByRole("tab", { name: "警告" }));
    expect(await screen.findByText("请注意归一化偏差")).toBeInTheDocument();
    expect(screen.queryByText("无警告")).not.toBeInTheDocument();
  });

  it("shows a partial_success banner with its reason", async () => {
    const partialResult: BuildResult = {
      status: "partial_success",
      valid_row_count: 5,
      successful_sources: ["binding_gdc"],
      rejected_sources: ["binding_xena"],
      available_artifact_roles: ["primary_dataset"],
      publication_id: "pub_partial",
      reason_codes: ["partial_coverage"],
      user_summary: "部分来源成功，已发布部分数据",
      recommended_next_action: "检查被拒绝的数据源",
    };
    stubBuildFetch(buildDetail({}, partialResult));

    render(<BuildResultsViewer buildId="build_abc" taskId="task_results" />);

    expect(await screen.findByText("部分来源成功，已发布部分数据")).toBeInTheDocument();
    expect(screen.getByText("检查被拒绝的数据源")).toBeInTheDocument();
    const banner = screen
      .getByText("部分来源成功，已发布部分数据")
      .closest('[data-status="partial_success"]');
    expect(banner).not.toBeNull();
  });

  it("shows an error state when the build cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "Build not found" }),
      }),
    );

    render(<BuildResultsViewer buildId="build_missing" taskId="task_results" />);

    expect(await screen.findByText("无法加载构建结果")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/*  ResultsViewer wiring                                               */
/* ------------------------------------------------------------------ */

function seedStoreTask(options: {
  artifacts?: ArtifactProjectionLike[];
  runBuildResult?: BuildResult | null;
  runStatus?: "completed" | "failed" | "cancelled" | "interrupted";
}) {
  useAgentStore.setState(createInitialRuntimeState());
  useAgentStore.getState().mergeTaskPage(
    {
      active_items: [],
      items: [
        {
          task_id: "task_results",
          mode: "agent",
          databases: [],
          title: "Results",
          status: "completed",
          active_run_id: null,
          created_at: "2026-07-14T00:00:00Z",
          updated_at: "2026-07-14T00:00:00Z",
          latest_sequence: 0,
        },
      ],
      next_cursor: null,
    },
    false,
  );
  const task = useAgentStore.getState().tasksById.task_results;
  const artifactsById: Record<string, ArtifactProjectionLike> = {};
  const artifactOrder: string[] = [];
  for (const artifact of options.artifacts ?? []) {
    artifactsById[artifact.artifact_id] = artifact;
    artifactOrder.push(artifact.artifact_id);
  }
  useAgentStore.setState({
    activeTaskId: "task_results",
    tasksById: {
      task_results: {
        ...task,
        artifactsById,
        artifactOrder,
        runsById:
          options.runBuildResult === undefined
            ? {}
            : {
                run_results: {
                  runId: "run_results",
                  taskId: "task_results",
                  requestId: "req_results",
                  status: options.runStatus ?? "completed",
                  input: "question",
                  createdAt: "2026-07-14T00:00:00Z",
                  updatedAt: "2026-07-14T00:00:00Z",
                  startedAt: "2026-07-14T00:00:00Z",
                  finishedAt: "2026-07-14T00:00:00Z",
                  error: null,
                  summary: {
                    run_status: options.runStatus ?? "completed",
                    build_result: options.runBuildResult,
                    error_code: null,
                    cancelled_at_stage: null,
                    user_message: null,
                  },
                },
              },
        runOrder:
          options.runBuildResult === undefined ? [] : ["run_results"],
      },
    },
  });
}

interface ArtifactProjectionLike {
  artifact_id: string;
  name: string;
  role: string;
  size: number;
  sha256: string;
  media_type: string;
  taskId: string;
  generatedByStepId: string | null;
}

function legacyArtifact(): ArtifactProjectionLike {
  return {
    artifact_id: "artifact_csv",
    name: "results.csv",
    role: "primary_dataset",
    size: 64,
    sha256: "a".repeat(64),
    media_type: "text/csv",
    taskId: "task_results",
    generatedByStepId: null,
  };
}

describe("ResultsViewer build wiring", () => {
  it("renders the manifest view when a buildId is provided", async () => {
    stubBuildFetch(buildDetail());
    seedStoreTask({});

    render(
      <ResultsViewer
        taskId="task_results"
        buildId="build_abc"
        artifacts={[]}
        activities={[]}
      />,
    );

    expect(await screen.findByText("gene_expression")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "主数据" })).toBeInTheDocument();
  });

  it("derives the build from the task's latest completed run via the builds API", async () => {
    stubBuildFetch(buildDetail(), PRIMARY_CSV, [
      {
        build_id: "build_abc",
        task_id: "task_results",
        dataset_family: "gene_expression",
        row_granularity: "gene",
        schema_ref: "gene_expression.long.v1",
        row_count: 42,
        status: "succeeded",
        publication_id: "pub_build_1",
        manifest_ref: "datasets_build/build_abc/dataset_manifest.json",
        manifest_sha256: "a".repeat(64),
        published_at: "2026-07-14T00:00:00Z",
        build_result: SUCCEEDED_RESULT,
      },
    ]);
    seedStoreTask({ runBuildResult: SUCCEEDED_RESULT });

    render(<ResultsViewer />);

    expect(await screen.findByText("gene_expression")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "处理" })).toBeInTheDocument();
  });

  it("keeps the legacy artifact view when the task has no build", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "gene,description\nTP53,tumor suppressor\n",
      }),
    );
    seedStoreTask({ artifacts: [legacyArtifact()] });

    render(<ResultsViewer taskId="task_results" />);

    expect(screen.getByText("results.csv")).toBeInTheDocument();
    expect(screen.getByText("主数据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CSV 预览" }));
    expect(await screen.findByText("tumor suppressor")).toBeInTheDocument();
    // No manifest-driven tabs for legacy runs.
    expect(screen.queryByRole("tab", { name: "来源" })).not.toBeInTheDocument();
  });

  it("keeps the legacy empty state when the latest run has no build result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "",
      }),
    );
    seedStoreTask({ runBuildResult: null });

    render(<ResultsViewer taskId="task_results" />);

    expect(screen.getByText("暂无结果")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "主数据" })).not.toBeInTheDocument();
  });
});
