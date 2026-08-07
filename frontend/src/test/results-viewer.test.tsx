import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ResultsViewer from "@/components/ResultsViewer";
import { createInitialRuntimeState } from "@/runtime/reducer";
import type { ArtifactProjection } from "@/runtime/types";
import { useAgentStore } from "@/stores/agentStore";

describe("ResultsViewer", () => {
  beforeEach(() => {
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
    useAgentStore.setState({
      activeTaskId: "task_results",
      tasksById: {
        task_results: {
          ...task,
          artifactsById: {
            artifact_csv: {
              artifact_id: "artifact_csv",
              name: "results.csv",
              size: 64,
              sha256: "a".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            },
          },
          artifactOrder: ["artifact_csv"],
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'gene,description\nTP53,"tumor protein, p53"',
      }),
    );
  });

  it("preserves quoted commas and loads the selected task artifact ID", async () => {
    render(<ResultsViewer />);
    fireEvent.click(screen.getByRole("button", { name: "CSV 预览" }));

    expect(await screen.findByText("tumor protein, p53")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/tasks/task_results/artifacts/artifact_csv",
    );
  });

  it("keeps the final artifact inside a bounded results scroll area", async () => {
    const task = useAgentStore.getState().tasksById.task_results;
    const artifacts = Array.from({ length: 14 }, (_, index) => {
      const ordinal = index + 1;
      const artifactId = `artifact_${ordinal}`;
      return [
        artifactId,
        {
          artifact_id: artifactId,
          name: `artifact-${ordinal}.csv`,
          role: "audit_report",
          size: ordinal,
          sha256: String(ordinal).padStart(64, "0"),
          media_type: "text/csv",
          taskId: "task_results",
          generatedByStepId: null,
        } satisfies ArtifactProjection,
      ] as const;
    });
    useAgentStore.setState({
      tasksById: {
        task_results: {
          ...task,
          artifactsById: Object.fromEntries(artifacts),
          artifactOrder: artifacts.map(([artifactId]) => artifactId),
        },
      },
    });

    const { container } = render(<ResultsViewer />);
    const resultsLayout = container.firstElementChild;
    const scrollArea = container.querySelector('[data-slot="scroll-area"]');
    const scrollViewport = container.querySelector(
      '[data-slot="scroll-area-viewport"]',
    );
    const finalArtifact = screen.getByText("artifact-14.csv");

    await waitFor(() => {
      expect(resultsLayout).toHaveClass("h-full", "min-h-0");
      expect(scrollArea).toHaveClass("min-h-0", "flex-1");
      expect(scrollViewport).toContainElement(finalArtifact);
    });
  });

  it("shows the server no-data message when the run summary reports no_data", async () => {
    const task = useAgentStore.getState().tasksById.task_results;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_results: {
          ...task,
          runsById: {
            run_results: {
              runId: "run_results",
              taskId: "task_results",
              requestId: "req_results",
              status: "completed",
              input: "question",
              createdAt: "2026-07-14T00:00:00Z",
              updatedAt: "2026-07-14T00:00:00Z",
              startedAt: "2026-07-14T00:00:00Z",
              finishedAt: "2026-07-14T00:00:00Z",
              error: null,
              summary: {
                run_status: "completed",
                build_result: {
                  status: "no_data",
                  valid_row_count: 0,
                  successful_sources: [],
                  rejected_sources: ["pubmed"],
                  available_artifact_roles: [],
                  publication_id: null,
                  reason_codes: ["no_records"],
                  user_summary: "所选数据源未返回任何记录",
                  recommended_next_action: "调整检索词后重试",
                },
                error_code: null,
                cancelled_at_stage: null,
                user_message: "所选数据源未返回任何记录",
              },
            },
          },
          runOrder: ["run_results"],
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
    );

    render(<ResultsViewer />);
    // The NO_DATA banner surfaces the message without opening a preview...
    expect(screen.getByText("所选数据源未返回任何记录")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "CSV 预览" }));
    // ...and the empty CSV preview repeats it for this artifact once loaded.
    await waitFor(() => {
      expect(screen.getAllByText("所选数据源未返回任何记录")).toHaveLength(2);
    });
  });

  it("shows the server no-data message for a completed no_data run with zero artifacts", () => {
    const task = useAgentStore.getState().tasksById.task_results;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_results: {
          ...task,
          artifactsById: {},
          artifactOrder: [],
          runsById: {
            run_results: {
              runId: "run_results",
              taskId: "task_results",
              requestId: "req_results",
              status: "completed",
              input: "question",
              createdAt: "2026-07-14T00:00:00Z",
              updatedAt: "2026-07-14T00:00:00Z",
              startedAt: "2026-07-14T00:00:00Z",
              finishedAt: "2026-07-14T00:00:00Z",
              error: null,
              summary: {
                run_status: "completed",
                build_result: {
                  status: "no_data",
                  valid_row_count: 0,
                  successful_sources: [],
                  rejected_sources: ["pubmed"],
                  available_artifact_roles: [],
                  publication_id: null,
                  reason_codes: ["no_records"],
                  user_summary: "所选数据源未返回任何记录",
                  recommended_next_action: "调整检索词后重试",
                },
                error_code: null,
                cancelled_at_stage: null,
                user_message: "所选数据源未返回任何记录",
              },
            },
          },
          runOrder: ["run_results"],
        },
      },
    });

    render(<ResultsViewer />);

    expect(screen.getByText("所选数据源未返回任何记录")).toBeVisible();
    expect(screen.queryByText("暂无结果")).not.toBeInTheDocument();
  });

  it("does not show CSV preview for a primary_dataset artifact with a non-CSV extension", () => {
    const task = useAgentStore.getState().tasksById.task_results;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_results: {
          ...task,
          artifactsById: {
            artifact_json: {
              artifact_id: "artifact_json",
              name: "main_data.json",
              role: "primary_dataset",
              size: 128,
              sha256: "b".repeat(64),
              media_type: "application/json",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
          },
          artifactOrder: ["artifact_json"],
        },
      },
    });

    render(<ResultsViewer />);

    // Should show the role label "主数据" but NOT a CSV preview button
    expect(screen.getByText("主数据")).toBeVisible();
    expect(screen.queryByRole("button", { name: "CSV 预览" })).not.toBeInTheDocument();
  });

  it("renders a NO_DATA publication (no primary) safely: supporting/audit listed, build result surfaced, CSV preview works", async () => {
    const task = useAgentStore.getState().tasksById.task_results;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_results: {
          ...task,
          artifactsById: {
            artifact_metadata: {
              artifact_id: "artifact_metadata",
              name: "sample_metadata.csv",
              role: "supporting_dataset",
              size: 128,
              sha256: "c".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
            artifact_quality: {
              artifact_id: "artifact_quality",
              name: "quality_report.csv",
              role: "audit_report",
              size: 96,
              sha256: "d".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
            artifact_sources: {
              artifact_id: "artifact_sources",
              name: "source_list.csv",
              role: "audit_report",
              size: 64,
              sha256: "e".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
            artifact_schema: {
              artifact_id: "artifact_schema",
              name: "schema.json",
              role: "schema",
              size: 512,
              sha256: "f".repeat(64),
              media_type: "application/json",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
          },
          artifactOrder: [
            "artifact_metadata",
            "artifact_quality",
            "artifact_sources",
            "artifact_schema",
          ],
          runsById: {
            run_no_data: {
              runId: "run_no_data",
              taskId: "task_results",
              requestId: "req_no_data",
              status: "completed",
              input: "question",
              createdAt: "2026-07-14T00:00:00Z",
              updatedAt: "2026-07-14T00:00:00Z",
              startedAt: "2026-07-14T00:00:00Z",
              finishedAt: "2026-07-14T00:00:00Z",
              error: null,
              summary: {
                run_status: "completed",
                build_result: {
                  status: "no_data",
                  valid_row_count: 0,
                  successful_sources: [],
                  rejected_sources: ["geo"],
                  available_artifact_roles: [
                    "supporting_dataset",
                    "audit_report",
                    "schema",
                  ],
                  publication_id: "pub_no_data",
                  reason_codes: ["no_primary_data"],
                  user_summary: "未找到可发布的表达数据",
                  recommended_next_action: "请更换数据集或调整检索词后重试",
                },
                error_code: null,
                cancelled_at_stage: null,
                user_message: "未找到可发布的表达数据",
              },
            },
          },
          runOrder: ["run_no_data"],
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          "sample_id,condition\nGSM1234567,treated\nGSM1234568,control",
      }),
    );

    const { container } = render(<ResultsViewer />);

    // All supporting/audit artifacts are listed with their role labels.
    expect(screen.getByText("sample_metadata.csv")).toBeVisible();
    expect(screen.getByText("quality_report.csv")).toBeVisible();
    expect(screen.getByText("source_list.csv")).toBeVisible();
    expect(screen.getByText("schema.json")).toBeVisible();
    expect(screen.getByText("辅助数据")).toBeVisible();
    expect(screen.getAllByText("审计报告")).toHaveLength(2);
    expect(screen.getByText("结构定义")).toBeVisible();

    // The NO_DATA build result is surfaced: user_summary + recommended_next_action.
    expect(screen.getByText("未找到可发布的表达数据")).toBeVisible();
    expect(screen.getByText("请更换数据集或调整检索词后重试")).toBeVisible();

    // No primary artifact, no row-count / NaN mis-render.
    expect(screen.queryByText("主数据")).not.toBeInTheDocument();
    expect(screen.queryByText(/0\s*行/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();

    // sample_metadata.csv is CSV-previewable (extension-gated) and loads its data.
    const sampleCard = [...container.querySelectorAll('[data-slot="card"]')].find(
      (card) => card.textContent?.includes("sample_metadata.csv"),
    );
    expect(sampleCard).toBeDefined();
    fireEvent.click(
      within(sampleCard as HTMLElement).getByRole("button", { name: "CSV 预览" }),
    );
    expect(await screen.findByText("GSM1234567")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/tasks/task_results/artifacts/artifact_metadata",
    );
  });

  it("keeps SUCCEEDED publications unchanged: primary listed with role label, no NO_DATA banner", () => {
    const task = useAgentStore.getState().tasksById.task_results;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_results: {
          ...task,
          artifactsById: {
            artifact_main: {
              artifact_id: "artifact_main",
              name: "main_data.csv",
              role: "primary_dataset",
              size: 1024,
              sha256: "g".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
            artifact_metadata: {
              artifact_id: "artifact_metadata",
              name: "sample_metadata.csv",
              role: "supporting_dataset",
              size: 128,
              sha256: "c".repeat(64),
              media_type: "text/csv",
              taskId: "task_results",
              generatedByStepId: null,
            } satisfies ArtifactProjection,
          },
          artifactOrder: ["artifact_main", "artifact_metadata"],
          runsById: {
            run_ok: {
              runId: "run_ok",
              taskId: "task_results",
              requestId: "req_ok",
              status: "completed",
              input: "question",
              createdAt: "2026-07-14T00:00:00Z",
              updatedAt: "2026-07-14T00:00:00Z",
              startedAt: "2026-07-14T00:00:00Z",
              finishedAt: "2026-07-14T00:00:00Z",
              error: null,
              summary: {
                run_status: "completed",
                build_result: {
                  status: "succeeded",
                  valid_row_count: 42,
                  successful_sources: ["geo"],
                  rejected_sources: [],
                  available_artifact_roles: [
                    "primary_dataset",
                    "supporting_dataset",
                  ],
                  publication_id: "pub_ok",
                  reason_codes: [],
                  user_summary: "数据构建成功",
                  recommended_next_action: "",
                },
                error_code: null,
                cancelled_at_stage: null,
                user_message: null,
              },
            },
          },
          runOrder: ["run_ok"],
        },
      },
    });

    render(<ResultsViewer />);

    expect(screen.getByText("main_data.csv")).toBeVisible();
    expect(screen.getByText("sample_metadata.csv")).toBeVisible();
    expect(screen.getAllByText("主数据")).toHaveLength(1);
    expect(screen.getByText("辅助数据")).toBeVisible();
    // No NO_DATA banner for SUCCEEDED runs.
    expect(screen.queryByText("数据构建成功")).not.toBeInTheDocument();
    expect(screen.queryByText("无数据")).not.toBeInTheDocument();
  });
});
