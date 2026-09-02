import type { Projection, RelationDefinition, TableDefinition } from "@biomed/contracts";

import {
  parseRelationDefinition,
  parseTableDefinition,
} from "../../contracts/index.js";

export const LITERATURE_EXPERIMENT_CHART_FAMILY_ID = "literature_experiment_chart";
export const LITERATURE_EXPERIMENT_CHART_PROFILE_REF =
  "literature_experiment_chart.release.v1";
export const LITERATURE_EXPERIMENT_CHART_PROJECTION_ID =
  "literature_experiment_chart.six_table.v1";

function table(options: {
  tableId: string;
  schemaRef: string;
  role: TableDefinition["role"];
  primaryKey: readonly string[];
  fields: readonly string[];
  allowEmpty?: boolean;
  required?: boolean;
}): TableDefinition {
  return parseTableDefinition({
    table_id: options.tableId,
    schema_ref: options.schemaRef,
    role: options.role,
    required: options.required ?? true,
    allow_empty: options.allowEmpty ?? false,
    primary_key: [...options.primaryKey],
    field_names: [...options.fields],
  });
}

export const literatureExperimentChartTables: readonly TableDefinition[] = Object.freeze([
  table({
    tableId: "activity_value_records",
    schemaRef: "literature_experiment_chart.activity_value.v1",
    role: "primary",
    primaryKey: ["activity_value_id"],
    fields: [
      "activity_value_id", "experiment_id", "raw_value", "raw_relation", "raw_unit",
      "normalized_value", "normalized_unit", "value_precision", "extraction_method",
      "confidence", "review_status", "source_asset_id", "source_locator",
    ],
  }),
  table({
    tableId: "paper_records",
    schemaRef: "literature_experiment_chart.paper.v1",
    role: "supporting",
    primaryKey: ["paper_id", "paper_id_namespace"],
    fields: [
      "paper_id", "paper_id_namespace", "title", "journal", "publication_date",
      "authors", "source_url",
    ],
  }),
  table({
    tableId: "experiment_records",
    schemaRef: "literature_experiment_chart.experiment.v1",
    role: "supporting",
    primaryKey: ["experiment_id"],
    fields: [
      "experiment_id", "paper_id", "paper_id_namespace", "experiment_type",
      "subject", "target", "assay", "conditions", "source_asset_id", "source_locator",
    ],
  }),
  table({
    tableId: "chart_series",
    schemaRef: "literature_experiment_chart.chart_series.v1",
    role: "supporting",
    primaryKey: ["chart_series_id"],
    fields: [
      "chart_series_id", "experiment_id", "figure_id", "series_label", "x_axis_name",
      "x_axis_unit", "y_axis_name", "y_axis_unit", "x_scale", "y_scale",
      "legend_text", "axis_validation_status", "legend_validation_status",
      "human_review_status", "source_asset_id", "source_locator", "model_name",
      "model_version", "prompt_digest", "extraction_confidence", "transform_provenance",
    ],
  }),
  table({
    tableId: "chart_points",
    schemaRef: "literature_experiment_chart.chart_point.v1",
    role: "derived",
    primaryKey: ["point_id"],
    fields: [
      "point_id", "chart_series_id", "activity_value_id", "x_value", "y_value",
      "point_type", "estimated_or_exact", "pixel_or_coordinate_locator",
      "extraction_confidence", "confidence_reason", "review_status", "review_id",
      "original_x_value", "original_y_value", "transform_provenance",
    ],
    allowEmpty: true,
  }),
  table({
    tableId: "supplementary_asset_records",
    schemaRef: "literature_experiment_chart.supplementary_asset.v1",
    role: "supporting",
    primaryKey: ["supplementary_asset_id"],
    fields: [
      "supplementary_asset_id", "paper_id", "paper_id_namespace", "source_asset_id",
      "parent_archive_asset_id", "parent_archive_sha256", "member_path", "member_sha256",
      "media_type", "size_bytes", "parser_id", "operation_result_id", "source_locator",
    ],
    // Topology change approved 2026-09-02 (operator): the archive-member gate
    // is conditional. Papers whose supplementary assets are not EBI-hosted
    // (publisher-DOI hosting) cannot supply a Core-owned archive member; the
    // table stays in the closure but is optional and may be empty, and the
    // validator then requires the absence to be explicit and evidence-backed.
    allowEmpty: true,
    required: false,
  }),
]);

function relation(value: RelationDefinition): RelationDefinition {
  return parseRelationDefinition(value);
}

export const literatureExperimentChartRelations: readonly RelationDefinition[] = Object.freeze([
  relation({
    relation_id: "experiment_paper",
    from_table_id: "experiment_records",
    from_fields: ["paper_id", "paper_id_namespace"],
    to_table_id: "paper_records",
    to_fields: ["paper_id", "paper_id_namespace"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "activity_experiment",
    from_table_id: "activity_value_records",
    from_fields: ["experiment_id"],
    to_table_id: "experiment_records",
    to_fields: ["experiment_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "chart_series_experiment",
    from_table_id: "chart_series",
    from_fields: ["experiment_id"],
    to_table_id: "experiment_records",
    to_fields: ["experiment_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
  relation({
    relation_id: "chart_point_series",
    from_table_id: "chart_points",
    from_fields: ["chart_series_id"],
    to_table_id: "chart_series",
    to_fields: ["chart_series_id"],
    cardinality: "many_to_one",
    missing_policy: "allow_empty",
  }),
  relation({
    relation_id: "chart_point_activity",
    from_table_id: "chart_points",
    from_fields: ["activity_value_id"],
    to_table_id: "activity_value_records",
    to_fields: ["activity_value_id"],
    cardinality: "many_to_one",
    missing_policy: "allow_empty",
  }),
  relation({
    relation_id: "supplementary_asset_paper",
    from_table_id: "supplementary_asset_records",
    from_fields: ["paper_id", "paper_id_namespace"],
    to_table_id: "paper_records",
    to_fields: ["paper_id", "paper_id_namespace"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  }),
]);

export const literatureExperimentChartProjection: Projection = Object.freeze({
  projection_id: LITERATURE_EXPERIMENT_CHART_PROJECTION_ID,
  schema_version: "2.0",
  primary_tables: ["activity_value_records"],
  supporting_tables: [
    "paper_records", "experiment_records", "chart_series", "supplementary_asset_records",
  ],
  derived_tables: ["chart_points"],
  required: literatureExperimentChartTables
    .filter((item) => item.required)
    .map((item) => item.table_id),
  optional: ["supplementary_asset_records"],
  allow_empty: ["chart_points", "supplementary_asset_records"],
  relations: literatureExperimentChartRelations.map((item) => item.relation_id),
  row_granularity: "literature_experiment_activity_value",
  compatibility_dimensions: ["raw_relation", "raw_unit", "normalized_unit", "value_precision"],
  merge_identity_fields: ["activity_value_id"],
  validation_policy_ref: "literature_experiment_chart.validation.v1",
  assessment_policy_ref: LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
});
