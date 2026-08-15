import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("concurrent task admission", () => {
  test("admits 50 concurrent tasks without request-id or sequence corruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-concurrent-"));
    roots.push(root);
    const repo = new DurableTaskRepository(root);

    const admitted = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        repo.createTask({
          requestId: `req-${index}`,
          input: `task ${index}`,
          databases: [],
          mode: "agent",
        }),
      ),
    );

    expect(new Set(admitted.map((item) => item.task_id)).size).toBe(50);
    expect(new Set(admitted.map((item) => item.request_id)).size).toBe(50);

    const page = await repo.listTasks(100);
    expect(page.active_items.length).toBe(50);

    for (const task of page.active_items) {
      const snapshot = await repo.getSnapshot(task.task_id);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.task.latest_sequence).toBe(2);
    }
  });
});