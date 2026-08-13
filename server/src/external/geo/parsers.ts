/**
 * Pure parsers for official GEO (NCBI) response formats (P5-04; Python
 * ``app/integrations/ncbi/parsers.py`` parity, GEO parts only).
 *
 * Ports:
 * - ``parse_geo_esearch`` / ``parse_geo_esummary`` — E-utilities JSON
 *   (``gds`` database) into typed GEO series records; numeric UIDs are kept
 *   distinct from accessions (the UID is the esearch id, the accession is
 *   ``GSE...``).
 * - ``resolve_geo_supplementary_assets`` — GEO FTP ``suppl/`` HTML directory
 *   listings into downloadable asset candidates.
 */

import { URL } from "node:url";

import type { DataLevel } from "../../dataset/contracts/enums.js";

export interface GeoSampleRecord {
  accession: string;
  title: string;
}

export interface GeoSeriesRecord {
  uid: string;
  accession: string;
  title: string;
  summary: string;
  organism: string;
  experiment_type: string;
  sample_count: number;
  samples: GeoSampleRecord[];
  platform_ids: string[];
  pubmed_ids: string[];
  bioproject: string | null;
  ftp_root: string;
}

export interface NcbiSearchPage {
  count: number;
  retmax: number;
  retstart: number;
  ids: string[];
  query_translation: string;
}

export interface GeoAssetCandidate {
  filename: string;
  url: string;
  media_type: string;
  data_level: DataLevel;
}

export interface GeoSearchResult {
  query: string;
  query_translation: string;
  total_count: number;
  records: GeoSeriesRecord[];
}

const GSE_PATTERN = /^GSE\d+$/;
const GSM_PATTERN = /^GSM\d+$/;
const GPL_PATTERN = /^GPL\d+$/;
const SUPPL_FILENAME_PATTERN = /^GSE\d+_[A-Za-z0-9_.-]+\.gz$/;

function decodeJson(payload: Uint8Array): unknown {
  return JSON.parse(
    Buffer.from(payload).toString("utf8").replace(/^\uFEFF/, ""),
  ) as unknown;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Python ``_safe_int``: one malformed record must not abort the batch. */
export function safeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Python ``parse_geo_esearch`` / shared ``parse_ncbi_esearch``. */
export function parseGeoEsearch(payload: Uint8Array): NcbiSearchPage {
  const root = asRecord(decodeJson(payload), "esearch payload");
  const result = asRecord(root.esearchresult, "esearchresult");
  return {
    count: safeInt(result.count, 0),
    retmax: safeInt(result.retmax, 0),
    retstart: safeInt(result.retstart, 0),
    ids: Array.isArray(result.idlist) ? result.idlist.map(String) : [],
    query_translation: String(result.querytranslation ?? ""),
  };
}

/** Normalize a GSE/GSM/GPL accession (Python field validators). */
function normalizeAccession(
  value: unknown,
  pattern: RegExp,
  kind: string,
): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!pattern.test(normalized)) {
    throw new TypeError(`GEO ${kind} accession must match ${kind} followed by digits`);
  }
  return normalized;
}

/** Python ``parse_geo_esummary``: esummary JSON -> typed GSE records. */
export function parseGeoEsummary(payload: Uint8Array): GeoSeriesRecord[] {
  const root = asRecord(decodeJson(payload), "esummary payload");
  const result = asRecord(root.result, "esummary result");
  const uids = Array.isArray(result.uids) ? result.uids.map(String) : [];
  const records: GeoSeriesRecord[] = [];
  for (const uid of uids) {
    const item = result[uid];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.entrytype !== "GSE") continue;
    const gpl = String(record.gpl ?? "").trim();
    const platformIds = [...gpl.matchAll(/\d+/g)].map((match) => `GPL${match[0]}`);
    const samples = (Array.isArray(record.samples) ? record.samples : [])
      .map((sample) => asRecord(sample, "esummary sample"))
      .map((sample) => ({
        accession: normalizeAccession(sample.accession, GSM_PATTERN, "sample"),
        title: String(sample.title ?? ""),
      }));
    const sampleCount = safeInt(record.n_samples, samples.length);
    records.push({
      uid: String(uid),
      accession: normalizeAccession(record.accession, GSE_PATTERN, "series"),
      title: String(record.title ?? ""),
      summary: String(record.summary ?? ""),
      organism: String(record.taxon ?? ""),
      experiment_type: String(record.gdstype ?? ""),
      sample_count: sampleCount,
      samples,
      platform_ids: platformIds.map((platformId) =>
        normalizeAccession(platformId, GPL_PATTERN, "platform"),
      ),
      pubmed_ids: (Array.isArray(record.pubmedids) ? record.pubmedids : []).map(
        String,
      ),
      bioproject:
        typeof record.bioproject === "string" && record.bioproject !== ""
          ? record.bioproject
          : null,
      ftp_root: String(record.ftplink ?? ""),
    });
  }
  return records;
}

/** Minimal HTML anchor scan (Python ``_ListingParser`` / ``HTMLParser``). */
function anchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[2] ?? match[3] ?? "";
    if (href !== "") hrefs.push(href);
  }
  return hrefs;
}

/** Python ``resolve_geo_supplementary_assets``. */
export function resolveGeoSupplementaryAssets(
  html: Uint8Array,
  baseUrl: string,
): GeoAssetCandidate[] {
  const assets: GeoAssetCandidate[] = [];
  for (const href of anchorHrefs(Buffer.from(html).toString("utf8"))) {
    const pathname = new URL(href, "https://example.invalid").pathname;
    const filename = pathname.split("/").pop() ?? "";
    if (!SUPPL_FILENAME_PATTERN.test(filename)) continue;
    assets.push({
      filename,
      url: new URL(href, baseUrl).toString(),
      media_type: "application/gzip",
      data_level: "repository_processed",
    });
  }
  return assets;
}
