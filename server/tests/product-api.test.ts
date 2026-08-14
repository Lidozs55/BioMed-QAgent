import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createProductApi, type ProductDatabaseClient } from "../src/product/product-api.js";
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startApi(
  root: string,
  database: ProductDatabaseClient,
) {
  const api = await createProductApi({
    tasksRoot: path.join(root, "output", "tasks"),
    cacheDir: path.join(root, "cache"),
    settingsDir: path.join(root, "settings"),
    database,
  });
  const server = createServer((request, response) => {
    if (!api.handle(request, response)) response.writeHead(404).end("Not Found");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { api, base: `http://127.0.0.1:${port}/api/v1` };
}

class FakeDatabase implements ProductDatabaseClient {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  // Phase 8: the bridge persists user-declared databases only; builtin
  // entries are merged by the product API from the TS catalogue.
  entries = [{
    id: "demo", name: "demo", category: "discovery",
    description: "Demo user DB", origin: "package", version: "1.0.0",
    pipeline_supported: false, capability: "research_only", available: true,
    enabled: true, declarative_manifest: null,
  }];

  async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    if (op === "database.list") return this.entries as T;
    if (op === "database.disabled") return { disabled: [] } as T;
    if (op === "database.get") {
      return (this.entries.find((entry) => entry.name === args.name) ?? null) as T;
    }
    if (op === "database.save") return args.manifest as T;
    if (op === "database.patch") return args.patch as T;
    if (op === "cache.list") return [] as T;
    return { ok: true } as T;
  }
}

describe("Phase 7 product API", () => {
  test("serves health, database CRUD, and persistent personalization", async () => {
    const root = await temporaryDirectory("phase7-product-");
    const database = new FakeDatabase();
    const { base } = await startApi(root, database);

    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      status: "ok", app_host: "ts", agent_runtime: "pi", dataset_core: "ts",
    });
    expect(await (await fetch(`${base}/databases`)).json()).toEqual({
      // Phase 8: TS builtin catalogue (9 entries) merged with user manifests.
      databases: expect.arrayContaining([
        expect.objectContaining({ id: "pubmed", origin: "builtin", enabled: true }),
        expect.objectContaining({ id: "demo", origin: "package" }),
      ]),
    });
    const databaseDetail = await (await fetch(`${base}/databases/pubmed`)).json() as { id: string; origin: string };
    expect(databaseDetail.id).toBe("pubmed");
    expect(databaseDetail.origin).toBe("builtin");
    const toggled = await fetch(`${base}/databases/pubmed/disable`, { method: "POST" });
    expect(toggled.status).toBe(200);
    expect(database.calls.at(-1)).toEqual({
      op: "database.set_enabled", args: { name: "pubmed", enabled: false },
    });

    const saved = await fetch(`${base}/personalization`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ custom_instructions: "Prefer concise tables", personality: "rigorous" }),
    });
    expect(await saved.json()).toEqual({
      custom_instructions: "Prefer concise tables",
      personality: "rigorous",
      personality_label: "严谨",
    });
    expect(JSON.parse(await readFile(path.join(root, "settings", "personalization.json"), "utf8")))
      .toMatchObject({ personality: "rigorous" });
  });

  test("reports the fixed TS/Pi/TS architecture and rejects unsupported methods", async () => {
    const root = await temporaryDirectory("phase7-health-");
    const { base } = await startApi(root, new FakeDatabase());

    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: "ok",
      app_host: "ts",
      agent_runtime: "pi",
      dataset_core: "ts",
    });
    const unsupported = await fetch(`${base}/health`, { method: "PUT" });
    expect(unsupported.status).toBe(405);
    expect(await unsupported.json()).toEqual({ detail: "Method not allowed" });
  });

  test("serves TS build list, detail, and verified artifacts", async () => {
    const root = await temporaryDirectory("phase7-build-");
    const database = new FakeDatabase();
    const taskId = "task_ts_example";
    const buildId = "build_example";
    const buildDir = path.join(root, "output", "tasks", taskId, "datasets_build", buildId);
    const artifact = Buffer.from("gene,value\nTP53,1\n", "utf8");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    await mkdir(path.join(buildDir, "artifacts"), { recursive: true });
    await writeFile(path.join(buildDir, "artifacts", "primary.csv"), artifact);
    const manifest = {
      schema_version: "1.0", manifest_id: "manifest_example", task_id: taskId,
      build_id: buildId, dataset_family: "gene_expression", row_granularity: "gene",
      schema_ref: "gene.v1", primary_key: ["gene"], row_count: 1, sha256,
      artifacts: [{
        artifact_id: "artifact_primary", role: "primary_dataset",
        relative_path: "artifacts/primary.csv", media_type: "text/csv",
        size_bytes: artifact.length, sha256,
      }],
      source_summary: { geo: 1 }, validation_summary: {}, confidence_summary: {},
      provenance_summary: {},
    };
    await writeFile(path.join(buildDir, "dataset_manifest.json"), JSON.stringify(manifest));
    const { base } = await startApi(root, database);

    const page = await (await fetch(`${base}/builds`)).json() as { items: unknown[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ build_id: buildId, task_id: taskId, status: "no_data" });
    const detail = await (await fetch(`${base}/builds/${buildId}?task_id=${taskId}`)).json();
    expect(detail).toMatchObject({ build_id: buildId, manifest, artifacts: manifest.artifacts });
    const downloaded = await fetch(`${base}/builds/${buildId}/artifacts/artifact_primary?task_id=${taskId}`);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(artifact);
  });

  test("serves cache metadata and a ZIP export", async () => {
    const root = await temporaryDirectory("phase7-cache-");
    const database = new FakeDatabase();
    database.call = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
      database.calls.push({ op, args });
      if (op === "cache.list") return [{
        dataset_id: "dataset_1", source_namespace: "user_import", topic: "TP53",
        description: "demo", row_count: 1, column_count: 2,
        created_at: "2026-08-14T00:00:00Z", created_by_task_id: "task_ts_example",
        source_files: ["input.csv"], extra: {}, keywords: ["TP53"],
      }] as T;
      if (op === "cache.describe") return (await database.call<unknown[]>("cache.list", {}))[0] as T;
      return FakeDatabase.prototype.call.call(database, op, args) as Promise<T>;
    };
    const recordDir = path.join(root, "cache", "records", "user_import", "dataset_1");
    await mkdir(recordDir, { recursive: true });
    await writeFile(path.join(recordDir, "main_data.csv"), "gene,value\nTP53,1\n");
    await writeFile(path.join(recordDir, "manifest.json"), "{}\n");
    const { base } = await startApi(root, database);

    const page = await (await fetch(`${base}/cache/datasets`)).json() as { items: unknown[] };
    expect(page.items[0]).toMatchObject({
      dataset_id: "dataset_1", namespace: "user_import", row_count: 1,
    });
    const detail = await (
      await fetch(`${base}/cache/datasets/dataset_1?namespace=user_import`)
    ).json() as { artifacts: unknown[] };
    expect(detail.artifacts).toHaveLength(2);
    const inferredDetail = await (
      await fetch(`${base}/cache/datasets/dataset_1`)
    ).json() as { namespace: string; artifacts: unknown[] };
    expect(inferredDetail).toMatchObject({
      namespace: "user_import",
      artifacts: expect.any(Array),
    });
    const exported = await fetch(`${base}/cache/export`);
    expect(exported.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await exported.arrayBuffer()).subarray(0, 4).toString("hex")).toBe("504b0304");
  });
});
