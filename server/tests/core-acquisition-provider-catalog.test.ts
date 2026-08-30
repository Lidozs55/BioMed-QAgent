import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  CORE_ACQUISITION_PROVIDER_DESCRIPTORS,
  createCoreAcquisitionProviders,
} from "../src/dataset/acquisition/provider-catalog.js";

function request(providerId: string, source: string, accession: string): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: `request_${providerId.replaceAll(".", "_")}`,
    task_id: "task_catalog",
    requirement_id: "build_catalog",
    binding_id: "binding_catalog",
    mode: "builtin",
    provider_id: providerId,
    recipe_id: null,
    recipe_version: null,
    parameters: { source, accession, entities: {} },
  };
}

describe("Core acquisition provider catalog", () => {
  it("keeps runtime handlers and Dynamic Family descriptors in exact closure", () => {
    const descriptorIds = CORE_ACQUISITION_PROVIDER_DESCRIPTORS.map((entry) => entry.providerId);
    const handlerIds = createCoreAcquisitionProviders().map((entry) => entry.providerId);
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length);
    expect(handlerIds).toEqual(descriptorIds);
  });

  it.each([
    ["xena.files.v1", "xena", "TCGA.BRCA.sampleMap/HiSeqV2", "tcga-xena-hub.s3.us-east-1.amazonaws.com", "ucsc_xena"],
    ["reactome.files.v1", "reactome", "R-HSA-199420", "reactome.org", "reactome"],
    ["dbsnp.files.v1", "dbsnp", "rs429358", "api.ncbi.nlm.nih.gov", "dbsnp"],
    ["mgnify.files.v1", "mgnify", "MGYS00000322", "www.ebi.ac.uk", "mgnify"],
    ["openfda.files.v1", "openfda_faers", "ibuprofen", "api.fda.gov", "openfda"],
    ["gwas-catalog.associations.v1", "gwas_catalog", "rs429358", "www.ebi.ac.uk", "gwas_catalog"],
    ["europepmc.supplementary.v1", "europepmc_supplementary", "PMC9005347", "www.ebi.ac.uk", "pubmed"],
    ["europepmc.pdf.v1", "europepmc_pdf", "PMC9005347", "europepmc.org", "pubmed"],
    ["europepmc.fulltext_xml.v1", "europepmc_fulltext_xml", "PMC9005347", "www.ebi.ac.uk", "pubmed"],
    ["gmrepo.files.v1", "gmrepo", "1234", "gmrepo.humangut.info", "gmrepo"],
  ])("plans %s through a provider-owned endpoint", async (providerId, source, accession, host, database) => {
    const provider = createCoreAcquisitionProviders().find((entry) => entry.providerId === providerId);
    expect(provider).toBeDefined();
    const plan = await provider!.plan(request(providerId, source, accession));
    expect(new URL(plan.source.url).hostname).toBe(host);
    expect(plan.source.database).toBe(database);
    expect(plan.allowedHosts).toEqual(new Set([host]));
    expect(plan.assetRole).toBe("carrier");
    expect(plan.providerRevisionFacts?.canonical_accession).toBeTruthy();
  });

  it("rejects source mismatches and agent-controlled URL parameters", async () => {
    const provider = createCoreAcquisitionProviders().find((entry) => entry.providerId === "dbsnp.files.v1")!;
    await expect(provider.plan(request("dbsnp.files.v1", "browser", "rs429358")))
      .rejects.toThrow(/source 'dbsnp'/);
    const injected = request("dbsnp.files.v1", "dbsnp", "rs429358");
    injected.parameters.url = "https://example.test/payload";
    await expect(provider.plan(injected)).rejects.toThrow(/only source, accession, and entities/);
  });

  it("uses current structured Reactome and source-specific Xena endpoints", async () => {
    const providers = createCoreAcquisitionProviders();
    const reactome = providers.find((entry) => entry.providerId === "reactome.files.v1")!;
    const reactomePlan = await reactome.plan(request("reactome.files.v1", "reactome", "R-HSA-199420"));
    expect(reactomePlan.source.url).toBe("https://reactome.org/ContentService/data/participants/R-HSA-199420");
    expect(reactomePlan.expectedMediaTypes).toEqual(new Set(["application/json"]));

    const xena = providers.find((entry) => entry.providerId === "xena.files.v1")!;
    const tcga = await xena.plan(request("xena.files.v1", "xena", "TCGA.BRCA.sampleMap/HiSeqV2"));
    const toil = await xena.plan(request("xena.files.v1", "xena", "probeMap/hugo_gencode_good_hg19_V24lift37"));
    expect(new URL(tcga.source.url).hostname).toBe("tcga-xena-hub.s3.us-east-1.amazonaws.com");
    expect(new URL(toil.source.url).hostname).toBe("toil-xena-hub.s3.us-east-1.amazonaws.com");
  });

  it("plans the fixed Europe PMC PDF carrier as an acquisition-only binary asset", async () => {
    const providers = createCoreAcquisitionProviders();
    const pdf = providers.find((entry) => entry.providerId === "europepmc.pdf.v1");
    expect(pdf).toBeDefined();
    const plan = await pdf!.plan(request("europepmc.pdf.v1", "europepmc_pdf", "PMC9005347"));
    expect(plan.source.url).toBe("https://europepmc.org/api/getPdf?pmcid=PMC9005347");
    expect(plan.filename).toBe("PMC9005347.pdf");
    expect(plan.expectedMediaTypes).toEqual(new Set(["application/pdf"]));
    expect(plan.allowedHosts).toEqual(new Set(["europepmc.org"]));
    expect(plan.assetRole).toBe("carrier");
  });

  it("plans the fixed Europe PMC full-text XML carrier as an acquisition-only binary asset", async () => {
    const providers = createCoreAcquisitionProviders();
    const xml = providers.find((entry) => entry.providerId === "europepmc.fulltext_xml.v1");
    expect(xml).toBeDefined();
    const plan = await xml!.plan(request("europepmc.fulltext_xml.v1", "europepmc_fulltext_xml", "PMC9005347"));
    expect(plan.source.url).toBe("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC9005347/fullTextXML");
    expect(plan.filename).toBe("PMC9005347.xml");
    expect(plan.expectedMediaTypes).toEqual(new Set(["application/xml"]));
    expect(plan.allowedHosts).toEqual(new Set(["www.ebi.ac.uk"]));
    expect(plan.assetRole).toBe("carrier");
  });
});
