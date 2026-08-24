import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import { GDC_API_BASE } from "../../external/gdc/api.js";
import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const GEO_FILES_PROVIDER_ID = "geo.files.v1";
export const GDC_FILES_PROVIDER_ID = "gdc.files.v1";

const GEO_IMPLEMENTATION_DIGEST = "0d5b4bb3e3e2ab8dd541df22d0a41d82f8401d5a0040b550c5c0408cbef0f1a1";
const GDC_IMPLEMENTATION_DIGEST = "5dc13f02a763e3c16bd19d8a3f16c7ec1d1c44579b3e9de5d5eb5ef14d5d5b20";
const GEO_DOWNLOAD_HOST = "ftp.ncbi.nlm.nih.gov";
const GEO_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
const GDC_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
const PARAMETER_KEYS = new Set(["source", "accession", "entities"]);
const SAFE_GDC_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GEO_ACCESSION = /^GSE[1-9][0-9]*$/;

type ExpressionParameters = {
  source: string;
  accession: string;
  entities: Record<string, string[]>;
};

function sourceId(providerId: string, accession: string): string {
  const digest = createHash("sha256")
    .update(`${providerId}\u0000${accession}`)
    .digest("hex")
    .slice(0, 20);
  return `source_${providerId.split(".", 1)[0]}_${digest}`;
}

function parseParameters(
  request: CoreAcquisitionRequest,
  providerId: string,
  source: "geo" | "gdc",
): ExpressionParameters {
  if (request.mode !== "builtin" || request.provider_id !== providerId) {
    throw new TypeError(`${providerId} only accepts its fixed builtin acquisition contract`);
  }
  const keys = Object.keys(request.parameters);
  if (keys.some((key) => !PARAMETER_KEYS.has(key))) {
    throw new TypeError(`${providerId} accepts only server-owned source, accession, and entities`);
  }
  if (request.parameters.source !== source) {
    throw new TypeError(`${providerId} requires binding source '${source}'`);
  }
  const accession = request.parameters.accession;
  if (typeof accession !== "string" || accession.trim() === "") {
    throw new TypeError(`${providerId} requires a non-blank accession`);
  }
  const entities = request.parameters.entities;
  if (entities === null || Array.isArray(entities) || typeof entities !== "object") {
    throw new TypeError(`${providerId} entities must be a string-array record`);
  }
  const parsedEntities: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entities)) {
    if (/(?:url|path|code|command|script)/i.test(key)) {
      throw new TypeError(`${providerId} entities must not contain URL, path, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${providerId} entities must be a string-array record`);
    }
    parsedEntities[key] = [...value];
  }
  return { source, accession: accession.trim(), entities: parsedEntities };
}

function geoPlan(parameters: ExpressionParameters): AcquisitionDownloadPlan {
  const accession = parameters.accession.toUpperCase();
  if (!GEO_ACCESSION.test(accession)) {
    throw new TypeError(`${GEO_FILES_PROVIDER_ID} requires a valid GEO series accession`);
  }
  const prefix = `${accession.slice(0, -3)}nnn`;
  return {
    source: {
      schema_version: "1.0",
      source_id: sourceId(GEO_FILES_PROVIDER_ID, accession),
      database: "geo",
      accession,
      url: `https://${GEO_DOWNLOAD_HOST}/geo/series/${prefix}/${accession}/matrix/${accession}_series_matrix.txt.gz`,
      title: `NCBI GEO series matrix ${accession}`,
      retrieved_at: new Date().toISOString(),
    },
    filename: `${accession}_series_matrix.txt.gz`,
    dataLevel: "repository_processed",
    maxBytes: GEO_MAX_DOWNLOAD_BYTES,
    expectedMediaTypes: new Set([
      "application/gzip",
      "application/x-gzip",
      "text/tab-separated-values",
      "text/plain",
      "application/octet-stream",
    ]),
    accept: "application/gzip,application/x-gzip,text/plain;q=0.9,application/octet-stream;q=0.8",
    allowedHosts: new Set([GEO_DOWNLOAD_HOST]),
    assetRole: "carrier",
    providerRevisionFacts: {
      canonical_accession: accession,
      provider_snapshot_identity: "geo:series-matrix:v1",
      provider_revision_token: null,
    },
  };
}

function gdcPlan(parameters: ExpressionParameters): AcquisitionDownloadPlan {
  const accession = parameters.accession.trim();
  if (!SAFE_GDC_FILE_ID.test(accession)) {
    throw new TypeError(`${GDC_FILES_PROVIDER_ID} requires a valid GDC file identifier`);
  }
  return {
    source: {
      schema_version: "1.0",
      source_id: sourceId(GDC_FILES_PROVIDER_ID, accession),
      database: "gdc",
      accession,
      url: `${GDC_API_BASE}/data/${encodeURIComponent(accession)}`,
      title: `NCI GDC file ${accession}`,
      retrieved_at: new Date().toISOString(),
    },
    filename: `${accession}.dat`,
    dataLevel: "repository_processed",
    maxBytes: GDC_MAX_DOWNLOAD_BYTES,
    expectedMediaTypes: new Set([
      "text/tab-separated-values",
      "text/plain",
      "application/octet-stream",
    ]),
    accept: "text/tab-separated-values,text/plain;q=0.9,application/octet-stream;q=0.8",
    allowedHosts: new Set([new URL(GDC_API_BASE).hostname]),
    assetRole: "carrier",
    providerRevisionFacts: {
      canonical_accession: accession,
      provider_snapshot_identity: "gdc:file-data:v1",
      provider_revision_token: null,
    },
  };
}

export function createGeoFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GEO_FILES_PROVIDER_ID,
    implementationDigest: GEO_IMPLEMENTATION_DIGEST,
    plan: (request: CoreAcquisitionRequest) => geoPlan(parseParameters(request, GEO_FILES_PROVIDER_ID, "geo")),
  });
}

export function createGdcFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GDC_FILES_PROVIDER_ID,
    implementationDigest: GDC_IMPLEMENTATION_DIGEST,
    plan: (request: CoreAcquisitionRequest) => gdcPlan(parseParameters(request, GDC_FILES_PROVIDER_ID, "gdc")),
  });
}
