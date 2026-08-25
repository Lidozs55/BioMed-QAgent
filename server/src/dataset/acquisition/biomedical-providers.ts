import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest, JsonValue } from "@biomed/contracts";

import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";
import { CHEMBL_FILES_PROVIDER_ID } from "./chembl-provider.js";
import {
  GDC_FILES_PROVIDER_ID,
  GEO_FILES_PROVIDER_ID,
} from "./expression-providers.js";

export const FIXED_BIOMEDICAL_PROVIDER_IDS = Object.freeze({
  pdb: "pdb.files.v1",
  pubmed: "pubmed.files.v1",
  uniprot: "uniprot.files.v1",
  clinvar: "clinvar.files.v1",
  clinicalTrials: "clinicaltrials.files.v1",
  pubchem: "pubchem.files.v1",
});

export const FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS = Object.freeze({
  pdb: "39d39ec534eea9f8464e94a7968ac1a104e3e1d44b2cc348d309e9918b5817bc",
  pubmed: "b3bc9c49af86c378becf411120946ea20b245039379586c07a64ce5a1b53ecf5",
  uniprot: "5b646512b83f11b9cb936fb815f5b2cb039e08bddcf78f1beaa3efef2795cbc4",
  clinvar: "49f07112144a794dde52370e018b8ca7ab46efbb7dcc9e3676908e788b94f0fe",
  clinicalTrials: "79af22071345a2f31094f86a4a6c2965d113b8817e4ab99586dc959a94474d6d",
  pubchem: "85dda22b9f274c0fc3277e1bf9b5f1e8e8ac8c63b1504cf40417c3ebd83e2bd7",
});

const FIXED_PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PDB_RESPONSE_BYTES = 64 * 1024 * 1024;

type FixedParameters = {
  source: string;
  accession: string | null;
  entities: Record<string, string[]>;
};

type ProviderDefinition = {
  providerId: string;
  implementationDigest: string;
  source: string;
  identifierName: string;
  entityKeys: readonly string[];
  identifierPattern: RegExp;
  normalizeIdentifier: (value: string) => string;
  plan: (identifier: string) => AcquisitionDownloadPlan;
};

function parseFixedParameters(request: CoreAcquisitionRequest, definition: ProviderDefinition): FixedParameters {
  if (request.mode !== "builtin" || request.provider_id !== definition.providerId) {
    throw new TypeError(`${definition.providerId} only accepts its fixed builtin acquisition contract`);
  }
  const keys = Object.keys(request.parameters);
  if (keys.some((key) => !FIXED_PARAMETER_KEYS.has(key))) {
    throw new TypeError(`${definition.providerId} accepts only server-owned source, accession, and entities`);
  }
  const source = request.parameters.source;
  const accession = request.parameters.accession;
  const entities = request.parameters.entities;
  if (source !== definition.source) {
    throw new TypeError(`${definition.providerId} requires binding source '${definition.source}'`);
  }
  if (accession !== null && typeof accession !== "string") {
    throw new TypeError(`${definition.providerId} accession must be a string or null`);
  }
  if (entities === null || Array.isArray(entities) || typeof entities !== "object") {
    throw new TypeError(`${definition.providerId} entities must be a string-array record`);
  }
  const parsedEntities: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entities)) {
    if (/(?:url|path|code|command|script)/i.test(key)) {
      throw new TypeError(`${definition.providerId} entities must not contain URL, path, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${definition.providerId} entities must be a string-array record`);
    }
    parsedEntities[key] = value;
  }
  return { source, accession, entities: parsedEntities };
}

function identifierFrom(parameters: FixedParameters, definition: ProviderDefinition): string {
  const candidates = [
    ...(parameters.accession === null ? [] : [parameters.accession]),
    ...definition.entityKeys.flatMap((key) => parameters.entities[key] ?? []),
  ];
  for (const candidate of candidates) {
    const normalized = definition.normalizeIdentifier(candidate.trim());
    if (definition.identifierPattern.test(normalized)) return normalized;
  }
  throw new TypeError(`${definition.providerId} requires a valid ${definition.identifierName} in binding accession or entities`);
}

function sourceId(providerId: string, accession: string): string {
  const digest = createHash("sha256").update(`${providerId}\u0000${accession}`).digest("hex").slice(0, 20);
  return `source_${providerId.split(".", 1)[0]}_${digest}`;
}

function sourcePlan(options: {
  providerId: string;
  database: "pdb" | "pubmed" | "uniprot" | "pubchem" | "clinvar" | "clinicaltrials_gov";
  accession: string;
  url: string;
  title: string;
  filename: string;
  host: string;
  maxBytes?: number;
  expectedMediaTypes?: ReadonlySet<string>;
  accept: string;
}): AcquisitionDownloadPlan {
  return {
    source: {
      schema_version: "1.0",
      source_id: sourceId(options.providerId, options.accession),
      database: options.database,
      accession: options.accession,
      url: options.url,
      title: options.title,
      retrieved_at: new Date().toISOString(),
    },
    filename: options.filename,
    dataLevel: "repository_processed",
    maxBytes: options.maxBytes ?? MAX_API_RESPONSE_BYTES,
    ...(options.expectedMediaTypes === undefined ? {} : { expectedMediaTypes: options.expectedMediaTypes }),
    accept: options.accept,
    allowedHosts: new Set([options.host]),
    assetRole: "carrier",
  };
}

const DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.pdb,
    source: "pdb",
    identifierName: "PDB ID",
    entityKeys: ["pdb", "pdb_id", "pdb_ids", "structure", "structure_id", "structure_ids"],
    identifierPattern: /^[0-9][A-Z0-9]{3}$/,
    normalizeIdentifier: (value) => value.toUpperCase(),
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      database: "pdb",
      accession: identifier,
      url: `https://files.rcsb.org/download/${identifier}.pdb`,
      title: `RCSB PDB structure ${identifier}`,
      filename: `${identifier}.pdb`,
      host: "files.rcsb.org",
      maxBytes: MAX_PDB_RESPONSE_BYTES,
      expectedMediaTypes: new Set(["chemical/x-pdb", "text/plain", "application/octet-stream"]),
      accept: "chemical/x-pdb,text/plain,application/octet-stream;q=0.9",
    }),
  },
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pubmed,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.pubmed,
    source: "pubmed",
    identifierName: "PMCID",
    entityKeys: ["pmc", "pmcid", "pmcids", "paper", "paper_id", "paper_ids"],
    identifierPattern: /^PMC[1-9][0-9]*$/,
    normalizeIdentifier: (value) => value.toUpperCase(),
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pubmed,
      database: "pubmed",
      accession: identifier,
      url: `https://www.ebi.ac.uk/europepmc/webservices/rest/${identifier}/fullTextXML`,
      title: `Europe PMC BioC full text ${identifier}`,
      filename: `${identifier}.xml`,
      host: "www.ebi.ac.uk",
      expectedMediaTypes: new Set(["application/xml", "text/xml", "text/plain"]),
      accept: "application/xml,text/xml;q=0.9",
    }),
  },
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.uniprot,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.uniprot,
    source: "uniprot",
    identifierName: "UniProt accession",
    entityKeys: ["uniprot", "uniprot_id", "uniprot_ids", "protein", "protein_id", "protein_ids"],
    identifierPattern: /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/,
    normalizeIdentifier: (value) => value.toUpperCase(),
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.uniprot,
      database: "uniprot",
      accession: identifier,
      url: `https://rest.uniprot.org/uniprotkb/search?query=accession%3A${identifier}&format=json&size=1`,
      title: `UniProt record ${identifier}`,
      filename: `${identifier}.json`,
      host: "rest.uniprot.org",
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json",
    }),
  },
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinvar,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.clinvar,
    source: "ncbi_clinvar",
    identifierName: "ClinVar accession or UID",
    entityKeys: ["clinvar", "clinvar_id", "clinvar_ids", "variant", "variant_id", "variant_ids"],
    identifierPattern: /^(?:[RSV]CV[0-9]+(?:\.[0-9]+)?|[1-9][0-9]*)$/,
    normalizeIdentifier: (value) => value.toUpperCase(),
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinvar,
      database: "clinvar",
      accession: identifier,
      url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&retmode=json&id=${encodeURIComponent(identifier)}`,
      title: `NCBI ClinVar summary ${identifier}`,
      filename: `${identifier.replace(".", "_")}.json`,
      host: "eutils.ncbi.nlm.nih.gov",
      expectedMediaTypes: new Set(["application/json", "text/plain"]),
      accept: "application/json",
    }),
  },
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinicalTrials,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.clinicalTrials,
    source: "clinicaltrials_gov",
    identifierName: "NCT ID",
    entityKeys: ["nct", "nct_id", "nct_ids", "trial", "trial_id", "trial_ids"],
    identifierPattern: /^NCT[0-9]{8}$/,
    normalizeIdentifier: (value) => value.toUpperCase(),
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.clinicalTrials,
      database: "clinicaltrials_gov",
      accession: identifier,
      url: `https://clinicaltrials.gov/api/v2/studies?query.id=${identifier}&pageSize=1&format=json`,
      title: `ClinicalTrials.gov study ${identifier}`,
      filename: `${identifier}.json`,
      host: "clinicaltrials.gov",
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json",
    }),
  },
  {
    providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pubchem,
    implementationDigest: FIXED_BIOMEDICAL_IMPLEMENTATION_DIGESTS.pubchem,
    source: "pubchem",
    identifierName: "PubChem CID",
    entityKeys: ["pubchem", "pubchem_cid", "pubchem_cids", "compound", "compound_id", "compound_ids"],
    identifierPattern: /^[1-9][0-9]*$/,
    normalizeIdentifier: (value) => value,
    plan: (identifier) => sourcePlan({
      providerId: FIXED_BIOMEDICAL_PROVIDER_IDS.pubchem,
      database: "pubchem",
      accession: identifier,
      url: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${identifier}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,IsomericSMILES,InChIKey,InChI/JSON`,
      title: `PubChem compound identity ${identifier}`,
      filename: `${identifier}.json`,
      host: "pubchem.ncbi.nlm.nih.gov",
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json",
    }),
  },
]);

export function createFixedBiomedicalProviders(): readonly AcquisitionProviderHandler[] {
  return DEFINITIONS.map((definition) => Object.freeze({
    providerId: definition.providerId,
    implementationDigest: definition.implementationDigest,
    plan(request: CoreAcquisitionRequest): AcquisitionDownloadPlan {
      return definition.plan(identifierFrom(parseFixedParameters(request, definition), definition));
    },
  }));
}

export function fixedBiomedicalAcquisitionParameters(options: {
  providerId: string | null;
  source: string;
  accession: string | null;
  entities: Record<string, string[]>;
  bindingParameters: Record<string, JsonValue>;
}): Record<string, JsonValue> | null {
  const providerIds: ReadonlySet<string> = new Set([
    ...Object.values(FIXED_BIOMEDICAL_PROVIDER_IDS),
    CHEMBL_FILES_PROVIDER_ID,
    GEO_FILES_PROVIDER_ID,
    GDC_FILES_PROVIDER_ID,
  ]);
  if (!providerIds.has(options.providerId ?? "")) return null;
  if (
    options.providerId !== GEO_FILES_PROVIDER_ID
    && options.providerId !== GDC_FILES_PROVIDER_ID
    && Object.keys(options.bindingParameters).length !== 0
  ) {
    throw new TypeError(`${options.providerId} does not accept binding parameters`);
  }
  return {
    source: options.source,
    accession: options.accession,
    entities: options.entities,
  };
}
