import type { SourceLocatorV2 } from "@biomed/contracts";

import type {
  BioactivityActivityInput,
  BioactivityAssayInput,
  BioactivityCompoundInput,
  BioactivityTargetInput,
} from "../types.js";

export const PAPER_RECORDS_TABLE_ID = "paper_records";
export const EXPERIMENT_RECORDS_TABLE_ID = "experiment_records";
export const ACTIVITY_VALUE_RECORDS_TABLE_ID = "activity_value_records";
export const SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID = "supplementary_asset_records";

export const PAPER_EVIDENCE_TABLE_IDS = [
  PAPER_RECORDS_TABLE_ID,
  EXPERIMENT_RECORDS_TABLE_ID,
  ACTIVITY_VALUE_RECORDS_TABLE_ID,
  SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID,
] as const;

export type PaperEvidenceTableId = (typeof PAPER_EVIDENCE_TABLE_IDS)[number];

/**
 * Roles frozen from `docs/evaluation/gold-v1/schemas/gold6-reference.json`.
 * The formal PublicationCandidate contract admits exactly one primary table
 * (canonical `activities`), so the gold6 "primary" role of
 * activity_value_records is recorded here and published as "supporting".
 */
export const GOLD6_REFERENCE_ROLES: Readonly<Record<PaperEvidenceTableId, string>> = {
  [PAPER_RECORDS_TABLE_ID]: "supporting",
  [EXPERIMENT_RECORDS_TABLE_ID]: "supporting",
  [ACTIVITY_VALUE_RECORDS_TABLE_ID]: "primary",
  [SUPPLEMENTARY_ASSET_RECORDS_TABLE_ID]: "supporting",
};

/** Provenance fields required by the gold6 reference measurement contract. */
export const PAPER_EVIDENCE_REQUIRED_PROVENANCE_FIELDS = [
  "source_asset_id",
  "source_locator",
  "retrieved_at",
  "extraction_method",
  "confidence_level",
] as const;

/**
 * Explicit token used for absent identifiers and absent table/row/column
 * labels so composite primary keys stay total in CSV bytes.
 */
export const PAPER_ID_ABSENT = "none";

export interface PaperRecordInput {
  pmid: string;
  pmcid: string;
  doi: string;
  title: string;
  journal: string | null;
  publication_date: string | null;
  authors: readonly string[] | null;
  open_access_status: string | null;
  source_url: string | null;
  paper_key: string;
  source_id: string;
}

export interface ExperimentRecordInput {
  experiment_id: string;
  paper_id: string;
  protein: string;
  variant: string | null;
  construct: string | null;
  ligand: string | null;
  assay_type: string;
  cell_line_or_system: string | null;
  temperature: string | null;
  buffer: string | null;
  incubation_time: string | null;
  source_locator: SourceLocatorV2;
  extraction_method: string;
}

export interface ActivityValueRecordInput {
  experiment_id: string;
  compound: string;
  protein_variant: string;
  activity_type: string;
  activity_value: string;
  activity_unit: string;
  relation: string;
  replicate_count: number | null;
  error_value: number | null;
  error_type: string | null;
  original_text: string;
  table_or_figure: string;
  page_number: number | null;
  row_label: string;
  column_label: string;
  confidence_level: string;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
}

export interface SupplementaryAssetRecordInput {
  paper_id: string;
  asset_name: string;
  asset_type: string;
  download_url: string | null;
  sha256: string;
  file_size: number | null;
  parse_status: string;
  table_count: number | null;
  source_locator: SourceLocatorV2;
  source_asset_id: string;
}

export interface PaperEvidenceRows {
  paper_records: readonly PaperRecordInput[];
  experiment_records: readonly ExperimentRecordInput[];
  activity_value_records: readonly ActivityValueRecordInput[];
  supplementary_asset_records: readonly SupplementaryAssetRecordInput[];
}

/** Canonical identities derived deterministically from admitted paper evidence. */
export interface PaperDerivedCanonicalIdentities {
  activities: readonly BioactivityActivityInput[];
  compounds: readonly BioactivityCompoundInput[];
  assays: readonly BioactivityAssayInput[];
  targets: readonly BioactivityTargetInput[];
}
