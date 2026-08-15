import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<DurableTaskRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ts-events-corrupt-"));
  roots.push(root);
  return new DurableTaskRepository(root);
}

describe("durable event log corruption fails closed", () => {
  test("rejects a malformed JSON line with an actionable error", async () => {
    const repo = await repository();
    const taskId = "task_corrupt_json";
    await mkdir(path.join(repo.tasksRoot, taskId), { recursive: true });
    await writeFile(
      path.join(repo.tasksRoot, taskId, "events.jsonl"),
      '{"sequence":1,"type":"task_created"}\n{broken\n',
      "utf8",
    );
    await expect(repo.listEvents(taskId, 0)).rejects.toThrow(/events\.jsonl line 2 is not valid JSON/);
  });

  test("rejects a sequence gap with an actionable error", async () => {
    const repo = await repository();
    const taskId = "task_sequence_gap";
    await mkdir(path.join(repo.tasksRoot, taskId), { recursive: true });
    await writeFile(
      path.join(repo.tasksRoot, taskId, "events.jsonl"),
      '{"sequence":1,"type":"task_created"}\n{"sequence":3,"type":"run_queued"}\n',
      "utf8",
    );
    await expect(repo.listEvents(taskId, 0)).rejects.toThrow(/sequence gap at line 2: expected 2, got 3/);
  });
});