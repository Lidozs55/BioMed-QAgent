import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  SourceAssetRegistrationReceipt,
  TableDefinition,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  RegisteredTableAdapter,
  type RegisteredTableAdapterResult,
  type RegisteredTableAudit,
  type RegisteredTableRejectedRow,
  type RegisteredTableRow,
  type RegisteredTableSink,
} from "../src/dataset/adapters/registered/index.js";
import type { MultiTableValidationTable } from "../src/dataset/contracts/index.js";
import {
  BIOACTIVITY_ASSEMBLER_ID,
  BIOACTIVITY_FAMILY_ID,
  BIOACTIVITY_ROW_GRANULARITY,
  assertBioactivityRows,
  assembleBioactivityCandidate,
  bioactivityRelations,
  bioactivityTableEntries,
  bioactivityValidationPolicy,
  createBioactivityRegisteredTableRegistry,
  transformChemblRegisteredAssets,
  type BioactivityRows,
  validateBioactivityCandidate,
} from "../src/dataset/families/bioactivity-measurement/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "bioactivity-measurement");
const DIGEST = "c".repeat(64);
const ASSET_ID = `asset_${"a".repeat(64)}`;
const tempRoots: string[] = [];

class MemorySink implements RegisteredTableSink {
  readonly rows: RegisteredTableRow[] = [];
  readonly rejected: RegisteredTableRejectedRow[] = [];
  committed: RegisteredTableAdapterResult | null = null;
  rolledBack: RegisteredTableAudit | null = null;

  writeRow(row: RegisteredTableRow): void { this.rows.push(row); }
  writeRejectedRow(row: RegisteredTableRejectedRow): void { this.rejected.push(row); }
  commit(result: RegisteredTableAdapterResult): void { this.committed = result; }
  rollback(audit: RegisteredTableAudit): void {
    this.rolledBack = audit;
    this.rows.length = 0;
    this.rejected.length = 0;
  }
}

async function loadFixture(name: string): Promise<BioactivityRows> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as BioactivityRows;
}

function registrationReceipt(bytes: Buffer): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_bioactivity_fixture",
    task_id: "task_bioactivity",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_bioactivity",
      role: "source",
    },
    source_id: "source_chembl_activity_1",
    relative_path: "source_assets/chembl/non-gold.valid.json",
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

async function parseRegistered(
  bytes: Buffer,
  tableId: string,
  schemaRef: string,
): Promise<MemorySink> {
  const receipt = registrationReceipt(bytes);
  const sink = new MemorySink();
  await new RegisteredTableAdapter(createBioactivityRegisteredTableRegistry()).parse({
    schema_version: "1.0",
    task_id: "task_bioactivity",
    asset_id: receipt.asset_ref.asset_id,
    schema_ref: schemaRef,
    adapter_id: `registered_bioactivity_${tableId}_json`,
    parser_version: "1_0_0",
  }, {
    registration_receipt: receipt,
    content: (async function* () { yield bytes; })(),
  }, sink);
  return sink;
}

function csvCell(value: unknown): string {
  const text = value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(
  root: string,
  fileName: string,
  schema: DatasetSchemaV2,
  rows: readonly object[],
): Promise<void> {
  const fields = schema.fields.map((field) => field.name);
  const content = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvCell(Reflect.get(row, field))).join(",")),
  ].join("\n") + "\n";
  await writeFile(path.join(root, fileName), content);
}

async function resultFor(
  root: string,
  tableId: string,
  fileName: string,
  schema: DatasetSchemaV2,
): Promise<OperationResultManifest> {
  const bytes = await readFile(path.join(root, fileName));
  const fileStat = await stat(path.join(root, fileName));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const rowCount = Math.max(0, bytes.toString("utf8").trimEnd().split("\n").length - 1);
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_bioactivity",
    build_id: "build_bioactivity",
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
      row_count: rowCount,
      column_count: schema.fields.length,
      primary_file_sha256: sha256,
    },
    output_files: [{ relative_path: fileName, size_bytes: fileStat.size, sha256 }],
    dependency_closure: {
      input_asset_ids: [ASSET_ID],
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

async function validationTable(
  definition: TableDefinition,
  schema: DatasetSchemaV2,
  fileName: string,
  result: OperationResultManifest,
): Promise<MultiTableValidationTable> {
  return {
    definition,
    schema,
    file: {
      origin: "core_operation_result",
      relative_path: fileName,
      delimiter: ",",
      operation_result: result,
    },
    provenance_refs: [`prov_${definition.table_id}`],
    confidence_refs: [`conf_${definition.table_id}`],
  };
}

async function prepare(rows: BioactivityRows) {
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "bioactivity-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "bioactivity-workspace-"));
  tempRoots.push(trustedRoot, forbiddenRoot);
  const rowSets: Record<string, readonly object[]> = {
    activities: rows.activities,
    compounds: rows.compounds,
    assays: rows.assays,
    targets: rows.targets,
  };
  const results: OperationResultManifest[] = [];
  const tables: MultiTableValidationTable[] = [];
  for (const entry of bioactivityTableEntries()) {
    const fileName = `${entry.tableId}.csv`;
    await writeCsv(trustedRoot, fileName, entry.schema, rowSets[entry.tableId]!);
    const result = await resultFor(trustedRoot, entry.tableId, fileName, entry.schema);
    results.push(result);
    tables.push(await validationTable(entry.definition, entry.schema, fileName, result));
  }
  return { trustedRoot, forbiddenRoot, results, tables };
}

function candidateRefs(tables: readonly MultiTableValidationTable[]) {
  return {
    candidate_id: "candidate_bioactivity_validation",
    table_ids: tables.map((table) => table.definition.table_id),
    relation_ids: bioactivityRelations.map((relation) => relation.relation_id),
    provenance_refs: tables.flatMap((table) => table.provenance_refs),
    confidence_refs: tables.flatMap((table) => table.confidence_refs),
    audit_refs: [],
  };
}

function failedChecks(result: Awaited<ReturnType<typeof validateBioactivityCandidate>>): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => `${check.scope}:${check.check_id}`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bioactivity_measurement B5A module", () => {
  it("deterministically transforms registered ChEMBL API carriers", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(FIXTURES, "non-gold.chembl-provider.json"), "utf8"),
    ) as Record<"activity" | "assay" | "target", unknown>;
    const rows = transformChemblRegisteredAssets([
      {
        kind: "activity",
        source_id: "source_chembl_provider",
        source_asset_id: ASSET_ID,
        logical_file: "source_assets/chembl/activities.json",
        document: fixture.activity,
      },
      {
        kind: "assay",
        source_id: "source_chembl_provider",
        source_asset_id: `asset_${"b".repeat(64)}`,
        logical_file: "source_assets/chembl/assays.json",
        document: fixture.assay,
      },
      {
        kind: "target",
        source_id: "source_chembl_provider",
        source_asset_id: `asset_${"c".repeat(64)}`,
        logical_file: "source_assets/chembl/targets.json",
        document: fixture.target,
      },
    ]);

    expect(() => assertBioactivityRows(rows)).not.toThrow();
    expect(rows.activities[0]).toMatchObject({
      activity_id: "CHEMBL_ACTIVITY_918273",
      raw_value: "0.25",
      raw_relation: ">",
      raw_unit: "uM",
      standardized_value: 250,
      standardized_unit: "nM",
      compound_id: "CHEMBL120",
      assay_id: "CHEMBL_A918",
      target_id: "CHEMBL_T918",
      source_asset_id: ASSET_ID,
    });
    expect(rows.activities[0]!.source_locator).toMatchObject({
      asset_id: ASSET_ID,
      json_pointer: "/activities/0",
    });
    expect(rows.compounds).toHaveLength(1);
    expect(rows.assays).toHaveLength(1);
    expect(rows.targets).toHaveLength(1);
  });

  it("fails closed on an unknown ChEMBL response structure", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(FIXTURES, "non-gold.chembl-provider.json"), "utf8"),
    ) as Record<"activity" | "assay" | "target", unknown>;
    expect(() => transformChemblRegisteredAssets([
      {
        kind: "activity",
        source_id: "source_chembl_provider",
        source_asset_id: ASSET_ID,
        logical_file: "source_assets/chembl/activities.json",
        document: { records: [] },
      },
      {
        kind: "assay",
        source_id: "source_chembl_provider",
        source_asset_id: `asset_${"b".repeat(64)}`,
        logical_file: "source_assets/chembl/assays.json",
        document: fixture.assay,
      },
      {
        kind: "target",
        source_id: "source_chembl_provider",
        source_asset_id: `asset_${"c".repeat(64)}`,
        logical_file: "source_assets/chembl/targets.json",
        document: fixture.target,
      },
    ])).toThrow(/unknown top-level fields/);
  });

  it("parses and publishes a non-Gold activity fact with compound, assay, and target support", async () => {
    const bytes = await readFile(path.join(FIXTURES, "non-gold.valid.json"));
    const rows = JSON.parse(bytes.toString("utf8")) as BioactivityRows;
    expect(() => assertBioactivityRows(rows)).not.toThrow();

    const parsed = await Promise.all(bioactivityTableEntries().map((entry) =>
      parseRegistered(bytes, entry.tableId, entry.schema.schema_id),
    ));
    expect(parsed.map((sink) => sink.committed?.audit.accepted_row_count)).toEqual([3, 1, 1, 1]);
    expect(parsed[0]!.rows.map((row) => row.values.raw_relation)).toEqual(["<", ">", "="]);
    expect(parsed[0]!.rows[1]!.values).toMatchObject({
      raw_value: "1.0",
      raw_unit: "uM",
      preserved_raw_unit: "uM",
      standardized_value: 1000,
      standardized_unit: "nM",
    });

    const prepared = await prepare(rows);
    const candidate = assembleBioactivityCandidate({
      taskId: "task_bioactivity",
      buildId: "build_bioactivity",
      datasetFamily: BIOACTIVITY_FAMILY_ID,
      rowGranularity: BIOACTIVITY_ROW_GRANULARITY,
      tables: bioactivityTableEntries().map((entry, index) => ({
        tableId: entry.tableId,
        result: prepared.results[index]!,
        provenanceResults: [prepared.results[index]!],
        confidenceResults: [prepared.results[index]!],
      })),
      registeredAssetIds: [ASSET_ID],
      rows,
    });
    expect(candidate.tables.map((table) => [table.definition.table_id, table.definition.role])).toEqual([
      ["activities", "primary"],
      ["compounds", "supporting"],
      ["assays", "supporting"],
      ["targets", "supporting"],
    ]);
    expect(candidate.registered_asset_ids).toEqual([ASSET_ID]);
    expect(candidate.relations.map((relation) => relation.relation_id)).toEqual([
      "activity_compound", "activity_assay", "activity_target", "assay_target",
    ]);

    const validation = await validateBioactivityCandidate({
      task_id: "task_bioactivity",
      build_id: "build_bioactivity",
      candidate: candidateRefs(prepared.tables),
      tables: prepared.tables,
      relations: [...bioactivityRelations],
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: bioactivityValidationPolicy(),
    });
    expect(validation.passed).toBe(true);
    expect(failedChecks(validation)).toEqual([]);
  });

  it("fails closed on changed tokens, foreign keys, locator provenance, and missing table provenance", async () => {
    const invalid = await loadFixture("non-gold.bad-fk-token.json");
    expect(() => assertBioactivityRows(invalid)).toThrow(/changed the raw relation token/);

    const valid = await loadFixture("non-gold.valid.json");
    expect(() => assertBioactivityRows({
      ...valid,
      activities: [{
        ...valid.activities[0]!,
        source_locator: invalid.activities[0]!.source_locator,
      }],
    })).toThrow(/locator does not match source_asset_id/);
    expect(() => assertBioactivityRows({
      ...valid,
      compounds: [{ ...valid.compounds[0]!, source_id: "source_unregistered" }],
    })).toThrow(/unprovenanced source_id/);

    const prepared = await prepare(invalid);
    const rejected = await validateBioactivityCandidate({
      task_id: "task_bioactivity",
      build_id: "build_bioactivity",
      candidate: candidateRefs(prepared.tables),
      tables: prepared.tables,
      relations: [...bioactivityRelations],
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: bioactivityValidationPolicy(),
    });
    expect(failedChecks(rejected)).toEqual(expect.arrayContaining([
      "activities:token_preservation",
      "activity_compound:foreign_key",
    ]));

    const validPrepared = await prepare(valid);
    validPrepared.tables[0]!.provenance_refs = [];
    const missingProvenance = await validateBioactivityCandidate({
      task_id: "task_bioactivity",
      build_id: "build_bioactivity",
      candidate: candidateRefs(validPrepared.tables),
      tables: validPrepared.tables,
      relations: [...bioactivityRelations],
      trusted_root: validPrepared.trustedRoot,
      forbidden_roots: [validPrepared.forbiddenRoot],
      policy: bioactivityValidationPolicy(),
    });
    expect(failedChecks(missingProvenance)).toContain("activities:table_provenance_refs");
  });

  it("rejects incomplete contracts and remains absent from production registration", async () => {
    const rows = await loadFixture("non-gold.valid.json");
    const prepared = await prepare(rows);
    await expect(validateBioactivityCandidate({
      task_id: "task_bioactivity",
      build_id: "build_bioactivity",
      candidate: candidateRefs(prepared.tables.slice(0, 3)),
      tables: prepared.tables.slice(0, 3),
      relations: bioactivityRelations.slice(0, 2),
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: bioactivityValidationPolicy(),
    })).rejects.toThrow(/activities, compounds, assays, and targets/);

    const registry = createDefaultDatasetFamilyRegistry();
    expect(registry.list()).toContain(BIOACTIVITY_FAMILY_ID);
    expect(registry.get(BIOACTIVITY_FAMILY_ID)).toMatchObject({
      runtime_id: "registered_multitable.runtime.v1",
      default_normalization_profile_ref: "bioactivity_measurement.registered.v1",
    });
    expect(BIOACTIVITY_ASSEMBLER_ID).toBe("bioactivity_measurement.assembler.v1");
  });
});
