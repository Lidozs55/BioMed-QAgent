import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionSidebar } from "@/components/SessionSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

describe("SessionSidebar", () => {
  beforeAll(() => {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  });

  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          {
            task_id: "task_sidebar",
            mode: "agent",
            databases: ["pubmed", "geo"],
            title: "Sidebar structure",
            status: "running",
            active_run_id: "run_sidebar",
            created_at: "2026-07-14T00:00:00Z",
            updated_at: "2026-07-14T00:00:00Z",
            latest_sequence: 1,
          },
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
  });

  it("renders canonical task navigation without a local delete control", () => {
    const onSelectTask = vi.fn();
    const { container } = render(
      <SidebarProvider>
        <SessionSidebar onNewDraft={vi.fn()} onSelectTask={onSelectTask} />
      </SidebarProvider>,
    );

    expect(container.querySelector("button button")).toBeNull();
    expect(screen.queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sidebar structure/ }));
    expect(onSelectTask).toHaveBeenCalledWith("task_sidebar");
  });

  it("keeps new research available while a background task runs", () => {
    const onNewDraft = vi.fn();
    render(
      <SidebarProvider>
        <SessionSidebar onNewDraft={onNewDraft} onSelectTask={vi.fn()} />
      </SidebarProvider>,
    );

    const button = screen.getByRole("button", { name: "新建研究" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onNewDraft).toHaveBeenCalledTimes(1);
  });
});
