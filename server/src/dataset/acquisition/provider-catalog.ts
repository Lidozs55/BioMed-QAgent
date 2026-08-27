import type { AcquisitionProviderHandler } from "./runtime.js";
import { createChemblFilesProvider, CHEMBL_FILES_PROVIDER_ID } from "./chembl-provider.js";
import { createGdcFilesProvider, createGeoFilesProvider, GDC_FILES_PROVIDER_ID, GEO_FILES_PROVIDER_ID } from "./expression-providers.js";
import { createFixedBiomedicalProviders, FIXED_BIOMEDICAL_PROVIDER_IDS } from "./biomedical-providers.js";
import { createGmrepoFilesProvider, GMREPO_FILES_PROVIDER_ID } from "./gmrepo-provider.js";
import { createExtendedAcquisitionProviders, EXTENDED_PROVIDER_IDS } from "./extended-providers.js";
import { createGold9AcquisitionProviders, GOLD9_PROVIDER_IDS } from "./gold9-providers.js";
import { createNcbiTaxonomyFilesProvider, NCBI_TAXONOMY_FILES_PROVIDER_ID } from "./ncbi-taxonomy-provider.js";

export type AcquisitionParameterContract = "fixed" | "chembl" | "pubchem" | "pubmed";

export interface CoreAcquisitionProviderDescriptor {
  readonly providerId: string;
  readonly source: string;
  readonly parameterContract: AcquisitionParameterContract;
  readonly inputHint: string;
  readonly dynamicInput: "utf8" | "gzip_utf8" | "binary_archive";
  readonly databaseId: string | null;
}

function descriptor(
  providerId: string,
  source: string,
  parameterContract: AcquisitionParameterContract,
  inputHint: string,
  dynamicInput: CoreAcquisitionProviderDescriptor["dynamicInput"] = "utf8",
  databaseId: string | null = source,
): CoreAcquisitionProviderDescriptor {
  return Object.freeze({ providerId, source, parameterContract, inputHint, dynamicInput, databaseId });
}

export const CORE_ACQUISITION_PROVIDER_DESCRIPTORS: readonly CoreAcquisitionProviderDescriptor[] = Object.freeze([
  descriptor(CHEMBL_FILES_PROVIDER_ID, "chembl", "chembl", "One ChEMBL target ID per binding; compounds belong in entities."),
  descriptor(GEO_FILES_PROVIDER_ID, "geo", "fixed", "One GEO series accession per binding.", "gzip_utf8"),
  descriptor(GDC_FILES_PROVIDER_ID, "gdc", "fixed", "One GDC file ID per binding."),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.pdb, "pdb", "fixed", "One PDB ID per binding."),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.pubmed, "pubmed", "pubmed", "One PMCID per binding; retrieves full-text XML."),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.uniprot, "uniprot", "fixed", "One UniProt accession per binding."),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.clinvar, "ncbi_clinvar", "fixed", "One ClinVar accession or UID per binding.", "utf8", "clinvar"),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.clinicalTrials, "clinicaltrials_gov", "fixed", "One NCT ID per binding.", "utf8", null),
  descriptor(FIXED_BIOMEDICAL_PROVIDER_IDS.pubchem, "pubchem", "pubchem", "One positive PubChem CID per binding."),
  descriptor(EXTENDED_PROVIDER_IDS.xena, "xena", "fixed", "One UCSC Xena dataset ID per binding.", "gzip_utf8"),
  descriptor(EXTENDED_PROVIDER_IDS.reactome, "reactome", "fixed", "One Reactome stable pathway ID per binding."),
  descriptor(EXTENDED_PROVIDER_IDS.dbsnp, "dbsnp", "fixed", "One rsID per binding."),
  descriptor(EXTENDED_PROVIDER_IDS.mgnify, "mgnify", "fixed", "One MGnify study accession per binding."),
  descriptor(EXTENDED_PROVIDER_IDS.openfda, "openfda_faers", "fixed", "One drug generic name per binding.", "utf8", "openfda"),
  descriptor(EXTENDED_PROVIDER_IDS.gwasCatalog, "gwas_catalog", "fixed", "One GCST study accession or rsID per binding.", "utf8", null),
  descriptor(EXTENDED_PROVIDER_IDS.europePmcSupplementary, "europepmc_supplementary", "fixed", "One PMCID per binding; retrieves the official supplementary ZIP carrier.", "binary_archive", null),
  descriptor(GMREPO_FILES_PROVIDER_ID, "gmrepo", "fixed", "One numeric NCBI taxon ID per binding; POSTs the official GMRepo API for that taxon's phenotype prevalence summary."),
  descriptor(GOLD9_PROVIDER_IDS.orphanetProduct1, "orphanet_en_product1", "fixed", "The fixed en_product1 Orphanet XML response form.", "utf8", null),
  descriptor(GOLD9_PROVIDER_IDS.orphanetProduct6, "orphanet_en_product6", "fixed", "The fixed en_product6 Orphanet XML response form.", "utf8", null),
  descriptor(GOLD9_PROVIDER_IDS.hgncApproved, "hgnc_approved", "fixed", "The current HGNC approved complete-set TSV.", "utf8", null),
  descriptor(GOLD9_PROVIDER_IDS.clinvarGeneEsearch, "clinvar_gene_esearch", "fixed", "One HGNC gene symbol per ClinVar ESearch JSON response.", "utf8", "clinvar"),
  descriptor(GOLD9_PROVIDER_IDS.clingenGeneValidity, "clingen_gene_validity", "fixed", "The current ClinGen gene-validity CSV response.", "utf8", null),
  descriptor(NCBI_TAXONOMY_FILES_PROVIDER_ID, "ncbi_taxonomy", "fixed", "One NCBI Taxonomy name or taxid per binding; fixed E-utilities ESearch JSON or EFetch XML response.", "utf8", "ncbi_taxonomy"),
]);

export const DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS: readonly CoreAcquisitionProviderDescriptor[] =
  Object.freeze(CORE_ACQUISITION_PROVIDER_DESCRIPTORS.filter((entry) => entry.dynamicInput !== "binary_archive"));

export function createCoreAcquisitionProviders(): readonly AcquisitionProviderHandler[] {
  return [
    createChemblFilesProvider(),
    createGeoFilesProvider(),
    createGdcFilesProvider(),
    ...createFixedBiomedicalProviders(),
    ...createExtendedAcquisitionProviders(),
    createGmrepoFilesProvider(),
    ...createGold9AcquisitionProviders(),
    createNcbiTaxonomyFilesProvider(),
  ];
}
