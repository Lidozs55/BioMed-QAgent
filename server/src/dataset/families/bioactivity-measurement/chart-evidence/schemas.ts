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
import {
  buildPaperTable,
  buildSourceTable,
} from "../../../schema/common/index.js";
import { BIOACTIVITY_FAMILY_ID } from "../types.js";
import {
  CHART_PAPERS_TABLE_ID,
  CHART_POINTS_TABLE_ID,
  CHART_SERIES_TABLE_ID,
  CHART_SOURCES_TABLE_ID,
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

export const chartSeriesSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.chart_series.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one extracted series in one paper figure",
  primary_key: ["chart_series_id"],
  fields: [
    field("chart_series_id", { semanticRole: "row_identifier", description: "Stable chart-series identifier." }),
    field("paper_id", { semanticRole: "foreign_key", description: "Paper containing the figure." }),
    field("paper_id_namespace", { semanticRole: "identifier_namespace", ontology: "biomed:id_namespace.v1", description: "Authority for paper_id." }),
    field("figure_id", { semanticRole: "figure_identifier", description: "Figure or panel identifier in the paper." }),
    field("series_label", { semanticRole: "chart_series_label", description: "Legend label for the series." }),
    field("x_axis_name", { semanticRole: "axis_label", description: "Extracted x-axis label." }),
    field("x_axis_unit", { semanticRole: "axis_unit", description: "Extracted x-axis unit; use an explicit none token when dimensionless." }),
    field("y_axis_name", { semanticRole: "axis_label", description: "Extracted y-axis label." }),
    field("y_axis_unit", { semanticRole: "axis_unit", description: "Extracted y-axis unit; use an explicit none token when dimensionless." }),
    field("x_scale", { semanticRole: "axis_scale", description: "Extracted x-axis scale." }),
    field("y_scale", { semanticRole: "axis_scale", description: "Extracted y-axis scale." }),
    field("legend_text", { semanticRole: "legend_text", description: "Verbatim visible legend text." }),
    field("axis_validation_status", { semanticRole: "axis_validation_status", ontology: "biomed:chart_axis_status.v1", description: "Whether axis semantics are clear or human validated." }),
    field("legend_validation_status", { semanticRole: "legend_validation_status", ontology: "biomed:chart_legend_status.v1", description: "Whether legend semantics are clear or human validated." }),
    field("human_review_status", { semanticRole: "human_review_status", ontology: "biomed:human_review_status.v1", description: "Review state for this series." }),
    field("source_id", { semanticRole: "foreign_key", description: "Source carrier for this figure." }),
    field("source_asset_id", { semanticRole: "source_asset_reference", description: "Core-registered immutable image or PDF asset." }),
    field("source_locator", { dataType: "json", semanticRole: "source_locator", description: "SourceLocator 2.0 image bbox for the figure." }),
    field("model_name", { semanticRole: "extraction_model", description: "VLM model name." }),
    field("model_version", { semanticRole: "extraction_model_version", description: "Pinned VLM model version." }),
    field("extraction_method", { semanticRole: "extraction_method", description: "Controlled extraction method; VLM for this module." }),
    field("extraction_confidence", { semanticRole: "confidence", ontology: "biomed:confidence_level.v1", description: "Evidence quality assigned to the extracted series." }),
    field("source_reliability", { semanticRole: "source_reliability", ontology: "biomed:reliability_level.v1", description: "Reliability of the source carrier, independent of review acceptance." }),
    field("extraction_reliability", { semanticRole: "extraction_reliability", ontology: "biomed:reliability_level.v1", description: "Reliability of the extraction, independent of review acceptance." }),
    field("transform_provenance", { dataType: "json", semanticRole: "transform_provenance", description: "Model, transforms, digests, and human review provenance." }),
  ],
});

export const chartPointSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: "bioactivity_measurement.chart_point.v1",
  dataset_family: BIOACTIVITY_FAMILY_ID,
  row_granularity: "one extracted coordinate in one chart series linked to one activity measurement",
  primary_key: ["point_id"],
  fields: [
    field("point_id", { semanticRole: "row_identifier", description: "Stable chart-point identifier." }),
    field("chart_series_id", { semanticRole: "foreign_key", description: "Owning chart series." }),
    field("activity_id", { semanticRole: "foreign_key", description: "Primary activity measurement represented by this point." }),
    field("x_value", { semanticRole: "chart_coordinate", description: "Extracted x coordinate token." }),
    field("y_value", { semanticRole: "chart_coordinate", description: "Extracted y coordinate token." }),
    field("point_type", { semanticRole: "chart_point_type", description: "Point, bar, line vertex, error bound, or related visual mark." }),
    field("estimated_or_exact", { semanticRole: "measurement_precision", ontology: "biomed:chart_value_precision.v1", description: "Whether the value is exact from labels/data or visually estimated." }),
    field("pixel_or_coordinate_locator", { dataType: "json", semanticRole: "source_locator", description: "Image bbox locating the mark or coordinate evidence." }),
    field("extraction_confidence", { semanticRole: "confidence", ontology: "biomed:confidence_level.v1", description: "Point-level extraction confidence." }),
    field("confidence_reason", { semanticRole: "confidence_explanation", description: "Concrete reason for the confidence level." }),
    field("review_status", { semanticRole: "human_review_status", ontology: "biomed:human_review_status.v1", description: "Point-level human review state." }),
    field("review_id", { semanticRole: "human_review_reference", nullable: true, description: "Durable review identifier when reviewed." }),
    field("source_reliability", { semanticRole: "source_reliability", ontology: "biomed:reliability_level.v1", description: "Source reliability retained through review." }),
    field("extraction_reliability", { semanticRole: "extraction_reliability", ontology: "biomed:reliability_level.v1", description: "Extraction reliability retained through review." }),
    field("original_x_value", { semanticRole: "pre_transform_value", nullable: true, description: "Original x token before a correction or transform." }),
    field("original_y_value", { semanticRole: "pre_transform_value", nullable: true, description: "Original y token before a correction or transform." }),
    field("transform_provenance", { dataType: "json", semanticRole: "transform_provenance", description: "Model, transforms, digests, and review provenance for this point." }),
  ],
});

const paper = buildPaperTable({
  datasetFamily: BIOACTIVITY_FAMILY_ID,
  schemaId: "bioactivity_measurement.chart_paper.v1",
  rowGranularity: "one paper carrying bioactivity chart evidence",
  tableId: CHART_PAPERS_TABLE_ID,
  role: "supporting",
});
const source = buildSourceTable({
  datasetFamily: BIOACTIVITY_FAMILY_ID,
  schemaId: "bioactivity_measurement.chart_source.v1",
  rowGranularity: "one registered carrier containing bioactivity chart evidence",
  tableId: CHART_SOURCES_TABLE_ID,
  role: "supporting",
});

export const chartPaperSchema = paper.schema;
export const chartSourceSchema = source.schema;

export const chartSeriesDefinition: TableDefinition = parseTableDefinition({
  table_id: CHART_SERIES_TABLE_ID,
  schema_ref: chartSeriesSchema.schema_id,
  role: "supporting",
  required: true,
  allow_empty: false,
  primary_key: [...chartSeriesSchema.primary_key],
  field_names: chartSeriesSchema.fields.map((item) => item.name),
});
export const chartPointDefinition: TableDefinition = parseTableDefinition({
  table_id: CHART_POINTS_TABLE_ID,
  schema_ref: chartPointSchema.schema_id,
  role: "derived",
  required: true,
  allow_empty: true,
  primary_key: [...chartPointSchema.primary_key],
  field_names: chartPointSchema.fields.map((item) => item.name),
});

export const chartEvidenceTables = [
  { schema: chartSeriesSchema, definition: chartSeriesDefinition },
  { schema: chartPointSchema, definition: chartPointDefinition },
  paper,
  source,
] as const;

function relation(value: RelationDefinition): RelationDefinition {
  return parseRelationDefinition(value);
}

export const chartEvidenceRelations: readonly RelationDefinition[] = [
  relation({
    relation_id: "chart_series_paper",
    from_table_id: CHART_SERIES_TABLE_ID,
    from_fields: ["paper_id", "paper_id_namespace"],
    to_table_id: CHART_PAPERS_TABLE_ID,
    to_fields: ["paper_id", "paper_id_namespace"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "chart_series_source",
    from_table_id: CHART_SERIES_TABLE_ID,
    from_fields: ["source_id"],
    to_table_id: CHART_SOURCES_TABLE_ID,
    to_fields: ["source_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "chart_point_series",
    from_table_id: CHART_POINTS_TABLE_ID,
    from_fields: ["chart_series_id"],
    to_table_id: CHART_SERIES_TABLE_ID,
    to_fields: ["chart_series_id"],
    cardinality: "many_to_one",
    missing_policy: "allow_empty",
  }),
  relation({
    relation_id: "chart_point_activity",
    from_table_id: CHART_POINTS_TABLE_ID,
    from_fields: ["activity_id"],
    to_table_id: "activities",
    to_fields: ["activity_id"],
    cardinality: "many_to_one",
    missing_policy: "allow_empty",
  }),
];
