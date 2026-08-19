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

  test("serves TS build list, detail, and verified artifacts (A7 immutable-root download)", async () => {
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
    // A7: the official download reads ONLY from an immutable publication root,
    // so a build must be published (not just staged in the mutable build dir).
    const versionDir = path.join(buildDir, "publish", "version_1");
    await mkdir(path.join(versionDir, "artifacts"), { recursive: true });
    await writeFile(path.join(versionDir, "artifacts", "primary.csv"), artifact);
    await writeFile(path.join(versionDir, "dataset_manifest.json"), JSON.stringify(manifest));
    await writeFile(path.join(versionDir, "publication.json"), JSON.stringify({
      publication_id: `pub_${buildId}_${sha256.slice(0, 16)}`,
      manifest_ref: `datasets_build/${buildId}/dataset_manifest.json`,
      manifest_sha256: sha256,
      published_at: "2026-08-19T00:00:00Z",
    }));
    const { base } = await startApi(root, database);

    const page = await (await fetch(`${base}/builds`)).json() as { items: unknown[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ build_id: buildId, task_id: taskId, status: "success" });
    const detail = await (await fetch(`${base}/builds/${buildId}?task_id=${taskId}`)).json();
    expect(detail).toMatchObject({ build_id: buildId, manifest, artifacts: manifest.artifacts });
    const downloaded = await fetch(`${base}/builds/${buildId}/artifacts/artifact_primary?task_id=${taskId}`);
    expect(downloaded.status).toBe(200);
    const body = Buffer.from(await downloaded.arrayBuffer());
    expect(body).toEqual(artifact);
    expect(createHash("sha256").update(body).digest("hex")).toBe(sha256);
    expect(downloaded.headers.get("content-length")).toBe(String(artifact.length));

    // A7: a same-name file placed in the MUTABLE build dir can never affect the
    // official download — it must still serve the immutable publication bytes.
    await writeFile(path.join(buildDir, "artifacts", "primary.csv"), Buffer.from("tampered", "utf8"));
    const afterTamper = await fetch(`${base}/builds/${buildId}/artifacts/artifact_primary?task_id=${taskId}`);
    const tamperedBody = Buffer.from(await afterTamper.arrayBuffer());
    expect(tamperedBody).toEqual(artifact);
    expect(createHash("sha256").update(tamperedBody).digest("hex")).toBe(sha256);
  });

  test("starts, gets, and cancels a durable build with typed responses", async () => {
    const root = await temporaryDirectory("c3i-product-");
    const { base } = await startApi(root, new FakeDatabase());
    const request = {
      schema_version: "1.0", idempotency_key: "idem_product_c3i",
      task_id: "task_product_c3i", run_id: "run_product_c3i",
      spec: {
        schema_version: "1.0", build_id: "build_product_c3i", objective: "test",
        dataset_family: "gene_expression", row_granularity: "gene_sample_measurement",
        entities: {}, cohort_filters: {}, required_fields: [], schema_ref: "gene_expression.long.v1",
        source_bindings: [{ schema_version: "1.0", binding_id: "binding_1", source: "fixture",
          acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "fixture.v1", recipe_id: null, recipe_version: null },
          adapter_id: "fixture.expression.v1", accession: null, parameters: {} }],
        normalization_profile_ref: null, merge_strategy: "append_by_canonical_row",
        validation_profile_ref: "gene_expression.release.v1", output_format: "csv", target_entity_level: null,
      },
    };
    const started = await fetch(`${base}/builds`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ idempotent_replay: false, build: { status: "queued", build_id: "build_product_c3i" } });
    expect(await (await fetch(`${base}/builds/build_product_c3i`)).json()).toMatchObject({ build: { status: "queued" } });
    const cancelled = await fetch(`${base}/builds/build_product_c3i/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "1.0", request_id: "cancel_product_c3i", task_id: "task_product_c3i", run_id: "run_product_c3i", reason: null }) });
    expect(await cancelled.json()).toMatchObject({ disposition: "accepted", status: "cancel_requested", terminal: false });
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
        source_files: ["input.csv"],
        extra: {
          asset_files: [{
            name: "blob_ab12_input.csv",
            relative_path: "assets/blob_ab12_input.csv",
            media_type: "text/csv",
          }],
        },
        keywords: ["TP53"],
      }] as T;
      if (op === "cache.describe") return (await database.call<unknown[]>("cache.list", {}))[0] as T;
      if (op === "cache.delete") return { deleted: true } as T;
      if (op === "cache.clear") return { deleted: 3 } as T;
      return FakeDatabase.prototype.call.call(database, op, args) as Promise<T>;
    };
    const recordDir = path.join(root, "cache", "records", "user_import", "dataset_1");
    await mkdir(recordDir, { recursive: true });
    await mkdir(path.join(recordDir, "assets"), { recursive: true });
    await writeFile(path.join(recordDir, "main_data.csv"), "gene,value\nTP53,1\n");
    await writeFile(path.join(recordDir, "manifest.json"), "{}\n");
    await writeFile(path.join(recordDir, "assets", "blob_ab12_input.csv"), "raw,bytes\n");
    const { base } = await startApi(root, database);

    const page = await (await fetch(`${base}/cache/datasets`)).json() as { items: unknown[] };
    expect(page.items[0]).toMatchObject({
      dataset_id: "dataset_1", namespace: "user_import", row_count: 1,
    });
    const detail = await (
      await fetch(`${base}/cache/datasets/dataset_1?namespace=user_import`)
    ).json() as { artifacts: unknown[] };
    expect(detail.artifacts).toHaveLength(3);
    expect(detail.artifacts[2]).toMatchObject({
      artifact_id: "blob_ab12_input.csv", role: "raw_source", media_type: "text/csv",
    });
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

    const rawAsset = await fetch(
      `${base}/cache/datasets/dataset_1/artifacts/blob_ab12_input.csv?namespace=user_import`,
    );
    expect(rawAsset.status).toBe(200);
    expect(await rawAsset.text()).toBe("raw,bytes\n");
  });

  test("deletes a cache dataset and clears the cache", async () => {
    const root = await temporaryDirectory("phase7-cache-delete-");
    const database = new FakeDatabase();
    database.call = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
      database.calls.push({ op, args });
      if (op === "cache.list") return [{
        dataset_id: "dataset_1", source_namespace: "user_import", topic: "TP53",
        description: "demo", row_count: 1, column_count: 2,
        created_at: "2026-08-14T00:00:00Z", created_by_task_id: "task_ts_example",
        source_files: ["input.csv"], extra: {}, keywords: ["TP53"],
      }] as T;
      if (op === "cache.describe") {
        if (args["dataset_id"] === "missing") return null as T;
        return (await database.call<unknown[]>("cache.list", {}))[0] as T;
      }
      if (op === "cache.delete") return { deleted: true } as T;
      if (op === "cache.clear") return { deleted: 1 } as T;
      return FakeDatabase.prototype.call.call(database, op, args) as Promise<T>;
    };
    const recordDir = path.join(root, "cache", "records", "user_import", "dataset_1");
    await mkdir(recordDir, { recursive: true });
    await writeFile(path.join(recordDir, "main_data.csv"), "gene,value\nTP53,1\n");
    await writeFile(path.join(recordDir, "manifest.json"), "{}\n");
    const { base } = await startApi(root, database);

    const removed = await fetch(
      `${base}/cache/datasets/dataset_1?namespace=user_import`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    expect(database.calls.at(-1)).toEqual({
      op: "cache.delete", args: { source_namespace: "user_import", dataset_id: "dataset_1" },
    });

    const notFound = await fetch(
      `${base}/cache/datasets/missing?namespace=user_import`,
      { method: "DELETE" },
    );
    expect(notFound.status).toBe(404);

    const cleared = await fetch(`${base}/cache/datasets`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ deleted: 1 });
    expect(database.calls.at(-1)).toEqual({ op: "cache.clear", args: {} });
  });
});
