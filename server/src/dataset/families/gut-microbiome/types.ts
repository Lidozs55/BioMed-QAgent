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
  gutMicrobiomeTaxonCrosswalkSchema,
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

/** One NCBI ESearch name-resolution outcome: a literature query name plus the matched taxid (null when unresolved). */
export interface GutMicrobiomeTaxonResolutionInput {
  query_name: string;
  taxon_id: string | null;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

/** One NCBI EFetch taxon record with classified alternative names and lineage. */
export interface GutMicrobiomeTaxonDetailInput {
  ncbi_taxon_id: string;
  current_name: string;
  common_name: string | null;
  taxon_rank: string;
  parent_taxon_id: string | null;
  lineage: string | null;
  synonyms: readonly string[];
  equivalent_names: readonly string[];
  historical_names: readonly string[];
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

/** Final taxon_records row: the EFetch detail enriched with the literature query names that resolved to it. */
export interface GutMicrobiomeCrosswalkInput {
  ncbi_taxon_id: string;
  current_name: string;
  common_name: string | null;
  taxon_rank: string;
  parent_taxon_id: string | null;
  lineage: string | null;
  synonyms: string;
  equivalent_names: string;
  historical_names: string;
  name_change_observed: boolean;
  query_names: string | null;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

/**
 * One raw differential result extracted from a paper supplement statistics
 * panel, before the reported literature name is joined to an NCBI taxid via
 * the ESearch resolutions of the same spec.
 */
export interface GutMicrobiomePaperDifferentialInput {
  study_id: string;
  reported_taxon_name: string;
  comparison_id: string;
  comparison_label: string;
  effect_size: number;
  p_value: number;
  adjusted_p_value: number | null;
  effect_direction: "increase" | "decrease" | "unchanged";
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
  source_database: "mgnify" | "gmrepo" | "ncbi_taxonomy" | "europepmc_supplement";
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}

export interface GutMicrobiomeRows {
  studies: readonly GutMicrobiomeStudyInput[];
  crosswalk: readonly GutMicrobiomeCrosswalkInput[];
  differentialAbundances: readonly GutMicrobiomeDifferentialAbundanceInput[];
  referencePrevalences: readonly GutMicrobiomeReferencePrevalenceInput[];
  sources: readonly GutMicrobiomeSourceInput[];
}

export function buildGutMicrobiomeTables(): GutMicrobiomeSchemaSet {
  const definitions = gutMicrobiomeTableDefinitions();
  return {
    study: gutMicrobiomeStudySchema,
    taxon: gutMicrobiomeTaxonCrosswalkSchema,
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
