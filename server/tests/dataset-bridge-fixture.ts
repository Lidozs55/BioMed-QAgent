import type { DatasetBuildSpec } from "@biomed/contracts";

export const datasetBuildSpec: DatasetBuildSpec = {
  schema_version: "1.0",
  build_id: "build_1",
  objective: "Build a fixture dataset",
  dataset_family: "gene_expression",
  row_granularity: "gene_sample_measurement",
  entities: {},
  cohort_filters: {},
  required_fields: [],
  schema_ref: "gene_expression.long.v1",
  source_bindings: [{
    schema_version: "1.0",
    binding_id: "binding_gdc",
    source: "gdc",
    acquisition: {
      schema_version: "1.0",
      mode: "builtin",
      provider_id: "gdc.v1",
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: "gdc.expression.v1",
    accession: null,
    parameters: {},
  }],
  normalization_profile_ref: "gene_expression.normalization.v1",
  merge_strategy: "append_by_canonical_row",
  validation_profile_ref: "gene_expression.release.v1",
  output_format: "csv",
  target_entity_level: null,
};
