import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { OperationResultManifest } from "@biomed/contracts";

import {
  bioactivityTableEntries,
  BIOACTIVITY_FAMILY_ID,
} from "../src/dataset/families/bioactivity-measurement/index.js";
import {
  chartEvidenceTables,
  CHART_SERIES_TABLE_ID,
  createChartEvidenceRegisteredTableRegistry,
} from "../src/dataset/families/bioactivity-measurement/chart-evidence/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { executeRegisteredMultiTableBuild } from "../src/dataset/runtime/registered-multitable.js";
import { sha256FileStream } from "../src/dataset/adapters/hashing.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const CHART_FIXTURE = path.join(
  import.meta.dirname,
  "fixtures",
  "bioactivity-chart-evidence",
  "non-gold.valid.json",
);
const BIOACTIVITY_FIXTURE = path.join(
  import.meta.dirname,
  "fixtures",
  "bioactivity-measurement",
  "non-gold.valid.json",
);
const PLACEHOLDER_ASSET = `asset_${"a".repeat(64)}`;

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registerBytes(
  root: string,
  taskId: string,
  sourceId: string,
  fileName: string,
  bytes: Buffer,
) {
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  await writeFile(path.join(root, "source_assets", fileName), bytes);
  return new SourceAssetRegistry(taskId, root).register({
    sourceId,
    relativePath: `source_assets/${fileName}`,
    role: "source",
  });
}

function binding(bindingId: string, source: string, adapterId: string, providerId: string) {
  return {
    schema_version: "1.0" as const,
    binding_id: bindingId,
    source,
    acquisition: {
      schema_version: "1.0" as const,
      mode: "builtin" as const,
      provider_id: providerId,
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: adapterId,
    accession: null,
    parameters: {},
  };
}

interface Scenario {
  chartFixtureText: string;
}

async function buildTask(scenario: Scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chart-evidence-publication-"));
  tempRoots.push(root);
  const taskId = "task_chart_closure";

  // The figure/PGN carrier and the upstream ChEMBL-style carrier are separate
  // registered assets; the row-level source_asset_id fields must reference
  // their real content-addressed IDs.
  const figureReceipt = await registerBytes(
    root, taskId, "source_pmc_fig2", "figure2.png", Buffer.from("png-bytes"),
  );
  const upstreamReceipt = await registerBytes(
    root, taskId, "source_chembl", "non-gold-upstream.json", Buffer.from("upstream-json"),
  );
  const chartJson = scenario.chartFixtureText.replaceAll(PLACEHOLDER_ASSET, figureReceipt.asset_ref.asset_id);
  const chartReceipt = await registerBytes(
    root, taskId, "source_chart_carrier", "chart-evidence.json", Buffer.from(chartJson, "utf8"),
  );
  const bioactivityJson = (await readFile(BIOACTIVITY_FIXTURE, "utf8"))
    .replaceAll(PLACEHOLDER_ASSET, upstreamReceipt.asset_ref.asset_id);
  const bioactivityReceipt = await registerBytes(
    root, taskId, "source_bioactivity_carrier", "bioactivity-evidence.json", Buffer.from(bioactivityJson, "utf8"),
  );

  const baseBindings = bioactivityTableEntries().map((entry) =>
    binding(
      `base_${entry.tableId}`,
      `registered_bioactivity_${entry.tableId}`,
      `registered_bioactivity_${entry.tableId}_json`,
      "registered_asset",
    ));
  const chartBindings = chartEvidenceTables.map((entry) =>
    binding(
      `chart_${entry.definition.table_id}`,
      `registered_bioactivity_${entry.definition.table_id}`,
      `registered_bioactivity_${entry.definition.table_id}_json`,
      "registered_asset",
    ));
  const bindings = [...baseBindings, ...chartBindings];
  const registeredAssetIds: Record<string, string> = {};
  for (const item of baseBindings) registeredAssetIds[item.binding_id] = bioactivityReceipt.asset_ref.asset_id;
  for (const item of chartBindings) registeredAssetIds[item.binding_id] = chartReceipt.asset_ref.asset_id;

  const activitiesSchema = bioactivityTableEntries().find((entry) => entry.tableId === "activities")!.schema;
  const result = await executeRegisteredMultiTableBuild({
    taskId,
    runId: "run_chart_closure",
    taskRoot: root,
    spec: {
      schema_version: "1.0",
      requirement_id: "build_chart_closure",
      objective: "Publish chart evidence through the formal bioactivity route",
      dataset_family: BIOACTIVITY_FAMILY_ID,
      row_granularity: "one compound-assay-target activity measurement",
      entities: {},
      cohort_filters: {},
      required_fields: activitiesSchema.fields.map((field) => field.name),
      schema_ref: activitiesSchema.schema_id,
      source_bindings: bindings,
      normalization_profile_ref: "bioactivity_measurement.registered.v1",
      merge_strategy: "registered_multitable_identity",
      validation_profile_ref: "bioactivity_measurement.release.v1",
      output_format: "csv",
      target_entity_level: null,
    },
    registeredAssetIds,
    publishedAt: "2026-08-29T00:00:00.000Z",
  });
  return { root, result };
}

function tableResult(tableId: string, result: ReturnType<typeof JSON.parse>): OperationResultManifest {
  return result.tableResults[tableId] as OperationResultManifest;
}

describe("chart evidence formal publication closure", () => {
  it("registers chart tables and parsers in the production bioactivity family", () => {
    const family = createDefaultDatasetFamilyRegistry().get(BIOACTIVITY_FAMILY_ID);
    const schemaIds = family.schemas.map((schema) => schema.schema_id);
    for (const entry of chartEvidenceTables) {
      expect(schemaIds).toContain(entry.schema.schema_id);
      expect(family.validation_profiles_by_schema[entry.schema.schema_id]).toEqual([
        "bioactivity_measurement.release.v1",
      ]);
    }
    const chartSources = family.sources.filter((source) =>
      createChartEvidenceRegisteredTableRegistry().entries().some((registration) =>
        registration.parser.adapter_id === source.adapter_id));
    expect(chartSources.map((source) => source.table_id).sort()).toEqual([
      "chart_points", "chart_series", "papers", "sources",
    ]);
  });

  it("publishes accepted chart points end-to-end with intact artifact hashes and provenance", async () => {
    const chartFixtureText = await readFile(CHART_FIXTURE, "utf8");
    const { root, result } = await buildTask({ chartFixtureText });

    expect(result.validation.status).toBe("passed");
    expect(result.candidate.tables.map((table) => table.definition.table_id)).toEqual([
      "activities", "compounds", "assays", "targets",
      "chart_series", "chart_points", "papers", "sources",
    ]);
    expect(result.publication.publicationId).toMatch(/^pub_build_chart_closure_/);
    expect(result.publication.invariants.provenance_closed).toBe(true);

    const versionDir = path.join(
      root, "dataset_runs", "run_chart_closure", "build_chart_closure", result.publication.versionDir,
    );
    const manifestBytes = await readFile(path.join(versionDir, "dataset_manifest.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(
      result.publication.publication.manifest_sha256,
    );
    for (const artifact of result.manifest.artifacts) {
      const stored = path.join(versionDir, ...artifact.relative_path.split("/"));
      expect(await sha256FileStream(stored)).toBe(artifact.sha256);
    }

    // The chart evidence table keeps source asset, page/bbox locator, model
    // identity, transform digests, and point-level confidence in the formal
    // publication bytes.
    const chartSeries = tableResult(CHART_SERIES_TABLE_ID, result);
    const seriesCsv = await readFile(
      path.join(root, "dataset_runs", "run_chart_closure", "build_chart_closure", chartSeries.output_files[0]!.relative_path),
      "utf8",
    );
    expect(seriesCsv).toContain("qwen-vl-max");
    expect(seriesCsv).toContain("2026-07-15");
    expect(seriesCsv).toContain("image_bbox");
    expect(seriesCsv).toContain("vlm_extract");
    expect(seriesCsv).toContain("1111111111111111111111111111111111111111111111111111111111111111");
  });

  it("publishes human-corrected points while preserving the correction history", async () => {
    const rows = JSON.parse(await readFile(CHART_FIXTURE, "utf8")) as {
      chart_points: Array<Record<string, unknown> & { transform_provenance: { steps: unknown[]; review: Record<string, unknown> } }>;
    };
    const point = rows.chart_points[0]!;
    point.review_status = "corrected";
    point.original_x_value = "10";
    point.original_y_value = "63";
    point.transform_provenance.steps.push({
      step_id: "step_human_correction",
      operation: "human_correction",
      implementation: "durable-hil-review",
      implementation_version: "1.0.0",
      parameters: { fields: ["y_value"] },
      input_digest: "7".repeat(64),
      output_digest: "8".repeat(64),
    });
    point.transform_provenance.review = {
      ...point.transform_provenance.review,
      status: "corrected",
      reason: "The reviewer corrected the interpolated y coordinate.",
    };
    const { root, result } = await buildTask({ chartFixtureText: JSON.stringify(rows) });

    expect(result.validation.status).toBe("passed");
    const pointResult = result.tableResults["chart_points"] as OperationResultManifest;
    const pointsCsv = await readFile(
      path.join(root, "dataset_runs", "run_chart_closure", "build_chart_closure", pointResult.output_files[0]!.relative_path),
      "utf8",
    );
    expect(pointsCsv).toContain("human_correction");
    expect(pointsCsv).toContain("7".repeat(64));
    expect(pointsCsv).toContain("63");
  });

  it("fails closed on a pending review point without promoting any publication", async () => {
    const rows = JSON.parse(await readFile(CHART_FIXTURE, "utf8")) as {
      chart_points: Array<Record<string, unknown> & { transform_provenance: { review: unknown } }>;
    };
    rows.chart_points[0]!.review_status = "pending";
    rows.chart_points[0]!.transform_provenance.review = null;

    await expect(buildTask({ chartFixtureText: JSON.stringify(rows) }))
      .rejects.toThrow(/chart_evidence:chart_evidence_gate/);
  });

  it("fails closed when a chart table binding is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chart-evidence-missing-"));
    tempRoots.push(root);
    const taskId = "task_chart_missing";
    const figureReceipt = await registerBytes(
      root, taskId, "source_pmc_fig2", "figure2.png", Buffer.from("png-bytes"),
    );
    const chartJson = (await readFile(CHART_FIXTURE, "utf8"))
      .replaceAll(PLACEHOLDER_ASSET, figureReceipt.asset_ref.asset_id);
    const chartReceipt = await registerBytes(
      root, taskId, "source_chart_carrier", "chart-evidence.json", Buffer.from(chartJson, "utf8"),
    );
    const activitiesSchema = bioactivityTableEntries().find((entry) => entry.tableId === "activities")!.schema;
    const chartBindings = chartEvidenceTables
      .filter((entry) => entry.definition.table_id !== "chart_points")
      .map((entry) => binding(
        `chart_${entry.definition.table_id}`,
        `registered_bioactivity_${entry.definition.table_id}`,
        `registered_bioactivity_${entry.definition.table_id}_json`,
        "registered_asset",
      ));
    // Only chart_series is bound, so the point/paper/source tables never exist.
    await expect(executeRegisteredMultiTableBuild({
      taskId,
      runId: "run_chart_missing",
      taskRoot: root,
      spec: {
        schema_version: "1.0",
        requirement_id: "build_chart_missing",
        objective: "Chart bindings must close all four tables",
        dataset_family: BIOACTIVITY_FAMILY_ID,
        row_granularity: "one compound-assay-target activity measurement",
        entities: {},
        cohort_filters: {},
        required_fields: activitiesSchema.fields.map((field) => field.name),
        schema_ref: activitiesSchema.schema_id,
        source_bindings: chartBindings,
        normalization_profile_ref: "bioactivity_measurement.registered.v1",
        merge_strategy: "registered_multitable_identity",
        validation_profile_ref: "bioactivity_measurement.release.v1",
        output_format: "csv",
        target_entity_level: null,
      },
      registeredAssetIds: Object.fromEntries(chartBindings.map((item) => [item.binding_id, chartReceipt.asset_ref.asset_id])),
    })).rejects.toThrow();
    await stat(path.join(root, "dataset_runs"));
  });
});
