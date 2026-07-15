import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

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
        if (url === "/api/v1/tasks?limit=30") {
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
});
