import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable runtime fault injection", () => {
  test("event append failure rejects instead of reporting false success (M04-T10)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "biomed-fault-"));
    roots.push(root);
    const repo = new DurableTaskRepository(root);
    const created = await repo.createTask({
      requestId: "req-1",
      input: "task",
      databases: [],
      mode: "agent",
    });

    const eventsPath = path.join(repo.tasksRoot, created.task_id, "events.jsonl");
    rmSync(eventsPath, { force: true });
    mkdirSync(eventsPath);

    await expect(
      repo.appendRunEvent(created.task_id, created.run_id, {
        type: "run_queued",
        request_id: "req-2",
        input: "x",
      }),
    ).rejects.toThrow();
  });
});