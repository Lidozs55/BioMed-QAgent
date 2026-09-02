import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type { Database } from "../contracts/enums.js";
import type { AcquisitionDownloadPlan, AcquisitionProviderHandler } from "./runtime.js";

export const GOLD9_PROVIDER_IDS = Object.freeze({
  orphanetProduct1: "orphanet.en_product1.v1",
  orphanetProduct6: "orphanet.en_product6.v1",
  hgncApproved: "hgnc.approved.v1",
  clinvarGeneEsearch: "clinvar.gene-esearch.v1",
  clingenGeneValidity: "clingen.gene-validity.v1",
});

export const GOLD9_IMPLEMENTATION_DIGESTS = Object.freeze({
  // v2: Orphanet carriers now carry an explicit per-plan wall-clock timeout
  // budget (45/20 min) instead of the generic 5-minute HTTP timeout.
  orphanetProduct1: "c2257b4731a7659fcdc3e4cf334d5a3c007f91e87c1cd512cf8490767300002b",
  orphanetProduct6: "703942a006baa1c74f954d95c965521347a83d8f161c4b001bcb42e2f88a6774",
  hgncApproved: "c2c85835ffbc8ebf8ff9a74e39b99e188e13d14e3bb8a97ae4f6dd38b77ae92b",
  // v3: ClinVar gene probe accession gate accepts HGNC symbols with '_'/'@'
  // (Y1: GTF2H2C_2 / SNORD116@ were fail-closed rejected).
  clinvarGeneEsearch: "e01c6c0ea7d4b25d84ed6e9be0ad84e36793d84b30beaf4d0a56068e15c65a34",
  clingenGeneValidity: "5f29c06b8d09320a3b4a1de93d0a7fc9402a01d06a81a9b94091fd6c1e8e9111",
});

const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
// HGNC current symbols legitimately contain '_' (e.g. GTF2H2C_2) and the '@'
// cluster suffix on snoRNA/scaRNA genes (e.g. SNORD116@); both must be usable
// as the ClinVar gene probe accession.
const GENE_SYMBOL = /^[A-Z][A-Z0-9_@-]{0,30}$/;

function sourceId(providerId: string, accession: string): string {
  const digest = createHash("sha256").update(`${providerId}\u0000${accession}`).digest("hex").slice(0, 20);
  return `source_${providerId.split(".", 1)[0]!.replaceAll("-", "_")}_${digest}`;
}

function parseParameters(
  request: CoreAcquisitionRequest,
  providerId: string,
  source: string,
  validateAccession: (value: string) => boolean,
  accessionDescription: string,
): { accession: string; entities: Record<string, string[]> } {
  if (request.mode !== "builtin" || request.provider_id !== providerId) {
    throw new TypeError(`${providerId} only accepts its fixed builtin acquisition contract`);
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError(`${providerId} accepts only source, accession, and entities`);
  }
  if (request.parameters.source !== source) {
    throw new TypeError(`${providerId} requires binding source '${source}'`);
  }
  if (typeof request.parameters.accession !== "string") {
    throw new TypeError(`${providerId} requires a ${accessionDescription}`);
  }
  const accession = request.parameters.accession.trim();
  if (!validateAccession(accession)) {
    throw new TypeError(`${providerId} requires a valid ${accessionDescription}`);
  }
  const rawEntities = request.parameters.entities;
  if (rawEntities === null || Array.isArray(rawEntities) || typeof rawEntities !== "object") {
    throw new TypeError(`${providerId} entities must be a string-array record`);
  }
  const entities: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(rawEntities)) {
    if (/(?:url|path|code|command|script|filename)/i.test(key)) {
      throw new TypeError(`${providerId} entities must not contain URL, path, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${providerId} entities must be a string-array record`);
    }
    entities[key] = value.map((entry) => entry.trim());
  }
  return { accession, entities };
}

function plan(options: {
  providerId: string;
  source: string;
  database: Database;
  accession: string;
  url: string;
  title: string;
  filename: string;
  mediaTypes: ReadonlySet<string>;
  accept: string;
  host: string;
  /** Large-carrier wall-clock budget; defaults to the generic HTTP timeout. */
  timeoutMs?: number;
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
    maxBytes: MAX_RESPONSE_BYTES,
    expectedMediaTypes: options.mediaTypes,
    accept: options.accept,
    allowedHosts: new Set([options.host]),
    assetRole: "carrier",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    providerRevisionFacts: {
      canonical_accession: options.accession,
      provider_snapshot_identity: `${options.providerId}:official-endpoint`,
      provider_revision_token: null,
    },
  };
}

function provider(
  providerId: string,
  implementationDigest: string,
  requestPlan: (request: CoreAcquisitionRequest) => AcquisitionDownloadPlan,
): AcquisitionProviderHandler {
  return Object.freeze({
    providerId,
    implementationDigest,
    async plan(request: CoreAcquisitionRequest): Promise<AcquisitionDownloadPlan> {
      return requestPlan(request);
    },
  });
}

export function createGold9AcquisitionProviders(): readonly AcquisitionProviderHandler[] {
  const xml = new Set(["application/xml", "text/xml", "text/plain", "application/octet-stream"]);
  const tsv = new Set(["text/tab-separated-values", "text/plain", "application/octet-stream"]);
  const json = new Set(["application/json", "text/plain"]);
  const csv = new Set(["text/csv", "text/plain", "application/octet-stream"]);
  // Measured 2026-08-27 from the formal Gold9 rerun journal: en_product1.xml
  // is ~52 MB and orphadata throughput ranged 18-170 KB/s (a 300 s default
  // budget killed three attempts at 92% completion). 45/20 minute budgets
  // keep both carriers inside one wall-clock window even at worst throughput.
  const ORPHANET_PRODUCT1_TIMEOUT_MS = 45 * 60_000;
  const ORPHANET_PRODUCT6_TIMEOUT_MS = 20 * 60_000;
  return [
    provider(GOLD9_PROVIDER_IDS.orphanetProduct1, GOLD9_IMPLEMENTATION_DIGESTS.orphanetProduct1, (request) => {
      const { accession } = parseParameters(request, GOLD9_PROVIDER_IDS.orphanetProduct1, "orphanet_en_product1", (value) => value === "en_product1", "Orphanet product accession");
      return plan({ providerId: GOLD9_PROVIDER_IDS.orphanetProduct1, source: "orphanet_en_product1", database: "orphanet", accession, url: "https://www.orphadata.com/data/xml/en_product1.xml", title: "Orphanet en_product1 XML", filename: "en_product1.xml", mediaTypes: xml, accept: "application/xml,text/xml;q=0.9", host: "www.orphadata.com", timeoutMs: ORPHANET_PRODUCT1_TIMEOUT_MS });
    }),
    provider(GOLD9_PROVIDER_IDS.orphanetProduct6, GOLD9_IMPLEMENTATION_DIGESTS.orphanetProduct6, (request) => {
      const { accession } = parseParameters(request, GOLD9_PROVIDER_IDS.orphanetProduct6, "orphanet_en_product6", (value) => value === "en_product6", "Orphanet product accession");
      return plan({ providerId: GOLD9_PROVIDER_IDS.orphanetProduct6, source: "orphanet_en_product6", database: "orphanet", accession, url: "https://www.orphadata.com/data/xml/en_product6.xml", title: "Orphanet en_product6 XML", filename: "en_product6.xml", mediaTypes: xml, accept: "application/xml,text/xml;q=0.9", host: "www.orphadata.com", timeoutMs: ORPHANET_PRODUCT6_TIMEOUT_MS });
    }),
    provider(GOLD9_PROVIDER_IDS.hgncApproved, GOLD9_IMPLEMENTATION_DIGESTS.hgncApproved, (request) => {
      const { accession } = parseParameters(request, GOLD9_PROVIDER_IDS.hgncApproved, "hgnc_approved", (value) => value === "current", "HGNC approved snapshot accession");
      return plan({ providerId: GOLD9_PROVIDER_IDS.hgncApproved, source: "hgnc_approved", database: "hgnc", accession, url: "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt", title: "HGNC approved complete set TSV", filename: "hgnc_complete_set.txt", mediaTypes: tsv, accept: "text/tab-separated-values,text/plain;q=0.9", host: "storage.googleapis.com" });
    }),
    provider(GOLD9_PROVIDER_IDS.clinvarGeneEsearch, GOLD9_IMPLEMENTATION_DIGESTS.clinvarGeneEsearch, (request) => {
      const { accession } = parseParameters(request, GOLD9_PROVIDER_IDS.clinvarGeneEsearch, "clinvar_gene_esearch", (value) => GENE_SYMBOL.test(value), "HGNC gene symbol");
      const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
      url.searchParams.set("db", "clinvar");
      url.searchParams.set("retmode", "json");
      url.searchParams.set("retmax", "0");
      url.searchParams.set("term", `${accession}[gene] AND (pathogenic[Clinical Significance] OR likely pathogenic[Clinical Significance])`);
      return plan({ providerId: GOLD9_PROVIDER_IDS.clinvarGeneEsearch, source: "clinvar_gene_esearch", database: "clinvar", accession, url: url.toString(), title: `ClinVar ESearch gene response ${accession}`, filename: `${accession}.json`, mediaTypes: json, accept: "application/json", host: "eutils.ncbi.nlm.nih.gov" });
    }),
    provider(GOLD9_PROVIDER_IDS.clingenGeneValidity, GOLD9_IMPLEMENTATION_DIGESTS.clingenGeneValidity, (request) => {
      const { accession } = parseParameters(request, GOLD9_PROVIDER_IDS.clingenGeneValidity, "clingen_gene_validity", (value) => value === "current", "ClinGen gene-validity snapshot accession");
      return plan({ providerId: GOLD9_PROVIDER_IDS.clingenGeneValidity, source: "clingen_gene_validity", database: "clingen", accession, url: "https://search.clinicalgenome.org/kb/gene-validity/download", title: "ClinGen gene-disease validity CSV", filename: "gene-validity.csv", mediaTypes: csv, accept: "text/csv,text/plain;q=0.9", host: "search.clinicalgenome.org" });
    }),
  ];
}
