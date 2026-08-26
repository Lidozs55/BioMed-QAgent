export interface ProviderCarrierBinding {
  readonly familyId: string;
  readonly source: string;
  readonly adapterId: string;
  /** Optional schema gate for providers whose carrier role is V2-only. */
  readonly schemaRefs?: readonly string[];
}

/** Fixed Core-owned provider carrier bindings. Agent input cannot extend this set. */
export const PROVIDER_CARRIER_BINDINGS: readonly ProviderCarrierBinding[] = Object.freeze([
  {
    familyId: "gene_expression",
    source: "geo",
    adapterId: "geo.expression.v1",
    schemaRefs: ["gene_expression.long.v2", "gene_expression.probe_long.v2"],
  },
  {
    familyId: "gene_expression",
    source: "gdc",
    adapterId: "gdc.expression.v1",
    schemaRefs: ["gene_expression.long.v2"],
  },
  { familyId: "literature_evidence", source: "pubmed", adapterId: "literature.bioc_xml.v1" },
  { familyId: "target_evidence", source: "uniprot", adapterId: "target.evidence.uniprot.v1" },
  { familyId: "target_evidence", source: "ncbi_clinvar", adapterId: "target.evidence.clinvar.v1" },
  { familyId: "target_evidence", source: "clinicaltrials_gov", adapterId: "target.evidence.trials.v1" },
  { familyId: "protein_structure", source: "pdb", adapterId: "protein.structure.carrier.v1" },
  { familyId: "bioactivity_measurement", source: "chembl", adapterId: "bioactivity.chembl_json.v1" },
  { familyId: "bioactivity_measurement", source: "pubchem", adapterId: "bioactivity.pubchem_identity.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "orphanet_en_product1", adapterId: "inherited_disease.orphanet_product1.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "orphanet_en_product6", adapterId: "inherited_disease.orphanet_product6.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "hgnc_approved", adapterId: "inherited_disease.hgnc_approved.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "clinvar_gene_esearch", adapterId: "inherited_disease.clinvar_gene_esearch.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "clingen_gene_validity", adapterId: "inherited_disease.clingen_gene_validity.v1" },
]);

export function providerCarrierBinding(
  familyId: string,
  source: string,
  adapterId: string,
  schemaRef?: string,
): ProviderCarrierBinding | null {
  return PROVIDER_CARRIER_BINDINGS.find((binding) =>
    binding.familyId === familyId
      && binding.source === source
      && binding.adapterId === adapterId
      && (schemaRef === undefined || binding.schemaRefs === undefined || binding.schemaRefs.includes(schemaRef)),
  ) ?? null;
}

export function isProviderCarrierAdapterId(adapterId: string): boolean {
  return PROVIDER_CARRIER_BINDINGS.some((binding) => binding.adapterId === adapterId);
}
