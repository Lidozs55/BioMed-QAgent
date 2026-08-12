import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { EventEnvelope } from "@biomed/contracts";

import { ExperimentalPiApp } from "@/experimental/pi/ExperimentalPiApp";
import { ExperimentalPiClient } from "@/experimental/pi/client";
import { experimentalPiUiEnabled } from "@/experimental/pi/config";
import {
  applyExperimentalEvent,
  createExperimentalPiState,
  markExperimentalDisconnected,
  recordAcceptedRun,
} from "@/experimental/pi/state";
import type {
  ExperimentalPiLiveHandlers,
  ExperimentalPiLiveTransport,
} from "@/experimental/pi/transport";
import { ExperimentalPiWebSocketTransport } from "@/experimental/pi/transport";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

function envelope(
  sequence: number,
  runId: string,
  payload: EventEnvelope["payload"],
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event-${sequence}`,
    type: payload.type,
    task_id: "task-live",
    run_id: runId,
    stage_attempt_id: null,
    sequence,
    timestamp: "2026-08-12T00:00:00.000Z",
    payload,
  };
}

describe("experimental Pi frontend isolation", () => {
  test("stays off unless build or runtime configuration explicitly opts in", () => {
    expect(experimentalPiUiEnabled(undefined, undefined)).toBe(false);
    expect(experimentalPiUiEnabled("0", false)).toBe(false);
    expect(experimentalPiUiEnabled("1", false)).toBe(true);
    expect(experimentalPiUiEnabled("0", true)).toBe(true);
  });

  test("uses only the dedicated experimental HTTP surface for create, multi-turn, and cancel", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task_id: "task-live",
            run_id: "run-1",
            session_id: "pi-session",
            status: "running",
            durable: false,
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task_id: "task-live",
            run_id: "run-2",
            session_id: "pi-session",
            status: "running",
            durable: false,
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task_id: "task-live",
            run_id: "run-2",
            status: "cancel_requested",
          }),
          { status: 202 },
        ),
      );
    const client = new ExperimentalPiClient(fetcher);

    const first = await client.createTask("first");
    const second = await client.createRun(first.task_id, "second");
    await client.cancelRun(second.task_id, second.run_id);

    expect(first.session_id).toBe(second.session_id);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/experimental/pi/tasks",
      "/experimental/pi/tasks/task-live/runs",
      "/experimental/pi/tasks/task-live/runs/run-2/cancel",
    ]);
    expect(fetcher.mock.calls.some(([input]) => String(input).startsWith("/api/v1"))).toBe(false);
  });

  test("subscribes without replay state and surfaces live disconnects", async () => {
    class FakeSocket {
      readyState: number = WebSocket.CONNECTING;
      sent: string[] = [];
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      send(frame: string) {
        this.sent.push(frame);
      }

      close() {
        this.readyState = WebSocket.CLOSED;
      }

      open() {
        this.readyState = WebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      disconnect() {
        this.readyState = WebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }
    const socket = new FakeSocket();
    const onDisconnect = vi.fn();
    const onConnection = vi.fn();
    const transport = new ExperimentalPiWebSocketTransport(
      {
        onEvent: vi.fn(),
        onControl: vi.fn(),
        onConnection,
        onDisconnect,
      },
      () => socket as unknown as WebSocket,
    );

    const connected = transport.connect();
    socket.open();
    await connected;
    transport.subscribe("task-live");
    socket.disconnect();

    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "subscribe", task_id: "task-live" },
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain("after_sequence");
    expect(onConnection).toHaveBeenLastCalledWith("disconnected");
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  test("projects assistant/tool flow, typed failure, and disconnect limitation separately", () => {
    let state = createExperimentalPiState();
    state = recordAcceptedRun(state, {
      task_id: "task-live",
      run_id: "run-1",
      session_id: "pi-session",
      status: "running",
      durable: false,
    }, "find data");
    state = applyExperimentalEvent(
      state,
      envelope(1, "run-1", { type: "assistant_delta", delta: "hello " }),
    );
    state = applyExperimentalEvent(
      state,
      envelope(2, "run-1", { type: "assistant_delta", delta: "world" }),
    );
    state = applyExperimentalEvent(
      state,
      envelope(3, "run-1", {
        type: "tool_started",
        tool_call_id: "call-1",
        tool_name: "workspace_read",
        arguments: { path: "parsed/data.csv" },
      }),
    );
    state = applyExperimentalEvent(
      state,
      envelope(4, "run-1", {
        type: "tool_completed",
        tool_call_id: "call-1",
        tool_name: "workspace_read",
        output_digest: null,
        output: "done",
        is_error: true,
      }),
    );
    state = applyExperimentalEvent(
      state,
      envelope(5, "run-1", {
        type: "run_failed",
        error: "Experimental Pi turn failed",
        error_code: "internal_error",
      }),
    );
    state = markExperimentalDisconnected(state);

    expect(state.runs[0]).toMatchObject({
      assistant: "hello world",
      status: "failed",
      error: "Experimental Pi turn failed",
    });
    expect(state.runs[0]?.tools[0]).toMatchObject({
      toolCallId: "call-1",
      status: "error",
      output: "done",
    });
    expect(state.connection).toBe("disconnected");
    expect(state.liveGap).toBe(true);
  });

  test("projects real Dataset Core publication references and structured rejection", () => {
    let success = recordAcceptedRun(createExperimentalPiState(), {
      task_id: "task-live",
      run_id: "run-success",
      session_id: "fixture-session",
      status: "running",
      durable: false,
    }, "run dataset_success");
    success = applyExperimentalEvent(success, envelope(1, "run-success", {
      type: "tool_started",
      tool_call_id: "fixture-execute",
      tool_name: "execute_dataset_build",
      arguments: {},
    }));
    success = applyExperimentalEvent(success, envelope(2, "run-success", {
      type: "tool_completed",
      tool_call_id: "fixture-execute",
      tool_name: "execute_dataset_build",
      output_digest: null,
      output: JSON.stringify({
        code: "ok",
        data: {
          build_id: "golden_succeeded",
          publication_id: "pub_actual",
          manifest: { manifest_id: "manifest_actual" },
          artifacts: ["[truncated]"],
        },
      }),
      is_error: false,
    }));
    success = applyExperimentalEvent(success, envelope(3, "run-success", {
      type: "assistant_delta",
      delta: "DatasetBuild golden_succeeded SUCCEEDED. Publication pub_actual. Manifest manifest_actual. Artifact artifact_actual.",
    }));

    expect(success.runs[0]?.datasetBuild).toEqual({
      status: "succeeded",
      buildId: "golden_succeeded",
      publicationId: "pub_actual",
      manifestId: "manifest_actual",
      artifactId: "artifact_actual",
      reasonCodes: [],
    });

    let rejected = recordAcceptedRun(createExperimentalPiState(), {
      task_id: "task-live",
      run_id: "run-rejected",
      session_id: "fixture-session",
      status: "running",
      durable: false,
    }, "run spec_rejected");
    rejected = applyExperimentalEvent(rejected, envelope(1, "run-rejected", {
      type: "tool_started",
      tool_call_id: "fixture-validate",
      tool_name: "validate_dataset_build",
      arguments: {},
    }));
    rejected = applyExperimentalEvent(rejected, envelope(2, "run-rejected", {
      type: "tool_completed",
      tool_call_id: "fixture-validate",
      tool_name: "validate_dataset_build",
      output_digest: null,
      output: JSON.stringify({ code: "spec_rejected", reason_codes: ["unknown_schema"] }),
      is_error: true,
    }));

    expect(rejected.runs[0]?.datasetBuild).toEqual({
      status: "spec_rejected",
      buildId: null,
      publicationId: null,
      manifestId: null,
      artifactId: null,
      reasonCodes: ["unknown_schema"],
    });
  });

  test("renders create/live tool/cancel/multi-turn without mutating the legacy store", async () => {
    useAgentStore.setState(createInitialRuntimeState());
    const legacyBefore = useAgentStore.getState();
    const createTask = vi.fn(async () => ({
      task_id: "task-live",
      run_id: "run-1",
      session_id: "pi-session",
      status: "running" as const,
      durable: false as const,
    }));
    const createRun = vi.fn(async () => ({
      task_id: "task-live",
      run_id: "run-2",
      session_id: "pi-session",
      status: "running" as const,
      durable: false as const,
    }));
    const cancelRun = vi.fn(async () => ({
      task_id: "task-live",
      run_id: "run-2",
      status: "cancel_requested" as const,
    }));
    let handlers!: ExperimentalPiLiveHandlers;
    const transport: ExperimentalPiLiveTransport = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(),
      disconnect: vi.fn(),
    };
    render(
      <ExperimentalPiApp
        api={{ createTask, createRun, cancelRun }}
        transportFactory={(nextHandlers) => {
          handlers = nextHandlers;
          return transport;
        }}
      />,
    );

    expect(screen.getByText("Pi 实验模式")).toBeInTheDocument();
    expect(screen.getByText(/仅实时展示，不支持断线回放/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("实验消息"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith("first"));
    expect(transport.subscribe).toHaveBeenCalledWith("task-live");

    act(() => {
      handlers.onEvent(
        envelope(1, "run-1", { type: "assistant_delta", delta: "live answer" }),
      );
      handlers.onEvent(
        envelope(2, "run-1", {
          type: "tool_started",
          tool_call_id: "call-1",
          tool_name: "workspace_read",
          arguments: { path: "parsed/data.csv" },
        }),
      );
      handlers.onEvent(
        envelope(3, "run-1", {
          type: "tool_completed",
          tool_call_id: "call-1",
          tool_name: "workspace_read",
          output: "2 rows",
          output_digest: null,
          is_error: false,
        }),
      );
      handlers.onEvent(
        envelope(4, "run-1", {
          type: "tool_started",
          tool_call_id: "fixture-execute",
          tool_name: "execute_dataset_build",
          arguments: {},
        }),
      );
      handlers.onEvent(
        envelope(5, "run-1", {
          type: "tool_completed",
          tool_call_id: "fixture-execute",
          tool_name: "execute_dataset_build",
          output: JSON.stringify({
            code: "ok",
            data: {
              build_id: "golden_succeeded",
              publication_id: "pub_actual",
              manifest: { manifest_id: "manifest_actual" },
            },
          }),
          output_digest: null,
          is_error: false,
        }),
      );
      handlers.onEvent(
        envelope(6, "run-1", {
          type: "assistant_delta",
          delta: " Publication pub_actual. Manifest manifest_actual. Artifact artifact_actual.",
        }),
      );
      handlers.onEvent(
        envelope(7, "run-1", { type: "run_completed", build_result: null }),
      );
    });
    expect(await screen.findByText(/live answer/)).toBeInTheDocument();
    expect(screen.getByText("workspace_read")).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
    expect(screen.getByText("DatasetBuild 已发布")).toBeInTheDocument();
    expect(screen.getAllByText(/pub_actual.*manifest_actual.*artifact_actual/)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("实验消息"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(createRun).toHaveBeenCalledWith("task-live", "second"));
    fireEvent.click(screen.getByRole("button", { name: "取消当前轮次" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("task-live", "run-2"));

    expect(useAgentStore.getState()).toEqual(legacyBefore);
  });
});
