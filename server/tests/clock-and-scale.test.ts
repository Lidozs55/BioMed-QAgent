import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("clock jump and scale", () => {
  test("event sequence stays monotonic across a backward clock jump (M14)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-clock-"));
    roots.push(root);
    let now = Date.parse("2026-08-15T10:00:00Z");
    const repo = new DurableTaskRepository(root, { now: () => new Date(now) });
    const a = await repo.createTask({ requestId: "req-a", input: "a", databases: [], mode: "agent" });
    now = Date.parse("2020-01-01T00:00:00Z");
    const b = await repo.createTask({ requestId: "req-b", input: "b", databases: [], mode: "agent" });
    expect((await repo.getSnapshot(a.task_id))?.task.latest_sequence).toBe(2);
    expect((await repo.getSnapshot(b.task_id))?.task.latest_sequence).toBe(2);
  });

  test("admits 100 concurrent tasks (M14)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-100-"));
    roots.push(root);
    const repo = new DurableTaskRepository(root);
    const admitted = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        repo.createTask({ requestId: `req-${i}`, input: `t${i}`, databases: [], mode: "agent" }),
      ),
    );
    expect(new Set(admitted.map((x) => x.task_id)).size).toBe(100);
    expect((await repo.listTasks(100)).active_items.length).toBe(100);
  });
});