/**
 * HIL × operation-timeout integration (review round 1, P0/P1):
 *
 * 1. A human review wait must NOT count against the per-operation wall-clock
 *    timeout — the runner declares the suspension and the executor pauses
 *    the timer, so a review answered after the budget would otherwise expire
 *    must still complete the build.
 * 2. The remaining compute budget is still enforced after the suspension
 *    resumes.
 * 3. Cancelling the build while a review is pending finalizes as
 *    ``cancelled`` (the gate rejects with OperationAbortedError), and a
 *    replay of the same operation after a cancelled request creates a fresh
 *    generation instead of dead-waiting on the terminal one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HumanReviewRecord } from "@biomed/contracts";

import { parseDataBatch } from "../../src/dataset/contracts/data.js";
import type { DatasetBuildSpec } from "../../src/dataset/contracts/index.js";
import { expressionNormalizationV1 } from "../../src/dataset/canonicalizer/profiles.js";
import { reviewBatchForHIL } from "../../src/dataset/review/hil-policy.js";
import {
  DatasetBuildExecutor,
} from "../../src/dataset/runtime/executor.js";
import { buildOperationPlan, makeOperationOutput } from "../../src/dataset/runtime/index.js";
import { DurableHILGate } from "../../src/runtime/hil-gate.js";
import { DurableHILStore } from "../../src/runtime/hil-store.js";
import { DurableTaskRepository } from "../../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function spec(overrides: Record<string, unknown> = {}): DatasetBuildSpec {
  return {
    schema_version: "1.0",
    build_id: "build_hil",
    objective: "compare TP53 expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
    ...overrides,
  } as DatasetBuildSpec;
}

async function fixture(): Promise<{
  root: string;
  taskId: string;
  runId: string;
  repository: DurableTaskRepository;
  store: DurableHILStore;
  gate: DurableHILGate;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p5-hil-timeout-"));
  roots.push(root);
  let sequence = 0;
  const repository = new DurableTaskRepository(root, {
    id: () => `fixed_${++sequence}`,
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
  const store = new DurableHILStore(repository);
  const gate = new DurableHILGate(accepted.task_id, repository, accepted.run_id, store);
  return { root, taskId: accepted.task_id, runId: accepted.run_id, repository, store, gate };
}

function batchWithProposedMappings() {
  return parseDataBatch({
    batch_id: "batch_1",
    binding_id: "binding_gdc",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample",
    schema_ref: "gene_expression.long.v1",
    file_asset: null,
    row_count: 3,
    column_count: 4,
    parser_id: "fixture",
    parser_version: "1.0.0",
    statistics: { expression_unit: "tpm" },
    warnings: [],
    declared_mappings: [{
      mapping_id: "map_gene",
      source_schema_ref: "source.v1",
      target_schema_ref: "gene_expression.long.v1",
      source_field: "Gene Symbol",
      target_field: "gene_id",
      transform: "identity",
      mapping_method: "string_similarity",
      confidence_level: "low",
      evidence: "fixture evidence",
      review_status: "proposed",
    }],
  });
}

async function resolveReview(
  store: DurableHILStore,
  taskId: string,
  runId: string,
  requestId: string,
  decision: HumanReviewRecord["decision"],
): Promise<HumanReviewRecord> {
  const request = await store.getRequest(taskId, requestId);
  if (request === null) throw new Error("HIL request not found");
  return store.resolveRequest(taskId, runId, {
    request_id: request.request_id,
    evidence_digest: request.evidence_digest,
    decision,
    reason: null,
  });
}

async function waitForRequest(
  store: DurableHILStore,
  taskId: string,
  runId: string,
): Promise<import("@biomed/contracts").HILRequest> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pending = await store.findPendingForRun(taskId, runId);
    if (pending !== null) return pending;
    if (Date.now() > deadline) throw new Error("no pending HIL request appeared");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HIL wait vs operation timeout (review P0/P1)", () => {
  it("suspends the operation timeout while the runner waits for human review", async () => {
    const { taskId, runId, store, gate } = await fixture();
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-hil-susp-"));
    roots.push(taskRoot);
    const buildSpec = spec({ build_id: "build_suspend" });
    const executor = new DatasetBuildExecutor({
      taskId,
      buildId: "build_suspend",
      stateDir: path.join(taskRoot, "state"),
      taskRoot,
      plan: buildOperationPlan(buildSpec),
      runOperation: async (op, _upstream, signal, suspension) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        if (op.kind === "canonicalize") {
          const reviewed = await reviewBatchForHIL({
            batch: batchWithProposedMappings(),
            profile: expressionNormalizationV1(),
            gate,
            buildId: "build_suspend",
            signal,
            suspension: suspension ?? null,
          });
          if (reviewed.batch.declared_mappings[0]?.review_status !== "accepted") {
            throw new Error("mapping was not human-approved");
          }
          return makeOperationOutput({ binding_id: op.category });
        }
        return makeOperationOutput({});
      },
      operationTimeoutMs: 80,
    });

    const pending = executor.run();
    const request = await waitForRequest(store, taskId, runId);
    // Wait well past the operation budget while the human is away.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stillPending = await store.getRequest(taskId, request.request_id);
    expect(stillPending?.status).toBe("pending");

    const review = await resolveReview(store, taskId, runId, request.request_id, {
      action: "accept",
    });
    expect(gate.resolvePending(runId, review)).toBe(true);

    const outcome = await pending;
    expect(outcome.status).toBe("completed");
    expect(outcome.error).toBeNull();
    // The reviewed request resolved as a single generation: no cancellation,
    // no replay.
    expect((await store.getRequest(taskId, request.request_id))?.status).toBe("resolved");
    expect((await store.getRequest(taskId, request.request_id))?.request_id).toBe(
      request.request_id,
    );
  });

  it("enforces the remaining compute budget after the suspension resumes", async () => {
    const { taskId, runId, store, gate } = await fixture();
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-hil-budget-"));
    roots.push(taskRoot);
    const executor = new DatasetBuildExecutor({
      taskId,
      buildId: "build_budget",
      stateDir: path.join(taskRoot, "state"),
      taskRoot,
      plan: buildOperationPlan(spec({ build_id: "build_budget" })),
      runOperation: async (op, _upstream, signal, suspension) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        if (op.kind === "canonicalize") {
          const reviewed = await reviewBatchForHIL({
            batch: batchWithProposedMappings(),
            profile: expressionNormalizationV1(),
            gate,
            buildId: "build_budget",
            signal,
            suspension: suspension ?? null,
          });
          if (reviewed.batch.declared_mappings[0]?.review_status !== "accepted") {
            throw new Error("mapping was not human-approved");
          }
          // Exceed the remaining budget (80ms) after the wait.
          await new Promise((resolve) => setTimeout(resolve, 250));
          return makeOperationOutput({ binding_id: op.category });
        }
        return makeOperationOutput({});
      },
      operationTimeoutMs: 80,
    });

    const pending = executor.run();
    const request = await waitForRequest(store, taskId, runId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const review = await resolveReview(store, taskId, runId, request.request_id, {
      action: "accept",
    });
    gate.resolvePending(runId, review);

    const outcome = await pending;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("timeout");
    if (outcome.error !== null) {
      expect(outcome.error.message).toContain("timed out after 80ms");
    }
  });

  it("finalizes a build cancelled during a human review as cancelled, not failed", async () => {
    const { taskId, runId, store, gate } = await fixture();
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-hil-cancel-"));
    roots.push(taskRoot);
    const cancellationSignal = new AbortController();
    const executor = new DatasetBuildExecutor({
      taskId,
      buildId: "build_cancel",
      stateDir: path.join(taskRoot, "state"),
      taskRoot,
      plan: buildOperationPlan(spec({ build_id: "build_cancel" })),
      runOperation: async (op, _upstream, signal, suspension) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        if (op.kind === "canonicalize") {
          await reviewBatchForHIL({
            batch: batchWithProposedMappings(),
            profile: expressionNormalizationV1(),
            gate,
            buildId: "build_cancel",
            signal,
            suspension: suspension ?? null,
          });
          throw new Error("unreachable: review was cancelled");
        }
        return makeOperationOutput({});
      },
      operationTimeoutMs: 5_000,
      cancellationSignal: cancellationSignal.signal,
    });

    const pending = executor.run();
    const request = await waitForRequest(store, taskId, runId);
    cancellationSignal.abort();
    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    await expect.poll(async () =>
      (await store.getRequest(taskId, request.request_id))?.status
    ).toBe("cancelled");
  });

  it("recreates a fresh generation instead of dead-waiting on a cancelled request", async () => {
    const { taskId, runId, store, gate } = await fixture();
    const controller = new AbortController();
    const first = gate.requestHIL({
      build_id: "build_replay",
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: { mapping_ids: ["map_gene"] },
      review_items: [],
      summary: "Review mapping",
      evidence: { source: "Gene Symbol" },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: "build_replay:binding_gdc:field_mapping",
    }, controller.signal);
    const firstRequest = await waitForRequest(store, taskId, runId);
    controller.abort();
    await expect(first).rejects.toThrow("aborted");
    await expect.poll(async () =>
      (await store.getRequest(taskId, firstRequest.request_id))?.status
    ).toBe("cancelled");

    // The same operation replays with the same deterministic input: it must
    // NOT return the cancelled request.
    const second = gate.requestHIL({
      build_id: "build_replay",
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: { mapping_ids: ["map_gene"] },
      review_items: [],
      summary: "Review mapping",
      evidence: { source: "Gene Symbol" },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: "build_replay:binding_gdc:field_mapping",
    });
    const secondRequest = await waitForRequest(store, taskId, runId);
    expect(secondRequest.request_id).not.toBe(firstRequest.request_id);
    expect(secondRequest.request_id).toMatch(/_g2$/);
    expect(secondRequest.status).toBe("pending");

    const review = await resolveReview(store, taskId, runId, secondRequest.request_id, {
      action: "accept",
    });
    expect(gate.resolvePending(runId, review)).toBe(true);
    const resolved = await second;
    expect(resolved).toEqual(review);
  });
});

describe("executor suspension mechanics", () => {
  it("keeps the timeout paused across repeated suspensions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-suspend-mech-"));
    roots.push(root);
    const executor = new DatasetBuildExecutor({
      taskId: "task_t",
      buildId: "build_t",
      stateDir: path.join(root, "state"),
      taskRoot: root,
      plan: buildOperationPlan(spec({ build_id: "build_t" })),
      runOperation: async (op, _upstream, _signal, suspension) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        for (let round = 0; round < 3; round += 1) {
          suspension?.suspend();
          await new Promise((resolve) => setTimeout(resolve, 60));
          suspension?.resume();
        }
        return makeOperationOutput({});
      },
      operationTimeoutMs: 100,
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe("completed");
  });

  it("still times out a runner that never suspends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-suspend-timeout-"));
    roots.push(root);
    const executor = new DatasetBuildExecutor({
      taskId: "task_t",
      buildId: "build_t",
      stateDir: path.join(root, "state"),
      taskRoot: root,
      plan: buildOperationPlan(spec({ build_id: "build_t" })),
      runOperation: async (op) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        return makeOperationOutput({});
      },
      operationTimeoutMs: 60,
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("timeout");
  });
});