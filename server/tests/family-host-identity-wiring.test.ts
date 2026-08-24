import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import type {
  ProviderRevisionEvidenceV1,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import { getAdapter } from "../src/dataset/adapters/adapters.js";
import { parseDatasetBuildSpec, type SourceAsset } from "../src/dataset/contracts/index.js";
import { delimitedRowsWithLines } from "../src/dataset/adapters/text.js";
import { deriveProductionExpressionIdentity } from "../src/dataset/identity/production.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];

function fixture(name: string): string {
  return path.resolve("tests", "phase5", "fixtures", "gdc", name);
}

function geoFixture(name: string): string {
  return path.resolve("tests", "phase5", "fixtures", "geo", name);
}

function assetFor(sourcePath: string): SourceAsset {
  const bytes = readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    asset_id: `asset_${sha256}`,
    kind: "source",
    relative_path: `source_assets/${path.basename(sourcePath)}`,
    sha256,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: "binding_gdc",
    successful_attempt_id: "receipt_source",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

function v2Spec(accession: string | null = null): ReturnType<typeof parseDatasetBuildSpec> {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_identity_derivation",
    objective: "identity derivation",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v2",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
      accession,
      parameters: {},
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

function receiptFor(asset: SourceAsset, taskId = "task_identity_derivation"): SourceAssetRegistrationReceipt {
  return {
    schema_version: "1.0",
    receipt_id: "receipt_identity_source",
    task_id: taskId,
    asset_ref: { schema_version: "1.0", asset_id: asset.asset_id, task_id: taskId, role: "source" },
    source_id: "binding_gdc",
    relative_path: "source_assets/gdc_expression.tsv",
    sha256: asset.sha256,
    size_bytes: asset.size_bytes,
    media_type: "text/tab-separated-values",
    registered_at: "2026-08-24T00:00:00.000Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
  };
}

function providerEvidence(receipt: SourceAssetRegistrationReceipt, revisionToken: string | null = null): ProviderRevisionEvidenceV1 {
  return {
    schema_version: "1.0",
    canonical_accession: "GDC:TEST",
    provider_snapshot_identity: "gdc-fixture-snapshot:v1",
    provider_revision_token: revisionToken,
    source_asset_registration_receipt: receipt,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authoritative expression identity production wiring", () => {
  test.each([
    ["gene", "gene_expression.long.v2"],
    ["probe", "gene_expression.probe_long.v2"],
  ])("GEO %s V2 source rows carry explicit dataset and revision identity", async (_label, schemaRef) => {
    const sourcePath = geoFixture("geo_series_matrix.txt.gz");
    const sourceAsset = assetFor(sourcePath);
    const outputDir = mkdtempSync(path.join(tmpdir(), "identity-wiring-geo-"));
    roots.push(outputDir);

    const batch = await getAdapter("geo.expression.v1").parse(sourceAsset, sourcePath, {
      buildId: "build_must_not_be_identity",
      bindingId: "binding_geo",
      schemaRef,
      outputDir,
      parameters: {
        schema_version: "1.0",
        format: "series_matrix",
        value_semantics: "normalized_expression_value",
        value_scale: "log2",
        expression_unit: "normalized_expression_value",
        is_normalized: true,
        platform_ids: [],
        delimiter: "auto",
      },
      identityContext: {
        schemaRef: schemaRef as "gene_expression.long.v2" | "gene_expression.probe_long.v2",
        datasetId: `ds_${"c".repeat(64)}`,
        datasetRevisionId: `dsrev_${"d".repeat(64)}`,
        carrierAssetIds: [sourceAsset.asset_id],
        sourceAssetId: sourceAsset.asset_id,
      },
    });

    const parsed = delimitedRowsWithLines(
      readFileSync(path.join(outputDir, "batches", "binding_geo.csv"), "utf8"),
      ",",
    );
    expect(batch.schema_ref).toBe(schemaRef);
    expect(parsed[0]?.values).toContain("dataset_revision_id");
    expect(parsed[1]?.values).toContain(`ds_${"c".repeat(64)}`);
    expect(parsed[1]?.values).toContain(`dsrev_${"d".repeat(64)}`);
    expect(JSON.stringify(parsed)).not.toContain("build_must_not_be_identity");
  });

  test("GDC V2 source rows carry explicit dataset and revision identity", async () => {
    const sourcePath = fixture("gdc_expression.tsv");
    const sourceAsset = assetFor(sourcePath);
    const outputDir = mkdtempSync(path.join(tmpdir(), "identity-wiring-red-"));
    roots.push(outputDir);

    const batch = await getAdapter("gdc.expression.v1").parse(sourceAsset, sourcePath, {
      buildId: "build_must_not_be_identity",
      bindingId: "binding_gdc",
      schemaRef: "gene_expression.long.v2",
      outputDir,
      identityContext: {
        schemaRef: "gene_expression.long.v2",
        datasetId: `ds_${"a".repeat(64)}`,
        datasetRevisionId: `dsrev_${"b".repeat(64)}`,
        carrierAssetIds: [sourceAsset.asset_id],
        sourceAssetId: sourceAsset.asset_id,
      },
    });

    const parsed = delimitedRowsWithLines(
      readFileSync(path.join(outputDir, "batches", "binding_gdc.csv"), "utf8"),
      ",",
    );
    expect(batch.schema_ref).toBe("gene_expression.long.v2");
    expect(parsed[0]?.values).toContain("dataset_revision_id");
    expect(parsed[1]?.values).toContain(`ds_${"a".repeat(64)}`);
    expect(parsed[1]?.values).toContain(`dsrev_${"b".repeat(64)}`);
    expect(JSON.stringify(parsed)).not.toContain("build_must_not_be_identity");
  });

  test("V2 adapters reject an identity capability for a different schema", async () => {
    const sourcePath = fixture("gdc_expression.tsv");
    const sourceAsset = assetFor(sourcePath);
    const outputDir = mkdtempSync(path.join(tmpdir(), "identity-wiring-schema-mismatch-"));
    roots.push(outputDir);

    await expect(getAdapter("gdc.expression.v1").parse(sourceAsset, sourcePath, {
      buildId: "build_must_not_be_identity",
      bindingId: "binding_gdc",
      schemaRef: "gene_expression.long.v2",
      outputDir,
      identityContext: {
        schemaRef: "gene_expression.probe_long.v2",
        datasetId: `ds_${"a".repeat(64)}`,
        datasetRevisionId: `dsrev_${"b".repeat(64)}`,
        carrierAssetIds: [sourceAsset.asset_id],
        sourceAssetId: sourceAsset.asset_id,
      },
    })).rejects.toThrow(/schemaRef does not match/);
  });

  test("V2 identity derivation fails closed for missing, cross-task, inconsistent, and caller-owned facts", () => {
    const sourcePath = fixture("gdc_expression.tsv");
    const sourceAsset = assetFor(sourcePath);
    const receipt = receiptFor(sourceAsset);
    const baseInput = {
      spec: v2Spec(),
      taskId: "task_identity_derivation",
      sourceAssets: { binding_gdc: sourceAsset },
      mappingAssets: {},
      metadataAssets: {},
      providerRevisionEvidence: [providerEvidence(receipt)],
      registrationReceipts: [receipt],
    } as const;

    expect(() => deriveProductionExpressionIdentity({
      ...baseInput,
      providerRevisionEvidence: null,
    })).toThrow(/provider revision evidence is required/);
    expect(() => deriveProductionExpressionIdentity({
      ...baseInput,
      registrationReceipts: null,
    })).toThrow(/registration receipts are required/);
    const otherTaskReceipt = receiptFor(sourceAsset, "task_other");
    expect(() => deriveProductionExpressionIdentity({
      ...baseInput,
      providerRevisionEvidence: [providerEvidence(otherTaskReceipt)],
      registrationReceipts: [otherTaskReceipt],
    })).toThrow(/different task/);
    const secondAsset = { ...sourceAsset, asset_id: `asset_${"e".repeat(64)}`, sha256: "e".repeat(64), source_id: "binding_gdc_mapping" };
    const secondReceipt = {
      ...receiptFor(secondAsset),
      receipt_id: "receipt_identity_mapping",
      asset_ref: { ...receiptFor(secondAsset).asset_ref, role: "mapping" as const },
      source_id: "binding_gdc_mapping",
    };
    expect(() => deriveProductionExpressionIdentity({
      ...baseInput,
      mappingAssets: { binding_gdc: secondAsset },
      providerRevisionEvidence: [providerEvidence(receipt), providerEvidence(secondReceipt, "revision-drift")],
      registrationReceipts: [receipt, secondReceipt],
    })).toThrow(/share one provider revision snapshot/);
    expect(() => deriveProductionExpressionIdentity({
      ...baseInput,
      spec: v2Spec("CALLER_DATASET_ID"),
    })).toThrow(/caller accession/);

    const derived = deriveProductionExpressionIdentity(baseInput);
    expect(derived?.context.datasetId).toMatch(/^ds_[0-9a-f]{64}$/);
    expect(derived?.context.datasetRevisionId).toMatch(/^dsrev_[0-9a-f]{64}$/);
    expect(derived?.context.datasetId).not.toBe(baseInput.spec.build_id);
    expect(derived?.context.datasetRevisionId).not.toBe(baseInput.spec.build_id);
  });

  test("Core passes the authoritative V2 identity into a GDC publication path", async () => {
    const sourcePath = fixture("gdc_expression.tsv");
    const bytes = readFileSync(sourcePath);
    const taskRoot = mkdtempSync(path.join(tmpdir(), "identity-wiring-core-"));
    roots.push(taskRoot);
    mkdirSync(path.join(taskRoot, "source_assets"), { recursive: true });
    writeFileSync(path.join(taskRoot, "source_assets", "gdc_expression.tsv"), bytes);
    const taskId = "task_identity_core";
    const registry = new SourceAssetRegistry(taskId, taskRoot);
    const receipt = await registry.register({
      sourceId: "binding_gdc",
      relativePath: "source_assets/gdc_expression.tsv",
      role: "source",
    });
    const sourceAsset: SourceAsset = {
      ...assetFor(sourcePath),
      relative_path: "source_assets/gdc_expression.tsv",
      successful_attempt_id: receipt.receipt_id,
    };
    const core = new TypeScriptDatasetCore({ taskId, taskRoot });
    const record = await core.executeDatasetBuild({
      ...v2Spec(),
      build_id: "build_identity_core",
    }, {
      runId: "run_identity_core",
      sourceAssets: { binding_gdc: sourceAsset },
      providerRevisionEvidence: [providerEvidence(receipt)],
      registrationReceipts: [receipt],
    });
    expect(record.status, `record.error=${record.error ?? "null"}`).toBe("completed");
    expect(record.manifest?.schema_ref).toBe("gene_expression.long.v2");
    const primary = readFileSync(
      path.join(taskRoot, "datasets_build", "build_identity_core", "merged", "primary.csv"),
      "utf8",
    );
    const [headerLine, firstRow] = primary.split(/\r?\n/);
    const header = headerLine?.split(",") ?? [];
    const row = firstRow?.split(",") ?? [];
    const datasetId = row[header.indexOf("dataset_id")];
    const datasetRevisionId = row[header.indexOf("dataset_revision_id")];
    expect(header).toContain("dataset_revision_id");
    expect(datasetId).toMatch(/^ds_[0-9a-f]{64}$/);
    expect(datasetRevisionId).toMatch(/^dsrev_[0-9a-f]{64}$/);
    expect(datasetId).not.toBe("build_identity_core");
    expect(primary).toContain(datasetRevisionId ?? "missing-revision");
  });
});
