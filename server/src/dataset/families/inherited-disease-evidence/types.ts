import type { SourceLocatorV2 } from "@biomed/contracts";

export const INHERITED_DISEASE_EVIDENCE_FAMILY_ID = "inherited_disease_gene_evidence" as const;
export const INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY = "one inherited disease gene association" as const;

export type InheritedDiseaseEvidenceSource =
  | "orphanet_en_product1"
  | "orphanet_en_product6"
  | "hgnc_approved"
  | "clinvar_gene_esearch"
  | "clingen_gene_validity";

export interface InheritedDiseaseGeneRecord {
  gene_id: string;
  gene_namespace: "hgnc";
  gene_symbol: string;
  gene_name: string;
  status: string;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface InheritedDiseaseDiseaseRecord {
  disease_id: string;
  disease_namespace: "orphanet";
  disease_name: string;
  omim_id: string | null;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface InheritedDiseaseGeneDiseaseRecord {
  gene_disease_id: string;
  gene_id: string;
  gene_namespace: "hgnc";
  disease_id: string;
  disease_namespace: "orphanet";
  association_type: string;
  classification: string;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface InheritedDiseaseEvidenceCrosswalkRecord {
  crosswalk_id: string;
  evidence_id: string;
  gene_id: string;
  gene_namespace: "hgnc";
  evidence_source: string;
  pathogenic_count: number;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface InheritedDiseaseEvidenceRows {
  gene_records: readonly InheritedDiseaseGeneRecord[];
  disease_records: readonly InheritedDiseaseDiseaseRecord[];
  gene_disease_records: readonly InheritedDiseaseGeneDiseaseRecord[];
  gene_evidence_crosswalk: readonly InheritedDiseaseEvidenceCrosswalkRecord[];
}

export interface InheritedDiseaseEvidenceCarrier {
  source: InheritedDiseaseEvidenceSource;
  sourceId: string;
  assetId: string;
  logicalFile: string;
  retrievedAt: string;
  bytes: Buffer;
}

export interface InheritedDiseaseEvidenceTableEntry {
  tableId: keyof InheritedDiseaseEvidenceRows;
  schema: import("@biomed/contracts").DatasetSchemaV2;
  definition: import("@biomed/contracts").TableDefinition;
}
