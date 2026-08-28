import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createDatasetExecutionTools } from "../src/agent/tools/dataset-execution.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import {
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
  type AcquisitionProviderHandler,
} from "../src/dataset/acquisition/runtime.js";
import { integrate } from "../src/dataset/integrator/integrator.js";
import { parseDatasetExecutionSpec, parseSourceAsset } from "../src/dataset/contracts/index.js";
import { buildProbeExpressionSchemaV2 } from "../src/dataset/schema/expression.js";
import { parseDataBatch } from "../src/dataset/contracts/data.js";
import { TsDatasetCoreAdapter } from "../src/dataset/service/dataset-core.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient } from "../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const DATASET_ID = `ds_${"a".repeat(64)}`;
const REVISION_ID = `dsrev_${"b".repeat(64)}`;

async function canonicalProbeFile(root: string): Promise<string> {
  const file = path.join(root, "probe.csv");
  const header = [
    "record_id", "dataset_id", "dataset_revision_id", "source_id", "asset_id",
    "probe_id", "platform_id", "sample_id", "value", "gene_id_namespace",
    "value_semantics", "value_scale", "expression_unit", "is_normalized",
    "is_integer_expected", "source_sample_alias", "measurement_type",
    "source_logical_file", "source_line_number", "source_column_index",
    "source_column_name", "source_raw_value",
  ];
  const row = (platform: string, value: string, asset: string): string[] => [
    `record_${platform}`,
    DATASET_ID,
    REVISION_ID,
    "geo",
    asset,
    "probe_1",
    platform,
    "sample_1",
    value,
    "geo_probe",
    "normalized_expression",
    "log2",
    "normalized_expression_value",
    "true",
    "false",
    "sample_1",
    "expression",
    "fixture.txt",
    "1",
    "0",
    "value",
    value,
  ];
  await writeFile(file, `${header.join(",")}\n${row("GPL111", "1", `asset_${"c".repeat(64)}`).join(",")}\n${row("GPL222", "2", `asset_${"d".repeat(64)}`).join(",")}\n`);
  return file;
}

describe("Family Host identity review regressions", () => {
  it("publishes a GDC V2 build through the tool using Core-generated provider evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "identity-review-tool-"));
    try {
      const fixturePath = path.resolve("tests", "phase5", "fixtures", "gdc", "gdc_expression.tsv");
      const bytes = await readFile(fixturePath);
      const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      const provider: AcquisitionProviderHandler = {
        providerId: "gdc.files.v1",
        implementationDigest: "e".repeat(64),
        plan: () => ({
          source: {
            schema_version: "1.0",
            source_id: "source_gdc_fixture",
            database: "gdc",
            accession: "GDC:TEST",
            url: "https://fixture.example/gdc.tsv",
            title: "GDC fixture",
            retrieved_at: "2026-08-24T00:00:00.000Z",
          },
          filename: "gdc_expression.tsv",
          dataLevel: "repository_processed",
          maxBytes: 1024 * 1024,
          expectedSha256: sha256,
          expectedMediaTypes: new Set(["text/tab-separated-values"]),
          allowedHosts: new Set(["fixture.example"]),
          assetRole: "carrier",
          providerRevisionFacts: {
            canonical_accession: "GDC:TEST",
            provider_snapshot_identity: "gdc-fixture-snapshot:v1",
            provider_revision_token: "gdc-fixture-revision:v1",
          },
        }),
      };
      const registry = new CoreAcquisitionRegistry();
      registry.registerProvider(provider);
      const sourceAssets = new SourceAssetRegistry("task_identity_tool", root);
      const acquisition = new CoreAcquisitionRuntime({
        taskId: "task_identity_tool",
        taskRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: new PublicHttpClient({
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          executor: async () => ({
            status: 200,
            headers: {
              "content-type": "text/tab-separated-values",
              "content-length": String(bytes.length),
            },
            body: (async function* (): AsyncIterable<Buffer> { yield bytes; })(),
          }),
        }),
        sourceAssetRegistry: sourceAssets,
        registry,
        maxAttempts: 1,
      });
      const core = new TypeScriptDatasetCore({ taskId: "task_identity_tool", taskRoot: root });
      const service = new TsDatasetCoreAdapter(core, {
        acquisition: (input) => acquisition.acquire(input.request, input.signal),
      });
      const spec = parseDatasetExecutionSpec({
        schema_version: "1.0",
        requirement_id: "requirement_identity_tool",
        objective: "publish trusted GDC identity",
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v2",
        source_bindings: [{
          schema_version: "1.0",
          binding_id: "binding_gdc",
          source: "gdc",
          acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
          adapter_id: "gdc.expression.v1",
          accession: "GDC:TEST",
          parameters: {},
        }],
        validation_profile_ref: "gene_expression.release.v1",
      });
      const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
        client: service,
        taskId: "task_identity_tool",
        taskRoot: root,
        runId: () => "run_identity_tool",
        piSessionId: () => "pi_identity_tool",
      });
      const result = await tools[1]!.execute({ spec, mapping_files: {} });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      expect(result.details).toMatchObject({ code: "ok" });
      const primary = await readFile(path.join(root, "dataset_runs", "run_identity_tool", spec.requirement_id, "merged", "primary.csv"), "utf8");
      expect(primary).toContain("dataset_revision_id");
      expect(primary).not.toContain(spec.requirement_id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the V2 probe primary key including platform_id and the probe value column", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "identity-review-probe-"));
    try {
      const canonicalPath = await canonicalProbeFile(root);
      const schema = buildProbeExpressionSchemaV2();
      const batch = parseDataBatch({
        schema_version: "1.0",
        batch_id: "batch_probe",
        binding_id: "binding_geo",
        dataset_family: "gene_expression",
        row_granularity: "probe_sample_measurement",
        schema_ref: schema.schema_id,
        file_asset: null,
        row_count: 2,
        column_count: schema.fields.length,
        parser_id: "fixture.geo.v1",
        parser_version: "1.0",
        statistics: {},
        warnings: [],
        declared_mappings: [],
      });
      const result = await integrate({
        results: [{
          batch,
          canonicalPath,
          rowCount: 2,
          rejectedCount: 0,
          namespaces: ["geo_probe"],
          auditPaths: [],
        }],
        mergeStrategy: "append_by_canonical_row",
        schema,
        requirementId: "build_probe_identity_review",
        outputDir: root,
        identityContext: {
          datasetId: DATASET_ID,
          datasetRevisionId: REVISION_ID,
          carrierAssetIds: [`asset_${"c".repeat(64)}`, `asset_${"d".repeat(64)}`],
        },
      });

      expect(result.rowCount).toBe(2);
      expect(result.dedupCount).toBe(0);
      expect(result.conflictCount).toBe(0);
      const conflicts = await readFile(result.conflictsPath!, "utf8");
      expect(conflicts.trim().split("\n")).toHaveLength(1);
      expect(conflicts.split("\n")[0]).toContain("platform_id");
      const primary = await readFile(result.mergedPath, "utf8");
      expect(primary).toContain(",GPL111,");
      expect(primary).toContain(",GPL222,");
      expect(primary).toContain(",1,");
      expect(primary).toContain(",2,");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a Core GEO probe V2 build across platforms with differing values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "identity-review-geo-core-"));
    try {
      await mkdir(path.join(root, "source_assets"), { recursive: true });
      const fixturePath = path.resolve("tests", "phase5", "fixtures", "geo", "geo_series_matrix.txt.gz");
      const fixture = await readFile(fixturePath);
      const makeAsset = async (bindingId: string, platform: string, values: [string, string, string, string, string, string]) => {
        const text = (await import("node:zlib")).gunzipSync(fixture).toString("utf8")
          .replaceAll("GPL570", platform)
          .replace("1.5\t2.0", `${values[0]}\t${values[1]}`)
          .replace("3.0\t4.0", `${values[2]}\t${values[3]}`)
          .replace("5.0\t6.0", `${values[4]}\t${values[5]}`);
        const bytes = gzipSync(text.split(/\r?\n/).filter((line) => !line.includes("ENSG00000141510")).join("\n"));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const relativePath = `source_assets/${bindingId}.txt.gz`;
        await writeFile(path.join(root, ...relativePath.split("/")), bytes);
        return {
          asset: parseSourceAsset({
            schema_version: "1.0",
            asset_id: `asset_${sha256}`,
            kind: "source",
            relative_path: relativePath,
            sha256,
            size_bytes: bytes.length,
            media_type: "application/gzip",
            generated_by_step_id: null,
            source_id: bindingId,
            successful_attempt_id: "attempt_fixture",
            derived_from_asset_id: null,
            data_level: "repository_processed",
          }),
          bytes,
        };
      };
      const first = await makeAsset("geo_gpl570", "GPL570", ["1.5", "2.0", "3.0", "4.0", "5.0", "6.0"]);
      const second = await makeAsset("geo_gpl571", "GPL571", ["11.5", "12.0", "13.0", "14.0", "15.0", "16.0"]);
      const taskId = "task_identity_geo_core";
      const registry = new SourceAssetRegistry(taskId, root);
      const firstReceipt = await registry.register({ sourceId: "geo_gpl570", relativePath: "source_assets/geo_gpl570.txt.gz", role: "carrier" });
      const secondReceipt = await registry.register({ sourceId: "geo_gpl571", relativePath: "source_assets/geo_gpl571.txt.gz", role: "carrier" });
      for (const [receipt, requestDigest] of [[firstReceipt, "1".repeat(64)], [secondReceipt, "2".repeat(64)] ] as const) {
        await registry.registerCoreAcquisitionProvenance(receipt, {
          provider_id: "geo.files.v1",
          implementation_digest: "f".repeat(64),
          request_identity_digest: requestDigest,
          canonical_accession: "GSE178352",
          provider_snapshot_identity: "geo-fixture-snapshot:v1",
          provider_revision_token: "geo-fixture-revision:v1",
        });
      }
      const core = new TypeScriptDatasetCore({ taskId, taskRoot: root });
      const spec = parseDatasetExecutionSpec({
        schema_version: "1.0",
        requirement_id: "build_geo_probe_identity",
        objective: "publish multi-platform GEO probes",
        dataset_family: "gene_expression",
        row_granularity: "probe_sample_measurement",
        schema_ref: "gene_expression.probe_long.v2",
        source_bindings: [
          {
            schema_version: "1.0", binding_id: "geo_gpl570", source: "geo",
            acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.files.v1" },
            adapter_id: "geo.expression.v1", accession: "GSE178352",
            parameters: {
              schema_version: "1.0", format: "series_matrix", value_semantics: "normalized_expression",
              value_scale: "log2", expression_unit: "log2_expression", is_normalized: true,
              platform_ids: ["GPL570"], delimiter: "auto",
            },
          },
          {
            schema_version: "1.0", binding_id: "geo_gpl571", source: "geo",
            acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.files.v1" },
            adapter_id: "geo.expression.v1", accession: "GSE178352",
            parameters: {
              schema_version: "1.0", format: "series_matrix", value_semantics: "normalized_expression",
              value_scale: "log2", expression_unit: "log2_expression", is_normalized: true,
              platform_ids: ["GPL571"], delimiter: "auto",
            },
          },
        ],
        validation_profile_ref: "gene_expression.probe_release.v1",
        target_entity_level: "probe",
      });
      const record = await core.executeDatasetExecution(spec, {
        runId: "run_geo_probe_identity",
        sourceAssets: { geo_gpl570: first.asset, geo_gpl571: second.asset },
        registrationReceipts: [firstReceipt, secondReceipt],
      });
      expect(record.status, record.error ?? "no error").toBe("completed");
      const primary = await readFile(path.join(root, "dataset_runs", "run_geo_probe_identity", spec.requirement_id, "merged", "primary.csv"), "utf8");
      expect(primary).toContain("platform_id");
      expect(primary).toContain("GPL570");
      expect(primary).toContain("GPL571");
      expect(primary).toContain(",11.5,");
      expect(primary).toContain(",14.0,");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
