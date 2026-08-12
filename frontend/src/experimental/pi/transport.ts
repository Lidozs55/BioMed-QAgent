import type {
  EventEnvelope,
  ExperimentalPiWebSocketControlFrame,
} from "@biomed/contracts";

export type ExperimentalPiConnection = "connecting" | "connected" | "disconnected";

export interface ExperimentalPiLiveHandlers {
  onEvent(event: EventEnvelope): void;
  onConnection(status: ExperimentalPiConnection): void;
  onControl(frame: ExperimentalPiWebSocketControlFrame): void;
  onDisconnect(): void;
}

export interface ExperimentalPiLiveTransport {
  connect(): Promise<void>;
  subscribe(taskId: string): void;
  disconnect(): void;
}

type SocketFactory = (url: string) => WebSocket;

function experimentalSocketUrl(): string {
  const url = new URL("/experimental/pi/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ExperimentalPiWebSocketTransport implements ExperimentalPiLiveTransport {
  private socket?: WebSocket;

  constructor(
    private readonly handlers: ExperimentalPiLiveHandlers,
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url),
  ) {}

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.handlers.onConnection("connecting");
    const socket = this.createSocket(experimentalSocketUrl());
    this.socket = socket;
    return new Promise((resolve, reject) => {
      socket.onopen = () => {
        this.handlers.onConnection("connected");
        resolve();
      };
      socket.onerror = () => reject(new Error("Experimental Pi WebSocket failed"));
      socket.onmessage = (message) => this.receive(message.data);
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        this.handlers.onConnection("disconnected");
        this.handlers.onDisconnect();
      };
    });
  }

  subscribe(taskId: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Experimental Pi WebSocket is not connected");
    }
    this.socket.send(JSON.stringify({ type: "subscribe", task_id: taskId }));
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (
      typeof value.event_id === "string" &&
      typeof value.task_id === "string" &&
      typeof value.sequence === "number" &&
      isRecord(value.payload)
    ) {
      this.handlers.onEvent(value as unknown as EventEnvelope);
      return;
    }
    this.handlers.onControl(value as unknown as ExperimentalPiWebSocketControlFrame);
  }
}
