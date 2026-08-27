import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type {
  MultiTableValidationRequest,
  MultiTableValidationTable,
} from "../src/dataset/contracts/index.js";
import { validateMultiTableCandidate } from "../src/dataset/validation/multitable.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "multitable-validation");
const DIGEST = "0".repeat(64);
const tempRoots: string[] = [];

const field = (
  name: string,
  dataType = "string",
  nullable = false,
  semanticRole = "attribute",
  unitPolicy: string | null = null,
) => ({
  schema_version: "2.0" as const,
  name,
  data_type: dataType,
  semantic_role: semanticRole,
  required: true,
  nullable,
  unit_policy: unitPolicy,
  ontology: null,
  description: name,
  derivation_policy: null,
});

const compoundSchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "compound.v1",
  dataset_family: "bioactivity_measurement",
  row_granularity: "compound",
  primary_key: ["compound_id"],
  fields: [field("compound_id"), field("compound_name")],
};

const activitySchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "activity.v1",
  dataset_family: "bioactivity_measurement",
  row_granularity: "activity_measurement",
  primary_key: ["activity_id"],
  fields: [
    field("activity_id"),
    field("compound_id"),
    field("value", "float", false, "measurement"),
    field("raw_relation", "string", false, "relation_token"),
    field("preserved_relation", "string", false, "relation_token"),
    field("raw_unit", "string", false, "unit_token", "preserve_original"),
    field("preserved_unit", "string", false, "unit_token", "preserve_original"),
    field("optional_note", "string", true),
  ],
};

const chartSchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "chart_point.v1",
  dataset_family: "bioactivity_measurement",
  row_granularity: "chart_point",
  primary_key: ["point_id"],
  fields: [
    field("point_id"),
    field("series_id"),
    field("x_value", "float"),
    field("y_value", "float"),
  ],
};

function definition(
  tableId: string,
  schema: DatasetSchemaV2,
  role: TableDefinition["role"],
  required: boolean,
  allowEmpty: boolean,
): TableDefinition {
  return {
    table_id: tableId,
    schema_ref: schema.schema_id,
    role,
    required,
    allow_empty: allowEmpty,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  };
}

const relation: RelationDefinition = {
  relation_id: "activity_compound",
  from_table_id: "activities",
  from_fields: ["compound_id"],
  to_table_id: "compounds",
  to_fields: ["compound_id"],
  cardinality: "many_to_one",
  missing_policy: "reject",
};

async function operationResult(
  tableId: string,
  relativePath: string,
  root = FIXTURES,
): Promise<OperationResultManifest> {
  const bytes = await readFile(path.join(root, relativePath));
  const fileStat = await stat(path.join(root, relativePath));
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_1",
    run_id: "run_test",
    requirement_id: "build_1",
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
      relative_path: relativePath,
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

async function table(
  tableId: string,
  schema: DatasetSchemaV2,
  role: TableDefinition["role"],
  fileName: string,
  required: boolean,
  allowEmpty: boolean,
  root = FIXTURES,
): Promise<MultiTableValidationTable> {
  return {
    definition: definition(tableId, schema, role, required, allowEmpty),
    schema,
    file: {
      origin: "core_operation_result",
      relative_path: fileName,
      delimiter: ",",
      operation_result: await operationResult(tableId, fileName, root),
    },
    provenance_refs: [`prov_${tableId}`],
    confidence_refs: [`conf_${tableId}`],
  };
}

async function validRequest(options: {
  activityFile?: string;
  compoundFile?: string;
  chartAllowEmpty?: boolean;
  root?: string;
} = {}): Promise<MultiTableValidationRequest> {
  const root = options.root ?? FIXTURES;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "multitable-workspace-"));
  tempRoots.push(workspaceRoot);
  const tables = [
    await table("activities", activitySchema, "primary", options.activityFile ?? "activities.valid.csv", true, false, root),
    await table("compounds", compoundSchema, "supporting", options.compoundFile ?? "compounds.valid.csv", true, false, root),
    await table("chart_points", chartSchema, "supporting", "chart-points.empty.csv", false, options.chartAllowEmpty ?? true, root),
  ];
  return {
    task_id: "task_1",
    run_id: "run_test",
    requirement_id: "build_1",
    candidate: {
      candidate_id: "candidate_1",
      table_ids: tables.map((item) => item.definition.table_id),
      relation_ids: [relation.relation_id],
      provenance_refs: tables.flatMap((item) => item.provenance_refs),
      confidence_refs: tables.flatMap((item) => item.confidence_refs),
      audit_refs: [],
    },
    tables,
    relations: [relation],
    trusted_root: root,
    forbidden_roots: [workspaceRoot],
    policy: {
      token_preservation_rules: [
        {
          table_id: "activities",
          source_field: "raw_relation",
          output_field: "preserved_relation",
          token_kind: "relation",
        },
        {
          table_id: "activities",
          source_field: "raw_unit",
          output_field: "preserved_unit",
          token_kind: "unit",
        },
      ],
      profile_relation_missing_policies: {},
    },
  };
}

function failedChecks(result: Awaited<ReturnType<typeof validateMultiTableCandidate>>): string[] {
  return result.checks.filter((item) => !item.passed).map((item) => `${item.scope}:${item.check_id}`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generic multi-table validation and relation gate", () => {
  it("accepts strict related tables, preserved activity tokens, and an explicitly empty supporting table", async () => {
    const result = await validateMultiTableCandidate(await validRequest());

    expect(result.passed).toBe(true);
    expect(failedChecks(result)).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "activities", check_id: "token_preservation", passed: true }),
      expect.objectContaining({ scope: "chart_points", check_id: "required_allow_empty", passed: true }),
      expect.objectContaining({ scope: relation.relation_id, check_id: "foreign_key", passed: true }),
      expect.objectContaining({ scope: relation.relation_id, check_id: "cardinality", passed: true }),
    ]));
  });

  it("rejects header order, row width, and typed-value violations", async () => {
    const result = await validateMultiTableCandidate(await validRequest({
      activityFile: "activities.bad-structure.csv",
    }));

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toEqual(expect.arrayContaining([
      "activities:header_order",
      "activities:row_width",
      "activities:data_type",
    ]));
  });

  it("rejects null and duplicate primary keys", async () => {
    const result = await validateMultiTableCandidate(await validRequest({
      activityFile: "activities.bad-null-pk.csv",
    }));

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toEqual(expect.arrayContaining([
      "activities:nullability",
      "activities:primary_key_uniqueness",
    ]));
  });

  it("rejects missing foreign keys and changed relation/unit tokens", async () => {
    const result = await validateMultiTableCandidate(await validRequest({
      activityFile: "activities.bad-fk-token.csv",
    }));

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toEqual(expect.arrayContaining([
      "activities:token_preservation",
      "activity_compound:foreign_key",
    ]));
  });

  it("enforces declared relation cardinality", async () => {
    const request = await validRequest({ compoundFile: "compounds.bad-cardinality.csv" });
    request.tables[1].schema = {
      ...request.tables[1].schema,
      primary_key: ["compound_id", "compound_name"],
    };
    request.tables[1].definition = {
      ...request.tables[1].definition,
      primary_key: ["compound_id", "compound_name"],
    };
    const result = await validateMultiTableCandidate(request);

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toContain("activity_compound:cardinality");
  });

  it("allows an empty supporting table only when allow_empty is declared", async () => {
    const result = await validateMultiTableCandidate(await validRequest({ chartAllowEmpty: false }));

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toContain("chart_points:required_allow_empty");

    const missingRequired = await validRequest();
    missingRequired.tables[1].file = null;
    const missingResult = await validateMultiTableCandidate(missingRequired);
    expect(missingResult.passed).toBe(false);
    expect(failedChecks(missingResult)).toEqual(expect.arrayContaining([
      "compounds:trusted_table_input",
      "activity_compound:foreign_key",
    ]));
  });

  it("fails closed when a family omits preservation rules for relation/unit token fields", async () => {
    const request = await validRequest();
    request.policy.token_preservation_rules = [];
    const result = await validateMultiTableCandidate(request);

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toContain("activities:token_policy_coverage");
  });

  it("requires provenance and confidence references for every table", async () => {
    const request = await validRequest();
    request.tables[0].provenance_refs = [];
    request.tables[1].confidence_refs = [];
    const result = await validateMultiTableCandidate(request);

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toEqual(expect.arrayContaining([
      "activities:table_provenance_refs",
      "compounds:table_confidence_refs",
    ]));
  });

  it("fails closed when a profile-defined relation policy is unresolved", async () => {
    const request = await validRequest();
    request.relations = [{ ...relation, missing_policy: "profile_defined" }];
    const result = await validateMultiTableCandidate(request);

    expect(result.passed).toBe(false);
    expect(failedChecks(result)).toContain("activity_compound:foreign_key");
  });

  it("rejects Agent-origin inputs, workspace roots, and receipt tampering", async () => {
    const agentRequest = await validRequest();
    const activityFile = agentRequest.tables[0].file;
    if (activityFile === null) throw new Error("test fixture must have a file");
    agentRequest.tables[0].file = {
      ...activityFile,
      origin: "agent_workspace" as "core_operation_result",
    };
    const agentResult = await validateMultiTableCandidate(agentRequest);
    expect(failedChecks(agentResult)).toContain("activities:trusted_table_input");

    const workspaceRequest = await validRequest();
    workspaceRequest.forbidden_roots = [FIXTURES];
    const workspaceResult = await validateMultiTableCandidate(workspaceRequest);
    expect(failedChecks(workspaceResult)).toContain("candidate_1:trusted_root");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "multitable-receipt-"));
    tempRoots.push(tempRoot);
    for (const fileName of ["activities.valid.csv", "compounds.valid.csv", "chart-points.empty.csv"]) {
      await writeFile(path.join(tempRoot, fileName), await readFile(path.join(FIXTURES, fileName)));
    }
    const tamperedRequest = await validRequest({ root: tempRoot });
    await writeFile(path.join(tempRoot, "activities.valid.csv"), "activity_id\nTAMPERED\n");
    const tamperedResult = await validateMultiTableCandidate(tamperedRequest);
    expect(failedChecks(tamperedResult)).toContain("activities:trusted_table_input");

    const traversalRequest = await validRequest();
    const traversalFile = traversalRequest.tables[0].file;
    if (traversalFile === null) throw new Error("test fixture must have a file");
    traversalRequest.tables[0].file = { ...traversalFile, relative_path: "../activities.valid.csv" };
    const traversalResult = await validateMultiTableCandidate(traversalRequest);
    expect(failedChecks(traversalResult)).toContain("activities:trusted_table_input");
  });
});
