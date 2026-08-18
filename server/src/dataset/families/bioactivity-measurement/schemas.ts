import type {
  DatasetSchemaV2,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";

import {
  buildAssayTable,
  buildBiomedicalRelation,
  buildCompoundTable,
  buildEntityTable,
} from "../../schema/common/index.js";
import {
  parseDatasetSchemaV2,
  parseTableDefinition,
  type MultiTableValidationPolicy,
} from "../../contracts/index.js";
import {
  BIOACTIVITY_FAMILY_ID,
  BIOACTIVITY_ROW_GRANULARITY,
  type BioactivityTableId,
} from "./types.js";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    unitPolicy?: string | null;
    ontology?: string | null;
    description: string;
  },
): DatasetSchemaV2["fields"][number] {
  return {
    schema_version: "2.0",
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole,
    required: true,
    nullable: false,
    unit_policy: options.unitPolicy ?? null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

export const bioactivityActivitySchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.activity.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: BIOACTIVITY_ROW_GRANULARITY,
  primary_key: ["activity_id"],
  fields: [
    field("activity_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for one source activity measurement.",
    }),
    field("compound_id", {
      semanticRole: "foreign_key",
      description: "Compound measured in the activity record.",
    }),
    field("compound_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: "biomed:id_namespace.v1",
      description: "Controlled authority for compound_id.",
    }),
    field("assay_id", {
      semanticRole: "foreign_key",
      description: "Assay that produced the activity measurement.",
    }),
    field("assay_id_namespace", {
      semanticRole: "identifier_namespace",
      ontology: "biomed:id_namespace.v1",
      description: "Controlled authority for assay_id.",
    }),
    field("target_id", {
      semanticRole: "foreign_key",
      description: "Target measured by the activity record.",
    }),
    field("target_namespace", {
      semanticRole: "identifier_namespace",
      ontology: "biomed:id_namespace.v1",
      description: "Controlled authority for target_id.",
    }),
    field("activity_type", {
      semanticRole: "measurement_type",
      description: "Endpoint type reported by the source, such as IC50 or Ki.",
    }),
    field("raw_value", {
      semanticRole: "raw_measurement_value",
      description: "Verbatim numeric value token reported by the source.",
    }),
    field("raw_relation", {
      semanticRole: "raw_relation_token",
      unitPolicy: "preserve_original",
      ontology: "biomed:measurement_relation.v1",
      description: "Verbatim comparison token reported by the source.",
    }),
    field("preserved_relation", {
      semanticRole: "preserved_relation_token",
      unitPolicy: "preserve_original",
      ontology: "biomed:measurement_relation.v1",
      description: "Output copy of raw_relation used by the token-preservation gate.",
    }),
    field("raw_unit", {
      semanticRole: "raw_unit_token",
      unitPolicy: "preserve_original",
      description: "Verbatim unit token reported by the source.",
    }),
    field("preserved_raw_unit", {
      semanticRole: "preserved_unit_token",
      unitPolicy: "preserve_original",
      description: "Output copy of raw_unit used by the token-preservation gate.",
    }),
    field("standardized_value", {
      dataType: "float",
      semanticRole: "standardized_measurement_value",
      description: "Finite normalized measurement value without replacing raw_value.",
    }),
    field("standardized_unit", {
      semanticRole: "standardized_measurement_unit",
      ontology: "biomed:unit.v1",
      description: "Controlled unit for standardized_value.",
    }),
    field("source_id", {
      semanticRole: "provenance_source_identifier",
      description: "Source carrier identity retained for row-level provenance.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Core-registered immutable SourceAsset carrying this record.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "SourceLocator 2.0 locating the exact source activity record.",
    }),
  ],
});

const compound = buildCompoundTable({
  datasetFamily: BIOACTIVITY_FAMILY_ID,
  schemaId: "bioactivity_measurement.compound.v1",
  rowGranularity: "one compound identity used by an activity measurement",
  tableId: "compounds",
  role: "supporting",
});

const assay = buildAssayTable({
  datasetFamily: BIOACTIVITY_FAMILY_ID,
  schemaId: "bioactivity_measurement.assay.v1",
  rowGranularity: "one assay definition used by an activity measurement",
  tableId: "assays",
  role: "supporting",
});

const target = buildEntityTable({
  datasetFamily: BIOACTIVITY_FAMILY_ID,
  schemaId: "bioactivity_measurement.target.v1",
  rowGranularity: "one target identity used by an activity measurement",
  tableId: "targets",
  role: "supporting",
});

export const bioactivityCompoundSchema = compound.schema;
export const bioactivityAssaySchema = assay.schema;
export const bioactivityTargetSchema = target.schema;

export const bioactivityActivityTable: TableDefinition = parseTableDefinition({
  table_id: "activities",
  schema_ref: bioactivityActivitySchema.schema_id,
  role: "primary",
  required: true,
  allow_empty: false,
  primary_key: [...bioactivityActivitySchema.primary_key],
  field_names: bioactivityActivitySchema.fields.map((item) => item.name),
});

export const bioactivityRelations: readonly RelationDefinition[] = Object.freeze([
  buildBiomedicalRelation({
    relationType: "compound_has_activity",
    relationId: "activity_compound",
    fromTableId: "activities",
    fromFields: ["compound_id", "compound_id_namespace"],
    toTableId: "compounds",
    toFields: ["compound_id", "compound_id_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "assay_measures_target",
    relationId: "activity_assay",
    fromTableId: "activities",
    fromFields: ["assay_id", "assay_id_namespace"],
    toTableId: "assays",
    toFields: ["assay_id", "assay_id_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "assay_measures_target",
    relationId: "activity_target",
    fromTableId: "activities",
    fromFields: ["target_id", "target_namespace"],
    toTableId: "targets",
    toFields: ["entity_id", "entity_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "assay_measures_target",
    relationId: "assay_target",
    fromTableId: "assays",
    fromFields: ["target_entity_id", "target_entity_namespace"],
    toTableId: "targets",
    toFields: ["entity_id", "entity_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
]);

export function buildBioactivityTables() {
  return {
    activities: {
      schema: bioactivityActivitySchema,
      definition: bioactivityActivityTable,
    },
    compounds: compound,
    assays: assay,
    targets: target,
    relations: bioactivityRelations,
  } as const;
}

export function bioactivityTableEntries(): readonly {
  tableId: BioactivityTableId;
  schema: DatasetSchemaV2;
  definition: TableDefinition;
}[] {
  const tables = buildBioactivityTables();
  return [
    { tableId: "activities", ...tables.activities },
    { tableId: "compounds", ...tables.compounds },
    { tableId: "assays", ...tables.assays },
    { tableId: "targets", ...tables.targets },
  ];
}

export function bioactivityValidationPolicy(): MultiTableValidationPolicy {
  return {
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
        output_field: "preserved_raw_unit",
        token_kind: "unit",
      },
      {
        table_id: "activities",
        source_field: "standardized_unit",
        output_field: "standardized_unit",
        token_kind: "unit",
      },
    ],
    profile_relation_missing_policies: {},
  };
}
