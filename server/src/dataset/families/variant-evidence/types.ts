import type { DatasetSchemaV2, RelationDefinition, TableDefinition } from "@biomed/contracts";
import type { SourceLocatorV2 } from "@biomed/contracts";

export const VARIANT_EVIDENCE_FAMILY_ID = "variant_evidence";
export const VARIANT_EVIDENCE_ROW_GRANULARITY =
  "one variant assertion for a reference allele under a declared condition";

export const VARIANT_ASSERTION_CONFLICT_POLICIES = [
  "retain_conflict_and_block_primary",
  "retain_conflict_and_require_review",
] as const;
export type VariantAssertionConflictPolicy =
  typeof VARIANT_ASSERTION_CONFLICT_POLICIES[number];

export type VariantAssertionStatus = "asserted" | "refuted" | "uncertain";
export type VariantEvidenceKind = "source_assertion" | "derived_mapping";

export interface VariantEvidenceSchemaSet {
  variant: DatasetSchemaV2;
  evidence: DatasetSchemaV2;
  source: DatasetSchemaV2;
  variantTable: TableDefinition;
  evidenceTable: TableDefinition;
  sourceTable: TableDefinition;
  relations: readonly RelationDefinition[];
}

export interface VariantAssertionEvidenceInput {
  assertion_id: string;
  variant_id: string;
  variant_namespace: string;
  reference_sequence_id: string;
  reference_namespace: string;
  reference_version: string;
  reference_position: string;
  reference_allele: string;
  alternate_allele: string;
  condition_id: string;
  condition_namespace: string;
  assertion_status: VariantAssertionStatus;
  conflict_policy: VariantAssertionConflictPolicy;
  conflict_status: "none" | "conflict";
  conflict_evidence: Readonly<Record<string, unknown>> | null;
  source_id: string;
}

export interface VariantEvidenceRecordInput {
  evidence_id: string;
  assertion_id: string;
  evidence_kind: VariantEvidenceKind;
  evidence_text: string;
  source_locator: SourceLocatorV2;
  evidence_digest: string;
  source_id: string;
}

export interface VariantEvidenceSourceInput {
  source_id: string;
  source_database: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}
