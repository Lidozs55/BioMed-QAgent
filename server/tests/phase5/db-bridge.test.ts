/**
 * P5-10 local cache + DB bridge tests: TS DatabaseClient over the real
 * database/bridge.py subprocess, and local-cache tool parity.
 */

import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseClient, DatabaseBridgeError, probePythonBin, defaultBridgePaths } from "../../src/persistence/db-client.js";
import { createLocalCacheTools, CACHE_MAIN_DATA_COLUMNS } from "../../src/agent/tools/local-cache.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";

const backendRoot = defaultBridgePaths().backendRoot;
const pythonBin = probePythonBin(backendRoot);
const bridgeAvailable = ((): boolean => {
  try {
    const result = spawnSync(pythonBin, ["--version"], { stdio: "ignore", timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIf = bridgeAvailable ? describe : describe.skip;

describeIf("database bridge + local cache tools", () => {
  let root: string;
  let client: DatabaseClient;

  beforeAll(async () => {
    const dir = path.join(os.tmpdir(), `p5-db-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    root = dir;
    client = new DatabaseClient({
      cacheDir: path.join(root, "cache"),
      databasesDir: path.join(root, "databases"),
      timeoutMs: 60_000,
    });
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    const fs = await import("node:fs/promises");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ping returns the bridge service identity", async () => {
    const data = await client.call<{ service: string; version: string }>("ping", {});
    expect(data.service).toBe("biomed-db-bridge");
    expect(data.version).toBe("1");
  });

  it("rejects unknown operations (no arbitrary SQL)", async () => {
    await expect(client.call("sql.exec", {})).rejects.toThrow(DatabaseBridgeError);
    await expect(client.call("db.raw_query", {})).rejects.toThrow(/unknown operation/);
  });

  it("commit → search → describe → get round-trip with 22-column rows", async () => {
    const commit = await client.call<Record<string, unknown>>("cache.commit", {
      dataset_id: "ds_tp53",
      source_namespace: "user_import",
      topic: "TP53 expression cohort",
      description: "fixture TP53 expression dataset for bridge tests",
      csv_rows: [
        { record_id: "r1", dataset_id: "ds_tp53", source_id: "src_1", asset_id: "asset_1", gene_id: "TP53", sample_id: "S1", expression_value: "1.5" },
        { record_id: "r2", dataset_id: "ds_tp53", source_id: "src_1", asset_id: "asset_1", gene_id: "TP53", sample_id: "S2", expression_value: "2.5" },
      ],
      created_by_task_id: "task_test",
      source_files: ["upload.tsv"],
      keywords: ["TP53", "expression"],
    });
    expect(commit.row_count).toBe(2);
    expect(commit.column_count).toBe(CACHE_MAIN_DATA_COLUMNS.length);

    const search = await client.call<Array<Record<string, unknown>>>("cache.search", { query: "TP53", limit: 10 });
    expect(search).toHaveLength(1);
    expect(search[0]?.dataset_id).toBe("ds_tp53");

    const describe = await client.call<Record<string, unknown> | null>("cache.describe", {
      source_namespace: "user_import",
      dataset_id: "ds_tp53",
    });
    expect(describe?.topic).toBe("TP53 expression cohort");

    const loaded = await client.call<{ manifest: { row_count: number }; rows: Array<Record<string, string>> } | null>("cache.get", {
      source_namespace: "user_import",
      dataset_id: "ds_tp53",
    });
    expect(loaded?.manifest.row_count).toBe(2);
    expect(loaded?.rows).toHaveLength(2);
    expect(loaded?.rows[0]?.expression_value).toBe("1.5");
  });

  it("returns null for missing datasets", async () => {
    const missing = await client.call<null>("cache.describe", {
      source_namespace: "user_import",
      dataset_id: "does_not_exist",
    });
    expect(missing).toBeNull();
  });

  it("restarts the bridge after a crash", async () => {
    await client.call("ping", {});
    const child = (client as unknown as { process: { kill: () => void } }).process;
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Next call must transparently restart the process.
    const data = await client.call<{ service: string }>("ping", {});
    expect(data.service).toBe("biomed-db-bridge");
  });

  describe("local cache tools", () => {
    it("registers the SKILL_TOOL_MAP names", () => {
      const tools = createLocalCacheTools({ db: client });
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(["search_local_cache", "describe_local_cache", "get_cache_dataset"]);
      for (const name of names) {
        expect(SKILL_TOOL_NAMES.has(name)).toBe(true);
        expect(toolOwner(name)).toBe("local_cache");
      }
    });

    it("search_local_cache returns Python-shaped results", async () => {
      const [search] = createLocalCacheTools({ db: client });
      const result = await search.execute({ query: "TP53", max_results: 10 });
      const parsed = JSON.parse(result.content) as { source: string; query: string; results: Array<Record<string, unknown>> };
      expect(parsed.source).toBe("local_cache");
      expect(parsed.results[0]).toMatchObject({
        dataset_id: "ds_tp53",
        source_namespace: "user_import",
        row_count: 2,
        created_by_task_id: "task_test",
      });
    });

    it("search_local_cache returns an empty results array (NOT_FOUND) when nothing matches", async () => {
      const [search] = createLocalCacheTools({ db: client });
      const result = await search.execute({ query: "zzz-no-match", max_results: 10 });
      expect(JSON.parse(result.content)).toEqual({ source: "local_cache", query: "zzz-no-match", results: [] });
    });

    it("describe_local_cache mirrors the manifest + column_count + extra", async () => {
      const [, describe] = createLocalCacheTools({ db: client });
      const result = await describe.execute({ source_namespace: "user_import", dataset_id: "ds_tp53" });
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.column_count).toBe(22);
      expect(parsed.row_count).toBe(2);
      expect(parsed.extra).toBeDefined();
    });

    it("describe_local_cache reports dataset not found", async () => {
      const [, describe] = createLocalCacheTools({ db: client });
      const result = await describe.execute({ source_namespace: "user_import", dataset_id: "nope" });
      const parsed = JSON.parse(result.content) as { error: string };
      expect(parsed.error).toBe("dataset not found");
    });

    it("get_cache_dataset honours max_rows with the truncated flag", async () => {
      const hooks: Array<[string, string, Record<string, unknown>]> = [];
      const [, , get] = createLocalCacheTools({
        db: client,
        hooks: { onProgress: (stage, kind, payload) => hooks.push([stage, kind, payload]) },
      });
      const result = await get.execute({ source_namespace: "user_import", dataset_id: "ds_tp53", max_rows: 1 });
      const parsed = JSON.parse(result.content) as { truncated: boolean; returned_rows: number; rows: unknown[]; columns: string[] };
      expect(parsed.truncated).toBe(true);
      expect(parsed.returned_rows).toBe(1);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.columns).toEqual([...CACHE_MAIN_DATA_COLUMNS]);
      expect(hooks).toEqual([["acquisition", "cache_dataset_loaded", expect.objectContaining({ truncated: true, current: 1, total: 2 })]]);
    });
  });
});
