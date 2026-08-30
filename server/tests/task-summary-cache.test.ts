import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<DurableTaskRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-summary-cache-"));
  roots.push(root);
  return new DurableTaskRepository(root);
}

/** A finished task so it lands in the paginated history instead of active_items. */
async function completedTask(
  repo: DurableTaskRepository,
  requestId: string,
  input: string,
): Promise<{ taskId: string; runId: string }> {
  const accepted = await repo.createTask({ requestId, input, databases: [], mode: "agent" });
  await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_completed" });
  return { taskId: accepted.task_id, runId: accepted.run_id };
}

function sidecarPath(repo: DurableTaskRepository, taskId: string): string {
  return path.join(repo.tasksRoot, taskId, "state", "summary.json");
}

describe("task summary cache (listTasks)", () => {
  test("warm and cold list calls return identical pages", async () => {
    const repo = await repository();
    const first = await completedTask(repo, "req_summary_warm_1", "first task\nbody");
    const active = await repo.createTask({ requestId: "req_summary_warm_2", input: "still queued", databases: [], mode: "agent" });

    const cold = await repo.listTasks(50);
    const warm = await repo.listTasks(50);
    expect(warm).toEqual(cold);
    expect(cold.items).toHaveLength(1);
    expect(cold.items[0]?.task_id).toBe(first.taskId);
    expect(cold.items[0]?.status).toBe("completed");
    expect(cold.active_items.map((task) => task.task_id)).toEqual([active.task_id]);
  });

  test("serves the persisted sidecar across restarts and invalidates on event-log growth", async () => {
    const repo = await repository();
    const { taskId, runId } = await completedTask(repo, "req_summary_grow_1", "sidecar task");
    await repo.listTasks(50);

    const written = JSON.parse(await readFile(sidecarPath(repo, taskId), "utf8"));
    expect(written.task.task_id).toBe(taskId);

    // A fresh repository (empty in-memory cache) must serve the sidecar…
    const revived = new DurableTaskRepository(repo.tasksRoot);
    await writeFile(
      sidecarPath(repo, taskId),
      `${JSON.stringify({ ...written, task: { ...written.task, title: "sidecar sentinel" } })}\n`,
      "utf8",
    );
    const fromSidecar = await revived.listTasks(50);
    expect(fromSidecar.items[0]?.title).toBe("sidecar sentinel");

    // …until the event log grows: the stat key changes and the summary is recomputed.
    await appendFile(
      path.join(repo.tasksRoot, taskId, "events.jsonl"),
      `${JSON.stringify({
        schema_version: "2.0",
        event_id: "event_external_growth",
        type: "run_failed",
        task_id: taskId,
        run_id: runId,
        stage_attempt_id: null,
        sequence: 4,
        timestamp: "2030-01-01T00:00:00.000Z",
        payload: { type: "run_failed", error: "external growth" },
      })}\n`,
      "utf8",
    );
    const recomputed = await revived.listTasks(50);
    expect(recomputed.items[0]?.title).toBe("sidecar task");
    expect(recomputed.items[0]?.status).toBe("failed");
    expect(recomputed.items[0]?.updated_at).toBe("2030-01-01T00:00:00.000Z");
  });

  test("a corrupted sidecar degrades to recompute", async () => {
    const repo = await repository();
    const { taskId } = await completedTask(repo, "req_summary_corrupt_1", "corrupt sidecar");
    await repo.listTasks(50);
    await writeFile(sidecarPath(repo, taskId), "{not json", "utf8");

    const fresh = new DurableTaskRepository(repo.tasksRoot);
    const page = await fresh.listTasks(50);
    expect(page.items[0]?.title).toBe("corrupt sidecar");
  });

  test("a metadata change invalidates the cached summary", async () => {
    const repo = await repository();
    const { taskId } = await completedTask(repo, "req_summary_meta_1", "meta task");
    await repo.listTasks(50);
    const written = JSON.parse(await readFile(sidecarPath(repo, taskId), "utf8"));
    await writeFile(
      sidecarPath(repo, taskId),
      `${JSON.stringify({ ...written, task: { ...written.task, title: "stale sentinel" } })}\n`,
      "utf8",
    );

    await repo.recordPiSessionId(taskId, "pi_session_meta_1");
    const page = await repo.listTasks(50);
    expect(page.items[0]?.title).toBe("meta task");
  });

  test("deleteTask removes the cached summary", async () => {
    const repo = await repository();
    const { taskId } = await completedTask(repo, "req_summary_delete_1", "deletable");
    await repo.listTasks(50);

    await repo.deleteTask(taskId);
    const page = await repo.listTasks(50);
    expect(page.items).toHaveLength(0);
    expect(page.active_items).toHaveLength(0);
  });

  test("pagination and ordering are unchanged by the cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-summary-cache-"));
    roots.push(root);
    let clock = 0;
    const repo = new DurableTaskRepository(root, { now: () => new Date(1_000_000 + (clock += 1_000)) });
    const first = await completedTask(repo, "req_summary_page_1", "oldest");
    const second = await completedTask(repo, "req_summary_page_2", "middle");
    const third = await completedTask(repo, "req_summary_page_3", "newest");
    expect([first.taskId, second.taskId, third.taskId]).not.toContain(undefined);

    const page = await repo.listTasks(2);
    expect(page.items.map((task) => task.task_id)).toEqual([third.taskId, second.taskId]);
    expect(page.next_cursor).toBe(second.taskId);
    expect(page.active_items).toHaveLength(0);

    const everything = await repo.listTasks(100);
    expect(everything.items.map((task) => task.task_id)).toEqual([
      third.taskId,
      second.taskId,
      first.taskId,
    ]);
    expect(everything.next_cursor).toBeNull();
  });
});
