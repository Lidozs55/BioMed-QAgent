import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { DatasetSchemaV2 } from "@biomed/contracts";

import {
  RegisteredTableAdapter,
  RegisteredTableRegistry,
  type RegisteredTableAdapterResult,
  type RegisteredTableSink,
} from "../src/dataset/adapters/registered/index.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";

class Sink implements RegisteredTableSink {
  result: RegisteredTableAdapterResult | null = null;
  writeRow(): void {}
  writeRejectedRow(): void {}
  commit(result: RegisteredTableAdapterResult): void { this.result = result; }
  rollback(): void {}
}

const schema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "source_asset_registry_test.v1",
  dataset_family: "target_evidence",
  row_granularity: "protein_record",
  primary_key: ["accession"],
  fields: [{
    schema_version: "2.0",
    name: "accession",
    data_type: "string",
    semantic_role: "identifier",
    required: true,
    nullable: false,
    unit_policy: null,
    ontology: null,
    description: "accession",
    derivation_policy: null,
  }],
};

function adapterRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  registry.register({
    schema,
    parser: {
      adapter_id: "trusted_source_test",
      parser_version: "1_0_0",
      schema_ref: schema.schema_id,
      format: "tsv",
      fields: [{ source_column: "accession", target_field: "accession" }],
      media_types: ["text/tab-separated-values"],
      limits: { max_bytes: 1024, max_rows: 10, max_columns: 1, max_line_characters: 100 },
    },
  });
  return registry;
}

async function tempTask(taskId = "task_c1i"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${taskId}-`));
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  return root;
}

function assetId(content: string): string {
  return `asset_${createHash("sha256").update(content).digest("hex")}`;
}

describe("TASK-C1I Core source asset registry", () => {
  it("registers, persists, and resolves only a task-owned source asset ID", async () => {
    const root = await tempTask();
    try {
      const content = "accession\nP04637\n";
      await writeFile(path.join(root, "source_assets", "proteins.tsv"), content);
      const telemetry: string[] = [];
      const registry = new SourceAssetRegistry("task_c1i", root, {
        now: () => new Date("2026-08-18T00:00:00.000Z"),
        onTelemetry: (event) => telemetry.push(event),
      });
      const receipt = await registry.register({ sourceId: "source_uniprot", relativePath: "source_assets/proteins.tsv" });
      expect(receipt.asset_ref.asset_id).toBe(assetId(content));
      expect(receipt.path_compatibility).toMatchObject({ mode: "asset_id", legacy_path: null });
      expect(await registry.resolve(receipt.asset_ref.asset_id)).toMatchObject({
        registration_receipt: receipt,
      });
      expect(await new SourceAssetRegistry("task_c1i", root).resolve(receipt.asset_ref.asset_id)).toMatchObject({
        registration_receipt: receipt,
      });
      registry.recordLegacyPathCompatibilityUse("source_assets/proteins.tsv");
      expect(telemetry).toEqual(["asset_ref_used", "legacy_path_compatibility_used"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("constructs the registry from the repository-owned task root", async () => {
    const tasksRoot = await mkdtemp(path.join(os.tmpdir(), "c1i-tasks-"));
    const taskRoot = path.join(tasksRoot, "task_c1i");
    try {
      await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
      await writeFile(path.join(taskRoot, "source_assets", "asset.json"), "{}\n");
      const receipt = await new DurableTaskRepository(tasksRoot)
        .sourceAssetRegistry("task_c1i")
        .register({ sourceId: "source_1", relativePath: "source_assets/asset.json" });
      expect(receipt.task_id).toBe("task_c1i");
    } finally {
      await rm(tasksRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "../workspace/file.tsv",
    "workspace/file.tsv",
    "C:/workspace/file.tsv",
    "/workspace/file.tsv",
    "source_assets/../workspace/file.tsv",
  ])("rejects non-task source path %s", async (relativePath) => {
    const root = await tempTask();
    try {
      await expect(new SourceAssetRegistry("task_c1i", root).register({ sourceId: "source_1", relativePath })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a persisted receipt owned by another task", async () => {
    const root = await tempTask();
    try {
      const content = "accession\nP04637\n";
      await writeFile(path.join(root, "source_assets", "proteins.tsv"), content);
      const receipt = await new SourceAssetRegistry("task_c1i", root).register({ sourceId: "source_1", relativePath: "source_assets/proteins.tsv" });
      await writeFile(path.join(root, "state", "source-asset-registrations.json"), JSON.stringify([{ ...receipt, task_id: "task_other", asset_ref: { ...receipt.asset_ref, task_id: "task_other" } }]));
      await expect(new SourceAssetRegistry("task_c1i", root).resolve(receipt.asset_ref.asset_id)).rejects.toThrow(/different task/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a registered asset when the adapter request names another task", async () => {
    const root = await tempTask();
    try {
      await writeFile(path.join(root, "source_assets", "proteins.tsv"), "accession\nP04637\n");
      const registry = new SourceAssetRegistry("task_c1i", root);
      const receipt = await registry.register({ sourceId: "source_1", relativePath: "source_assets/proteins.tsv" });
      await expect(new RegisteredTableAdapter(adapterRegistry()).parse({
        schema_version: "1.0",
        task_id: "task_other",
        asset_id: receipt.asset_ref.asset_id,
        schema_ref: schema.schema_id,
        adapter_id: "trusted_source_test",
        parser_version: "1_0_0",
      }, await registry.resolve(receipt.asset_ref.asset_id), new Sink())).rejects.toThrow(/different task/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds a registered adapter from the trusted asset ID and rejects same-size hash drift", async () => {
    const root = await tempTask();
    try {
      const original = "accession\nP04637\n";
      const replacement = "accession\nQ9Y6K9\n";
      const file = path.join(root, "source_assets", "proteins.tsv");
      await writeFile(file, original);
      const registry = new SourceAssetRegistry("task_c1i", root);
      const receipt = await registry.register({ sourceId: "source_1", relativePath: "source_assets/proteins.tsv" });
      const trusted = await registry.resolve(receipt.asset_ref.asset_id);
      const sink = new Sink();
      const result = await new RegisteredTableAdapter(adapterRegistry()).parse({
        schema_version: "1.0",
        task_id: "task_c1i",
        asset_id: receipt.asset_ref.asset_id,
        schema_ref: schema.schema_id,
        adapter_id: "trusted_source_test",
        parser_version: "1_0_0",
      }, trusted, sink);
      expect(result.audit.status).toBe("accepted");
      expect(sink.result?.audit.actual_sha256).toBe(receipt.sha256);

      const swappedAfterResolve = await registry.resolve(receipt.asset_ref.asset_id);
      await writeFile(file, replacement);
      await expect(new RegisteredTableAdapter(adapterRegistry()).parse({
        schema_version: "1.0",
        task_id: "task_c1i",
        asset_id: receipt.asset_ref.asset_id,
        schema_ref: schema.schema_id,
        adapter_id: "trusted_source_test",
        parser_version: "1_0_0",
      }, swappedAfterResolve, new Sink())).rejects.toThrow(/hash drift/);

      const drifted = await registry.resolve(receipt.asset_ref.asset_id);
      await expect(new RegisteredTableAdapter(adapterRegistry()).parse({
        schema_version: "1.0",
        task_id: "task_c1i",
        asset_id: receipt.asset_ref.asset_id,
        schema_ref: schema.schema_id,
        adapter_id: "trusted_source_test",
        parser_version: "1_0_0",
      }, drifted, new Sink())).rejects.toThrow(/hash drift/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
