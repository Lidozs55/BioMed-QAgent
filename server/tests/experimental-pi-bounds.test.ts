import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { BoundedWebSocketWriter } from "../src/agent/experimental-pi.js";

describe("experimental Pi live-only resource bounds", () => {
  test("closes a subscriber whose pending frame queue reaches its finite bound", () => {
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const writer = new BoundedWebSocketWriter(socket, 2);

    writer.send({ sequence: 1 });
    writer.send({ sequence: 2 });
    writer.send({ sequence: 3 });

    expect(socket.close).toHaveBeenCalledWith(1013, "slow subscriber");
  });

  test("has no dependency on the legacy durable event authorities", () => {
    const source = [
      "../src/agent/experimental-pi.ts",
      "../src/agent/event-adapter.ts",
      "../src/experimental/event-bus.ts",
    ]
      .map((module) => readFileSync(new URL(module, import.meta.url), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/TaskRepository|TaskManager|EventStore|events\.jsonl/);
  });
});
