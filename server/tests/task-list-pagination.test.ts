import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A finished task so it lands in the paginated history instead of active_items. */
async function completedTask(
  repo: DurableTaskRepository,
  requestId: string,
): Promise<string> {
  const accepted = await repo.createTask({
    requestId,
    input: `input ${requestId}`,
    databases: [],
    mode: "agent",
  });
  await repo.appendRunEvent(accepted.task_id, accepted.run_id, { type: "run_completed" });
  return accepted.task_id;
}

describe("listTasks cursor pagination", () => {
  test("continues exclusively after the cursor task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-cursor-"));
    roots.push(root);
    let clock = 0;
    const repo = new DurableTaskRepository(root, { now: () => new Date(1_000_000 + (clock += 1_000)) });
    const first = await completedTask(repo, "req_cursor_a");
    const second = await completedTask(repo, "req_cursor_b");
    const third = await completedTask(repo, "req_cursor_c");

    const page1 = await repo.listTasks(2);
    expect(page1.items.map((task) => task.task_id)).toEqual([third, second]);
    expect(page1.next_cursor).toBe(second);

    const page2 = await repo.listTasks(2, page1.next_cursor);
    expect(page2.items.map((task) => task.task_id)).toEqual([first]);
    expect(page2.next_cursor).toBeNull();
  });

  test("an unknown cursor yields an empty page and keeps active items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-cursor-"));
    roots.push(root);
    const repo = new DurableTaskRepository(root);
    const active = await repo.createTask({
      requestId: "req_cursor_active",
      input: "still queued",
      databases: [],
      mode: "agent",
    });

    const page = await repo.listTasks(2, "task_ts_missing");
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.active_items.map((task) => task.task_id)).toEqual([active.task_id]);
  });

  test("cursor pages keep returning the active items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-cursor-"));
    roots.push(root);
    let clock = 0;
    const repo = new DurableTaskRepository(root, { now: () => new Date(1_000_000 + (clock += 1_000)) });
    const active = await repo.createTask({
      requestId: "req_cursor_active2",
      input: "still queued",
      databases: [],
      mode: "agent",
    });
    const first = await completedTask(repo, "req_cursor_d");
    const second = await completedTask(repo, "req_cursor_e");

    const page1 = await repo.listTasks(1);
    expect(page1.items.map((task) => task.task_id)).toEqual([second]);
    expect(page1.next_cursor).toBe(second);

    const page2 = await repo.listTasks(1, page1.next_cursor);
    expect(page2.items.map((task) => task.task_id)).toEqual([first]);
    expect(page2.active_items.map((task) => task.task_id)).toEqual([active.task_id]);
  });
});
