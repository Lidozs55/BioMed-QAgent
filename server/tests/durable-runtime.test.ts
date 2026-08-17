import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DurableTaskConflictError,
  DurableTaskRepository,
} from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<DurableTaskRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-runtime-"));
  roots.push(root);
  return new DurableTaskRepository(root);
}

describe("DurableTaskRepository", () => {
  test("continues per-task event sequence and rebuilds a snapshot after reopen", async () => {
    const first = await repository();
    const accepted = await first.createTask({
      requestId: "request-1",
      input: "find expression data",
      databases: ["gdc"],
      mode: "agent",
    });
    await first.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_started",
    });
    await first.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "assistant_delta",
      delta: "working",
    });

    const reopened = new DurableTaskRepository(first.tasksRoot);
    const next = await reopened.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_completed",
      build_result: null,
    });
    const snapshot = await reopened.getSnapshot(accepted.task_id);

    expect(next.sequence).toBe(5);
    expect(snapshot?.task.status).toBe("completed");
    expect(snapshot?.task.active_run_id).toBeNull();
    expect(snapshot?.runs[0]).toMatchObject({
      run_id: accepted.run_id,
      status: "completed",
    });
    expect(snapshot?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("rejects createTask input that contains corrupted UTF-8 replacement characters", async () => {
    const repo = await repository();
    await expect(
      repo.createTask({
        requestId: "request-utf8-task",
        input: "\uFFFD\uFFFD\uFFFD 肺腺癌 EGFR 突变状态",
        databases: [],
        mode: "agent",
      }),
    ).rejects.toThrow(/corrupted UTF-8 text \(U\+FFFD/u);
  });

  test("rejects createRun input that contains corrupted UTF-8 replacement characters", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-utf8-run",
      input: "find expression data",
      databases: [],
      mode: "agent",
    });
    await expect(
      repo.createRun(accepted.task_id, {
        requestId: "request-utf8-run-2",
        input: "\uFFFD\uFFFD\uFFFD 肺腺癌 EGFR 突变状态",
      }),
    ).rejects.toThrow(/corrupted UTF-8 text \(U\+FFFD/u);
  });

  test("marks an active run interrupted during recovery without changing completed history", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-2",
      input: "long running request",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_started",
    });

    const recovered = new DurableTaskRepository(repo.tasksRoot);
    await recovered.recoverActiveRuns();
    const snapshot = await recovered.getSnapshot(accepted.task_id);
    const events = await recovered.listEvents(accepted.task_id, 0);

    expect(snapshot?.task.status).toBe("interrupted");
    expect(snapshot?.runs[0]?.status).toBe("interrupted");
    expect(events.at(-1)?.type).toBe("run_interrupted");
    await expect(recovered.recoverActiveRuns()).resolves.toBeUndefined();
    expect((await recovered.listEvents(accepted.task_id, 0)).length).toBe(events.length);
  });

  test("preserves only an explicitly reconciled formal-HIL run during recovery", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-hil-recovery",
      input: "wait for review",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_started",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "user_input_required",
      request_id: "hil_recovery",
      prompt_kind: "data_correction",
      summary: "Review one mapping",
      expires_at: null,
      fixture_exempt: false,
      detail: {},
    });

    const recovered = new DurableTaskRepository(repo.tasksRoot);
    await recovered.recoverActiveRuns(new Set([
      `${accepted.task_id}:${accepted.run_id}`,
    ]));
    const snapshot = await recovered.getSnapshot(accepted.task_id);
    const events = await recovered.listEvents(accepted.task_id, 0);

    expect(snapshot?.runs[0]?.status).toBe("awaiting_user_input");
    expect(events.at(-1)?.type).toBe("user_input_required");
  });

  test("interrupts an awaiting legacy prompt that has no recoverable continuation", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-legacy-recovery",
      input: "wait for legacy prompt",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_started" });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "user_input_required",
      request_id: "legacy_recovery",
      prompt_kind: "no_progress",
      summary: "Continue?",
      expires_at: null,
      fixture_exempt: false,
      detail: {},
    });

    const recovered = new DurableTaskRepository(repo.tasksRoot);
    await recovered.recoverActiveRuns();

    expect((await recovered.getSnapshot(accepted.task_id))?.runs[0]?.status).toBe("interrupted");
    expect((await recovered.listEvents(accepted.task_id, 0)).at(-1)?.type).toBe("run_interrupted");
  });

  test("makes request admission idempotent and rejects semantic request-id reuse", async () => {
    const repo = await repository();
    const input = {
      requestId: "request-idempotent",
      input: "same request",
      databases: ["gdc"],
      mode: "agent" as const,
    };

    const first = await repo.createTask(input);
    const retry = await repo.createTask(input);

    expect(retry).toEqual(first);
    await expect(repo.createTask({ ...input, input: "different request" })).rejects.toBeInstanceOf(
      DurableTaskConflictError,
    );
  });

  test("admits a later run only after the current run is terminal", async () => {
    const repo = await repository();
    const first = await repo.createTask({
      requestId: "request-first",
      input: "first turn",
      databases: [],
      mode: "agent",
    });

    await expect(repo.createRun(first.task_id, {
      requestId: "request-too-early",
      input: "second turn",
    })).rejects.toBeInstanceOf(DurableTaskConflictError);
    await repo.appendRunEvent(first.task_id, first.run_id, {
      type: "run_completed",
      build_result: null,
    });

    const second = await repo.createRun(first.task_id, {
      requestId: "request-second",
      input: "second turn",
    });
    const snapshot = await repo.getSnapshot(first.task_id);

    expect(second.run_id).not.toBe(first.run_id);
    expect(snapshot?.runs.map((run) => run.input)).toEqual(["first turn", "second turn"]);
    expect(snapshot?.task.active_run_id).toBe(second.run_id);
  });

  test("projects build status from the latest run only", async () => {
    const repo = await repository();
    const first = await repo.createTask({
      requestId: "request-build-status-first",
      input: "first build",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(first.task_id, first.run_id, {
      type: "run_completed",
      build_result: {
        status: "succeeded",
        valid_row_count: 1,
        successful_sources: ["source-1"],
        rejected_sources: [],
        available_artifact_roles: ["primary"],
        publication_id: "publication-1",
        reason_codes: [],
        user_summary: "Build succeeded",
        recommended_next_action: "Review the dataset",
        build_id: "build-1",
      },
    });
    expect((await repo.getSnapshot(first.task_id))?.task.latest_build_status).toBe("succeeded");

    const second = await repo.createRun(first.task_id, {
      requestId: "request-build-status-second",
      input: "second build",
    });
    expect((await repo.getSnapshot(first.task_id))?.task.latest_build_status).toBeNull();

    await repo.appendRunEvent(first.task_id, second.run_id, {
      type: "run_failed",
      error: "Second build failed",
      error_code: "internal_error",
    });
    expect((await repo.getSnapshot(first.task_id))?.task.latest_build_status).toBeNull();
  });

  test("keeps sequence and snapshot projection correct beyond one replay page", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-long-stream",
      input: "long stream",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvents(
      accepted.task_id,
      accepted.run_id,
      Array.from({ length: 1_001 }, (_, index) => ({
        type: "assistant_delta" as const,
        delta: String(index % 10),
      })),
    );

    const terminal = await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_completed",
      build_result: null,
    });
    const snapshot = await repo.getSnapshot(accepted.task_id);
    const secondPage = await repo.listEvents(accepted.task_id, 1_000, 10);

    expect(terminal.sequence).toBe(1_004);
    expect(snapshot?.task.latest_sequence).toBe(1_004);
    expect(snapshot?.messages[1]?.content).toHaveLength(1_001);
    expect(secondPage.map((event) => event.sequence)).toEqual([1_001, 1_002, 1_003, 1_004]);
  });
});
