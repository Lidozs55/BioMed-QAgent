import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
