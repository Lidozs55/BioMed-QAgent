/**
 * P5-11 durable approval gate + HIL resume route tests.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BioMedAgentAdapter, BioMedAgentEvent, BioMedAgentSession, BioMedSessionConfig } from "../../src/agent/contracts.js";
import { DurableApprovalGate } from "../../src/runtime/approval-gate.js";
import { DurableHILStore } from "../../src/runtime/hil-store.js";
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
    if (required?.payload.type !== "user_input_required" || required.payload.hil_request == null) {
      throw new Error("missing durable HIL request");
    }
    const store = new DurableHILStore(repository);
    const review = await store.resolveRequest(accepted.task_id, accepted.run_id, {
      request_id: required.payload.hil_request.request_id,
      evidence_digest: required.payload.hil_request.evidence_digest,
      decision: { action: "approve" },
      reason: null,
    });
    expect(gate.resolvePending(accepted.run_id, review)).toBe(true);
    await pending;
    expect(settled).toBe("approve");
    expect(gate.hasPending(accepted.run_id)).toBe(false);
  });

  it("rejects duplicate concurrent requests for different operations (single-flight per run)", async () => {
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
    await expect(gate.request("op_b")).rejects.toThrow("another blocking HIL request is already pending");
    gate.rejectPending(accepted.run_id, new Error("cancelled"));
    await firstRejection;
  });

  it("coalesces four concurrent extraction credential requests into one review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-approval-coalesce-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "req_coalesce",
      input: "four parallel credentialed extractions",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);

    // Four concurrent governed extraction calls share one run and one
    // credential operation scope: they must await ONE pending decision
    // instead of conflict-failing each other.
    const callers = [
      gate.request("extract_chart_data_vlm"),
      gate.request("extract_chart_data_vlm"),
      gate.request("extract_chart_data_vlm"),
      gate.request("extract_chart_data_vlm"),
    ];

    await expect.poll(async () => {
      const events = await repository.listEvents(accepted.task_id, 0);
      return events.filter((event) => event.type === "user_input_required").length;
    }).toBe(1);

    const events = await repository.listEvents(accepted.task_id, 0);
    const required = events.find((event) => event.type === "user_input_required");
    if (required?.payload.type !== "user_input_required" || required.payload.hil_request == null) {
      throw new Error("missing durable HIL request");
    }
    // Exactly one durable credential request exists for the run.
    expect(
      events.filter(
        (event) =>
          event.payload.type === "user_input_required" &&
          event.payload.hil_request?.kind === "permission",
      ),
    ).toHaveLength(1);

    const store = new DurableHILStore(repository);
    const review = await store.resolveRequest(accepted.task_id, accepted.run_id, {
      request_id: required.payload.hil_request.request_id,
      evidence_digest: required.payload.hil_request.evidence_digest,
      decision: { action: "approve" },
      reason: null,
    });
    expect(gate.resolvePending(accepted.run_id, review)).toBe(true);

    // Every caller resolves with the SAME single decision; none observed the
    // "another HIL request is already pending" conflict.
    await expect(Promise.all(callers)).resolves.toEqual([
      "approve",
      "approve",
      "approve",
      "approve",
    ]);
    expect(gate.hasPending(accepted.run_id)).toBe(false);
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

  it("does not let an old abort signal cancel a later request on the same run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-approval-abort-cleanup-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "req_abort_cleanup",
      input: "two sequential approvals",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);
    const oldController = new AbortController();
    const first = gate.request("op_first", oldController.signal);
    await expect.poll(() => gate.getPendingRequest(accepted.run_id)).not.toBeNull();
    const firstRequest = await gate.getPendingRequest(accepted.run_id);
    if (firstRequest === null) throw new Error("missing first request");
    const firstReview = await new DurableHILStore(repository).resolveRequest(
      accepted.task_id,
      accepted.run_id,
      {
        request_id: firstRequest.request_id,
        evidence_digest: firstRequest.evidence_digest,
        decision: { action: "approve" },
        reason: null,
      },
    );
    gate.resolvePending(accepted.run_id, firstReview);
    await expect(first).resolves.toBe("approve");

    const second = gate.request("op_second");
    const secondRejection = expect(second).rejects.toThrow("test cleanup");
    await expect.poll(async () =>
      (await gate.getPendingRequest(accepted.run_id))?.summary,
    ).toContain("op_second");
    oldController.abort();
    expect(gate.hasPending(accepted.run_id)).toBe(true);
    gate.rejectPending(accepted.run_id, new Error("test cleanup"));
    await secondRejection;
  });

  it("records advisory review without pausing the run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-advisory-hil-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "advisory_1",
      input: "supporting data",
      databases: [],
      mode: "agent",
    });
    const gate = new DurableApprovalGate(accepted.task_id, repository, accepted.run_id);

    const request = await gate.recordAdvisoryHIL({
      requirement_id: "build_1",
      kind: "data_review",
      review_type: "vlm_extraction",
      blocking: false,
      subject: { record_ids: ["supporting_1"] },
      review_items: [],
      summary: "Supporting value has low-confidence evidence",
      evidence: { record_id: "supporting_1" },
      policy_ref: "dataset.supporting.v1",
      idempotency_key: "supporting_1",
    });

    expect(request.blocking).toBe(false);
    expect((await repository.getSnapshot(accepted.task_id))?.runs[0]?.status).toBe("queued");
    expect((await repository.listEvents(accepted.task_id, 0)).at(-1)?.payload).toMatchObject({
      type: "warning",
      code: `HIL_ADVISORY:${request.request_id}`,
    });
    expect(gate.hasPending(accepted.run_id)).toBe(false);
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

    const requiredEvents = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0&limit=50`,
    ).then((r) => r.json()) as {
      events: Array<{
        type: string;
        payload?: {
          hil_request?: { request_id: string; evidence_digest: string } | null;
        };
      }>;
    };
    const hilRequest = requiredEvents.events.find(
      (event) => event.type === "user_input_required",
    )?.payload?.hil_request;
    if (hilRequest == null) throw new Error("missing durable HIL request");

    // Snapshot must show awaiting_user_input.
    const pending = await fetch(`${base}/api/v1/tasks/${accepted.task_id}`).then((r) => r.json()) as {
      task: { active_run_id: string | null };
      runs: Array<{ run_id: string; status: string }>;
    };
    expect(pending.runs.find((run) => run.run_id === accepted.run_id)?.status).toBe("awaiting_user_input");

    // Approve via the resume surface.
    const resumeUrl = `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`;
    const resumeInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: hilRequest.request_id,
          evidence_digest: hilRequest.evidence_digest,
          decision: { action: "approve" },
          reason: null,
        }),
      };
    const appendRunEvent = repository.appendRunEvent.bind(repository);
    let failResumeAppend = true;
    vi.spyOn(repository, "appendRunEvent").mockImplementation(async (taskId, runId, payload) => {
      if (payload.type === "user_input_resumed" && failResumeAppend) {
        failResumeAppend = false;
        throw new Error("injected resume append failure");
      }
      return appendRunEvent(taskId, runId, payload);
    });
    const failedResume = await fetch(resumeUrl, resumeInit);
    expect(failedResume.status).toBe(500);
    expect((await repository.getSnapshot(accepted.task_id))?.runs[0]?.status).toBe(
      "awaiting_user_input",
    );

    const resumeResponses = await Promise.all([
      fetch(resumeUrl, resumeInit),
      fetch(resumeUrl, resumeInit),
    ]);
    expect(resumeResponses.map((response) => response.status)).toEqual([200, 200]);

    await expect.poll(async () => {
      const events = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0&limit=100`).then((r) => r.json()) as { events: Array<{ type: string }> };
      return events.events.some((event) => event.type === "run_completed");
    }, { timeout: 15_000 }).toBe(true);

    const snapshot = await fetch(`${base}/api/v1/tasks/${accepted.task_id}`).then((r) => r.json()) as {
      runs: Array<{ run_id: string; status: string }>;
    };
    expect(snapshot.runs.find((run) => run.run_id === accepted.run_id)?.status).toBe("completed");
    expect(toolCall).toBe(1);

    const retryResponse = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: hilRequest.request_id,
          evidence_digest: hilRequest.evidence_digest,
          decision: { action: "approve" },
          reason: null,
        }),
      },
    );
    expect(retryResponse.status).toBe(200);
    expect(
      (await repository.listEvents(accepted.task_id, 0)).filter(
        (event) => event.type === "user_input_resumed",
      ),
    ).toHaveLength(1);
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

  it("preserves pending HIL across host restart and reconstructs the run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-hil-restart-"));
    roots.push(root);
    let toolCalls = 0;
    const adapter: BioMedAgentAdapter = {
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        return {
          piSessionId: `pi_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run: async function* run(): AsyncIterable<BioMedAgentEvent> {
            toolCalls += 1;
            const tool = config.tools?.find((candidate) => candidate.name === "protected");
            await tool?.execute({});
            yield { type: "turn_completed" };
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };
    const workspaceFactory = async ({ approvalGate }: {
      approvalGate: import("../../src/runtime/approval-gate.js").ApprovalGateHandle;
    }) => ({
      root: path.join(root, "workspace"),
      tools: [{
        name: "protected",
        label: "protected",
        description: "credential fixture",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await approvalGate.request("protected") }),
      }],
      dispose: async () => undefined,
    });

    const firstRepository = new DurableTaskRepository(root);
    const firstRuntime = await createDurableAgentRuntime({
      tasksRoot: root,
      repository: firstRepository,
      adapter,
      workspaceFactory,
    });
    const firstBase = await startServer((request, response) => {
      void firstRuntime.handle(request, response);
    });
    const accepted = await fetch(`${firstBase}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "restart_hil",
        input: "use protected operation",
        databases: [],
        mode: "agent",
      }),
    }).then((response) => response.json()) as { task_id: string; run_id: string };

    await expect.poll(async () => {
      const pending = await new DurableHILStore(firstRepository).findPendingForRun(
        accepted.task_id,
        accepted.run_id,
      );
      return pending?.request_id ?? null;
    }).not.toBeNull();
    const pending = await new DurableHILStore(firstRepository).findPendingForRun(
      accepted.task_id,
      accepted.run_id,
    );
    if (pending === null) throw new Error("missing pending HIL request");

    await firstRuntime.close();
    expect((await firstRepository.getSnapshot(accepted.task_id))?.runs[0]?.status).toBe(
      "awaiting_user_input",
    );

    const secondRepository = new DurableTaskRepository(root);
    const secondRuntime = await createDurableAgentRuntime({
      tasksRoot: root,
      repository: secondRepository,
      adapter,
      workspaceFactory,
    });
    const secondBase = await startServer((request, response) => {
      void secondRuntime.handle(request, response);
    });
    const response = await fetch(
      `${secondBase}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: pending.request_id,
          evidence_digest: pending.evidence_digest,
          decision: { action: "approve" },
          reason: null,
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect.poll(async () =>
      (await secondRepository.getSnapshot(accepted.task_id))?.runs[0]?.status,
    ).toBe("completed");
    expect(toolCalls).toBe(2);
    expect(
      (await secondRepository.listEvents(accepted.task_id, 0)).some(
        (event) => event.type === "run_interrupted",
      ),
    ).toBe(false);
    await secondRuntime.close();
  });

  it("reconciles a review committed before its resume event and restarts continuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-hil-commit-window-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: "review_commit_window",
      input: "continue after review",
      databases: [],
      mode: "agent",
    });
    const store = new DurableHILStore(repository);
    const request = await store.createRequest({
      task_id: accepted.task_id,
      run_id: accepted.run_id,
      requirement_id: null,
      kind: "permission",
      review_type: null,
      blocking: true,
      subject: {},
      review_items: [],
      summary: "approve protected operation",
      evidence: { operation: "protected" },
      policy_ref: "runtime.credential.v1",
      idempotency_key: "commit-window",
    });
    await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "user_input_required",
      request_id: request.request_id,
      prompt_kind: "api_key_or_credential",
      summary: request.summary,
      expires_at: null,
      fixture_exempt: false,
      detail: {},
      hil_request: request,
    });
    await store.resolveRequest(accepted.task_id, accepted.run_id, {
      request_id: request.request_id,
      evidence_digest: request.evidence_digest,
      decision: { action: "approve" },
      reason: null,
    });

    const adapter: BioMedAgentAdapter = {
      async createSession(config): Promise<BioMedAgentSession> {
        return {
          piSessionId: `pi_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run: async function* run(): AsyncIterable<BioMedAgentEvent> {
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
      workspaceFactory: async () => ({
        root: path.join(root, "workspace"),
        tools: [],
        dispose: async () => undefined,
      }),
    });

    await expect.poll(async () =>
      (await repository.getSnapshot(accepted.task_id))?.runs[0]?.status,
    ).toBe("completed");
    const events = await repository.listEvents(accepted.task_id, 0);
    expect(events.filter((event) => event.type === "user_input_resumed")).toHaveLength(1);
    expect(events.some((event) => event.type === "run_interrupted")).toBe(false);
    await runtime.close();
  });
});
