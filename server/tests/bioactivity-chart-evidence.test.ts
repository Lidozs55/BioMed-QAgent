import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  JsonValue,
  OperationResultManifest,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import type { MultiTableValidationRequest } from "../src/dataset/contracts/index.js";

import {
  RegisteredTableAdapter,
  type RegisteredTableAdapterResult,
  type RegisteredTableRejectedRow,
  type RegisteredTableRow,
  type RegisteredTableSink,
} from "../src/dataset/adapters/registered/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import {
  bioactivityRelations,
  bioactivityTableEntries,
  type BioactivityRows,
} from "../src/dataset/families/bioactivity-measurement/index.js";
import {
  assembleBioactivityChartEvidenceCandidate,
  assertChartEvidenceRows,
  BIOACTIVITY_CHART_EVIDENCE_ASSEMBLER_ID,
  chartEvidenceRelations,
  chartEvidenceTables,
  chartEvidenceValidationPolicy,
  createChartEvidenceRegisteredTableRegistry,
  evaluateChartEvidencePublication,
  validateChartEvidenceCandidate,
  type ChartEvidenceRows,
} from "../src/dataset/families/bioactivity-measurement/chart-evidence/index.js";

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
const DIGEST = "c".repeat(64);
const SOURCE_ASSET_ID = `asset_${"a".repeat(64)}`;

class MemorySink implements RegisteredTableSink {
  readonly rows: RegisteredTableRow[] = [];
  readonly rejected: RegisteredTableRejectedRow[] = [];
  result: RegisteredTableAdapterResult | null = null;

  writeRow(row: RegisteredTableRow): void {
    this.rows.push(row);
  }

  writeRejectedRow(row: RegisteredTableRejectedRow): void {
    this.rejected.push(row);
  }

  commit(result: RegisteredTableAdapterResult): void {
    this.result = result;
  }

  rollback(): void {
    throw new Error("test does not expect rollback");
  }
}

async function loadChartRows(): Promise<ChartEvidenceRows> {
  return JSON.parse(await readFile(CHART_FIXTURE, "utf8")) as ChartEvidenceRows;
}

async function loadBioactivityRows(): Promise<BioactivityRows> {
  return JSON.parse(await readFile(BIOACTIVITY_FIXTURE, "utf8")) as BioactivityRows;
}

function receipt(bytes: Buffer): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_chart_fixture",
    task_id: "task_chart",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_chart",
      role: "source",
    },
    source_id: "source_chart_fixture",
    relative_path: "source_assets/chart-fixture.json",
    sha256,
    size_bytes: bytes.length,
    media_type: "application/json",
    registered_at: "2026-08-18T00:00:00Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
  };
}

async function parseTable(
  bytes: Buffer,
  tableIndex: number,
): Promise<MemorySink> {
  const table = chartEvidenceTables[tableIndex];
  if (table === undefined) throw new Error("missing chart table definition");
  const registrationReceipt = receipt(bytes);
  const registry = createChartEvidenceRegisteredTableRegistry();
  const adapterId = `registered_bioactivity_${table.definition.table_id}_json`;
  const parserVersion = "1_0_0";
  const sink = new MemorySink();
  await new RegisteredTableAdapter(registry).parse({
    schema_version: "1.0",
    task_id: "task_chart",
    asset_id: registrationReceipt.asset_ref.asset_id,
    schema_ref: table.schema.schema_id,
    adapter_id: adapterId,
    parser_version: parserVersion,
  }, {
    registration_receipt: registrationReceipt,
    content: (async function* () { yield bytes; })(),
  }, sink);
  return sink;
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowCount(rows: ChartEvidenceRows | BioactivityRows, tableId: string): number {
  const value = Reflect.get(rows, tableId);
  if (!Array.isArray(value)) throw new Error(`fixture omits ${tableId}`);
  return value.length;
}

function rowsFor(rows: ChartEvidenceRows | BioactivityRows, tableId: string): readonly object[] {
  const value = Reflect.get(rows, tableId);
  if (!Array.isArray(value)) throw new Error(`fixture omits ${tableId}`);
  return value as readonly object[];
}

async function csvFixture(
  root: string,
  tableId: string,
  schema: DatasetSchemaV2,
  rows: ChartEvidenceRows | BioactivityRows,
): Promise<{ relativePath: string; bytes: Buffer }> {
  const fields = schema.fields.map((field) => field.name);
  const content = [
    fields.join(","),
    ...rowsFor(rows, tableId).map((row) => fields.map((field) => csvCell(Reflect.get(row, field))).join(",")),
  ].join("\n") + "\n";
  const bytes = Buffer.from(content);
  const relativePath = `tables/${tableId}.csv`;
  await mkdir(path.join(root, "tables"), { recursive: true });
  await writeFile(path.join(root, "tables", `${tableId}.csv`), bytes);
  return { relativePath, bytes };
}

function resultFor(
  tableId: string,
  schema: DatasetSchemaV2,
  rows: ChartEvidenceRows | BioactivityRows,
  file?: { relativePath: string; bytes: Buffer },
): OperationResultManifest {
  const bytes = file?.bytes ?? Buffer.from(JSON.stringify(Reflect.get(rows, tableId)));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_chart",
    build_id: "build_chart",
    operation_id: `integrate_${tableId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: sha256,
    output_kind: "integrated_table",
    output_summary: {
      table_id: tableId,
      schema_ref: schema.schema_id,
      row_count: rowCount(rows, tableId),
      column_count: schema.fields.length,
      primary_file_sha256: sha256,
    },
    output_files: [{
      relative_path: file?.relativePath ?? `tables/${tableId}.csv`,
      size_bytes: bytes.length,
      sha256,
    }],
    dependency_closure: {
      input_asset_ids: [SOURCE_ASSET_ID],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${tableId}`,
      committed_at: "2026-08-18T00:00:00Z",
    },
    migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
  };
}

function evidenceResult(
  tableId: string,
  kind: "provenance" | "confidence",
): OperationResultManifest {
  const sha256 = createHash("sha256").update(`${kind}:${tableId}`).digest("hex");
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${kind}_${tableId}`,
    task_id: "task_chart",
    build_id: "build_chart",
    operation_id: `${kind}_${tableId}`,
    operation_kind: "canonicalize",
    operation_attempt_id: `attempt_${kind}_${tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: sha256,
    output_kind: "canonical_table",
    output_summary: { table_id: tableId } as Record<string, JsonValue>,
    output_files: [{ relative_path: `${kind}/${tableId}.json`, size_bytes: 64, sha256 }],
    dependency_closure: {
      input_asset_ids: [SOURCE_ASSET_ID],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${kind}_${tableId}`,
      committed_at: "2026-08-18T00:00:00Z",
    },
    migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function candidateValidationRequest(
  root: string,
  tables: readonly { definition: import("@biomed/contracts").TableDefinition; schema: DatasetSchemaV2; file: { relativePath: string; bytes: Buffer }; result: OperationResultManifest }[],
): MultiTableValidationRequest {
  const allTableIds = tables.map((table) => table.definition.table_id);
  const allRelationIds = [
    ...bioactivityRelations.map((relation) => relation.relation_id),
    ...chartEvidenceRelations.map((relation) => relation.relation_id),
  ];
  return {
    task_id: "task_chart",
    build_id: "build_chart",
    candidate: {
      candidate_id: "candidate_chart_validation",
      table_ids: allTableIds,
      relation_ids: allRelationIds,
      provenance_refs: tables.map((table) => `prov_${table.definition.table_id}`),
      confidence_refs: tables.map((table) => `conf_${table.definition.table_id}`),
      audit_refs: [],
    },
    tables: tables.map((table) => ({
      definition: table.definition,
      schema: table.schema,
      file: {
        origin: "core_operation_result" as const,
        relative_path: table.file.relativePath,
        delimiter: "," as const,
        operation_result: table.result,
      },
      provenance_refs: [`prov_${table.definition.table_id}`],
      confidence_refs: [`conf_${table.definition.table_id}`],
    })),
    relations: [
      ...bioactivityRelations,
      ...chartEvidenceRelations,
    ],
    trusted_root: root,
    forbidden_roots: [],
    policy: chartEvidenceValidationPolicy(),
  };
}

describe("bioactivity chart evidence B6A module", () => {
  it("parses non-Gold chart tables and assembles a Core-only bioactivity candidate", async () => {
    const bytes = await readFile(CHART_FIXTURE);
    const chartRows = JSON.parse(bytes.toString("utf8")) as ChartEvidenceRows;
    const bioactivityRows = await loadBioactivityRows();
    expect(evaluateChartEvidencePublication(
      chartRows,
      new Set(bioactivityRows.activities.map((row) => row.activity_id)),
    )).toMatchObject({ publishable: true });

    const sinks = await Promise.all(chartEvidenceTables.map((_, index) => parseTable(bytes, index)));
    expect(sinks.map((sink) => sink.result?.audit.accepted_row_count)).toEqual([1, 1, 1, 1]);
    expect(sinks.every((sink) => sink.rejected.length === 0)).toBe(true);
    expect(chartEvidenceTables.map((entry) => [entry.definition.table_id, entry.definition.role])).toEqual([
      ["chart_series", "supporting"],
      ["chart_points", "derived"],
      ["papers", "supporting"],
      ["sources", "supporting"],
    ]);
    expect(chartEvidenceTables[1]!.definition.allow_empty).toBe(true);

    const bioactivityResults = bioactivityTableEntries().map((entry) =>
      resultFor(entry.tableId, entry.schema, bioactivityRows));
    const chartResults = chartEvidenceTables.map((entry) =>
      resultFor(entry.definition.table_id, entry.schema, chartRows));
    const candidate = assembleBioactivityChartEvidenceCandidate({
      bioactivity: {
        taskId: "task_chart",
        buildId: "build_chart",
        datasetFamily: "bioactivity_measurement",
        rowGranularity: "one compound-assay-target activity measurement",
        tables: bioactivityTableEntries().map((entry, index) => ({
          tableId: entry.tableId,
          result: bioactivityResults[index]!,
          provenanceResults: [evidenceResult(entry.tableId, "provenance")],
          confidenceResults: [evidenceResult(entry.tableId, "confidence")],
        })),
        registeredAssetIds: [SOURCE_ASSET_ID],
        rows: bioactivityRows,
      },
      chartTables: chartEvidenceTables.map((entry, index) => ({
        tableId: entry.definition.table_id as "chart_series" | "chart_points" | "papers" | "sources",
        result: chartResults[index]!,
        provenanceResults: [evidenceResult(entry.definition.table_id, "provenance")],
        confidenceResults: [evidenceResult(entry.definition.table_id, "confidence")],
      })),
      chartRows,
      bioactivityRows,
      registeredAssetIds: [SOURCE_ASSET_ID],
    });

    expect(candidate.tables.map((table) => table.definition.table_id)).toEqual([
      "activities", "compounds", "assays", "targets",
      "chart_series", "chart_points", "papers", "sources",
    ]);
    expect(candidate.relations.map((relation) => relation.relation_id)).toEqual([
      "activity_compound", "activity_assay", "activity_target", "assay_target",
      ...chartEvidenceRelations.map((relation) => relation.relation_id),
    ]);
    expect(candidate.registered_asset_ids).toEqual([SOURCE_ASSET_ID]);
    expect(JSON.stringify(candidate)).not.toContain("tables/chart_points.csv");
    expect(BIOACTIVITY_CHART_EVIDENCE_ASSEMBLER_ID).toBe(
      "bioactivity_measurement.chart_evidence.assembler.v1",
    );
    const productionRegistry = createDefaultDatasetFamilyRegistry();
    expect(productionRegistry.list()).not.toContain("bioactivity_measurement");
    expect(() => productionRegistry.get("bioactivity_measurement")).toThrow(/not registered/);
  });

  it("blocks unreviewed low-confidence primary points and review-based reliability upgrades", async () => {
    const rows = await loadChartRows();
    const pending = clone(rows);
    pending.chart_points[0]!.review_status = "pending";
    pending.chart_points[0]!.review_id = null;
    pending.chart_points[0]!.transform_provenance = {
      ...pending.chart_points[0]!.transform_provenance,
      review: null,
    };
    const activityIds = new Set(["ACT_NON_GOLD_1"]);
    expect(evaluateChartEvidencePublication(pending, activityIds)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/estimated point.*requires accepted or corrected review/) }],
    });

    const upgraded = clone(rows);
    upgraded.chart_points[0]!.source_reliability = "high";
    expect(evaluateChartEvidencePublication(upgraded, activityIds)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/must not upgrade source reliability/) }],
    });

    expect(rows.chart_points[0]).toMatchObject({
      review_status: "accepted",
      source_reliability: "medium",
      extraction_reliability: "low",
    });
    expect(rows.chart_points[0]!.transform_provenance).toMatchObject({
      source_reliability_at_extraction: "medium",
      extraction_reliability_at_extraction: "low",
    });
  });

  it("allows empty chart_points only for explicit axis or legend uncertainty", async () => {
    const clear = await loadChartRows();
    clear.chart_points = [];
    expect(() => assertChartEvidenceRows(clear, new Set(["ACT_NON_GOLD_1"]))).toThrow(
      /may omit chart_points only when axis or legend is unclear/,
    );

    const unclear = clone(clear);
    unclear.chart_series[0]!.axis_validation_status = "unclear";
    expect(() => assertChartEvidenceRows(unclear, new Set(["ACT_NON_GOLD_1"]))).not.toThrow();
  });

  it("passes the generic B3 multi-table gate with trusted files and fails on chart token drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chart-evidence-b3-trusted-"));
    const forbidden = await mkdtemp(path.join(os.tmpdir(), "chart-evidence-b3-forbidden-"));
    await writeFile(path.join(root, "keep"), "trusted");
    const chartRows = await loadChartRows();
    const bioactivityRows = await loadBioactivityRows();
    const files: Array<{
      definition: import("@biomed/contracts").TableDefinition;
      schema: DatasetSchemaV2;
      file: { relativePath: string; bytes: Buffer };
      result: OperationResultManifest;
    }> = [];
    for (const entry of bioactivityTableEntries()) {
      const file = await csvFixture(root, entry.tableId, entry.schema, bioactivityRows);
      files.push({ definition: entry.definition, schema: entry.schema, file, result: resultFor(entry.tableId, entry.schema, bioactivityRows, file) });
    }
    for (const entry of chartEvidenceTables) {
      const file = await csvFixture(root, entry.definition.table_id, entry.schema, chartRows);
      files.push({ definition: entry.definition, schema: entry.schema, file, result: resultFor(entry.definition.table_id, entry.schema, chartRows, file) });
    }
    try {
      const request = candidateValidationRequest(root, files);
      request.forbidden_roots = [forbidden];
      const validation = await validateChartEvidenceCandidate(
        request,
        chartRows,
        new Set(bioactivityRows.activities.map((row) => row.activity_id)),
      );
      expect(validation.passed).toBe(true);

      const drifted = clone(request);
      const chartSeriesTable = drifted.tables.find((table) => table.definition.table_id === "chart_series");
      if (chartSeriesTable === undefined) throw new Error("missing chart_series validation table");
      chartSeriesTable.provenance_refs = [];
      expect((await validateChartEvidenceCandidate(
        drifted,
        chartRows,
        new Set(bioactivityRows.activities.map((row) => row.activity_id)),
      )).passed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(forbidden, { recursive: true, force: true });

    }
  });

  it("requires bbox/model/transform provenance and correction history", async () => {
    const activityIds = new Set(["ACT_NON_GOLD_1"]);
    const badLocator = await loadChartRows();
    const pointLocator = badLocator.chart_points[0]!.pixel_or_coordinate_locator;
    if (pointLocator.locator_type !== "image_bbox") throw new Error("fixture locator must be image_bbox");
    badLocator.chart_points[0]!.pixel_or_coordinate_locator = {
      ...pointLocator,
      bbox: [500, 330, 432, 342],
    };
    expect(evaluateChartEvidencePublication(badLocator, activityIds)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/bbox/) }],
    });

    const corrected = await loadChartRows();
    corrected.chart_points[0]!.review_status = "corrected";
    corrected.chart_points[0]!.original_x_value = "10";
    corrected.chart_points[0]!.original_y_value = "63";
    corrected.chart_points[0]!.transform_provenance = {
      ...corrected.chart_points[0]!.transform_provenance,
      steps: [
        ...corrected.chart_points[0]!.transform_provenance.steps,
        {
          step_id: "step_human_correction",
          operation: "human_correction",
          implementation: "durable-hil-review",
          implementation_version: "1.0.0",
          parameters: { fields: ["y_value"] },
          input_digest: "7".repeat(64),
          output_digest: "8".repeat(64),
        },
      ],
      review: {
        ...corrected.chart_points[0]!.transform_provenance.review!,
        status: "corrected",
        reason: "The reviewer corrected the interpolated y coordinate.",
      },
    };
    expect(evaluateChartEvidencePublication(corrected, activityIds)).toMatchObject({ publishable: true });

    const missingTransform = clone(corrected);
    missingTransform.chart_points[0]!.transform_provenance = {
      ...missingTransform.chart_points[0]!.transform_provenance,
      steps: missingTransform.chart_points[0]!.transform_provenance.steps.filter(
        (step) => step.operation !== "human_correction",
      ),
    };
    expect(evaluateChartEvidencePublication(missingTransform, activityIds)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/human_correction transform/) }],
    });
  });
});
