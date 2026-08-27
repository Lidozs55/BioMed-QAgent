import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { UserInputDialog } from "@/components/UserInputDialog";
import type { APIClient } from "@/hooks/useAPI";
import type {
  EventEnvelope,
  MessageRecord,
  RunRecord,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import { RuntimeController } from "@/runtime/controller";
import { createInitialRuntimeState } from "@/runtime/reducer";
import {
  AgentEventTransport,
  type SocketFactory,
  type WebSocketLike,
} from "@/runtime/transport";
import { useAgentStore } from "@/stores/agentStore";

// T5 (Phase 4c) end-to-end: the FULL user-visible data_correction flow through
// the REAL frontend runtime path — AgentEventTransport over a WebSocket-shaped
// socket + the real store reducer + the real RuntimeController.resumeRun +
// the rendered UserInputDialog:
//
//   live user_input_required(data_correction) → dialog opens with the pending
//   correction → user types + submits → controller.resumeRun posts the
//   approve/correction payload → user_input_resumed + run_completed arrive
//   over the socket → dialog closes and the Run is COMPLETED.
//
// This is the frontend twin of the server-side approval-gate E2E in
// server/tests/phase5/approval-gate.test.ts. The transport layer
// (envelope validation, subscribe command, applyEvent dispatch) is the real
// implementation — only the socket itself is faked.

const CREATED_AT = "2026-07-14T00:00:00Z";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof value === "string" ? value : JSON.stringify(value),
      }),
    );
  }
}

function summary(
  taskId: string,
  status: TaskSummary["status"] = "running",
  latestSequence = 0,
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: `Task ${taskId}`,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: latestSequence,
  };
}

function runRecord(
  taskId: string,
  status: RunRecord["status"],
  finishedAt: string | null = null,
): RunRecord {
  return {
    run_id: `run_${taskId}`,
    task_id: taskId,
    request_id: `request_${taskId}`,
    status,
    input: "question",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    started_at: CREATED_AT,
    finished_at: finishedAt,
    error: null,
  };
}

function envelope(
  taskId: string,
  sequence: number,
  payload: EventEnvelope["payload"],
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: payload.type,
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload,
  } as EventEnvelope;
}

function dataCorrectionRequired(
  taskId: string,
  sequence: number,
): EventEnvelope {
  return envelope(taskId, sequence, {
    type: "user_input_required",
    request_id: "data_correction-run_e2e-0",
    prompt_kind: "data_correction",
    summary: "候选 GSE 无法判断，请确认使用哪个数据集？",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    fixture_exempt: false,
    detail: { field: "dataset_id", options: ["GSE100500", "GSE12345"] },
  });
}

function api(overrides: Partial<APIClient> = {}): APIClient {
  return {
    fetchDatabases: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue({ active_items: [], items: [], next_cursor: null } as TaskPage),
    fetchTask: vi.fn(),
    fetchMessages: vi.fn(),
    fetchEvents: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    startImportTask: vi.fn(),
    continueTask: vi.fn(),
    cancelRun: vi.fn(),
    cancelSubagent: vi.fn(),
    compactTask: vi.fn(),
    injectTaskContext: vi.fn(),
    resumeRun: vi.fn(),
    resolvePermission: vi.fn(),
    resumeDownload: vi.fn(),
    cancelDownload: vi.fn(),
    deleteTask: vi.fn(),
    fetchArtifacts: vi.fn().mockResolvedValue([]),
    getArtifactUrl: vi.fn(),
    getCacheExportUrl: vi.fn(),
    fetchCacheDatasets: vi.fn().mockResolvedValue({ items: [] }),
    deleteCacheDataset: vi.fn().mockResolvedValue(undefined),
    clearCacheDatasets: vi.fn().mockResolvedValue(0),
    fetchPublications: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    fetchPublication: vi.fn(),
    getPublicationArtifactUrl: vi.fn(),
    ...overrides,
  };
}

function setupTransport(sockets: FakeSocket[]): AgentEventTransport {
  const socketFactory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return new AgentEventTransport({
    socketFactory,
    getLastSequence: (taskId) =>
      useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0,
    applyEvent: (event) => useAgentStore.getState().applyEvent(event),
    applyAssistantStreamFrames: () => undefined,
    deactivateAssistantStreams: () => undefined,
    setConnectionStatus: (status) =>
      useAgentStore.getState().setConnectionStatus(status),
    reconnectDelayMs: 10,
  });
}

function ActiveTaskDialog({ controller }: { controller: RuntimeController }) {
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const task = useAgentStore((state) =>
    activeTaskId !== null ? state.tasksById[activeTaskId] : undefined,
  );
  return (
    <UserInputDialog
      task={task}
      onResumeRun={(taskId, runId, input) =>
        controller.resumeRun(taskId, runId, input)
      }
    />
  );
}

describe("data_correction end-to-end (real transport + reducer + controller + dialog)", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("runs the full user-visible flow: live prompt → submit correction → resumed → COMPLETED", async () => {
    const taskId = "task_e2e";
    const runId = `run_${taskId}`;
    const sockets: FakeSocket[] = [];

    // 1) Seed an active running task so the dialog harness can select it.
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary(taskId, "running", 0)],
        items: [],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().setActiveTaskId(taskId);

    const resumeSnapshot = vi.fn(
      (): Promise<TaskSnapshot> =>
        Promise.resolve({
          task: summary(taskId, "running", 2),
          runs: [runRecord(taskId, "running")],
          messages: [] as MessageRecord[],
          older_messages_cursor: null,
        }),
    );
    const transport = setupTransport(sockets);
    const controller = new RuntimeController(
      api({ resumeRun: resumeSnapshot }),
      transport,
    );

    // 2) Real transport: connect and subscribe (the app subscribes active tasks).
    const connecting = transport.connect();
    const socket = sockets[0];
    transport.subscribe(taskId, 0);
    socket.open();
    await connecting;

    // 3) Live data_correction prompt arrives over the WebSocket-shaped socket.
    act(() => {
      socket.message(dataCorrectionRequired(taskId, 1));
    });
    expect(useAgentStore.getState().tasksById[taskId]).toMatchObject({
      pendingUserInput: {
        runId,
        requestId: "data_correction-run_e2e-0",
        promptKind: "data_correction",
      },
    });
    expect(useAgentStore.getState().tasksById[taskId].summary.status).toBe(
      "awaiting_user_input",
    );

    // 4) Render the real dialog bound to the store's active task.
    const { rerender } = render(
      <ActiveTaskDialog controller={controller} />,
    );
    expect(screen.getByText("需要人工修正")).toBeVisible();
    expect(
      screen.getByText("候选 GSE 无法判断，请确认使用哪个数据集？"),
    ).toBeVisible();

    // 5) User types the correction and submits.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GEO 数据 GSE12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修正" }));
    await waitFor(() => expect(resumeSnapshot).toHaveBeenCalledTimes(1));
    expect(resumeSnapshot).toHaveBeenCalledWith(taskId, runId, {
      request_id: "data_correction-run_e2e-0",
      decision: "approve",
      detail: { correction: "改用 GEO 数据 GSE12345" },
    });
    // The resume API snapshot (run back to RUNNING) clears the pending prompt.
    await waitFor(() => {
      expect(
        useAgentStore.getState().tasksById[taskId].pendingUserInput,
      ).toBeNull();
    });
    rerender(<ActiveTaskDialog controller={controller} />);

    // 6) The durable chain continues over the socket: resumed → COMPLETED.
    act(() => {
      socket.message(
        envelope(taskId, 2, {
          type: "user_input_resumed",
          request_id: "data_correction-run_e2e-0",
          decision: "approve",
          detail: { correction: "改用 GEO 数据 GSE12345" },
        }),
      );
      socket.message(envelope(taskId, 3, { type: "run_completed" }));
    });

    expect(
      useAgentStore.getState().tasksById[taskId].summary.status,
    ).toBe("completed");
    expect(
      useAgentStore.getState().tasksById[taskId].runsById[runId].status,
    ).toBe("completed");
    // The dialog closed once the Run left AWAITING_USER_INPUT.
    rerender(<ActiveTaskDialog controller={controller} />);
    expect(screen.queryByText("需要人工修正")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
