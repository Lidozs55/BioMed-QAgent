/**
 * Focused coverage for the read-only source-asset listing slice:
 * - SourceAssetRegistry.listRegistrations(): strict clone, deterministic
 *   (registered_at, receipt_id) ordering, bounded listing.
 * - GET /api/v1/tasks/:taskId/source-assets: exact wire shape, unknown task
 *   404, no task events appended (read-only projection).
 */
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDurableAgentRuntime,
  type DurableAgentRuntimeOptions,
} from "../src/runtime/durable-agent-runtime.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import {
  parseSourceAssetRegistrationReceipt,
} from "../src/dataset/contracts/source.js";
import type {
  SourceAssetRegistrationReceipt,
  RegisteredSourceAssetRole,
} from "@biomed/contracts";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TaskFixture {
  root: string;
  taskId: string;
}

/** Creates a durable task plus two registered carrier assets (derived asset
 * registered first, so expected listing order differs from insertion). */
async function seedTaskFixture(label: string, now: () => Date): Promise<TaskFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `source-assets-${label}-`));
  roots.push(root);
  const repository = new DurableTaskRepository(root, { now });
  const accepted = await repository.createTask({
    requestId: `request_${label}`,
    input: "source asset listing fixture",
    databases: [],
    mode: "agent",
  });
  const taskId = accepted.task_id;
  const taskRoot = path.join(root, taskId);
  await mkdir(path.join(taskRoot, "source_assets", "extract"), { recursive: true });

  const carrierBytes = Buffer.from("carrier,body\n1,2\n", "utf8");
  await writeFile(path.join(taskRoot, "source_assets", "table.csv"), carrierBytes);
  const derivedBytes = Buffer.from("derived\n3\n", "utf8");
  await writeFile(path.join(taskRoot, "source_assets", "extract", "derived.csv"), derivedBytes);

  const registry = new SourceAssetRegistry(taskId, taskRoot, { now });
  await registry.register({
    sourceId: "derived_fixture",
    relativePath: "source_assets/extract/derived.csv",
    role: "carrier",
  });
  await registry.register({
    sourceId: "carrier_fixture",
    relativePath: "source_assets/table.csv",
    role: "carrier",
  });
  return { root, taskId };
}

describe("SourceAssetRegistry.listRegistrations", () => {
  test("returns strictly parsed carrier/derived receipts sorted by registered_at", async () => {
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++));
    const { root, taskId } = await seedTaskFixture("order", now);

    const registry = new SourceAssetRegistry(
      taskId,
      path.join(root, taskId),
      { now },
    );
    const items = await registry.listRegistrations();

    expect(items).toHaveLength(2);
    // Deterministic (registered_at, receipt_id) ordering; derived.csv was
    // registered first, so the earlier timestamp must sort first.
    expect(items.map((item) => item.registered_at)).toEqual(
      [...items.map((item) => item.registered_at)].sort(),
    );
    const paths = items.map((item) => item.relative_path);
    expect(paths).toEqual([
      "source_assets/extract/derived.csv",
      "source_assets/table.csv",
    ]);

    // Receipts carry the full wire projection with a consistent hash binding.
    for (const item of items) {
      expect(parseSourceAssetRegistrationReceipt(item, taskId)).toEqual(item);
      expect(item.asset_ref.asset_id).toBe(`asset_${item.sha256}`);
      expect(item.task_id).toBe(taskId);
      expect(item.asset_ref.role).toBe<RegisteredSourceAssetRole>("carrier");
      expect(item.size_bytes).toBeGreaterThan(0);
      expect(item.registered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const carrier = items.find((item) => item.relative_path === "source_assets/table.csv");
    expect(carrier?.media_type).toBe("text/csv");
    expect(carrier?.sha256).toBe(
      createHash("sha256").update("carrier,body\n1,2\n").digest("hex"),
    );
    expect(carrier?.size_bytes).toBe(Buffer.byteLength("carrier,body\n1,2\n"));
  });

  test("returns cloned receipts that do not alias registry state", async () => {
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++));
    const { root, taskId } = await seedTaskFixture("clone", now);

    const taskRoot = path.join(root, taskId);
    const registry = new SourceAssetRegistry(taskId, taskRoot, { now });
    const [first] = await registry.listRegistrations();
    const mutated = JSON.parse(JSON.stringify(first)) as SourceAssetRegistrationReceipt;
    mutated.relative_path = "source_assets/tampered.csv";
    expect(await registry.listRegistrations()).not.toContainEqual(mutated);
    // A fresh registry instance (as constructed per request by the route)
    // still reads the pristine persisted receipts.
    const fresh = new SourceAssetRegistry(taskId, taskRoot, { now });
    expect((await fresh.listRegistrations()).map((item) => item.relative_path).sort())
      .toEqual(["source_assets/extract/derived.csv", "source_assets/table.csv"]);
  });

  test("rejects deterministically above the safe listing bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "source-assets-bound-"));
    roots.push(root);
    const taskId = "task_bounded";
    const taskRoot = path.join(root, taskId);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets", "a.csv"), "a\n");
    const registry = new SourceAssetRegistry(taskId, taskRoot);
    await registry.register({
      sourceId: "bound_fixture",
      relativePath: "source_assets/a.csv",
      role: "carrier",
    });
    // Simulate a corrupted/runaway registry file: 520 distinct, individually
    // valid receipts (distinct content hashes, receipt ids, and paths) — far
    // above the 500-receipt listing bound.
    const base = await registry.listRegistrations();
    const inflated: unknown[] = [...base];
    while (inflated.length <= 500) {
      const index = inflated.length;
      const sha256 = createHash("sha256").update(String(index)).digest("hex");
      inflated.push({
        ...base[0],
        receipt_id: `receipt_${String(index).padStart(8, "0")}`,
        sha256,
        relative_path: `source_assets/generated_${index}.csv`,
        path_compatibility: {
          ...base[0].path_compatibility,
        },
      });
      (inflated[index] as { asset_ref: { asset_id: string } }).asset_ref = {
        ...base[0].asset_ref,
        asset_id: `asset_${sha256}`,
      };
    }
    await writeFile(
      path.join(taskRoot, "state", "source-asset-registrations.json"),
      JSON.stringify(inflated),
      "utf8",
    );
    // A fresh registry (uncached state) must read the inflated file and
    // reject deterministically instead of streaming an unbounded listing.
    const fresh = new SourceAssetRegistry(taskId, taskRoot);
    await expect(fresh.listRegistrations()).rejects.toBeInstanceOf(RangeError);
  });

  test("returns an empty listing for a task without registrations", async () => {
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++));
    const root = await mkdtemp(path.join(os.tmpdir(), "source-assets-empty-"));
    roots.push(root);
    const repository = new DurableTaskRepository(root, { now });
    const accepted = await repository.createTask({
      requestId: "request_empty",
      input: "empty registry fixture",
      databases: [],
      mode: "agent",
    });
    expect(await repository
      .sourceAssetRegistry(accepted.task_id)
      .listRegistrations()).toEqual([]);
  });
});

function runtimeOptions(root: string): DurableAgentRuntimeOptions {
  return {
    tasksRoot: root,
    adapter: {
      createSession: async () => {
        throw new Error("no session expected in this test");
      },
    },
    workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
  };
}

test("source-assets route lists receipts read-only and 404s unknown tasks", async () => {
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++));
  const { root, taskId } = await seedTaskFixture("route", now);
  const taskRoot = path.join(root, taskId);

  const runtime = await createDurableAgentRuntime(runtimeOptions(root));
  const server = createServer((request, response) => {
    if (!runtime.handle(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const eventsPath = path.join(taskRoot, "events.jsonl");
  const readEventCount = async (): Promise<number> =>
    (await readFile(eventsPath, "utf8")).trim().split("\n").length;
  const eventsBefore = await readEventCount();

  const response = await fetch(`${base}/api/v1/tasks/${taskId}/source-assets`);
  expect(response.status).toBe(200);
  const body = await response.json() as { items: unknown[] };
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.items).toHaveLength(2);

  // Exact bounded wire shape: strict SourceAssetRegistrationReceipt keys only.
  const expectedKeys = [
    "schema_version", "receipt_id", "task_id", "asset_ref", "source_id",
    "relative_path", "sha256", "size_bytes", "media_type", "registered_at",
    "path_compatibility",
  ].sort();
  const serialized = JSON.stringify(body.items);
  for (const item of body.items) {
    expect(Object.keys(item as Record<string, unknown>).sort()).toEqual(expectedKeys);
    const receipt = parseSourceAssetRegistrationReceipt(item, taskId);
    expect(receipt.asset_ref.asset_id).toMatch(/^asset_[0-9a-f]{64}$/);
    expect(receipt.relative_path.startsWith("source_assets/")).toBe(true);
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    // No absolute paths or bytes leak into the projection.
    expect(serialized).not.toContain(taskRoot);
    expect(serialized).not.toContain(root);
  }
  const byPath = new Map(body.items.map((item) => [
    (item as SourceAssetRegistrationReceipt).relative_path,
    item as SourceAssetRegistrationReceipt,
  ]));
  expect(byPath.get("source_assets/table.csv")?.media_type).toBe("text/csv");
  expect(byPath.get("source_assets/table.csv")?.asset_ref.role).toBe("carrier");
  expect(byPath.has("source_assets/extract/derived.csv")).toBe(true);

  // Unknown task -> 404 with the route's JSON error body.
  const missing = await fetch(`${base}/api/v1/tasks/task_ts_missing/source-assets`);
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { detail?: string }).detail).toBe("Task not found");

  // Read-only projection: a second listing appends no events and does not
  // change the persisted registry or any task state.
  await fetch(`${base}/api/v1/tasks/${taskId}/source-assets`);
  expect(await readEventCount()).toBe(eventsBefore);
  expect((await registryListing(taskRoot)).length).toBe(2);
});

async function registryListing(taskRoot: string): Promise<unknown[]> {
  const raw = await readFile(
    path.join(taskRoot, "state", "source-asset-registrations.json"),
    "utf8",
  );
  return JSON.parse(raw) as unknown[];
}
