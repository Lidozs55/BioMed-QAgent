export interface ProviderCarrierBinding {
  readonly familyId: string;
  readonly source: string;
  readonly adapterId: string;
  /** Fixed builtin provider that is allowed to produce this carrier. */
  readonly providerId: string;
  /** Explicit output table/input role for multi-table provider composition. */
  readonly tableId?: string;
  readonly inputRole?: string;
  /** Gold-family bindings require the exact acquisition provider ID. */
  readonly strictProviderId?: boolean;
  /** Optional schema gate for providers whose carrier role is V2-only. */
  readonly schemaRefs?: readonly string[];
}

/** Fixed Core-owned provider carrier bindings. Agent input cannot extend this set. */
export const PROVIDER_CARRIER_BINDINGS: readonly ProviderCarrierBinding[] = Object.freeze([
  {
    familyId: "gene_expression",
    source: "geo",
    adapterId: "geo.expression.v1",
    providerId: "geo.files.v1",
    schemaRefs: ["gene_expression.long.v2", "gene_expression.probe_long.v2"],
  },
  {
    familyId: "gene_expression",
    source: "gdc",
    adapterId: "gdc.expression.v1",
    providerId: "gdc.files.v1",
    schemaRefs: ["gene_expression.long.v2"],
  },
  { familyId: "literature_evidence", source: "pubmed", adapterId: "literature.bioc_xml.v1", providerId: "pubmed.files.v1" },
  { familyId: "target_evidence", source: "uniprot", adapterId: "target.evidence.uniprot.v1", providerId: "uniprot.files.v1" },
  { familyId: "target_evidence", source: "ncbi_clinvar", adapterId: "target.evidence.clinvar.v1", providerId: "clinvar.files.v1" },
  { familyId: "target_evidence", source: "clinicaltrials_gov", adapterId: "target.evidence.trials.v1", providerId: "clinicaltrials.files.v1" },
  { familyId: "protein_structure", source: "pdb", adapterId: "protein.structure.carrier.v1", providerId: "pdb.files.v1" },
  { familyId: "bioactivity_measurement", source: "chembl", adapterId: "bioactivity.chembl_json.v1", providerId: "chembl.files.v1" },
  { familyId: "bioactivity_measurement", source: "pubchem", adapterId: "bioactivity.pubchem_identity.v1", providerId: "pubchem.files.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "orphanet_en_product1", adapterId: "inherited_disease.orphanet_product1.v1", providerId: "orphanet.en_product1.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "orphanet_en_product6", adapterId: "inherited_disease.orphanet_product6.v1", providerId: "orphanet.en_product6.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "hgnc_approved", adapterId: "inherited_disease.hgnc_approved.v1", providerId: "hgnc.approved.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "clinvar_gene_esearch", adapterId: "inherited_disease.clinvar_gene_esearch.v1", providerId: "clinvar.gene-esearch.v1" },
  { familyId: "inherited_disease_gene_evidence", source: "clingen_gene_validity", adapterId: "inherited_disease.clingen_gene_validity.v1", providerId: "clingen.gene-validity.v1" },
  {
    familyId: "gut_microbiome",
    source: "mgnify",
    adapterId: "registered_gut_microbiome_study_json",
    providerId: "mgnify.files.v1",
    tableId: "study_records",
    inputRole: "study",
    strictProviderId: true,
    schemaRefs: ["gut_microbiome.study.v1"],
  },
  {
    familyId: "gut_microbiome",
    source: "mgnify",
    adapterId: "registered_gut_microbiome_differential_abundance_xlsx",
    providerId: "mgnify.files.v1",
    tableId: "differential_abundance_records",
    inputRole: "differential_abundance",
    strictProviderId: true,
    schemaRefs: ["gut_microbiome.differential_abundance.v1"],
  },
  {
    familyId: "gut_microbiome",
    source: "ncbi_taxonomy",
    adapterId: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
    providerId: "ncbi.taxonomy.files.v1",
    tableId: "taxon_records",
    inputRole: "taxon",
    strictProviderId: true,
    schemaRefs: ["gut_microbiome.taxon_name_crosswalk.v1"],
  },
  {
    familyId: "gut_microbiome",
    source: "ncbi_taxonomy",
    adapterId: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
    providerId: "ncbi.taxonomy.files.v1",
    tableId: "taxon_records",
    inputRole: "taxon",
    strictProviderId: true,
    schemaRefs: ["gut_microbiome.taxon_name_crosswalk.v1"],
  },
  {
    familyId: "gut_microbiome",
    source: "gmrepo",
    adapterId: "gut_microbiome.gmrepo_taxon_phenotypes_json.v1",
    providerId: "gmrepo.files.v1",
    tableId: "reference_prevalence_records",
    inputRole: "reference_prevalence",
    strictProviderId: true,
    schemaRefs: ["gut_microbiome.reference_prevalence.v1"],
  },
]);

export function providerCarrierBinding(
  familyId: string,
  source: string,
  adapterId: string,
  schemaRef?: string,
  providerId?: string | null,
): ProviderCarrierBinding | null {
  return PROVIDER_CARRIER_BINDINGS.find((binding) =>
    binding.familyId === familyId
      && binding.source === source
      && binding.adapterId === adapterId
      && (providerId === undefined || providerId === null || binding.strictProviderId !== true || binding.providerId === providerId)
      && (schemaRef === undefined || binding.schemaRefs === undefined || binding.schemaRefs.includes(schemaRef)),
  ) ?? null;
}

export function isProviderCarrierAdapterId(adapterId: string): boolean {
  return PROVIDER_CARRIER_BINDINGS.some((binding) => binding.adapterId === adapterId);
}
