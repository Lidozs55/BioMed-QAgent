import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  PiAgentAdapter,
  type PiUpstreamEvent,
  type PiUpstreamSession,
} from "../src/agent/pi-adapter.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Stands in for the Pi SDK session at the translated PiUpstreamEvent boundary:
 * during one prompt it reports a successful threshold compaction and an
 * aborted overflow compaction, then completes the turn.
 */
class CompactingUpstreamSession implements PiUpstreamSession {
  readonly sessionId = "pi-compaction-e2e";
  private readonly listeners = new Set<(event: PiUpstreamEvent) => void>();

  async prompt(): Promise<void> {
    this.emit({
      type: "compaction_end",
      reason: "threshold",
      compactionResult: { summary: "e2e checkpoint summary" },
      aborted: false,
    });
    this.emit({ type: "compaction_end", reason: "overflow", aborted: true });
  }

  subscribe(listener: (event: PiUpstreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PiUpstreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.listeners.clear();
  }
}

describe("Pi auto-compaction durable projection", () => {
  test("records exactly one conversation_compacted event for a successful Pi compaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "biomed-pi-compaction-"));
    roots.push(root);
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new PiAgentAdapter({
        createUpstreamSession: async () => new CompactingUpstreamSession(),
      }),
      workspaceFactory: async ({ taskId }) => {
        const workspaceRoot = path.join(root, taskId);
        await mkdir(workspaceRoot, { recursive: true });
        return {
          root: workspaceRoot,
          tools: [],
          dispose: async () => undefined,
        };
      },
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-compaction-e2e",
        input: "continue the study",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };

    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.task.status;
    }).toBe("completed");

    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    const compacted = events.filter((event) => event.payload.type === "conversation_compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.payload).toEqual({
      type: "conversation_compacted",
      covered_through_run_id: accepted.run_id,
      summary_digest: createHash("sha256").update("e2e checkpoint summary", "utf8").digest("hex"),
    });
    expect(events.some((event) => event.payload.type === "run_completed")).toBe(true);

    await runtime.close();
  });
});
