import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  CORE_ACQUISITION_PROVIDER_DESCRIPTORS,
  DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS,
  createCoreAcquisitionProviders,
} from "../src/dataset/acquisition/provider-catalog.js";
import {
  GOLD9_PROVIDER_IDS,
  createGold9AcquisitionProviders,
} from "../src/dataset/acquisition/gold9-providers.js";
import { fixedBiomedicalAcquisitionParameters } from "../src/dataset/acquisition/biomedical-providers.js";

function request(providerId: string, source: string, accession: string): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: `request_${providerId.replaceAll(".", "_")}`,
    task_id: "task_gold9",
    build_id: "build_gold9",
    binding_id: "binding_gold9",
    mode: "builtin",
    provider_id: providerId,
    recipe_id: null,
    recipe_version: null,
    parameters: { source, accession, entities: {} },
  };
}

const cases = [
  [GOLD9_PROVIDER_IDS.orphanetProduct1, "orphanet_en_product1", "en_product1", "https://www.orphadata.com/data/xml/en_product1.xml", "en_product1.xml", "application/xml"],
  [GOLD9_PROVIDER_IDS.orphanetProduct6, "orphanet_en_product6", "en_product6", "https://www.orphadata.com/data/xml/en_product6.xml", "en_product6.xml", "application/xml"],
  [GOLD9_PROVIDER_IDS.hgncApproved, "hgnc_approved", "current", "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt", "hgnc_complete_set.txt", "text/tab-separated-values"],
  [GOLD9_PROVIDER_IDS.clinvarGeneEsearch, "clinvar_gene_esearch", "BTK", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&retmode=json&retmax=0&term=BTK%5Bgene%5D", "BTK.json", "application/json"],
  [GOLD9_PROVIDER_IDS.clingenGeneValidity, "clingen_gene_validity", "current", "https://search.clinicalgenome.org/kb/gene-validity/download", "gene-validity.csv", "text/csv"],
] as const;

describe("Gold9 trusted Core acquisition providers", () => {
  it("has exact Core/Dynamic descriptor and handler closure", () => {
    const expected = Object.values(GOLD9_PROVIDER_IDS);
    expect(CORE_ACQUISITION_PROVIDER_DESCRIPTORS.map((entry) => entry.providerId)).toEqual(expect.arrayContaining(expected));
    expect(DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS.map((entry) => entry.providerId)).toEqual(expect.arrayContaining(expected));
    expect(createCoreAcquisitionProviders().map((entry) => entry.providerId)).toEqual(expect.arrayContaining(expected));
    expect(createGold9AcquisitionProviders()).toHaveLength(expected.length);
  });

  it.each(cases)("plans the %s response form", async (providerId, source, accession, url, filename, mediaType) => {
    const provider = createGold9AcquisitionProviders().find((entry) => entry.providerId === providerId);
    expect(provider).toBeDefined();
    const result = await provider!.plan(request(providerId, source, accession));
    expect(result.source.url).toBe(url);
    expect(result.filename).toBe(filename);
    expect(result.expectedMediaTypes).toContain(mediaType);
    expect(result.allowedHosts).toEqual(new Set([new URL(url).hostname]));
    expect(result.assetRole).toBe("carrier");
    expect(result.providerRevisionFacts).toMatchObject({ canonical_accession: accession });
  });

  it("recognizes the ClinVar gene ESearch JSON fixture as the documented response form", async () => {
    const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "gold9", "clinvar-gene-esearch.json"), "utf8")) as { esearchresult?: { querytranslation?: string } };
    expect(fixture.esearchresult?.querytranslation).toBe("BTK[gene]");
  });

  it("projects Gold9 static bindings through the fixed Core parameter allowlist", () => {
    expect(fixedBiomedicalAcquisitionParameters({
      providerId: GOLD9_PROVIDER_IDS.clinvarGeneEsearch,
      source: "clinvar_gene_esearch",
      accession: "BTK",
      entities: {},
      bindingParameters: {},
    })).toEqual({ source: "clinvar_gene_esearch", accession: "BTK", entities: {} });
    expect(() => fixedBiomedicalAcquisitionParameters({
      providerId: GOLD9_PROVIDER_IDS.clinvarGeneEsearch,
      source: "clinvar_gene_esearch",
      accession: "BTK",
      entities: {},
      bindingParameters: { url: "https://evil.example" },
    })).toThrow(/does not accept binding parameters/);
  });

  it.each(cases)("accepts only source/accession/entities for %s", async (providerId, source, accession) => {
    const provider = createGold9AcquisitionProviders().find((entry) => entry.providerId === providerId)!;
    const injected = request(providerId, source, accession);
    injected.parameters.url = "https://evil.example/payload";
    await expect(provider.plan(injected)).rejects.toThrow(/only source, accession, and entities/);
  });

  it.each([
    [GOLD9_PROVIDER_IDS.orphanetProduct1, "orphanet_en_product1", "en_product6"],
    [GOLD9_PROVIDER_IDS.orphanetProduct6, "orphanet_en_product6", "https://evil.example/x"],
    [GOLD9_PROVIDER_IDS.hgncApproved, "hgnc_approved", "../hgnc.tsv"],
    [GOLD9_PROVIDER_IDS.clinvarGeneEsearch, "clinvar_gene_esearch", "not a gene"],
    [GOLD9_PROVIDER_IDS.clingenGeneValidity, "clingen_gene_validity", "gene-validity.csv"],
  ] as const)("rejects an invalid accession for %s", async (providerId, source, accession) => {
    const provider = createGold9AcquisitionProviders().find((entry) => entry.providerId === providerId)!;
    await expect(provider.plan(request(providerId, source, accession))).rejects.toThrow(/valid/);
  });
});
