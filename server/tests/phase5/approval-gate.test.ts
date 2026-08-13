/**
 * P5-11 durable approval gate + HIL resume route tests.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BioMedAgentAdapter, BioMedAgentEvent, BioMedAgentSession, BioMedSessionConfig } from "../../src/agent/contracts.js";
import { DurableApprovalGate } from "../../src/runtime/approval-gate.js";
import { DurableTaskRepository } from "../../src/runtime/task-repository.js";
import { createDurableAgentRuntime } from "../../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startServer(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("DurableApprovalGate", () => {
  it("emits a durable user_input_required event and resumes on decision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-approval-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "req_1",
      input: "use the credentialed operation",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);

    let settled: "approve" | "reject" | null = null;
    const pending = gate.request("query_protected").then((decision) => {
      settled = decision;
    });
    // The durable event append completes asynchronously; poll for it.
    await expect.poll(async () => {
      const events = await repository.listEvents(accepted.task_id, 0);
      return events.some((event) => event.type === "user_input_required");
    }).toBe(true);

    const events = await repository.listEvents(accepted.task_id, 0);
    const required = events.find((event) => event.type === "user_input_required");
    expect(required?.payload).toMatchObject({
      type: "user_input_required",
      prompt_kind: "api_key_or_credential",
      summary: "Approve credential use for query_protected",
      detail: { operation: "query_protected" },
    });
    expect(settled).toBeNull();

    expect(gate.hasPending(accepted.run_id)).toBe(true);
    expect(gate.resolvePending(accepted.run_id, "approve")).toBe(true);
    await pending;
    expect(settled).toBe("approve");
    expect(gate.hasPending(accepted.run_id)).toBe(false);
  });

  it("rejects duplicate concurrent requests (single-flight per run)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-approval-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "req_2",
      input: "two credentialed calls",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);
    const first = gate.request("op_a");
    const firstRejection = expect(first).rejects.toThrow("cancelled");
    await expect(gate.request("op_b")).rejects.toThrow("another approval request is already pending");
    gate.rejectPending(accepted.run_id, new Error("cancelled"));
    await firstRejection;
  });

  it("aborts when the run signal fires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-approval-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "req_3",
      input: "abort case",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);
    const controller = new AbortController();
    const pending = gate.request("op_c", controller.signal);
    const rejection = expect(pending).rejects.toThrow("aborted");
    controller.abort();
    await rejection;
  });
});

describe("HIL resume route (durable runtime)", () => {
  it("suspends a run on approval, resumes it via POST resume, and completes it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-hil-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);

    let toolCall = 0;

    const adapter: BioMedAgentAdapter = {
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        return {
          piSessionId: `pi_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run: async function* run(): AsyncIterable<BioMedAgentEvent> {
            toolCall += 1;
            const gate = config.tools?.find((tool) => tool.name === "query_protected");
            const decision = await gate?.execute({}).then((result) => {
              return result.content as "approve" | "reject";
            });
            yield { type: "tool_started", toolCallId: "t1", toolName: "query_protected", arguments: {} };
            yield { type: "tool_completed", toolCallId: "t1", toolName: "query_protected", result: decision ?? "reject", isError: false };
            yield { type: "turn_completed" };
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };

    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      repository,
      adapter,
      workspaceFactory: async ({ approvalGate }) => {
        const tool = {
          name: "query_protected",
          label: "query_protected",
          description: "credentialed fixture tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            const decision = await approvalGate.request("query_protected");
            return { content: decision };
          },
        };
        return { root: path.join(root, "w"), tools: [tool], dispose: async () => undefined };
      },
    });

    const base = await startServer((request, response) => {
      void runtime.handle(request, response);
    });

    // Create the task; the run starts and suspends awaiting approval.
    const createResponse = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req_hil",
        input: "call the credentialed database",
        databases: [],
        mode: "agent",
      }),
    });
    expect(createResponse.status).toBe(202);
    const accepted = await createResponse.json() as { task_id: string; run_id: string };

    await expect.poll(async () => {
      const events = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0&limit=50`).then((r) => r.json()) as { events: Array<{ type: string }> };
      return events.events.some((event) => event.type === "user_input_required");
    }, { timeout: 15_000 }).toBe(true);

    // Snapshot must show awaiting_user_input.
    const pending = await fetch(`${base}/api/v1/tasks/${accepted.task_id}`).then((r) => r.json()) as {
      task: { active_run_id: string | null };
      runs: Array<{ run_id: string; status: string }>;
    };
    expect(pending.runs.find((run) => run.run_id === accepted.run_id)?.status).toBe("awaiting_user_input");

    // Approve via the resume surface.
    const resumeResponse = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: "approval_irrelevant_for_route", decision: "approve", detail: {} }),
      },
    );
    expect(resumeResponse.status).toBe(200);

    await expect.poll(async () => {
      const events = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0&limit=100`).then((r) => r.json()) as { events: Array<{ type: string }> };
      return events.events.some((event) => event.type === "run_completed");
    }, { timeout: 15_000 }).toBe(true);

    const snapshot = await fetch(`${base}/api/v1/tasks/${accepted.task_id}`).then((r) => r.json()) as {
      runs: Array<{ run_id: string; status: string }>;
    };
    expect(snapshot.runs.find((run) => run.run_id === accepted.run_id)?.status).toBe("completed");
    expect(toolCall).toBe(1);

    await runtime.close();
  });

  it("rejects invalid decisions with 422", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-hil-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const adapter: BioMedAgentAdapter = {
      async createSession(): Promise<BioMedAgentSession> {
        throw new Error("unused");
      },
    };
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      repository,
      adapter,
      workspaceFactory: async () => ({ root: path.join(root, "w"), tools: [], dispose: async () => undefined }),
    });
    const accepted = await repository.createTask({
      requestId: "req_decision",
      input: "x",
      databases: [],
      mode: "agent",
    });
    const base = await startServer((request, response) => {
      void runtime.handle(request, response);
    });
    const response = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: "r", decision: "maybe", detail: {} }),
      },
    );
    expect(response.status).toBe(422);
    await runtime.close();
  });
});
