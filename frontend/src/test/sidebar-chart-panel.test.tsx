import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarChartPanel } from "@/components/SidebarChartPanel";
import type {
  ConversationItem,
  TaskProjection,
  ToolCallItem,
} from "@/runtime/types";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    // jsdom 下 ResponsiveContainer 尺寸为 0，直接透传子图表以便断言。
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const fetchTaskFileText = vi.fn();

vi.mock("@/hooks/useAPI", () => ({
  useAPI: () => ({ fetchTaskFileText }),
}));

const CREATED_AT = "2026-08-30T00:00:00Z";

const TOOL_OUTPUT = JSON.stringify({
  status: "ok",
  source_file: "figure_1.png",
  source_path: "source_assets/figures/figure_1.png",
  outputs: [
    "parsed/chart_data/chart_data.csv",
    "parsed/chart_data/chart_data_points.csv",
  ],
  charts: [
    { chart_id: "chart_001", chart_type: "bar", data_point_count: 2, source_asset_id: "asset_1" },
  ],
  total_charts: 1,
  total_data_points: 2,
  metas: [],
});

const META_CSV = [
  "chart_id,source_asset_id,chart_type,title,x_label,x_unit,x_scale,y_label,y_unit,y_scale",
  "chart_001,asset_1,bar,活性对比,浓度,μM,linear,活性,%,linear",
].join("\n");

const POINTS_CSV = [
  "point_id,chart_id,x_value,y_value,series_label",
  "p1,chart_001,1,10,实验组",
  "p2,chart_001,2,20,实验组",
].join("\n");

function toolCallItem(): ToolCallItem {
  return {
    kind: "tool_call",
    itemId: "tool:run_1:call_1",
    runId: "run_1",
    sequence: 3,
    createdAt: CREATED_AT,
    toolCallId: "call_1",
    toolName: "extract_chart_data_vlm",
    arguments: { source_path: "source_assets/figures/figure_1.png" },
    status: "completed",
    output: TOOL_OUTPUT,
    completedSequence: 3,
  };
}

function taskWithItems(items: ConversationItem[]): TaskProjection {
  return {
    summary: {
      task_id: "task_1",
      mode: "agent",
      databases: [],
      title: "图表任务",
      status: "completed",
      active_run_id: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 3,
    },
    runsById: {},
    runOrder: [],
    subagentsById: {},
    subagentOrder: [],
    messages: [],
    olderMessagesCursor: null,
    activitiesById: {},
    activityOrder: [],
    artifactsById: {},
    artifactOrder: [],
    artifactEventSequences: {},
    artifactManifestSequence: null,
    stages: {},
    assistantStreamsByRunId: {},
    pendingUserInput: null,
    pendingPermission: null,
    lastSequence: 3,
    hydration: "snapshot",
    items,
    itemSequences: {},
    currentReasoningSegmentByRun: {},
    currentPublicationId: null,
    publications: [],
    sequenceGap: null,
  };
}

function seedTask(items: ConversationItem[]): void {
  const state = createInitialRuntimeState();
  useAgentStore.setState({
    ...state,
    tasksById: { ...state.tasksById, task_1: taskWithItems(items) },
    activeTaskId: "task_1",
  });
}

describe("SidebarChartPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState(createInitialRuntimeState());
    fetchTaskFileText.mockImplementation((_taskId: string, path: string) => {
      if (path.endsWith("chart_data.csv")) return Promise.resolve(META_CSV);
      if (path.endsWith("chart_data_points.csv")) return Promise.resolve(POINTS_CSV);
      return Promise.reject(new Error("unexpected path: " + path));
    });
  });

  it("renders nothing without chart tool outputs", () => {
    seedTask([]);
    const { container } = render(<SidebarChartPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders extracted charts after the tool output lands", async () => {
    seedTask([toolCallItem()]);
    render(<SidebarChartPanel />);
    expect(await screen.findByText("数据可视化")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("活性对比")).toBeInTheDocument();
    });
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
    expect(fetchTaskFileText).toHaveBeenCalledWith("task_1", "parsed/chart_data/chart_data.csv");
    expect(fetchTaskFileText).toHaveBeenCalledWith("task_1", "parsed/chart_data/chart_data_points.csv");
  });

  it("keeps the panel hidden while CSV loading fails", async () => {
    fetchTaskFileText.mockRejectedValue(new Error("backend down"));
    seedTask([toolCallItem()]);
    const { container } = render(<SidebarChartPanel />);
    await waitFor(() => {
      expect(screen.getByText("图表数据加载失败")).toBeInTheDocument();
    });
    expect(container.querySelector("[data-testid='responsive-container']")).toBeNull();
  });
});
