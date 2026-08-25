/**
 * Phase 8 builtin database catalogue tests.
 *
 * The builtin catalogue moved from Python (``builtin_skill_records``) to
 * TypeScript (``server/src/product/builtin-databases.ts``). These tests pin
 * the migrated facts (names, categories, versions) and current pipeline support,
 * user-selectability) so the TS catalogue cannot drift from the retired
 * Python records, and the product API merge semantics.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterAll, describe, expect, test } from "vitest";

import {
  BUILTIN_DATABASE_NAMES,
  getBuiltinDatabase,
  listBuiltinDatabases,
} from "../../src/product/builtin-databases.js";
import { CORE_ACQUISITION_PROVIDER_DESCRIPTORS } from "../../src/dataset/acquisition/provider-catalog.js";
import { createProductApi, type ProductDatabaseClient } from "../../src/product/product-api.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

async function temporaryDirectory(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `phase8-${label}-`));
  roots.push(root);
  return root;
}

async function startApi(database: ProductDatabaseClient) {
  const root = await temporaryDirectory("builtin-api");
  const api = await createProductApi({
    tasksRoot: path.join(root, "output"),
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
  return { base: `http://127.0.0.1:${port}/api/v1`, database };
}

class FakeDatabase implements ProductDatabaseClient {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  disabled: string[] = [];
  userEntries: unknown[] = [];

  async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    if (op === "database.list") return this.userEntries as T;
    if (op === "database.disabled") return { disabled: this.disabled } as T;
    if (op === "database.get") return null as T;
    if (op === "cache.list") return [] as T;
    return { ok: true } as T;
  }
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

describe("builtin database catalogue", () => {
  test("exposes every curated database skill with current pipeline facts", () => {
    const entries = listBuiltinDatabases(new Set());
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([
      "pubmed", "dbsnp", "openfda", "clinvar", "mgnify", "chembl", "uniprot",
      "geo", "gdc", "xena", "pdb", "pubchem", "reactome",
    ]);
    expect(new Set(names)).toEqual(BUILTIN_DATABASE_NAMES);

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    // Versions migrated from the Python records
    expect(byName.get("pubmed")).toMatchObject({ version: "0.2.0", category: "discovery" });
    expect(byName.get("geo")).toMatchObject({ version: "0.5.0", category: "acquisition" });
    expect(byName.get("gdc")).toMatchObject({ version: "0.1.0", category: "acquisition" });
    // Every selectable builtin now has a formal Core acquisition route.
    expect(byName.get("pubmed")?.pipeline_supported).toBe(true);
    expect(byName.get("geo")?.pipeline_supported).toBe(true);
    expect(byName.get("gdc")?.pipeline_supported).toBe(true);
    expect(byName.get("xena")?.pipeline_supported).toBe(true);
    for (const entry of entries) expect(entry.pipeline_supported).toBe(true);

    for (const entry of entries) {
      expect(entry.origin).toBe("builtin");
      expect(entry.available).toBe(true);
      expect(entry.declarative_manifest).toBeNull();
      expect(entry.capability).toBe(entry.pipeline_supported ? "pipeline_supported" : "research_only");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("keeps every selectable builtin database connected to a formal Core provider", () => {
    const providerDatabases = new Set(CORE_ACQUISITION_PROVIDER_DESCRIPTORS.map((entry) => entry.databaseId));
    for (const database of listBuiltinDatabases(new Set())) {
      expect(providerDatabases.has(database.name), database.name).toBe(true);
    }
  });

  test("excludes non-selectable skills from the catalogue", () => {
    const names = listBuiltinDatabases(new Set()).map((entry) => entry.name);
    for (const excluded of [
      "browser", "local_cache", "web_visual_capture",
      "literature_understanding", "pdf_extraction", "extract_chart_data_vlm",
      "analysis", "research_data_guidance", "dataset-construction",
    ]) {
      expect(names).not.toContain(excluded);
    }
  });

  test("disabled set flips the enabled flag", () => {
    const disabled = new Set(["geo", "pubmed"]);
    const entries = listBuiltinDatabases(disabled);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("geo")?.enabled).toBe(false);
    expect(byName.get("pubmed")?.enabled).toBe(false);
    expect(byName.get("gdc")?.enabled).toBe(true);
  });

  test("getBuiltinDatabase resolves selectable names and rejects others", () => {
    expect(getBuiltinDatabase("geo", new Set())?.enabled).toBe(true);
    expect(getBuiltinDatabase("geo", new Set(["geo"]))?.enabled).toBe(false);
    expect(getBuiltinDatabase("local_cache", new Set())).toBeNull();
    expect(getBuiltinDatabase("unknown", new Set())).toBeNull();
  });
});

describe("product API builtin merge", () => {
  test("GET /databases merges TS builtin catalogue with user manifests", async () => {
    const database = new FakeDatabase();
    database.userEntries = [{
      id: "demo", name: "demo", category: "discovery",
      description: "Demo", origin: "package", version: "1.0.0",
      pipeline_supported: false, capability: "research_only", available: true,
      enabled: true, declarative_manifest: null,
    }];
    database.disabled = ["geo"];
    const { base } = await startApi(database);

    const body = await (await fetch(`${base}/databases`)).json() as { databases: Array<{ id: string; enabled?: boolean }> };
    const names = body.databases.map((entry) => entry.id);
    expect(names).toContain("pubmed");
    expect(names).toContain("demo");
    const geo = body.databases.find((entry) => entry.id === "geo");
    expect(geo?.enabled).toBe(false);
    // catalogue merge requires both named ops
    expect(database.calls).toContainEqual({ op: "database.list", args: {} });
    expect(database.calls).toContainEqual({ op: "database.disabled", args: {} });
  });

  test("GET /databases/{builtin} serves the catalogue entry", async () => {
    const database = new FakeDatabase();
    const { base } = await startApi(database);
    const detail = await (await fetch(`${base}/databases/pubmed`)).json() as { id: string; origin: string };
    expect(detail.id).toBe("pubmed");
    expect(detail.origin).toBe("builtin");
  });

  test("builtin databases are immutable via PUT/DELETE", async () => {
    const database = new FakeDatabase();
    const { base } = await startApi(database);
    const put = await fetch(`${base}/databases/pubmed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "hijack" }),
    });
    expect(put.status).toBe(403);
    const del = await fetch(`${base}/databases/pubmed`, { method: "DELETE" });
    expect(del.status).toBe(403);
    // no persistence call reached the bridge
    expect(database.calls.some((call) => call.op === "database.patch" || call.op === "database.delete")).toBe(false);
  });

  test("POST /databases with a builtin name is rejected", async () => {
    const database = new FakeDatabase();
    const { base } = await startApi(database);
    const saved = await fetch(`${base}/databases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "geo", display_name: "X" }),
    });
    expect(saved.status).toBe(422);
    expect(database.calls.some((call) => call.op === "database.save")).toBe(false);
  });

  test("user database CRUD still flows to the bridge", async () => {
    const database = new FakeDatabase();
    const { base } = await startApi(database);
    const saved = await fetch(`${base}/databases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo", display_name: "Demo" }),
    });
    expect(saved.status).toBe(201);
    expect(database.calls.at(-1)).toEqual({
      op: "database.save",
      args: { manifest: { name: "demo", display_name: "Demo" } },
    });
  });
});
