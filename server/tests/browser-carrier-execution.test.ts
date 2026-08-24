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
      adapterId: "fixture",
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      parserVersion: "1",
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
      requestIdentityDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", schemaRef: "fixture_schema", adapterId: "fixture", parserVersion: "1",
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tableId: "fixture_table", familyId: "fixture_family", rowGranularity: "row", sourceAssetRegistry: registry,
    })).rejects.toThrow();
  });
});
