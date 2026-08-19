export interface ProviderCarrierBinding {
  readonly familyId: string;
  readonly source: string;
  readonly adapterId: string;
}

/** Fixed Core-owned provider carrier bindings. Agent input cannot extend this set. */
export const PROVIDER_CARRIER_BINDINGS: readonly ProviderCarrierBinding[] = Object.freeze([
  { familyId: "literature_evidence", source: "pubmed", adapterId: "literature.bioc_xml.v1" },
  { familyId: "target_evidence", source: "uniprot", adapterId: "target.evidence.uniprot.v1" },
  { familyId: "target_evidence", source: "ncbi_clinvar", adapterId: "target.evidence.clinvar.v1" },
  { familyId: "target_evidence", source: "clinicaltrials_gov", adapterId: "target.evidence.trials.v1" },
  { familyId: "protein_structure", source: "pdb", adapterId: "protein.structure.carrier.v1" },
  { familyId: "bioactivity_measurement", source: "chembl", adapterId: "bioactivity.chembl_json.v1" },
]);

export function providerCarrierBinding(
  familyId: string,
  source: string,
  adapterId: string,
): ProviderCarrierBinding | null {
  return PROVIDER_CARRIER_BINDINGS.find((binding) =>
    binding.familyId === familyId && binding.source === source && binding.adapterId === adapterId,
  ) ?? null;
}

export function isProviderCarrierAdapterId(adapterId: string): boolean {
  return PROVIDER_CARRIER_BINDINGS.some((binding) => binding.adapterId === adapterId);
}
