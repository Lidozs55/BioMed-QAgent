import {
  computeFamilySpecDigest,
  type FamilySpec,
  type OperationResultManifest,
  type Projection,
} from "@biomed/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DYNAMIC_STRING_PRESERVING_PROFILE,
  materializeDynamicFamilyCandidate,
  materializeDynamicFamilySchemas,
  type DynamicFamilyAssemblyInput,
  type DynamicFamilyTableOutputs,
} from "../src/dataset/dynamic-family/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const ASSET_A = `asset_${A}`;
const ASSET_B = `asset_${B}`;

const PROJECTION: Projection = {
  projection_id: "network_projection",
  schema_version: "2.0",
  primary_tables: ["edges"],
  supporting_tables: ["nodes"],
  derived_tables: ["node_labels"],
  required: ["edges", "nodes"],
  optional: ["node_labels"],
  allow_empty: ["node_labels"],
  relations: ["edge_source", "label_node"],
  row_granularity: "declared_network_records",
  compatibility_dimensions: ["source_revision"],
  merge_identity_fields: ["source_id", "target_id"],
  validation_policy_ref: "policy.validation.dynamic",
  assessment_policy_ref: "policy.assessment.dynamic",
};

async function familySpec(): Promise<FamilySpec> {
  const unsigned: FamilySpec = {
    family_spec_id: "family_network_fixture",
    semantic_version: "2.0.0",
    canonical_digest: A,
    projections: [structuredClone(PROJECTION)],
    table_definitions: [
      {
        table_id: "edges",
        schema_ref: "schema.network.edges.v2",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["source_id", "target_id"],
        field_names: ["source_id", "target_id", "weight_text"],
      },
      {
        table_id: "nodes",
        schema_ref: "schema.network.nodes.v2",
        role: "supporting",
        required: true,
        allow_empty: false,
        primary_key: ["node_id"],
        field_names: ["node_id", "display_name"],
      },
      {
        table_id: "node_labels",
        schema_ref: "schema.network.labels.v2",
        role: "derived",
        required: false,
        allow_empty: true,
        primary_key: ["node_id", "label"],
        field_names: ["node_id", "label"],
      },
    ],
    relations: [
      {
        relation_id: "edge_source",
        from_table_id: "edges",
        from_fields: ["source_id"],
        to_table_id: "nodes",
        to_fields: ["node_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "label_node",
        from_table_id: "node_labels",
        from_fields: ["node_id"],
        to_table_id: "nodes",
        to_fields: ["node_id"],
        cardinality: "many_to_one",
        missing_policy: "allow_empty",
      },
    ],
    identity: {
      dataset_id_scheme: "ds_hash",
      dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: ["capability.dynamic.fixture"],
    declared_outputs: [
      { table_id: "edges", schema_ref: "schema.network.edges.v2" },
      { table_id: "nodes", schema_ref: "schema.network.nodes.v2" },
      { table_id: "node_labels", schema_ref: "schema.network.labels.v2" },
    ],
    integration_policy_ref: "policy.integration.dynamic",
    validation_policy_ref: "policy.validation.dynamic",
    assessment_policy_ref: "policy.assessment.dynamic",
    resource_class_request: "small",
    scope: "task",
    author: "dynamic-fixture",
    evidence_refs: ["evidence.fixture"],
  };
  return { ...unsigned, canonical_digest: await computeFamilySpecDigest(unsigned) };
}

let serial = 0;

function result(options: {
  tableId?: string;
  schemaRef?: string;
  familyId?: string;
  rowGranularity?: string;
  rowCount?: number;
  columnCount?: number;
  kind?: "data" | "provenance" | "confidence" | "audit";
  assetId?: string;
  digest?: string;
} = {}): OperationResultManifest {
  serial += 1;
  const kind = options.kind ?? "data";
  const tableId = options.tableId ?? "edges";
  const digest = options.digest ?? (kind === "data" ? A : kind === "provenance" ? B : C);
  const outputKind = kind === "data" ? "integrated_table" : "derived_evidence";
  const operationKind = kind === "data" ? "integrate" : "derive";
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${kind}_${tableId}_${serial}`,
    task_id: "task_dynamic",
    build_id: "build_dynamic",
    operation_id: `${operationKind}_${tableId}_${serial}`,
    operation_kind: operationKind,
    operation_attempt_id: `attempt_${serial}`,
    attempt: 1,
    status: "succeeded",
    input_digest: A,
    parameter_digest: B,
    implementation_digest: C,
    output_digest: digest,
    output_kind: outputKind,
    output_summary: kind === "data" ? {
      table_id: tableId,
      dataset_family: options.familyId ?? "family_network_fixture",
      row_granularity: options.rowGranularity ?? PROJECTION.row_granularity,
      schema_ref: options.schemaRef ?? `schema.network.${tableId === "node_labels" ? "labels" : tableId}.v2`,
      row_count: options.rowCount ?? 2,
      column_count: options.columnCount ?? (tableId === "edges" ? 3 : 2),
      primary_file_sha256: digest,
    } : { evidence_kind: kind, table_id: tableId },
    output_files: [{
      relative_path: `${kind}/${tableId}-${serial}.jsonl`,
      size_bytes: 17,
      sha256: digest,
    }],
    dependency_closure: {
      input_asset_ids: [options.assetId ?? ASSET_A],
      upstream_result_manifest_ids: [],
      parameter_digest: B,
      implementation_digest: C,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${serial}`,
      committed_at: "2026-08-23T00:00:00Z",
    },
    migration: {
      mode: "native",
      legacy_checkpoint_path: null,
      migrated_at: null,
    },
  };
}

function tableOutputs(tableId: string, assetId = ASSET_A): DynamicFamilyTableOutputs {
  return {
    data: result({ tableId, assetId, digest: tableId === "edges" ? A : tableId === "nodes" ? B : C }),
    provenance: [result({ tableId, assetId, kind: "provenance", digest: `${serial}`.padStart(64, "1").slice(-64) })],
    confidence: [result({ tableId, assetId, kind: "confidence", digest: `${serial}`.padStart(64, "2").slice(-64) })],
    audit: [],
  };
}

async function assemblyInput(
  overrides: Partial<DynamicFamilyAssemblyInput> = {},
): Promise<DynamicFamilyAssemblyInput> {
  return {
    taskId: "task_dynamic",
    buildId: "build_dynamic",
    familySpec: await familySpec(),
    projection: structuredClone(PROJECTION),
    tableOutputs: {
      edges: tableOutputs("edges", ASSET_A),
      nodes: tableOutputs("nodes", ASSET_B),
      node_labels: tableOutputs("node_labels", ASSET_B),
    },
    ...overrides,
  };
}

beforeEach(() => {
  serial = 0;
});

describe("dynamic FamilySpec materializer", () => {
  it("materializes exact ordered string-preserving Schema 2.0 definitions", async () => {
    const spec = await familySpec();
    const materialized = await materializeDynamicFamilySchemas(spec, PROJECTION);

    expect(materialized.profile).toBe(DYNAMIC_STRING_PRESERVING_PROFILE);
    expect(materialized.schemas.map((schema) => schema.schema_id)).toEqual([
      "schema.network.edges.v2",
      "schema.network.nodes.v2",
      "schema.network.labels.v2",
    ]);
    expect(materialized.schemas[0]).toMatchObject({
      schema_version: "2.0",
      schema_id: "schema.network.edges.v2",
      dataset_family: "family_network_fixture",
      row_granularity: "declared_network_records",
      primary_key: ["source_id", "target_id"],
    });
    expect(materialized.schemas[0]!.fields.map((field) => ({
      name: field.name,
      data_type: field.data_type,
      required: field.required,
      nullable: field.nullable,
      semantic_role: field.semantic_role,
      unit_policy: field.unit_policy,
      ontology: field.ontology,
    }))).toEqual([
      { name: "source_id", data_type: "string", required: true, nullable: false, semantic_role: DYNAMIC_STRING_PRESERVING_PROFILE, unit_policy: null, ontology: null },
      { name: "target_id", data_type: "string", required: true, nullable: false, semantic_role: DYNAMIC_STRING_PRESERVING_PROFILE, unit_policy: null, ontology: null },
      { name: "weight_text", data_type: "string", required: false, nullable: true, semantic_role: DYNAMIC_STRING_PRESERVING_PROFILE, unit_policy: null, ontology: null },
    ]);
  });

  it("assembles a shared native multi-table OperationResult with exact summary closure", async () => {
    const base = result({ tableId: "edges", assetId: ASSET_A, digest: A });
    const shared: OperationResultManifest = {
      ...base,
      result_manifest_id: "result_shared_dynamic_tables",
      output_digest: "d".repeat(64),
      output_summary: {
        tables: {
          edges: {
            table_id: "edges", dataset_family: "family_network_fixture",
            row_granularity: PROJECTION.row_granularity, schema_ref: "schema.network.edges.v2",
            row_count: 2, column_count: 3, primary_file_sha256: A,
          },
          nodes: {
            table_id: "nodes", dataset_family: "family_network_fixture",
            row_granularity: PROJECTION.row_granularity, schema_ref: "schema.network.nodes.v2",
            row_count: 2, column_count: 2, primary_file_sha256: B,
          },
          node_labels: {
            table_id: "node_labels", dataset_family: "family_network_fixture",
            row_granularity: PROJECTION.row_granularity, schema_ref: "schema.network.labels.v2",
            row_count: 0, column_count: 2, primary_file_sha256: C,
          },
        },
      },
      output_files: [
        { relative_path: "tables/edges.csv", size_bytes: 17, sha256: A },
        { relative_path: "tables/nodes.csv", size_bytes: 17, sha256: B },
        { relative_path: "tables/node_labels.csv", size_bytes: 0, sha256: C },
      ],
    };
    const input = await assemblyInput();
    const tableOutputs = Object.fromEntries(Object.entries(input.tableOutputs).map(([tableId, outputs]) => [
      tableId,
      { ...outputs, data: shared },
    ]));

    const materialized = await materializeDynamicFamilyCandidate({ ...input, tableOutputs });
    expect(materialized.candidate.tables.map((table) => table.data_ref.output_file_index)).toEqual([0, 1, 2]);

    const invalid = structuredClone(shared);
    const tables = invalid.output_summary.tables as Record<string, unknown>;
    tables.extra = { table_id: "extra" };
    const invalidOutputs = Object.fromEntries(Object.entries(tableOutputs).map(([tableId, outputs]) => [
      tableId,
      { ...outputs, data: invalid },
    ]));
    await expect(materializeDynamicFamilyCandidate({ ...input, tableOutputs: invalidOutputs }))
      .rejects.toThrow(/exactly close referenced tables/);
  });

  it("assembles tables, relations, evidence, assets, and optional emptiness from only the projection closure", async () => {
    const input = await assemblyInput();
    const labels = input.tableOutputs.node_labels!;
    const output = await materializeDynamicFamilyCandidate({
      ...input,
      tableOutputs: {
        ...input.tableOutputs,
        node_labels: {
          ...labels,
          data: result({ tableId: "node_labels", rowCount: 0, assetId: ASSET_B, digest: C }),
        },
      },
    });

    expect(output.schema_profile).toBe(DYNAMIC_STRING_PRESERVING_PROFILE);
    expect(output.candidate.tables.map((table) => ({
      id: table.definition.table_id,
      required: table.definition.required,
      allow_empty: table.definition.allow_empty,
      row_count: table.row_count,
    }))).toEqual([
      { id: "edges", required: true, allow_empty: false, row_count: 2 },
      { id: "nodes", required: true, allow_empty: false, row_count: 2 },
      { id: "node_labels", required: false, allow_empty: true, row_count: 0 },
    ]);
    expect(output.candidate.relations.map((relation) => relation.relation_id)).toEqual([
      "edge_source",
      "label_node",
    ]);
    expect(output.candidate.provenance_refs).toHaveLength(3);
    expect(output.candidate.confidence_refs).toHaveLength(3);
    expect(output.candidate.audit_refs).toEqual([]);
    expect(output.candidate.registered_asset_ids).toEqual([ASSET_A, ASSET_B]);
    expect(output.candidate.candidate_id).toMatch(/^candidate_[0-9a-f]{32}$/);
    expect(JSON.stringify(output.candidate)).not.toContain("relative_path");
  });

  it("rejects unknown, missing, and extra table outputs", async () => {
    const base = await assemblyInput();
    await expect(materializeDynamicFamilyCandidate({
      ...base,
      tableOutputs: { ...base.tableOutputs, mystery: tableOutputs("edges") },
    })).rejects.toThrow(/unknown table outputs: mystery/);

    const missing = { ...base.tableOutputs };
    delete missing.nodes;
    await expect(materializeDynamicFamilyCandidate({ ...base, tableOutputs: missing }))
      .rejects.toThrow(/missing selected table outputs: nodes/);

    const spec = structuredClone(base.familySpec);
    spec.table_definitions.push({
      table_id: "unused",
      schema_ref: "schema.network.unused.v2",
      role: "supporting",
      required: false,
      allow_empty: true,
      primary_key: ["id"],
      field_names: ["id"],
    });
    spec.declared_outputs.push({ table_id: "unused", schema_ref: "schema.network.unused.v2" });
    spec.projections.push({
      ...structuredClone(PROJECTION),
      projection_id: "unused_projection",
      primary_tables: ["edges"],
      supporting_tables: ["unused"],
      derived_tables: [],
      required: ["edges"],
      optional: ["unused"],
      allow_empty: ["unused"],
      relations: [],
    });
    spec.canonical_digest = await computeFamilySpecDigest(spec);
    await expect(materializeDynamicFamilyCandidate({
      ...base,
      familySpec: spec,
      tableOutputs: { ...base.tableOutputs, unused: tableOutputs("edges") },
    })).rejects.toThrow(/extra table outputs outside selected projection: unused/);
  });

  it("rejects result schema mismatches and nonempty-policy violations", async () => {
    const base = await assemblyInput();
    const edges = base.tableOutputs.edges!;
    await expect(materializeDynamicFamilyCandidate({
      ...base,
      tableOutputs: {
        ...base.tableOutputs,
        edges: { ...edges, data: result({ tableId: "edges", schemaRef: "schema.wrong.v2" }) },
      },
    })).rejects.toThrow(/result summary schema mismatch/);

    await expect(materializeDynamicFamilyCandidate({
      ...base,
      tableOutputs: {
        ...base.tableOutputs,
        edges: { ...edges, data: result({ tableId: "edges", rowCount: 0 }) },
      },
    })).rejects.toThrow(/edges.*must not be empty/);
  });

  it("rejects invalid topology, projection substitution, and an unverified FamilySpec", async () => {
    const base = await assemblyInput();
    const invalid = structuredClone(base.familySpec);
    invalid.table_definitions[0]!.primary_key = [];
    invalid.canonical_digest = await computeFamilySpecDigest(invalid);
    await expect(materializeDynamicFamilyCandidate({ ...base, familySpec: invalid }))
      .rejects.toThrow(/invalid FamilySpec topology: PRIMARY_KEY_EMPTY/);

    await expect(materializeDynamicFamilyCandidate({
      ...base,
      projection: { ...structuredClone(PROJECTION), relations: ["label_node", "edge_source"] },
    })).rejects.toThrow(/does not exactly match FamilySpec/);

    await expect(materializeDynamicFamilyCandidate({
      ...base,
      familySpec: { ...base.familySpec, canonical_digest: A },
    })).rejects.toThrow(/canonical digest verification failed/);
  });

  it("rejects overlap among data, provenance, confidence, and audit evidence closures", async () => {
    const base = await assemblyInput();
    const edges = base.tableOutputs.edges!;
    await expect(materializeDynamicFamilyCandidate({
      ...base,
      tableOutputs: {
        ...base.tableOutputs,
        edges: {
          ...edges,
          provenance: [edges.data],
          confidence: [],
        },
      },
    })).rejects.toThrow(/evidence overlap.*provenance.*data|evidence overlap.*data.*provenance/);
  });
});
