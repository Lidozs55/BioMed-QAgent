import type { DatasetSchemaV2 } from "@biomed/contracts";
import { parseDatasetSchemaV2 } from "../../contracts/index.js";

export const GUT_MICROBIOME_FAMILY_ID = "gut_microbiome";
export const GUT_MICROBIOME_TAXON_SCHEMA_ID = "gut_microbiome.taxon.v1";
export const GUT_MICROBIOME_TAXON_TABLE_ID = "taxon_records";
export const GUT_MICROBIOME_TAXON_ROW_GRANULARITY = "one taxon abundance record per sample";

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

export const gutMicrobiomeTaxonSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
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
