import type { DatasetSchemaV2, RelationDefinition } from "@biomed/contracts";
import {
  buildBiomedicalRelation,
  buildSourceTable,
} from "../../schema/common/index.js";
import { parseDatasetSchemaV2, parseTableDefinition } from "../../contracts/index.js";
import type { VariantEvidenceSchemaSet } from "./types.js";
import {
  VARIANT_EVIDENCE_FAMILY_ID,
  VARIANT_EVIDENCE_ROW_GRANULARITY,
} from "./types.js";

const NAMESPACE_ONTOLOGY = "biomed:id_namespace.v1";
const CONDITION_NAMESPACE_ONTOLOGY = "biomed:condition_namespace.v1";
const CONFLICT_STATUS_ONTOLOGY = "biomed:variant_conflict_status.v1";
const ASSERTION_STATUS_ONTOLOGY = "biomed:variant_assertion_status.v1";
const EVIDENCE_KIND_ONTOLOGY = "biomed:variant_evidence_kind.v1";
const CONFLICT_POLICY_ONTOLOGY = "biomed:variant_conflict_policy.v1";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    required?: boolean;
    nullable?: boolean;
    ontology?: string | null;
    description: string;
    derivationPolicy?: string | null;
  },
): DatasetSchemaV2["fields"][number] {
  return {
    schema_version: "2.0",
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole,
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: options.derivationPolicy ?? null,
  };
}

function optionalField(
  name: string,
  options: Parameters<typeof field>[1],
): DatasetSchemaV2["fields"][number] {
  return field(name, { ...options, required: false, nullable: true });
}

export function buildVariantAssertionSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "variant_evidence.assertion.v1",
    dataset_family: VARIANT_EVIDENCE_FAMILY_ID,
    row_granularity: VARIANT_EVIDENCE_ROW_GRANULARITY,
    primary_key: ["assertion_id"],
    fields: [
      field("assertion_id", {
        semanticRole: "row_identifier",
        description: "Stable identity of one variant assertion under one condition.",
      }),
      field("variant_id", {
        semanticRole: "entity_identifier",
        ontology: NAMESPACE_ONTOLOGY,
        description: "Variant identifier in variant_namespace.",
      }),
      field("variant_namespace", {
        semanticRole: "identifier_namespace",
        ontology: NAMESPACE_ONTOLOGY,
        description: "Authority and syntax for variant_id.",
      }),
      field("reference_sequence_id", {
        semanticRole: "reference_identifier",
        ontology: NAMESPACE_ONTOLOGY,
        description: "Reference sequence containing the asserted position.",
      }),
      field("reference_namespace", {
        semanticRole: "reference_namespace",
        ontology: NAMESPACE_ONTOLOGY,
        description: "Authority for reference_sequence_id.",
      }),
      field("reference_version", {
        semanticRole: "reference_version",
        description: "Exact assembly or sequence version used to interpret position and alleles.",
      }),
      field("reference_position", {
        semanticRole: "reference_coordinate",
        description: "Position token preserved exactly as supplied by the source.",
      }),
      field("reference_allele", {
        semanticRole: "reference_allele",
        description: "Reference allele on the declared reference sequence and version.",
      }),
      field("alternate_allele", {
        semanticRole: "alternate_allele",
        description: "Alternate allele asserted against reference_allele.",
      }),
      field("condition_id", {
        semanticRole: "condition_identifier",
        description: "Condition, phenotype, disease, or trait identifier for this assertion.",
      }),
      field("condition_namespace", {
        semanticRole: "condition_namespace",
        ontology: CONDITION_NAMESPACE_ONTOLOGY,
        description: "Controlled namespace for condition_id; condition is not free text.",
      }),
      field("assertion_status", {
        semanticRole: "assertion_status",
        ontology: ASSERTION_STATUS_ONTOLOGY,
        description: "Whether the source asserts, refutes, or leaves the variant claim uncertain.",
      }),
      field("conflict_policy", {
        semanticRole: "conflict_policy",
        ontology: CONFLICT_POLICY_ONTOLOGY,
        description: "Policy applied when sources disagree; conflicts are never silently merged.",
      }),
      field("conflict_status", {
        semanticRole: "conflict_status",
        ontology: CONFLICT_STATUS_ONTOLOGY,
        description: "Whether this assertion has a retained source conflict.",
      }),
      optionalField("conflict_evidence", {
        dataType: "json",
        semanticRole: "conflict_evidence",
        description: "Conflicting claims and source IDs retained for review when conflict_status is conflict.",
      }),
      field("source_id", {
        semanticRole: "foreign_key",
        description: "Source carrier record supporting this assertion.",
      }),
    ],
  });
}

export function buildVariantEvidenceSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "variant_evidence.evidence.v1",
    dataset_family: VARIANT_EVIDENCE_FAMILY_ID,
    row_granularity: "one evidence item supporting one variant assertion",
    primary_key: ["evidence_id"],
    fields: [
      field("evidence_id", {
        semanticRole: "row_identifier",
        description: "Stable identity of one evidence item.",
      }),
      field("assertion_id", {
        semanticRole: "foreign_key",
        description: "Variant assertion supported by this evidence item.",
      }),
      field("evidence_kind", {
        semanticRole: "evidence_type",
        ontology: EVIDENCE_KIND_ONTOLOGY,
        description: "Whether evidence is a source assertion or a deterministic derived mapping.",
      }),
      field("evidence_text", {
        semanticRole: "evidence_content",
        description: "Verbatim or normalized evidence statement; not a synthetic scientific value.",
      }),
      field("source_locator", {
        dataType: "json",
        semanticRole: "source_locator",
        description: "SourceLocator 2.0 locating the exact supporting record or cell.",
      }),
      field("evidence_digest", {
        semanticRole: "evidence_integrity",
        description: "Digest of the evidence payload and locator.",
      }),
      field("source_id", {
        semanticRole: "foreign_key",
        description: "Source carrier record supporting this evidence item.",
      }),
    ],
  });
}

export function buildVariantEvidenceTables(): VariantEvidenceSchemaSet {
  const variant = buildVariantAssertionSchema();
  const evidence = buildVariantEvidenceSchema();
  const source = buildSourceTable({
    datasetFamily: VARIANT_EVIDENCE_FAMILY_ID,
    tableId: "sources",
    role: "supporting",
    fieldNames: [
      "source_id",
      "source_database",
      "source_asset_id",
      "source_locator",
      "retrieved_at",
      "carrier_type",
    ],
  });
  const variantTable = parseTableDefinition({
    table_id: "variant_assertions",
    schema_ref: variant.schema_id,
    role: "primary",
    required: true,
    allow_empty: false,
    primary_key: [...variant.primary_key],
    field_names: variant.fields.map((item) => item.name),
  });
  const evidenceTable = parseTableDefinition({
    table_id: "evidence",
    schema_ref: evidence.schema_id,
    role: "supporting",
    required: true,
    allow_empty: false,
    primary_key: [...evidence.primary_key],
    field_names: evidence.fields.map((item) => item.name),
  });
  const relations: RelationDefinition[] = [
    buildBiomedicalRelation({
      relationType: "entity_identity_link",
      relationId: "variant_assertion_evidence",
      fromTableId: "evidence",
      fromFields: ["assertion_id"],
      toTableId: "variant_assertions",
      toFields: ["assertion_id"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    }),
    buildBiomedicalRelation({
      relationType: "entity_identity_link",
      relationId: "variant_assertion_source",
      fromTableId: "variant_assertions",
      fromFields: ["source_id"],
      toTableId: "sources",
      toFields: ["source_id"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    }),
    buildBiomedicalRelation({
      relationType: "entity_identity_link",
      relationId: "evidence_source",
      fromTableId: "evidence",
      fromFields: ["source_id"],
      toTableId: "sources",
      toFields: ["source_id"],
      cardinality: "many_to_one",
      missingPolicy: "reject",
    }),
  ];
  return { variant, evidence, source: source.schema, variantTable, evidenceTable, sourceTable: source.definition, relations };
}
