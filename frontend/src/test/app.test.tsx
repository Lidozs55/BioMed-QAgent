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
            new Response(JSON.stringify({ base_url: "", api_key: "", model_name: "", max_tokens: 8192, temperature: 0.7, top_p: 1.0, repetition_penalty: 1.0, enable_search: false, thinking_mode: false }), { status: 200 }),
          );
        }
        if (url === "/api/v1/vendors") {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
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

  it("catches model change rejection with toast.error and no unhandled promise", async () => {
    // Override fetch so POST /api/v1/settings fails (simulates a rejected model change)
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/databases") {
          return Promise.resolve(
            new Response(JSON.stringify({ databases: [] }), { status: 200 }),
          );
        }
        if (url === "/api/v1/settings" && (!init || init.method !== "POST")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                base_url: "https://test.url",
                api_key: "sk-real",
                model_name: "qwen-plus",
                max_tokens: 8192,
                temperature: 0.7, top_p: 1.0,
                repetition_penalty: 1.0,
                enable_search: false,
                thinking_mode: false,
              }),
              { status: 200 },
            ),
          );
        }
        if (url === "/api/v1/settings" && init?.method === "POST") {
          return Promise.reject(new Error("模型不可用"));
        }
        if (url === "/api/v1/vendors") {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        if (url === "/api/v1/tasks?limit=10") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                active_items: [{ task_id: "task_active", mode: "agent", databases: [], title: "Active task", status: "running", active_run_id: "run_active", created_at: "2026-07-14T00:00:00Z", updated_at: "2026-07-14T00:00:00Z", latest_sequence: 6 }],
                items: [],
                next_cursor: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("/api/v1/models")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ id: "qwen-plus", name: "Qwen Plus", description: "Balanced", context_window: 131072, suggested_max_tokens: 8192, capabilities: { text: true, image: false, video: false, audio: false }, recommended: true, api_available: true, capability_source: "api" }],
                total_count: 1,
                api_source: null,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);

    // Wait for the model selector button to appear (settings + models loaded)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /当前模型|点击选择模型/ })).toBeVisible();
    });

    // Open the model dropdown
    fireEvent.click(screen.getByRole("button", { name: /当前模型|点击选择模型/ }));

    // Click the "Qwen Plus 推荐" model option inside the dropdown
    const optionBtns = await screen.findAllByRole("button", { name: /Qwen Plus/ });
    // The dropdown option has text "Qwen Plus 推荐"; the toggle has aria-label "当前模型 Qwen Plus，点击切换"
    const dropdownOption = optionBtns.find(
      (btn) => btn.textContent?.includes("推荐"),
    );
    expect(dropdownOption).toBeDefined();
    fireEvent.click(dropdownOption!);

    // The model change should trigger POST /api/v1/settings which fails.
    // handleModelChange catches the rejection and shows toast.error.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "模型选择失败",
        expect.objectContaining({ description: "模型不可用" }),
      );
    });

    // Verify no unhandled promise rejection leaked to console.error
    const unhandledCalls = errorSpy.mock.calls.filter(
      (args) => String(args[0]).includes("Unhandled") || String(args[0]).toLowerCase().includes("rejection"),
    );
    expect(unhandledCalls).toHaveLength(0);

    errorSpy.mockRestore();
  });

  it("coexists with settings integration without breaking startup or history", async () => {
    const view = render(<App />);
    await waitFor(() =>
      expect(useAgentStore.getState().activeItems).toEqual(["task_active"]),
    );
    expect(useAgentStore.getState().activeTaskId).toBeNull();
    expect(useAgentStore.getState().draft.input).toBe("");

    // Sidebar renders both settings and export buttons
    expect(screen.getByRole("button", { name: "打开设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出本地缓存为 ZIP" })).toBeVisible();

    // Header has unique ThemeToggle and ArtifactPanelToggle
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Toggle theme" })).toHaveLength(1);

    view.unmount();
  });
});
