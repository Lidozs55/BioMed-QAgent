import type {
  DatasetSchemaV2,
  RelationDefinition,
  SchemaFieldV2,
  TableDefinition,
} from "@biomed/contracts";

import {
  parseDatasetSchemaV2,
  parseTableDefinition,
  type MultiTableValidationPolicy,
} from "../../contracts/index.js";
import { buildBiomedicalRelation } from "../../schema/common/index.js";
import {
  INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  type InheritedDiseaseEvidenceTableEntry,
} from "./types.js";

const NAMESPACE_ONTOLOGY = "biomed:id_namespace.v1";
const SOURCE_LOCATOR_ONTOLOGY = "biomed:source_locator.v2";
const RELATION_ONTOLOGY = "biomed:relation_type.v1";

export const INHERITED_DISEASE_GENE_SCHEMA_ID =
  "inherited_disease_gene_evidence.gene.v1";
export const INHERITED_DISEASE_DISEASE_SCHEMA_ID =
  "inherited_disease_gene_evidence.disease.v1";
export const INHERITED_DISEASE_GENE_DISEASE_SCHEMA_ID =
  "inherited_disease_gene_evidence.gene_disease.v1";
export const INHERITED_DISEASE_CROSSWALK_SCHEMA_ID =
  "inherited_disease_gene_evidence.gene_evidence_crosswalk.v1";

export const INHERITED_DISEASE_GENE_TABLE_ID = "gene_records" as const;
export const INHERITED_DISEASE_DISEASE_TABLE_ID = "disease_records" as const;
export const INHERITED_DISEASE_GENE_DISEASE_TABLE_ID =
  "gene_disease_records" as const;
export const INHERITED_DISEASE_CROSSWALK_TABLE_ID =
  "gene_evidence_crosswalk" as const;

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    required?: boolean;
    nullable?: boolean;
    ontology?: string | null;
    description: string;
  },
): SchemaFieldV2 {
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
    derivation_policy: null,
  };
}

function optionalField(
  name: string,
  options: Omit<Parameters<typeof field>[1], "required" | "nullable">,
): SchemaFieldV2 {
  return field(name, { ...options, required: false, nullable: true });
}

export const inheritedDiseaseGeneSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: INHERITED_DISEASE_GENE_SCHEMA_ID,
  dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  primary_key: ["gene_id", "gene_namespace"],
  fields: [
    field("gene_id", {
      semanticRole: "entity_identifier",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Stable HGNC identifier for the approved gene record.",
    }),
    field("gene_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Identifier namespace for gene_id; fixed to hgnc.",
    }),
    field("gene_symbol", {
      semanticRole: "entity_label",
      description: "Approved HGNC gene symbol.",
    }),
    field("gene_name", {
      semanticRole: "entity_label",
      description: "Approved HGNC gene name.",
    }),
    field("status", {
      semanticRole: "record_status",
      description: "HGNC record status retained from the approved-gene source.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Task-owned source carrier that supplied this gene record.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      ontology: SOURCE_LOCATOR_ONTOLOGY,
      description: "SourceLocator 2.0 for the exact HGNC row or XML gene element.",
    }),
  ],
});

export const inheritedDiseaseDiseaseSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: INHERITED_DISEASE_DISEASE_SCHEMA_ID,
  dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  primary_key: ["disease_id", "disease_namespace"],
  fields: [
    field("disease_id", {
      semanticRole: "entity_identifier",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Orphanet disease identifier in ORPHA:<code> form.",
    }),
    field("disease_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Identifier namespace for disease_id; fixed to orphanet.",
    }),
    field("disease_name", {
      semanticRole: "entity_label",
      description: "English disease label reported by Orphanet.",
    }),
    optionalField("omim_id", {
      semanticRole: "crosswalk_identifier",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Optional OMIM identifier retained from Orphanet external references.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Task-owned source carrier that supplied this disease record.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      ontology: SOURCE_LOCATOR_ONTOLOGY,
      description: "SourceLocator 2.0 for the exact Orphanet disorder element.",
    }),
  ],
});

export const inheritedDiseaseGeneDiseaseSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: INHERITED_DISEASE_GENE_DISEASE_SCHEMA_ID,
  dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  primary_key: ["gene_disease_id"],
  fields: [
    field("gene_disease_id", {
      semanticRole: "row_identifier",
      description: "Stable identity of one HGNC-to-Orphanet association.",
    }),
    field("gene_id", {
      semanticRole: "foreign_key",
      ontology: NAMESPACE_ONTOLOGY,
      description: "HGNC gene referenced by the association.",
    }),
    field("gene_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Identifier namespace for gene_id; fixed to hgnc.",
    }),
    field("disease_id", {
      semanticRole: "foreign_key",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Orphanet disease referenced by the association.",
    }),
    field("disease_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Identifier namespace for disease_id; fixed to orphanet.",
    }),
    field("association_type", {
      semanticRole: "relation_token",
      ontology: RELATION_ONTOLOGY,
      description: "Exact association type token retained from the source.",
    }),
    field("classification", {
      semanticRole: "evidence_classification",
      description: "ClinGen classification when available, otherwise not_reported.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Task-owned source carrier supporting the retained association.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      ontology: SOURCE_LOCATOR_ONTOLOGY,
      description: "SourceLocator 2.0 for the exact association or validity row.",
    }),
  ],
});

export const inheritedDiseaseCrosswalkSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: INHERITED_DISEASE_CROSSWALK_SCHEMA_ID,
  dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  primary_key: ["crosswalk_id"],
  fields: [
    field("crosswalk_id", {
      semanticRole: "row_identifier",
      description: "Stable identity of one gene-to-evidence crosswalk row.",
    }),
    field("evidence_id", {
      semanticRole: "evidence_identifier",
      description: "Stable identifier of the ClinVar gene ESearch evidence response.",
    }),
    field("gene_id", {
      semanticRole: "foreign_key",
      ontology: NAMESPACE_ONTOLOGY,
      description: "HGNC gene covered by the evidence response.",
    }),
    field("gene_namespace", {
      semanticRole: "identifier_namespace",
      ontology: NAMESPACE_ONTOLOGY,
      description: "Identifier namespace for gene_id; fixed to hgnc.",
    }),
    field("evidence_source", {
      semanticRole: "evidence_source",
      description: "Controlled provider source that produced the evidence count.",
    }),
    field("pathogenic_count", {
      dataType: "integer",
      semanticRole: "evidence_measurement",
      description: "Non-negative ClinVar pathogenic/likely-pathogenic record count reported by the fixed ESearch query.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Task-owned ClinVar carrier supporting the crosswalk row.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      ontology: SOURCE_LOCATOR_ONTOLOGY,
      description: "SourceLocator 2.0 for the exact ClinVar JSON count/query fields.",
    }),
  ],
});

function table(
  tableId: string,
  schema: DatasetSchemaV2,
  role: "primary" | "supporting",
  allowEmpty = false,
): TableDefinition {
  return parseTableDefinition({
    table_id: tableId,
    schema_ref: schema.schema_id,
    role,
    required: true,
    allow_empty: allowEmpty,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  });
}

export const inheritedDiseaseGeneDefinition = table(
  INHERITED_DISEASE_GENE_TABLE_ID,
  inheritedDiseaseGeneSchema,
  "supporting",
);
export const inheritedDiseaseDiseaseDefinition = table(
  INHERITED_DISEASE_DISEASE_TABLE_ID,
  inheritedDiseaseDiseaseSchema,
  "supporting",
);
export const inheritedDiseaseGeneDiseaseDefinition = table(
  INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
  inheritedDiseaseGeneDiseaseSchema,
  "primary",
);
export const inheritedDiseaseCrosswalkDefinition = table(
  INHERITED_DISEASE_CROSSWALK_TABLE_ID,
  inheritedDiseaseCrosswalkSchema,
  "supporting",
);

export const inheritedDiseaseEvidenceTables: readonly InheritedDiseaseEvidenceTableEntry[] =
  Object.freeze([
    {
      tableId: INHERITED_DISEASE_GENE_TABLE_ID,
      schema: inheritedDiseaseGeneSchema,
      definition: inheritedDiseaseGeneDefinition,
    },
    {
      tableId: INHERITED_DISEASE_DISEASE_TABLE_ID,
      schema: inheritedDiseaseDiseaseSchema,
      definition: inheritedDiseaseDiseaseDefinition,
    },
    {
      tableId: INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
      schema: inheritedDiseaseGeneDiseaseSchema,
      definition: inheritedDiseaseGeneDiseaseDefinition,
    },
    {
      tableId: INHERITED_DISEASE_CROSSWALK_TABLE_ID,
      schema: inheritedDiseaseCrosswalkSchema,
      definition: inheritedDiseaseCrosswalkDefinition,
    },
  ]);

export const inheritedDiseaseEvidenceSchemas: readonly DatasetSchemaV2[] = Object.freeze(
  inheritedDiseaseEvidenceTables.map((entry) => entry.schema),
);

export const inheritedDiseaseEvidenceRelations: readonly RelationDefinition[] = Object.freeze([
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "inherited_disease_gene_disease_gene",
    fromTableId: INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
    fromFields: ["gene_id", "gene_namespace"],
    toTableId: INHERITED_DISEASE_GENE_TABLE_ID,
    toFields: ["gene_id", "gene_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "inherited_disease_gene_disease_disease",
    fromTableId: INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
    fromFields: ["disease_id", "disease_namespace"],
    toTableId: INHERITED_DISEASE_DISEASE_TABLE_ID,
    toFields: ["disease_id", "disease_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "inherited_disease_evidence_gene",
    fromTableId: INHERITED_DISEASE_CROSSWALK_TABLE_ID,
    fromFields: ["gene_id", "gene_namespace"],
    toTableId: INHERITED_DISEASE_GENE_TABLE_ID,
    toFields: ["gene_id", "gene_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
]);

export function inheritedDiseaseEvidenceValidationPolicy(): MultiTableValidationPolicy {
  return {
    token_preservation_rules: [
      {
        table_id: INHERITED_DISEASE_GENE_DISEASE_TABLE_ID,
        source_field: "association_type",
        output_field: "association_type",
        token_kind: "relation",
      },
    ],
    profile_relation_missing_policies: {},
  };
}