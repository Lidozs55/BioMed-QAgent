import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OutputPanelToggle,
  TaskOutputWorkspace,
} from "@/components/TaskOutputWorkspace";
import { OUTPUT_FORMAL_TAB } from "@/components/TaskOutputPanel";
import { openTaskOutputPanel } from "@/components/taskOutputPanelControl";
import { createAPIClient, type FetchLike, useAPI } from "@/hooks/useAPI";
import type { EventEnvelope, TaskSnapshot } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("@/hooks/useAPI", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAPI")>();
  return { ...actual, useAPI: vi.fn() };
});

const CREATED_AT = "2026-09-03T00:00:00.000Z";
const mockedUseAPI = vi.mocked(useAPI);

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function snapshot(
  taskId: string,
  status: "running" | "completed",
  hydrationSequence = 3,
): TaskSnapshot {
  const active = status === "running";
  return {
    task: {
      task_id: taskId,
      mode: "agent",
      databases: [],
      title: `${taskId} output`,
      status,
      active_run_id: active ? `run_${taskId}` : null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: hydrationSequence,
      artifact_count: 0,
    },
    runs: [{
      run_id: `run_${taskId}`,
      task_id: taskId,
      request_id: `request_${taskId}`,
      status,
      input: "research",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      started_at: CREATED_AT,
      finished_at: active ? null : CREATED_AT,
      error: null,
    }],
    messages: [],
    subagents: [{
      subagent_id: `subagent_${taskId}`,
      task_id: taskId,
      run_id: `run_${taskId}`,
      agent_type: "source_research",
      objective: "Search source",
      target_source: "pubmed",
      status: active ? "running" : "completed",
      parent_tool_call_id: "tool_1",
      created_at: CREATED_AT,
      started_at: CREATED_AT,
      finished_at: active ? null : CREATED_AT,
      progress_current: 1,
      progress_total: 1,
      progress_message: null,
      result_summary: null,
      source_asset_ids: [],
      recipe_id: null,
      error_code: null,
      error_message: null,
      pending_request_id: null,
    }],
    current_publication_id: null,
    publications: [],
    older_messages_cursor: null,
  };
}

function terminalEvent(taskId: string, sequence: number): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "run_completed",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-09-03T00:00:0${sequence}.000Z`,
    payload: { type: "run_completed" },
  };
}

function seed(taskId: string, status: "running" | "completed"): void {
  useAgentStore.getState().hydrateTaskSnapshot(snapshot(taskId, status));
  useAgentStore.getState().setActiveTaskId(taskId);
}

function outputFetcher(): FetchLike {
  return vi.fn<FetchLike>().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/quarantine") || url.includes("/source-assets")) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

describe("TaskOutputWorkspace", () => {
  beforeEach(() => {
    setViewportWidth(1024);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("767") && window.innerWidth < 768,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    useAgentStore.setState(createInitialRuntimeState());
    mockedUseAPI.mockReturnValue(createAPIClient({ fetcher: outputFetcher() }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedUseAPI.mockReset();
    mockedUseAPI.mockReturnValue(createAPIClient());
  });

  it("opens a resizable output-only sidebar from the header control", async () => {
    seed("task_1", "completed");
    const { container } = render(
      <>
        <OutputPanelToggle />
        <TaskOutputWorkspace>
          <div>Conversation</div>
        </TaskOutputWorkspace>
      </>,
    );

    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换输出面板" }));

    expect(await screen.findByRole("heading", { name: "任务输出" })).toBeVisible();
    expect(screen.getByRole("region", { name: "任务输出面板" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /正式产物/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /来源\/证据/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /未准入/ })).toBeVisible();
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).toBeInTheDocument();
    expect(screen.queryByText("子任务")).not.toBeInTheDocument();
    expect(screen.queryByText("SourceResearchAgent")).not.toBeInTheDocument();
  });

  it("auto-opens once when the selected task transitions from active to completed", async () => {
    seed("task_live", "running");
    const { container } = render(
      <TaskOutputWorkspace>
        <div>Conversation</div>
      </TaskOutputWorkspace>,
    );

    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();
    act(() => {
      useAgentStore.getState().applyEvent(terminalEvent("task_live", 4));
    });

    expect(await screen.findByRole("heading", { name: "任务输出" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭输出面板" }));
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();

    act(() => {
      useAgentStore.setState((state) => ({ ...state }));
    });
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();
  });

  it("does not reopen after a manual close when completed state is rehydrated", async () => {
    seed("task_rehydrated", "running");
    const { container } = render(
      <TaskOutputWorkspace>
        <div>Conversation</div>
      </TaskOutputWorkspace>,
    );

    act(() => {
      useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_rehydrated", "completed", 4));
    });
    expect(await screen.findByRole("heading", { name: "任务输出" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭输出面板" }));

    act(() => {
      useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_rehydrated", "completed", 5));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();
    });
  });

  it("does not auto-open for a completed history task or task selection", async () => {
    seed("task_history", "completed");
    const { container } = render(
      <TaskOutputWorkspace>
        <div>Conversation</div>
      </TaskOutputWorkspace>,
    );
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();

    act(() => {
      seed("task_history_2", "completed");
      useAgentStore.getState().setActiveTaskId("task_history");
      useAgentStore.getState().setHydratingTaskId("task_history");
      useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_history", "running", 7));
      useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_history", "completed", 8));
      useAgentStore.getState().setHydratingTaskId(null);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();
    });
  });

  it("offers the same output panel as an accessible mobile sheet", async () => {
    setViewportWidth(390);
    seed("task_mobile", "completed");
    render(
      <>
        <OutputPanelToggle />
        <TaskOutputWorkspace>
          <div>Conversation</div>
        </TaskOutputWorkspace>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换输出面板" }));
    expect(await screen.findByRole("dialog", { name: "任务输出" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /正式产物/ })).toBeVisible();
  });

  it("opens publication reports on the formal tab", async () => {
    seed("task_event", "completed");
    render(
      <TaskOutputWorkspace>
        <div>Conversation</div>
      </TaskOutputWorkspace>,
    );

    act(() => openTaskOutputPanel());
    expect(await screen.findByRole("heading", { name: "任务输出" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /来源\/证据/ }));
    expect(screen.getByRole("tab", { name: /来源\/证据/ })).toHaveAttribute(
      "data-active",
    );

    act(() => openTaskOutputPanel(OUTPUT_FORMAL_TAB));
    expect(screen.getByRole("tab", { name: /正式产物/ })).toHaveAttribute(
      "data-active",
    );
  });
});
