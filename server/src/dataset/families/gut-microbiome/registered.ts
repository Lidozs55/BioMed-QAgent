import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import { gutMicrobiomeTaxonSchema } from "./schemas.js";

const LIMITS = {
  max_bytes: 32 * 1024 * 1024,
  max_rows: 500_000,
  max_columns: 256,
  max_line_characters: 256 * 1024,
};

const TAXON_FIELDS = [
  { source_column: "sample_id", target_field: "sample_id" },
  { source_column: "taxon_path", target_field: "taxon_path" },
  { source_column: "abundance", target_field: "abundance" },
] as const;

/**
 * Core-owned long-form taxonomy carrier. The MGnify wide matrix is not
 * transposed or inferred here: a deterministic transform must first produce
 * this exact schema-bound TSV shape.
 */
export function createGutMicrobiomeRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  registry.register({
    schema: gutMicrobiomeTaxonSchema,
    parser: {
      adapter_id: "registered_gut_microbiome_taxon_tsv",
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeTaxonSchema.schema_id,
      format: "tsv",
      fields: TAXON_FIELDS,
      layout: "sample_matrix",
      sample_matrix: {
        sample_id_header: "#SampleID",
        row_label_column: "taxon_path",
        value_column: "abundance",
      },
      media_types: ["text/tab-separated-values"],
      limits: LIMITS,
    },
  });
  return registry;
}
