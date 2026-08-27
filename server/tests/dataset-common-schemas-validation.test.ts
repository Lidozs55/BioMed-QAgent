import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  TableDefinition,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { MultiTableValidationTable } from "../src/dataset/contracts/index.js";
import {
  buildBiomedicalRelation,
  buildCompoundCrosswalkTable,
  buildCompoundTable,
  buildSourceTable,
} from "../src/dataset/schema/index.js";
import { validateMultiTableCandidate } from "../src/dataset/validation/multitable.js";

const DIGEST = "0".repeat(64);
const tempRoots: string[] = [];

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function writeCsv(
  root: string,
  fileName: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Promise<void> {
  const content = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
  await writeFile(path.join(root, fileName), content);
}

async function operationResult(
  root: string,
  tableId: string,
  fileName: string,
): Promise<OperationResultManifest> {
  const bytes = await readFile(path.join(root, fileName));
  const fileStat = await stat(path.join(root, fileName));
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_common",
    run_id: "run_test",
    requirement_id: "build_common",
    operation_id: `integrate_${tableId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: createHash("sha256").update(`output:${tableId}`).digest("hex"),
    output_kind: "integrated_table",
    output_summary: {},
    output_files: [{
      relative_path: fileName,
      size_bytes: fileStat.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
    dependency_closure: {
      input_asset_ids: [],
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

async function validationTable(
  root: string,
  definition: TableDefinition,
  schema: DatasetSchemaV2,
  fileName: string,
): Promise<MultiTableValidationTable> {
  return {
    definition,
    schema,
    file: {
      origin: "core_operation_result",
      relative_path: fileName,
      delimiter: ",",
      operation_result: await operationResult(root, definition.table_id, fileName),
    },
    provenance_refs: [`prov_${definition.table_id}`],
    confidence_refs: [`conf_${definition.table_id}`],
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("common schemas with generic B3 validation", () => {
  it("validates compound identity and conflict-preserving crosswalk relations", async () => {
    const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "common-schema-trusted-"));
    const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "common-schema-workspace-"));
    tempRoots.push(trustedRoot, forbiddenRoot);

    const compounds = buildCompoundTable({
      datasetFamily: "bioactivity_measurement",
      tableId: "compounds",
      role: "primary",
    });
    const crosswalks = buildCompoundCrosswalkTable({
      datasetFamily: "bioactivity_measurement",
      tableId: "compound_crosswalks",
      role: "supporting",
    });
    const sources = buildSourceTable({
      datasetFamily: "bioactivity_measurement",
      tableId: "sources",
      role: "supporting",
    });

    await writeCsv(trustedRoot, "compounds.csv", compounds.definition.field_names, [[
      "CHEMBL25",
      "chembl_compound",
      "Aspirin",
      "",
      "",
      "",
      "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
      "C9H8O4",
      "180.16",
      "source_chembl",
    ]]);
    await writeCsv(trustedRoot, "crosswalks.csv", crosswalks.definition.field_names, [[
      "crosswalk_1",
      "CHEMBL25",
      "chembl_compound",
      "2244",
      "pubchem_cid",
      "compound_identity_link",
      "exact_inchi_key",
      JSON.stringify({ inchi_key: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N" }),
      "conflict",
      JSON.stringify({ preferred_name: ["Aspirin", "Acetylsalicylic acid"] }),
      "0.91",
      "high",
      "source_chembl",
    ]]);
    await writeCsv(trustedRoot, "sources.csv", sources.definition.field_names, [[
      "source_chembl",
      "chembl",
      "asset_chembl_25",
      JSON.stringify({ kind: "json_pointer", pointer: "/molecules/0" }),
      "2026-08-18T00:00:00Z",
      "api_record",
    ]]);

    const tables = [
      await validationTable(trustedRoot, compounds.definition, compounds.schema, "compounds.csv"),
      await validationTable(trustedRoot, crosswalks.definition, crosswalks.schema, "crosswalks.csv"),
      await validationTable(trustedRoot, sources.definition, sources.schema, "sources.csv"),
    ];
    const relations = [
      buildBiomedicalRelation({
        relationType: "compound_identity_link",
        relationId: "crosswalk_left_compound",
        fromTableId: "compound_crosswalks",
        fromFields: ["left_id", "left_namespace"],
        toTableId: "compounds",
        toFields: ["compound_id", "compound_id_namespace"],
        cardinality: "many_to_one",
      }),
      buildBiomedicalRelation({
        relationType: "compound_has_activity",
        relationId: "compound_source",
        fromTableId: "compounds",
        fromFields: ["source_id"],
        toTableId: "sources",
        toFields: ["source_id"],
        cardinality: "many_to_one",
      }),
      buildBiomedicalRelation({
        relationType: "compound_identity_link",
        relationId: "crosswalk_source",
        fromTableId: "compound_crosswalks",
        fromFields: ["source_id"],
        toTableId: "sources",
        toFields: ["source_id"],
        cardinality: "many_to_one",
      }),
    ];

    const result = await validateMultiTableCandidate({
      task_id: "task_common",
    run_id: "run_test",
      requirement_id: "build_common",
      candidate: {
        candidate_id: "candidate_common",
        table_ids: tables.map((table) => table.definition.table_id),
        relation_ids: relations.map((relation) => relation.relation_id),
        provenance_refs: tables.flatMap((table) => table.provenance_refs),
        confidence_refs: tables.flatMap((table) => table.confidence_refs),
        audit_refs: [],
      },
      tables,
      relations,
      trusted_root: trustedRoot,
      forbidden_roots: [forbiddenRoot],
      policy: {
        token_preservation_rules: [],
        profile_relation_missing_policies: {},
      },
    });

    expect(result.passed).toBe(true);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "crosswalk_left_compound", check_id: "foreign_key", passed: true }),
      expect.objectContaining({ scope: "crosswalk_left_compound", check_id: "cardinality", passed: true }),
      expect.objectContaining({ scope: "compound_crosswalks", check_id: "table_schema_contract", passed: true }),
    ]));
  });
});
