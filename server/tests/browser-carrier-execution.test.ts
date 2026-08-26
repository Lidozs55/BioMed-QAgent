import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { executeBrowserCarrierParser } from "../src/dataset/acquisition/browser-carrier-execution.js";
import { createDefaultBrowserParserRecipeRegistry } from "../src/dataset/acquisition/browser-recipe-registry.js";
import { PROTEIN_STRUCTURE_ROW_GRANULARITY } from "../src/dataset/families/protein-structure/index.js";

const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSX_FIXTURE = path.join(import.meta.dirname, "fixtures", "registered-table", "protein-structure.xlsx");
const XLSX_RECIPE_ID = "browser.registered.registered_protein_structure_xlsx.1_0_0";
const REQUEST_DIGEST = "a".repeat(64);

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
      recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["application/json"] }), resolveRegisteredTable: () => { throw new Error("not reached"); } },
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
      requestIdentityDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", schemaRef: "fixture_schema", recipeId: "fixture.tsv", recipeVersion: "1", recipeRegistry: { resolve: () => ({ ref: { schema_version: "1.0", recipe_id: "fixture.tsv", recipe_version: 1, status: "PROMOTED", implementation_digest: "b".repeat(64) }, schema_ref: "fixture_schema", adapter_id: "fixture", parser_version: "1", media_types: ["application/json"] }), resolveRegisteredTable: () => { throw new Error("not reached"); } },
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tableId: "fixture_table", familyId: "fixture_family", rowGranularity: "row", sourceAssetRegistry: registry,
    })).rejects.toThrow();
  });

  it("parses a promoted XLSX carrier with exact provenance and emits a parsed-table operation result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-carrier-"));
    await mkdir(path.join(root, "source_assets"), { recursive: true });
    const bytes = await readFile(XLSX_FIXTURE);
    const relativePath = "source_assets/protein-structure.xlsx";
    await writeFile(path.join(root, relativePath), bytes);
    const registry = new SourceAssetRegistry("task_carrier_xlsx", root);
    const receipt = await registry.register({
      sourceId: "browser_source",
      relativePath,
      role: "carrier",
      mediaType: XLSX_MEDIA_TYPE,
    });
    await registry.registerCoreAcquisitionProvenance(receipt, {
      provider_id: "browser.snapshot.v1",
      implementation_digest: "b".repeat(64),
      request_identity_digest: REQUEST_DIGEST,
      canonical_accession: "https://example.org/protein-structure.xlsx",
    });

    const outputDir = path.join(root, "build");
    const result = await executeBrowserCarrierParser({
      taskId: "task_carrier_xlsx",
      buildId: "build_carrier_xlsx",
      outputDir,
      assetId: receipt.asset_ref.asset_id,
      requestIdentityDigest: REQUEST_DIGEST,
      schemaRef: "protein_structure.structure.v1",
      recipeId: XLSX_RECIPE_ID,
      recipeVersion: "1",
      recipeRegistry: createDefaultBrowserParserRecipeRegistry(),
      implementationDigest: "b".repeat(64),
      tableId: "structures",
      familyId: "protein_structure",
      rowGranularity: PROTEIN_STRUCTURE_ROW_GRANULARITY,
      sourceAssetRegistry: registry,
    });

    expect(result.adapter.audit).toMatchObject({ format: "xlsx", accepted_row_count: 2, rejected_row_count: 0 });
    expect(result.operationResult.status).toBe("succeeded");
    expect(result.operationResult.output_kind).toBe("parsed_table");
    expect(result.operationResult.output_summary).toMatchObject({ table_id: "structures", row_count: 2 });
    const csv = await readFile(result.absolutePath, "utf8");
    expect(csv).toContain("structure_id,structure_namespace,structure_version,title,experimental_method,resolution_angstrom,deposited_at,source_id,source_locator");
    expect(csv).toContain('4HHB,pdb,1.0,Hemoglobin (deoxy),X-RAY DIFFRACTION,1.74,1984-03-21,pdb_4hhb,"{""pdb_id"":""4HHB""}"');
    expect(csv).toContain('1CRN,pdb,1.0,Crambin,X-RAY DIFFRACTION,0.54,1980-12-01,pdb_1crn,"{""pdb_id"":""1CRN""}"');
  });
});
