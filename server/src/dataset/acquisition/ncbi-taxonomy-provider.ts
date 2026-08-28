import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import type { AcquisitionDownloadPlan, AcquisitionProviderHandler } from "./runtime.js";

/**
 * Fixed NCBI Taxonomy E-utilities response forms.
 *
 * A scientific-name accession acquires one ESearch JSON response using the
 * exact-name `[SCIN]` term. A numeric taxid accession acquires one EFetch XML
 * Taxon record. The provider intentionally does not combine those requests or
 * batch names/IDs: the ESearch carrier contains the matched UID, while the
 * EFetch carrier is the form that may contain current name, rank, and lineage
 * fields. This slice does not parse or guarantee lineage semantics.
 */
export const NCBI_TAXONOMY_FILES_PROVIDER_ID = "ncbi.taxonomy.files.v1";
/** Stable provider revision; the implementation digest excludes this constant line. */
export const NCBI_TAXONOMY_FILES_IMPLEMENTATION_DIGEST =
  "48f489e028803cb4cb81da8a4c353bc329e9776ee7c9487c38e0ee7918743e8d";

const NCBI_EUTILS_HOST = "eutils.ncbi.nlm.nih.gov";
const NCBI_EUTILS_BASE = `https://${NCBI_EUTILS_HOST}/entrez/eutils`;
const NCBI_TAXONOMY_SOURCE = "ncbi_taxonomy";
const NCBI_TAXONOMY_DATABASE = "taxonomy";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
/** Exact E-utility parameter names that entities must never shadow. */
const NCBI_EUTILITY_RESERVED_KEYS = new Set([
  "id", "term", "db", "retmode", "rettype", "retstart", "retmax", "api_key",
  "webenv", "usehistory", "tool", "email", "url", "path", "command", "script",
  "filename",
]);
const TAXID = /^[1-9][0-9]{0,11}$/;
const TAXONOMY_NAME = /^(?=.{1,240}$)(?=.*\p{L})[\p{L}\p{N}][\p{L}\p{N} .()'_-]*$/u;

function sourceId(accession: string): string {
  const digest = createHash("sha256")
    .update(`${NCBI_TAXONOMY_FILES_PROVIDER_ID}\u0000${accession}`)
    .digest("hex")
    .slice(0, 20);
  return `source_ncbi_taxonomy_${digest}`;
}

function filenameFor(accession: string): string {
  if (TAXID.test(accession)) return `taxid_${accession}.xml`;
  const slug = accession
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${slug || "taxonomy"}.json`;
}

function parseAccession(request: CoreAcquisitionRequest): string {
  if (request.mode !== "builtin" || request.provider_id !== NCBI_TAXONOMY_FILES_PROVIDER_ID) {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} only accepts its fixed builtin acquisition contract`);
  }
  if (Object.keys(request.parameters).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} accepts only source, accession, and entities`);
  }
  if (request.parameters.source !== NCBI_TAXONOMY_SOURCE) {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} requires binding source '${NCBI_TAXONOMY_SOURCE}'`);
  }
  if (typeof request.parameters.accession !== "string") {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} requires a taxonomy name or taxid`);
  }
  const accession = request.parameters.accession.normalize("NFKC").trim();
  if (!TAXID.test(accession) && !TAXONOMY_NAME.test(accession)) {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} requires a valid taxonomy name or taxid`);
  }
  const entities = request.parameters.entities;
  if (entities === null || Array.isArray(entities) || typeof entities !== "object") {
    throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} entities must be a string-array record`);
  }
  for (const [key, value] of Object.entries(entities)) {
    // Entities are declaration metadata (study_id, disease_id, ...) and are
    // never forwarded into E-utilities; only EXACT reserved E-utility
    // parameter names are rejected. The previous suffix match also blocked
    // required context keys like `study_id`, breaking the esearch-based
    // taxon closure path.
    if (NCBI_EUTILITY_RESERVED_KEYS.has(key.toLowerCase())) {
      throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} entities must not contain URL, path, database, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} entities must be a string-array record`);
    }
    if (value.some((entry) => /^(?:[A-Za-z]:|[\\/])|(?:https?:|ftp:|[?#&=\r\n])|\.\.[\\/]/i.test(entry))) {
      throw new TypeError(`${NCBI_TAXONOMY_FILES_PROVIDER_ID} entities must not contain URL, query, or path controls`);
    }
  }
  return accession;
}

function taxonomyUrl(accession: string): string {
  const url = new URL(`${NCBI_EUTILS_BASE}/${TAXID.test(accession) ? "efetch" : "esearch"}.fcgi`);
  url.searchParams.set("db", NCBI_TAXONOMY_DATABASE);
  url.searchParams.set("retmode", TAXID.test(accession) ? "xml" : "json");
  if (TAXID.test(accession)) {
    url.searchParams.set("id", accession);
  } else {
    url.searchParams.set("retmax", "1");
    url.searchParams.set("term", `${accession}[SCIN]`);
  }
  return url.toString();
}

export function createNcbiTaxonomyFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: NCBI_TAXONOMY_FILES_PROVIDER_ID,
    implementationDigest: NCBI_TAXONOMY_FILES_IMPLEMENTATION_DIGEST,
    plan(request: CoreAcquisitionRequest): AcquisitionDownloadPlan {
      const accession = parseAccession(request);
      const url = taxonomyUrl(accession);
      return {
        source: {
          schema_version: "1.0",
          source_id: sourceId(accession),
          database: "ncbi_taxonomy",
          accession,
          url,
          title: `NCBI Taxonomy E-utilities response ${accession}`,
          retrieved_at: new Date().toISOString(),
        },
        filename: filenameFor(accession),
        dataLevel: "repository_processed",
        maxBytes: MAX_RESPONSE_BYTES,
        expectedMediaTypes: TAXID.test(accession)
          ? new Set(["application/xml", "text/xml", "text/plain"])
          : new Set(["application/json", "text/plain"]),
        accept: TAXID.test(accession)
          ? "application/xml,text/xml;q=0.9"
          : "application/json,text/plain;q=0.9",
        allowedHosts: new Set([NCBI_EUTILS_HOST]),
        assetRole: "carrier",
        providerRevisionFacts: {
          canonical_accession: accession,
          provider_snapshot_identity: `${NCBI_TAXONOMY_FILES_PROVIDER_ID}:official-eutilities`,
          provider_revision_token: null,
        },
      };
    },
  });
}
