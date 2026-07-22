import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import App from "@/App";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

class FakeWebSocket {
  static latest: FakeWebSocket;

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeWebSocket.latest = this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
}

describe("App startup ownership", () => {
  let historyFailure = false;

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
    historyFailure = false;
    vi.clearAllMocks();
    useAgentStore.setState(createInitialRuntimeState());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/databases") {
          return Promise.resolve(
            new Response(JSON.stringify({ databases: [] }), { status: 200 }),
          );
        }
        if (url === "/api/v1/settings") {
          return Promise.resolve(
            new Response(JSON.stringify({ base_url: "", api_key: "", api_key_configured: false, model_name: "", max_tokens: 8192, context_window: 0, context_window_source: "catalog", safety_reserve_ratio: 0.05, safety_reserve_tokens: 16384, compaction_trigger_ratio: 0.85, compaction_target_ratio: 0.60, available_input_tokens: 0, advanced: { temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false } }), { status: 200 }),
          );
        }
        if (url === "/api/v1/vendors") {
          return Promise.resolve(new Response(JSON.stringify({ vendors: [] }), { status: 200 }));
        }
        if (url === "/api/v1/skills") {
          return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }));
        }
        if (url === "/api/v1/tasks?limit=10") {
          if (historyFailure) {
            return Promise.reject(new Error("history unavailable"));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                active_items: [
                  {
                    task_id: "task_active",
                    mode: "agent",
                    databases: [],
                    title: "Active task",
                    status: "running",
                    active_run_id: "run_active",
                    created_at: "2026-07-14T00:00:00Z",
                    updated_at: "2026-07-14T00:00:00Z",
                    latest_sequence: 6,
                  },
                ],
                items: [],
                next_cursor: null,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes startup history while keeping the blank new draft", async () => {
    const view = render(<App />);
    await waitFor(() =>
      expect(useAgentStore.getState().activeItems).toEqual(["task_active"]),
    );

    expect(useAgentStore.getState().activeTaskId).toBeNull();
    expect(useAgentStore.getState().draft.input).toBe("");
    act(() => FakeWebSocket.latest.open());
    expect(FakeWebSocket.latest.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "subscribe", task_id: "task_active", after_sequence: 6 },
    ]);

    view.unmount();
    expect(FakeWebSocket.latest.closed).toBe(true);
    expect(useAgentStore.getState().tasksById.task_active.summary.status).toBe(
      "running",
    );
    expect(useAgentStore.getState().connectionStatus).toBe("disconnected");
  });

  it("bounds the App viewport chain for non-chat tab scrolling", async () => {
    const { container } = render(<App />);
    await waitFor(() =>
      expect(useAgentStore.getState().activeItems).toEqual(["task_active"]),
    );

    const sidebarWrapper = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    );
    const sidebarInset = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-inset"]',
    );
    const header = sidebarInset?.querySelector<HTMLElement>(":scope > header");
    const contentMain = sidebarInset?.querySelector<HTMLElement>(":scope > main");
    const chatPanelWrapper = contentMain?.firstElementChild;

    expect(sidebarWrapper).toHaveClass(
      "h-svh",
      "min-h-0",
      "overflow-hidden",
    );
    expect(sidebarInset).toHaveClass("min-h-0", "overflow-hidden");
    expect(header).toHaveClass("shrink-0");
    expect(contentMain).toHaveClass("min-h-0");
    expect(chatPanelWrapper).toHaveClass("min-h-0");
  });

  it("shows a visible error when startup history loading fails", async () => {
    historyFailure = true;
    render(<App />);
    act(() => FakeWebSocket.latest.open());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "会话历史加载失败",
        expect.objectContaining({ description: "history unavailable" }),
      ),
    );
  });

  it("opens and closes settings without replacing the task workspace", async () => {
    render(<App />);
    await waitFor(() => expect(useAgentStore.getState().activeItems).toEqual(["task_active"]));
    fireEvent.click(screen.getAllByRole("button", { name: "打开设置" })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(useAgentStore.getState().activeTaskId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useAgentStore.getState().tasksById.task_active).toBeDefined();
  });
});
