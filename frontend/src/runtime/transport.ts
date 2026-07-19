import type {
  AssistantStreamFrame,
  EventEnvelope,
  WebSocketCommand,
  WebSocketControlFrame,
} from "./contracts";
import type { ConnectionStatus } from "./types";

const CONNECTING = 0;
const OPEN = 1;
const MAX_PENDING_ASSISTANT_STREAM_FRAMES = 2048;
const EVENT_TYPES = new Set([
  "task_created",
  "plan_ready",
  "user_input_required",
  "user_input_resumed",
  "stage_started",
  "stage_completed",
  "stage_failed",
  "stage_skipped",
  "stage_progress",
  "tool_called",
  "tool_completed",
  "warning",
  "artifact_produced",
  "task_cancel_requested",
  "task_cancelled",
  "task_recovered",
  "task_completed",
  "task_failed",
  "run_queued",
  "run_started",
  "run_finalizing",
  "run_completed",
  "run_failed",
  "run_cancel_requested",
  "run_cancelled",
  "run_interrupted",
  "assistant_delta",
  "tool_started",
  "conversation_compacted",
]);

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

interface TransportOptions {
  socketFactory: SocketFactory;
  getLastSequence: (taskId: string) => number;
  applyEvent: (event: EventEnvelope) => void;
  applyAssistantStreamFrames: (frames: readonly AssistantStreamFrame[]) => void;
  deactivateAssistantStreams: (taskId?: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  onControlError?: (frame: Extract<WebSocketControlFrame, { type: "error" }>) => void;
  reconnectDelayMs?: number;
  pingTimeoutMs?: number;
  scheduleAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  url?: string | (() => string);
}

interface PendingPing {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface RecoveryAttempt {
  taskId: string;
  controlError: Error | null;
}

interface ControlBarrierRequest {
  disconnectGeneration: number;
  operation: () => Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function browserSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/ws`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlFrame(value: unknown): value is WebSocketControlFrame {
  if (!isRecord(value)) return false;
  if (value.type === "pong") return true;
  return (
    value.type === "error" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) {
    return false;
  }
  if (!payloadShapeMatches(value.type, value.payload)) return false;
  const runtimeScoped =
    value.type.startsWith("run_") ||
    value.type === "assistant_delta" ||
    value.type === "tool_started" ||
    value.type === "conversation_compacted" ||
    (value.type === "tool_completed" &&
      typeof value.payload.tool_call_id === "string") ||
    (value.type === "warning" && value.payload.warning == null);
  return (
    (value.schema_version === "1.0" || value.schema_version === "2.0") &&
    typeof value.event_id === "string" &&
    typeof value.task_id === "string" &&
    (value.run_id === null || typeof value.run_id === "string") &&
    (value.stage_attempt_id === null ||
      typeof value.stage_attempt_id === "string") &&
    Number.isInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    typeof value.timestamp === "string" &&
    value.payload.type === value.type &&
    (!runtimeScoped ||
      (value.schema_version === "2.0" && typeof value.run_id === "string"))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

const ASSISTANT_STREAM_DELTA_KEYS = new Set([
  "type",
  "task_id",
  "run_id",
  "stream_id",
  "chunk_index",
  "delta",
]);
const ASSISTANT_STREAM_END_KEYS = new Set([
  "type",
  "task_id",
  "run_id",
  "stream_id",
  "last_chunk_index",
  "finish_reason",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isAssistantStreamFrame(value: unknown): value is AssistantStreamFrame {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.task_id) ||
    !isNonEmptyString(value.run_id) ||
    !isNonEmptyString(value.stream_id)
  ) {
    return false;
  }
  if (value.type === "assistant_stream_delta") {
    return (
      hasOnlyKeys(value, ASSISTANT_STREAM_DELTA_KEYS) &&
      isNonNegativeInteger(value.chunk_index) &&
      isNonEmptyString(value.delta)
    );
  }
  if (value.type === "assistant_stream_end") {
    return (
      hasOnlyKeys(value, ASSISTANT_STREAM_END_KEYS) &&
      (value.last_chunk_index === null ||
        isNonNegativeInteger(value.last_chunk_index)) &&
      isNonEmptyString(value.finish_reason)
    );
  }
  return false;
}

function isAssistantStreamBoundary(envelope: EventEnvelope): boolean {
  return (
    envelope.type === "tool_started" ||
    envelope.type === "run_finalizing" ||
    envelope.type === "run_completed" ||
    envelope.type === "run_failed" ||
    envelope.type === "run_cancel_requested" ||
    envelope.type === "run_cancelled" ||
    envelope.type === "run_interrupted"
  );
}

function payloadShapeMatches(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  if (payload.type !== type) return false;
  switch (type) {
    case "run_queued":
      return (
        typeof payload.request_id === "string" &&
        typeof payload.input === "string"
      );
    case "assistant_delta": {
      if (typeof payload.delta !== "string" || payload.delta.length === 0) {
        return false;
      }
      const hasStreamId = payload.stream_id !== undefined;
      const hasFromIndex = payload.from_chunk_index !== undefined;
      const hasThroughIndex = payload.through_chunk_index !== undefined;
      if (!hasStreamId && !hasFromIndex && !hasThroughIndex) return true;
      if (
        payload.stream_id === null &&
        payload.from_chunk_index === null &&
        payload.through_chunk_index === null
      ) {
        return true;
      }
      return (
        hasStreamId === hasFromIndex &&
        hasFromIndex === hasThroughIndex &&
        isNonEmptyString(payload.stream_id) &&
        isNonNegativeInteger(payload.from_chunk_index) &&
        isNonNegativeInteger(payload.through_chunk_index) &&
        payload.from_chunk_index <= payload.through_chunk_index
      );
    }
    case "tool_started":
      return (
        typeof payload.tool_call_id === "string" &&
        typeof payload.tool_name === "string"
      );
    case "tool_completed":
      return (
        typeof payload.tool_name === "string" &&
        typeof payload.is_error === "boolean"
      );
    case "artifact_produced":
      return isRecord(payload.artifact);
    case "stage_started":
      return typeof payload.stage === "string" && Number.isInteger(payload.attempt);
    case "stage_completed":
    case "stage_failed":
    case "stage_skipped":
      return typeof payload.stage === "string" && typeof payload.status === "string";
    case "run_failed":
      return typeof payload.error === "string";
    case "run_interrupted":
      return typeof payload.reason === "string";
    case "conversation_compacted":
      return (
        typeof payload.covered_through_run_id === "string" &&
        typeof payload.summary_digest === "string"
      );
    default:
      return true;
  }
}

function parseFrame(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export class AgentEventTransport {
  private socket: WebSocketLike | null = null;
  private readonly desired = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly awaitingUnsubscribe = new Set<string>();
  private readonly pendingPings: PendingPing[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private readonly connectionWaiters: ConnectionWaiter[] = [];
  private readonly controlBarrierQueue: ControlBarrierRequest[] = [];
  private controlBarrierRunning = false;
  private recoveryAttempt: RecoveryAttempt | null = null;
  private disconnectGeneration = 0;
  private manuallyDisconnected = false;
  private hasConnected = false;
  private pendingAssistantStreamFrames: AssistantStreamFrame[] = [];
  private animationFrameHandle: number | null = null;
  private animationFrameGeneration = 0;

  constructor(private readonly options: TransportOptions) {}

  get isConnected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  isSubscribed(taskId: string): boolean {
    return this.desired.has(taskId);
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === OPEN) return Promise.resolve();
    if (this.socket?.readyState === CONNECTING && this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.manuallyDisconnected = false;
    this.options.setConnectionStatus(
      this.hasConnected ? "reconnecting" : "connecting",
    );
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.openSocket();
    return this.connectPromise;
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.disconnectGeneration += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const error = new Error("WebSocket transport disconnected");
    this.rejectPendingPings(error);
    this.rejectConnectionWaiters(error);
    this.rejectConnect?.(error);
    this.finishConnect();
    const socket = this.socket;
    this.socket = null;
    this.active.clear();
    this.desired.clear();
    this.discardAssistantStreamFrames();
    this.options.deactivateAssistantStreams();
    if (socket !== null) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close(1000, "client disconnect");
    }
    this.options.setConnectionStatus("disconnected");
  }

  subscribe(taskId: string, afterSequence: number): void {
    const previous = this.desired.get(taskId);
    this.desired.set(taskId, Math.max(previous ?? 0, afterSequence));
    if (this.isConnected && !this.active.has(taskId)) {
      this.send({
        type: "subscribe",
        task_id: taskId,
        after_sequence: Math.max(
          this.desired.get(taskId) ?? 0,
          this.options.getLastSequence(taskId),
        ),
      });
      this.active.add(taskId);
    }
  }

  unsubscribe(taskId: string): void {
    this.desired.delete(taskId);
    this.discardAssistantStreamFrames(taskId);
    this.options.deactivateAssistantStreams(taskId);
    if (this.isConnected && this.active.has(taskId)) {
      this.send({ type: "unsubscribe", task_id: taskId });
      this.awaitingUnsubscribe.add(taskId);
    }
  }

  ping(): Promise<void> {
    if (!this.isConnected) {
      return Promise.reject(new Error("WebSocket transport is not connected"));
    }
    const promise = new Promise<void>((resolve, reject) => {
      const pending: PendingPing = { resolve, reject, timer: null };
      const timeoutMs = this.options.pingTimeoutMs ?? 10_000;
      pending.timer = setTimeout(() => {
        const index = this.pendingPings.indexOf(pending);
        if (index !== -1) this.pendingPings.splice(index, 1);
        pending.timer = null;
        reject(new Error("WebSocket ping timed out"));
      }, timeoutMs);
      this.pendingPings.push(pending);
    });
    this.send({ type: "ping" });
    return promise;
  }

  unsubscribeAndWait(taskId: string): Promise<void> {
    return this.enqueueControlBarrier(async () => {
      this.unsubscribe(taskId);
      await this.ping();
      this.discardAssistantStreamFrames(taskId);
      this.options.deactivateAssistantStreams(taskId);
      this.active.delete(taskId);
      this.awaitingUnsubscribe.delete(taskId);
    });
  }

  recoverSubscription(taskId: string, afterSequence: number): Promise<void> {
    this.desired.set(taskId, afterSequence);
    const disconnectGeneration = this.disconnectGeneration;
    return this.enqueueControlBarrier(() =>
      this.performRecovery(taskId, disconnectGeneration),
    );
  }

  private enqueueControlBarrier(
    operation: () => Promise<void>,
  ): Promise<void> {
    const barrier = new Promise<void>((resolve, reject) => {
      this.controlBarrierQueue.push({
        disconnectGeneration: this.disconnectGeneration,
        operation,
        resolve,
        reject,
      });
    });
    this.startNextControlBarrier();
    return barrier;
  }

  private startNextControlBarrier(): void {
    if (this.controlBarrierRunning) return;
    const request = this.controlBarrierQueue.shift();
    if (request === undefined) return;
    this.controlBarrierRunning = true;
    if (request.disconnectGeneration !== this.disconnectGeneration) {
      request.reject(new Error("WebSocket control barrier expired"));
      this.finishControlBarrier();
      return;
    }
    void request.operation().then(
      () => {
        request.resolve();
        this.finishControlBarrier();
      },
      (error: unknown) => {
        request.reject(error);
        this.finishControlBarrier();
      },
    );
  }

  private finishControlBarrier(): void {
    this.controlBarrierRunning = false;
    this.startNextControlBarrier();
  }

  private async performRecovery(
    taskId: string,
    disconnectGeneration: number,
  ): Promise<void> {
    if (disconnectGeneration !== this.disconnectGeneration) {
      throw new Error("WebSocket transport disconnected");
    }
    this.replaceSocket();
    for (;;) {
      let attempt: RecoveryAttempt | null = null;
      try {
        if (!this.isConnected) await this.connect();
        if (disconnectGeneration !== this.disconnectGeneration) {
          throw new Error("WebSocket transport disconnected");
        }
        attempt = { taskId, controlError: null };
        this.recoveryAttempt = attempt;
        await this.ping();
        if (attempt.controlError !== null) throw attempt.controlError;
        return;
      } catch (error) {
        const controlError = attempt?.controlError ?? null;
        if (this.recoveryAttempt === attempt) this.recoveryAttempt = null;
        if (controlError !== null) throw controlError;
        if (
          disconnectGeneration !== this.disconnectGeneration ||
          this.manuallyDisconnected
        ) {
          throw error;
        }
        await this.waitForConnection(disconnectGeneration);
      } finally {
        if (this.recoveryAttempt === attempt) this.recoveryAttempt = null;
      }
    }
  }

  private waitForConnection(disconnectGeneration: number): Promise<void> {
    if (disconnectGeneration !== this.disconnectGeneration) {
      return Promise.reject(new Error("WebSocket transport disconnected"));
    }
    if (this.isConnected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.connectionWaiters.push({ resolve, reject });
    });
  }

  private replaceSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const error = new Error("WebSocket transport replaced for replay recovery");
    this.rejectPendingPings(error);
    this.rejectConnect?.(error);
    this.finishConnect();
    const socket = this.socket;
    this.socket = null;
    this.active.clear();
    this.awaitingUnsubscribe.clear();
    this.discardAssistantStreamFrames();
    this.options.deactivateAssistantStreams();
    if (socket !== null) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close(1000, "replay recovery");
    }
  }

  private openSocket(): void {
    const configuredUrl = this.options.url;
    const url =
      typeof configuredUrl === "function"
        ? configuredUrl()
        : configuredUrl ?? browserSocketUrl();
    const socket = this.options.socketFactory(url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.active.clear();
      this.awaitingUnsubscribe.clear();
      this.hasConnected = true;
      this.options.setConnectionStatus("connected");
      this.flushSubscriptions();
      this.resolveConnectionWaiters();
      this.resolveConnect?.();
      this.finishConnect();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(parseFrame(event.data));
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.options.setConnectionStatus(
        this.manuallyDisconnected ? "disconnected" : "reconnecting",
      );
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.active.clear();
      this.awaitingUnsubscribe.clear();
      this.discardAssistantStreamFrames();
      this.options.deactivateAssistantStreams();
      const error = new Error("WebSocket transport closed");
      this.rejectPendingPings(error);
      this.rejectConnect?.(error);
      this.finishConnect();
      if (this.manuallyDisconnected) {
        this.options.setConnectionStatus("disconnected");
        return;
      }
      this.options.setConnectionStatus("reconnecting");
      this.scheduleReconnect();
    };
  }

  private flushSubscriptions(): void {
    for (const taskId of this.desired.keys()) {
      this.send({
        type: "subscribe",
        task_id: taskId,
        after_sequence: Math.max(
          this.desired.get(taskId) ?? 0,
          this.options.getLastSequence(taskId),
        ),
      });
      this.active.add(taskId);
    }
  }

  private handleFrame(frame: unknown): void {
    if (isControlFrame(frame)) {
      if (frame.type === "pong") {
        const pending = this.pendingPings.shift();
        if (pending?.timer !== null && pending?.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        pending?.resolve();
      } else {
        if (
          frame.task_id !== undefined &&
          frame.task_id === this.recoveryAttempt?.taskId
        ) {
          this.recoveryAttempt.controlError = new Error(
            `${frame.code}: ${frame.message}`,
          );
        }
        this.options.onControlError?.(frame);
      }
      return;
    }
    if (isAssistantStreamFrame(frame)) {
      if (!this.active.has(frame.task_id)) return;
      this.queueAssistantStreamFrame(frame);
      return;
    }
    if (!isEventEnvelope(frame)) return;
    if (!this.active.has(frame.task_id)) return;
    this.confirmQueuedAssistantStreamFrames(frame);
    if (isAssistantStreamBoundary(frame) && frame.run_id !== null) {
      this.discardAssistantStreamFrames(frame.task_id, frame.run_id);
    }
    this.options.applyEvent(frame);
  }

  private queueAssistantStreamFrame(frame: AssistantStreamFrame): void {
    if (
      this.pendingAssistantStreamFrames.length >=
      MAX_PENDING_ASSISTANT_STREAM_FRAMES
    ) {
      if (frame.type === "assistant_stream_delta") return;
      let disposableIndex = -1;
      for (
        let index = this.pendingAssistantStreamFrames.length - 1;
        index >= 0;
        index -= 1
      ) {
        if (this.pendingAssistantStreamFrames[index].type === "assistant_stream_delta") {
          disposableIndex = index;
          break;
        }
      }
      if (disposableIndex >= 0) {
        this.pendingAssistantStreamFrames.splice(disposableIndex, 1);
      } else {
        return;
      }
    }
    this.pendingAssistantStreamFrames.push(frame);
    if (this.animationFrameHandle !== null) return;
    const generation = ++this.animationFrameGeneration;
    const schedule =
      this.options.scheduleAnimationFrame ??
      ((callback: () => void) => window.requestAnimationFrame(callback));
    this.animationFrameHandle = schedule(() => {
      if (generation !== this.animationFrameGeneration) return;
      this.animationFrameHandle = null;
      const frames = this.pendingAssistantStreamFrames.splice(0);
      if (frames.length > 0) this.options.applyAssistantStreamFrames(frames);
    });
  }

  private confirmQueuedAssistantStreamFrames(envelope: EventEnvelope): void {
    const payload = envelope.payload;
    if (payload.type !== "assistant_delta") return;
    if (typeof payload.stream_id !== "string" || envelope.run_id === null) {
      return;
    }
    const streamId = payload.stream_id;
    const throughChunkIndex = payload.through_chunk_index;
    this.pendingAssistantStreamFrames = this.pendingAssistantStreamFrames.filter(
      (frame) =>
        frame.task_id !== envelope.task_id ||
        frame.run_id !== envelope.run_id ||
        frame.stream_id !== streamId ||
        frame.type !== "assistant_stream_delta" ||
        frame.chunk_index > throughChunkIndex,
    );
    this.cancelEmptyAssistantStreamFrameBatch();
  }

  private discardAssistantStreamFrames(taskId?: string, runId?: string): void {
    if (taskId === undefined) {
      this.pendingAssistantStreamFrames = [];
    } else {
      this.pendingAssistantStreamFrames = this.pendingAssistantStreamFrames.filter(
        (frame) =>
          frame.task_id !== taskId ||
          (runId !== undefined && frame.run_id !== runId),
      );
    }
    this.cancelEmptyAssistantStreamFrameBatch();
  }

  private cancelEmptyAssistantStreamFrameBatch(): void {
    if (this.pendingAssistantStreamFrames.length > 0) return;
    if (this.animationFrameHandle === null) return;
    const cancel =
      this.options.cancelAnimationFrame ??
      ((handle: number) => window.cancelAnimationFrame(handle));
    cancel(this.animationFrameHandle);
    this.animationFrameHandle = null;
    this.animationFrameGeneration += 1;
  }

  private send(command: WebSocketCommand): void {
    if (!this.isConnected || this.socket === null) return;
    this.socket.send(JSON.stringify(command));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.manuallyDisconnected) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyDisconnected || this.socket !== null) return;
      void this.connect().catch(() => undefined);
    }, this.options.reconnectDelayMs ?? 500);
  }

  private rejectPendingPings(error: Error): void {
    for (const pending of this.pendingPings.splice(0)) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private resolveConnectionWaiters(): void {
    for (const waiter of this.connectionWaiters.splice(0)) waiter.resolve();
  }

  private rejectConnectionWaiters(error: Error): void {
    for (const waiter of this.connectionWaiters.splice(0)) waiter.reject(error);
  }

  private finishConnect(): void {
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }
}
