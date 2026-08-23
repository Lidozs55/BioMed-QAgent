import {
  type FamilySpec,
  type Projection,
  type RelationDefinition,
  type TableDefinition,
} from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  checkFamilySpecTopology,
  type FamilySpecTopologyIssueCode,
} from "../src/dataset/family-spec-topology/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const EXPRESSION_TABLE: TableDefinition = {
  table_id: "expression",
  schema_ref: "schema.expression.v2",
  role: "primary",
  required: true,
  allow_empty: false,
  primary_key: ["sample_id", "dataset_revision_id", "feature_id"],
  field_names: ["dataset_revision_id", "sample_id", "feature_id", "value"],
};

const SAMPLES_TABLE: TableDefinition = {
  table_id: "samples",
  schema_ref: "schema.samples.v2",
  role: "supporting",
  required: true,
  allow_empty: false,
  primary_key: ["sample_id", "dataset_revision_id"],
  field_names: ["dataset_revision_id", "sample_id", "sample_label"],
};

const QUALITY_TABLE: TableDefinition = {
  table_id: "quality",
  schema_ref: "schema.quality.v2",
  role: "derived",
  required: false,
  allow_empty: true,
  primary_key: ["dataset_revision_id", "sample_id"],
  field_names: ["dataset_revision_id", "sample_id", "quality_score"],
};

const EXPRESSION_SAMPLES_RELATION: RelationDefinition = {
  relation_id: "relation.expression_samples",
  from_table_id: "expression",
  from_fields: ["sample_id", "dataset_revision_id"],
  to_table_id: "samples",
  to_fields: ["sample_id", "dataset_revision_id"],
  cardinality: "many_to_one",
  missing_policy: "reject",
};

const EXPRESSION_QUALITY_RELATION: RelationDefinition = {
  relation_id: "relation.expression_quality",
  from_table_id: "expression",
  from_fields: ["dataset_revision_id", "sample_id"],
  to_table_id: "quality",
  to_fields: ["dataset_revision_id", "sample_id"],
  cardinality: "many_to_one",
  missing_policy: "allow_missing",
};

function projection(projectionId: string): Projection {
  return {
    projection_id: projectionId,
    schema_version: "2.0",
    primary_tables: ["expression"],
    supporting_tables: ["samples"],
    derived_tables: ["quality"],
    required: ["expression", "samples"],
    optional: ["quality"],
    allow_empty: ["quality"],
    relations: ["relation.expression_samples", "relation.expression_quality"],
    row_granularity: "measurement_by_sample",
    compatibility_dimensions: ["taxon", "measurement_type"],
    merge_identity_fields: ["dataset_revision_id", "sample_id", "feature_id"],
    validation_policy_ref: "policy.validation.v1",
    assessment_policy_ref: "policy.assessment.v1",
  };
}

const BASE_FAMILY: FamilySpec = {
  family_spec_id: "family.local_topology",
  semantic_version: "2.0.0",
  canonical_digest: DIGEST_A,
  projections: [projection("projection.zeta"), projection("projection.alpha")],
  table_definitions: [QUALITY_TABLE, EXPRESSION_TABLE, SAMPLES_TABLE],
  relations: [EXPRESSION_SAMPLES_RELATION, EXPRESSION_QUALITY_RELATION],
  identity: {
    dataset_id_scheme: "ds_hash",
    dataset_revision_id_scheme: "dsrev_hash",
    asset_id_scheme: "asset_sha256",
    sample_identity_fields: ["dataset_revision_id", "sample_id"],
    probe_mapping_assertion_pk: "mapping_assertion_id",
  },
  transform_capability_refs: ["transform.local.v1"],
  declared_outputs: [
    { table_id: "samples", schema_ref: SAMPLES_TABLE.schema_ref },
    { table_id: "quality", schema_ref: QUALITY_TABLE.schema_ref },
    { table_id: "expression", schema_ref: EXPRESSION_TABLE.schema_ref },
  ],
  integration_policy_ref: "policy.integration.v1",
  validation_policy_ref: "policy.validation.v1",
  assessment_policy_ref: "policy.assessment.v1",
  resource_class_request: "standard",
  scope: "curated",
  author: "fixture_author",
  evidence_refs: ["evidence.fixture"],
};

function family(): FamilySpec {
  return structuredClone(BASE_FAMILY);
}

function issueCodes(value: unknown): FamilySpecTopologyIssueCode[] {
  return checkFamilySpecTopology(value).issues.map((issue) => issue.code);
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    key,
    ...collectKeys(nested),
  ]);
}

describe("FamilySpec proposal-only pure topology linter", () => {
  it("returns only proposal topology facts for a locally closed FamilySpec", () => {
    const result = checkFamilySpecTopology(family());

    expect(result).toMatchObject({
      proposal_only: true,
      topology_valid: true,
      issues: [],
    });
    expect(result.normalized_topology.projections.map((item) => item.projection_id)).toEqual([
      "projection.alpha",
      "projection.zeta",
    ]);
    expect(result.normalized_topology.table_definitions.map((item) => item.table_id)).toEqual([
      "expression",
      "quality",
      "samples",
    ]);
    expect(result.normalized_topology.relations.map((item) => item.relation_id)).toEqual([
      "relation.expression_quality",
      "relation.expression_samples",
    ]);
  });

  it("uses the strict parseFamilySpec boundary rather than accepting copied shape rules", () => {
    const input = Object.assign(family(), { unexpected_topology_extension: true });

    expect(() => checkFamilySpecTopology(input)).toThrow(/Unknown field.*unexpected_topology_extension/);
  });

  it("reports duplicate IDs only within each object kind", () => {
    const input = family();
    input.projections.push({ ...input.projections[0]! });
    input.table_definitions.push({ ...input.table_definitions[0]! });
    input.relations.push({ ...input.relations[0]! });
    input.declared_outputs.push({ ...input.declared_outputs[0]! });

    const codes = issueCodes(input);

    expect(codes).toEqual(expect.arrayContaining([
      "DUPLICATE_PROJECTION_ID",
      "DUPLICATE_TABLE_ID",
      "DUPLICATE_RELATION_ID",
      "DUPLICATE_DECLARED_OUTPUT_TABLE_ID",
    ]));
  });

  it("checks projection role membership, disjointness, and requirement coverage", () => {
    const input = family();
    const first = input.projections[0]!;
    first.primary_tables.push("samples");
    first.optional = ["samples"];
    first.allow_empty.push("outside");

    const codes = issueCodes(input);

    expect(codes).toEqual(expect.arrayContaining([
      "TABLE_ROLE_MISMATCH",
      "PROJECTION_ROLE_OVERLAP",
      "PROJECTION_REQUIREMENT_OVERLAP",
      "PROJECTION_REQUIREMENT_COVERAGE_MISMATCH",
      "ALLOW_EMPTY_OUTSIDE_TOPOLOGY",
    ]));
  });

  it("closes declared output table/schema refs over table definitions", () => {
    const missingOutput = family();
    missingOutput.declared_outputs = missingOutput.declared_outputs.filter(
      (output) => output.table_id !== "quality",
    );
    expect(issueCodes(missingOutput)).toContain("TABLE_OUTPUT_UNDECLARED");

    const undefinedOutput = family();
    undefinedOutput.declared_outputs.push({
      table_id: "outside",
      schema_ref: "schema.outside.v2",
    });
    expect(issueCodes(undefinedOutput)).toContain("DECLARED_OUTPUT_TABLE_UNDEFINED");

    const mismatchedSchema = family();
    mismatchedSchema.declared_outputs.find(
      (output) => output.table_id === "samples",
    )!.schema_ref = "schema.wrong.v2";
    expect(issueCodes(mismatchedSchema)).toContain("DECLARED_OUTPUT_SCHEMA_MISMATCH");
  });

  it("requires non-empty PKs with declared fields and preserves PK declaration order", () => {
    const valid = checkFamilySpecTopology(family());
    const expression = valid.normalized_topology.table_definitions.find(
      (table) => table.table_id === "expression",
    );
    expect(expression?.primary_key).toEqual([
      "sample_id",
      "dataset_revision_id",
      "feature_id",
    ]);

    const invalid = family();
    invalid.table_definitions.find((table) => table.table_id === "samples")!.primary_key = [];
    invalid.table_definitions.find((table) => table.table_id === "quality")!.primary_key = [
      "missing_field",
    ];
    expect(issueCodes(invalid)).toEqual(expect.arrayContaining([
      "PRIMARY_KEY_EMPTY",
      "PRIMARY_KEY_FIELD_UNDEFINED",
    ]));
  });

  it("preserves relation tuple order and does not infer whole-PK cardinality rules", () => {
    const input = family();
    const relation = input.relations.find(
      (item) => item.relation_id === "relation.expression_samples",
    )!;
    relation.cardinality = "one_to_one";
    relation.from_fields = ["sample_id", "dataset_revision_id"];
    relation.to_fields = ["dataset_revision_id", "sample_id"];

    const result = checkFamilySpecTopology(input);
    const normalized = result.normalized_topology.relations.find(
      (item) => item.relation_id === relation.relation_id,
    );

    expect(result.topology_valid).toBe(true);
    expect(normalized?.from_fields).toEqual(["sample_id", "dataset_revision_id"]);
    expect(normalized?.to_fields).toEqual(["dataset_revision_id", "sample_id"]);
  });

  it("checks relation endpoint tables, non-empty equal-width tuples, and endpoint fields", () => {
    const input = family();
    input.relations = [
      {
        ...EXPRESSION_SAMPLES_RELATION,
        relation_id: "relation.empty",
        from_fields: [],
        to_fields: [],
      },
      {
        ...EXPRESSION_SAMPLES_RELATION,
        relation_id: "relation.arity",
        from_fields: ["sample_id"],
        to_fields: ["sample_id", "dataset_revision_id"],
      },
      {
        ...EXPRESSION_SAMPLES_RELATION,
        relation_id: "relation.endpoint",
        to_table_id: "missing_table",
      },
      {
        ...EXPRESSION_SAMPLES_RELATION,
        relation_id: "relation.field",
        from_fields: ["missing_field"],
        to_fields: ["sample_id"],
      },
    ];
    for (const item of input.projections) {
      item.relations = input.relations.map((relation) => relation.relation_id);
    }

    expect(issueCodes(input)).toEqual(expect.arrayContaining([
      "RELATION_FIELD_TUPLE_EMPTY",
      "RELATION_FIELD_ARITY_MISMATCH",
      "RELATION_ENDPOINT_TABLE_UNDEFINED",
      "RELATION_ENDPOINT_FIELD_UNDEFINED",
    ]));
  });

  it("requires every projected relation endpoint to remain inside that projection", () => {
    const input = family();
    const first = input.projections[0]!;
    first.derived_tables = [];
    first.optional = [];

    expect(issueCodes(input)).toContain("PROJECTION_RELATION_ENDPOINT_OUTSIDE_TOPOLOGY");
  });

  it("reports tables and relations unused by every projection", () => {
    const input = family();
    const unusedTable: TableDefinition = {
      table_id: "unused_table",
      schema_ref: "schema.unused.v2",
      role: "supporting",
      required: false,
      allow_empty: true,
      primary_key: ["id"],
      field_names: ["id"],
    };
    const unusedRelation: RelationDefinition = {
      relation_id: "relation.unused",
      from_table_id: "unused_table",
      from_fields: ["id"],
      to_table_id: "unused_table",
      to_fields: ["id"],
      cardinality: "one_to_one",
      missing_policy: "allow_empty",
    };
    input.table_definitions.push(unusedTable);
    input.relations.push(unusedRelation);
    input.declared_outputs.push({
      table_id: unusedTable.table_id,
      schema_ref: unusedTable.schema_ref,
    });

    expect(issueCodes(input)).toEqual(expect.arrayContaining([
      "UNUSED_TABLE",
      "UNUSED_RELATION",
    ]));
  });

  it("is stable when only top-level object collections are reordered", () => {
    const forward = family();
    const reversed = family();
    reversed.projections.reverse();
    reversed.table_definitions.reverse();
    reversed.relations.reverse();
    reversed.declared_outputs.reverse();

    expect(checkFamilySpecTopology(reversed)).toEqual(checkFamilySpecTopology(forward));
  });

  it("allows the same textual ID across different object kinds", () => {
    const shared: FamilySpec = {
      ...family(),
      family_spec_id: "shared",
      projections: [{
        ...projection("shared"),
        primary_tables: ["shared"],
        supporting_tables: [],
        derived_tables: [],
        required: ["shared"],
        optional: [],
        allow_empty: [],
        relations: ["shared"],
      }],
      table_definitions: [{
        table_id: "shared",
        schema_ref: "shared",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["id"],
        field_names: ["id"],
      }],
      relations: [{
        relation_id: "shared",
        from_table_id: "shared",
        from_fields: ["id"],
        to_table_id: "shared",
        to_fields: ["id"],
        cardinality: "one_to_one",
        missing_policy: "reject",
      }],
      declared_outputs: [{ table_id: "shared", schema_ref: "shared" }],
    };

    expect(checkFamilySpecTopology(shared)).toMatchObject({
      proposal_only: true,
      topology_valid: true,
      issues: [],
    });
  });

  it("does not attach expression-domain rules to a same-named probe table", () => {
    const probeNamed: FamilySpec = {
      ...family(),
      projections: [{
        ...projection("projection.nonexpression"),
        primary_tables: ["probe_gene_mapping"],
        supporting_tables: [],
        derived_tables: [],
        required: ["probe_gene_mapping"],
        optional: [],
        allow_empty: [],
        relations: [],
      }],
      table_definitions: [{
        table_id: "probe_gene_mapping",
        schema_ref: "schema.nonexpression.v1",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["probe_id"],
        field_names: ["probe_id", "measurement"],
      }],
      relations: [],
      declared_outputs: [{
        table_id: "probe_gene_mapping",
        schema_ref: "schema.nonexpression.v1",
      }],
    };

    expect(checkFamilySpecTopology(probeNamed)).toMatchObject({
      topology_valid: true,
      issues: [],
    });
  });

  it("ignores scope, resource request, and declared digest as local topology authority", () => {
    const left = family();
    const right = family();
    right.canonical_digest = DIGEST_B;
    right.scope = "task";
    right.resource_class_request = "unbounded_request";
    right.author = "different_author";
    right.evidence_refs = ["different_evidence"];

    expect(checkFamilySpecTopology(right)).toEqual(checkFamilySpecTopology(left));
  });

  it("emits no trust-bearing or runtime-result fields", () => {
    const result = checkFamilySpecTopology(family());
    const keys = new Set(collectKeys(result));
    const forbidden = [
      "admit",
      "admitted",
      "admission",
      "admission_kind",
      "status",
      "canonical_digest",
      "digest_input",
      "scope",
      "author",
      "evidence_refs",
      "resource_class",
      "resource_class_request",
      "granted_capabilities",
      "exact_references",
      "operation_id",
      "operation_kind",
      "output_kind",
      "candidate_id",
      "publication_id",
      "trust",
    ];

    expect([...keys].filter((key) => forbidden.includes(key))).toEqual([]);
    expect(result).not.toHaveProperty("schema_version");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("commit");
  });
});
