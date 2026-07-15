import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope, TaskSummary } from "@/runtime/contracts";
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

function setupTransport() {
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
    setConnectionStatus: (status) =>
      useAgentStore.getState().setConnectionStatus(status),
    onControlError: (frame) => controlErrors.push(frame),
    reconnectDelayMs: 10,
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

  it("reconnects after 1013 and resumes each task from its own current watermark", async () => {
    const { transport, sockets } = setupTransport();
    transport.subscribe("task_a", 0);
    transport.subscribe("task_b", 3);
    const connected = transport.connect();
    sockets[0].open();
    await connected;
    sockets[0].message(event("task_a", 8, "latest"));

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
