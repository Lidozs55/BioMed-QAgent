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
  assembleVariantEvidenceCandidate,
  assertVariantAssertion,
  assertVariantEvidence,
  assertVariantEvidenceRows,
  buildVariantEvidenceTables,
  createVariantEvidenceAssemblerCapability,
  createVariantEvidenceRegisteredTableRegistry,
  VARIANT_EVIDENCE_ROW_GRANULARITY,
  type VariantAssertionEvidenceInput,
  type VariantEvidenceRecordInput,
  type VariantEvidenceSourceInput,
} from "../../src/dataset/families/variant-evidence/index.js";
import { createDefaultDatasetFamilyRegistry } from "../../src/dataset/families/index.js";
import { validateMultiTableCandidate } from "../../src/dataset/validation/multitable.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const DIGEST = "c".repeat(64);
const ASSET_ID = `asset_${"a".repeat(64)}`;
const tempRoots: string[] = [];

interface FixtureDocument {
  assertions: VariantAssertionEvidenceInput[];
  evidence: VariantEvidenceRecordInput[];
  sources: VariantEvidenceSourceInput[];
}

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

async function loadFixture(name: string): Promise<{ bytes: Buffer; document: FixtureDocument }> {
  const bytes = await readFile(path.join(FIXTURES, name));
  return { bytes, document: JSON.parse(bytes.toString("utf8")) as FixtureDocument };
}

function registrationReceipt(bytes: Buffer): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_variant_fixture",
    task_id: "task_variant",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_variant",
      role: "source",
    },
    source_id: "fixture_variant_source",
    relative_path: "source_assets/non-gold.variant.json",
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

async function parseRegisteredTable(
  bytes: Buffer,
  adapterId: string,
  schemaRef: string,
): Promise<MemorySink> {
  const receipt = registrationReceipt(bytes);
  const sink = new MemorySink();
  await new RegisteredTableAdapter(createVariantEvidenceRegisteredTableRegistry()).parse({
    schema_version: "1.0",
    task_id: "task_variant",
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
  const text = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv<T extends object>(
  root: string,
  name: string,
  header: readonly string[],
  rows: readonly T[],
): Promise<void> {
  const content = [header.join(","), ...rows.map((row) => header.map((field) => csvCell(Reflect.get(row, field))).join(","))].join("\n") + "\n";
  await writeFile(path.join(root, name), content);
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
  const dataRows = bytes.toString("utf8").trimEnd().split("\n").length - 1;
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_variant",
    build_id: "build_variant",
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
      dataset_family: "variant_evidence",
      row_granularity: schema.row_granularity,
      schema_ref: schema.schema_id,
      row_count: dataRows,
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

async function prepareValidation(document: FixtureDocument) {
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "variant-evidence-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "variant-evidence-workspace-"));
  tempRoots.push(trustedRoot, forbiddenRoot);
  const schemas = buildVariantEvidenceTables();
  await writeCsv(trustedRoot, "variant_assertions.csv", schemas.variantTable.field_names, document.assertions);
  await writeCsv(trustedRoot, "evidence.csv", schemas.evidenceTable.field_names, document.evidence);
  await writeCsv(trustedRoot, "sources.csv", schemas.sourceTable.field_names, document.sources);
  const primary = await resultFor(trustedRoot, "variant_assertions", "variant_assertions.csv", schemas.variant);
  const evidence = await resultFor(trustedRoot, "evidence", "evidence.csv", schemas.evidence);
  const source = await resultFor(trustedRoot, "sources", "sources.csv", schemas.source);
  const tables = [
    await validationTable(schemas.variantTable, schemas.variant, "variant_assertions.csv", primary),
    await validationTable(schemas.evidenceTable, schemas.evidence, "evidence.csv", evidence),
    await validationTable(schemas.sourceTable, schemas.source, "sources.csv", source),
  ];
  return { trustedRoot, forbiddenRoot, schemas, primary, evidence, source, tables };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("variant_evidence B-owned module slice", () => {
  it("parses and validates a non-Gold multi-table candidate through B4, assembly, and B3", async () => {
    const { bytes, document } = await loadFixture("non-gold.valid.json");
    const schemas = buildVariantEvidenceTables();
    const parsedAssertions = await parseRegisteredTable(bytes, "registered_variant_assertion_json", schemas.variant.schema_id);
    const parsedEvidence = await parseRegisteredTable(bytes, "registered_variant_evidence_json", schemas.evidence.schema_id);
    const parsedSources = await parseRegisteredTable(bytes, "registered_variant_source_json", schemas.source.schema_id);

    expect(parsedAssertions.committed?.audit.accepted_row_count).toBe(1);
    expect(parsedEvidence.rows[0]?.locators.source_locator).toMatchObject({
      locator_version: "2.0",
      locator_type: "json_pointer",
      json_pointer: "/evidence/0/source_locator",
    });
    expect(parsedSources.committed?.audit.status).toBe("accepted");
    assertVariantEvidenceRows(document, schemas);

    const prepared = await prepareValidation(document);
    const capability = createVariantEvidenceAssemblerCapability();
    const candidate = capability.assemble({
      taskId: "task_variant",
      buildId: "build_variant",
      datasetFamily: "variant_evidence",
      rowGranularity: VARIANT_EVIDENCE_ROW_GRANULARITY,
      schema: prepared.schemas.variant,
      integrationResult: prepared.primary,
      evidenceResult: prepared.evidence,
      sourceResult: prepared.source,
      registeredAssetIds: [ASSET_ID],
      rows: document,
    });
    expect(candidate.tables.map((table) => table.definition.table_id)).toEqual([
      "variant_assertions", "evidence", "sources",
    ]);
    expect(candidate.relations.map((relation) => relation.missing_policy)).toEqual([
      "reject", "reject", "reject",
    ]);
    expect(candidate.registered_asset_ids).toEqual([ASSET_ID]);

    const validation = await validateMultiTableCandidate({
      task_id: "task_variant",
      build_id: "build_variant",
      candidate: {
        candidate_id: candidate.candidate_id,
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
    expect(validation.passed).toBe(true);
    expect(validation.checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("fails closed for missing reference, locator, and conflict evidence", async () => {
    const { document } = await loadFixture("non-gold.valid.json");
    const assertion = document.assertions[0]!;
    const evidence = document.evidence[0]!;

    expect(() => assertVariantAssertion({ ...assertion, reference_version: "" })).toThrow(/reference_version is required/);
    expect(() => assertVariantEvidence({
      ...evidence,
      source_locator: { ...evidence.source_locator, locator_version: "1.0" } as unknown as VariantEvidenceRecordInput["source_locator"],
    })).toThrow(/SourceLocator 2.0/);
    expect(() => assertVariantAssertion({
      ...assertion,
      conflict_status: "conflict",
      conflict_evidence: null,
    })).toThrow(/conflict_evidence must be an object/);
    expect(() => assertVariantAssertion({
      ...assertion,
      conflict_status: "conflict",
      conflict_policy: "retain_conflict_and_block_primary",
      conflict_evidence: { claims: ["asserted", "refuted"] },
    })).toThrow(/blocked from the primary table/);
  });

  it("fails closed on assertion/evidence/source foreign keys", async () => {
    const { document } = await loadFixture("non-gold.bad-fk.json");
    expect(() => assertVariantEvidenceRows(document)).toThrow(/references missing assertion_id/);

    const prepared = await prepareValidation(document);
    const validation = await validateMultiTableCandidate({
      task_id: "task_variant",
      build_id: "build_variant",
      candidate: {
        candidate_id: "candidate_bad_fk",
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
      check_id: "foreign_key",
      scope: "variant_assertion_evidence",
      passed: false,
    }));
  });

  it("registers the trusted module in both production default registries", () => {
    expect(createDefaultDatasetFamilyRegistry().list()).toContain("variant_evidence");
    expect(createDefaultDatasetFamilyRegistry().get("variant_evidence")).toMatchObject({
      runtime_id: "registered_multitable.runtime.v1",
    });
    expect(createVariantEvidenceAssemblerCapability()).toMatchObject({
      familyId: "variant_evidence",
      handlerId: "variant_evidence.assembler.v1",
    });
  });

  it("rejects assembly when table summaries or registered dependencies are incomplete", async () => {
    const { document } = await loadFixture("non-gold.valid.json");
    const prepared = await prepareValidation(document);
    const missingReference = {
      ...prepared.primary,
      output_summary: { ...prepared.primary.output_summary, row_count: 0 },
    };
    const input = {
      taskId: "task_variant",
      buildId: "build_variant",
      datasetFamily: "variant_evidence",
      rowGranularity: VARIANT_EVIDENCE_ROW_GRANULARITY,
      schema: prepared.schemas.variant,
      integrationResult: missingReference,
      evidenceResult: prepared.evidence,
      sourceResult: prepared.source,
      registeredAssetIds: [ASSET_ID],
      rows: document,
    } as const;
    expect(() => assembleVariantEvidenceCandidate(input)).toThrow(/must not be empty/);
    expect(() => assembleVariantEvidenceCandidate({
      ...input,
      integrationResult: prepared.primary,
      registeredAssetIds: [],
    })).toThrow(/exactly match.*dependency closures/);
  });
});
