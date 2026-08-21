import type { SourceLocatorV2 } from "@biomed/contracts";

export const BIOACTIVITY_FAMILY_ID = "bioactivity_measurement";
export const BIOACTIVITY_ROW_GRANULARITY =
  "one compound-assay-target activity measurement";

export type BioactivityTableId =
  | "activities"
  | "compounds"
  | "assays"
  | "targets"
  | "compound_crosswalks";

export interface BioactivityActivityInput {
  activity_id: string;
  compound_id: string;
  compound_id_namespace: string;
  assay_id: string;
  assay_id_namespace: string;
  target_id: string;
  target_namespace: string;
  activity_type: string;
  raw_value: string;
  raw_relation: string;
  preserved_relation: string;
  raw_unit: string;
  preserved_raw_unit: string;
  standardized_value: number;
  standardized_unit: string;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
}

export interface BioactivityCompoundInput {
  compound_id: string;
  compound_id_namespace: string;
  preferred_name: string;
  canonical_smiles: string | null;
  isomeric_smiles: string | null;
  inchi: string | null;
  inchi_key: string | null;
  molecular_formula: string | null;
  molecular_weight: number | null;
  source_id: string;
}

export interface BioactivityAssayInput {
  assay_id: string;
  assay_id_namespace: string;
  assay_type: string;
  description: string | null;
  organism: string | null;
  cell_line: string | null;
  target_entity_id: string;
  target_entity_namespace: string;
  bao_format_id: string | null;
  source_id: string;
}

export interface BioactivityTargetInput {
  entity_id: string;
  entity_namespace: string;
  entity_type: string;
  preferred_name: string;
  organism: string | null;
  source_id: string;
}

export interface BioactivityRows {
  activities: readonly BioactivityActivityInput[];
  compounds: readonly BioactivityCompoundInput[];
  assays: readonly BioactivityAssayInput[];
  targets: readonly BioactivityTargetInput[];
}
