import type {
  DatasetSchemaV2,
  RelationDefinition,
  SchemaFieldV2,
  TableDefinition,
} from "@biomed/contracts";

import {
  parseDatasetSchemaV2,
  parseRelationDefinition,
  parseTableDefinition,
} from "../../../contracts/index.js";
import { BIOACTIVITY_FAMILY_ID } from "../types.js";
import {
  ACTIVITY_VALUE_RECORDS_TABLE_ID,
  EXPERIMENT_RECORDS_TABLE_ID,
  GOLD6_REFERENCE_ROLES,
  PAPER_RECORDS_TABLE_ID,
  SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
} from "./types.js";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole: string;
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
    required: true,
    nullable: options.nullable ?? false,
    unit_policy: null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

// Schema field order keeps the gold6-reference columns as a frozen prefix;
// provenance fields required by the same reference are appended after them.
export const paperRecordSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.paper_record.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one paper",
  primary_key: ["pmid", "pmcid", "doi"],
  fields: [
    field("pmid", { semanticRole: "paper_identifier", description: "PubMed identifier, or the explicit absent token when unreported." }),
    field("pmcid", { semanticRole: "paper_identifier", description: "PMC identifier, or the explicit absent token when unreported." }),
    field("doi", { semanticRole: "paper_identifier", description: "Digital Object Identifier, or the explicit absent token when unreported." }),
    field("title", { semanticRole: "entity_label", description: "Paper title as reported by the source." }),
    field("journal", { semanticRole: "attribute", nullable: true, description: "Journal or proceedings title when reported." }),
    field("publication_date", { semanticRole: "attribute", nullable: true, description: "Publication date in ISO 8601 date form when reported." }),
    field("authors", { dataType: "json", semanticRole: "attribute", nullable: true, description: "Ordered JSON array of author names when reported." }),
    field("open_access_status", { semanticRole: "attribute", nullable: true, description: "Open access status such as gold, hybrid, or closed." }),
    field("source_url", { semanticRole: "source_locator", nullable: true, description: "Canonical landing-page URL for the paper." }),
    field("paper_key", { semanticRole: "paper_identifier", description: "Deterministic digest-derived join key of the pmid, pmcid, and doi identity triple." }),
    field("source_id", { semanticRole: "foreign_key", description: "Source carrier identity retained for row-level provenance." }),
  ],
});

export const experimentRecordSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.experiment_record.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one paper experiment",
  primary_key: ["experiment_id"],
  fields: [
    field("experiment_id", { semanticRole: "row_identifier", description: "Stable experiment identifier as reported by the paper evidence." }),
    field("paper_id", { semanticRole: "foreign_key", description: "Composite paper_records key carrying this experiment." }),
    field("protein", { semanticRole: "attribute", description: "Studied protein or gene symbol as reported by the paper." }),
    field("variant", { semanticRole: "attribute", nullable: true, description: "Protein variant or mutation when reported." }),
    field("construct", { semanticRole: "attribute", nullable: true, description: "Construct description when reported." }),
    field("ligand", { semanticRole: "attribute", nullable: true, description: "Ligand or probe used by the experiment when reported." }),
    field("assay_type", { semanticRole: "assay_type", description: "Assay category or measurement type reported by the paper." }),
    field("cell_line_or_system", { semanticRole: "attribute", nullable: true, description: "Cell line or experimental system when reported." }),
    field("temperature", { semanticRole: "experiment_condition", nullable: true, description: "Reported experiment temperature." }),
    field("buffer", { semanticRole: "experiment_condition", nullable: true, description: "Reported buffer or medium." }),
    field("incubation_time", { semanticRole: "experiment_condition", nullable: true, description: "Reported incubation time." }),
    field("source_locator", { dataType: "json", semanticRole: "source_locator", description: "SourceLocator 2.0 locating the experiment description." }),
    field("extraction_method", { semanticRole: "extraction_method", description: "Controlled extraction method used for this experiment record." }),
  ],
});

export const activityValueRecordSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.activity_value_record.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one extracted activity value",
  primary_key: ["experiment_id", "compound", "protein_variant", "activity_type", "table_or_figure", "row_label", "column_label"],
  fields: [
    field("experiment_id", { semanticRole: "foreign_key", description: "Experiment that produced this activity value." }),
    field("compound", { semanticRole: "entity_label", description: "Compound name exactly as reported by the paper." }),
    field("protein_variant", { semanticRole: "attribute", description: "Protein or protein variant the value is reported against." }),
    field("activity_type", { semanticRole: "measurement_type", description: "Endpoint type reported by the paper, such as IC50 or Ki." }),
    field("activity_value", { semanticRole: "raw_measurement_value", description: "Verbatim numeric value token reported by the paper." }),
    field("activity_unit", { semanticRole: "raw_unit_token", description: "Verbatim unit token reported by the paper." }),
    field("relation", { semanticRole: "raw_relation_token", description: "Verbatim comparison token reported by the paper." }),
    field("replicate_count", { dataType: "integer", semanticRole: "attribute", nullable: true, description: "Replicate count when reported." }),
    field("error_value", { dataType: "float", semanticRole: "attribute", nullable: true, description: "Reported error or dispersion value." }),
    field("error_type", { semanticRole: "attribute", nullable: true, description: "Reported error type such as standard deviation." }),
    field("original_text", { semanticRole: "extracted_text", description: "Verbatim source sentence or cell text the value was extracted from." }),
    field("table_or_figure", { semanticRole: "source_table_or_figure", description: "Table or figure identifier carrying the value; explicit absent token when unreported." }),
    field("page_number", { dataType: "integer", semanticRole: "attribute", nullable: true, description: "Page number carrying the value when known." }),
    field("row_label", { semanticRole: "attribute", description: "Source row label; explicit absent token when unreported." }),
    field("column_label", { semanticRole: "attribute", description: "Source column label; explicit absent token when unreported." }),
    field("confidence_level", { semanticRole: "confidence", ontology: "biomed:confidence_level.v1", description: "Extraction confidence assigned to this value." }),
    field("source_id", { semanticRole: "provenance_source_identifier", description: "Source carrier identity retained for row-level provenance." }),
    field("source_asset_id", { semanticRole: "source_asset_reference", description: "Core-registered immutable SourceAsset carrying this record." }),
    field("source_locator", { dataType: "json", semanticRole: "source_locator", description: "SourceLocator 2.0 locating the exact extracted value." }),
    field("retrieved_at", { dataType: "datetime", semanticRole: "provenance", description: "ISO 8601 retrieval timestamp." }),
  ],
});

export const supplementaryAssetRecordSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.supplementary_asset_record.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one supplementary asset",
  primary_key: ["paper_id", "asset_name"],
  fields: [
    field("paper_id", { semanticRole: "foreign_key", description: "Composite paper_records key owning this asset." }),
    field("asset_name", { semanticRole: "asset_identifier", description: "Asset file name or stable label as published." }),
    field("asset_type", { semanticRole: "attribute", description: "Asset form such as csv_table, pdf_document, or image." }),
    field("download_url", { semanticRole: "attribute", nullable: true, description: "Download URL when available." }),
    field("sha256", { semanticRole: "content_digest", description: "Lowercase SHA-256 digest of the asset bytes." }),
    field("file_size", { dataType: "integer", semanticRole: "attribute", nullable: true, description: "Asset size in bytes when known." }),
    field("parse_status", { semanticRole: "attribute", description: "Honest parse outcome such as parsed, unsupported, or failed." }),
    field("table_count", { dataType: "integer", semanticRole: "attribute", nullable: true, description: "Number of tables recovered from the asset when parsed." }),
    field("source_locator", { dataType: "json", semanticRole: "source_locator", description: "SourceLocator 2.0 locating the registered asset content." }),
    field("source_asset_id", { semanticRole: "source_asset_reference", description: "Core-registered immutable SourceAsset holding the supplementary bytes." }),
  ],
});

function definition(
  tableId: string,
  schema: DatasetSchemaV2,
  role: TableDefinition["role"],
): TableDefinition {
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

export const paperRecordTable: TableDefinition = definition(
  PAPER_RECORDS_TABLE_ID,
  paperRecordSchema,
  "supporting",
);
export const experimentRecordTable: TableDefinition = definition(
  EXPERIMENT_RECORDS_TABLE_ID,
  experimentRecordSchema,
  "supporting",
);
export const activityValueRecordTable: TableDefinition = definition(
  ACTIVITY_VALUE_RECORDS_TABLE_ID,
  activityValueRecordSchema,
  "supporting",
);
export const supplementaryAssetRecordTable: TableDefinition = definition(
  SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
  supplementaryAssetRecordSchema,
  "supporting",
);

export const paperEvidenceTables = [
  {
    schema: paperRecordSchema,
    definition: paperRecordTable,
    gold6ReferenceRole: GOLD6_REFERENCE_ROLES[PAPER_RECORDS_TABLE_ID],
  },
  {
    schema: experimentRecordSchema,
    definition: experimentRecordTable,
    gold6ReferenceRole: GOLD6_REFERENCE_ROLES[EXPERIMENT_RECORDS_TABLE_ID],
  },
  {
    schema: activityValueRecordSchema,
    definition: activityValueRecordTable,
    gold6ReferenceRole: GOLD6_REFERENCE_ROLES[ACTIVITY_VALUE_RECORDS_TABLE_ID],
  },
  {
    schema: supplementaryAssetRecordSchema,
    definition: supplementaryAssetRecordTable,
    gold6ReferenceRole: GOLD6_REFERENCE_ROLES[SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID],
  },
] as const;

function relation(value: RelationDefinition): RelationDefinition {
  return parseRelationDefinition(value);
}

export const paperEvidenceRelations: readonly RelationDefinition[] = [
  relation({
    relation_id: "experiment_paper",
    from_table_id: EXPERIMENT_RECORDS_TABLE_ID,
    from_fields: ["paper_id"],
    to_table_id: PAPER_RECORDS_TABLE_ID,
    to_fields: ["paper_key"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "activity_value_experiment",
    from_table_id: ACTIVITY_VALUE_RECORDS_TABLE_ID,
    from_fields: ["experiment_id"],
    to_table_id: EXPERIMENT_RECORDS_TABLE_ID,
    to_fields: ["experiment_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "chart_series_paper_record",
    from_table_id: "chart_series",
    from_fields: ["paper_id"],
    to_table_id: PAPER_RECORDS_TABLE_ID,
    to_fields: ["paper_key"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
];
