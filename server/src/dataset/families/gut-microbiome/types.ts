import type {
  DatasetSchemaV2,
  RelationDefinition,
  SourceLocatorV2,
  TableDefinition,
} from "@biomed/contracts";

import {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_ROW_GRANULARITY,
  gutMicrobiomeDifferentialAbundanceSchema,
  gutMicrobiomeRelations,
  gutMicrobiomeReferencePrevalenceSchema,
  gutMicrobiomeSourceSchema,
  gutMicrobiomeSourceTableDefinition,
  gutMicrobiomeStudySchema,
  gutMicrobiomeTableDefinitions,
  gutMicrobiomeTaxonSchema,
} from "./schemas.js";

export {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_ROW_GRANULARITY,
};

export type GutMicrobiomeTableId =
  | "study_records"
  | "taxon_records"
  | "differential_abundance_records"
  | "reference_prevalence_records";

export interface GutMicrobiomeSchemaSet {
  study: DatasetSchemaV2;
  taxon: DatasetSchemaV2;
  differentialAbundance: DatasetSchemaV2;
  referencePrevalence: DatasetSchemaV2;
  source: DatasetSchemaV2;
  studyTable: TableDefinition;
  taxonTable: TableDefinition;
  differentialAbundanceTable: TableDefinition;
  referencePrevalenceTable: TableDefinition;
  sourceTable: TableDefinition;
  relations: readonly RelationDefinition[];
}

export interface GutMicrobiomeStudyInput {
  study_id: string;
  study_accession: string;
  study_title: string;
  disease_id: string;
  disease_name: string;
  host_taxon_id: string;
  sample_count: number;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

export interface GutMicrobiomeTaxonInput {
  study_id: string;
  sample_id: string;
  taxon_path: string;
  taxon_id: string;
  abundance: number;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

export interface GutMicrobiomeDifferentialAbundanceInput {
  study_id: string;
  taxon_id: string;
  comparison_id: string;
  comparison_label: string;
  effect_size: number;
  p_value: number;
  adjusted_p_value: number | null;
  effect_direction: string;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

export interface GutMicrobiomeReferencePrevalenceInput {
  study_id: string;
  taxon_id: string;
  reference_group: string;
  prevalence: number;
  reference_sample_count: number;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

export interface GutMicrobiomeSourceInput {
  source_id: string;
  source_database: "mgnify" | "gmrepo" | "ncbi_taxonomy";
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}

export interface GutMicrobiomeRows {
  studies: readonly GutMicrobiomeStudyInput[];
  taxa: readonly GutMicrobiomeTaxonInput[];
  differentialAbundances: readonly GutMicrobiomeDifferentialAbundanceInput[];
  referencePrevalences: readonly GutMicrobiomeReferencePrevalenceInput[];
  sources: readonly GutMicrobiomeSourceInput[];
}

export function buildGutMicrobiomeTables(): GutMicrobiomeSchemaSet {
  const definitions = gutMicrobiomeTableDefinitions();
  return {
    study: gutMicrobiomeStudySchema,
    taxon: gutMicrobiomeTaxonSchema,
    differentialAbundance: gutMicrobiomeDifferentialAbundanceSchema,
    referencePrevalence: gutMicrobiomeReferencePrevalenceSchema,
    source: gutMicrobiomeSourceSchema.schema,
    studyTable: definitions[0]!,
    taxonTable: definitions[1]!,
    differentialAbundanceTable: definitions[2]!,
    referencePrevalenceTable: definitions[3]!,
    sourceTable: gutMicrobiomeSourceTableDefinition(),
    relations: gutMicrobiomeRelations,
  };
}
