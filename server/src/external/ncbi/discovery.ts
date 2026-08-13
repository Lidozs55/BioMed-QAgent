/**
 * Deterministic orchestration of NCBI discovery calls and pure parsers
 * (Python ``app/integrations/ncbi/discovery.py`` parity, PubMed subset).
 *
 * ``search_pubmed`` runs esearch → batched efetch (200 ids per call) and
 * orders the parsed records by the esearch id order. GEO series discovery is
 * ported separately (P5-04).
 */

import type { PubmedRecord } from "./parsers.js";
import { parseNcbiEsearch, parsePubmedXml } from "./parsers.js";

const BATCH_SIZE = 200;

/** NCBI E-utilities surface needed by discovery orchestration. */
export interface NcbiDiscoveryClient {
  esearch(options: { db: string; term: string; retmax: number }, signal?: AbortSignal): Promise<Buffer>;
  esummary(options: { db: string; ids: readonly string[] }, signal?: AbortSignal): Promise<Buffer>;
  efetch(options: { db: string; ids: readonly string[]; retmode: string }, signal?: AbortSignal): Promise<Buffer>;
}

export interface PubMedSearchResult {
  query: string;
  query_translation: string;
  total_count: number;
  records: PubmedRecord[];
}

function batches(values: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    result.push([...values.slice(index, index + BATCH_SIZE)]);
  }
  return result;
}

export async function searchPubmed(
  client: NcbiDiscoveryClient,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<PubMedSearchResult> {
  const searchPayload = await client.esearch({ db: "pubmed", term: query, retmax: maxResults }, signal);
  const page = parseNcbiEsearch(searchPayload);
  const selectedIds = page.ids.slice(0, maxResults);
  const recordsByPmid = new Map<string, PubmedRecord>();
  for (const batch of batches(selectedIds)) {
    const fetchPayload = await client.efetch({ db: "pubmed", ids: batch, retmode: "xml" }, signal);
    for (const record of parsePubmedXml(fetchPayload)) {
      recordsByPmid.set(record.pmid, record);
    }
  }
  const orderedRecords: PubmedRecord[] = [];
  for (const pmid of selectedIds) {
    const record = recordsByPmid.get(pmid);
    if (record !== undefined) orderedRecords.push(record);
  }
  return {
    query,
    query_translation: page.query_translation,
    total_count: page.count,
    records: orderedRecords,
  };
}
