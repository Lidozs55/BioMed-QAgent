import type {
  DatasetSchemaV2,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";
import {
  buildBiomedicalRelation,
  buildSourceTable,
} from "../../schema/common/index.js";
import {
  parseDatasetSchemaV2,
  parseTableDefinition,
  type MultiTableValidationPolicy,
} from "../../contracts/index.js";

export const GUT_MICROBIOME_FAMILY_ID = "gut_microbiome";
export const GUT_MICROBIOME_STUDY_SCHEMA_ID = "gut_microbiome.study.v1";
/** Stable schema ID for the original MGnify wide-matrix carrier. */
export const GUT_MICROBIOME_TAXON_SCHEMA_ID = "gut_microbiome.taxon.v1";
/** Schema ID for the strict long-form taxon_records publication table. */
export const GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID = "gut_microbiome.taxon_records.v1";
export const GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_SCHEMA_ID = "gut_microbiome.differential_abundance.v1";
export const GUT_MICROBIOME_REFERENCE_PREVALENCE_SCHEMA_ID = "gut_microbiome.reference_prevalence.v1";

export const GUT_MICROBIOME_STUDY_TABLE_ID = "study_records";
export const GUT_MICROBIOME_TAXON_TABLE_ID = "taxon_records";
export const GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_TABLE_ID = "differential_abundance_records";
export const GUT_MICROBIOME_REFERENCE_PREVALENCE_TABLE_ID = "reference_prevalence_records";

export const GUT_MICROBIOME_ROW_GRANULARITY = "one gut microbiome disease association study";
export const GUT_MICROBIOME_TAXON_ROW_GRANULARITY = "one taxon abundance record per sample";
export const GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_ROW_GRANULARITY = "one differential abundance result per study taxon";
export const GUT_MICROBIOME_REFERENCE_PREVALENCE_ROW_GRANULARITY = "one reference prevalence result per study taxon";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
    required?: boolean;
    nullable?: boolean;
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
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: options.unitPolicy ?? null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

function optionalField(
  name: string,
  options: Parameters<typeof field>[1],
): DatasetSchemaV2["fields"][number] {
  return field(name, { ...options, required: false, nullable: true });
}

export const gutMicrobiomeStudySchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: GUT_MICROBIOME_STUDY_SCHEMA_ID,
  dataset_family: GUT_MICROBIOME_FAMILY_ID,
  row_granularity: GUT_MICROBIOME_ROW_GRANULARITY,
  primary_key: ["study_id"],
  fields: [
    field("study_id", {
      semanticRole: "study_identifier",
      description: "Stable MGnify or repository study identifier.",
    }),
    field("study_accession", {
      semanticRole: "source_accession",
      description: "Public study accession used to bind all study-derived tables.",
    }),
    field("study_title", {
      semanticRole: "entity_label",
      description: "Study title from the fixed study metadata carrier.",
    }),
    field("disease_id", {
      semanticRole: "disease_identifier",
      ontology: "MeSH",
      description: "Disease identifier used for the association query.",
    }),
    field("disease_name", {
      semanticRole: "disease_label",
      description: "Disease name exactly as declared by the study carrier.",
    }),
    field("host_taxon_id", {
      semanticRole: "taxon_identifier",
      ontology: "NCBI Taxonomy",
      description: "NCBI Taxonomy identifier for the host species.",
    }),
    field("sample_count", {
      dataType: "integer",
      semanticRole: "sample_count",
      description: "Number of samples represented by the study.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record supporting this study row.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Task-owned Core asset containing the exact study record.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "SourceLocator 2.0 for the exact study record.",
    }),
  ],
});

export const gutMicrobiomeTaxonSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID,
  dataset_family: GUT_MICROBIOME_FAMILY_ID,
  row_granularity: GUT_MICROBIOME_TAXON_ROW_GRANULARITY,
  primary_key: ["study_id", "sample_id", "taxon_path"],
  fields: [
    field("study_id", {
      semanticRole: "foreign_key",
      description: "Study whose sample contains this taxonomy measurement.",
    }),
    field("sample_id", {
      semanticRole: "sample_identifier",
      description: "Source sample accession from the MGnify taxonomy matrix.",
    }),
    field("taxon_path", {
      semanticRole: "taxon_lineage",
      ontology: "NCBI Taxonomy",
      description: "Taxonomic lineage token exactly as supplied by MGnify.",
    }),
    field("taxon_id", {
      semanticRole: "taxon_identifier",
      ontology: "NCBI Taxonomy",
      description: "Resolved NCBI Taxonomy identifier for the terminal taxon.",
    }),
    field("abundance", {
      dataType: "integer",
      semanticRole: "abundance_measurement",
      unitPolicy: "read_count",
      description: "Integer taxon abundance reported by the MGnify TSV.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record supporting this taxonomy row.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Task-owned Core asset containing the exact taxonomy carrier.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "SourceLocator 2.0 for the exact taxonomy cell.",
    }),
  ],
});

/**
 * Compatibility schema for the original MGnify wide matrix carrier. It
 * intentionally has the same stable schema ID as the historical parser; it is
 * registered only with the compatibility adapter and is not admitted by the
 * four-table family definition. The formal family uses gutMicrobiomeTaxonSchema
 * above and the independent long-form adapter.
 */
export const gutMicrobiomeTaxonMatrixSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: GUT_MICROBIOME_TAXON_SCHEMA_ID,
  dataset_family: GUT_MICROBIOME_FAMILY_ID,
  row_granularity: GUT_MICROBIOME_TAXON_ROW_GRANULARITY,
  primary_key: ["sample_id", "taxon_path"],
  fields: [
    field("sample_id", {
      semanticRole: "sample_identifier",
      description: "Source sample accession from the MGnify taxonomy matrix.",
    }),
    field("taxon_path", {
      semanticRole: "taxon_lineage",
      ontology: "NCBI Taxonomy",
      description: "Taxonomic lineage token exactly as supplied by MGnify.",
    }),
    field("abundance", {
      dataType: "integer",
      semanticRole: "abundance_measurement",
      unitPolicy: "read_count",
      description: "Integer taxon abundance reported by the MGnify TSV.",
    }),
  ],
});

export const gutMicrobiomeDifferentialAbundanceSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_SCHEMA_ID,
  dataset_family: GUT_MICROBIOME_FAMILY_ID,
  row_granularity: GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_ROW_GRANULARITY,
  primary_key: ["study_id", "taxon_id", "comparison_id"],
  fields: [
    field("study_id", {
      semanticRole: "foreign_key",
      description: "Study whose groups produced this comparison.",
    }),
    field("taxon_id", {
      semanticRole: "foreign_key",
      ontology: "NCBI Taxonomy",
      description: "Resolved NCBI Taxonomy identifier tested for differential abundance.",
    }),
    field("comparison_id", {
      semanticRole: "comparison_identifier",
      description: "Stable comparison identifier within the study.",
    }),
    field("comparison_label", {
      semanticRole: "comparison_label",
      description: "Case/control or group comparison label.",
    }),
    field("effect_size", {
      dataType: "float",
      semanticRole: "effect_size",
      description: "Reported differential abundance effect size.",
    }),
    field("p_value", {
      dataType: "float",
      semanticRole: "p_value",
      description: "Unadjusted significance value from the source table.",
    }),
    optionalField("adjusted_p_value", {
      dataType: "float",
      semanticRole: "adjusted_p_value",
      description: "Multiple-testing adjusted significance value when reported.",
    }),
    field("effect_direction", {
      semanticRole: "effect_direction",
      description: "Direction of the reported association, increase or decrease.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record supporting this result.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Task-owned Core asset containing the exact differential result.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "SourceLocator 2.0 for the exact spreadsheet cell row.",
    }),
  ],
});

export const gutMicrobiomeReferencePrevalenceSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: GUT_MICROBIOME_REFERENCE_PREVALENCE_SCHEMA_ID,
  dataset_family: GUT_MICROBIOME_FAMILY_ID,
  row_granularity: GUT_MICROBIOME_REFERENCE_PREVALENCE_ROW_GRANULARITY,
  primary_key: ["study_id", "taxon_id", "reference_group"],
  fields: [
    field("study_id", {
      semanticRole: "foreign_key",
      description: "Study associated with this reference prevalence result.",
    }),
    field("taxon_id", {
      semanticRole: "foreign_key",
      ontology: "NCBI Taxonomy",
      description: "Resolved NCBI Taxonomy identifier for the prevalence taxon.",
    }),
    field("reference_group", {
      semanticRole: "reference_group",
      description: "Reference cohort label used by the prevalence estimate.",
    }),
    field("prevalence", {
      dataType: "float",
      semanticRole: "prevalence_measurement",
      unitPolicy: "fraction_0_1",
      description: "Fraction of reference samples containing the taxon.",
    }),
    field("reference_sample_count", {
      dataType: "integer",
      semanticRole: "sample_count",
      description: "Reference cohort sample count.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record supporting this prevalence result.",
    }),
    field("source_asset_id", {
      semanticRole: "source_asset_reference",
      description: "Task-owned Core asset containing the exact prevalence result.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "SourceLocator 2.0 for the exact prevalence record.",
    }),
  ],
});

export const gutMicrobiomeSourceSchema = buildSourceTable({
  datasetFamily: GUT_MICROBIOME_FAMILY_ID,
  schemaId: "gut_microbiome.source.v1",
  rowGranularity: "one gut microbiome source carrier record",
  tableId: "sources",
  role: "supporting",
});

export const gutMicrobiomeSchemas = Object.freeze([
  gutMicrobiomeStudySchema,
  gutMicrobiomeTaxonSchema,
  gutMicrobiomeDifferentialAbundanceSchema,
  gutMicrobiomeReferencePrevalenceSchema,
]);

export const gutMicrobiomeAllSchemas = Object.freeze([
  ...gutMicrobiomeSchemas,
  gutMicrobiomeSourceSchema.schema,
]);

export const gutMicrobiomeRelations: readonly RelationDefinition[] = Object.freeze([
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "taxon_study",
    fromTableId: GUT_MICROBIOME_TAXON_TABLE_ID,
    fromFields: ["study_id"],
    toTableId: GUT_MICROBIOME_STUDY_TABLE_ID,
    toFields: ["study_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "differential_abundance_study",
    fromTableId: GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_TABLE_ID,
    fromFields: ["study_id"],
    toTableId: GUT_MICROBIOME_STUDY_TABLE_ID,
    toFields: ["study_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "reference_prevalence_study",
    fromTableId: GUT_MICROBIOME_REFERENCE_PREVALENCE_TABLE_ID,
    fromFields: ["study_id"],
    toTableId: GUT_MICROBIOME_STUDY_TABLE_ID,
    toFields: ["study_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "differential_abundance_taxon",
    fromTableId: GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_TABLE_ID,
    fromFields: ["study_id", "taxon_id"],
    toTableId: GUT_MICROBIOME_TAXON_TABLE_ID,
    toFields: ["study_id", "taxon_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "reference_prevalence_taxon",
    fromTableId: GUT_MICROBIOME_REFERENCE_PREVALENCE_TABLE_ID,
    fromFields: ["study_id", "taxon_id"],
    toTableId: GUT_MICROBIOME_TAXON_TABLE_ID,
    toFields: ["study_id", "taxon_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  ...([
    GUT_MICROBIOME_STUDY_TABLE_ID,
    GUT_MICROBIOME_TAXON_TABLE_ID,
    GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_TABLE_ID,
    GUT_MICROBIOME_REFERENCE_PREVALENCE_TABLE_ID,
  ] as const).map((tableId) => buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: `${tableId}_source`,
    fromTableId: tableId,
    fromFields: ["source_id"],
    toTableId: "sources",
    toFields: ["source_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  })),
]);

function tableDefinition(tableId: string, schema: DatasetSchemaV2, role: "primary" | "supporting"): TableDefinition {
  return parseTableDefinition({
    table_id: tableId,
    schema_ref: schema.schema_id,
    role,
    required: true,
    allow_empty: false,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  });
}

export function gutMicrobiomeTableDefinitions(): readonly TableDefinition[] {
  return [
    tableDefinition(GUT_MICROBIOME_STUDY_TABLE_ID, gutMicrobiomeStudySchema, "primary"),
    tableDefinition(GUT_MICROBIOME_TAXON_TABLE_ID, gutMicrobiomeTaxonSchema, "supporting"),
    tableDefinition(GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_TABLE_ID, gutMicrobiomeDifferentialAbundanceSchema, "supporting"),
    tableDefinition(GUT_MICROBIOME_REFERENCE_PREVALENCE_TABLE_ID, gutMicrobiomeReferencePrevalenceSchema, "supporting"),
  ];
}

export function gutMicrobiomeSourceTableDefinition(): TableDefinition {
  return gutMicrobiomeSourceSchema.definition;
}

export function gutMicrobiomeValidationPolicy(): MultiTableValidationPolicy {
  return { token_preservation_rules: [], profile_relation_missing_policies: {} };
}
