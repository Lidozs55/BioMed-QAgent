import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import {
  createGwasCatalogTools,
  lookupGwasCatalog,
} from "../../src/agent/tools/gwas-catalog.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "www.ebi.ac.uk";
const servers: FixtureServer[] = [];
const immediateLimiter = { wait: async (): Promise<void> => undefined };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

describe("lookupGwasCatalog", () => {
  it("resolves a PubMed ID to source-linked GWAS Catalog studies", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://www.ebi.ac.uk");
      expect(url.pathname).toBe("/gwas/rest/api/studies/search/findByPublicationIdPubmedId");
      expect(url.searchParams.get("pubmedId")).toBe("35379992");
      expect(url.searchParams.get("size")).toBe("5");
      res.writeHead(200, { "content-type": "application/hal+json" });
      res.end(JSON.stringify({
        _embedded: {
          studies: [{
            accessionId: "GCST90027158",
            initialSampleSize: "487,511 European ancestry individuals",
            replicationSampleSize: "",
            publicationInfo: { pubmedId: "35379992", title: "New insights into the genetic etiology of Alzheimer's disease" },
            diseaseTrait: { trait: "Alzheimer disease" },
            _links: { self: { href: "https://www.ebi.ac.uk/gwas/rest/api/studies/GCST90027158" } },
          }],
        },
        page: { totalElements: 1 },
      }));
    });
    servers.push(fixture);

    const result = await lookupGwasCatalog("pubmed_id", "35379992", 5, {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });

    expect(result).toMatchObject({
      source: "gwas_catalog",
      query_type: "pubmed_id",
      query: "35379992",
      result_type: "studies",
      total_count: 1,
      records_count: 1,
    });
    expect(result.records[0]).toMatchObject({
      study_accession: "GCST90027158",
      pubmed_id: "35379992",
      trait: "Alzheimer disease",
      source_url: "https://www.ebi.ac.uk/gwas/rest/api/studies/GCST90027158",
    });
  });

  it("returns bounded association evidence for a study accession", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://www.ebi.ac.uk");
      expect(url.pathname).toBe("/gwas/rest/api/studies/GCST90027158/associations");
      res.writeHead(200, { "content-type": "application/hal+json" });
      res.end(JSON.stringify({
        _embedded: {
          associations: [{
            pvalue: 2e-12,
            pvalueMantissa: 2,
            pvalueExponent: -12,
            betaNum: 0.13,
            betaUnit: "unit increase",
            betaDirection: "increase",
            standardError: 0.02,
            range: "[0.09-0.17]",
            loci: [{
              strongestRiskAlleles: [{ riskAlleleName: "rs429358-C" }],
              authorReportedGenes: [{ geneName: "APOE" }],
              mappedGenes: [{ geneName: "APOE" }, { geneName: "TOMM40" }],
            }],
            _links: {
              self: { href: "https://www.ebi.ac.uk/gwas/rest/api/associations/123" },
              study: { href: "https://www.ebi.ac.uk/gwas/rest/api/studies/GCST90027158" },
            },
          }],
        },
        page: { totalElements: 83 },
      }));
    });
    servers.push(fixture);

    const result = await lookupGwasCatalog("study_accession", "gcst90027158", 10, {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });

    expect(result).toMatchObject({
      query: "GCST90027158",
      result_type: "associations",
      total_count: 83,
      records_count: 1,
    });
    expect(result.records[0]).toMatchObject({
      association_id: "123",
      study_accession: "GCST90027158",
      p_value: 2e-12,
      p_value_mantissa: 2,
      p_value_exponent: -12,
      beta: 0.13,
      beta_unit: "unit increase",
      beta_direction: "increase",
      strongest_risk_alleles: ["rs429358-C"],
      reported_genes: ["APOE"],
      mapped_genes: ["APOE", "TOMM40"],
    });
  });

  it("uses the official rsID relation and leaves an undisclosed total unknown", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = new URL(req.url ?? "", "https://www.ebi.ac.uk");
      expect(url.pathname).toBe("/gwas/rest/api/singleNucleotidePolymorphisms/rs429358/associations");
      res.writeHead(200, { "content-type": "application/hal+json" });
      res.end(JSON.stringify({
        _embedded: {
          associations: [{
            pvalue: 1e-9,
            loci: [{ strongestRiskAlleles: [{ riskAlleleName: "rs429358-?" }] }],
            _links: {
              self: { href: "https://www.ebi.ac.uk/gwas/rest/api/associations/17463923" },
              study: { href: "https://www.ebi.ac.uk/gwas/rest/api/associations/17463923/study" },
            },
          }],
        },
      }));
    });
    servers.push(fixture);

    const result = await lookupGwasCatalog("rs_id", "RS429358", 2, {
      client: client(fixture.port),
      limiter: immediateLimiter,
    });

    expect(result).toMatchObject({
      query: "rs429358",
      total_count: null,
      records_count: 1,
    });
    expect(result.records[0]).toMatchObject({
      association_id: "17463923",
      study_accession: null,
      strongest_risk_alleles: ["rs429358-?"],
    });
  });

  it("rejects malformed identifiers and registers the tool under its skill", async () => {
    await expect(lookupGwasCatalog("rs_id", "429358", 10)).rejects.toThrow(/rsID/i);
    await expect(lookupGwasCatalog("study_accession", "GCST-nope", 10)).rejects.toThrow(/study accession/i);
    const [tool] = createGwasCatalogTools();
    expect(tool?.name).toBe("lookup_gwas_catalog");
    expect(SKILL_TOOL_NAMES.has("lookup_gwas_catalog")).toBe(true);
    expect(toolOwner("lookup_gwas_catalog")).toBe("gwas_catalog");
  });
});
