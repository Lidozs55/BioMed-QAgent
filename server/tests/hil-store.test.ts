import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableHILStore, HILConflictError } from "../src/runtime/hil-store.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  taskId: string;
  runId: string;
  repository: DurableTaskRepository;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "biomed-hil-store-"));
  roots.push(root);
  let sequence = 0;
  const repository = new DurableTaskRepository(root, {
    id: () => `fixed_${++sequence}`,
    now: () => new Date("2026-08-16T01:00:00.000Z"),
  });
  const accepted = await repository.createTask({
    requestId: "request_1",
    input: "Build a dataset",
    databases: [],
    mode: "agent",
  });
  await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
    type: "run_started",
  });
  return {
    root,
    taskId: accepted.task_id,
    runId: accepted.run_id,
    repository,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DurableHILStore", () => {
  it("reconciles a persisted request whose required event was not appended before restart", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    const request = await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: { mapping_ids: ["map_gene"] },
      review_items: [],
      summary: "Review mapping",
      evidence: { source: "Gene Symbol", target: "gene_symbol" },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: "crash-window",
    });

    const recoveries = await store.reconcileTaskTimeline();

    expect(recoveries).toMatchObject([{
      task_id: taskId,
      run_id: runId,
      request: { request_id: request.request_id },
      review: null,
    }]);
    expect((await repository.getSnapshot(taskId))?.runs[0]?.status).toBe(
      "awaiting_user_input",
    );
    expect(
      (await repository.listEvents(taskId, 0)).filter(
        (event) => event.type === "user_input_required",
      ),
    ).toHaveLength(1);
  });

  it("recovers an unresolved request from a new store instance", async () => {
    const { repository, taskId, runId } = await fixture();
    const first = new DurableHILStore(repository, {
      now: () => new Date("2026-08-16T01:01:00.000Z"),
    });
    const request = await first.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: { mapping_ids: ["map_gene"] },
      review_items: [],
      summary: "Review mapping",
      evidence: { source: "Gene Symbol", target: "gene_symbol" },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: "operation_1",
    });

    const recovered = await new DurableHILStore(repository).findPendingForRun(taskId, runId);
    expect(recovered).toEqual(request);
    expect(request.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the digest to the complete reviewer-visible snapshot", async () => {
    const firstFixture = await fixture();
    const secondFixture = await fixture();
    const baseInput = {
      build_id: "build_1",
      kind: "data_review" as const,
      review_type: "vlm_extraction" as const,
      blocking: true,
      subject: { record_ids: ["point_1"] },
      summary: "Review one chart point",
      evidence: { source_asset_id: "asset_1" },
      policy_ref: "dataset.vlm_extraction.v1",
      idempotency_key: "visible-snapshot",
    };
    const first = await new DurableHILStore(firstFixture.repository).createRequest({
      ...baseInput,
      task_id: firstFixture.taskId,
      run_id: firstFixture.runId,
      review_items: [{
        item_id: "point_1",
        summary: "series A: (1, 2)",
        subject: { record_ids: ["point_1"] },
        evidence: { label: "legible" },
        proposed_value: { x: "1", y: "2" },
        confidence_level: "low",
      }],
    });
    const second = await new DurableHILStore(secondFixture.repository).createRequest({
      ...baseInput,
      task_id: secondFixture.taskId,
      run_id: secondFixture.runId,
      review_items: [{
        item_id: "point_1",
        summary: "series A: (1, 3)",
        subject: { record_ids: ["point_1"] },
        evidence: { label: "ambiguous" },
        proposed_value: { x: "1", y: "3" },
        confidence_level: "low",
      }],
    });

    expect(first.evidence_digest).not.toBe(second.evidence_digest);
  });

  it("does not turn a non-blocking advisory into a blocking recovery prompt", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: "build_1",
      kind: "data_review",
      review_type: "vlm_extraction",
      blocking: false,
      subject: { record_ids: ["supporting_1"] },
      review_items: [],
      summary: "Optional supporting-data review",
      evidence: { record_id: "supporting_1" },
      policy_ref: "dataset.supporting.v1",
      idempotency_key: "advisory-restart",
    });

    expect(await store.reconcileTaskTimeline()).toEqual([]);
    expect((await repository.getSnapshot(taskId))?.runs[0]?.status).toBe("running");
    expect(
      (await repository.listEvents(taskId, 0)).some(
        (event) => event.type === "user_input_required",
      ),
    ).toBe(false);
  });

  it("interrupts a run when its blocking request was cancelled before restart", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    const request = await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "semantic_review",
      review_type: "unit_conversion",
      blocking: true,
      subject: { binding_id: "binding_1" },
      review_items: [],
      summary: "Review unit",
      evidence: { unit: "mystery" },
      policy_ref: "dataset.unit_conversion.v1",
      idempotency_key: "cancel-before-restart",
    });
    await repository.appendRunEvent(taskId, runId, {
      type: "user_input_required",
      request_id: request.request_id,
      prompt_kind: "data_correction",
      summary: request.summary,
      expires_at: null,
      fixture_exempt: false,
      detail: {},
      hil_request: request,
    });
    await store.cancelRequest(taskId, runId, request.request_id);

    expect(await store.reconcileTaskTimeline()).toEqual([]);
    await repository.recoverActiveRuns(new Set());
    expect((await repository.getSnapshot(taskId))?.runs[0]?.status).toBe("interrupted");
  });

  it("deduplicates the same operation and rejects a second blocking request", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    const input = {
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "permission" as const,
      review_type: null,
      blocking: true,
      subject: {},
      review_items: [],
      summary: "Approve credential use",
      evidence: { operation: "gdc.search" },
      policy_ref: "runtime.credential.v1",
      idempotency_key: "tool_call_1",
    };
    const created = await store.createRequest(input);
    await expect(store.createRequest(input)).resolves.toEqual(created);
    await expect(
      store.createRequest({ ...input, idempotency_key: "tool_call_2" }),
    ).rejects.toThrow(/blocking HIL request/);
  });

  it("binds resolution to task, run, request, and evidence", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    const request = await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "data_review",
      review_type: "vlm_extraction",
      blocking: true,
      subject: { record_ids: ["point_1"] },
      review_items: [],
      summary: "Review chart point",
      evidence: { point_1: { x: 1, y: 2 } },
      policy_ref: "dataset.vlm.v1",
      idempotency_key: "vlm_1",
    });

    await expect(
      store.resolveRequest(taskId, runId, {
        request_id: request.request_id,
        evidence_digest: "b".repeat(64),
        decision: { action: "accept" },
        reason: null,
      }),
    ).rejects.toThrow(/evidence/i);
    await expect(store.getRequest(taskId, request.request_id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("makes identical resume idempotent and rejects conflicting retries", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository, {
      now: () => new Date("2026-08-16T01:02:00.000Z"),
    });
    const request = await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "permission",
      review_type: null,
      blocking: true,
      subject: {},
      review_items: [],
      summary: "Approve credential use",
      evidence: { operation: "gdc.search" },
      policy_ref: "runtime.credential.v1",
      idempotency_key: "tool_call_1",
    });
    const resume = {
      request_id: request.request_id,
      evidence_digest: request.evidence_digest,
      decision: { action: "approve" as const },
      reason: null,
    };
    const first = await store.resolveRequest(taskId, runId, resume);
    const recoveredStore = new DurableHILStore(repository);
    const repeated = await recoveredStore.resolveRequest(taskId, runId, resume);
    expect(repeated).toEqual(first);
    expect((await recoveredStore.getRequest(taskId, request.request_id))?.status).toBe(
      "resolved",
    );
    await expect(
      recoveredStore.resolveRequest(taskId, runId, {
        ...resume,
        decision: { action: "reject" },
      }),
    ).rejects.toBeInstanceOf(HILConflictError);
  });

  it("rejects permission-only and review-only decision mismatches", async () => {
    const { repository, taskId, runId } = await fixture();
    const store = new DurableHILStore(repository);
    const request = await store.createRequest({
      task_id: taskId,
      run_id: runId,
      build_id: null,
      kind: "permission",
      review_type: null,
      blocking: true,
      subject: {},
      review_items: [],
      summary: "Approve credential use",
      evidence: { operation: "gdc.search" },
      policy_ref: "runtime.credential.v1",
      idempotency_key: "tool_call_1",
    });
    await expect(
      store.resolveRequest(taskId, runId, {
        request_id: request.request_id,
        evidence_digest: request.evidence_digest,
        decision: { action: "accept" },
        reason: null,
      }),
    ).rejects.toThrow(/permission/);
  });
});
