import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SourceAsset } from "../src/dataset/contracts/index.js";
import { targetEvidenceSchemas, TARGET_EVIDENCE_FAMILY_ID, TARGET_EVIDENCE_ROW_GRANULARITY } from "../src/dataset/families/target-evidence/index.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "target-evidence", "uniprot-api.non-gold.json");
const roots: string[] = [];

function sourceAssetFromReceipt(receipt: Awaited<ReturnType<SourceAssetRegistry["register"]>>): SourceAsset {
  return {
    schema_version: "1.0",
    asset_id: receipt.asset_ref.asset_id,
    kind: "source",
    relative_path: receipt.relative_path,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
    media_type: receipt.media_type,
    generated_by_step_id: null,
    source_id: receipt.source_id,
    successful_attempt_id: receipt.receipt_id,
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

describe("provider runtime dispatch", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes a registered target carrier through executeDatasetBuild", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-e2e-"));
    roots.push(taskRoot);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    const relativePath = "source_assets/uniprot.json";
    await writeFile(path.join(taskRoot, relativePath), await readFile(FIXTURE));
    const registry = new SourceAssetRegistry("task_provider_dispatch", taskRoot);
    const receipt = await registry.register({
      sourceId: "provider_uniprot_carrier",
      relativePath,
      role: "carrier",
    });
    const primarySchema = targetEvidenceSchemas[0]!;
    const sourceAsset = sourceAssetFromReceipt(receipt);
    const spec = {
      schema_version: "1.0" as const,
      build_id: "build_provider_dispatch",
      objective: "Publish a target carrier",
      dataset_family: TARGET_EVIDENCE_FAMILY_ID,
      row_granularity: TARGET_EVIDENCE_ROW_GRANULARITY,
      entities: {},
      cohort_filters: {},
      required_fields: primarySchema.fields.map((field) => field.name),
      schema_ref: primarySchema.schema_id,
      source_bindings: [{
        schema_version: "1.0" as const,
        binding_id: "binding_uniprot_carrier",
        source: "uniprot",
        acquisition: {
          schema_version: "1.0" as const,
          mode: "builtin" as const,
          provider_id: "uniprot.provider.v1",
          recipe_id: null,
          recipe_version: null,
        },
        adapter_id: "target.evidence.uniprot.v1",
        accession: null,
        parameters: {},
      }],
      normalization_profile_ref: "target_evidence.registered.v1",
      merge_strategy: "registered_multitable_identity",
      validation_profile_ref: "target_evidence.release.v1",
      output_format: "csv",
      target_entity_level: null,
    };
    const core = new TypeScriptDatasetCore({ taskId: "task_provider_dispatch", taskRoot });
    const result = await core.executeDatasetBuild(spec, {
      runId: "run_provider_dispatch",
      sourceAssets: { binding_uniprot_carrier: sourceAsset },
      registeredSourceAssetIds: new Set([receipt.asset_ref.asset_id]),
    });

    expect(result.status).toBe("completed");
    expect(result.publication_id).toMatch(/^pub_build_provider_dispatch_/);
    expect(result.manifest?.schema_version).toBe("2.0");
    const manifest = result.manifest;
    if (manifest?.schema_version !== "2.0") throw new Error("provider dispatch did not produce a v2 manifest");
    expect(manifest.tables.map((table) => table.table_id)).toEqual([
      "targets", "evidence", "sources", "supporting",
    ]);
    const publicationEntries = await readdir(path.join(taskRoot, "datasets_build", spec.build_id, "publish"));
    expect(publicationEntries).toHaveLength(1);
    const publicationDir = path.join(taskRoot, "datasets_build", spec.build_id, "publish", publicationEntries[0]!);
    expect(await stat(path.join(publicationDir, "dataset_manifest.json"))).toMatchObject({});
    expect(await readFile(path.join(publicationDir, "tables", "targets.csv"), "utf8")).toContain("Q9Y243");

    const invalidRelativePath = "source_assets/invalid.json";
    await writeFile(path.join(taskRoot, invalidRelativePath), JSON.stringify({ unexpected: true }));
    const invalidReceipt = await registry.register({
      sourceId: "provider_invalid_carrier",
      relativePath: invalidRelativePath,
      role: "carrier",
    });
    await expect(core.executeDatasetBuild({ ...spec, build_id: "build_provider_dispatch_invalid" }, {
      runId: "run_provider_dispatch_invalid",
      sourceAssets: { binding_uniprot_carrier: sourceAssetFromReceipt(invalidReceipt) },
      registeredSourceAssetIds: new Set([invalidReceipt.asset_ref.asset_id]),
    })).rejects.toThrow(/target evidence provider rejected/);
  });
});
