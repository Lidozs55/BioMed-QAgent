import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantStreamFrame,
  EventEnvelope,
  TaskSummary,
} from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import {
  AgentEventTransport,
  type SocketFactory,
  type WebSocketLike,
} from "@/runtime/transport";
import { useAgentStore } from "@/stores/agentStore";

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

  abnormalClose(code = 1013): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

function summary(
  taskId: string,
  latestSequence = 0,
  status: TaskSummary["status"] = "running",
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: latestSequence,
  };
}

function event(taskId: string, sequence: number, delta: string): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "assistant_delta",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    payload: { type: "assistant_delta", delta },
  };
}

interface TransportTestOptions {
  applyAssistantStreamFrames?: (frames: readonly AssistantStreamFrame[]) => void;
  deactivateAssistantStreams?: (taskId?: string) => void;
  scheduleAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  shouldSubscribe?: (taskId: string) => boolean;
  onPermanentGap?: (taskId: string) => void;
}

function setupTransport(options: TransportTestOptions = {}) {
  const sockets: FakeSocket[] = [];
  const socketFactory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const controlErrors: unknown[] = [];
  const transport = new AgentEventTransport({
    socketFactory,
    getLastSequence: (taskId) =>
      useAgentStore.getState().tasksById[taskId]?.lastSequence ?? 0,
    applyEvent: (incoming) => useAgentStore.getState().applyEvent(incoming),
    applyAssistantStreamFrames:
      options.applyAssistantStreamFrames ?? (() => undefined),
    deactivateAssistantStreams:
      options.deactivateAssistantStreams ?? (() => undefined),
    setConnectionStatus: (status) =>
      useAgentStore.getState().setConnectionStatus(status),
    onControlError: (frame) => controlErrors.push(frame),
    scheduleAnimationFrame: options.scheduleAnimationFrame,
    cancelAnimationFrame: options.cancelAnimationFrame,
    reconnectDelayMs: 10,
    shouldSubscribe: options.shouldSubscribe,
    onPermanentGap: options.onPermanentGap,
  });
  return { transport, sockets, controlErrors };
}

describe("durable event transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentStore.setState(createInitialRuntimeState());
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("task_a"), summary("task_b", 3)],
        items: [],
        next_cursor: null,
      },
      false,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes one desired subscription after open and never sends a run command", async () => {
    const { transport, sockets } = setupTransport();
    const connected = transport.connect();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_a", 0);

    sockets[0].open();
    await connected;

    expect(sockets[0].sent.map((item) => JSON.parse(item))).toEqual([
      { type: "subscribe", task_id: "task_a", after_sequence: 0 },
    ]);
    expect(sockets[0].sent.join("\n")).not.toContain('"type":"run"');
  });

  it("honors the requested baseline before a task projection exists", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_not_loaded", 11);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: "subscribe",
      task_id: "task_not_loaded",
      after_sequence: 11,
    });
  });

  it("honors the requested baseline on an already-open socket", async () => {
    const { transport, sockets } = setupTransport();
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    transport.subscribe("task_not_loaded", 12);

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: "subscribe",
      task_id: "task_not_loaded",
      after_sequence: 12,
    });
  });

  it("allows an existing desired subscription baseline to move forward", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    transport.subscribe("task_a", 8);
    sockets[0].abnormalClose(1013);
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].open();

    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      type: "subscribe",
      task_id: "task_a",
      after_sequence: 8,
    });
  });

  it("dispatches durable envelopes but keeps pong and control errors out of the reducer", async () => {
    const { transport, sockets, controlErrors } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    const pong = transport.ping();

    sockets[0].message(event("task_a", 1, "A"));
    sockets[0].message({
      type: "error",
      code: "task_not_found",
      message: "Task not found",
      task_id: "task_missing",
    });
    sockets[0].message(event("task_b", 4, "B"));
    sockets[0].message({ type: "pong" });
    await pong;

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
    expect(useAgentStore.getState().tasksById.task_b.lastSequence).toBe(4);
    expect(controlErrors).toHaveLength(1);
  });

  it("unsubscribes a task whose last run becomes terminal and never resubscribes it on reconnect", async () => {
    const { transport, sockets } = setupTransport({
      shouldSubscribe: (taskId) =>
        useAgentStore.getState().activeItems.includes(taskId),
    });
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    // task_a's only run completes → the task leaves activeItems.
    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_task_a_done",
      type: "run_completed",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: { type: "run_completed", build_result: null },
    });

    expect(transport.isSubscribed("task_a")).toBe(false);
    expect(transport.isSubscribed("task_b")).toBe(true);
    expect(
      sockets[0].sent.some((raw) => {
        const command = JSON.parse(raw);
        return command.type === "unsubscribe" && command.task_id === "task_a";
      }),
    ).toBe(true);

    // Reconnect: only the still-active task may be resubscribed.
    sockets[0].abnormalClose(1013);
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].open();

    const commands = sockets[1].sent.map((raw) => JSON.parse(raw));
    expect(commands).not.toContainEqual(
      expect.objectContaining({ type: "subscribe", task_id: "task_a" }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "subscribe", task_id: "task_b" }),
    );
  });

  it("accepts backend operation lifecycle envelopes without crashing or changing state (F4)", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const before = useAgentStore.getState().tasksById.task_a;

    const operationEnvelope = (
      type: string,
      sequence: number,
      payload: Record<string, unknown>,
    ) => ({
      schema_version: "2.0",
      event_id: `event_task_a_${sequence}`,
      type,
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence,
      timestamp: `2026-07-14T00:00:${String(sequence).padStart(2, "0")}Z`,
      payload: { type, ...payload },
    });

    sockets[0].message(
      operationEnvelope("operation_started", 1, {
        operation_id: "op-1",
        label: "build skeleton",
        category: "build",
        attempt: 1,
      }),
    );
    sockets[0].message(
      operationEnvelope("operation_progress", 2, {
        operation_id: "op-1",
        kind: "rows_parsed",
        current: 42,
        total: 100,
        detail: {},
      }),
    );
    sockets[0].message(
      operationEnvelope("operation_completed", 3, {
        operation_id: "op-1",
        status: "succeeded",
        output_digest: "a".repeat(64),
        reused_operation_attempt_id: null,
      }),
    );
    sockets[0].message(
      operationEnvelope("operation_failed", 4, {
        operation_id: "op-1",
        status: "failed",
        error: null,
      }),
    );

    const after = useAgentStore.getState().tasksById.task_a;
    // Informational frames: the cursor advances but no projection changes.
    expect(after.lastSequence).toBe(4);
    expect(after.sequenceGap).toBeNull();
    expect(after.messages).toEqual(before.messages);
    expect(after.runsById).toEqual(before.runsById);
    expect(after.activityOrder).toEqual(before.activityOrder);
    expect(after.summary.status).toBe(before.summary.status);
  });

  it("accepts publication_created on the live path and keeps the cursor moving", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_task_a_1",
      type: "publication_created",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: {
        type: "publication_created",
        publication_id: "pub-1",
        run_id: "run_task_a",
        manifest_sha256: "a".repeat(64),
        supersedes_publication_id: null,
        published_at: "2026-07-14T00:00:01Z",
      },
    });

    const task = useAgentStore.getState().tasksById.task_a;
    expect(task.currentPublicationId).toBe("pub-1");
    expect(task.lastSequence).toBe(1);

    // A later terminal event must still be applied after the publication.
    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_task_a_2",
      type: "run_completed",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 2,
      timestamp: "2026-07-14T00:00:02Z",
      payload: { type: "run_completed", build_result: null },
    });

    const after = useAgentStore.getState().tasksById.task_a;
    expect(after.lastSequence).toBe(2);
    expect(after.summary.status).toBe("completed");
  });

  it("detects a sequence gap and re-subscribes after the last applied sequence", async () => {
    const { transport, sockets } = setupTransport();
    // Seed task_a at lastSequence 4 (events 1..4 already applied).
    useAgentStore.getState().applyEvent(event("task_a", 1, "one"));
    useAgentStore.getState().applyEvent(event("task_a", 2, "two"));
    useAgentStore.getState().applyEvent(event("task_a", 3, "three"));
    useAgentStore.getState().applyEvent(event("task_a", 4, "four"));
    transport.subscribe("task_a", 4);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    // A frame at 5 was dropped or rejected; the next valid frame is 6.
    // The event must not be reduced and the cursor must not advance.
    sockets[0].message(event("task_a", 6, "jumped"));

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(4);
    expect(useAgentStore.getState().tasksById.task_a.messages[0]?.content).toBe(
      "onetwothreefour",
    );
    expect(useAgentStore.getState().tasksById.task_a.sequenceGap).toEqual({
      expected: 5,
      received: 6,
    });

    // Recovery requested: the socket is replaced and the fresh connection
    // re-subscribes after the last applied sequence (4).
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve();
    expect(sockets[1].sent.map((item) => JSON.parse(item))).toContainEqual({
      type: "subscribe",
      task_id: "task_a",
      after_sequence: 4,
    });

    // Replay 5 then 6 → both applied, cursor 6, gap healed.
    sockets[1].message(event("task_a", 5, "five"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(5);
    sockets[1].message(event("task_a", 6, "six"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(6);
    expect(useAgentStore.getState().tasksById.task_a.sequenceGap).toBeNull();
    sockets[1].message({ type: "pong" });
    await Promise.resolve();
  });

  it("re-arms gap recovery after a natural reconnect clears the recovery guard (F2)", async () => {
    const { transport, sockets } = setupTransport();
    // Seed task_a at lastSequence 4 (events 1..4 already applied). Frame 5
    // is permanently undeliverable; the first valid frame is 6.
    useAgentStore.getState().applyEvent(event("task_a", 1, "one"));
    useAgentStore.getState().applyEvent(event("task_a", 2, "two"));
    useAgentStore.getState().applyEvent(event("task_a", 3, "three"));
    useAgentStore.getState().applyEvent(event("task_a", 4, "four"));
    transport.subscribe("task_a", 4);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    // Gap at 6 → one socket-replacement recovery (sockets[1]).
    sockets[0].message(event("task_a", 6, "jumped"));
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve();

    // The replay cannot deliver frame 5, so the gap re-appears at the same
    // cursor. The bounded guard must NOT arm a second recovery yet.
    sockets[1].message(event("task_a", 6, "jumped"));
    expect(sockets).toHaveLength(2);
    sockets[1].message({ type: "pong" });
    await Promise.resolve();

    // A natural reconnect (server-side close) clears the recovery guard so
    // the next gap event can arm a fresh recovery on the new connection.
    sockets[1].abnormalClose(1013);
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    await Promise.resolve();

    // Without the F2 guard-clearing, this gap would be silently blocked;
    // with it, a fresh socket-replacement recovery is armed (sockets[3]).
    sockets[2].message(event("task_a", 6, "jumped"));
    expect(sockets).toHaveLength(4);
    sockets[3].open();
    await Promise.resolve();

    // The fresh replay can now deliver the missing frame → gap healed.
    sockets[3].message(event("task_a", 5, "five"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(5);
    sockets[3].message(event("task_a", 6, "six"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(6);
    expect(useAgentStore.getState().tasksById.task_a.sequenceGap).toBeNull();
    sockets[3].message({ type: "pong" });
    await Promise.resolve();
  });

  it("falls back to an authoritative snapshot when replay cannot heal a permanent gap (F2)", async () => {
    const onPermanentGap = vi.fn((taskId: string) => {
      // Controller-style fallback: rebuild the task authoritatively from a
      // REST snapshot (watermark 8 covers the undeliverable frame 5) and
      // resume the live subscription after that watermark.
      useAgentStore.getState().hydrateTaskSnapshot({
        task: summary(taskId, 8, "running"),
        runs: [],
        messages: [],
        older_messages_cursor: null,
      });
      void harness.transport.recoverSubscription(taskId, 8);
    });
    const harness = setupTransport({ onPermanentGap });
    const transport = harness.transport;
    const { sockets } = harness;
    useAgentStore.getState().applyEvent(event("task_a", 1, "one"));
    useAgentStore.getState().applyEvent(event("task_a", 2, "two"));
    useAgentStore.getState().applyEvent(event("task_a", 3, "three"));
    useAgentStore.getState().applyEvent(event("task_a", 4, "four"));
    transport.subscribe("task_a", 4);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    // Gap at 6 → first socket-replacement recovery (sockets[1]).
    sockets[0].message(event("task_a", 6, "jumped"));
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve();

    // The replay still cannot deliver frame 5 → the same gap re-appears;
    // one failed recovery alone must not trigger the snapshot fallback.
    sockets[1].message(event("task_a", 6, "jumped"));
    expect(onPermanentGap).not.toHaveBeenCalled();

    // A second failed recovery crosses the bounded threshold → fallback.
    sockets[1].message(event("task_a", 7, "seven"));
    expect(onPermanentGap).toHaveBeenCalledWith("task_a");
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(8);
    expect(useAgentStore.getState().tasksById.task_a.sequenceGap).toBeNull();

    // Settle the first recovery's pending ping so the queued resume runs.
    sockets[1].message({ type: "pong" });
    // The ping resolution unwinds through the control barrier queue across
    // several await boundaries before the resume replaces the socket.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    await Promise.resolve();

    // Valid events after the snapshot watermark are contiguous → applied.
    sockets[2].message(event("task_a", 9, "nine"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(9);
    expect(useAgentStore.getState().tasksById.task_a.sequenceGap).toBeNull();
    sockets[2].message({ type: "pong" });
    await Promise.resolve();
  });

  it("applies valid realtime frames once on the next animation frame without advancing sequence", async () => {
    const scheduled: Array<() => void> = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame: () => undefined,
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 0,
      delta: "你",
    });
    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 1,
      delta: "好🙂",
    });
    sockets[0].message({
      type: "assistant_stream_end",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      last_chunk_index: 1,
      finish_reason: "stop",
    });

    expect(batches).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(0);

    scheduled[0]();

    expect(batches).toHaveLength(1);
    expect(batches[0].map((frame) => frame.type)).toEqual([
      "assistant_stream_delta",
      "assistant_stream_delta",
      "assistant_stream_end",
    ]);
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(0);
  });

  it("strictly rejects malformed realtime frames and partial durable ranges", async () => {
    const scheduled: Array<() => void> = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame: () => undefined,
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const malformed = [
      {
        type: "assistant_stream_delta",
        task_id: "",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: 0,
        delta: "bad",
      },
      {
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: -1,
        delta: "bad",
      },
      {
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: 0,
        delta: "",
      },
      {
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: 0,
        delta: "bad",
        unexpected: true,
      },
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        last_chunk_index: 0.5,
        finish_reason: "stop",
      },
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        last_chunk_index: null,
        finish_reason: "",
      },
    ];
    for (const frame of malformed) sockets[0].message(frame);
    sockets[0].message({
      ...event("task_a", 1, "durable"),
      payload: {
        type: "assistant_delta",
        delta: "durable",
        stream_id: "assistant:run_task_a",
      },
    });

    expect(scheduled).toEqual([]);
    expect(batches).toEqual([]);
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(0);
  });

  it("accepts an all-null historical durable range but rejects mixed null metadata", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    sockets[0].message({
      ...event("task_a", 1, "legacy-null"),
      payload: {
        type: "assistant_delta",
        delta: "legacy-null",
        stream_id: null,
        from_chunk_index: null,
        through_chunk_index: null,
      },
    });
    sockets[0].message({
      ...event("task_a", 2, "invalid"),
      payload: {
        type: "assistant_delta",
        delta: "invalid",
        stream_id: null,
        from_chunk_index: 0,
        through_chunk_index: null,
      },
    });

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
    expect(
      useAgentStore.getState().tasksById.task_a.messages.find(
        (message) => message.runId === "run_task_a",
      )?.content,
    ).toBe("legacy-null");
  });

  it("rejects malformed subagent envelopes without advancing the replay cursor", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const queued = {
      schema_version: "2.0",
      event_id: "subagent_event_1",
      type: "subagent_queued",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      subagent_id: "subagent_1",
      parent_tool_call_id: "call_parent_1",
      sequence: 1,
      timestamp: CREATED_AT,
      payload: {
        type: "subagent_queued",
        subagent_id: "subagent_1",
        request: {
          agent_type: "source_research",
          objective: "Find datasets",
          target_source: null,
          domain: "genomics",
          capability: "dataset_search",
          inputs: {},
        },
      },
    };
    const terminal = {
      ...queued,
      type: "subagent_completed",
      payload: {
        type: "subagent_completed",
        subagent_id: "subagent_1",
        result: {
          subagent_id: "subagent_1",
          status: "completed",
          summary: "Done",
          source_asset_ids: ["source_1"],
          recipe_id: null,
          warnings: [],
          error_code: null,
          error_message: null,
        },
      },
    };
    const inputRequired = {
      ...queued,
      type: "subagent_input_required",
      payload: {
        type: "subagent_input_required",
        subagent_id: "subagent_1",
        request_id: "request_1",
        summary: "Approve source access",
        prompt_kind: "confirmation",
        expires_at: null,
        detail: {},
      },
    };

    const malformed = [
      { ...event("task_a", 1, "bad-link"), subagent_id: 7 },
      { ...event("task_a", 1, "blank-link"), subagent_id: "" },
      {
        ...queued,
        payload: {
          ...queued.payload,
          request: { ...queued.payload.request, agent_type: "unknown_agent" },
        },
      },
      {
        ...queued,
        payload: {
          ...queued.payload,
          request: { ...queued.payload.request, target_source: 7 },
        },
      },
      {
        ...terminal,
        payload: {
          ...terminal.payload,
          result: { ...terminal.payload.result, status: "failed" },
        },
      },
      {
        ...terminal,
        payload: {
          ...terminal.payload,
          result: { ...terminal.payload.result, source_asset_ids: [7] },
        },
      },
      {
        ...inputRequired,
        payload: {
          ...inputRequired.payload,
          prompt_kind: "invalid_prompt",
        },
      },
    ];
    for (const frame of malformed) sockets[0].message(frame);

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(0);
    sockets[0].message(queued);
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
  });

  it("normalizes omitted nullable subagent payload fields before reducing", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const envelope = {
      schema_version: "2.0",
      event_id: "legacy_subagent_1",
      type: "subagent_queued",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      subagent_id: "subagent_legacy",
      parent_tool_call_id: "call_parent_1",
      sequence: 1,
      timestamp: CREATED_AT,
      payload: {
        type: "subagent_queued",
        subagent_id: "subagent_legacy",
        request: {
          agent_type: "source_research",
          objective: "Find legacy datasets",
          domain: "genomics",
          capability: "dataset_search",
          inputs: {},
        },
      },
    };
    sockets[0].message(envelope);
    sockets[0].message({
      ...envelope,
      event_id: "legacy_subagent_2",
      type: "subagent_progress",
      sequence: 2,
      payload: {
        type: "subagent_progress",
        subagent_id: "subagent_legacy",
        current: 1,
      },
    });
    sockets[0].message({
      ...envelope,
      event_id: "legacy_subagent_3",
      type: "subagent_completed",
      sequence: 3,
      payload: {
        type: "subagent_completed",
        subagent_id: "subagent_legacy",
        result: {
          subagent_id: "subagent_legacy",
          status: "completed",
          summary: "Found one dataset",
          source_asset_ids: [],
          warnings: [],
        },
      },
    });

    const subagent = useAgentStore.getState().tasksById.task_a.subagentsById
      .subagent_legacy;
    expect(subagent).toMatchObject({
      targetSource: null,
      progressTotal: null,
      progressMessage: null,
      recipeId: null,
      errorCode: null,
      errorMessage: null,
    });
  });

  it("cancels a queued visual batch and deactivates streams on disconnect", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    let deactivateCount = 0;
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      deactivateAssistantStreams: () => {
        deactivateCount += 1;
      },
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return 41;
      },
      cancelAnimationFrame: (handle) => cancelled.push(handle),
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 0,
      delta: "pending",
    });

    transport.disconnect();
    scheduled[0]();

    expect(cancelled).toEqual([41]);
    expect(batches).toEqual([]);
    expect(deactivateCount).toBe(1);
  });

  it("commits a realtime batch to the store in one notification", () => {
    let notifications = 0;
    const unsubscribe = useAgentStore.subscribe(() => {
      notifications += 1;
    });

    useAgentStore.getState().applyAssistantStreamFrames([
      {
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: 0,
        delta: "A",
      },
      {
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: 1,
        delta: "B",
      },
    ]);

    unsubscribe();
    expect(notifications).toBe(1);
    expect(
      useAgentStore.getState().tasksById.task_a.messages.find(
        (message) => message.runId === "run_task_a",
      )?.content,
    ).toBe("AB");
  });

  it("bounds a suspended visual queue and lets durable coverage cancel it", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return 73;
      },
      cancelAnimationFrame: (handle) => cancelled.push(handle),
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    for (let chunkIndex = 0; chunkIndex < 3_000; chunkIndex += 1) {
      sockets[0].message({
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: chunkIndex,
        delta: "x",
      });
    }
    sockets[0].message({
      ...event("task_a", 1, "x".repeat(3_000)),
      payload: {
        type: "assistant_delta",
        delta: "x".repeat(3_000),
        stream_id: "assistant:run_task_a",
        from_chunk_index: 0,
        through_chunk_index: 2_999,
      },
    });
    scheduled[0]();

    expect(cancelled).toEqual([73]);
    expect(batches).toEqual([]);
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
    expect(
      useAgentStore.getState().tasksById.task_a.messages.find(
        (message) => message.runId === "run_task_a",
      )?.content,
    ).toBe("x".repeat(3_000));
  });

  it("keeps a stream end and the contiguous prefix when the visual queue is full", async () => {
    const scheduled: Array<() => void> = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return 74;
      },
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    for (let chunkIndex = 0; chunkIndex < 2_048; chunkIndex += 1) {
      sockets[0].message({
        type: "assistant_stream_delta",
        task_id: "task_a",
        run_id: "run_task_a",
        stream_id: "assistant:run_task_a",
        chunk_index: chunkIndex,
        delta: "x",
      });
    }
    sockets[0].message({
      type: "assistant_stream_end",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      last_chunk_index: 2_047,
      finish_reason: "stop",
    });
    scheduled[0]();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2_048);
    expect(batches[0][0]).toMatchObject({
      type: "assistant_stream_delta",
      chunk_index: 0,
    });
    expect(batches[0][batches[0].length - 1]).toMatchObject({
      type: "assistant_stream_end",
    });
  });

  it("drops a queued realtime delta when a durable tool boundary arrives first", async () => {
    const scheduled: Array<() => void> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) =>
        useAgentStore.getState().applyAssistantStreamFrames(frames),
      deactivateAssistantStreams: (taskId) =>
        useAgentStore.getState().deactivateAssistantStreams(taskId),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame: () => undefined,
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 0,
      delta: "stale",
    });
    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_tool_boundary",
      type: "tool_started",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: CREATED_AT,
      payload: {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      },
    });

    scheduled[0]();

    expect(
      useAgentStore.getState().tasksById.task_a.assistantStreamsByRunId
        .run_task_a,
    ).toBeUndefined();
  });

  it("cancels queued realtime frames when replay recovery replaces the socket", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    let deactivateCount = 0;
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      deactivateAssistantStreams: () => {
        deactivateCount += 1;
      },
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return 73;
      },
      cancelAnimationFrame: (handle) => cancelled.push(handle),
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 0,
      delta: "pending",
    });

    const recovery = transport.recoverSubscription("task_a", 0);
    scheduled[0]();

    expect(cancelled).toEqual([73]);
    expect(batches).toEqual([]);
    expect(deactivateCount).toBe(1);

    sockets[1].open();
    await Promise.resolve();
    sockets[1].message({ type: "pong" });
    await recovery;
  });

  it("reconnects after 1013 and resumes each task from its own current watermark", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      sockets[0].message(event("task_a", sequence, "latest"));
    }

    sockets[0].abnormalClose(1013);
    expect(useAgentStore.getState().connectionStatus).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    expect(useAgentStore.getState().connectionStatus).toBe("reconnecting");
    sockets[1].open();

    expect(sockets[1].sent.map((item) => JSON.parse(item))).toEqual([
      { type: "subscribe", task_id: "task_a", after_sequence: 8 },
      { type: "subscribe", task_id: "task_b", after_sequence: 3 },
    ]);
  });

  it("manual disconnect does not reconnect or mutate backend run status", async () => {
    const { transport, sockets } = setupTransport();
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    transport.disconnect();
    await vi.runAllTimersAsync();

    expect(sockets).toHaveLength(1);
    expect(useAgentStore.getState().connectionStatus).toBe("disconnected");
    expect(useAgentStore.getState().tasksById.task_a.summary.status).toBe(
      "running",
    );
  });

  it("rejects a pending connect and prevents a late socket open after disconnect", async () => {
    const { transport, sockets } = setupTransport();
    const connected = transport.connect();

    transport.disconnect();
    sockets[0].open();

    await expect(connected).rejects.toThrow("disconnected");
    expect(useAgentStore.getState().connectionStatus).toBe("disconnected");
    expect(sockets[0].sent).toEqual([]);
  });

  it("uses unsubscribe plus pong as a task-local snapshot barrier", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    sockets[0].message(event("task_a", 1, "before"));

    const barrier = transport.unsubscribeAndWait("task_a");
    sockets[0].message(event("task_a", 2, "queued"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(2);
    sockets[0].message({ type: "pong" });
    await barrier;
    sockets[0].message(event("task_a", 3, "too late"));

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(2);
    transport.subscribe("task_a", 2);
    expect(JSON.parse(sockets[0].sent.slice(-1)[0] ?? "{}")).toEqual({
      type: "subscribe",
      task_id: "task_a",
      after_sequence: 2,
    });
    sockets[0].message(event("task_a", 3, "replayed"));
    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(3);
  });

  it("discards realtime frames drained before the unsubscribe pong barrier", async () => {
    const scheduled: Array<() => void> = [];
    const batches: Array<readonly AssistantStreamFrame[]> = [];
    const { transport, sockets } = setupTransport({
      applyAssistantStreamFrames: (frames) => batches.push(frames),
      scheduleAnimationFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelAnimationFrame: () => undefined,
    });
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const barrier = transport.unsubscribeAndWait("task_a");
    sockets[0].message({
      type: "assistant_stream_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stream_id: "assistant:run_task_a",
      chunk_index: 0,
      delta: "drained",
    });
    sockets[0].message({ type: "pong" });
    await barrier;
    scheduled[0]();

    expect(batches).toEqual([]);
  });

  it("waits for an unsubscribe pong before replacing the socket for recovery", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const barrier = transport.unsubscribeAndWait("task_b");
    const recovery = transport.recoverSubscription("task_a", 0);
    const outcomes = [
      barrier.then(
        () => "fulfilled",
        () => "rejected",
      ),
      recovery.then(
        () => "fulfilled",
        () => "rejected",
      ),
    ];

    try {
      expect(sockets).toHaveLength(1);
      expect(sockets[0].readyState).toBe(1);
      expect(sockets[0].sent.map((item) => JSON.parse(item)).slice(-2)).toEqual([
        { type: "unsubscribe", task_id: "task_b" },
        { type: "ping" },
      ]);

      sockets[0].message({ type: "pong" });
      await barrier;
      expect(sockets).toHaveLength(2);
      transport.subscribe("task_b", 3);
      sockets[1].open();
      await Promise.resolve();
      expect(sockets[1].sent.map((item) => JSON.parse(item))).toEqual([
        { type: "subscribe", task_id: "task_a", after_sequence: 0 },
        { type: "subscribe", task_id: "task_b", after_sequence: 3 },
        { type: "ping" },
      ]);
      sockets[1].message({ type: "pong" });
      await recovery;

      expect(transport.isSubscribed("task_a")).toBe(true);
      expect(transport.isSubscribed("task_b")).toBe(true);
    } finally {
      transport.disconnect();
      await Promise.all(outcomes);
    }
  });

  it("expires a queued unsubscribe before a new disconnect-generation recovery", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const activeBarrier = transport.unsubscribeAndWait("task_a");
    const staleBarrier = transport.unsubscribeAndWait("task_b");
    const barrierOutcomes = [activeBarrier, staleBarrier].map((barrier) =>
      barrier.then(
        () => "fulfilled",
        () => "rejected",
      ),
    );
    transport.disconnect();
    const recovery = transport.recoverSubscription("task_b", 3);
    const recoveryOutcome = recovery.then(
      () => "fulfilled",
      () => "rejected",
    );

    try {
      for (let index = 0; index < 8 && sockets.length < 2; index += 1) {
        await Promise.resolve();
      }
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      await Promise.resolve();
      expect(sockets[1].sent.map((item) => JSON.parse(item))).toEqual([
        { type: "subscribe", task_id: "task_b", after_sequence: 3 },
        { type: "ping" },
      ]);
      sockets[1].message({ type: "pong" });
      await recovery;

      expect(await Promise.all(barrierOutcomes)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(transport.isSubscribed("task_b")).toBe(true);
    } finally {
      transport.disconnect();
      await recoveryOutcome;
    }
  });

  it("recovers one task on a fresh socket without dropping other desired subscriptions", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 3);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    const unsubscribeBarrier = transport.unsubscribeAndWait("task_a");
    sockets[0].message({ type: "pong" });
    await unsubscribeBarrier;
    useAgentStore.getState().applyEvent(event("task_a", 1, "partial"));

    const recovery = transport.recoverSubscription("task_a", 1);
    expect(sockets[0].readyState).toBe(3);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve();

    expect(sockets[1].sent.map((item) => JSON.parse(item))).toEqual([
      { type: "subscribe", task_id: "task_b", after_sequence: 3 },
      { type: "subscribe", task_id: "task_a", after_sequence: 1 },
      { type: "ping" },
    ]);
    sockets[1].message(event("task_a", 2, "recovered"));
    sockets[1].message({ type: "pong" });
    await recovery;

    expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(2);
    expect(transport.isSubscribed("task_b")).toBe(true);
  });

  it("serializes concurrent task recoveries without opening parallel sockets", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const recoverA = transport.recoverSubscription("task_a", 0);
    const recoverB = transport.recoverSubscription("task_b", 3);
    const outcomes = [
      recoverA.then(
        () => "fulfilled",
        () => "rejected",
      ),
      recoverB.then(
        () => "fulfilled",
        () => "rejected",
      ),
    ];

    try {
      await Promise.resolve();
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      await Promise.resolve();
      expect(sockets[1].sent.map((item) => JSON.parse(item))).toEqual([
        { type: "subscribe", task_id: "task_a", after_sequence: 0 },
        { type: "subscribe", task_id: "task_b", after_sequence: 3 },
        { type: "ping" },
      ]);
      sockets[1].message(event("task_a", 1, "A"));
      sockets[1].message({ type: "pong" });
      await recoverA;
      await Promise.resolve();
      await Promise.resolve();

      expect(sockets).toHaveLength(3);
      expect(sockets[1].readyState).toBe(3);
      sockets[2].open();
      await Promise.resolve();
      expect(sockets[2].sent.map((item) => JSON.parse(item))).toEqual([
        { type: "subscribe", task_id: "task_a", after_sequence: 1 },
        { type: "subscribe", task_id: "task_b", after_sequence: 3 },
        { type: "ping" },
      ]);
      sockets[2].message(event("task_b", 4, "B"));
      sockets[2].message({ type: "pong" });
      await recoverB;

      expect(transport.isSubscribed("task_a")).toBe(true);
      expect(transport.isSubscribed("task_b")).toBe(true);
      expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
      expect(useAgentStore.getState().tasksById.task_b.lastSequence).toBe(4);
    } finally {
      transport.disconnect();
      await Promise.all(outcomes);
    }
  });

  it("keeps recovery pending across a transient close before the fresh socket opens", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const recovery = transport.recoverSubscription("task_a", 0);
    let outcome = "pending";
    const observed = recovery.then(
      () => {
        outcome = "fulfilled";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await Promise.resolve();
      expect(sockets).toHaveLength(2);
      sockets[1].abnormalClose();
      await Promise.resolve();
      await Promise.resolve();
      expect(outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(3);
      sockets[2].open();
      await Promise.resolve();
      expect(sockets[2].sent.map((item) => JSON.parse(item))).toEqual([
        { type: "subscribe", task_id: "task_a", after_sequence: 0 },
        { type: "subscribe", task_id: "task_b", after_sequence: 3 },
        { type: "ping" },
      ]);
      sockets[2].message(event("task_a", 1, "recovered"));
      sockets[2].message({ type: "pong" });
      await recovery;

      expect(outcome).toBe("fulfilled");
      expect(useAgentStore.getState().tasksById.task_a.lastSequence).toBe(1);
      expect(transport.isSubscribed("task_b")).toBe(true);
    } finally {
      transport.disconnect();
      await observed;
    }
  });

  it("terminates queued recovery on manual disconnect", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const recovery = transport.recoverSubscription("task_a", 0);
    transport.disconnect();

    await expect(recovery).rejects.toThrow("disconnected");
    await vi.runAllTimersAsync();
    expect(sockets).toHaveLength(2);
    expect(useAgentStore.getState().connectionStatus).toBe("disconnected");
  });

  it("rejects recovery when the target task subscription returns a control error", async () => {
    const { transport, sockets, controlErrors } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const recovery = transport.recoverSubscription("task_a", 0);
    try {
      await Promise.resolve();
      sockets[1].open();
      await Promise.resolve();
      sockets[1].message({
        type: "error",
        code: "task_not_found",
        message: "Task not found",
        task_id: "task_a",
      });
      sockets[1].message({ type: "pong" });

      await expect(recovery).rejects.toThrow("Task not found");
      expect(controlErrors).toHaveLength(1);
    } finally {
      transport.disconnect();
      await recovery.catch(() => undefined);
    }
  });

  it("does not reject target recovery for another task's control error", async () => {
    const { transport, sockets, controlErrors } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;

    const recovery = transport.recoverSubscription("task_a", 0);
    try {
      await Promise.resolve();
      sockets[1].open();
      await Promise.resolve();
      sockets[1].message({
        type: "error",
        code: "task_not_found",
        message: "Task not found",
        task_id: "task_b",
      });
      sockets[1].message({ type: "pong" });

      await expect(recovery).resolves.toBeUndefined();
      expect(controlErrors).toHaveLength(1);
    } finally {
      transport.disconnect();
      await recovery.catch(() => undefined);
    }
  });

  it("ignores malformed JSON and unknown frames without corrupting state", async () => {
    const { transport, sockets } = setupTransport();
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    const before = useAgentStore.getState().tasksById;

    sockets[0].message("{");
    sockets[0].message({ type: "mystery", task_id: "task_a", sequence: 99 });
    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_unknown",
      type: "mystery",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 99,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "mystery" },
    });
    sockets[0].message({
      schema_version: "2.0",
      event_id: "event_missing_delta",
      type: "assistant_delta",
      task_id: "task_a",
      run_id: "run_task_a",
      stage_attempt_id: null,
      sequence: 100,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "assistant_delta" },
    });
    sockets[0].message({
      schema_version: "1.0",
      event_id: "event_bad_runtime_scope",
      type: "run_completed",
      task_id: "task_a",
      run_id: null,
      stage_attempt_id: null,
      sequence: 101,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "run_completed" },
    });
    sockets[0].message({
      schema_version: "1.0",
      event_id: "event_bad_artifact",
      type: "artifact_produced",
      task_id: "task_a",
      run_id: null,
      stage_attempt_id: null,
      sequence: 102,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "artifact_produced", artifact: {} },
    });
    sockets[0].message({
      schema_version: "1.0",
      event_id: "event_bad_stage",
      type: "stage_started",
      task_id: "task_a",
      run_id: null,
      stage_attempt_id: "attempt_bad",
      sequence: 103,
      timestamp: "2026-07-14T00:00:00Z",
      payload: { type: "stage_started", stage: "invented", attempt: 1 },
    });

    expect(useAgentStore.getState().tasksById).toBe(before);
  });
});
