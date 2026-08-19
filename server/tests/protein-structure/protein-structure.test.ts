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
} from "../../src/dataset/adapters/registered/index.js";
import type { MultiTableValidationTable } from "../../src/dataset/contracts/index.js";
import {
  PROTEIN_STRUCTURE_ASSEMBLER_ID,
  PROTEIN_STRUCTURE_FAMILY_ID,
  PROTEIN_STRUCTURE_ROW_GRANULARITY,
  assertProteinStructureRelations,
  assertProteinStructureRows,
  assembleProteinStructureCandidate,
  buildProteinStructureTables,
  createProteinStructureRegisteredTableRegistry,
  type ProteinStructureRows,
  validateProteinStructureCandidate,
} from "../../src/dataset/families/protein-structure/index.js";
import { createDefaultDatasetFamilyRegistry } from "../../src/dataset/families/index.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "protein-structure");
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

async function loadFixture(name: string): Promise<ProteinStructureRows> {
  const bytes = await readFile(path.join(FIXTURES, name));
  return JSON.parse(bytes.toString("utf8")) as ProteinStructureRows;
}

function registrationReceipt(bytes: Buffer): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_pdb_fixture",
    task_id: "task_structure",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_structure",
      role: "source",
    },
    source_id: "source_pdb_1",
    relative_path: "source_assets/pdb/non-gold.structure.json",
    sha256,
    size_bytes: bytes.length,
    media_type: "application/json",
    registered_at: "2024-02-01T00:00:00Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
  };
}

async function parseRegisteredTable(
  bytes: Buffer,
  adapterId: string,
  schemaRef: string,
): Promise<MemorySink> {
  const receipt = registrationReceipt(bytes);
  const sink = new MemorySink();
  await new RegisteredTableAdapter(createProteinStructureRegisteredTableRegistry()).parse({
    schema_version: "1.0",
    task_id: "task_structure",
    asset_id: receipt.asset_ref.asset_id,
    schema_ref: schemaRef,
    adapter_id: adapterId,
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

async function writeCsv<T extends object>(
  root: string,
  fileName: string,
  schema: DatasetSchemaV2,
  rows: readonly T[],
): Promise<void> {
  const fields = schema.fields.map((field) => field.name);
  const content = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvCell(Reflect.get(row, field))).join(",")),
  ].join("\n") + "\n";
  await writeFile(path.join(root, fileName), content);
}

function digestFor(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function resultFor(
  root: string,
  tableId: string,
  fileName: string,
  schema: DatasetSchemaV2,
  operationId: string,
  inputAssetIds: readonly string[] = [ASSET_ID],
): Promise<OperationResultManifest> {
  const bytes = await readFile(path.join(root, fileName));
  const fileStat = await stat(path.join(root, fileName));
  const sha256 = digestFor(bytes.toString("utf8"));
  const rowCount = Math.max(0, bytes.toString("utf8").trimEnd().split("\n").length - 1);
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${operationId}`,
    task_id: "task_structure",
    build_id: "build_structure",
    operation_id: operationId,
    operation_kind: operationId.startsWith("integrate_") ? "integrate" : "validate_profile",
    operation_attempt_id: `attempt_${operationId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: sha256,
    output_kind: operationId.startsWith("integrate_") ? "integrated_table" : "validation_result",
    output_summary: operationId.startsWith("integrate_") ? {
      table_id: tableId,
      dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
      row_granularity: schema.row_granularity,
      schema_ref: schema.schema_id,
      row_count: rowCount,
      column_count: schema.fields.length,
      primary_file_sha256: sha256,
    } : {},
    output_files: [{ relative_path: fileName, size_bytes: fileStat.size, sha256 }],
    dependency_closure: {
      input_asset_ids: [...inputAssetIds],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationId}`,
      committed_at: "2024-02-01T00:00:00Z",
    },
    migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
  };
}

async function validationTable(
  definition: TableDefinition,
  schema: DatasetSchemaV2,
  fileName: string,
  result: OperationResultManifest,
  tableId: string,
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
    provenance_refs: [`prov_${tableId}`],
    confidence_refs: [`conf_${tableId}`],
  };
}

async function prepare(rows: ProteinStructureRows) {
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "protein-structure-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "protein-structure-workspace-"));
  tempRoots.push(trustedRoot, forbiddenRoot);
  const schemas = buildProteinStructureTables();
  const tableRows: {
    tableId: string;
    schema: DatasetSchemaV2;
    definition: TableDefinition;
    fileName: string;
    rows: readonly object[];
  }[] = [
    { tableId: "structures", schema: schemas.structure, definition: schemas.structureTable, fileName: "structures.csv", rows: rows.structures },
    { tableId: "chains", schema: schemas.chain, definition: schemas.chainTable, fileName: "chains.csv", rows: rows.chains },
    { tableId: "ligands", schema: schemas.ligand, definition: schemas.ligandTable, fileName: "ligands.csv", rows: rows.ligands },
    { tableId: "sources", schema: schemas.source, definition: schemas.sourceTable, fileName: "sources.csv", rows: rows.sources },
  ];
  const results: OperationResultManifest[] = [];
  const tables: MultiTableValidationTable[] = [];
  for (const { tableId, schema, definition, fileName, rows: tableRowsForFile } of tableRows) {
    await writeCsv(trustedRoot, fileName, schema, tableRowsForFile);
    const result = await resultFor(trustedRoot, tableId, fileName, schema, `integrate_${tableId}`);
    results.push(result);
    tables.push(await validationTable(definition, schema, fileName, result, tableId));
  }
  for (const table of tables) {
    table.provenance_refs.push(`prov_result_${table.definition.table_id}`);
    table.confidence_refs.push(`conf_result_${table.definition.table_id}`);
  }
  return { trustedRoot, forbiddenRoot, schemas, results, tables };
}

async function assemble(rows: ProteinStructureRows) {
  const prepared = await prepare(rows);
  const tableIds = ["structures", "chains", "ligands", "sources"] as const;
  const candidate = assembleProteinStructureCandidate({
    taskId: "task_structure",
    buildId: "build_structure",
    datasetFamily: PROTEIN_STRUCTURE_FAMILY_ID,
    rowGranularity: PROTEIN_STRUCTURE_ROW_GRANULARITY,
    tables: prepared.results.map((result, index) => ({
      tableId: tableIds[index]!,
      result,
      provenanceResults: [result],
      confidenceResults: [result],
    })),
    registeredAssetIds: [ASSET_ID],
    rows,
  });
  return { ...prepared, candidate };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protein_structure B-owned module slice", () => {
  it("parses PDB source records and validates a non-Gold related multi-table candidate", async () => {
    const bytes = await readFile(path.join(FIXTURES, "non-gold.valid.json"));
    const rows = JSON.parse(bytes.toString("utf8")) as ProteinStructureRows;
    const schemas = buildProteinStructureTables();
    const parsedStructure = await parseRegisteredTable(bytes, "registered_protein_structure_json", schemas.structure.schema_id);
    const parsedChain = await parseRegisteredTable(bytes, "registered_protein_structure_chain_json", schemas.chain.schema_id);
    const parsedLigand = await parseRegisteredTable(bytes, "registered_protein_structure_ligand_json", schemas.ligand.schema_id);
    const parsedSource = await parseRegisteredTable(bytes, "registered_protein_structure_source_json", schemas.source.schema_id);

    expect(parsedStructure.committed?.audit.accepted_row_count).toBe(1);
    expect(parsedChain.rows[0]?.locators.source_locator).toMatchObject({
      locator_version: "2.0",
      locator_type: "json_pointer",
      json_pointer: "/chains/0/source_locator",
    });
    expect(parsedChain.rows[0]?.values.source_locator).toMatchObject({
      locator_version: "2.0",
      locator_type: "json_pointer",
      json_pointer: "/chains/0/chain_id",
    });
    expect(parsedLigand.committed?.audit.status).toBe("accepted");
    expect(parsedSource.committed?.audit.source_id).toBe("source_pdb_1");

    const prepared = await assemble(rows);
    expect(prepared.candidate).toMatchObject({
      dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
      row_granularity: PROTEIN_STRUCTURE_ROW_GRANULARITY,
      registered_asset_ids: [ASSET_ID],
    });
    expect(prepared.candidate.tables.map((table) => table.definition.table_id)).toEqual([
      "structures", "chains", "ligands", "sources",
    ]);
    expect(prepared.candidate.tables[0]?.definition.role).toBe("primary");
    expect(prepared.candidate.relations.map((relation) => relation.relation_id)).toEqual([
      "chain_structure", "ligand_structure", "structure_source", "chain_source", "ligand_source",
    ]);

    const candidateRefs = {
      candidate_id: prepared.candidate.candidate_id,
      table_ids: prepared.tables.map((table) => table.definition.table_id),
      relation_ids: prepared.schemas.relations.map((relation) => relation.relation_id),
      provenance_refs: prepared.tables.flatMap((table) => table.provenance_refs),
      confidence_refs: prepared.tables.flatMap((table) => table.confidence_refs),
      audit_refs: [],
    };
    const validation = await validateProteinStructureCandidate({
      task_id: "task_structure",
      build_id: "build_structure",
      candidate: candidateRefs,
      tables: prepared.tables,
      relations: [...prepared.schemas.relations],
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: { token_preservation_rules: [], profile_relation_missing_policies: {} },
    });
    expect(validation.passed).toBe(true);
    expect(validation.checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("fails closed for missing structure relations, locators, and provenance", async () => {
    const valid = await loadFixture("non-gold.valid.json");
    expect(() => assertProteinStructureRelations([])).toThrow(/all structure, chain, ligand/);
    expect(() => assertProteinStructureRows({
      ...valid,
      structures: [{ ...valid.structures[0]!, source_locator: undefined }],
    } as unknown as ProteinStructureRows)).toThrow(/source_locator/);

    const prepared = await assemble(valid);
    await expect(validateProteinStructureCandidate({
      task_id: "task_structure",
      build_id: "build_structure",
      candidate: {
        candidate_id: prepared.candidate.candidate_id,
        table_ids: prepared.tables.map((table) => table.definition.table_id),
        relation_ids: prepared.schemas.relations.slice(1).map((relation) => relation.relation_id),
        provenance_refs: prepared.tables.flatMap((table) => table.provenance_refs),
        confidence_refs: prepared.tables.flatMap((table) => table.confidence_refs),
        audit_refs: [],
      },
      tables: prepared.tables,
      relations: prepared.schemas.relations.slice(1),
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: { token_preservation_rules: [], profile_relation_missing_policies: {} },
    })).rejects.toThrow(/all structure, chain, ligand/);

    prepared.tables[0]!.provenance_refs = [];
    const validation = await validateProteinStructureCandidate({
      task_id: "task_structure",
      build_id: "build_structure",
      candidate: {
        candidate_id: prepared.candidate.candidate_id,
        table_ids: prepared.tables.map((table) => table.definition.table_id),
        relation_ids: prepared.schemas.relations.map((relation) => relation.relation_id),
        provenance_refs: prepared.tables.flatMap((table) => table.provenance_refs),
        confidence_refs: prepared.tables.flatMap((table) => table.confidence_refs),
        audit_refs: [],
      },
      tables: prepared.tables,
      relations: [...prepared.schemas.relations],
      trusted_root: prepared.trustedRoot,
      forbidden_roots: [prepared.forbiddenRoot],
      policy: { token_preservation_rules: [], profile_relation_missing_policies: {} },
    });
    expect(validation.passed).toBe(false);
    expect(validation.checks).toContainEqual(expect.objectContaining({
      check_id: "table_provenance_refs",
      scope: "structures",
      passed: false,
    }));
  });

  it("rejects broken structure foreign keys and keeps the family out of production registries", async () => {
    const invalid = await loadFixture("non-gold.bad-relation.json");
    expect(() => assertProteinStructureRows(invalid)).toThrow(/missing structure version/);
    expect(createDefaultDatasetFamilyRegistry().list()).toContain(PROTEIN_STRUCTURE_FAMILY_ID);
    expect(createDefaultDatasetFamilyRegistry().get(PROTEIN_STRUCTURE_FAMILY_ID)).toMatchObject({
      runtime_id: "registered_multitable.runtime.v1",
    });
    expect(PROTEIN_STRUCTURE_ASSEMBLER_ID).toBe("protein_structure.assembler.v1");
  });
});
