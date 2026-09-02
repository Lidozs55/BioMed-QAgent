import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseTaskExecutionContext,
  stableTaskExecutionContextJson,
  type TaskExecutionContext,
} from "@biomed/contracts";
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

function frozenGold6Context(
  overrides: Record<string, unknown> = {},
): TaskExecutionContext {
  return parseTaskExecutionContext({
    schema_version: "1.0",
    kind: "frozen_evaluation",
    manifest_id: "gold-v1",
    case_id: "gold6",
    manifest_sha256: "a".repeat(64),
    case_spec_sha256: "b".repeat(64),
    prompt_sha256: "2267815c0bab859bc0b7488837bd4682ca4248d6fcf84b15e4af8414ab34c92e",
    runtime_profile_sha256: "c".repeat(64),
    expected_family: "bioactivity_measurement",
    required_tables: ["paper_records", "chart_points"],
    allowed_sources: ["PubMed", "Europe PMC"],
    source_selection: { papers: ["PMC10408569"] },
    success_definition: "registered bioactivity publication with reverified artifact hashes",
    forbidden_shortcuts: ["prompt modification"],
    ...overrides,
  });
}

describe("DurableTaskRepository", () => {
  test("compares the frozen execution context on request-id reuse and replays it byte-equivalently after a Host restart", async () => {
    const repo = await repository();
    const executionContext = frozenGold6Context();
    const input = {
      requestId: "request-frozen-context",
      input: "frozen gold6 prompt",
      databases: [],
      mode: "agent" as const,
      executionContext,
    };

    const first = await repo.createTask(input);
    expect(await repo.createTask(input)).toEqual(first);
    await expect(repo.createTask({ ...input, executionContext: null })).rejects.toBeInstanceOf(
      DurableTaskConflictError,
    );
    await expect(
      repo.createTask({
        ...input,
        executionContext: frozenGold6Context({ case_id: "gold5" }),
      }),
    ).rejects.toBeInstanceOf(DurableTaskConflictError);

    // Host restart: a fresh repository instance replays the event log and
    // returns a byte-equivalent context.
    const restarted = new DurableTaskRepository(repo.tasksRoot);
    const snapshot = await restarted.getSnapshot(first.task_id);
    const replayed = snapshot?.runs[0]?.execution_context;
    expect(replayed).toEqual(executionContext);
    expect(stableTaskExecutionContextJson(replayed!)).toBe(
      stableTaskExecutionContextJson(executionContext),
    );
  });

  test("compares the frozen execution context when a run request id is reused", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-frozen-first",
      input: "first turn",
      databases: [],
      mode: "agent",
      executionContext: null,
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_completed" });
    const context = frozenGold6Context();

    const queued = await repo.createRun(accepted.task_id, {
      requestId: "request-frozen-run",
      input: "frozen follow-up",
      executionContext: context,
    });
    expect(
      await repo.createRun(accepted.task_id, {
        requestId: "request-frozen-run",
        input: "frozen follow-up",
        executionContext: context,
      }),
    ).toEqual(queued);
    await expect(
      repo.createRun(accepted.task_id, {
        requestId: "request-frozen-run",
        input: "frozen follow-up",
        executionContext: frozenGold6Context({ case_id: "gold5" }),
      }),
    ).rejects.toBeInstanceOf(DurableTaskConflictError);
  });

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

  test("fails orphaned permission requests closed before interrupting a restarted run", async () => {
    const repo = await repository();
    const pending = await repo.createTask({
      requestId: "request-permission-recovery",
      input: "wait for workspace permission",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(pending.task_id, pending.run_id, { type: "run_started" });
    await repo.appendRunEvent(pending.task_id, pending.run_id, {
      type: "permission_requested",
      request_id: "permission_orphaned",
      capability: "process.exec",
      scope: "workspace",
      resource: null,
      canonical_resource: null,
      command: "node inspect.js",
      cwd: "/workspace",
      summary: "Execute node inspect.js",
    });

    const resolved = await repo.createTask({
      requestId: "request-permission-resolved",
      input: "resolved workspace permission",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(resolved.task_id, resolved.run_id, { type: "run_started" });
    await repo.appendRunEvent(resolved.task_id, resolved.run_id, {
      type: "permission_requested",
      request_id: "permission_resolved_before_restart",
      capability: "process.exec",
      scope: "workspace",
      resource: null,
      canonical_resource: null,
      command: "node inspect.js",
      cwd: "/workspace",
      summary: "Execute node inspect.js",
    });
    await repo.appendRunEvent(resolved.task_id, resolved.run_id, {
      type: "permission_resolved",
      request_id: "permission_resolved_before_restart",
      decision: "allow",
      grant_scope: "once",
    });

    const reopened = new DurableTaskRepository(repo.tasksRoot);
    await expect(reopened.rejectOrphanedPermissionRequests()).resolves.toBe(1);
    await reopened.recoverActiveRuns();

    const pendingEvents = await reopened.listEvents(pending.task_id, 0);
    expect(pendingEvents.slice(-2).map((event) => event.payload)).toEqual([
      {
        type: "permission_resolved",
        request_id: "permission_orphaned",
        decision: "deny",
        grant_scope: null,
      },
      {
        type: "run_interrupted",
        reason: "Application Host restarted before the run reached a terminal state",
      },
    ]);
    expect((await reopened.getSnapshot(pending.task_id))?.runs[0]?.status).toBe("interrupted");
    expect((await reopened.listEvents(resolved.task_id, 0)).filter(
      (event) => event.payload.type === "permission_resolved",
    )).toHaveLength(1);
    await expect(reopened.rejectOrphanedPermissionRequests()).resolves.toBe(0);
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

  test("projects Core publication events once into the task snapshot", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-publication-projection",
      input: "publish a dataset",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_started" });
    const publication = {
      type: "publication_created" as const,
      publication_id: "pub_build_receipt",
      run_id: accepted.run_id,
      manifest_sha256: "a".repeat(64),
      supersedes_publication_id: null,
      published_at: "2026-08-20T00:00:00.000Z",
    };
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, publication);
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, publication);
    const artifact = {
      type: "artifact_produced" as const,
      artifact: {
        artifact_id: "artifact_projection",
        name: "dataset.csv",
        role: "primary_dataset",
        relative_path: "tables/dataset.csv",
        media_type: "text/csv",
        size_bytes: 12,
        sha256: "b".repeat(64),
        generated_by_step_id: "step_dataset_core_publish",
      },
    };
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, artifact);
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, artifact);
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_completed",
    });

    const snapshot = await repo.getSnapshot(accepted.task_id);
    expect(snapshot?.current_publication_id).toBe("pub_build_receipt");
    expect(snapshot?.task.artifact_count).toBe(1);
    expect(snapshot?.publications).toEqual([{
      publication_id: "pub_build_receipt",
      manifest_sha256: "a".repeat(64),
      supersedes_publication_id: null,
      published_at: "2026-08-20T00:00:00.000Z",
    }]);
  });

  test("registers the publication pointer even when the run later fails", async () => {
    const repo = await repository();
    const accepted = await repo.createTask({
      requestId: "request-publication-then-failure",
      input: "publish a dataset",
      databases: [],
      mode: "agent",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_started" });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "publication_created",
      publication_id: "pub_failed_run_publication",
      run_id: accepted.run_id,
      manifest_sha256: "c".repeat(64),
      supersedes_publication_id: null,
      published_at: "2026-08-20T00:00:00.000Z",
    });
    await repo.appendRunEvent(accepted.task_id, accepted.run_id, {
      type: "run_failed",
      error: "Context compaction did not reduce the estimated context",
      error_code: "internal_error",
    });

    // The publication is an immutable product that already hit the event
    // stream and disk; a subsequent run failure must not un-register it.
    const snapshot = await repo.getSnapshot(accepted.task_id);
    expect(snapshot?.current_publication_id).toBe("pub_failed_run_publication");
    expect(snapshot?.publications).toHaveLength(1);
    expect(snapshot?.runs[0]?.status).toBe("failed");
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
    });
    const snapshot = await repo.getSnapshot(accepted.task_id);
    const secondPage = await repo.listEvents(accepted.task_id, 1_000, 10);

    expect(terminal.sequence).toBe(1_004);
    expect(snapshot?.task.latest_sequence).toBe(1_004);
    expect(snapshot?.messages[1]?.content).toHaveLength(1_001);
    expect(secondPage.map((event) => event.sequence)).toEqual([1_001, 1_002, 1_003, 1_004]);
  });
});
