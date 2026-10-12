import { createHash } from "node:crypto";

import type { CoreAcquisitionRequest } from "@biomed/contracts";

import { GDC_API_BASE } from "../../external/gdc/api.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { getGeoListing } from "../../external/geo/client.js";
import { resolveGeoSupplementaryAssets } from "../../external/geo/parsers.js";
import type {
  AcquisitionDownloadPlan,
  AcquisitionProviderHandler,
} from "./runtime.js";

export const GEO_FILES_PROVIDER_ID = "geo.files.v1";
export const GDC_FILES_PROVIDER_ID = "gdc.files.v1";

const GEO_IMPLEMENTATION_DIGEST = "b41a4ba9e86547a9c26d09a63b1b3394dcdcc7601cbf80e0d3a5c9df7fa24b41";
const GDC_IMPLEMENTATION_DIGEST = "5dc13f02a763e3c16bd19c8a3f16c7ec1c1d44579b3e9de5d5eb5ef14d5d5b20";
const GEO_DOWNLOAD_HOST = "ftp.ncbi.nlm.nih.gov";
const GEO_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
const GDC_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
const PARAMETER_KEYS = new Set(["source", "accession", "entities", "file_class", "supplement_index"]);
const SAFE_GDC_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GEO_ACCESSION = /^GSE[1-9][0-9]*$/;
const GEO_FILE_CLASSES = new Set(["series_matrix", "supplementary"]);

type ExpressionParameters = {
  source: string;
  accession: string;
  entities: Record<string, string[]>;
  fileClass: "series_matrix" | "supplementary";
  supplementIndex: number | null;
};

/** ADR-044 server-side enumeration of a series' supplementary directory. */
export type SupplementaryListingResolver = (accession: string) => Promise<readonly { filename: string; url: string }[]>;

function sourceId(providerId: string, accession: string): string {
  const digest = createHash("sha256")
    .update(`${providerId}\u0000${accession}`)
    .digest("hex")
    .slice(0, 20);
  return `source_${providerId.split(".", 1)[0]}_${digest}`;
}

/** ADR-044: supplementary carriers extend the identity input with the
 * server-resolved filename so multiple files of one series never collide;
 * fixed-path carrier identity stays byte-identical to the historical form. */
function sourceIdSupplementary(providerId: string, accession: string, resolvedFilename: string): string {
  const digest = createHash("sha256")
    .update(`${providerId}\u0000${accession}\u0000supplementary\u0000${resolvedFilename}`)
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
    throw new TypeError(`${providerId} accepts only server-owned source, accession, entities, file_class, and supplement_index`);
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
    if (/(?:url|path|code|command)/i.test(key)) {
      throw new TypeError(`${providerId} entities must not contain URL, path, or code controls`);
    }
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
      throw new TypeError(`${providerId} entities must be a string-array record`);
    }
    parsedEntities[key] = [...value];
  }
  const rawFileClass = request.parameters.file_class;
  if (rawFileClass !== undefined && typeof rawFileClass !== "string") {
    throw new TypeError(`${providerId} file_class must be a string`);
  }
  if (rawFileClass !== undefined && !GEO_FILE_CLASSES.has(rawFileClass) && source === "geo") {
    throw new TypeError(`${providerId} file_class must be one of series_matrix, supplementary`);
  }
  if (rawFileClass !== undefined && source === "gdc") {
    throw new TypeError(`${providerId} does not accept file_class`);
  }
  const rawIndex = request.parameters.supplement_index;
  if (rawIndex !== undefined && (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 1)) {
    throw new TypeError(`${providerId} supplement_index must be a positive integer`);
  }
  const fileClass = rawFileClass === "supplementary" ? "supplementary" : "series_matrix";
  if (rawIndex !== undefined && fileClass !== "supplementary") {
    throw new TypeError(`${providerId} supplement_index is only valid with file_class=supplementary`);
  }
  return {
    source,
    accession: accession.trim(),
    entities: parsedEntities,
    fileClass,
    supplementIndex: typeof rawIndex === "number" ? rawIndex : null,
  };
}

function geoSeriesPrefix(accession: string): string {
  const numericAccession = accession.slice(3);
  return numericAccession.length <= 3
    ? "GSEnnn"
    : `GSE${numericAccession.slice(0, -3)}nnn`;
}

function geoMediaTypes(): {
  expectedMediaTypes: Set<string>;
  accept: string;
} {
  return {
    expectedMediaTypes: new Set([
      "application/gzip",
      "application/x-gzip",
      "text/tab-separated-values",
      "text/csv",
      "text/plain",
      "application/octet-stream",
    ]),
    accept: "application/gzip,application/x-gzip,text/plain;q=0.9,application/octet-stream;q=0.8",
  };
}

function geoMatrixPlan(parameters: ExpressionParameters): AcquisitionDownloadPlan {
  const accession = parameters.accession.toUpperCase();
  if (!GEO_ACCESSION.test(accession)) {
    throw new TypeError(`${GEO_FILES_PROVIDER_ID} requires a valid GEO series accession`);
  }
  const prefix = geoSeriesPrefix(accession);
  const media = geoMediaTypes();
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
    expectedMediaTypes: media.expectedMediaTypes,
    accept: media.accept,
    allowedHosts: new Set([GEO_DOWNLOAD_HOST]),
    assetRole: "carrier",
    providerRevisionFacts: {
      canonical_accession: accession,
      provider_snapshot_identity: "geo:series-matrix:v1",
      provider_revision_token: null,
    },
  };
}

async function geoSupplementaryPlan(
  parameters: ExpressionParameters,
  resolveListing: SupplementaryListingResolver | undefined,
): Promise<AcquisitionDownloadPlan> {
  const accession = parameters.accession.toUpperCase();
  if (!GEO_ACCESSION.test(accession)) {
    throw new TypeError(`${GEO_FILES_PROVIDER_ID} requires a valid GEO series accession`);
  }
  if (resolveListing === undefined) {
    throw new TypeError(
      `${GEO_FILES_PROVIDER_ID} supplementary acquisition requires a listing resolver (missing runtime wiring)`,
    );
  }
  const listing = await resolveListing(accession);
  const index = parameters.supplementIndex ?? 1;
  const selected = listing[index - 1];
  if (selected === undefined) {
    throw new TypeError(
      `${GEO_FILES_PROVIDER_ID} supplement_index ${index} is out of range: the server-enumerated listing for ${accession} has ${listing.length} entries`,
    );
  }
  // Defense in depth: the plan is built only from the server-side listing; the
  // filename is never taken from request parameters (ADR-044).
  const selectedUrl = new URL(selected.url);
  if (selectedUrl.hostname !== GEO_DOWNLOAD_HOST || !selectedUrl.pathname.endsWith(`/${selected.filename}`)) {
    throw new TypeError(`${GEO_FILES_PROVIDER_ID} listing resolver returned a non-canonical entry`);
  }
  const media = geoMediaTypes();
  return {
    source: {
      schema_version: "1.0",
      source_id: sourceIdSupplementary(GEO_FILES_PROVIDER_ID, accession, selected.filename),
      database: "geo",
      accession,
      url: selectedUrl.toString(),
      title: `NCBI GEO supplementary file ${accession} ${selected.filename}`,
      retrieved_at: new Date().toISOString(),
    },
    filename: selected.filename,
    dataLevel: "repository_processed",
    maxBytes: GEO_MAX_DOWNLOAD_BYTES,
    expectedMediaTypes: media.expectedMediaTypes,
    accept: media.accept,
    allowedHosts: new Set([GEO_DOWNLOAD_HOST]),
    assetRole: "carrier",
    providerRevisionFacts: {
      canonical_accession: accession,
      provider_snapshot_identity: "geo:supplementary:v1",
      provider_revision_token: null,
      resolved_filename: selected.filename,
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

export interface GeoFilesProviderOptions {
  /** ADR-044: runtime-injected server-side suppl listing enumeration
   * (host-locked; built from the shared HTTP client at composition). */
  resolveSupplementaryListing?: SupplementaryListingResolver;
}

/** Build the production listing resolver from the shared HTTP client; the
 * enumeration order is `resolveGeoSupplementaryAssets`'s fixed parse order. */
export function createGeoSupplementaryListingResolver(client: PublicHttpClient): SupplementaryListingResolver {
  return async (accession: string): Promise<readonly { filename: string; url: string }[]> => {
    const normalized = accession.toUpperCase();
    if (!GEO_ACCESSION.test(normalized)) {
      throw new TypeError("GEO supplementary listing requires a valid series accession");
    }
    const url = `https://${GEO_DOWNLOAD_HOST}/geo/series/${geoSeriesPrefix(normalized)}/${normalized}/suppl/`;
    const response = await getGeoListing(client, url, {});
    if (response.status < 200 || response.status >= 300) {
      throw new TypeError(`GEO supplementary listing returned HTTP ${response.status}`);
    }
    return resolveGeoSupplementaryAssets(response.body, url).map((candidate) => ({
      filename: candidate.filename,
      url: candidate.url,
    }));
  };
}

export function createGeoFilesProvider(options: GeoFilesProviderOptions = {}): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GEO_FILES_PROVIDER_ID,
    implementationDigest: GEO_IMPLEMENTATION_DIGEST,
    plan: (request: CoreAcquisitionRequest): AcquisitionDownloadPlan | Promise<AcquisitionDownloadPlan> => {
      const parameters = parseParameters(request, GEO_FILES_PROVIDER_ID, "geo");
      if (parameters.fileClass === "supplementary") {
        return geoSupplementaryPlan(parameters, options.resolveSupplementaryListing);
      }
      return geoMatrixPlan(parameters);
    },
  });
}

export function createGdcFilesProvider(): AcquisitionProviderHandler {
  return Object.freeze({
    providerId: GDC_FILES_PROVIDER_ID,
    implementationDigest: GDC_IMPLEMENTATION_DIGEST,
    plan: (request: CoreAcquisitionRequest) => gdcPlan(parseParameters(request, GDC_FILES_PROVIDER_ID, "gdc")),
  });
}
