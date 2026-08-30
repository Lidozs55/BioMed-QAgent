import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  NCBI_TAXONOMY_FILES_PROVIDER_ID,
  createNcbiTaxonomyFilesProvider,
} from "../src/dataset/acquisition/ncbi-taxonomy-provider.js";
import {
  CORE_ACQUISITION_PROVIDER_DESCRIPTORS,
  createCoreAcquisitionProviders,
} from "../src/dataset/acquisition/provider-catalog.js";

function request(accession: string): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: "request_taxonomy",
    task_id: "task_taxonomy",
    requirement_id: "build_taxonomy",
    binding_id: "binding_taxonomy",
    mode: "builtin",
    provider_id: NCBI_TAXONOMY_FILES_PROVIDER_ID,
    recipe_id: null,
    recipe_version: null,
    parameters: { source: "ncbi_taxonomy", accession, entities: {} },
  };
}

describe("NCBI Taxonomy trusted Core provider", () => {
  it("is registered in the Core/Dynamic provider closure", () => {
    expect(CORE_ACQUISITION_PROVIDER_DESCRIPTORS.map((entry) => entry.providerId))
      .toContain(NCBI_TAXONOMY_FILES_PROVIDER_ID);
    expect(createCoreAcquisitionProviders().map((entry) => entry.providerId))
      .toContain(NCBI_TAXONOMY_FILES_PROVIDER_ID);
  });

  it("plans a strict taxonomy name ESearch response form", async () => {
    const provider = createNcbiTaxonomyFilesProvider();
    const plan = await provider.plan(request("Escherichia coli"));

    expect(plan.source).toMatchObject({
      database: "ncbi_taxonomy",
      accession: "Escherichia coli",
      url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=taxonomy&retmode=json&retmax=1&term=Escherichia+coli%5BSCIN%5D",
    });
    expect(plan.filename).toBe("escherichia_coli.json");
    expect(plan.expectedMediaTypes).toEqual(new Set(["application/json", "text/plain"]));
    expect(plan.allowedHosts).toEqual(new Set(["eutils.ncbi.nlm.nih.gov"]));
    expect(plan.assetRole).toBe("carrier");
    expect(plan.providerRevisionFacts).toEqual({
      canonical_accession: "Escherichia coli",
      provider_snapshot_identity: "ncbi.taxonomy.files.v1:official-eutilities",
      provider_revision_token: null,
    });
  });

  it("keeps verbatim literature names as accessions while cleaning the ESearch term", async () => {
    const provider = createNcbiTaxonomyFilesProvider();
    const cases: ReadonlyArray<[string, string]> = [
      ["[Ruminococcus] torques", "Ruminococcus+torques"],
      ["Faecalibacterium prausnitzii [h:1576]", "Faecalibacterium+prausnitzii"],
      ["Bacteroides dorei/vulgatus [c:1104]", "Bacteroides+dorei"],
      ["unnamed Ruminococcus sp. SR1/5 [u:1621]", "Ruminococcus+sp."],
      ["Bifidobacterium catenulatum-Bifidobacterium pseudocatenulatum complex", "Bifidobacterium+catenulatum"],
    ];
    for (const [accession, expectedTerm] of cases) {
      const plan = await provider.plan(request(accession));
      expect(plan.source.accession).toBe(accession);
      expect(plan.source.url).toBe(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=taxonomy&retmode=json&retmax=1&term=${expectedTerm}%5BSCIN%5D`,
      );
    }
  });

  it("plans a taxid EFetch response when the accession is an NCBI taxid", async () => {
    const plan = await createNcbiTaxonomyFilesProvider().plan(request("562"));
    expect(plan.source.url).toBe(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=taxonomy&retmode=xml&id=562",
    );
    expect(plan.filename).toBe("taxid_562.xml");
    expect(plan.expectedMediaTypes).toEqual(new Set(["application/xml", "text/xml", "text/plain"]));
  });

  it("keeps the non-Gold fixture within the fixed ESearch response form", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(import.meta.dirname, "fixtures", "ncbi-taxonomy", "escherichia-coli.json"),
      "utf8",
    )) as { esearchresult?: { idlist?: string[]; querytranslation?: string } };
    expect(fixture.esearchresult).toEqual({
      count: "1",
      retmax: "1",
      retstart: "0",
      idlist: ["562"],
      translationset: [],
      querytranslation: "Escherichia coli[SCIN]",
    });
  });

  it("rejects URL/path injection, arbitrary databases, and unsupported response controls", async () => {
    const provider = createNcbiTaxonomyFilesProvider();
    for (const accession of [
      "https://evil.example/?db=taxonomy",
      "562&db=protein",
      "Escherichia coli\n&retmode=xml",
      "*",
      "Bacteria|Firmicutes",
      "../etc/passwd",
    ]) {
      expect(() => provider.plan(request(accession))).toThrow(/valid taxonomy name or taxid/);
    }

    const injected = request("562");
    injected.parameters.db = "protein";
    expect(() => provider.plan(injected)).toThrow(/only source, accession, and entities/);
  });
it("accepts required context entity keys and still rejects reserved E-utility names", async () => {
  const provider = createNcbiTaxonomyFilesProvider();
  const context = request("Blautia obeum");
  context.parameters.entities = { study_id: ["MGYS00000322"], disease_id: ["D003924"], mesh_id: ["D003924"] };
  const plan = await provider.plan(context);
  expect(plan.source.url).toContain("esearch.fcgi");
  for (const reserved of ["term", "id", "db", "retmode"]) {
    const injected = request("Blautia obeum");
    injected.parameters.entities = { [reserved]: ["x"] };
    expect(() => provider.plan(injected)).toThrow(/must not contain URL, path, database, or code controls/);
  }
});
});
