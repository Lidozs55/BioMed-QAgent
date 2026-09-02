import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
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
import {
  assertBioactivityRows,
  bioactivityRelations,
  bioactivityTableEntries,
  type BioactivityRows,
} from "../src/dataset/families/bioactivity-measurement/index.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "../src/dataset/families/bioactivity-measurement/chart-evidence/index.js";
import {
  ACTIVITY_VALUE_RECORDS_TABLE_ID,
  assertPaperEvidenceRows,
  createPaperEvidenceRegisteredTableRegistry,
  derivePaperCanonicalIdentities,
  evaluatePaperEvidencePublication,
  EXPERIMENT_RECORDS_TABLE_ID,
  GOLD6_REFERENCE_ROLES,
  paperEvidenceRelations,
  paperEvidenceTables,
  paperEvidenceValidationPolicy,
  PAPER_EVIDENCE_REQUIRED_PROVENANCE_FIELDS,
  PAPER_RECORDS_TABLE_ID,
  SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
  validatePaperEvidenceCandidate,
  type PaperEvidenceRows,
  type PaperEvidenceTableId,
} from "../src/dataset/families/bioactivity-measurement/paper-evidence/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";

const PAPER_FIXTURE = path.join(
  import.meta.dirname,
  "fixtures",
  "bioactivity-paper-evidence",
  "non-gold.valid.json",
);
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
const GOLD6_REFERENCE = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evaluation",
  "gold-v1",
  "schemas",
  "gold6-reference.json",
);
const DIGEST = "c".repeat(64);
const PAPER_CARRIER_ASSET = `asset_${"a".repeat(64)}`;
const SUPPLEMENT_ASSET = `asset_${"b".repeat(64)}`;
const UNREGISTERED_ASSET = `asset_${"e".repeat(64)}`;

interface Gold6ReferenceTable {
  table_id: string;
  role: string;
  granularity: string;
  primary_key: readonly string[];
  columns: readonly string[];
}

interface Gold6Reference {
  tables: readonly Gold6ReferenceTable[];
  relations: readonly {
    from: string;
    to: string;
    cardinality: string;
    missing: string;
  }[];
  required_provenance: readonly string[];
}

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
    // Rejection paths roll back nothing in the in-memory sink.
  }
}

async function loadPaperRows(): Promise<PaperEvidenceRows> {
  return JSON.parse(await readFile(PAPER_FIXTURE, "utf8")) as PaperEvidenceRows;
}

/** Chart rows with paper_id retargeted at the paper_records composite key. */
async function loadChartRowsAlignedToPaperRecords(): Promise<Record<string, unknown[]>> {
  const text = (await readFile(CHART_FIXTURE, "utf8"))
    .replaceAll('"paper_id": "31234567"', '"paper_id": "paper_61c24be3438bc9cda08d90c85aad8d54"');
  return JSON.parse(text) as Record<string, unknown[]>;
}

async function loadBioactivityRows(): Promise<BioactivityRows> {
  return JSON.parse(await readFile(BIOACTIVITY_FIXTURE, "utf8")) as BioactivityRows;
}

function receipt(bytes: Buffer, mediaType = "application/json"): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_paper_fixture",
    task_id: "task_paper",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_paper",
      role: "source",
    },
    source_id: "source_paper_fixture",
    relative_path: "source_assets/paper-fixture.json",
    sha256,
    size_bytes: bytes.length,
    media_type: mediaType,
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
  mediaType = "application/json",
): Promise<MemorySink> {
  const table = paperEvidenceTables[tableIndex];
  if (table === undefined) throw new Error("missing paper table definition");
  const registrationReceipt = receipt(bytes, mediaType);
  const registry = createPaperEvidenceRegisteredTableRegistry();
  const adapterId = `registered_bioactivity_${table.definition.table_id}_json`;
  const sink = new MemorySink();
  await new RegisteredTableAdapter(registry).parse({
    schema_version: "1.0",
    task_id: "task_paper",
    asset_id: registrationReceipt.asset_ref.asset_id,
    schema_ref: table.schema.schema_id,
    adapter_id: adapterId,
    parser_version: "1_0_0",
  }, {
    registration_receipt: registrationReceipt,
    content: (async function* () { yield bytes; })(),
  }, sink);
  return sink;
}

function csvCell(value: unknown): string {
  const text = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsFor(rows: Record<string, unknown>, tableId: string): readonly object[] {
  const value = Reflect.get(rows, tableId);
  if (!Array.isArray(value)) throw new Error(`fixture omits ${tableId}`);
  return value as readonly object[];
}

async function csvFixture(
  root: string,
  tableId: string,
  schema: DatasetSchemaV2,
  rows: Record<string, unknown>,
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
  rows: Record<string, unknown>,
  file?: { relativePath: string; bytes: Buffer },
): OperationResultManifest {
  const bytes = file?.bytes ?? Buffer.from(JSON.stringify(Reflect.get(rows, tableId)));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_paper",
    run_id: "run_paper",
    requirement_id: "build_paper",
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
      row_count: rowsFor(rows, tableId).length,
      column_count: schema.fields.length,
      primary_file_sha256: sha256,
    },
    output_files: [{
      relative_path: file?.relativePath ?? `tables/${tableId}.csv`,
      size_bytes: bytes.length,
      sha256,
    }],
    dependency_closure: {
      input_asset_ids: [PAPER_CARRIER_ASSET],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${tableId}`,
      committed_at: "2026-08-18T00:00:00Z",
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("bioactivity paper evidence module", () => {
  // The gold6 reference schema ships with the internal docs on dev; the
  // pruned public release branch skips this freeze check.
  it.skipIf(!existsSync(GOLD6_REFERENCE))("freezes the gold6 reference table contract exactly", async () => {
    const reference = JSON.parse(await readFile(GOLD6_REFERENCE, "utf8")) as Gold6Reference;
    const referenceTables = reference.tables.filter((table) =>
      [PAPER_RECORDS_TABLE_ID, EXPERIMENT_RECORDS_TABLE_ID, ACTIVITY_VALUE_RECORDS_TABLE_ID, SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID]
        .includes(table.table_id),
    );
    expect(paperEvidenceTables.map((entry) => entry.definition.table_id)).toEqual(
      referenceTables.map((table) => table.table_id),
    );
    const allFieldNames = new Set<string>();
    for (const [index, entry] of paperEvidenceTables.entries()) {
      const frozen = referenceTables[index]!;
      expect(entry.definition.primary_key).toEqual(frozen.primary_key);
      expect(entry.definition.field_names.slice(0, frozen.columns.length)).toEqual([...frozen.columns]);
      expect(entry.schema.row_granularity).toBe(frozen.granularity);
      // The formal publication contract admits exactly one primary table
      // (canonical activities), so the gold6 primary role of
      // activity_value_records is recorded but published as supporting.
      expect(GOLD6_REFERENCE_ROLES[entry.definition.table_id as PaperEvidenceTableId]).toBe(frozen.role);
      if (entry.definition.table_id === ACTIVITY_VALUE_RECORDS_TABLE_ID) {
        expect(entry.definition.role).toBe("supporting");
      } else {
        expect(entry.definition.role).toBe(frozen.role);
      }
      for (const field of entry.schema.fields) allFieldNames.add(field.name);
    }
    for (const provenanceField of reference.required_provenance) {
      expect(allFieldNames.has(provenanceField)).toBe(true);
    }
    expect([...PAPER_EVIDENCE_REQUIRED_PROVENANCE_FIELDS].sort()).toEqual(
      [...reference.required_provenance].sort(),
    );

    expect(paperEvidenceRelations.map((relation) => relation.relation_id)).toEqual([
      "experiment_paper",
      "activity_value_experiment",
      "chart_series_paper_record",
    ]);
    const byRelationId = new Map(paperEvidenceRelations.map((relation) => [relation.relation_id, relation]));
    expect(byRelationId.get("experiment_paper")).toMatchObject({
      from_table_id: EXPERIMENT_RECORDS_TABLE_ID,
      from_fields: ["paper_id"],
      to_table_id: PAPER_RECORDS_TABLE_ID,
      to_fields: ["paper_key"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    });
    expect(byRelationId.get("activity_value_experiment")).toMatchObject({
      from_table_id: ACTIVITY_VALUE_RECORDS_TABLE_ID,
      from_fields: ["experiment_id"],
      to_table_id: EXPERIMENT_RECORDS_TABLE_ID,
      to_fields: ["experiment_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    });
    expect(byRelationId.get("chart_series_paper_record")).toMatchObject({
      from_table_id: "chart_series",
      from_fields: ["paper_id"],
      to_table_id: PAPER_RECORDS_TABLE_ID,
      to_fields: ["paper_key"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    });
  });

  it("registers paper tables and parsers in the production bioactivity family", () => {
    const family = createDefaultDatasetFamilyRegistry().get("bioactivity_measurement");
    const schemaIds = family.schemas.map((schema) => schema.schema_id);
    for (const entry of paperEvidenceTables) {
      expect(schemaIds).toContain(entry.schema.schema_id);
      expect(family.validation_profiles_by_schema[entry.schema.schema_id]).toEqual([
        "bioactivity_measurement.release.v1",
      ]);
    }
    const paperSources = family.sources.filter((source) =>
      createPaperEvidenceRegisteredTableRegistry().entries().some((registration) =>
        registration.parser.adapter_id === source.adapter_id));
    expect(paperSources.map((source) => source.table_id).sort()).toEqual([
      ACTIVITY_VALUE_RECORDS_TABLE_ID,
      EXPERIMENT_RECORDS_TABLE_ID,
      PAPER_RECORDS_TABLE_ID,
      SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
    ]);
  });

  it("parses non-Gold paper tables through registered JSON parsers only", async () => {
    const bytes = await readFile(PAPER_FIXTURE);
    const sinks = await Promise.all(paperEvidenceTables.map((_, index) => parseTable(bytes, index)));
    expect(sinks.map((sink) => sink.result?.audit.accepted_row_count)).toEqual([1, 1, 2, 1]);
    expect(sinks.every((sink) => sink.rejected.length === 0)).toBe(true);
    expect(paperEvidenceTables.map((entry) => entry.definition.allow_empty)).toEqual([
      false, false, false, false,
    ]);

    await expect(parseTable(bytes, 0, "text/csv")).rejects.toThrow(/media type/);

    const wrongPointer = Buffer.from(JSON.stringify({ unknown_table: [] }), "utf8");
    await expect(parseTable(wrongPointer, 0)).rejects.toThrow(/rows_pointer does not resolve to an array/);
  });

  it("fails closed on hostile paper evidence", async () => {
    const rows = await loadPaperRows();
    const registeredAssets = new Set([PAPER_CARRIER_ASSET, SUPPLEMENT_ASSET]);
    expect(evaluatePaperEvidencePublication(rows, registeredAssets)).toMatchObject({
      publishable: true,
    });
    expect(() => assertPaperEvidenceRows(rows, registeredAssets)).not.toThrow();

    const missingPaperLink = clone(rows);
    missingPaperLink.experiment_records[0]!.paper_id = "paper_00000000000000000000000000000000";
    expect(evaluatePaperEvidencePublication(missingPaperLink, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/references missing paper/)}],
    });

    const missingExperimentLink = clone(rows);
    missingExperimentLink.activity_value_records[0]!.experiment_id = "exp_missing";
    expect(evaluatePaperEvidencePublication(missingExperimentLink, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/references missing experiment/)}],
    });

    const duplicateActivity = clone(rows);
    duplicateActivity.activity_value_records = [
      ...duplicateActivity.activity_value_records,
      clone(duplicateActivity.activity_value_records[0]!),
    ];
    expect(evaluatePaperEvidencePublication(duplicateActivity, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/duplicate activity value/) }],
    });

    const duplicateExperiment = clone(rows);
    duplicateExperiment.experiment_records = [
      ...duplicateExperiment.experiment_records,
      clone(duplicateExperiment.experiment_records[0]!),
    ];
    expect(evaluatePaperEvidencePublication(duplicateExperiment, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/duplicate experiment_id/) }],
    });

    const duplicatePaper = clone(rows);
    duplicatePaper.paper_records = [
      ...duplicatePaper.paper_records,
      clone(duplicatePaper.paper_records[0]!),
    ];
    expect(evaluatePaperEvidencePublication(duplicatePaper, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/duplicate paper identity/) }],
    });

    const unregisteredSupplement = clone(rows);
    const supplement = unregisteredSupplement.supplementary_asset_records[0]!;
    supplement.source_asset_id = UNREGISTERED_ASSET;
    supplement.source_locator = {
      ...supplement.source_locator,
      asset_id: UNREGISTERED_ASSET,
    };
    expect(evaluatePaperEvidencePublication(unregisteredSupplement, registeredAssets)).toMatchObject({
      publishable: false,
      checks: [{ detail: expect.stringMatching(/unregistered supplementary asset/) }],
    });

    // Blank raw relation / unit / original text never survive strict parsing.
    for (const field of ["relation", "activity_unit", "original_text"] as const) {
      const blank = clone(rows);
      (blank.activity_value_records[0] as unknown as Record<string, unknown>)[field] = "";
      const bytes = Buffer.from(JSON.stringify(blank), "utf8");
      await expect(parseTable(bytes, 2)).rejects.toThrow(/strict schema validation/);
    }
  });

  it("derives deterministic canonical identities from admitted paper evidence", async () => {
    const rows = await loadPaperRows();
    const derived = derivePaperCanonicalIdentities(rows);
    expect(derivePaperCanonicalIdentities(clone(rows))).toEqual(derived);
    expect(derived.activities).toHaveLength(2);
    expect(derived.compounds).toHaveLength(1);
    expect(derived.assays).toHaveLength(1);
    expect(derived.targets).toHaveLength(1);
    for (const activity of derived.activities) {
      expect(activity.activity_id).toMatch(/^act_[0-9a-f]{32}$/);
      expect(activity.compound_id).toMatch(/^cmp_[0-9a-f]{32}$/);
      expect(activity.assay_id).toMatch(/^asy_[0-9a-f]{32}$/);
      expect(activity.target_id).toMatch(/^tgt_[0-9a-f]{32}$/);
      expect(activity.raw_relation).toBe(activity.preserved_relation);
      expect(activity.raw_unit).toBe(activity.preserved_raw_unit);
      expect(activity.standardized_unit).toBe("nM");
    }
    const byRawValue = new Map(derived.activities.map((activity) => [activity.raw_value, activity]));
    expect(byRawValue.get("12.5")!.standardized_value).toBe(12.5);
    expect(byRawValue.get("0.5")!.standardized_value).toBe(500);
    expect(byRawValue.get("0.5")!.raw_unit).toBe("uM");
    expect(byRawValue.get("0.5")!.source_locator).toMatchObject({
      locator_type: "pdf_region",
      page_number: 6,
      row_label: "erlotinib",
    });
    const [firstId, secondId] = derived.activities.map((activity) => activity.activity_id);
    expect(firstId).not.toBe(secondId);

    // Identity components drive the digest; unrelated metadata does not.
    const unrelated = clone(rows);
    unrelated.paper_records[0]!.title = "A completely different title";
    expect(derivePaperCanonicalIdentities(unrelated).activities).toEqual(derived.activities);
    const renamed = clone(rows);
    renamed.activity_value_records[1]!.compound = "Erlotinib HCl";
    const renamedDerived = derivePaperCanonicalIdentities(renamed);
    expect(renamedDerived.activities[0]!.activity_id).toBe(firstId);
    expect(renamedDerived.activities[1]!.activity_id).not.toBe(secondId);

    // Derived identities merge into the canonical tables as valid rows.
    const base = await loadBioactivityRows();
    expect(() => assertBioactivityRows({
      activities: [...base.activities, ...derived.activities],
      compounds: [...base.compounds, ...derived.compounds],
      assays: [...base.assays, ...derived.assays],
      targets: [...base.targets, ...derived.targets],
    })).not.toThrow();
    const resolvable = new Set([
      ...base.activities.map((activity) => activity.activity_id),
      ...derived.activities.map((activity) => activity.activity_id),
    ]);
    expect(resolvable.has("ACT_NON_GOLD_1")).toBe(true);
    for (const activity of derived.activities) {
      expect(resolvable.has(activity.activity_id)).toBe(true);
    }
  });

  it("passes the generic B3 multi-table gate for the richer publication and fails when paper tables are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-evidence-b3-trusted-"));
    const forbidden = await mkdtemp(path.join(os.tmpdir(), "paper-evidence-b3-forbidden-"));
    try {
      await writeFile(path.join(root, "keep"), "trusted");
      const paperRows = await loadPaperRows();
      const chartRows = await loadChartRowsAlignedToPaperRecords();
      const bioactivityRows = await loadBioactivityRows();
      const allRows: Record<string, unknown> = {
        ...bioactivityRows,
        ...chartRows,
        ...paperRows,
      };
      const schemas = new Map<string, DatasetSchemaV2>();
      for (const entry of bioactivityTableEntries()) schemas.set(entry.tableId, entry.schema);
      for (const entry of chartEvidenceTables) schemas.set(entry.definition.table_id, entry.schema);
      for (const entry of paperEvidenceTables) schemas.set(entry.definition.table_id, entry.schema);
      const files: Array<{
        definition: import("@biomed/contracts").TableDefinition;
        schema: DatasetSchemaV2;
        file: { relativePath: string; bytes: Buffer };
        result: OperationResultManifest;
      }> = [];
      for (const [tableId, schema] of schemas) {
        const file = await csvFixture(root, tableId, schema, allRows);
        files.push({ definition: schemaToDefinition(tableId), schema, file, result: resultFor(tableId, schema, allRows, file) });
      }
      const request = candidateValidationRequest(root, files);
      request.forbidden_roots = [forbidden];
      const validation = await validatePaperEvidenceCandidate(
        request,
        paperRows,
        new Set([PAPER_CARRIER_ASSET, SUPPLEMENT_ASSET]),
      );
      expect(validation.passed).toBe(true);

      const incomplete = clone(request);
      incomplete.tables = incomplete.tables.filter(
        (table) => table.definition.table_id !== SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
      );
      incomplete.candidate.table_ids = incomplete.tables.map((table) => table.definition.table_id);
      await expect(validatePaperEvidenceCandidate(
        incomplete,
        paperRows,
        new Set([PAPER_CARRIER_ASSET, SUPPLEMENT_ASSET]),
      )).rejects.toThrow(/complete bioactivity, chart, and paper evidence table/);

      const drifted = clone(request);
      const paperTable = drifted.tables.find(
        (table) => table.definition.table_id === PAPER_RECORDS_TABLE_ID,
      );
      if (paperTable === undefined) throw new Error("missing paper_records validation table");
      paperTable.provenance_refs = [];
      expect((await validatePaperEvidenceCandidate(
        drifted,
        paperRows,
        new Set([PAPER_CARRIER_ASSET, SUPPLEMENT_ASSET]),
      )).passed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(forbidden, { recursive: true, force: true });
    }
  });
});

function schemaToDefinition(
  tableId: string,
): import("@biomed/contracts").TableDefinition {
  const entry = [
    ...bioactivityTableEntries().map((item) => ({ tableId: item.tableId, definition: item.definition })),
    ...chartEvidenceTables.map((item) => ({ tableId: item.definition.table_id, definition: item.definition })),
    ...paperEvidenceTables.map((item) => ({ tableId: item.definition.table_id, definition: item.definition })),
  ].find((item) => item.tableId === tableId);
  if (entry === undefined) throw new Error(`no definition for ${tableId}`);
  return entry.definition;
}

function candidateValidationRequest(
  root: string,
  tables: readonly {
    definition: import("@biomed/contracts").TableDefinition;
    schema: DatasetSchemaV2;
    file: { relativePath: string; bytes: Buffer };
    result: OperationResultManifest;
  }[],
): MultiTableValidationRequest {
  const allTableIds = tables.map((table) => table.definition.table_id);
  const allRelationIds = [
    ...bioactivityRelations,
    ...chartEvidenceRelations,
    ...paperEvidenceRelations,
  ].map((relation) => relation.relation_id);
  return {
    task_id: "task_paper",
    requirement_id: "build_paper",
    candidate: {
      candidate_id: "candidate_paper_validation",
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
      ...paperEvidenceRelations,
    ],
    trusted_root: root,
    forbidden_roots: [],
    policy: paperEvidenceValidationPolicy(),
  };
}
