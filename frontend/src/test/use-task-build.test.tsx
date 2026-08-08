import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskBuildId } from "@/hooks/useTaskBuild";
import type { APIClient } from "@/hooks/useAPI";
import { createTaskProjection } from "@/runtime/reducer";
import type {
  BuildPage,
  BuildResult,
  BuildSummary,
  RunSummary,
} from "@/runtime/contracts";
import type { RunProjection } from "@/runtime/types";
import { useAgentStore } from "@/stores/agentStore";

/**
 * F3 (R1S-02): useTaskBuildId must refetch when a NEW run produces a build.
 *
 * The hook derives the build via GET /builds matched by task_id. The fetch
 * is keyed by (taskId, hasBuildResult); when a second build-producing run
 * lands, both key components stay true — without the latest run id in the
 * key/deps the hook would keep serving the first run's build forever.
 */

const { mockClient } = vi.hoisted(() => ({
  mockClient: {} as Pick<APIClient, "fetchBuilds">,
}));

vi.mock("@/hooks/useAPI", () => ({ useAPI: () => mockClient }));

const fetchBuildsMock = () => vi.mocked(mockClient.fetchBuilds);

function buildResult(validRowCount: number): BuildResult {
  return {
    status: "succeeded",
    valid_row_count: validRowCount,
    successful_sources: ["binding_geo"],
    rejected_sources: [],
    available_artifact_roles: ["primary_dataset"],
    publication_id: "pub_1",
    reason_codes: [],
    user_summary: "",
    recommended_next_action: "",
  };
}

function runProjection(runId: string, hasBuild: boolean): RunProjection {
  const summary: RunSummary = {
    run_status: "completed",
    build_result: hasBuild ? buildResult(1) : null,
    error_code: null,
    cancelled_at_stage: null,
    user_message: null,
  };
  return {
    runId,
    taskId: "task_f3",
    requestId: null,
    status: "completed",
    input: null,
    createdAt: "2026-07-14T00:00:00Z",
    updatedAt: "2026-07-14T00:00:00Z",
    startedAt: "2026-07-14T00:00:00Z",
    finishedAt: "2026-07-14T00:00:00Z",
    error: null,
    summary,
  };
}

function taskProjection(runOrder: string[], runsById: Record<string, RunProjection>) {
  const task = createTaskProjection({
    task_id: "task_f3",
    mode: "agent",
    databases: [],
    title: "Task F3",
    status: "completed",
    active_run_id: null,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    latest_sequence: 0,
  });
  return { ...task, runOrder, runsById };
}

function buildSummary(buildId: string, taskId: string): BuildSummary {
  return {
    build_id: buildId,
    task_id: taskId,
    dataset_family: "gene_expression",
    row_granularity: "gene",
    schema_ref: "gene_expression.long.v1",
    row_count: 1,
    status: "succeeded",
    publication_id: "pub_1",
    manifest_ref: "datasets_build/abc/dataset_manifest.json",
    manifest_sha256: "a".repeat(64),
    published_at: "2026-07-14T00:00:00Z",
    build_result: buildResult(1),
  };
}

function page(items: BuildSummary[]): BuildPage {
  return { items, next_cursor: null };
}

function Harness({ taskId }: { taskId: string | null }) {
  const state = useTaskBuildId(taskId);
  return (
    <div data-testid="state">{state.status}:{state.buildId ?? ""}</div>
  );
}

describe("useTaskBuildId — refetches when a new run produces a build (F3)", () => {
  beforeEach(() => {
    useAgentStore.setState({ tasksById: {} });
    mockClient.fetchBuilds = vi.fn();
  });

  it("refetches and resolves the newest build after a second build-producing run", async () => {
    useAgentStore.setState({
      tasksById: {
        task_f3: taskProjection(["run_a"], {
          run_a: runProjection("run_a", true),
        }),
      },
    });
    fetchBuildsMock().mockResolvedValueOnce(
      page([buildSummary("build_x", "task_f3")]),
    );

    render(<Harness taskId="task_f3" />);
    expect(await screen.findByText("ready:build_x")).toBeInTheDocument();

    // A second run lands with its own build_result — the hook must refetch
    // and resolve the newest build (build_y), not keep build_x. Queue the
    // second page BEFORE the store update: the effect fires synchronously
    // during act().
    fetchBuildsMock().mockResolvedValueOnce(
      page([
        buildSummary("build_y", "task_f3"),
        buildSummary("build_x", "task_f3"),
      ]),
    );
    await act(async () => {
      useAgentStore.setState({
        tasksById: {
          task_f3: taskProjection(["run_a", "run_b"], {
            run_a: runProjection("run_a", true),
            run_b: runProjection("run_b", true),
          }),
        },
      });
    });

    expect(await screen.findByText("ready:build_y")).toBeInTheDocument();
    expect(fetchBuildsMock()).toHaveBeenCalledTimes(2);
  });
});
