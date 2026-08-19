import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OperationResultManifest } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  assembleTargetEvidenceCandidate,
  assertTargetEvidenceRows,
  createTargetEvidenceRegisteredTableRegistry,
  expandTargetEvidenceJsonCarriers,
  targetEvidenceRelations,
  targetEvidenceSchemas,
  targetEvidenceTableDefinitions,
  targetEvidenceValidationPolicy,
  TARGET_EVIDENCE_ROW_GRANULARITY,
  type TargetEvidenceRows,
} from "../src/dataset/families/target-evidence/index.js";
import { delimitedRowsWithLines } from "../src/dataset/adapters/text.js";
import type {
  MultiTableValidationRequest,
  MultiTableValidationTable,
} from "../src/dataset/contracts/index.js";
import { validateMultiTableCandidate } from "../src/dataset/validation/multitable.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "target-evidence");
const DIGEST = "0".repeat(64);
const ASSET_A = `asset_${"a".repeat(64)}`;
const ASSET_B = `asset_${"b".repeat(64)}`;
const tempRoots: string[] = [];

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function fixtureRows(name: string): Promise<string[][]> {
  const text = await readFile(path.join(FIXTURES, name), "utf8");
  return delimitedRowsWithLines(text, ",").map((row) => row.values);
}

async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as unknown;
}

async function loadRows(options: { evidence?: string; sources?: string } = {}): Promise<TargetEvidenceRows> {
  const targets = await fixtureRows("targets.valid.csv");
  const evidence = await fixtureRows(options.evidence ?? "evidence.valid.csv");
  const sources = await fixtureRows(options.sources ?? "sources.valid.csv");
  const supporting = await fixtureRows("supporting.valid.csv");
  return {
    targets: [Object.fromEntries(targets[0]!.map((key, index) => [key, targets[1]![index]]))],
    evidence: evidence.slice(1).filter((row) => row.length > 1).map((row) => ({
      evidence_id: row[0]!,
      target_id: row[1]!,
      target_namespace: row[2]!,
      evidence_type: row[3]!,
      assertion: row[4]!,
      evidence_value: JSON.parse(row[5]!),
      source_id: row[6]!,
      source_locator: JSON.parse(row[7]!),
    })),
    sources: sources.slice(1).map((row) => ({
      source_id: row[0]!,
      source_database: row[1]!,
      source_asset_id: row[2]!,
      source_locator: JSON.parse(row[3]!),
      retrieved_at: row[4]!,
      carrier_type: row[5]!,
    })),
    supporting: supporting.slice(1).filter((row) => row.length > 1).map((row) => ({
      supporting_id: row[0]!,
      evidence_id: row[1]!,
      supporting_type: row[2]!,
      supporting_value: JSON.parse(row[3]!),
      source_id: row[4]!,
    })),
  };
}

function result(
  tableId: string,
  schemaRef: string,
  rowCount: number,
  fileDigest: string,
  inputAssetIds: readonly string[],
  relativePath = `integrated/${tableId}.csv`,
  sizeBytes = 1,
): OperationResultManifest {
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_target_1",
    build_id: "build_target_1",
    operation_id: `integrate_${tableId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: fileDigest,
    output_kind: "integrated_table",
    output_summary: {
      table_id: tableId,
      schema_ref: schemaRef,
      row_count: rowCount,
      column_count: targetEvidenceSchemas.find((schema) => schema.schema_id === schemaRef)!.fields.length,
      primary_file_sha256: fileDigest,
    },
    output_files: [{ relative_path: relativePath, size_bytes: sizeBytes, sha256: fileDigest }],
    dependency_closure: {
      input_asset_ids: [...inputAssetIds],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: { state: "committed", commit_id: `commit_${tableId}`, committed_at: "2026-08-18T00:00:00Z" },
    migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
  };
}

async function validationRequest(evidenceFile = "evidence.valid.csv"): Promise<MultiTableValidationRequest> {
  const definitions = targetEvidenceTableDefinitions();
  const files = ["targets.valid.csv", evidenceFile, "sources.valid.csv", "supporting.empty.csv"];
  const tables: MultiTableValidationTable[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    const schema = targetEvidenceSchemas[index]!;
    const fileName = files[index]!;
    const filePath = path.join(FIXTURES, fileName);
    const bytes = await readFile(filePath);
    const fileStat = await stat(filePath);
    tables.push({
      definition,
      schema,
      file: {
        origin: "core_operation_result",
        relative_path: fileName,
        delimiter: ",",
        operation_result: result(
          definition.table_id,
          schema.schema_id,
          fileName.includes("empty") ? 0 : 1,
          createHash("sha256").update(bytes).digest("hex"),
          [ASSET_A, ASSET_B],
          fileName,
          fileStat.size,
        ),
      },
      provenance_refs: [`prov_${definition.table_id}`],
      confidence_refs: [`conf_${definition.table_id}`],
    });
  }
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "target-evidence-workspace-"));
  tempRoots.push(workspaceRoot);
  return {
    task_id: "task_target_1",
    build_id: "build_target_1",
    candidate: {
      candidate_id: "candidate_target_1",
      table_ids: tables.map((table) => table.definition.table_id),
      relation_ids: targetEvidenceRelations.map((relation) => relation.relation_id),
      provenance_refs: tables.flatMap((table) => table.provenance_refs),
      confidence_refs: tables.flatMap((table) => table.confidence_refs),
      audit_refs: [],
    },
    tables,
    relations: [...targetEvidenceRelations],
    trusted_root: FIXTURES,
    forbidden_roots: [workspaceRoot],
    policy: targetEvidenceValidationPolicy(),
  };
}

function failedChecks(resultValue: Awaited<ReturnType<typeof validateMultiTableCandidate>>): string[] {
  return resultValue.checks.filter((check) => !check.passed).map((check) => `${check.scope}:${check.check_id}`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("target evidence family", () => {
  it("accepts target, evidence, UniProt/trial sources, and supporting rows", async () => {
    const rows = await loadRows();
    expect(() => assertTargetEvidenceRows(rows)).not.toThrow();
    expect(targetEvidenceRelations).toHaveLength(5);
    expect(targetEvidenceTableDefinitions().find((item) => item.table_id === "targets")).toMatchObject({ role: "primary", allow_empty: false });
  });

  it("allows an explicitly empty supporting table but rejects missing evidence and foreign keys", async () => {
    const rows = await loadRows();
    expect(() => assertTargetEvidenceRows({ ...rows, supporting: [] })).not.toThrow();

    const noEvidence = await loadRows({ evidence: "evidence.empty.csv" });
    expect(() => assertTargetEvidenceRows(noEvidence)).toThrow(/evidence table must not be empty/);

    const badForeignKey = await loadRows({ evidence: "evidence.bad-fk.csv" });
    expect(() => assertTargetEvidenceRows(badForeignKey)).toThrow(/missing source_id/);
  });

  it("rejects non-family sources and locator provenance drift", async () => {
    const rows = await loadRows();
    expect(() => assertTargetEvidenceRows({
      ...rows,
      sources: [{ ...rows.sources[0]!, source_database: "pubmed" }],
    })).toThrow(/source_database.*not allowed/);

    const valid = await loadRows();
    expect(() => assertTargetEvidenceRows({
      ...valid,
      evidence: [{
        ...valid.evidence[0]!,
        source_locator: { ...valid.evidence[0]!.source_locator, asset_id: ASSET_B },
      }],
    })).toThrow(/does not match its source asset/);
  });

  it("passes B3 integration and fails closed on FK, empty evidence, and missing provenance", async () => {
    const valid = await validateMultiTableCandidate(await validationRequest());
    expect(valid.passed).toBe(true);

    const badForeignKey = await validateMultiTableCandidate(await validationRequest("evidence.bad-fk.csv"));
    expect(failedChecks(badForeignKey)).toContain("target_evidence_source:foreign_key");

    const emptyEvidence = await validateMultiTableCandidate(await validationRequest("evidence.empty.csv"));
    expect(failedChecks(emptyEvidence)).toContain("evidence:required_allow_empty");

    const missingProvenance = await validationRequest();
    missingProvenance.tables[1]!.provenance_refs = [];
    const missingProvenanceResult = await validateMultiTableCandidate(missingProvenance);
    expect(failedChecks(missingProvenanceResult)).toContain("evidence:table_provenance_refs");
  });

  it("expands fixed non-Gold UniProt, ClinVar, and trial JSON carriers", async () => {
    const rows = expandTargetEvidenceJsonCarriers([
      { assetId: ASSET_A, sourceId: "src_uniprot", sourceDatabase: "uniprot", logicalFile: "source_assets/uniprot.json", retrievedAt: "2026-08-18T00:00:00Z", payload: await jsonFixture("uniprot-api.non-gold.json") },
      { assetId: ASSET_B, sourceId: "src_clinvar", sourceDatabase: "ncbi_clinvar", logicalFile: "source_assets/clinvar.json", retrievedAt: "2026-08-18T00:00:00Z", payload: await jsonFixture("clinvar-api.non-gold.json") },
      { assetId: `asset_${"c".repeat(64)}`, sourceId: "src_trial", sourceDatabase: "clinicaltrials_gov", logicalFile: "source_assets/trial.json", retrievedAt: "2026-08-18T00:00:00Z", payload: await jsonFixture("clinicaltrials-api.non-gold.json") },
    ]);
    expect(rows.targets.map((row) => row.entity_id)).toEqual(["Q9Y243", "VCV000123456", "NCT01234567"]);
    expect(rows.sources).toHaveLength(3);
    expect(rows.evidence).toHaveLength(3);
    expect(rows.supporting).toHaveLength(3);
    expect(rows.evidence[1]?.evidence_value).toMatchObject({ gene_id: "10000", gene_symbol: "AKT3" });
  });

  it("fails closed for an unknown provider response shape", async () => {
    const payload = await jsonFixture("unknown-api.non-gold.json");
    expect(() => expandTargetEvidenceJsonCarriers([{
      assetId: ASSET_A,
      sourceId: "src_unknown",
      sourceDatabase: "uniprot",
      logicalFile: "source_assets/unknown.json",
      retrievedAt: "2026-08-18T00:00:00Z",
      payload,
    }])).toThrow(/UniProt \/results must be a non-empty array/);
  });

  it("registers one strict CSV parser per target evidence schema", () => {
    const registry = createTargetEvidenceRegisteredTableRegistry();
    expect(registry.list()).toEqual([
      "registered_target_evidence_evidence_csv@1_0_0",
      "registered_target_evidence_source_csv@1_0_0",
      "registered_target_evidence_supporting_csv@1_0_0",
      "registered_target_evidence_target_csv@1_0_0",
    ]);
  });

  it("assembles a deterministic candidate from native Core table results and rejects missing evidence", () => {
    const schemas = new Map(targetEvidenceSchemas.map((schema) => [schema.schema_id, schema]));
    const tableIds = ["targets", "evidence", "sources", "supporting"] as const;
    const tableInputs = tableIds.map((tableId, index) => {
      const schema = targetEvidenceSchemas[index]!;
      const integration = result(tableId, schema.schema_id, tableId === "supporting" ? 0 : 1, digest(`table:${tableId}`), [ASSET_A, ASSET_B]);
      return {
        tableId,
        result: integration,
        provenanceResults: [result(`provenance_${tableId}`, schema.schema_id, 1, digest(`provenance:${tableId}`), [])],
        confidenceResults: [result(`confidence_${tableId}`, schema.schema_id, 1, digest(`confidence:${tableId}`), [])],
      };
    });
    const candidate = assembleTargetEvidenceCandidate({
      taskId: "task_target_1",
      buildId: "build_target_1",
      datasetFamily: "target_evidence",
      rowGranularity: TARGET_EVIDENCE_ROW_GRANULARITY,
      tables: tableInputs,
      registeredAssetIds: [ASSET_A, ASSET_B],
    });
    expect(candidate.tables.find((table) => table.definition.table_id === "supporting")).toMatchObject({ row_count: 0 });
    expect(candidate.relations).toHaveLength(5);
    expect(candidate.candidate_id).toMatch(/^candidate_[0-9a-f]{32}$/);
    expect(() => assembleTargetEvidenceCandidate({
      taskId: "task_target_1",
      buildId: "build_target_1",
      datasetFamily: "target_evidence",
      rowGranularity: TARGET_EVIDENCE_ROW_GRANULARITY,
      tables: tableInputs.filter((table) => table.tableId !== "evidence"),
      registeredAssetIds: [ASSET_A, ASSET_B],
    })).toThrow(/requires targets, evidence, sources, and supporting/);
    expect(schemas.size).toBe(4);
  });
});
