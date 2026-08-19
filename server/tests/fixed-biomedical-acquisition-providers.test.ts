import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  createFixedBiomedicalProviders,
  FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS,
  FIXED_BIOMEDICAL_PROVIDER_IDS,
  fixedBiomedicalAcquisitionParameters,
} from "../src/dataset/acquisition/biomedical-providers.js";
import { CoreAcquisitionRegistry } from "../src/dataset/acquisition/runtime.js";

function request(options: {
  providerId: string;
  source: string;
  accession?: string | null;
  entities?: Record<string, string[]>;
  extra?: Record<string, import("@biomed/contracts").JsonValue>;
}): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: `request_${options.providerId.replaceAll(".", "_")}`,
    task_id: "task_provider",
    build_id: "build_provider",
    binding_id: "binding_provider",
    mode: "builtin",
    provider_id: options.providerId,
    recipe_id: null,
    recipe_version: null,
    parameters: {
      source: options.source,
      accession: options.accession ?? null,
      entities: options.entities ?? {},
      ...options.extra,
    },
  };
}

function registry(): CoreAcquisitionRegistry {
  const value = new CoreAcquisitionRegistry();
  for (const provider of createFixedBiomedicalProviders()) value.registerProvider(provider);
  return value;
}

describe("fixed biomedical acquisition provider registry", () => {
  it("registers all fixed implementation digests and resolves every provider", () => {
    const value = registry();
    const cases = [
      [FIXED_BIOMEDICAL_PROVIDER_IDS.pdb, "pdb", "6m0j"],
      [FIXED_BIOMEDICAL_PROVIDER_IDS.pubmed, "pubmed", "PMC10408569"],
      [FIXED_BIOMEDICAL_PROVIDER_IDS.uniprot, "uniprot", "P00533"],
      [FIXED_BIOMEDICAL_PROVIDER_IDS.clinvar, "ncbi_clinvar", "VCV000123456"],
      [FIXED_BIOMEDICAL_PROVIDER_IDS.clinicalTrials, "clinicaltrials_gov", "NCT02411448"],
    ] as const;

    for (const [providerId, source, accession] of cases) {
      const resolved = value.resolve(request({ providerId, source, accession }), "task_provider");
      expect(resolved.handler.providerId).toBe(providerId);
      expect(resolved.handler.implementationDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(createFixedBiomedicalProviders().map((provider) => provider.implementationDigest)).toEqual(
      Object.values(FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS),
    );
  });

  it.each([
    {
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pubmed,
      source: "pubmed",
      accession: "PMC10408569",
      url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10408569/fullTextXML",
      filename: "PMC10408569.xml",
      host: "www.ebi.ac.uk",
    },
    {
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.uniprot,
      source: "uniprot",
      accession: "P00533",
      url: "https://rest.uniprot.org/uniprotkb/search?query=accession%3AP00533&format=json&size=1",
      filename: "P00533.json",
      host: "rest.uniprot.org",
    },
    {
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinvar,
      source: "ncbi_clinvar",
      accession: "VCV000123456",
      url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&retmode=json&id=VCV000123456",
      filename: "VCV000123456.json",
      host: "eutils.ncbi.nlm.nih.gov",
    },
    {
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinicalTrials,
      source: "clinicaltrials_gov",
      accession: "NCT02411448",
      url: "https://clinicaltrials.gov/api/v2/studies?query.id=NCT02411448&pageSize=1&format=json",
      filename: "NCT02411448.json",
      host: "clinicaltrials.gov",
    },
  ])("derives the $providerId plan from a fixed official endpoint", async (entry) => {
    const resolved = registry().resolve(request(entry), "task_provider");
    const plan = await resolved.handler.plan(resolved.request);
    expect(plan.source).toMatchObject({ accession: entry.accession, url: entry.url });
    expect(plan.filename).toBe(entry.filename);
    expect(plan.allowedHosts).toEqual(new Set([entry.host]));
    expect(plan.assetRole).toBe("carrier");
  });

  it("maps a PDB accession or server-owned entity ID to the fixed RCSB file URL", async () => {
    const value = registry();
    const fromAccession = value.resolve(request({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "pdb",
      accession: "6m0j",
    }), "task_provider");
    const accessionPlan = await fromAccession.handler.plan(fromAccession.request);
    expect(accessionPlan.source).toMatchObject({
      database: "pdb",
      accession: "6M0J",
      url: "https://files.rcsb.org/download/6M0J.pdb",
    });
    expect(accessionPlan).toMatchObject({ filename: "6M0J.pdb", assetRole: "carrier" });

    const fromEntities = value.resolve(request({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "pdb",
      entities: { protein: ["ACE2"], pdb_ids: ["7df4"] },
    }), "task_provider");
    const entityPlan = await fromEntities.handler.plan(fromEntities.request);
    expect(entityPlan.source.url).toBe("https://files.rcsb.org/download/7DF4.pdb");
  });

  it.each<{ extra: Record<string, import("@biomed/contracts").JsonValue>; message: RegExp }>([
    { extra: { url: "https://evil.example/payload" }, message: /server-owned|code or paths/ },
    { extra: { output_path: "../workspace/payload" }, message: /code or paths|arbitrary paths/ },
    { extra: { agent_code: "fetch('https://evil.example')" }, message: /code or paths/ },
  ])("rejects URL, path, and code controls before planning", async ({ extra, message }) => {
    const value = registry();
    const execute = async (): Promise<void> => {
      const resolved = value.resolve(request({
        providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
        source: "pdb",
        accession: "6M0J",
        extra,
      }), "task_provider");
      await resolved.handler.plan(resolved.request);
    };
    await expect(execute()).rejects.toThrow(message);
  });

  it("rejects source mismatch and non-identifier entities", async () => {
    const value = registry();
    const wrongSource = value.resolve(request({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "browser",
      accession: "6M0J",
    }), "task_provider");
    expect(() => wrongSource.handler.plan(wrongSource.request)).toThrow(/requires binding source 'pdb'/);

    const missingId = value.resolve(request({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "pdb",
      entities: { gene: ["EGFR"] },
    }), "task_provider");
    expect(() => missingId.handler.plan(missingId.request)).toThrow(/valid PDB ID/);
  });

  it("projects only validated binding accession and server-owned entities", () => {
    expect(fixedBiomedicalAcquisitionParameters({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "pdb",
      accession: "6M0J",
      entities: { pdb_ids: ["6M0J"] },
      bindingParameters: {},
    })).toEqual({ source: "pdb", accession: "6M0J", entities: { pdb_ids: ["6M0J"] } });
    expect(() => fixedBiomedicalAcquisitionParameters({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      source: "pdb",
      accession: "6M0J",
      entities: {},
      bindingParameters: { url: "https://evil.example" },
    })).toThrow(/does not accept binding parameters/);
  });
});
