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
 * the first prompt reports a successful threshold compaction (which ends the
 * Pi turn without auto-continue), the second prompt completes normally — the
 * runtime must resume the run across the compaction boundary.
 */
class CompactingUpstreamSession implements PiUpstreamSession {
  readonly sessionId = "pi-compaction-e2e";
  prompts = 0;
  private readonly listeners = new Set<(event: PiUpstreamEvent) => void>();

  async prompt(): Promise<void> {
    this.prompts += 1;
    if (this.prompts === 1) {
      this.emit({
        type: "compaction_end",
        reason: "threshold",
        compactionResult: { summary: "e2e checkpoint summary" },
        aborted: false,
      });
    }
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

class IneffectiveCompactingUpstreamSession implements PiUpstreamSession {
  readonly sessionId = "pi-ineffective-compaction-e2e";
  prompts = 0;
  private readonly listeners = new Set<(event: PiUpstreamEvent) => void>();

  async prompt(): Promise<void> {
    this.prompts += 1;
    this.emit({
      type: "compaction_end",
      reason: "threshold",
      compactionResult: {
        summary: "oversized checkpoint summary",
        tokensBefore: 100_000,
        estimatedTokensAfter: 97_000,
        targetTokens: 60_000,
        summaryTokens: 32_000,
      },
      aborted: false,
    });
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
  test("records one conversation_compacted event and resumes the run across the compaction boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "biomed-pi-compaction-"));
    roots.push(root);
    const upstream = new CompactingUpstreamSession();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new PiAgentAdapter({
        createUpstreamSession: async () => upstream,
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
      compaction_id: expect.any(String),
      covered_through_run_id: accepted.run_id,
      summary_digest: createHash("sha256").update("e2e checkpoint summary", "utf8").digest("hex"),
      reason: "threshold",
    });
    expect(events.some((event) => event.payload.type === "run_completed")).toBe(true);
    // The threshold compaction ended the first turn; the runtime resumed the
    // run with a second turn instead of terminating it.
    expect(upstream.prompts).toBe(2);

    await runtime.close();
  });

  test("fails closed when compaction misses its context target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "biomed-pi-compaction-"));
    roots.push(root);
    const upstream = new IneffectiveCompactingUpstreamSession();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new PiAgentAdapter({
        createUpstreamSession: async () => upstream,
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
        request_id: "request-ineffective-compaction-e2e",
        input: "continue the study",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };

    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.task.status;
    }).toBe("failed");

    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.find((event) => event.payload.type === "conversation_compacted")?.payload)
      .toMatchObject({
        type: "conversation_compacted",
        reason: "threshold",
        tokens_before: 100_000,
        estimated_tokens_after: 97_000,
        target_tokens: 60_000,
        summary_tokens: 32_000,
      });
    expect(events.find((event) => event.payload.type === "run_failed")?.payload).toEqual({
      type: "run_failed",
      error: "Context compaction did not reduce the estimated context",
      error_code: "internal_error",
    });
    expect(upstream.prompts).toBe(1);

    await runtime.close();
  });

  test("lands the turn when ineffective compaction follows an emitted publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "biomed-pi-compaction-"));
    roots.push(root);
    const upstream = new IneffectiveCompactingUpstreamSession();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new PiAgentAdapter({
        createUpstreamSession: async () => upstream,
      }),
      workspaceFactory: async ({ taskId }) => {
        const workspaceRoot = path.join(root, taskId);
        await mkdir(workspaceRoot, { recursive: true });
        return {
          root: workspaceRoot,
          tools: [],
          dispose: async () => undefined,
          getCurrentPublicationId: () => "pub_yield_guard_e2e",
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
        request_id: "request-published-ineffective-compaction-e2e",
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
    // Convergence telemetry is still persisted for post-hoc audit.
    expect(events.find((event) => event.payload.type === "conversation_compacted")?.payload)
      .toMatchObject({
        type: "conversation_compacted",
        reason: "threshold",
        tokens_before: 100_000,
        estimated_tokens_after: 97_000,
        target_tokens: 60_000,
      });
    expect(events.some((event) => event.payload.type === "run_completed")).toBe(true);
    expect(events.some((event) => event.payload.type === "run_failed")).toBe(false);
    // The guard must not issue a continuation prompt after landing the turn.
    expect(upstream.prompts).toBe(1);

    await runtime.close();
  });
});
