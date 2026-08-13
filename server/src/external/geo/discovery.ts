/**
 * Deterministic orchestration of GEO discovery calls and pure parsers
 * (P5-04; Python ``app/integrations/ncbi/discovery.py`` parity, GEO parts).
 */

import {
  parseGeoEsearch,
  parseGeoEsummary,
  type GeoSearchResult,
  type GeoSeriesRecord,
} from "./parsers.js";
import type { GeoDiscoveryClient } from "./client.js";
import { ValueError } from "./client.js";

export { ValueError } from "./client.js";

const BATCH_SIZE = 200;

function batches(values: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    result.push(values.slice(index, index + BATCH_SIZE));
  }
  return result;
}

/** Python ``search_geo_series``: esearch + batched esummary + dedupe. */
export async function searchGeoSeries(
  client: GeoDiscoveryClient,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<GeoSearchResult> {
  const searchPayload = await client.esearch(
    {
      db: "gds",
      term: query,
      retmax: maxResults,
    },
    signal,
  );
  const page = parseGeoEsearch(searchPayload);
  const selectedIds = page.ids.slice(0, maxResults);
  const records: GeoSeriesRecord[] = [];
  for (const batch of batches(selectedIds)) {
    const summaryPayload = await client.esummary({ db: "gds", ids: batch }, signal);
    records.push(...parseGeoEsummary(summaryPayload));
  }
  const uniqueRecords: GeoSeriesRecord[] = [];
  const seenAccessions = new Set<string>();
  for (const record of records) {
    if (seenAccessions.has(record.accession)) continue;
    seenAccessions.add(record.accession);
    uniqueRecords.push(record);
  }
  return {
    query,
    query_translation: page.query_translation,
    total_count: page.count,
    records: uniqueRecords,
  };
}

/** Python ``describe_geo_series``: exact-accession lookup via esearch. */
export async function describeGeoSeries(
  client: GeoDiscoveryClient,
  accession: string,
  signal?: AbortSignal,
): Promise<GeoSeriesRecord> {
  const normalized = accession.trim().toUpperCase();
  if (!/^GSE\d+$/.test(normalized)) {
    throw new ValueError("accession must be a GSE accession");
  }
  const result = await searchGeoSeries(
    client,
    `${normalized}[Accession]`,
    100,
    signal,
  );
  for (const record of result.records) {
    if (record.accession === normalized) return record;
  }
  throw new LookupError(`GEO series not found: ${normalized}`);
}

/** Python ``LookupError`` parity for missing series. */
export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}
