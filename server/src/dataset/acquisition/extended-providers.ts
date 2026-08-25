import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import { buildXenaDownloadUrl } from "../../external/xena/index.js";
import type { Database } from "../contracts/enums.js";
import type { AcquisitionDownloadPlan, AcquisitionProviderHandler } from "./runtime.js";

export const EXTENDED_PROVIDER_IDS = Object.freeze({
  xena: "xena.files.v1",
  reactome: "reactome.files.v1",
  dbsnp: "dbsnp.files.v1",
  mgnify: "mgnify.files.v1",
  openfda: "openfda.files.v1",
  gwasCatalog: "gwas-catalog.associations.v1",
  europePmcSupplementary: "europepmc.supplementary.v1",
});

const IMPLEMENTATION_DIGESTS: Readonly<Record<keyof typeof EXTENDED_PROVIDER_IDS, string>> = Object.freeze({
  xena: "b7250340f69d4360fcb2ef5f023bbcf94fa241e7ac13e5af8c3636a86686cd81",
  reactome: "efd4d39c9b922f6bd79d10bafe5f0afc8b68ae65c7616a506f80ce22eb790bdf",
  dbsnp: "584660e4df5553b854a0f089209936fed5830738591cc36ee7e6087039d036c1",
  mgnify: "a39a0bbf2e7dace89861dca1d2cda4f0b53054196641a767de263fd85f31c66b",
  openfda: "209eb79c902cafaa40295ee64da023599ca15e2dc26494b00909ab7671a4b4e1",
  gwasCatalog: "04c46c50d13b03b6920d75b8122370141c6a748b3deeed605991cf324c3741e0",
  europePmcSupplementary: "f87e4e571724fdcb8b22c52aac97164f195a7ad8ff64cfd760dd930e5e60134d",
});

const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_DATASET_BYTES = 4096 * 1024 * 1024;

type Parameters = {
  source: string;
  accession: string;
  entities: Readonly<Record<string, readonly string[]>>;
};

type Definition = {
  key: keyof typeof EXTENDED_PROVIDER_IDS;
  source: string;
  database: Database;
  normalize: (value: string) => string;
  validate: (value: string) => boolean;
  identifierName: string;
  plan: (identifier: string, entities: Parameters["entities"]) => Omit<AcquisitionDownloadPlan, "source"> & {
    url: string;
    title: string;
  };
};

function parseParameters(request: CoreAcquisitionRequest, definition: Definition): Parameters {
  const providerId = EXTENDED_PROVIDER_IDS[definition.key];
  if (request.mode !== "builtin" || request.provider_id !== providerId) {
    throw new TypeError(`${providerId} only accepts its fixed builtin acquisition contract`);
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError(`${providerId} accepts only source, accession, and entities`);
  }
  if (request.parameters.source !== definition.source) {
    throw new TypeError(`${providerId} requires binding source '${definition.source}'`);
  }
  if (typeof request.parameters.accession !== "string") {
    throw new TypeError(`${providerId} requires a ${definition.identifierName}`);
  }
  const identifier = definition.normalize(request.parameters.accession.trim());
  if (!definition.validate(identifier)) {
    throw new TypeError(`${providerId} requires a valid ${definition.identifierName}`);
  }
  const rawEntities = request.parameters.entities;
  if (rawEntities === null || Array.isArray(rawEntities) || typeof rawEntities !== "object") {
    throw new TypeError(`${providerId} entities must be a string-array record`);
  }
  const entities: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(rawEntities)) {
    if (/(?:url|path|code|command|script)/i.test(key)) {
      throw new TypeError(`${providerId} entities must not contain URL, path, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${providerId} entities must be a string-array record`);
    }
    entities[key] = value.map((entry) => entry.trim());
  }
  return { source: definition.source, accession: identifier, entities };
}

function sourceId(providerId: string, accession: string): string {
  const digest = createHash("sha256").update(`${providerId}\u0000${accession}`).digest("hex").slice(0, 20);
  return `source_${providerId.split(".", 1)[0]!.replaceAll("-", "_")}_${digest}`;
}

function openFdaUrl(drugName: string): string {
  const url = new URL("https://api.fda.gov/drug/event.json");
  url.searchParams.set("search", `patient.drug.openfda.generic_name:"${drugName}"`);
  url.searchParams.set("count", "patient.reaction.reactionmeddrapt.exact");
  url.searchParams.set("limit", "999");
  return url.toString();
}

const DEFINITIONS: readonly Definition[] = Object.freeze([
  {
    key: "xena", source: "xena", database: "ucsc_xena", identifierName: "UCSC Xena dataset ID",
    normalize: (value) => value, validate: (value) => value.length > 0 && value.length <= 512 && !/[\\?#\r\n]/.test(value) && !value.split("/").includes(".."),
    plan: (identifier) => {
      const url = buildXenaDownloadUrl(identifier);
      return {
        url, title: `UCSC Xena dataset ${identifier}`,
        filename: `${identifier.replaceAll("/", "_").replace(/\.gz$/i, "")}.gz`, dataLevel: "repository_processed",
        maxBytes: MAX_DATASET_BYTES,
        expectedMediaTypes: new Set(["application/gzip", "application/octet-stream", "binary/octet-stream"]),
        accept: "application/gzip,application/octet-stream;q=0.9", allowedHosts: new Set([new URL(url).hostname]),
        assetRole: "carrier",
      };
    },
  },
  {
    key: "reactome", source: "reactome", database: "reactome", identifierName: "Reactome stable pathway ID",
    normalize: (value) => value.toUpperCase(), validate: (value) => /^R-[A-Z]{3}-[1-9][0-9]*$/.test(value),
    plan: (identifier) => ({
      url: `https://reactome.org/ContentService/data/participants/${identifier}`,
      title: `Reactome pathway participants ${identifier}`, filename: `${identifier}_participants.json`,
      dataLevel: "repository_processed", maxBytes: MAX_JSON_BYTES,
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json", allowedHosts: new Set(["reactome.org"]), assetRole: "carrier",
    }),
  },
  {
    key: "dbsnp", source: "dbsnp", database: "dbsnp", identifierName: "rsID",
    normalize: (value) => value.toLowerCase(), validate: (value) => /^rs[1-9][0-9]*$/.test(value),
    plan: (identifier) => ({
      url: `https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/${identifier.slice(2)}`,
      title: `NCBI RefSNP record ${identifier}`, filename: `${identifier}.json`, dataLevel: "repository_processed",
      maxBytes: MAX_JSON_BYTES, expectedMediaTypes: new Set(["application/json"]), accept: "application/json",
      allowedHosts: new Set(["api.ncbi.nlm.nih.gov"]), assetRole: "carrier",
    }),
  },
  {
    key: "mgnify", source: "mgnify", database: "mgnify", identifierName: "MGnify study accession",
    normalize: (value) => value.toUpperCase(), validate: (value) => /^MGYS[0-9]{8}$/.test(value),
    plan: (identifier) => ({
      url: `https://www.ebi.ac.uk/metagenomics/api/v1/studies/${identifier}`,
      title: `MGnify study ${identifier}`, filename: `${identifier}.json`, dataLevel: "repository_processed",
      maxBytes: MAX_JSON_BYTES, expectedMediaTypes: new Set(["application/json", "application/vnd.api+json"]),
      accept: "application/vnd.api+json,application/json;q=0.9",
      allowedHosts: new Set(["www.ebi.ac.uk"]), assetRole: "carrier",
    }),
  },
  {
    key: "openfda", source: "openfda_faers", database: "openfda", identifierName: "drug generic name",
    normalize: (value) => value, validate: (value) => value.length > 0 && value.length <= 128 && !/["\\\r\n]/.test(value),
    plan: (identifier) => ({
      url: openFdaUrl(identifier), title: `openFDA FAERS reaction aggregate for ${identifier}`,
      filename: `${createHash("sha256").update(identifier).digest("hex").slice(0, 16)}.json`, dataLevel: "repository_processed",
      maxBytes: MAX_JSON_BYTES, expectedMediaTypes: new Set(["application/json"]), accept: "application/json",
      allowedHosts: new Set(["api.fda.gov"]), assetRole: "carrier",
    }),
  },
  {
    key: "gwasCatalog", source: "gwas_catalog", database: "gwas_catalog", identifierName: "GWAS Catalog study accession or rsID",
    normalize: (value) => /^(?:GCST)/i.test(value) ? value.toUpperCase() : value.toLowerCase(),
    validate: (value) => /^(?:GCST[0-9]+|rs[1-9][0-9]*)$/.test(value),
    plan: (identifier) => {
      const resource = identifier.startsWith("GCST")
        ? `studies/${identifier}/associations`
        : `singleNucleotidePolymorphisms/${identifier}/associations`;
      return {
        url: `https://www.ebi.ac.uk/gwas/rest/api/${resource}`,
        title: `GWAS Catalog associations for ${identifier}`, filename: `${identifier}_associations.json`,
        dataLevel: "repository_processed", maxBytes: MAX_JSON_BYTES,
        expectedMediaTypes: new Set(["application/json", "application/hal+json"]),
        accept: "application/hal+json,application/json;q=0.9",
        allowedHosts: new Set(["www.ebi.ac.uk"]), assetRole: "carrier",
      };
    },
  },
  {
    key: "europePmcSupplementary", source: "europepmc_supplementary", database: "pubmed",
    identifierName: "PMCID", normalize: (value) => value.toUpperCase(), validate: (value) => /^PMC[1-9][0-9]*$/.test(value),
    plan: (identifier) => ({
      url: `https://www.ebi.ac.uk/europepmc/webservices/rest/${identifier}/supplementaryFiles`,
      title: `Europe PMC supplementary archive ${identifier}`, filename: `${identifier}_supplementary.zip`,
      dataLevel: "repository_processed", maxBytes: MAX_DATASET_BYTES,
      expectedMediaTypes: new Set(["application/zip", "application/octet-stream"]),
      accept: "application/zip", allowedHosts: new Set(["www.ebi.ac.uk"]), assetRole: "carrier",
    }),
  },
]);

export function createExtendedAcquisitionProviders(): readonly AcquisitionProviderHandler[] {
  return DEFINITIONS.map((definition) => {
    const providerId = EXTENDED_PROVIDER_IDS[definition.key];
    return Object.freeze({
      providerId,
      implementationDigest: IMPLEMENTATION_DIGESTS[definition.key],
      async plan(request: CoreAcquisitionRequest): Promise<AcquisitionDownloadPlan> {
        const parameters = parseParameters(request, definition);
        const planned = definition.plan(parameters.accession, parameters.entities);
        return {
          source: {
            schema_version: "1.0",
            source_id: sourceId(providerId, parameters.accession),
            database: definition.database,
            accession: parameters.accession,
            url: planned.url,
            title: planned.title,
            retrieved_at: new Date().toISOString(),
          },
          filename: planned.filename,
          dataLevel: planned.dataLevel,
          maxBytes: planned.maxBytes,
          expectedMediaTypes: planned.expectedMediaTypes,
          accept: planned.accept,
          allowedHosts: planned.allowedHosts,
          assetRole: planned.assetRole,
          providerRevisionFacts: {
            canonical_accession: parameters.accession,
            provider_snapshot_identity: `${providerId}:official-endpoint`,
            provider_revision_token: null,
          },
        };
      },
    });
  });
}
