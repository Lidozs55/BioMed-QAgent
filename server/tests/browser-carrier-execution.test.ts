import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { executeBrowserCarrierParser } from "../src/dataset/acquisition/browser-carrier-execution.js";

describe("executeBrowserCarrierParser", () => {
  it("rejects a carrier without exact Core acquisition provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-carrier-"));
    await mkdir(path.join(root, "source_assets"), { recursive: true });
    await writeFile(path.join(root, "source_assets/source.json"), "{}", "utf8");
    const registry = new SourceAssetRegistry("task_carrier", root);
    const receipt = await registry.register({
      sourceId: "browser_source",
      relativePath: "source_assets/source.json",
      role: "carrier",
      mediaType: "application/json",
    });

    await expect(executeBrowserCarrierParser({
      taskId: "task_carrier",
      buildId: "build_carrier",
      outputDir: path.join(root, "build"),
      assetId: receipt.asset_ref.asset_id,
      requestIdentityDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schemaRef: "fixture_schema",
      recipeId: "fixture.tsv",
      recipeVersion: "1",
      recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["application/json"] }) },
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      tableId: "fixture_table",
      familyId: "fixture_family",
      rowGranularity: "row",
      sourceAssetRegistry: registry,
    })).rejects.toThrow(/Core acquisition provenance/);
  });

  it("does not emit an operation result until a carrier has exact provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-carrier-"));
    await mkdir(path.join(root, "source_assets"), { recursive: true });
    await writeFile(path.join(root, "source_assets/source.json"), "{}", "utf8");
    const registry = new SourceAssetRegistry("task_carrier_result", root);
    const receipt = await registry.register({ sourceId: "browser_source", relativePath: "source_assets/source.json", role: "carrier", mediaType: "application/json" });
    await expect(executeBrowserCarrierParser({
      taskId: "task_carrier_result", buildId: "build_carrier", outputDir: path.join(root, "build"), assetId: receipt.asset_ref.asset_id,
      requestIdentityDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", schemaRef: "fixture_schema", recipeId: "fixture.tsv", recipeVersion: "1", recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "b".repeat(64) }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["application/json"] }) },
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tableId: "fixture_table", familyId: "fixture_family", rowGranularity: "row", sourceAssetRegistry: registry,
    })).rejects.toThrow();
  });
});
