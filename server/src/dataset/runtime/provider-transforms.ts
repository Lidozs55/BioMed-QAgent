import type { SourceAssetRegistrationReceipt } from "@biomed/contracts";

import {
  parseInheritedDiseaseEvidenceCarriers,
  type InheritedDiseaseEvidenceCarrier,
  type InheritedDiseaseEvidenceRows,
} from "../families/inherited-disease-evidence/index.js";

export interface ProviderCarrierTransformInput {
  familyId: string;
  source: string;
  adapterId: string;
  assetId: string;
  receipt: SourceAssetRegistrationReceipt;
  bytes: Buffer;
}

export type ProviderCarrierRows = Readonly<Record<string, readonly object[]>>;
export type ProviderCarrierBatchTransform = (
  inputs: readonly ProviderCarrierTransformInput[],
) => ProviderCarrierRows;

interface ProviderCarrierTransformRegistration {
  readonly familyId: string;
  readonly transform: ProviderCarrierBatchTransform;
}

function inheritedDiseaseRows(
  inputs: readonly ProviderCarrierTransformInput[],
): ProviderCarrierRows {
  const carriers: InheritedDiseaseEvidenceCarrier[] = inputs.map((input) => ({
    source: input.source as InheritedDiseaseEvidenceCarrier["source"],
    sourceId: input.receipt.source_id,
    assetId: input.assetId,
    logicalFile: input.receipt.relative_path,
    retrievedAt: input.receipt.registered_at,
    bytes: input.bytes,
  }));
  const rows: InheritedDiseaseEvidenceRows = parseInheritedDiseaseEvidenceCarriers(carriers);
  return {
    gene_records: rows.gene_records,
    disease_records: rows.disease_records,
    gene_disease_records: rows.gene_disease_records,
    gene_evidence_crosswalk: rows.gene_evidence_crosswalk,
  };
}

const PROVIDER_CARRIER_TRANSFORMS: readonly ProviderCarrierTransformRegistration[] = Object.freeze([
  Object.freeze({
    familyId: "inherited_disease_gene_evidence",
    transform: inheritedDiseaseRows,
  }),
]);

export function providerCarrierTransformForFamily(
  familyId: string,
): ProviderCarrierBatchTransform | null {
  return PROVIDER_CARRIER_TRANSFORMS.find((entry) => entry.familyId === familyId)?.transform ?? null;
}