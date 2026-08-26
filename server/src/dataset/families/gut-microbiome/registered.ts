import { RegisteredTableRegistry } from "../../adapters/registered/index.js";
import {
  gutMicrobiomeDifferentialAbundanceSchema,
  gutMicrobiomeReferencePrevalenceSchema,
  gutMicrobiomeStudySchema,
  gutMicrobiomeTaxonMatrixSchema,
  gutMicrobiomeTaxonSchema,
} from "./schemas.js";

const LIMITS = {
  max_bytes: 64 * 1024 * 1024,
  max_rows: 500_000,
  max_columns: 64,
  max_line_characters: 256 * 1024,
};

function jsonFields(schema: { fields: readonly { name: string }[] }) {
  return schema.fields.map((field) => ({
    source_pointer: `/${field.name}`,
    target_field: field.name,
  }));
}

function delimitedFields(schema: { fields: readonly { name: string }[] }) {
  return schema.fields.map((field) => ({
    source_column: field.name,
    target_field: field.name,
  }));
}

export const GUT_MICROBIOME_STUDY_JSON_ADAPTER_ID = "registered_gut_microbiome_study_json";
/** Stable compatibility adapter for the original MGnify wide matrix carrier. */
export const GUT_MICROBIOME_TAXON_TSV_ADAPTER_ID = "registered_gut_microbiome_taxon_tsv";
/** Schema-bound long-form TSV parser for the four-table family. */
export const GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID = "registered_gut_microbiome_taxon_long_tsv";
export const GUT_MICROBIOME_TAXON_JSON_ADAPTER_ID = "registered_gut_microbiome_taxon_json";
export const GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_XLSX_ADAPTER_ID = "registered_gut_microbiome_differential_abundance_xlsx";
export const GUT_MICROBIOME_REFERENCE_PREVALENCE_JSON_ADAPTER_ID = "registered_gut_microbiome_reference_prevalence_json";

export function createGutMicrobiomeRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  registry.register({
    schema: gutMicrobiomeStudySchema,
    parser: {
      adapter_id: GUT_MICROBIOME_STUDY_JSON_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeStudySchema.schema_id,
      format: "json",
      rows_pointer: "/studies",
      fields: jsonFields(gutMicrobiomeStudySchema),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: gutMicrobiomeTaxonMatrixSchema,
    parser: {
      adapter_id: GUT_MICROBIOME_TAXON_TSV_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeTaxonMatrixSchema.schema_id,
      format: "tsv",
      fields: [
        { source_column: "sample_id", target_field: "sample_id" },
        { source_column: "taxon_path", target_field: "taxon_path" },
        { source_column: "abundance", target_field: "abundance" },
      ],
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
  registry.register({
    schema: gutMicrobiomeTaxonSchema,
    parser: {
      adapter_id: GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeTaxonSchema.schema_id,
      format: "tsv",
      fields: delimitedFields(gutMicrobiomeTaxonSchema),
      media_types: ["text/tab-separated-values"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: gutMicrobiomeTaxonSchema,
    parser: {
      adapter_id: GUT_MICROBIOME_TAXON_JSON_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeTaxonSchema.schema_id,
      format: "json",
      rows_pointer: "/records",
      fields: jsonFields(gutMicrobiomeTaxonSchema),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: gutMicrobiomeDifferentialAbundanceSchema,
    parser: {
      adapter_id: GUT_MICROBIOME_DIFFERENTIAL_ABUNDANCE_XLSX_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeDifferentialAbundanceSchema.schema_id,
      format: "xlsx",
      sheet_name: "DifferentialAbundance",
      fields: delimitedFields(gutMicrobiomeDifferentialAbundanceSchema),
      media_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      limits: LIMITS,
    },
  });
  registry.register({
    schema: gutMicrobiomeReferencePrevalenceSchema,
    parser: {
      adapter_id: GUT_MICROBIOME_REFERENCE_PREVALENCE_JSON_ADAPTER_ID,
      parser_version: "1_0_0",
      schema_ref: gutMicrobiomeReferencePrevalenceSchema.schema_id,
      format: "json",
      rows_pointer: "/records",
      fields: jsonFields(gutMicrobiomeReferencePrevalenceSchema),
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  return registry;
}
